"""Capture analysis and orbit-safe policy helpers for the pipeline runner."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from ..core.projects import append_log_line, update_reconstruction_framework
from .resource_contract import (
    RECOVERY_PRECEDENCE,
    RESOURCE_AWARE_SCHEMA_VERSION,
    missing_required_resource_fields,
)
from .frame_manifest import load_frame_selection_manifest

logger = logging.getLogger(__name__)

PHASE_REQUIRED_RESOURCE_FIELDS = {
    'feature_extraction': ['resource_profile', 'resource_lane', 'capture_budget_summary', 'auto_tuning_summary'],
    'feature_matching': ['resource_profile', 'resource_lane', 'capture_budget_summary', 'auto_tuning_summary'],
    'sparse_reconstruction': ['resource_profile', 'resource_lane', 'capture_budget_summary', 'recovery_loop_summary', 'auto_tuning_summary'],
    'gaussian_splatting': ['resource_profile', 'resource_lane', 'capture_budget_summary', 'recovery_loop_summary', 'training_budget_summary', 'auto_tuning_summary'],
}

ORDERED_CAPTURE_POLICY_IMAGE_LIMIT = 600
ORBIT_SAFE_PROFILE_PERMISSIVENESS = {
    'local-conservative': 0,
    'bridge-balanced': 1,
    'bridge-recovery': 2,
}


def summarize_name_ordering(image_names=None):
    normalized_names = [str(name).lower() for name in (image_names or [])]
    if not normalized_names:
        return {
            'frame_like_images': 0,
            'ordered_frame_ratio': 0.0,
            'ordered_name_ratio': 0.0,
            'dominant_pattern': None,
        }

    explicit_frame_like = 0
    prefix_groups = {}

    for name in normalized_names:
        stem = Path(name).stem.lower()
        if re.match(r'^(frame|img|image|photo|capture)[_-]?\d{2,}$', stem):
            explicit_frame_like += 1

        match = re.match(r'^(.*?)(\d{2,})$', stem)
        if not match:
            continue

        prefix = re.sub(r'[_-]+$', '', match.group(1)) or 'numeric'
        try:
            index = int(match.group(2))
        except ValueError:
            continue
        prefix_groups.setdefault(prefix, []).append(index)

    dominant_pattern = None
    ordered_name_ratio = 0.0
    dominant_frame_like = explicit_frame_like

    if prefix_groups:
        dominant_pattern, dominant_indices = max(prefix_groups.items(), key=lambda item: len(item[1]))
        dominant_indices = sorted(dominant_indices)
        if len(dominant_indices) >= 2:
            smooth_steps = sum(
                1 for left, right in zip(dominant_indices, dominant_indices[1:])
                if 0 < (right - left) <= 3
            )
            continuity_ratio = smooth_steps / max(len(dominant_indices) - 1, 1)
        else:
            continuity_ratio = 0.0

        coverage_ratio = len(dominant_indices) / len(normalized_names)
        ordered_name_ratio = round(coverage_ratio * continuity_ratio, 4)
        dominant_frame_like = max(explicit_frame_like, len(dominant_indices))

    explicit_frame_ratio = explicit_frame_like / len(normalized_names)
    ordered_frame_ratio = max(explicit_frame_ratio, ordered_name_ratio)

    return {
        'frame_like_images': dominant_frame_like,
        'ordered_frame_ratio': ordered_frame_ratio,
        'ordered_name_ratio': ordered_name_ratio,
        'dominant_pattern': dominant_pattern,
    }


def analyze_capture_pattern(paths, config=None):
    image_names = sorted(
        [
            image_path.name.lower()
            for image_path in Path(paths['images_path']).iterdir()
            if image_path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}
        ]
    )
    name_ordering = summarize_name_ordering(image_names)
    frame_like_images = name_ordering['frame_like_images']
    ordered_frame_ratio = name_ordering['ordered_frame_ratio']
    input_type = (config or {}).get('input_type')
    looks_like_video_input = input_type in {'video', 'mixed'} or ordered_frame_ratio >= 0.8

    return {
        'image_names': image_names,
        'frame_like_images': frame_like_images,
        'ordered_frame_ratio': ordered_frame_ratio,
        'ordered_name_ratio': name_ordering['ordered_name_ratio'],
        'dominant_pattern': name_ordering['dominant_pattern'],
        'looks_like_video_orbit': looks_like_video_input,
    }


def analyze_capture_pattern_from_names(image_names=None, config=None):
    normalized_names = [str(name).lower() for name in (image_names or [])]
    name_ordering = summarize_name_ordering(normalized_names)
    frame_like_images = name_ordering['frame_like_images']
    input_type = (config or {}).get('input_type')

    if normalized_names:
        ordered_frame_ratio = name_ordering['ordered_frame_ratio']
    elif input_type == 'video':
        ordered_frame_ratio = 1.0
        frame_like_images = int((config or {}).get('estimated_num_images') or 0)
    elif input_type == 'mixed':
        ordered_frame_ratio = 0.5
    else:
        ordered_frame_ratio = 0.0

    looks_like_video_input = input_type in {'video', 'mixed'} or ordered_frame_ratio >= 0.8

    return {
        'image_names': normalized_names,
        'frame_like_images': frame_like_images,
        'ordered_frame_ratio': ordered_frame_ratio,
        'ordered_name_ratio': name_ordering['ordered_name_ratio'] if normalized_names else 0.0,
        'dominant_pattern': name_ordering['dominant_pattern'] if normalized_names else None,
        'looks_like_video_orbit': looks_like_video_input,
    }


def should_use_orbit_safe_mode(paths, config, num_images):
    orbit_safe_policy = resolve_orbit_safe_policy(paths, config, num_images)
    if not orbit_safe_policy:
        return False, None

    return True, orbit_safe_policy['reason']


def get_orbit_safe_profile_settings(profile_name, num_images):
    if profile_name == 'bridge-recovery':
        overlap = '40' if num_images <= 80 else ('44' if num_images <= 150 else '52')
        return {
            'matcher_params': {
                'SequentialMatching.overlap': overlap,
                'SequentialMatching.quadratic_overlap': '1',
                'SequentialMatching.loop_detection': '0',
            },
            'mapper_params': {
                'Mapper.structure_less_registration_fallback': '1',
                'Mapper.abs_pose_max_error': '14',
                'Mapper.abs_pose_min_num_inliers': '12',
                'Mapper.abs_pose_min_inlier_ratio': '0.08',
                'Mapper.max_reg_trials': '16',
            },
            'min_num_matches_cap': 8,
            'init_num_trials_floor': 300,
        }

    if profile_name == 'bridge-balanced':
        overlap = '32' if num_images <= 80 else ('36' if num_images <= 150 else '44')
        return {
            'matcher_params': {
                'SequentialMatching.overlap': overlap,
                'SequentialMatching.quadratic_overlap': '1',
                'SequentialMatching.loop_detection': '0',
            },
            'mapper_params': {
                'Mapper.structure_less_registration_fallback': '1',
                'Mapper.abs_pose_max_error': '13',
                'Mapper.abs_pose_min_num_inliers': '14',
                'Mapper.abs_pose_min_inlier_ratio': '0.10',
                'Mapper.max_reg_trials': '12',
            },
            'min_num_matches_cap': 10,
            'init_num_trials_floor': 260,
        }

    overlap = '28' if num_images <= 80 else ('32' if num_images <= 150 else '40')
    return {
        'matcher_params': {
            'SequentialMatching.overlap': overlap,
            'SequentialMatching.quadratic_overlap': '1',
            'SequentialMatching.loop_detection': '0',
        },
        'mapper_params': {
            'Mapper.structure_less_registration_fallback': '0',
            'Mapper.abs_pose_max_error': '11',
            'Mapper.abs_pose_min_num_inliers': '22',
            'Mapper.abs_pose_min_inlier_ratio': '0.16',
            'Mapper.max_reg_trials': '6',
        },
        'min_num_matches_cap': 14,
        'init_num_trials_floor': 180,
    }


def get_orbit_safe_profile_permissiveness(profile_name):
    return ORBIT_SAFE_PROFILE_PERMISSIVENESS.get(str(profile_name or '').strip(), 0)


def merge_no_regression_floors(existing_floor, candidate_floor):
    if not existing_floor:
        return candidate_floor
    if not candidate_floor:
        return existing_floor

    merged_matcher = dict(existing_floor.get('matcher_params') or {})
    candidate_matcher = dict(candidate_floor.get('matcher_params') or {})

    overlap_values = []
    for source in (merged_matcher, candidate_matcher):
        try:
            overlap_values.append(int(source.get('SequentialMatching.overlap', '0')))
        except (TypeError, ValueError):
            continue
    if overlap_values:
        merged_matcher['SequentialMatching.overlap'] = str(max(overlap_values))

    for key in ('SequentialMatching.quadratic_overlap', 'SequentialMatching.loop_detection'):
        merged_matcher[key] = '1' if any(
            str(source.get(key, '0')) == '1'
            for source in (merged_matcher, candidate_matcher)
        ) else '0'

    merged_mapper = dict(existing_floor.get('mapper_params') or {})
    candidate_mapper = dict(candidate_floor.get('mapper_params') or {})

    if any(
        str(source.get('Mapper.structure_less_registration_fallback', '0')) == '1'
        for source in (merged_mapper, candidate_mapper)
    ):
        merged_mapper['Mapper.structure_less_registration_fallback'] = '1'
    else:
        merged_mapper['Mapper.structure_less_registration_fallback'] = '0'

    def _float_candidates(key):
        values = []
        for source in (merged_mapper, candidate_mapper):
            try:
                values.append(float(source.get(key)))
            except (TypeError, ValueError):
                continue
        return values

    def _int_candidates(key):
        values = []
        for source in (merged_mapper, candidate_mapper):
            try:
                values.append(int(source.get(key)))
            except (TypeError, ValueError):
                continue
        return values

    max_error_values = _float_candidates('Mapper.abs_pose_max_error')
    if max_error_values:
        merged_mapper['Mapper.abs_pose_max_error'] = str(max(max_error_values))

    min_inlier_values = _int_candidates('Mapper.abs_pose_min_num_inliers')
    if min_inlier_values:
        merged_mapper['Mapper.abs_pose_min_num_inliers'] = str(min(min_inlier_values))

    min_ratio_values = _float_candidates('Mapper.abs_pose_min_inlier_ratio')
    if min_ratio_values:
        merged_mapper['Mapper.abs_pose_min_inlier_ratio'] = str(min(min_ratio_values))

    reg_trial_values = _int_candidates('Mapper.max_reg_trials')
    if reg_trial_values:
        merged_mapper['Mapper.max_reg_trials'] = str(max(reg_trial_values))

    min_num_matches_values = []
    for floor in (existing_floor, candidate_floor):
        try:
            min_num_matches_values.append(int(floor.get('min_num_matches')))
        except (TypeError, ValueError):
            continue

    init_num_trials_values = []
    for floor in (existing_floor, candidate_floor):
        try:
            init_num_trials_values.append(int(floor.get('init_num_trials')))
        except (TypeError, ValueError):
            continue

    merged_profile = existing_floor.get('orbit_safe_profile')
    candidate_profile = candidate_floor.get('orbit_safe_profile')
    if get_orbit_safe_profile_permissiveness(candidate_profile) > get_orbit_safe_profile_permissiveness(merged_profile):
        merged_profile = candidate_profile

    return {
        'orbit_safe_profile': merged_profile,
        'matcher_params': merged_matcher,
        'mapper_params': merged_mapper,
        'min_num_matches': min(min_num_matches_values) if min_num_matches_values else None,
        'init_num_trials': max(init_num_trials_values) if init_num_trials_values else None,
    }


def capture_no_regression_floor(colmap_cfg):
    matcher_candidates = [dict(colmap_cfg.get('matcher_params') or {})]
    recovery_matching_pass = colmap_cfg.get('recovery_matching_pass') or {}
    if recovery_matching_pass.get('matcher_params'):
        matcher_candidates.append(dict(recovery_matching_pass['matcher_params']))

    matcher_floor = {}
    overlap_values = []
    for source in matcher_candidates:
        try:
            overlap_values.append(int(source.get('SequentialMatching.overlap', '0')))
        except (TypeError, ValueError):
            continue
    if overlap_values:
        matcher_floor['SequentialMatching.overlap'] = str(max(overlap_values))

    for key in ('SequentialMatching.quadratic_overlap', 'SequentialMatching.loop_detection'):
        matcher_floor[key] = '1' if any(
            str(source.get(key, '0')) == '1' for source in matcher_candidates
        ) else '0'

    return {
        'orbit_safe_profile': colmap_cfg.get('orbit_safe_profile'),
        'matcher_params': matcher_floor,
        'mapper_params': dict(colmap_cfg.get('mapper_params') or {}),
        'min_num_matches': colmap_cfg.get('min_num_matches'),
        'init_num_trials': colmap_cfg.get('init_num_trials'),
    }


def apply_no_regression_floor(colmap_cfg, project_id=None, reason=None):
    floor = colmap_cfg.get('no_regression_floor') or {}
    if not floor:
        return colmap_cfg, False

    matcher_params = dict(colmap_cfg.get('matcher_params') or {})
    mapper_params = dict(colmap_cfg.get('mapper_params') or {})
    changes = []

    floor_profile = floor.get('orbit_safe_profile')
    current_profile = colmap_cfg.get('orbit_safe_profile')
    if get_orbit_safe_profile_permissiveness(floor_profile) > get_orbit_safe_profile_permissiveness(current_profile):
        colmap_cfg['orbit_safe_profile'] = floor_profile
        changes.append(f'profile={floor_profile}')

    floor_matcher = dict(floor.get('matcher_params') or {})
    if colmap_cfg.get('matcher_type') == 'sequential':
        try:
            current_overlap = int(matcher_params.get('SequentialMatching.overlap', '0'))
        except (TypeError, ValueError):
            current_overlap = 0
        try:
            floor_overlap = int(floor_matcher.get('SequentialMatching.overlap', '0'))
        except (TypeError, ValueError):
            floor_overlap = 0
        if floor_overlap > current_overlap:
            matcher_params['SequentialMatching.overlap'] = str(floor_overlap)
            changes.append(f'overlap={current_overlap}->{floor_overlap}')

        for key in ('SequentialMatching.quadratic_overlap', 'SequentialMatching.loop_detection'):
            current_value = str(matcher_params.get(key, '0'))
            floor_value = str(floor_matcher.get(key, '0'))
            if floor_value == '1' and current_value != '1':
                matcher_params[key] = '1'
                changes.append(f'{key}=1')

    floor_mapper = dict(floor.get('mapper_params') or {})
    if (
        str(floor_mapper.get('Mapper.structure_less_registration_fallback', '0')) == '1'
        and str(mapper_params.get('Mapper.structure_less_registration_fallback', '0')) != '1'
    ):
        mapper_params['Mapper.structure_less_registration_fallback'] = '1'
        changes.append('structure_less_registration_fallback=1')

    def _get_float(mapping, key):
        try:
            return float(mapping.get(key))
        except (TypeError, ValueError):
            return None

    def _get_int(mapping, key):
        try:
            return int(mapping.get(key))
        except (TypeError, ValueError):
            return None

    current_max_error = _get_float(mapper_params, 'Mapper.abs_pose_max_error')
    floor_max_error = _get_float(floor_mapper, 'Mapper.abs_pose_max_error')
    if floor_max_error is not None and (current_max_error is None or floor_max_error > current_max_error):
        mapper_params['Mapper.abs_pose_max_error'] = str(floor_max_error)
        changes.append(f'abs_pose_max_error={current_max_error}->{floor_max_error}')

    current_min_inliers = _get_int(mapper_params, 'Mapper.abs_pose_min_num_inliers')
    floor_min_inliers = _get_int(floor_mapper, 'Mapper.abs_pose_min_num_inliers')
    if floor_min_inliers is not None and (current_min_inliers is None or floor_min_inliers < current_min_inliers):
        mapper_params['Mapper.abs_pose_min_num_inliers'] = str(floor_min_inliers)
        changes.append(f'abs_pose_min_num_inliers={current_min_inliers}->{floor_min_inliers}')

    current_min_ratio = _get_float(mapper_params, 'Mapper.abs_pose_min_inlier_ratio')
    floor_min_ratio = _get_float(floor_mapper, 'Mapper.abs_pose_min_inlier_ratio')
    if floor_min_ratio is not None and (current_min_ratio is None or floor_min_ratio < current_min_ratio):
        mapper_params['Mapper.abs_pose_min_inlier_ratio'] = str(floor_min_ratio)
        changes.append(f'abs_pose_min_inlier_ratio={current_min_ratio}->{floor_min_ratio}')

    current_reg_trials = _get_int(mapper_params, 'Mapper.max_reg_trials')
    floor_reg_trials = _get_int(floor_mapper, 'Mapper.max_reg_trials')
    if floor_reg_trials is not None and (current_reg_trials is None or floor_reg_trials > current_reg_trials):
        mapper_params['Mapper.max_reg_trials'] = str(floor_reg_trials)
        changes.append(f'max_reg_trials={current_reg_trials}->{floor_reg_trials}')

    try:
        current_min_num_matches = int(colmap_cfg.get('min_num_matches'))
    except (TypeError, ValueError):
        current_min_num_matches = None
    try:
        floor_min_num_matches = int(floor.get('min_num_matches'))
    except (TypeError, ValueError):
        floor_min_num_matches = None
    if floor_min_num_matches is not None and (
        current_min_num_matches is None or floor_min_num_matches < current_min_num_matches
    ):
        colmap_cfg['min_num_matches'] = floor_min_num_matches
        changes.append(f'min_num_matches={current_min_num_matches}->{floor_min_num_matches}')

    try:
        current_init_num_trials = int(colmap_cfg.get('init_num_trials'))
    except (TypeError, ValueError):
        current_init_num_trials = None
    try:
        floor_init_num_trials = int(floor.get('init_num_trials'))
    except (TypeError, ValueError):
        floor_init_num_trials = None
    if floor_init_num_trials is not None and (
        current_init_num_trials is None or floor_init_num_trials > current_init_num_trials
    ):
        colmap_cfg['init_num_trials'] = floor_init_num_trials
        changes.append(f'init_num_trials={current_init_num_trials}->{floor_init_num_trials}')

    colmap_cfg['matcher_params'] = matcher_params
    colmap_cfg['mapper_params'] = mapper_params

    if changes and project_id:
        prefix = "🧠 No-regression floor applied"
        if reason:
            prefix += f" ({reason})"
        append_log_line(project_id, f"{prefix}: {', '.join(changes)}")

    return colmap_cfg, bool(changes)


def make_orbit_safe_policy(profile_name, num_images, bridge_risk_score, capture_pattern, reason):
    settings = get_orbit_safe_profile_settings(profile_name, num_images)
    return {
        'profile_name': profile_name,
        'reason': reason,
        'bridge_risk_score': bridge_risk_score,
        'matcher_params': settings['matcher_params'],
        'mapper_params': settings['mapper_params'],
        'min_num_matches_cap': settings['min_num_matches_cap'],
        'init_num_trials_floor': settings['init_num_trials_floor'],
        'capture_pattern': capture_pattern,
    }


def percentile(values, ratio):
    if not values:
        return 0.0

    ordered = sorted(values)
    index = max(0, min(len(ordered) - 1, int(round((len(ordered) - 1) * ratio))))
    return float(ordered[index])


def summarize_frame_selection_spacing(paths):
    manifest = load_frame_selection_manifest(paths)
    if not manifest:
        return None

    entries = list(manifest.get('entries') or [])
    if len(entries) < 2:
        return None

    deltas = []
    previous_entry = None
    for entry in entries:
        source_index = entry.get('source_frame_index')
        source_video_path = entry.get('source_video_path')
        if source_index is None:
            previous_entry = None
            continue

        if previous_entry and previous_entry.get('source_video_path') == source_video_path:
            delta = int(source_index) - int(previous_entry['source_frame_index'])
            if delta > 0:
                deltas.append(delta)

        previous_entry = {
            'source_frame_index': int(source_index),
            'source_video_path': source_video_path,
        }

    if not deltas:
        return None

    mean_delta = sum(deltas) / max(1, len(deltas))
    p50_delta = percentile(deltas, 0.50)
    p90_delta = percentile(deltas, 0.90)

    return {
        'count': len(deltas),
        'mean': round(mean_delta, 3),
        'p50': round(p50_delta, 3),
        'p90': round(p90_delta, 3),
        'max': max(deltas),
        'irregularity_ratio': round(p90_delta / max(1.0, p50_delta), 3),
        'max_gap_ratio': round(max(deltas) / max(1.0, p90_delta), 3),
    }


def compute_sequential_overlap_cap(image_count, current_overlap, frame_spacing_stats=None):
    image_count = max(2, int(image_count or 0))
    current_overlap = max(1, int(current_overlap or 1))

    sqrt_cap = int(round((image_count ** 0.5) * 3.0))
    proportional_cap = int(round(image_count * 0.14))
    dynamic_cap = max(current_overlap + 4, sqrt_cap, proportional_cap)

    if frame_spacing_stats:
        dynamic_cap += int(
            round(
                max(0.0, float(frame_spacing_stats.get('irregularity_ratio') or 0.0) - 1.2) * 4.0
            )
        )

    return min(image_count - 1, max(current_overlap, dynamic_cap))


def derive_data_driven_overlap_plan(
    geometry_stats,
    matcher_params,
    *,
    sparse_summary=None,
    frame_spacing_stats=None,
):
    if not geometry_stats or not matcher_params:
        return None

    try:
        current_overlap = int(matcher_params.get('SequentialMatching.overlap', '0'))
    except (TypeError, ValueError):
        return None

    if current_overlap <= 0:
        return None

    image_count = int(geometry_stats.get('image_count') or 0)
    weak_boundary_count = int(geometry_stats.get('weak_boundary_count') or 0)
    weak_boundary_ratio = float(geometry_stats.get('weak_boundary_ratio') or 0.0)
    zero_boundary_count = int(geometry_stats.get('zero_boundary_count') or 0)
    bridge_p10 = float(geometry_stats.get('bridge_p10') or 0.0)
    bridge_min = float(geometry_stats.get('bridge_min') or 0.0)
    adjacent_p10 = float(geometry_stats.get('adjacent_p10') or 0.0)

    bridge_floor = min(
        value for value in (bridge_min, bridge_p10) if value > 0
    ) if any(value > 0 for value in (bridge_min, bridge_p10)) else 0.0

    signal_scores = {
        'zero_boundary': float(zero_boundary_count) * 4.0,
        'bridge_floor': max(0.0, (24.0 - bridge_floor) / 2.2),
        'bridge_p10': max(0.0, (28.0 - bridge_p10) / 3.0),
        'adjacent_p10': max(0.0, (26.0 - adjacent_p10) / 4.0),
        'weak_boundary': min(
            12.0,
            (weak_boundary_count * 1.4) + (weak_boundary_ratio * max(1, image_count) * 0.35),
        ),
        'spacing_irregularity': 0.0,
        'spacing_gap': 0.0,
        'sparse_fragmentation': 0.0,
        'sparse_alternate': 0.0,
        'sparse_model_count': 0.0,
    }

    if frame_spacing_stats:
        irregularity_ratio = float(frame_spacing_stats.get('irregularity_ratio') or 0.0)
        max_gap_ratio = float(frame_spacing_stats.get('max_gap_ratio') or 0.0)
        signal_scores['spacing_irregularity'] = max(0.0, irregularity_ratio - 1.15) * 4.0
        signal_scores['spacing_gap'] = max(0.0, max_gap_ratio - 1.15) * 3.0

    if sparse_summary:
        registered_ratio = float(sparse_summary.get('registered_ratio') or 0.0)
        alternate_ratio = float(sparse_summary.get('alternate_registered') or 0) / max(1, image_count)
        model_count = int(sparse_summary.get('model_count') or 0)
        signal_scores['sparse_fragmentation'] = max(0.0, 0.72 - registered_ratio) * 22.0
        signal_scores['sparse_alternate'] = alternate_ratio * 10.0
        signal_scores['sparse_model_count'] = max(0, model_count - 1) * 0.8

    raw_boost = sum(signal_scores.values())
    minimum_boost = 0
    if zero_boundary_count > 0:
        minimum_boost = 8
    elif weak_boundary_count > 0 or bridge_min <= 20 or bridge_p10 < 24:
        minimum_boost = 4
    elif sparse_summary and sparse_summary.get('has_multiple_models'):
        minimum_boost = 3

    overlap_cap = compute_sequential_overlap_cap(
        image_count,
        current_overlap,
        frame_spacing_stats=frame_spacing_stats,
    )
    overlap_boost = min(max(0, overlap_cap - current_overlap), max(minimum_boost, int(round(raw_boost))))
    target_overlap = min(overlap_cap, current_overlap + overlap_boost)

    sorted_signals = sorted(
        (
            (name, round(score, 3))
            for name, score in signal_scores.items()
            if score > 0.0
        ),
        key=lambda item: item[1],
        reverse=True,
    )

    return {
        'current_overlap': current_overlap,
        'target_overlap': target_overlap,
        'overlap_boost': overlap_boost,
        'overlap_cap': overlap_cap,
        'top_signals': sorted_signals[:3],
    }


def build_orbit_safe_bridge_recovery_pass(geometry_stats, matcher_params):
    overlap_plan = derive_data_driven_overlap_plan(geometry_stats, matcher_params)
    if not overlap_plan or overlap_plan['target_overlap'] <= overlap_plan['current_overlap']:
        return None

    refined_matcher_params = dict(matcher_params)
    refined_matcher_params['SequentialMatching.overlap'] = str(overlap_plan['target_overlap'])
    refined_matcher_params['SequentialMatching.quadratic_overlap'] = '1'
    refined_matcher_params['SequentialMatching.loop_detection'] = '1'

    if refined_matcher_params == matcher_params:
        return None

    top_signal_preview = ", ".join(
        f"{name}={score:g}" for name, score in overlap_plan['top_signals']
    )
    reason = (
        'data-driven bridge recovery '
        f"(overlap {overlap_plan['current_overlap']}→{overlap_plan['target_overlap']}"
        + (f"; signals: {top_signal_preview}" if top_signal_preview else "")
        + ')'
    )

    return {
        'kind': 'bridge_recovery',
        'label': 'Bridge recovery rematch',
        'matcher_params': refined_matcher_params,
        'reason_code': 'weak_bridge',
        'reason': reason,
        'overlap_plan': overlap_plan,
    }


def _summarize_recovery_loop(colmap_cfg):
    recovery_history = list(colmap_cfg.get('recovery_history') or [])
    pair_geometry_stats = dict(colmap_cfg.get('pair_geometry_stats') or {})
    sparse_summary = dict(colmap_cfg.get('last_sparse_summary') or {})

    final_path = 'baseline'
    broad_fallback_used = False
    local_repair_count = len(recovery_history)
    final_reason_code = None

    for step in recovery_history:
        kind = step.get('kind')
        if kind == 'final_loop_detection_subset':
            final_path = 'broad_fallback'
            broad_fallback_used = True
        elif step.get('pair_targeted'):
            final_path = 'stubborn_targeted_pairs'
        elif kind == 'boundary_frame_densification':
            final_path = 'densification'
        elif kind in {'weak_window_subset', 'stubborn_boundary_subset'}:
            final_path = 'subset_repair'
        elif kind and kind.startswith('bridge_recovery'):
            final_path = 'bridge_recovery'
        if step.get('reason_code'):
            final_reason_code = step.get('reason_code')

    unresolved_weak_boundaries = int(pair_geometry_stats.get('weak_boundary_count') or 0)
    unresolved_split = bool(sparse_summary.get('has_multiple_models'))

    if broad_fallback_used:
        state = 'fallback_used'
    elif local_repair_count > 0 and (unresolved_weak_boundaries == 0 and not unresolved_split):
        state = 'local_repair'
    elif local_repair_count == 0 and unresolved_weak_boundaries == 0 and not unresolved_split:
        state = 'clean'
    else:
        state = 'unresolved'

    return {
        'schema_version': RESOURCE_AWARE_SCHEMA_VERSION,
        'precedence': list(RECOVERY_PRECEDENCE),
        'final_path': final_path,
        'state': state,
        'local_repair_count': local_repair_count,
        'broad_fallback_used': broad_fallback_used,
        'final_reason_code': final_reason_code,
        'unresolved_weak_boundary_count': unresolved_weak_boundaries,
        'unresolved_split_model': unresolved_split,
    }


def sync_reconstruction_framework(project_id, config, colmap_cfg, *, phase, extra=None):
    if not project_id:
        return

    framework_state = {
        'phase': phase,
        'sfm_engine': config.get('sfm_engine', 'glomap'),
        'sfm_backend': config.get('sfm_backend', 'cli'),
        'feature_method': config.get('feature_method', 'sift'),
        'matcher_type': colmap_cfg.get('matcher_type'),
        'orbit_safe_mode': colmap_cfg.get('orbit_safe_mode', False),
        'orbit_safe_profile': colmap_cfg.get('orbit_safe_profile'),
        'bridge_risk_score': colmap_cfg.get('bridge_risk_score'),
        'pair_geometry_stats': colmap_cfg.get('pair_geometry_stats'),
        'matcher_params': dict(colmap_cfg.get('matcher_params', {})),
        'mapper_params': dict(colmap_cfg.get('mapper_params', {})),
        'capture_pattern': colmap_cfg.get('capture_pattern'),
        'progressive_matching_plan': colmap_cfg.get('progressive_matching_plan'),
        'progressive_matching_checkpoints': colmap_cfg.get(
            'progressive_matching_checkpoints'
        ),
        'recovery_history': colmap_cfg.get('recovery_history'),
        'resource_contract_version': RESOURCE_AWARE_SCHEMA_VERSION,
        'recovery_loop_summary': _summarize_recovery_loop(colmap_cfg),
    }

    for key in (
        'resource_profile',
        'resource_lane',
        'resource_lane_state',
        'admission_reason',
        'downgrade_reason',
        'estimated_start_delay',
        'capture_budget_summary',
        'auto_tuning_summary',
    ):
        if key in colmap_cfg:
            framework_state[key] = colmap_cfg.get(key)

    if extra:
        framework_state.update(extra)

    missing_fields = missing_required_resource_fields(
        framework_state,
        required_fields=PHASE_REQUIRED_RESOURCE_FIELDS.get(phase),
    )
    if missing_fields:
        logger.warning(
            "Resource-aware framework payload is missing fields for %s during %s: %s",
            project_id,
            phase,
            ", ".join(missing_fields),
        )

    update_reconstruction_framework(project_id, framework_state)


def build_orbit_safe_policy(paths, config, num_images):
    capture_pattern = analyze_capture_pattern(paths, config)
    return build_orbit_safe_policy_from_capture(capture_pattern, config, num_images)


def resolve_orbit_safe_policy(paths, config, num_images):
    orbit_safe_policy = build_orbit_safe_policy(paths, config, num_images)
    if not orbit_safe_policy:
        return None

    return orbit_safe_policy


def build_orbit_safe_policy_from_capture(capture_pattern, config, num_images):
    looks_like_video_orbit = capture_pattern['looks_like_video_orbit']
    if not looks_like_video_orbit:
        return None

    if num_images < 24 or num_images > ORDERED_CAPTURE_POLICY_IMAGE_LIMIT:
        return None

    if config.get('fast_sfm', False):
        return None

    target_fps = config.get('target_fps')
    try:
        target_fps = float(target_fps) if target_fps is not None else None
    except (TypeError, ValueError):
        target_fps = None

    bridge_risk_score = 0
    if num_images <= 120:
        bridge_risk_score += 2
    elif num_images <= 180:
        bridge_risk_score += 1

    if capture_pattern['ordered_frame_ratio'] >= 0.95:
        bridge_risk_score += 1

    if config.get('input_type') == 'video':
        bridge_risk_score += 1

    if target_fps is not None and target_fps <= 1.0:
        bridge_risk_score += 1

    if bridge_risk_score >= 4:
        profile_name = 'bridge-recovery'
    elif bridge_risk_score >= 2:
        profile_name = 'bridge-balanced'
    else:
        profile_name = 'local-conservative'

    reason = (
        'Ordered video/orbit frames benefit from local temporal matching and adaptive bridge-aware '
        f'pose registration ({profile_name}, risk={bridge_risk_score})'
    )

    return make_orbit_safe_policy(profile_name, num_images, bridge_risk_score, capture_pattern, reason)
