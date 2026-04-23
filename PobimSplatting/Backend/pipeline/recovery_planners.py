"""Recovery planning helpers for sparse reconstruction and retry flows."""

from __future__ import annotations

import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from ..core.commands import run_command_with_logs
from ..core.projects import append_log_line
from .config_builders import get_colmap_config_for_pipeline
from .frame_manifest import (
    build_boundary_frame_densification_plan,
    clear_colmap_database,
    rebuild_images_from_frame_manifest,
)
from .orbit_policy import (
    apply_no_regression_floor,
    build_orbit_safe_bridge_recovery_pass,
    capture_no_regression_floor,
    derive_data_driven_overlap_plan,
    make_orbit_safe_policy,
    merge_no_regression_floors,
    percentile,
    summarize_frame_selection_spacing,
)
from .runtime_support import (
    get_gpu_total_vram_mb,
    is_gpu_matching_error_text,
    resolve_colmap_feature_pipeline_profile,
    should_log_subprocess_line,
)
from .resource_contract import RECOVERY_PRECEDENCE, RESOURCE_AWARE_SCHEMA_VERSION

COLMAP_PAIR_ID_FACTOR = 2147483647


def _recovery_auto_tuning(colmap_cfg):
    snapshot = dict((colmap_cfg or {}).get('auto_tuning') or {})
    tuning = dict(snapshot.get('recovery') or {})
    return {
        'weak_boundary_stop_ratio': float(tuning.get('weak_boundary_stop_ratio') or 0.02),
        'weak_boundary_trigger_ratio': float(tuning.get('weak_boundary_trigger_ratio') or 0.08),
        'weak_boundary_quadratic_ratio': float(tuning.get('weak_boundary_quadratic_ratio') or 0.03),
        'pair_budget_scale': float(tuning.get('pair_budget_scale') or 1.0),
        'final_loop_trigger_ratio': float(tuning.get('final_loop_trigger_ratio') or 0.05),
        'final_loop_registered_ratio': float(tuning.get('final_loop_registered_ratio') or 0.95),
    }


def _tuned_decision_used(colmap_cfg):
    summary = dict((colmap_cfg or {}).get('auto_tuning_summary') or {})
    return summary.get('active_mode') == 'tuned'


