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
    is_gpu_matching_error_text,
    resolve_colmap_feature_pipeline_profile,
    should_log_subprocess_line,
)

COLMAP_PAIR_ID_FACTOR = 2147483647


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


def build_boundary_recovery_subset(database_path, geometry_stats, overlap, max_images=96):
    if not Path(database_path).exists():
        return None

    weak_boundaries = list((geometry_stats or {}).get('weak_boundaries') or [])
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
    current_profile = colmap_cfg.get('orbit_safe_profile') or 'bridge-balanced'
    suggested_profile = current_profile

    if (
        geometry_stats['bridge_min'] < 18
        or geometry_stats['bridge_p10'] < 22
        or geometry_stats['weak_boundary_ratio'] >= 0.08
        or geometry_stats['zero_boundary_count'] > 0
    ):
        suggested_profile = 'bridge-recovery'
    elif (
        geometry_stats['bridge_p10'] < 30
        or geometry_stats['weak_boundary_ratio'] >= 0.03
        or geometry_stats['adjacent_p10'] < 25
    ):
        suggested_profile = 'bridge-balanced'
    elif geometry_stats['bridge_p10'] >= 55 and geometry_stats['weak_boundary_count'] == 0:
        suggested_profile = 'local-conservative'

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

        if weak_boundary_ratio >= 0.03 or zero_boundary_count > 0:
            colmap_cfg['matcher_params']['SequentialMatching.quadratic_overlap'] = '1'
            colmap_cfg['matcher_params']['SequentialMatching.loop_detection'] = '1'

        if weak_boundary_ratio >= 0.06 or zero_boundary_count > 0:
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
                'matcher_params': non_loop_matcher_params,
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
                'matcher_params': final_recovery_matcher_params,
                'reason': f'{base_reason}; final loop-detection fallback after split sparse reconstruction',
                'boundary_subset': boundary_subset,
            }
        else:
            recovery_matching_pass = {
                'matcher_params': refined_matcher_params,
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

    def run_recovery_command(use_gpu):
        runtime_state['used_gpu'] = use_gpu
        matching_health['gpu_issue_detected'] = False
        matching_health['last_gpu_issue'] = None

        if loop_detection_enabled and subset_image_ids:
            with tempfile.TemporaryDirectory(prefix='colmap-loop-subset-') as temp_dir:
                subset_database_path = Path(temp_dir) / 'subset.db'
                create_boundary_subset_database(
                    paths['database_path'],
                    subset_database_path,
                    subset_image_ids,
                )
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
    return refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id)


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
        'matcher_params': retry_matcher_params,
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
    append_log_line(
        project_id,
        "🧠 Rebuilding the image set with denser coverage at weak boundaries: "
        f"+{densification_plan['inserted_count']} frames across {len(planned_boundaries)} gap(s)",
    )
    for boundary in planned_boundaries[:4]:
        append_log_line(
            project_id,
            "   ↳ densify "
            f"{boundary['left_image_name']}→{boundary['right_image_name']} with "
            f"{len(boundary['inserted_frame_indices'])} inserted frame(s)",
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

    if best_registered >= num_images:
        return False

    return alternate_registered >= max(5, int(num_images * 0.05))