def analyze_pair_geometry_stats(database_path, bridge_window=6):
    if not Path(database_path).exists():
        return None

    with sqlite3.connect(str(database_path)) as conn:
        image_rows = conn.execute('SELECT image_id, name FROM images ORDER BY image_id').fetchall()
        pair_rows = conn.execute('SELECT pair_id, rows, config FROM two_view_geometries').fetchall()

    if len(image_rows) < 2:
        return None

    local_pairs = {}
    adjacent_inliers = []

    for pair_id, rows, config in pair_rows:
        image_id1 = int(pair_id // COLMAP_PAIR_ID_FACTOR)
        image_id2 = int(pair_id % COLMAP_PAIR_ID_FACTOR)
        gap = image_id2 - image_id1
        if gap < 1 or gap > bridge_window:
            continue

        inliers = int(rows or 0) if int(config or 0) > 0 else 0
        local_pairs[(image_id1, image_id2)] = inliers
        if gap == 1 and inliers > 0:
            adjacent_inliers.append(inliers)

    image_ids = [row[0] for row in image_rows]
    image_names = {image_id: name for image_id, name in image_rows}
    bridge_strengths = []
    weak_boundaries = []
    weak_boundary_count = 0
    zero_boundary_count = 0

    for index in range(len(image_ids) - 1):
        left_ids = image_ids[max(0, index - 2):index + 1]
        right_ids = image_ids[index + 1:min(len(image_ids), index + 1 + bridge_window)]
        bridge_strength = 0
        best_bridge_pair = None
        for left_id in left_ids:
            for right_id in right_ids:
                pair_inliers = local_pairs.get((left_id, right_id), 0)
                if pair_inliers > bridge_strength:
                    bridge_strength = pair_inliers
                    best_bridge_pair = (left_id, right_id)
        bridge_strengths.append(bridge_strength)
        adjacent_pair_inliers = local_pairs.get((image_ids[index], image_ids[index + 1]), 0)
        if bridge_strength == 0:
            zero_boundary_count += 1
        if bridge_strength < 20:
            weak_boundary_count += 1
            weak_boundaries.append(
                {
                    'boundary_index': index,
                    'left_image_id': image_ids[index],
                    'left_image_name': image_names.get(image_ids[index]),
                    'right_image_id': image_ids[index + 1],
                    'right_image_name': image_names.get(image_ids[index + 1]),
                    'adjacent_inliers': adjacent_pair_inliers,
                    'bridge_strength': bridge_strength,
                    'best_bridge_pair': best_bridge_pair,
                }
            )

    weak_boundary_ratio = weak_boundary_count / max(len(bridge_strengths), 1)
    zero_boundary_ratio = zero_boundary_count / max(len(bridge_strengths), 1)
    weak_boundaries.sort(key=lambda item: (item['bridge_strength'], item['adjacent_inliers'], item['boundary_index']))
    weak_boundaries = weak_boundaries[:8]

    return {
        'image_count': len(image_rows),
        'adjacent_median': round(percentile(adjacent_inliers, 0.5), 3),
        'adjacent_p10': round(percentile(adjacent_inliers, 0.1), 3),
        'bridge_median': round(percentile(bridge_strengths, 0.5), 3),
        'bridge_p10': round(percentile(bridge_strengths, 0.1), 3),
        'bridge_min': round(min(bridge_strengths), 3) if bridge_strengths else 0.0,
        'weak_boundary_count': weak_boundary_count,
        'weak_boundary_ratio': round(weak_boundary_ratio, 4),
        'zero_boundary_count': zero_boundary_count,
        'zero_boundary_ratio': round(zero_boundary_ratio, 4),
        'weak_boundaries': weak_boundaries,
    }


def _append_recovery_history(colmap_cfg, entry):
    history = list(colmap_cfg.get('recovery_history') or [])
    history.append(entry)
    colmap_cfg['recovery_history'] = history[-12:]
    return colmap_cfg['recovery_history']


def _make_boundary_key(left_name, right_name):
    if not left_name or not right_name:
        return None
    return f"{left_name}→{right_name}"


def _recovery_step_order(kind):
    kind = str(kind or "")
    if kind == "bridge_recovery":
        return RECOVERY_PRECEDENCE.index("progressive_pair_scheduling") + 1
    if kind == "weak_window_subset":
        return RECOVERY_PRECEDENCE.index("weak_window_subset") + 1
    if kind == "boundary_frame_densification":
        return RECOVERY_PRECEDENCE.index("boundary_frame_densification") + 1
    if kind == "stubborn_boundary_subset":
        return RECOVERY_PRECEDENCE.index("stubborn_boundary_subset") + 1
    if kind == "final_loop_detection_subset":
        return RECOVERY_PRECEDENCE.index("final_loop_detection_subset") + 1
    return 0


def _is_ordered_video_split_retry_candidate(config, colmap_cfg, sparse_summary):
    if not sparse_summary or not sparse_summary.get("has_multiple_models"):
        return False

    if colmap_cfg.get("automatic_split_retry_attempted"):
        return False

    input_type = str((config or {}).get("input_type") or "").lower()
    if input_type not in {"video", "mixed"} and not bool(
        (colmap_cfg or {}).get("orbit_safe_mode")
    ):
        return False

    alternate_registered = int(sparse_summary.get("alternate_registered") or 0)
    return alternate_registered >= 5


def run_automatic_split_retry(
    project_id,
    paths,
    config,
    colmap_cfg,
    sparse_summary,
    *,
    rerun_feature_extraction_stage,
    rerun_feature_matching_stage,
    rerun_sparse_reconstruction_stage,
):
    if not _is_ordered_video_split_retry_candidate(config, colmap_cfg, sparse_summary):
        return None

    append_log_line(
        project_id,
        "🧠 Ordered video sparse reconstruction is still split after the normal recovery ladder; "
        "automatically rerunning extraction, matching, and sparse reconstruction once with a stronger single-model repair profile",
    )

    geometry_stats = colmap_cfg.get("pair_geometry_stats") or analyze_pair_geometry_stats(
        paths["database_path"]
    )
    matcher_params = dict(colmap_cfg.get("matcher_params") or {})
    overlap_plan = derive_data_driven_overlap_plan(
        geometry_stats,
        matcher_params,
        sparse_summary=sparse_summary,
        frame_spacing_stats=summarize_frame_selection_spacing(paths),
    )

    clear_sparse_reconstruction_outputs(paths["sparse_path"])
    clear_colmap_database(paths["database_path"])

    _, rerun_colmap_cfg, _, _ = get_colmap_config_for_pipeline(paths, config)
    rerun_colmap_cfg["automatic_split_retry_attempted"] = True
    rerun_colmap_cfg["boundary_frame_densification_attempted"] = bool(
        colmap_cfg.get("boundary_frame_densification_attempted")
    )
    rerun_colmap_cfg["weak_window_recovery_attempted"] = False
    rerun_colmap_cfg["stubborn_boundary_recovery_attempted"] = False
    rerun_colmap_cfg["densified_overlap_retry_attempted"] = False
    rerun_colmap_cfg["loop_detection_fallback_attempted"] = False
    rerun_colmap_cfg["pair_geometry_stats"] = None
    rerun_colmap_cfg["recovery_matching_pass"] = None
    rerun_colmap_cfg["final_recovery_matching_pass"] = None
    rerun_colmap_cfg["last_sparse_summary"] = dict(sparse_summary)
    rerun_colmap_cfg["no_regression_floor"] = merge_no_regression_floors(
        colmap_cfg.get("no_regression_floor"),
        capture_no_regression_floor(colmap_cfg),
    )
    rerun_colmap_cfg["recovery_history"] = list(colmap_cfg.get("recovery_history") or [])

    retry_matcher_params = dict(rerun_colmap_cfg.get("matcher_params") or {})
    current_overlap = max(
        6,
        int(
            retry_matcher_params.get(
                "SequentialMatching.overlap",
                matcher_params.get("SequentialMatching.overlap", "16"),
            )
        ),
    )
    target_overlap = current_overlap + 6
    if overlap_plan:
        target_overlap = max(
            target_overlap,
            int(overlap_plan.get("target_overlap") or current_overlap),
        )
    retry_matcher_params["SequentialMatching.overlap"] = str(min(60, target_overlap))
    retry_matcher_params["SequentialMatching.quadratic_overlap"] = "1"
    retry_matcher_params["SequentialMatching.loop_detection"] = "1"
    rerun_colmap_cfg["matcher_params"] = retry_matcher_params

    retry_mapper_params = dict(rerun_colmap_cfg.get("mapper_params") or {})
    current_trials = int(retry_mapper_params.get("Mapper.max_reg_trials", "8"))
    current_inliers = int(
        retry_mapper_params.get("Mapper.abs_pose_min_num_inliers", "18")
    )
    current_ratio = float(
        retry_mapper_params.get("Mapper.abs_pose_min_inlier_ratio", "0.12")
    )
    retry_mapper_params["Mapper.max_num_models"] = "1"
    retry_mapper_params["Mapper.structure_less_registration_fallback"] = "1"
    retry_mapper_params["Mapper.max_reg_trials"] = str(max(current_trials, 14))
    retry_mapper_params["Mapper.abs_pose_min_num_inliers"] = str(
        min(current_inliers, 12)
    )
    retry_mapper_params["Mapper.abs_pose_min_inlier_ratio"] = f"{min(current_ratio, 0.08):.2f}"
    rerun_colmap_cfg["mapper_params"] = retry_mapper_params

    _append_recovery_history(
        rerun_colmap_cfg,
        {
            "kind": "automatic_split_retry",
            "label": "Automatic split retry",
            "reason_code": "unresolved_split_model",
            "step_order": _recovery_step_order("final_loop_detection_subset"),
            "status": "completed",
            "outcome": "rerun_started",
            "reason": (
                "ordered video remained split after the recovery ladder, so the pipeline "
                "automatically reran extraction/matching/sparse with stronger overlap, "
                "loop detection, and a single-model mapper cap"
            ),
            "failed_step_key": None,
            "fallback_step": None,
            "fallback_reason": None,
            "subset_image_count": None,
            "weak_boundary_count": int(
                (geometry_stats or {}).get("weak_boundary_count") or 0
            ),
            "target_boundary_count": None,
            "surviving_target_boundary_count": None,
            "padding": None,
            "overlap": retry_matcher_params.get("SequentialMatching.overlap"),
            "quadratic_overlap": retry_matcher_params.get(
                "SequentialMatching.quadratic_overlap"
            ),
            "loop_detection": retry_matcher_params.get(
                "SequentialMatching.loop_detection"
            ),
            "runtime_mode": "automatic_rerun",
            "tuned_decision_used": _tuned_decision_used(colmap_cfg),
        },
    )

    append_log_line(
        project_id,
        "🔁 Automatic split retry: "
        f"overlap={retry_matcher_params.get('SequentialMatching.overlap')} | "
        f"loop={retry_matcher_params.get('SequentialMatching.loop_detection')} | "
        f"min_inliers={retry_mapper_params.get('Mapper.abs_pose_min_num_inliers')} | "
        f"min_ratio={retry_mapper_params.get('Mapper.abs_pose_min_inlier_ratio')} | "
        f"max_reg_trials={retry_mapper_params.get('Mapper.max_reg_trials')} | "
        "max_models=1",
    )

    rerun_colmap_cfg = rerun_feature_extraction_stage(
        project_id, paths, config, rerun_colmap_cfg
    )
    rerun_colmap_cfg = rerun_feature_matching_stage(
        project_id, paths, config, rerun_colmap_cfg
    )
    return rerun_sparse_reconstruction_stage(project_id, paths, config, rerun_colmap_cfg)


def _estimate_targeted_pair_budget(
    *,
    gpu_total_vram_mb,
    boundary_count,
    overlap,
    max_num_matches,
    scale=1.0,
):
    boundary_count = max(1, int(boundary_count or 1))
    overlap = max(4, int(overlap or 8))
    max_num_matches = int(max_num_matches or 0)
    gpu_total_vram_mb = int(gpu_total_vram_mb or 8192)

    if gpu_total_vram_mb <= 8192:
        per_boundary_cap = 72
    elif gpu_total_vram_mb <= 12288:
        per_boundary_cap = 96
    elif gpu_total_vram_mb <= 16384:
        per_boundary_cap = 128
    else:
        per_boundary_cap = 160

    if overlap >= 44:
        per_boundary_cap += 12
    elif overlap >= 36:
        per_boundary_cap += 6

    if max_num_matches and max_num_matches <= 32768:
        per_boundary_cap = min(per_boundary_cap, 72)

    scale = max(0.9, min(float(scale or 1.0), 1.15))
    per_boundary_cap = int(round(per_boundary_cap * scale))
    total_cap = per_boundary_cap * boundary_count
    total_cap = min(total_cap, 512 if gpu_total_vram_mb <= 8192 else 768)

    return {
        'per_boundary_cap': max(36, per_boundary_cap),
        'total_cap': max(72, total_cap),
        'reason': (
            f"gpu_vram={gpu_total_vram_mb}MB, overlap={overlap}, "
            f"max_matches={max_num_matches or '--'}"
        ),
    }


def _classify_boundary_outcome(previous_boundary, current_boundary, *, broad_fallback=False):
    if not current_boundary:
        return 'repaired'

    previous_bridge = float((previous_boundary or {}).get('bridge_strength') or 0.0)
    previous_adjacent = float((previous_boundary or {}).get('adjacent_inliers') or 0.0)
    current_bridge = float((current_boundary or {}).get('bridge_strength') or 0.0)
    current_adjacent = float((current_boundary or {}).get('adjacent_inliers') or 0.0)

    if broad_fallback:
        return 'abandoned_to_fallback'
    if current_bridge > previous_bridge or current_adjacent > previous_adjacent:
        return 'partially_repaired'
    return 'stubborn'


def build_boundary_recovery_subset(
    database_path,
    geometry_stats,
    overlap,
    max_images=96,
    *,
    weak_boundaries=None,
):
    if not Path(database_path).exists():
        return None

    weak_boundaries = list(
        weak_boundaries
        if weak_boundaries is not None
        else ((geometry_stats or {}).get('weak_boundaries') or [])
    )
    if not weak_boundaries:
        return None

    with sqlite3.connect(str(database_path)) as conn:
        image_rows = conn.execute('SELECT image_id, name FROM images ORDER BY image_id').fetchall()

    if len(image_rows) < 2:
        return None

    image_ids = [row[0] for row in image_rows]
    image_names = {image_id: name for image_id, name in image_rows}
    padding = max(10, min(24, int(overlap // 2) + 6))

    selected_ids = set()

    def add_range(start_index, end_index):
        for image_id in image_ids[start_index:end_index]:
            if len(selected_ids) >= max_images:
                break
            selected_ids.add(image_id)

    for boundary in weak_boundaries:
        boundary_index = int(boundary.get('boundary_index') or 0)
        start_index = max(0, boundary_index - padding)
        end_index = min(len(image_ids), boundary_index + padding + 2)
        add_range(start_index, end_index)

        best_bridge_pair = boundary.get('best_bridge_pair') or ()
        for image_id in best_bridge_pair:
            if len(selected_ids) >= max_images:
                break
            if image_id in image_names:
                selected_ids.add(int(image_id))

        if len(selected_ids) >= max_images:
            break

    if not selected_ids:
        return None

    ordered_image_ids = [image_id for image_id in image_ids if image_id in selected_ids]
    if len(ordered_image_ids) < 2:
        return None

    return {
        'image_ids': ordered_image_ids,
        'image_names': [image_names[image_id] for image_id in ordered_image_ids],
        'padding': padding,
        'weak_boundary_count': len(weak_boundaries),
        'target_boundaries': [
            {
                'key': _make_boundary_key(
                    boundary.get('left_image_name'),
                    boundary.get('right_image_name'),
                ),
                'left_image_name': boundary.get('left_image_name'),
                'right_image_name': boundary.get('right_image_name'),
                'bridge_strength': boundary.get('bridge_strength'),
                'adjacent_inliers': boundary.get('adjacent_inliers'),
                'severity_label': boundary.get('severity_label'),
                'severity_multiplier': boundary.get('severity_multiplier'),
                'target_segment_frames': boundary.get('target_segment_frames'),
                'inserted_frame_count': boundary.get('inserted_frame_count'),
            }
            for boundary in weak_boundaries
            if _make_boundary_key(
                boundary.get('left_image_name'),
                boundary.get('right_image_name'),
            )
        ],
    }


def _find_stubborn_densified_boundaries(colmap_cfg, geometry_stats):
    current_weak_boundaries = list((geometry_stats or {}).get('weak_boundaries') or [])
    if not current_weak_boundaries:
        return [], None

    recovery_history = list(colmap_cfg.get('recovery_history') or [])
    latest_densification = next(
        (
            step
            for step in reversed(recovery_history)
            if step.get('kind') == 'boundary_frame_densification'
        ),
        None,
    )
    if not latest_densification:
        return [], None

    current_by_key = {
        _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name')): boundary
        for boundary in current_weak_boundaries
        if _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name'))
    }

    stubborn_boundaries = []
    for boundary in latest_densification.get('targeted_boundaries') or []:
        boundary_key = boundary.get('key')
        current_boundary = current_by_key.get(boundary_key)
        if not current_boundary:
            continue

        severity_label = str(boundary.get('severity_label') or '').lower()
        target_segment_frames = int(boundary.get('target_segment_frames') or 0)
        inserted_frame_count = int(boundary.get('inserted_frame_count') or 0)
        current_bridge = float(current_boundary.get('bridge_strength') or 0.0)
        current_adjacent = float(current_boundary.get('adjacent_inliers') or 0.0)

        is_heavy = (
            severity_label in {'severe', 'critical'}
            or target_segment_frames >= 12
            or inserted_frame_count >= 4
        )
        still_stubborn = (
            current_bridge <= 12
            or current_adjacent <= 10
            or severity_label == 'critical'
        )
        if not is_heavy or not still_stubborn:
            continue

        merged_boundary = dict(current_boundary)
        merged_boundary['severity_label'] = boundary.get('severity_label')
        merged_boundary['severity_multiplier'] = boundary.get('severity_multiplier')
        merged_boundary['target_segment_frames'] = boundary.get('target_segment_frames')
        merged_boundary['inserted_frame_count'] = boundary.get('inserted_frame_count')
        stubborn_boundaries.append(merged_boundary)

    return stubborn_boundaries, latest_densification


def build_targeted_boundary_pair_plan(
    image_names,
    target_boundaries,
    overlap,
    *,
    gpu_total_vram_mb=None,
    max_num_matches=None,
    pair_budget_scale=1.0,
):
    ordered_names = [str(name) for name in (image_names or []) if name]
    if len(ordered_names) < 2:
        return None

    name_to_index = {name: index for index, name in enumerate(ordered_names)}
    pair_set = set()
    boundary_plans = []
    overlap = max(4, int(overlap or 8))
    budget = _estimate_targeted_pair_budget(
        gpu_total_vram_mb=gpu_total_vram_mb,
        boundary_count=len(target_boundaries or []),
        overlap=overlap,
        max_num_matches=max_num_matches,
        scale=pair_budget_scale,
    )
    remaining_total_cap = int(budget['total_cap'])
    plan_capped = False

    for boundary in target_boundaries or []:
        left_name = boundary.get('left_image_name')
        right_name = boundary.get('right_image_name')
        if left_name not in name_to_index or right_name not in name_to_index:
            continue

        left_index = name_to_index[left_name]
        right_index = name_to_index[right_name]
        if right_index <= left_index:
            continue

        severity_label = str(boundary.get('severity_label') or '').lower()
        bridge_strength = float(boundary.get('bridge_strength') or 0.0)
        target_segment_frames = int(boundary.get('target_segment_frames') or 0)
        base_radius = max(2, min(6, overlap // 4 + 1))
        cross_radius = base_radius
        if severity_label in {'severe', 'critical'} or bridge_strength <= 6:
            cross_radius = min(12, max(cross_radius + 2, target_segment_frames // 2 + 1))
        if bridge_strength <= 0:
            cross_radius = min(14, max(cross_radius + 2, target_segment_frames // 2 + 2))
        local_radius = max(1, min(4, cross_radius // 2 + 1))
        boundary_pair_set = set()

        def add_boundary_pair(first_index, second_index):
            if first_index == second_index:
                return
            left_pair_index, right_pair_index = sorted((int(first_index), int(second_index)))
            if left_pair_index < 0 or right_pair_index >= len(ordered_names):
                return
            if left_pair_index == right_pair_index:
                return
            boundary_pair_set.add((left_pair_index, right_pair_index))

        left_window = range(max(0, left_index - cross_radius), left_index + 1)
        right_window = range(right_index, min(len(ordered_names), right_index + cross_radius + 1))

        for anchor in left_window:
            for neighbor in range(anchor + 1, min(left_index + 1, anchor + local_radius + 1)):
                add_boundary_pair(anchor, neighbor)
        for anchor in right_window:
            for neighbor in range(anchor + 1, min(len(ordered_names), anchor + local_radius + 1)):
                add_boundary_pair(anchor, neighbor)
        for left_candidate in left_window:
            for right_candidate in right_window:
                add_boundary_pair(left_candidate, right_candidate)

        boundary_cap = int(budget['per_boundary_cap'])
        if severity_label in {'severe', 'critical'} or bridge_strength <= 6:
            boundary_cap += 16
        if bridge_strength <= 0:
            boundary_cap += 16
        boundary_cap = min(boundary_cap, max(24, remaining_total_cap))
        ordered_boundary_pairs = sorted(
            boundary_pair_set,
            key=lambda item: (
                abs(left_index - item[0]) + abs(item[1] - right_index),
                abs((item[1] - item[0])),
                item[0],
                item[1],
            ),
        )
        pair_budget_capped = len(ordered_boundary_pairs) > boundary_cap
        if pair_budget_capped:
            plan_capped = True
            ordered_boundary_pairs = ordered_boundary_pairs[:boundary_cap]
        remaining_total_cap = max(0, remaining_total_cap - len(ordered_boundary_pairs))
        pair_set.update(ordered_boundary_pairs)

        boundary_plans.append(
            {
                'key': boundary.get('key') or _make_boundary_key(left_name, right_name),
                'left_image_name': left_name,
                'right_image_name': right_name,
                'cross_radius': cross_radius,
                'local_radius': local_radius,
                'pair_count': len(ordered_boundary_pairs),
                'pair_budget_cap': boundary_cap,
                'pair_budget_capped': pair_budget_capped,
                'pair_budget_reason': budget['reason'],
                'severity_label': boundary.get('severity_label'),
                'bridge_strength': bridge_strength,
            }
        )
        if remaining_total_cap <= 0:
            break

    if not pair_set:
        return None

    ordered_pairs = [
        (ordered_names[left_index], ordered_names[right_index])
        for left_index, right_index in sorted(pair_set)
    ]
    return {
        'pairs': ordered_pairs,
        'pair_count': len(ordered_pairs),
        'boundary_plans': boundary_plans,
        'pair_budget_cap': int(budget['total_cap']),
        'pair_budget_capped': plan_capped,
        'pair_budget_reason': budget['reason'],
    }


def build_weak_window_subset_recovery_pass(paths, colmap_cfg, sparse_summary):
    if not sparse_summary or not sparse_summary.get('has_multiple_models'):
        return None

    if colmap_cfg.get('weak_window_recovery_attempted'):
        return None

    if colmap_cfg.get('matcher_type') != 'sequential':
        return None

    matcher_params = dict(colmap_cfg.get('matcher_params') or {})
    if not matcher_params:
        return None

    geometry_stats = colmap_cfg.get('pair_geometry_stats') or analyze_pair_geometry_stats(
        paths['database_path']
    )
    if not geometry_stats or not (geometry_stats.get('weak_boundaries') or []):
        return None

    weak_boundary_ratio = float(geometry_stats.get('weak_boundary_ratio') or 0.0)
    zero_boundary_count = int(geometry_stats.get('zero_boundary_count') or 0)
    bridge_p10 = float(geometry_stats.get('bridge_p10') or 0.0)
    bridge_min = float(geometry_stats.get('bridge_min') or 0.0)
    weak_boundary_count = int(geometry_stats.get('weak_boundary_count') or 0)
    recovery_tuning = _recovery_auto_tuning(colmap_cfg)
    weak_boundary_stop_ratio = float(recovery_tuning['weak_boundary_stop_ratio'])
    weak_boundary_trigger_ratio = float(recovery_tuning['weak_boundary_trigger_ratio'])
    weak_boundary_quadratic_ratio = float(recovery_tuning['weak_boundary_quadratic_ratio'])
    pair_budget_scale = float(recovery_tuning['pair_budget_scale'])
    if weak_boundary_count <= 0:
        return None

    stubborn_boundaries, stubborn_source = _find_stubborn_densified_boundaries(
        colmap_cfg, geometry_stats
    )
    if stubborn_boundaries and not colmap_cfg.get('stubborn_boundary_recovery_attempted'):
        current_overlap = max(6, int(matcher_params.get('SequentialMatching.overlap', '12')))
        overlap_plan = derive_data_driven_overlap_plan(
            geometry_stats,
            matcher_params,
            sparse_summary=sparse_summary,
            frame_spacing_stats=summarize_frame_selection_spacing(paths),
        )
        suggested_overlap = int((overlap_plan or {}).get('target_overlap') or current_overlap)
        target_overlap = min(
            max(current_overlap + 8, suggested_overlap + 4),
            max(40, current_overlap + 18),
        )
        subset_max_images = min(
            160,
            max(56, target_overlap * max(2, min(5, len(stubborn_boundaries)))),
        )
        boundary_subset = build_boundary_recovery_subset(
            paths['database_path'],
            geometry_stats,
            target_overlap,
            max_images=subset_max_images,
            weak_boundaries=stubborn_boundaries,
        )
        subset_image_ids = list((boundary_subset or {}).get('image_ids') or [])
        if len(subset_image_ids) >= max(12, min(24, current_overlap)):
            pair_plan = build_targeted_boundary_pair_plan(
                boundary_subset.get('image_names') or [],
                boundary_subset.get('target_boundaries') or [],
                target_overlap,
                gpu_total_vram_mb=get_gpu_total_vram_mb(),
                max_num_matches=colmap_cfg.get('max_num_matches'),
                pair_budget_scale=pair_budget_scale,
            )
            recovery_matcher_params = dict(matcher_params)
            recovery_matcher_params['SequentialMatching.overlap'] = str(target_overlap)
            recovery_matcher_params['SequentialMatching.quadratic_overlap'] = '1'
            recovery_matcher_params['SequentialMatching.loop_detection'] = '0'

            top_signal_preview = ", ".join(
                f"{name}={score:g}" for name, score in (overlap_plan or {}).get('top_signals', [])[:4]
            )
            return {
                'kind': 'stubborn_boundary_subset',
                'label': 'Stubborn boundary subset rematch',
                'matcher_params': recovery_matcher_params,
                'boundary_subset': boundary_subset,
                'overlap_plan': overlap_plan,
                'pair_targeted': bool(pair_plan and pair_plan.get('pair_count')),
                'pair_plan': {
                    'pair_count': int((pair_plan or {}).get('pair_count') or 0),
                    'pair_budget_cap': int((pair_plan or {}).get('pair_budget_cap') or 0),
                    'pair_budget_capped': bool((pair_plan or {}).get('pair_budget_capped')),
                    'pair_budget_reason': (pair_plan or {}).get('pair_budget_reason'),
                    'boundary_plans': list((pair_plan or {}).get('boundary_plans') or []),
                },
                'reason_code': (
                    'pair_budget_capped'
                    if pair_plan and pair_plan.get('pair_budget_capped')
                    else 'post_densification_survivor'
                ),
                'reason': (
                    'post-densification stubborn-boundary escalation with a narrower subset and stronger overlap profile '
                    f"(overlap {current_overlap}→{target_overlap}, subset={len(subset_image_ids)} images, stubborn={len(stubborn_boundaries)}"
                    + (
                        f"; targeted_pairs={(pair_plan or {}).get('pair_count', 0)}"
                        if pair_plan and pair_plan.get('pair_count')
                        else ""
                    )
                    + (
                        f"; source={stubborn_source.get('label', 'boundary densification')}"
                        if stubborn_source
                        else ""
                    )
                    + (f"; signals: {top_signal_preview}" if top_signal_preview else "")
                    + ')'
                ),
            }

    if (
        weak_boundary_ratio < weak_boundary_stop_ratio
        and zero_boundary_count == 0
        and bridge_p10 >= 28
        and bridge_min >= 18
    ):
        return None

    current_overlap = max(4, int(matcher_params.get('SequentialMatching.overlap', '12')))
    overlap_plan = derive_data_driven_overlap_plan(
        geometry_stats,
        matcher_params,
        sparse_summary=sparse_summary,
        frame_spacing_stats=summarize_frame_selection_spacing(paths),
    )
    suggested_overlap = int((overlap_plan or {}).get('target_overlap') or current_overlap)
    overlap_cap = max(24, min(48, current_overlap + 14))
    target_overlap = min(max(current_overlap + 4, suggested_overlap), overlap_cap)
    if zero_boundary_count > 0 or weak_boundary_ratio >= weak_boundary_trigger_ratio:
        target_overlap = min(max(target_overlap, current_overlap + 6), max(overlap_cap, current_overlap + 6))

    subset_max_images = min(144, max(48, target_overlap * max(2, min(4, weak_boundary_count))))
    boundary_subset = build_boundary_recovery_subset(
        paths['database_path'],
        geometry_stats,
        target_overlap,
        max_images=subset_max_images,
    )
    subset_image_ids = list((boundary_subset or {}).get('image_ids') or [])
    if len(subset_image_ids) < max(12, min(24, current_overlap)):
        return None

    recovery_matcher_params = dict(matcher_params)
    recovery_matcher_params['SequentialMatching.overlap'] = str(target_overlap)
    recovery_matcher_params['SequentialMatching.quadratic_overlap'] = (
        '1'
        if weak_boundary_ratio >= weak_boundary_quadratic_ratio or zero_boundary_count > 0
        else matcher_params.get('SequentialMatching.quadratic_overlap', '0')
    )
    recovery_matcher_params['SequentialMatching.loop_detection'] = '0'

    top_signal_preview = ", ".join(
        f"{name}={score:g}" for name, score in (overlap_plan or {}).get('top_signals', [])[:4]
    )
    return {
        'kind': 'weak_window_subset',
        'label': 'Weak-window subset rematch',
        'matcher_params': recovery_matcher_params,
        'boundary_subset': boundary_subset,
        'overlap_plan': overlap_plan,
        'reason_code': 'zero_boundary' if zero_boundary_count > 0 else 'weak_bridge',
        'reason': (
            'targeted boundary subset rematch before any densification '
            f"(overlap {current_overlap}→{target_overlap}, subset={len(subset_image_ids)} images"
            + (f"; signals: {top_signal_preview}" if top_signal_preview else "")
            + ')'
        ),
    }


def create_boundary_subset_database(source_database_path, subset_database_path, subset_image_ids):
    subset_ids = [int(image_id) for image_id in subset_image_ids]
    if not subset_ids:
        raise ValueError('boundary subset database requires at least one image id')

    shutil.copy2(source_database_path, subset_database_path)

    placeholders = ', '.join('?' for _ in subset_ids)
    with sqlite3.connect(str(subset_database_path)) as conn:
        conn.execute('PRAGMA foreign_keys=ON')
        conn.execute(f'DELETE FROM images WHERE image_id NOT IN ({placeholders})', subset_ids)
        conn.execute('DELETE FROM matches')
        conn.execute('DELETE FROM two_view_geometries')
        conn.commit()


def merge_boundary_subset_matches(source_database_path, target_database_path):
    with sqlite3.connect(str(target_database_path)) as conn:
        conn.execute('ATTACH DATABASE ? AS subset_db', (str(source_database_path),))
        conn.execute('BEGIN')
        conn.execute('INSERT OR REPLACE INTO matches SELECT * FROM subset_db.matches')
        conn.execute('INSERT OR REPLACE INTO two_view_geometries SELECT * FROM subset_db.two_view_geometries')
        conn.commit()
        conn.execute('DETACH DATABASE subset_db')


def refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id=None):
    if not colmap_cfg.get('orbit_safe_mode'):
        return colmap_cfg

    geometry_stats = analyze_pair_geometry_stats(paths['database_path'])
    if not geometry_stats:
        return colmap_cfg

    original_matcher_params = dict(colmap_cfg.get('matcher_params') or {})
    existing_final_recovery_matching_pass = colmap_cfg.get('final_recovery_matching_pass')

    profile_rank = {
        'local-conservative': 0,
        'bridge-balanced': 1,
        'bridge-recovery': 2,
    }
    recovery_tuning = _recovery_auto_tuning(colmap_cfg)
    weak_boundary_quadratic_ratio = float(recovery_tuning['weak_boundary_quadratic_ratio'])
    weak_boundary_trigger_ratio = float(recovery_tuning['weak_boundary_trigger_ratio'])
    current_profile = colmap_cfg.get('orbit_safe_profile') or 'bridge-balanced'
    suggested_profile = current_profile

    if (
        geometry_stats['bridge_min'] < 18
        or geometry_stats['bridge_p10'] < 22
        or geometry_stats['weak_boundary_ratio'] >= weak_boundary_trigger_ratio
        or geometry_stats['zero_boundary_count'] > 0
    ):
        suggested_profile = 'bridge-recovery'
    elif (
        geometry_stats['bridge_p10'] < 30
        or geometry_stats['weak_boundary_ratio'] >= weak_boundary_quadratic_ratio
        or geometry_stats['adjacent_p10'] < 25
    ):
        suggested_profile = 'bridge-balanced'
    elif (
        geometry_stats['bridge_p10'] >= 55
        and geometry_stats['adjacent_p10'] >= 40
        and geometry_stats['weak_boundary_count'] == 0
        and geometry_stats['zero_boundary_count'] == 0
    ):
        suggested_profile = 'bridge-balanced'

    if profile_rank[suggested_profile] < profile_rank[current_profile]:
        suggested_profile = current_profile

    refined_policy = make_orbit_safe_policy(
        suggested_profile,
        geometry_stats['image_count'],
        colmap_cfg.get('bridge_risk_score', 0),
        colmap_cfg.get('capture_pattern') or {},
        (
            'Pair-geometry refinement after feature matching '
            f'({suggested_profile}, bridge_p10={geometry_stats["bridge_p10"]}, '
            f'weak_ratio={geometry_stats["weak_boundary_ratio"]})'
        ),
    )

    colmap_cfg['pair_geometry_stats'] = geometry_stats
    colmap_cfg['orbit_safe_profile'] = refined_policy['profile_name']
    colmap_cfg['matcher_params'] = dict(refined_policy['matcher_params'])
    colmap_cfg['mapper_params'] = dict(refined_policy['mapper_params'])
    colmap_cfg['recovery_matching_pass'] = None
    colmap_cfg['final_recovery_matching_pass'] = (
        existing_final_recovery_matching_pass
        if existing_final_recovery_matching_pass and not colmap_cfg.get('loop_detection_fallback_attempted')
        else None
    )
    colmap_cfg['min_num_matches'] = min(colmap_cfg['min_num_matches'], refined_policy['min_num_matches_cap'])
    colmap_cfg['init_num_trials'] = max(colmap_cfg['init_num_trials'], refined_policy['init_num_trials_floor'])
    colmap_cfg, floor_applied = apply_no_regression_floor(
        colmap_cfg,
        project_id=project_id,
        reason='preserving round-1-or-better permissiveness',
    )

    weak_boundary_count = geometry_stats.get('weak_boundary_count', 0)
    weak_boundary_ratio = float(geometry_stats.get('weak_boundary_ratio') or 0.0)
    bridge_p10 = float(geometry_stats.get('bridge_p10') or 0.0)
    bridge_min = float(geometry_stats.get('bridge_min') or 0.0)
    adjacent_p10 = float(geometry_stats.get('adjacent_p10') or 0.0)
    zero_boundary_count = int(geometry_stats.get('zero_boundary_count') or 0)

    overlap_plan = derive_data_driven_overlap_plan(
        geometry_stats,
        colmap_cfg['matcher_params'],
        frame_spacing_stats=(
            summarize_frame_selection_spacing(paths)
            if colmap_cfg.get('boundary_frame_densification_attempted')
            else None
        ),
    )
    if weak_boundary_count > 0:
        if overlap_plan and overlap_plan['target_overlap'] > overlap_plan['current_overlap']:
            colmap_cfg['matcher_params']['SequentialMatching.overlap'] = str(overlap_plan['target_overlap'])

        if weak_boundary_ratio >= weak_boundary_quadratic_ratio or zero_boundary_count > 0:
            colmap_cfg['matcher_params']['SequentialMatching.quadratic_overlap'] = '1'
            colmap_cfg['matcher_params']['SequentialMatching.loop_detection'] = '1'

        if weak_boundary_ratio >= max(weak_boundary_trigger_ratio * 0.75, weak_boundary_quadratic_ratio) or zero_boundary_count > 0:
            colmap_cfg['mapper_params']['Mapper.structure_less_registration_fallback'] = '1'
            colmap_cfg['mapper_params']['Mapper.abs_pose_min_num_inliers'] = str(
                min(
                    int(colmap_cfg['mapper_params'].get('Mapper.abs_pose_min_num_inliers', '18')),
                    10,
                )
            )
            colmap_cfg['mapper_params']['Mapper.abs_pose_min_inlier_ratio'] = str(
                min(
                    float(colmap_cfg['mapper_params'].get('Mapper.abs_pose_min_inlier_ratio', '0.12')),
                    0.07,
                )
            )
            colmap_cfg['mapper_params']['Mapper.max_reg_trials'] = str(
                max(
                    int(colmap_cfg['mapper_params'].get('Mapper.max_reg_trials', '8')),
                    18,
                )
            )
            colmap_cfg['min_num_matches'] = min(colmap_cfg['min_num_matches'], 8)
            colmap_cfg['init_num_trials'] = max(colmap_cfg['init_num_trials'], 320)

        if bridge_min <= 20 or (weak_boundary_count > 0 and adjacent_p10 < 24):
            colmap_cfg['mapper_params']['Mapper.structure_less_registration_fallback'] = '1'
            colmap_cfg['mapper_params']['Mapper.abs_pose_min_num_inliers'] = str(
                min(
                    int(colmap_cfg['mapper_params'].get('Mapper.abs_pose_min_num_inliers', '12')),
                    10,
                )
            )
            colmap_cfg['mapper_params']['Mapper.abs_pose_min_inlier_ratio'] = str(
                min(
                    float(colmap_cfg['mapper_params'].get('Mapper.abs_pose_min_inlier_ratio', '0.08')),
                    0.07,
                )
            )
            colmap_cfg['mapper_params']['Mapper.max_reg_trials'] = str(
                max(
                    int(colmap_cfg['mapper_params'].get('Mapper.max_reg_trials', '16')),
                    18,
                )
            )
            colmap_cfg['min_num_matches'] = min(colmap_cfg['min_num_matches'], 8)
            colmap_cfg['init_num_trials'] = max(colmap_cfg['init_num_trials'], 320)

    recovery_matching_pass = None
    refined_matcher_params = dict(colmap_cfg.get('matcher_params') or {})
    if (
        colmap_cfg.get('matcher_type') == 'sequential'
        and refined_matcher_params
        and refined_matcher_params != original_matcher_params
    ):
        changed_keys = sorted(
            key
            for key in set(original_matcher_params) | set(refined_matcher_params)
            if original_matcher_params.get(key) != refined_matcher_params.get(key)
        )
        changed_preview = ", ".join(
            f"{key}={refined_matcher_params.get(key)}" for key in changed_keys
        )
        base_reason = (
            'pair-geometry refinement changed sequential matcher settings '
            f'after the initial matching pass ({changed_preview})'
        )
        if refined_matcher_params.get('SequentialMatching.loop_detection') == '1':
            non_loop_matcher_params = dict(refined_matcher_params)
            non_loop_matcher_params['SequentialMatching.loop_detection'] = '0'
            recovery_matching_pass = {
                'kind': 'bridge_recovery_subset_loop_prep',
                'label': 'Bridge recovery rematch',
                'matcher_params': non_loop_matcher_params,
                'reason_code': 'weak_bridge',
                'reason': f'{base_reason}; widening overlap before loop detection fallback',
            }
            boundary_subset = build_boundary_recovery_subset(
                paths['database_path'],
                geometry_stats,
                int(refined_matcher_params.get('SequentialMatching.overlap', '40')),
            )
            final_recovery_matcher_params = dict(refined_matcher_params)
            subset_size = len((boundary_subset or {}).get('image_ids') or [])
            if subset_size > 0:
                loop_detection_num_images = min(20, max(8, subset_size // 2))
                loop_detection_images_after_verification = min(10, loop_detection_num_images)
                final_recovery_matcher_params['SequentialMatching.loop_detection_num_images'] = str(
                    loop_detection_num_images
                )
                final_recovery_matcher_params[
                    'SequentialMatching.loop_detection_num_nearest_neighbors'
                ] = '1'
                final_recovery_matcher_params['SequentialMatching.loop_detection_num_checks'] = '32'
                final_recovery_matcher_params[
                    'SequentialMatching.loop_detection_num_images_after_verification'
                ] = str(loop_detection_images_after_verification)
            colmap_cfg['final_recovery_matching_pass'] = {
                'kind': 'final_loop_detection_subset',
                'label': 'Final loop-detection fallback',
                'matcher_params': final_recovery_matcher_params,
                'reason_code': 'broad_fallback',
                'reason': f'{base_reason}; final loop-detection fallback after split sparse reconstruction',
                'boundary_subset': boundary_subset,
            }
        else:
            recovery_matching_pass = {
                'kind': 'bridge_recovery',
                'label': 'Bridge recovery rematch',
                'matcher_params': refined_matcher_params,
                'reason_code': 'weak_bridge',
                'reason': base_reason,
            }
    else:
        if (
            colmap_cfg.get('boundary_frame_densification_attempted')
            and weak_boundary_count == 0
            and zero_boundary_count == 0
            and not floor_applied
        ):
            recovery_matching_pass = None
        else:
            recovery_matching_pass = build_orbit_safe_bridge_recovery_pass(
                geometry_stats,
                refined_matcher_params,
            )
    if recovery_matching_pass:
        colmap_cfg['recovery_matching_pass'] = recovery_matching_pass

    if project_id:
        append_log_line(
            project_id,
            '🧠 Pair geometry stats: '
            f'bridge_p10={geometry_stats["bridge_p10"]}, '
            f'bridge_min={geometry_stats["bridge_min"]}, '
            f'weak_boundaries={geometry_stats["weak_boundary_count"]}/{geometry_stats["image_count"] - 1}',
        )
        append_log_line(
            project_id,
            '🧠 Pair-geometry refinement selected orbit-safe profile: '
            f'{refined_policy["profile_name"]} | '
            f'overlap={colmap_cfg["matcher_params"]["SequentialMatching.overlap"]} | '
            f'min_inliers={colmap_cfg["mapper_params"]["Mapper.abs_pose_min_num_inliers"]} | '
            f'min_ratio={colmap_cfg["mapper_params"]["Mapper.abs_pose_min_inlier_ratio"]} | '
            f'max_reg_trials={colmap_cfg["mapper_params"]["Mapper.max_reg_trials"]}',
        )
        weak_boundaries = geometry_stats.get('weak_boundaries') or []
        if weak_boundaries:
            boundary_preview = ", ".join(
                f"{item['left_image_name']}→{item['right_image_name']} "
                f"(adj={item['adjacent_inliers']}, bridge={item['bridge_strength']})"
                for item in weak_boundaries[:4]
            )
            append_log_line(project_id, f"🧠 Weak frame boundaries: {boundary_preview}")
            append_log_line(
                project_id,
                "🧠 Bridge-aware tuning applied before sparse reconstruction to preserve borderline frames",
            )
            if overlap_plan and overlap_plan['target_overlap'] > overlap_plan['current_overlap']:
                signal_preview = ", ".join(
                    f"{name}={score:g}" for name, score in overlap_plan['top_signals']
                )
                append_log_line(
                    project_id,
                    "🧠 Data-driven overlap tuning: "
                    f"{overlap_plan['current_overlap']}→{overlap_plan['target_overlap']}"
                    + (f" | signals={signal_preview}" if signal_preview else ""),
                )
        elif (
            colmap_cfg.get('boundary_frame_densification_attempted')
            and weak_boundary_count == 0
            and zero_boundary_count == 0
        ):
            append_log_line(
                project_id,
                "🧠 Densified image set no longer shows weak boundaries; skipping extra recovery matching",
            )
        if recovery_matching_pass:
            append_log_line(
                project_id,
                "🧠 Bridge-recovery matching pass queued: "
                f"overlap={recovery_matching_pass['matcher_params']['SequentialMatching.overlap']} | "
                f"reason={recovery_matching_pass['reason']}",
            )
        final_recovery_matching_pass = colmap_cfg.get('final_recovery_matching_pass')
        if final_recovery_matching_pass:
            boundary_subset = final_recovery_matching_pass.get('boundary_subset') or {}
            append_log_line(
                project_id,
                "🧠 Final loop-detection fallback armed for post-reconstruction recovery: "
                f"overlap={final_recovery_matching_pass['matcher_params']['SequentialMatching.overlap']}",
            )
            if boundary_subset.get('image_ids'):
                append_log_line(
                    project_id,
                    "🧠 Final loop-detection boundary subset: "
                    f"{len(boundary_subset['image_ids'])} images | "
                    f"weak_boundaries={boundary_subset.get('weak_boundary_count', 0)} | "
                    f"padding={boundary_subset.get('padding', 0)}",
                )

    return colmap_cfg


def run_orbit_safe_bridge_recovery_matching_pass(
    project_id,
    paths,
    config,
    colmap_exe,
    colmap_cfg,
    has_cuda,
    line_handler=None,
):
    recovery_matching_pass = colmap_cfg.get('recovery_matching_pass')
    if not recovery_matching_pass:
        return colmap_cfg

    if colmap_cfg.get('matcher_type') != 'sequential':
        return colmap_cfg

    matcher_params = dict(recovery_matching_pass['matcher_params'])
    loop_detection_enabled = matcher_params.get('SequentialMatching.loop_detection') == '1'
    prefer_gpu_matching = has_cuda
    boundary_subset = recovery_matching_pass.get('boundary_subset') or {}
    recovery_database_path = paths['database_path']
    subset_image_ids = list(boundary_subset.get('image_ids') or [])
    matching_health = {
        'gpu_issue_detected': False,
        'last_gpu_issue': None,
    }
    feature_profile = resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe)
    runtime_state = {
        'used_gpu': False,
        'cpu_fallback_used': False,
    }
    use_pair_targeted_matching = bool(
        recovery_matching_pass.get('pair_targeted')
        and subset_image_ids
        and feature_profile.get('extractor_type') == 'SIFT'
        and not feature_profile.get('is_native_neural')
    )

    append_log_line(
        project_id,
        "🔁 Running orbit-safe bridge recovery matching pass: "
        f"overlap={matcher_params['SequentialMatching.overlap']} | "
        f"reason={recovery_matching_pass['reason']}",
    )
    if loop_detection_enabled and has_cuda:
        append_log_line(
            project_id,
            "🧠 Loop-detection recovery pass will try GPU matching first with automatic CPU fallback",
        )
    if loop_detection_enabled and subset_image_ids:
        append_log_line(
            project_id,
            "🧠 Final loop-detection fallback is constrained to a boundary subset: "
            f"{len(subset_image_ids)} images",
        )
    elif subset_image_ids:
        append_log_line(
            project_id,
            "🧠 Recovery matching is constrained to a weak-window subset: "
            f"{len(subset_image_ids)} images | "
            f"weak_boundaries={boundary_subset.get('weak_boundary_count', 0)} | "
            f"padding={boundary_subset.get('padding', 0)}",
        )
    if use_pair_targeted_matching:
        pair_plan = recovery_matching_pass.get('pair_plan') or {}
        append_log_line(
            project_id,
            "🧠 Pair-targeted stubborn rematch enabled: "
            f"{pair_plan.get('pair_count', 0)} explicit pair(s) across "
            f"{len(pair_plan.get('boundary_plans') or [])} stubborn boundary window(s)",
        )
        for boundary_plan in (pair_plan.get('boundary_plans') or [])[:4]:
            append_log_line(
                project_id,
                "   ↳ pair plan "
                f"{boundary_plan.get('left_image_name', '?')}→{boundary_plan.get('right_image_name', '?')} | "
                f"cross_radius={boundary_plan.get('cross_radius', '--')} | "
                f"local_radius={boundary_plan.get('local_radius', '--')} | "
                f"pairs={boundary_plan.get('pair_count', '--')}"
                + (
                    f" / cap {boundary_plan.get('pair_budget_cap', '--')}"
                    if boundary_plan.get('pair_budget_cap')
                    else ""
                ),
            )
        if pair_plan.get('pair_budget_capped'):
            append_log_line(
                project_id,
                "🧠 Pair-target plan was capped by the machine budget: "
                f"total_cap={pair_plan.get('pair_budget_cap', '--')} | "
                f"reason={pair_plan.get('pair_budget_reason', '--')}",
            )
    elif recovery_matching_pass.get('pair_targeted') and subset_image_ids:
        append_log_line(
            project_id,
            "⚠️ Pair-targeted stubborn rematch requested, but the active feature pipeline is not SIFT-compatible; falling back to subset sequential matching",
        )

    def recovery_line_handler(line):
        if line_handler:
            line_handler(line)
        if runtime_state['used_gpu'] and is_gpu_matching_error_text(line):
            matching_health['gpu_issue_detected'] = True
            matching_health['last_gpu_issue'] = line.strip()
            append_log_line(project_id, f"⚠️ GPU bridge-recovery matching issue detected: {line.strip()}")

    def build_recovery_command(database_path, use_gpu):
        cmd = [
            colmap_exe,
            'sequential_matcher',
            '--database_path', str(database_path),
            '--FeatureMatching.max_num_matches', str(colmap_cfg['max_num_matches']),
            '--FeatureMatching.use_gpu', '1' if use_gpu else '0',
        ]

        if feature_profile['matcher_args']:
            cmd.extend(feature_profile['matcher_args'])

        for param, value in matcher_params.items():
            cmd.extend([f'--{param}', value])

        return cmd

    def build_pair_targeted_recovery_command(database_path, match_list_path, use_gpu, max_num_matches):
        return [
            colmap_exe,
            'matches_importer',
            '--database_path', str(database_path),
            '--match_list_path', str(match_list_path),
            '--match_type', 'pairs',
            '--SiftMatching.max_num_matches', str(max_num_matches),
            '--SiftMatching.use_gpu', '1' if use_gpu else '0',
        ]

    def run_recovery_command(use_gpu):
        runtime_state['used_gpu'] = use_gpu
        matching_health['gpu_issue_detected'] = False
        matching_health['last_gpu_issue'] = None

        if subset_image_ids:
            with tempfile.TemporaryDirectory(prefix='colmap-loop-subset-') as temp_dir:
                subset_database_path = Path(temp_dir) / 'subset.db'
                create_boundary_subset_database(
                    paths['database_path'],
                    subset_database_path,
                    subset_image_ids,
                )
                if use_pair_targeted_matching:
                    pair_plan = build_targeted_boundary_pair_plan(
                        boundary_subset.get('image_names') or [],
                        boundary_subset.get('target_boundaries') or [],
                        int(matcher_params.get('SequentialMatching.overlap', '12')),
                        gpu_total_vram_mb=get_gpu_total_vram_mb(),
                        max_num_matches=colmap_cfg.get('max_num_matches'),
                    )
                    if not pair_plan or not pair_plan.get('pairs'):
                        raise RuntimeError('pair-targeted stubborn rematch produced no pairs')
                    pair_list_path = Path(temp_dir) / 'stubborn_pairs.txt'
                    pair_list_path.write_text(
                        "\n".join(f"{first} {second}" for first, second in pair_plan['pairs']),
                        encoding='utf-8',
                    )
                    cmd = build_pair_targeted_recovery_command(
                        subset_database_path,
                        pair_list_path,
                        use_gpu,
                        int(colmap_cfg['max_num_matches']),
                    )
                else:
                    cmd = build_recovery_command(subset_database_path, use_gpu)
                run_command_with_logs(
                    project_id,
                    cmd,
                    line_handler=recovery_line_handler,
                    raw_line_filter=should_log_subprocess_line,
                )
                merge_boundary_subset_matches(subset_database_path, paths['database_path'])
        else:
            cmd = build_recovery_command(recovery_database_path, use_gpu)
            run_command_with_logs(
                project_id,
                cmd,
                line_handler=recovery_line_handler,
                raw_line_filter=should_log_subprocess_line,
            )

    try:
        run_recovery_command(prefer_gpu_matching)
    except subprocess.CalledProcessError as exc:
        if prefer_gpu_matching and (matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(exc))):
            runtime_state['cpu_fallback_used'] = True
            append_log_line(
                project_id,
                "⚠️ GPU bridge-recovery matching failed; retrying on CPU automatically"
                + (
                    f" ({matching_health['last_gpu_issue']})"
                    if matching_health['last_gpu_issue']
                    else ""
                ),
            )
            run_recovery_command(False)
        else:
            _append_recovery_history(
                colmap_cfg,
                {
                    'kind': recovery_matching_pass.get('kind') or 'bridge_recovery',
                    'label': recovery_matching_pass.get('label') or 'Recovery matching',
                    'reason': recovery_matching_pass.get('reason'),
                    'reason_code': recovery_matching_pass.get('reason_code') or 'recovery_pass_failed',
                    'step_order': _recovery_step_order(recovery_matching_pass.get('kind')),
                    'status': 'failed',
                    'outcome': 'abandoned_to_fallback',
                    'failed_step_key': recovery_matching_pass.get('kind'),
                    'fallback_step': (
                        (colmap_cfg.get('final_recovery_matching_pass') or {}).get('kind')
                    ),
                    'fallback_reason': 'recovery matching failed before sparse continuity was restored',
                    'subset_image_count': len(subset_image_ids),
                    'weak_boundary_count': boundary_subset.get('weak_boundary_count', 0),
                    'target_boundary_count': len(boundary_subset.get('target_boundaries') or []),
                    'runtime_mode': (
                        'cpu_fallback'
                        if runtime_state['cpu_fallback_used']
                        else ('gpu' if runtime_state['used_gpu'] else 'cpu')
                    ),
                    'tuned_decision_used': _tuned_decision_used(colmap_cfg),
                    'schema_version': RESOURCE_AWARE_SCHEMA_VERSION,
                },
            )
            raise

    if prefer_gpu_matching and matching_health['gpu_issue_detected'] and not runtime_state['cpu_fallback_used']:
        runtime_state['cpu_fallback_used'] = True
        append_log_line(
            project_id,
            "⚠️ GPU bridge-recovery matching reported compatibility issues; retrying on CPU automatically"
            + (
                f" ({matching_health['last_gpu_issue']})"
                if matching_health['last_gpu_issue']
                else ""
            ),
        )
        run_recovery_command(False)

    if runtime_state['cpu_fallback_used']:
        append_log_line(project_id, "✅ Bridge-recovery matching completed on CPU after GPU fallback")
    elif runtime_state['used_gpu']:
        if loop_detection_enabled:
            append_log_line(project_id, "✅ Loop-detection recovery matching completed on GPU")
        else:
            append_log_line(project_id, "✅ Bridge-recovery matching completed on GPU")
    else:
        append_log_line(project_id, "✅ Bridge-recovery matching completed on CPU")

    colmap_cfg['matcher_params'] = matcher_params
    colmap_cfg['recovery_matching_pass'] = None
    colmap_cfg = refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id)
    current_weak_boundaries = list(
        ((colmap_cfg.get('pair_geometry_stats') or {}).get('weak_boundaries')) or []
    )
    current_weak_boundaries_by_key = {
        _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name')): boundary
        for boundary in current_weak_boundaries
        if _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name'))
    }
    targeted_boundaries = list(boundary_subset.get('target_boundaries') or [])
    targeted_boundary_keys = {
        item.get('key')
        for item in targeted_boundaries
        if item.get('key')
    }
    targeted_boundaries_by_key = {
        item.get('key'): item
        for item in targeted_boundaries
        if item.get('key')
    }
    pair_plan = recovery_matching_pass.get('pair_plan') or {}
    boundary_pair_plans_by_key = {
        item.get('key'): item
        for item in pair_plan.get('boundary_plans') or []
        if item.get('key')
    }
    enriched_targeted_boundaries = []
    for boundary in targeted_boundaries:
        enriched_boundary = dict(boundary)
        pair_plan_boundary = boundary_pair_plans_by_key.get(boundary.get('key'))
        if pair_plan_boundary:
            enriched_boundary['cross_radius'] = pair_plan_boundary.get('cross_radius')
            enriched_boundary['local_radius'] = pair_plan_boundary.get('local_radius')
            enriched_boundary['pair_count'] = pair_plan_boundary.get('pair_count')
            enriched_boundary['pair_budget_cap'] = pair_plan_boundary.get('pair_budget_cap')
            enriched_boundary['pair_budget_capped'] = pair_plan_boundary.get('pair_budget_capped')
        enriched_boundary['outcome'] = _classify_boundary_outcome(
            boundary,
            current_weak_boundaries_by_key.get(boundary.get('key')),
            broad_fallback=recovery_matching_pass.get('kind') == 'final_loop_detection_subset',
        )
        enriched_targeted_boundaries.append(enriched_boundary)
    surviving_target_boundaries = [
        {
            'key': _make_boundary_key(
                boundary.get('left_image_name'),
                boundary.get('right_image_name'),
            ),
            'left_image_name': boundary.get('left_image_name'),
            'right_image_name': boundary.get('right_image_name'),
            'bridge_strength': boundary.get('bridge_strength'),
            'adjacent_inliers': boundary.get('adjacent_inliers'),
        }
        for boundary in current_weak_boundaries
        if _make_boundary_key(
            boundary.get('left_image_name'),
            boundary.get('right_image_name'),
        )
        in targeted_boundary_keys
    ]
    enriched_surviving_target_boundaries = []
    for boundary in surviving_target_boundaries:
        enriched_boundary = dict(boundary)
        pair_plan_boundary = boundary_pair_plans_by_key.get(boundary.get('key'))
        if pair_plan_boundary:
            enriched_boundary['cross_radius'] = pair_plan_boundary.get('cross_radius')
            enriched_boundary['local_radius'] = pair_plan_boundary.get('local_radius')
            enriched_boundary['pair_count'] = pair_plan_boundary.get('pair_count')
            enriched_boundary['pair_budget_cap'] = pair_plan_boundary.get('pair_budget_cap')
            enriched_boundary['pair_budget_capped'] = pair_plan_boundary.get('pair_budget_capped')
            enriched_boundary['outcome'] = _classify_boundary_outcome(
                targeted_boundaries_by_key.get(boundary.get('key')),
                boundary,
                broad_fallback=recovery_matching_pass.get('kind') == 'final_loop_detection_subset',
            )
        enriched_surviving_target_boundaries.append(enriched_boundary)
    if len(surviving_target_boundaries) == 0:
        outcome = 'repaired'
    elif recovery_matching_pass.get('kind') == 'final_loop_detection_subset':
        outcome = 'abandoned_to_fallback'
    elif use_pair_targeted_matching:
        outcome = 'stubborn'
    else:
        outcome = 'partially_repaired'
    _append_recovery_history(
        colmap_cfg,
        {
            'kind': recovery_matching_pass.get('kind') or 'bridge_recovery',
            'label': recovery_matching_pass.get('label') or 'Recovery matching',
            'reason': recovery_matching_pass.get('reason'),
            'reason_code': recovery_matching_pass.get('reason_code'),
            'step_order': _recovery_step_order(recovery_matching_pass.get('kind')),
            'status': 'completed',
            'outcome': outcome,
            'failed_step_key': None,
            'fallback_step': (
                recovery_matching_pass.get('kind')
                if recovery_matching_pass.get('kind') == 'final_loop_detection_subset'
                else None
            ),
            'fallback_reason': (
                'broad fallback remained necessary after local repair attempts'
                if recovery_matching_pass.get('kind') == 'final_loop_detection_subset'
                else None
            ),
            'subset_image_count': len(subset_image_ids),
            'weak_boundary_count': boundary_subset.get('weak_boundary_count', 0),
            'target_boundary_count': len(targeted_boundary_keys),
            'surviving_target_boundary_count': len(surviving_target_boundaries),
            'padding': boundary_subset.get('padding'),
            'overlap': matcher_params.get('SequentialMatching.overlap'),
            'quadratic_overlap': matcher_params.get('SequentialMatching.quadratic_overlap'),
            'loop_detection': matcher_params.get('SequentialMatching.loop_detection'),
            'runtime_mode': (
                'cpu_fallback'
                if runtime_state['cpu_fallback_used']
                else ('gpu' if runtime_state['used_gpu'] else 'cpu')
            ),
            'tuned_decision_used': _tuned_decision_used(colmap_cfg),
            'pair_targeted': use_pair_targeted_matching,
            'pair_count': int(pair_plan.get('pair_count') or 0),
            'pair_budget_cap': int(pair_plan.get('pair_budget_cap') or 0),
            'pair_budget_capped': bool(pair_plan.get('pair_budget_capped')),
            'pair_budget_reason': pair_plan.get('pair_budget_reason'),
            'targeted_boundaries': enriched_targeted_boundaries,
            'surviving_target_boundaries': enriched_surviving_target_boundaries,
            'geometry_stats': colmap_cfg.get('pair_geometry_stats'),
            'schema_version': RESOURCE_AWARE_SCHEMA_VERSION,
        },
    )
    return colmap_cfg


def clear_sparse_reconstruction_outputs(sparse_path):
    sparse_root = Path(sparse_path)
    if not sparse_root.exists():
        return

    for item in sparse_root.iterdir():
        if item.is_dir():
            shutil.rmtree(item)
        else:
            item.unlink()


def build_densified_overlap_retry_pass(paths, colmap_cfg, sparse_summary):
    if not sparse_summary or not sparse_summary.get('has_multiple_models'):
        return None

    if not colmap_cfg.get('boundary_frame_densification_attempted'):
        return None

    if colmap_cfg.get('densified_overlap_retry_attempted'):
        return None

    if colmap_cfg.get('matcher_type') != 'sequential':
        return None

    matcher_params = dict(colmap_cfg.get('matcher_params') or {})
    if not matcher_params:
        return None

    geometry_stats = colmap_cfg.get('pair_geometry_stats') or analyze_pair_geometry_stats(paths['database_path'])
    if not geometry_stats:
        return None

    overlap_plan = derive_data_driven_overlap_plan(
        geometry_stats,
        matcher_params,
        sparse_summary=sparse_summary,
        frame_spacing_stats=summarize_frame_selection_spacing(paths),
    )
    if not overlap_plan or overlap_plan['target_overlap'] <= overlap_plan['current_overlap']:
        return None

    retry_matcher_params = dict(matcher_params)
    retry_matcher_params['SequentialMatching.overlap'] = str(overlap_plan['target_overlap'])
    retry_matcher_params['SequentialMatching.quadratic_overlap'] = '1'
    retry_matcher_params['SequentialMatching.loop_detection'] = '0'

    top_signal_preview = ", ".join(
        f"{name}={score:g}" for name, score in overlap_plan['top_signals']
    )

    return {
        'kind': 'densified_overlap_retry',
        'label': 'Densified overlap retry',
        'matcher_params': retry_matcher_params,
        'reason_code': 'post_densification_survivor',
        'reason': (
            'data-driven densified-set overlap retry before any heavier fallback '
            f"(overlap {overlap_plan['current_overlap']}→{overlap_plan['target_overlap']}"
            + (f"; signals: {top_signal_preview}" if top_signal_preview else "")
            + ')'
        ),
        'overlap_plan': overlap_plan,
    }


def run_boundary_frame_densification_recovery(
    project_id,
    paths,
    config,
    colmap_cfg,
    *,
    rerun_feature_extraction_stage,
    rerun_feature_matching_stage,
    rerun_sparse_reconstruction_stage,
):
    densification_plan = build_boundary_frame_densification_plan(paths, colmap_cfg, config)
    if not densification_plan or densification_plan.get('inserted_count', 0) <= 0:
        return None

    planned_boundaries = densification_plan.get('planned_boundaries') or []
    densification_source = densification_plan.get('densification_source') or {}
    if densification_source.get('kind') == 'weak_window_subset':
        append_log_line(
            project_id,
            "🧠 Boundary densification is now scoped to weak-window survivors from the subset rematch, "
            f"not the full weak-boundary list ({densification_plan.get('selected_boundary_count', len(planned_boundaries))} surviving boundary window(s))",
        )
    append_log_line(
        project_id,
        "🧠 Rebuilding the image set with denser coverage at weak boundaries: "
        f"+{densification_plan['inserted_count']} frames across {len(planned_boundaries)} gap(s)"
        + (
            f" | base={densification_plan.get('base_target_segment_frames', '--')} "
            f"max={densification_plan.get('max_target_segment_frames', '--')}"
        ),
    )
    for boundary in planned_boundaries[:4]:
        append_log_line(
            project_id,
            "   ↳ densify "
            f"{boundary['left_image_name']}→{boundary['right_image_name']} with "
            f"{len(boundary['inserted_frame_indices'])} inserted frame(s)"
            f" | severity={boundary.get('severity_label', 'light')}"
            f" x{boundary.get('severity_multiplier', '--')}"
            f" | target={boundary.get('target_segment_frames', '--')}"
            f" | reason={boundary.get('severity_reason', 'baseline weak boundary')}",
        )

    current_manifest = densification_plan['manifest']
    rebuild_images_from_frame_manifest(
        project_id,
        paths,
        current_manifest,
        densification_plan['entries'],
        resolution=config.get('colmap_resolution', '2K'),
    )

    clear_sparse_reconstruction_outputs(paths['sparse_path'])
    clear_colmap_database(paths['database_path'])

    previous_floor = merge_no_regression_floors(
        colmap_cfg.get('no_regression_floor'),
        capture_no_regression_floor(colmap_cfg),
    )

    _, rerun_colmap_cfg, _, _ = get_colmap_config_for_pipeline(paths, config)
    rerun_colmap_cfg['boundary_frame_densification_attempted'] = True
    rerun_colmap_cfg['recovery_matching_pass'] = None
    rerun_colmap_cfg['final_recovery_matching_pass'] = None
    rerun_colmap_cfg['densified_overlap_retry_attempted'] = False
    rerun_colmap_cfg['loop_detection_fallback_attempted'] = True
    rerun_colmap_cfg['pair_geometry_stats'] = None
    rerun_colmap_cfg['recovery_history'] = list(colmap_cfg.get('recovery_history') or [])
    _append_recovery_history(
        rerun_colmap_cfg,
        {
            'kind': 'boundary_frame_densification',
            'label': 'Boundary frame densification',
            'reason_code': 'post_densification_survivor',
            'step_order': _recovery_step_order('boundary_frame_densification'),
            'status': 'completed',
            'outcome': 'partially_repaired',
            'reason': (
                f"inserted {densification_plan['inserted_count']} frame(s) across "
                f"{len(planned_boundaries)} weak boundary window(s)"
            ),
            'failed_step_key': None,
            'fallback_step': 'stubborn_boundary_subset',
            'fallback_reason': 'densification inserted targeted frames before escalating to a stronger subset rematch if survivors remain',
            'subset_image_count': None,
            'weak_boundary_count': len(planned_boundaries),
            'target_boundary_count': int(densification_plan.get('selected_boundary_count') or len(planned_boundaries)),
            'surviving_target_boundary_count': int(densification_plan.get('selected_boundary_count') or len(planned_boundaries)),
            'padding': None,
            'overlap': None,
            'quadratic_overlap': None,
            'loop_detection': None,
            'runtime_mode': 'reextract',
            'tuned_decision_used': _tuned_decision_used(colmap_cfg),
            'targeted_boundaries': [
                {
                    'key': _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name')),
                    'left_image_name': boundary.get('left_image_name'),
                    'right_image_name': boundary.get('right_image_name'),
                    'bridge_strength': boundary.get('bridge_strength'),
                    'adjacent_inliers': boundary.get('adjacent_inliers'),
                    'severity_label': boundary.get('severity_label'),
                    'severity_multiplier': boundary.get('severity_multiplier'),
                    'target_segment_frames': boundary.get('target_segment_frames'),
                    'inserted_frame_count': len(boundary.get('inserted_frame_indices') or []),
                }
                for boundary in planned_boundaries
                if _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name'))
            ],
            'surviving_target_boundaries': [
                {
                    'key': _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name')),
                    'left_image_name': boundary.get('left_image_name'),
                    'right_image_name': boundary.get('right_image_name'),
                    'bridge_strength': boundary.get('bridge_strength'),
                    'adjacent_inliers': boundary.get('adjacent_inliers'),
                    'severity_label': boundary.get('severity_label'),
                    'severity_multiplier': boundary.get('severity_multiplier'),
                    'target_segment_frames': boundary.get('target_segment_frames'),
                    'inserted_frame_count': len(boundary.get('inserted_frame_indices') or []),
                }
                for boundary in planned_boundaries
                if _make_boundary_key(boundary.get('left_image_name'), boundary.get('right_image_name'))
            ],
            'geometry_stats': colmap_cfg.get('pair_geometry_stats'),
            'schema_version': RESOURCE_AWARE_SCHEMA_VERSION,
        },
    )
    rerun_colmap_cfg['pre_densification_sparse_summary'] = dict(colmap_cfg.get('last_sparse_summary') or {})
    if previous_floor:
        rerun_colmap_cfg['no_regression_floor'] = previous_floor
        rerun_colmap_cfg, _ = apply_no_regression_floor(
            rerun_colmap_cfg,
            project_id=project_id,
            reason='round-2 baseline after boundary densification',
        )

    append_log_line(
        project_id,
        "🔁 Rerunning feature extraction, feature matching, and sparse reconstruction "
        "after boundary frame densification with a no-regression matcher floor",
    )
    rerun_colmap_cfg = rerun_feature_extraction_stage(project_id, paths, config, rerun_colmap_cfg)
    rerun_colmap_cfg = rerun_feature_matching_stage(project_id, paths, config, rerun_colmap_cfg)
    return rerun_sparse_reconstruction_stage(project_id, paths, config, rerun_colmap_cfg)


def should_run_final_loop_detection_recovery(colmap_cfg, sparse_summary, num_images):
    if not sparse_summary:
        return False

    if not sparse_summary.get('has_multiple_models'):
        return False

    if colmap_cfg.get('loop_detection_fallback_attempted'):
        return False

    if not colmap_cfg.get('final_recovery_matching_pass'):
        return False

    best_registered = int(sparse_summary.get('best_registered') or 0)
    alternate_registered = int(sparse_summary.get('alternate_registered') or 0)
    tuning = _recovery_auto_tuning(colmap_cfg)
    final_loop_trigger_ratio = float(tuning['final_loop_trigger_ratio'])
    final_loop_registered_ratio = float(tuning['final_loop_registered_ratio'])

    if best_registered >= int(num_images * final_loop_registered_ratio):
        return False

    return alternate_registered >= max(5, int(num_images * final_loop_trigger_ratio))
