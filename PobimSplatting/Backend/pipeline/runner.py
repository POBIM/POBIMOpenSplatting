"""High-level processing pipeline orchestration."""

from __future__ import annotations

import logging
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import time
import importlib
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..core import config as app_config
from ..core import projects as project_store
from ..core.commands import run_command_with_logs
from ..core.projects import (
    append_log_line,
    emit_stage_progress,
    save_projects_db,
    update_stage_detail,
    update_reconstruction_framework,
    update_state,
)
from ..utils.video_processor import VideoProcessor

logger = logging.getLogger(__name__)

COLMAP_PAIR_ID_FACTOR = 2147483647
ORDERED_CAPTURE_POLICY_IMAGE_LIMIT = 600
FRAME_SELECTION_MANIFEST_NAME = 'frame_selection_manifest.json'
ORBIT_SAFE_PROFILE_PERMISSIVENESS = {
    'local-conservative': 0,
    'bridge-balanced': 1,
    'bridge-recovery': 2,
}

video_processor = VideoProcessor()


def get_glomap_executable():
    """Get the appropriate GLOMAP executable (must be compatible with COLMAP version).
    
    IMPORTANT: GLOMAP must be built with the same COLMAP version to read the database.
    Using mismatched versions causes 'SQLite error: SQL logic error'.
    """
    for candidate in app_config.GLOMAP_CANDIDATE_PATHS:
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue

    # Fallback: check system PATH (may have version mismatch issues)
    try:
        result = subprocess.run(['which', 'glomap'], capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    
    return None

GLOMAP_PATH = get_glomap_executable()

def get_fastmap_executable():
    if hasattr(app_config, 'FASTMAP_PATH') and app_config.FASTMAP_PATH:
        return app_config.FASTMAP_PATH
    return None

FASTMAP_PATH = get_fastmap_executable()

def check_hloc_available():
    """Check if hloc is available for neural feature extraction."""
    if hasattr(app_config, 'HLOC_INSTALLED') and app_config.HLOC_INSTALLED:
        return True
    try:
        import hloc
        from lightglue import LightGlue, ALIKED
        return True
    except ImportError:
        return False

HLOC_AVAILABLE = check_hloc_available()


def normalize_feature_method(feature_method):
    if feature_method is None:
        return 'sift'

    normalized = str(feature_method).strip().lower()
    if normalized in {'sift', 'aliked', 'superpoint'}:
        return normalized

    return 'sift'


def normalize_matcher_type(matcher_type):
    if matcher_type is None:
        return None

    normalized = str(matcher_type).strip().lower()
    if normalized in {"sequential", "exhaustive", "vocab_tree"}:
        return normalized

    return None


def normalize_sfm_engine(sfm_engine):
    if sfm_engine is None:
        return 'glomap'

    normalized = str(sfm_engine).strip().lower()
    if normalized in {'glomap', 'global', 'global_mapper'}:
        return 'glomap'
    if normalized in {'colmap', 'incremental'}:
        return 'colmap'
    if normalized == 'fastmap':
        return 'fastmap'
    return 'glomap'


def normalize_sfm_backend(sfm_backend):
    if sfm_backend is None:
        return 'cli'

    normalized = str(sfm_backend).strip().lower()
    if normalized in {'cli', 'command', 'subprocess'}:
        return 'cli'
    if normalized in {'pycolmap', 'python'}:
        return 'pycolmap'
    return 'cli'


@lru_cache(maxsize=1)
def get_pycolmap_module():
    try:
        return importlib.import_module('pycolmap')
    except Exception:
        return None


def pycolmap_supports_global_mapping():
    pycolmap = get_pycolmap_module()
    return bool(
        pycolmap
        and hasattr(pycolmap, 'global_mapping')
        and hasattr(pycolmap, 'GlobalMapperOptions')
        and hasattr(pycolmap, 'BundleAdjustmentOptions')
    )


@lru_cache(maxsize=4)
def colmap_supports_global_mapper(colmap_exe):
    try:
        result = subprocess.run(
            [colmap_exe, 'global_mapper', '-h'],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return False

    output = f"{result.stdout}\n{result.stderr}".lower()
    return result.returncode == 0 or 'global_mapper' in output


@lru_cache(maxsize=4)
def get_colmap_feature_extraction_max_image_size_flag(colmap_exe):
    try:
        result = subprocess.run(
            [colmap_exe, 'feature_extractor', '-h'],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return '--FeatureExtraction.max_image_size'

    output = f"{result.stdout}\n{result.stderr}"
    if 'FeatureExtraction.max_image_size' in output:
        return '--FeatureExtraction.max_image_size'
    if 'SiftExtraction.max_image_size' in output:
        return '--SiftExtraction.max_image_size'

    return '--FeatureExtraction.max_image_size'


@lru_cache(maxsize=4)
def get_colmap_native_feature_capabilities(colmap_exe):
    def _run_help(command):
        try:
            result = subprocess.run(
                [colmap_exe, command, '-h'],
                capture_output=True,
                text=True,
                timeout=10,
            )
        except Exception:
            return ''

        return f"{result.stdout}\n{result.stderr}"

    extraction_output = _run_help('feature_extractor')
    matching_output = _run_help('exhaustive_matcher')
    extraction_lower = extraction_output.lower()
    matching_lower = matching_output.lower()

    return {
        'supports_feature_extraction_type': 'featureextraction.type' in extraction_lower,
        'supports_aliked_extraction': 'alikedextraction.max_num_features' in extraction_lower,
        'supports_feature_matching_type': 'featurematching.type' in matching_lower,
        'supports_aliked_bruteforce': (
            'alikedmatching.bruteforce_model_path' in matching_lower
            or 'alikedmatching.brute_force_min_cossim' in matching_lower
        ),
        'supports_aliked_lightglue': 'alikedmatching.lightglue_model_path' in matching_lower,
    }


def get_native_aliked_max_num_features(quality_mode, fallback_max_num_features):
    caps = {
        'fast': 2048,
        'balanced': 4096,
        'high': 4096,
        'ultra': 6144,
        'hard': 8192,
        'professional': 8192,
        'ultra_professional': 12288,
        'robust': 8192,
        'custom': 4096,
    }
    default_cap = caps.get(str(quality_mode or 'balanced').strip().lower(), 4096)
    return min(int(fallback_max_num_features), default_cap)


def resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe):
    feature_method = normalize_feature_method(config.get('feature_method', 'sift'))
    capabilities = get_colmap_native_feature_capabilities(colmap_exe)

    profile = {
        'feature_method': feature_method,
        'extractor_type': 'SIFT',
        'matcher_type': 'SIFT_BRUTEFORCE',
        'is_native_neural': False,
        'uses_lightglue': False,
        'extractor_args': [],
        'matcher_args': [],
        'description': 'classic SIFT + brute-force matching',
    }

    if feature_method != 'aliked':
        return profile

    if not (
        capabilities['supports_feature_extraction_type']
        and capabilities['supports_aliked_extraction']
        and capabilities['supports_feature_matching_type']
        and capabilities['supports_aliked_bruteforce']
    ):
        return profile

    matcher_type = (
        'ALIKED_LIGHTGLUE'
        if capabilities['supports_aliked_lightglue']
        else 'ALIKED_BRUTEFORCE'
    )
    uses_lightglue = matcher_type == 'ALIKED_LIGHTGLUE'
    max_num_features = get_native_aliked_max_num_features(
        config.get('quality_mode', 'balanced'),
        colmap_cfg.get('max_num_features', 4096),
    )

    return {
        'feature_method': feature_method,
        'extractor_type': 'ALIKED_N16ROT',
        'matcher_type': matcher_type,
        'is_native_neural': True,
        'uses_lightglue': uses_lightglue,
        'extractor_args': [
            '--FeatureExtraction.type', 'ALIKED_N16ROT',
            '--AlikedExtraction.max_num_features', str(max_num_features),
        ],
        'matcher_args': [
            '--FeatureMatching.type', matcher_type,
        ],
        'description': (
            'native COLMAP ALIKED + LightGlue'
            if uses_lightglue
            else 'native COLMAP ALIKED + brute-force matching'
        ),
    }


@lru_cache(maxsize=1)
def get_gpu_total_vram_mb():
    try:
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=5,
        )
    except Exception:
        return None

    if result.returncode != 0:
        return None

    for raw_line in (result.stdout or '').splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            return int(float(line))
        except ValueError:
            continue

    return None


def get_peak_feature_count(database_path):
    if not Path(database_path).exists():
        return 0

    try:
        with sqlite3.connect(str(database_path)) as conn:
            row = conn.execute('SELECT MAX(rows) FROM keypoints').fetchone()
            return int(row[0]) if row and row[0] is not None else 0
    except sqlite3.Error:
        return 0


def count_verified_matching_pairs(database_path):
    if not Path(database_path).exists():
        return 0

    try:
        with sqlite3.connect(str(database_path)) as conn:
            row = conn.execute(
                'SELECT COUNT(*) FROM two_view_geometries WHERE rows > 0 AND config > 0'
            ).fetchone()
            return int(row[0]) if row else 0
    except sqlite3.Error:
        return 0


def is_gpu_matching_error_text(text):
    normalized = (text or '').lower()
    return (
        'not enough gpu memory' in normalized
        or 'failed to create feature matcher' in normalized
        or 'cuda error' in normalized
        or 'cuda driver version is insufficient' in normalized
        or 'cannot use gpu feature matching without cuda or opengl support' in normalized
        or 'failed to load shared library' in normalized
        or 'onnx runtime error' in normalized
        or 'ortsessionoptionsappendexecutionprovider_cuda' in normalized
        or 'libcudnn.so' in normalized
    )


def should_log_subprocess_line(line):
    normalized = (line or '').strip().lower()
    if not normalized:
        return False

    important_keywords = (
        'error',
        'warning',
        'failed',
        'fatal',
        'exception',
        'traceback',
        'downloading file',
        'caching file',
        'retrying',
        'abort',
        'terminate called',
    )
    return any(keyword in normalized for keyword in important_keywords)


def should_emit_progress_milestone(progress_state, current, total, *, percent_step=10):
    total = max(int(total or 0), 1)
    current = max(0, min(int(current or 0), total))
    percent = int((current / total) * 100)
    milestone = 100 if current >= total else (percent // percent_step) * percent_step
    last_milestone = int(progress_state.get('last_milestone', -1))
    if milestone <= last_milestone and current not in {1, total}:
        return False, percent

    progress_state['last_milestone'] = milestone
    return True, percent


def clear_colmap_database(database_path):
    db_path = Path(database_path)
    for candidate in (db_path, Path(f"{db_path}-shm"), Path(f"{db_path}-wal")):
        try:
            if candidate.exists():
                candidate.unlink()
        except OSError as exc:
            logger.warning("Failed to remove database file %s: %s", candidate, exc)


def get_frame_selection_manifest_path(paths):
    return Path(paths['project_path']) / FRAME_SELECTION_MANIFEST_NAME


def persist_frame_selection_manifest(paths, extraction_stats):
    frame_manifest = list(extraction_stats.get('frame_manifest') or [])
    if not frame_manifest:
        return

    manifest_path = get_frame_selection_manifest_path(paths)
    manifest_payload = {
        'created_at': datetime.utcnow().isoformat() + 'Z',
        'source_video_path': extraction_stats.get('source_video_path'),
        'source_total_frames': extraction_stats.get('source_total_frames'),
        'source_fps': extraction_stats.get('source_fps'),
        'entries': frame_manifest,
    }
    manifest_path.write_text(
        json.dumps(manifest_payload, ensure_ascii=True, indent=2),
        encoding='utf-8',
    )


def load_frame_selection_manifest(paths):
    manifest_path = get_frame_selection_manifest_path(paths)
    if not manifest_path.exists():
        return None

    try:
        return json.loads(manifest_path.read_text(encoding='utf-8'))
    except Exception as exc:
        logger.warning("Failed to read frame selection manifest %s: %s", manifest_path, exc)
        return None


def _build_dense_boundary_indices(left_source_index, right_source_index, desired_total_frames):
    gap = int(right_source_index) - int(left_source_index)
    if gap <= 1:
        return []

    desired_total = max(3, min(int(desired_total_frames), gap + 1))
    dense_indices = []
    seen = {int(left_source_index), int(right_source_index)}
    for step in range(1, desired_total - 1):
        position = left_source_index + (gap * (step / (desired_total - 1)))
        candidate_index = int(round(position))
        candidate_index = max(int(left_source_index) + 1, min(int(right_source_index) - 1, candidate_index))
        if candidate_index in seen:
            continue
        dense_indices.append(candidate_index)
        seen.add(candidate_index)
    return dense_indices


def build_boundary_frame_densification_plan(paths, colmap_cfg, config):
    manifest = load_frame_selection_manifest(paths)
    if not manifest:
        return None

    entries = list(manifest.get('entries') or [])
    if not entries:
        return None

    weak_boundaries = list(((colmap_cfg.get('pair_geometry_stats') or {}).get('weak_boundaries')) or [])
    if not weak_boundaries:
        return None

    source_fps = float(manifest.get('source_fps') or 0.0)
    entry_by_name = {
        str(entry.get('image_name')): entry
        for entry in entries
        if entry.get('image_name')
    }
    inserted_after = {}
    inserted_keys = set()
    target_segment_frames = int(config.get('boundary_target_segment_frames') or 8)
    planned_boundaries = []

    for boundary in weak_boundaries:
        left_name = boundary.get('left_image_name')
        right_name = boundary.get('right_image_name')
        left_entry = entry_by_name.get(left_name)
        right_entry = entry_by_name.get(right_name)
        if not left_entry or not right_entry:
            continue

        left_video = left_entry.get('source_video_path')
        right_video = right_entry.get('source_video_path')
        if not left_video or left_video != right_video:
            continue

        left_source_index = left_entry.get('source_frame_index')
        right_source_index = right_entry.get('source_frame_index')
        if left_source_index is None or right_source_index is None:
            continue

        dense_indices = _build_dense_boundary_indices(
            int(left_source_index),
            int(right_source_index),
            target_segment_frames,
        )
        if not dense_indices:
            continue

        planned_entries = []
        for source_index in dense_indices:
            source_key = (left_video, int(source_index))
            if source_key in inserted_keys:
                continue
            inserted_keys.add(source_key)
            planned_entries.append({
                'source_video_path': left_video,
                'source_frame_index': int(source_index),
                'source_time_seconds': round(source_index / source_fps, 6) if source_fps > 0 else None,
                'inserted_for_boundary': [left_name, right_name],
            })

        if not planned_entries:
            continue

        inserted_after.setdefault(left_name, []).extend(planned_entries)
        planned_boundaries.append({
            'left_image_name': left_name,
            'right_image_name': right_name,
            'inserted_frame_indices': [item['source_frame_index'] for item in planned_entries],
        })

    if not inserted_after:
        return None

    updated_entries = []
    existing_keys = set()
    for entry in entries:
        source_key = (entry.get('source_video_path'), entry.get('source_frame_index'))
        if source_key not in existing_keys:
            updated_entries.append(dict(entry))
            existing_keys.add(source_key)
        for inserted_entry in inserted_after.get(entry.get('image_name'), []):
            source_key = (inserted_entry.get('source_video_path'), inserted_entry.get('source_frame_index'))
            if source_key in existing_keys:
                continue
            updated_entries.append(dict(inserted_entry))
            existing_keys.add(source_key)

    return {
        'manifest': manifest,
        'entries': updated_entries,
        'inserted_count': len(updated_entries) - len(entries),
        'planned_boundaries': planned_boundaries,
    }


def should_run_boundary_frame_densification(config, colmap_cfg, sparse_summary, paths):
    if not sparse_summary or not sparse_summary.get('has_multiple_models'):
        return False

    if colmap_cfg.get('boundary_frame_densification_attempted'):
        return False

    if str(config.get('feature_method', 'sift')).lower() != 'sift':
        return False

    manifest = load_frame_selection_manifest(paths)
    if not manifest or not (manifest.get('entries') or []):
        return False

    pair_geometry_stats = colmap_cfg.get('pair_geometry_stats') or {}
    return bool(pair_geometry_stats.get('weak_boundaries'))


def rebuild_images_from_frame_manifest(project_id, paths, current_manifest, updated_entries, *, resolution):
    images_path = Path(paths['images_path'])
    project_path = Path(paths['project_path'])
    temp_images_path = project_path / '.images_boundary_densify'
    backup_images_path = project_path / '.images_boundary_backup'

    if temp_images_path.exists():
        shutil.rmtree(temp_images_path)
    temp_images_path.mkdir(parents=True, exist_ok=True)

    current_entries = list((current_manifest or {}).get('entries') or [])
    existing_images = {}
    for entry in current_entries:
        source_key = (entry.get('source_video_path'), entry.get('source_frame_index'))
        image_name = entry.get('image_name')
        image_path = images_path / image_name if image_name else None
        if image_path and image_path.exists():
            existing_images[source_key] = image_path

    extraction_requests_by_video: Dict[str, List[Dict[str, Any]]] = {}
    finalized_entries = []

    for index, entry in enumerate(updated_entries):
        new_name = f'frame_{index:06d}.jpg'
        updated_entry = dict(entry)
        updated_entry['image_name'] = new_name
        target_path = temp_images_path / new_name

        source_key = (updated_entry.get('source_video_path'), updated_entry.get('source_frame_index'))
        existing_path = existing_images.get(source_key)
        if existing_path and existing_path.exists():
            shutil.copy2(existing_path, target_path)
        else:
            source_video_path = updated_entry.get('source_video_path')
            source_frame_index = updated_entry.get('source_frame_index')
            if not source_video_path or source_frame_index is None:
                raise ValueError(f"Cannot rebuild frame {new_name}: missing source mapping")
            extraction_requests_by_video.setdefault(str(source_video_path), []).append({
                'frame_index': int(source_frame_index),
                'output_name': new_name,
            })

        finalized_entries.append(updated_entry)

    for source_video_path, frame_requests in extraction_requests_by_video.items():
        append_log_line(
            project_id,
            f"🧠 Re-extracting {len(frame_requests)} densified frame(s) from {Path(source_video_path).name}",
        )
        video_processor.extract_exact_frames(
            source_video_path,
            frame_requests,
            temp_images_path,
            resolution=resolution,
        )

    final_image_count = len(list(temp_images_path.glob('frame_*.jpg')))
    if final_image_count != len(finalized_entries):
        raise RuntimeError(
            f"Densified image rebuild incomplete: expected {len(finalized_entries)} files, found {final_image_count}"
        )

    if backup_images_path.exists():
        shutil.rmtree(backup_images_path)
    if images_path.exists():
        images_path.rename(backup_images_path)
    temp_images_path.rename(images_path)
    if backup_images_path.exists():
        shutil.rmtree(backup_images_path)

    manifest_payload = dict(current_manifest or {})
    manifest_payload['created_at'] = datetime.utcnow().isoformat() + 'Z'
    manifest_payload['entries'] = finalized_entries
    get_frame_selection_manifest_path(paths).write_text(
        json.dumps(manifest_payload, ensure_ascii=True, indent=2),
        encoding='utf-8',
    )

    return finalized_entries


def estimate_gpu_safe_match_limit(total_vram_mb=None, peak_feature_count=None):
    limits = []

    if total_vram_mb:
        vram_scaled_limit = int((max(total_vram_mb, 1024) / 1024.0) * 4096)
        vram_scaled_limit = max(16384, min(65536, (vram_scaled_limit // 1024) * 1024))
        limits.append(vram_scaled_limit)

    if peak_feature_count:
        feature_scaled_limit = int(peak_feature_count * 0.5)
        feature_scaled_limit = max(16384, min(65536, (feature_scaled_limit // 1024) * 1024))
        limits.append(feature_scaled_limit)

    if not limits:
        return None

    return min(limits)


def get_cpu_retry_match_limit(max_num_matches):
    return max(8192, min(int(max_num_matches) // 2, 32768))


def get_gpu_retry_match_limits(max_num_matches, peak_feature_count=None):
    base_limit = max(8192, int(max_num_matches))
    candidates = []
    seen = {base_limit}

    halved_limit = base_limit
    while halved_limit > 8192:
        halved_limit = max(8192, (halved_limit // 2 // 1024) * 1024)
        if halved_limit not in seen:
            candidates.append(halved_limit)
            seen.add(halved_limit)

    if peak_feature_count:
        feature_scaled_limit = int(peak_feature_count * 0.25)
        feature_scaled_limit = max(8192, min(base_limit, (feature_scaled_limit // 1024) * 1024))
        if feature_scaled_limit not in seen:
            candidates.insert(0, feature_scaled_limit)

    return [limit for limit in candidates if limit < base_limit]


def get_vocab_tree_matcher_params():
    matcher_params = {}
    vocab_tree_path = getattr(app_config, 'VOCAB_TREE_PATH', None)
    if vocab_tree_path and Path(vocab_tree_path).exists():
        matcher_params['VocabTreeMatching.vocab_tree_path'] = str(vocab_tree_path)
    return matcher_params


def resolve_global_sfm_backend(colmap_exe):
    global_command = getattr(app_config, 'COLMAP_GLOBAL_MAPPER_COMMAND', None)
    if colmap_supports_global_mapper(colmap_exe):
        return {
            'mode': 'colmap_global',
            'command': list(global_command) if global_command else [colmap_exe, 'global_mapper'],
            'label': 'COLMAP Global Mapper',
            'subtext': 'COLMAP global SfM',
        }

    legacy_glomap_command = getattr(app_config, 'GLOMAP_COMMAND', None)
    if GLOMAP_PATH is not None:
        return {
            'mode': 'legacy_glomap',
            'command': list(legacy_glomap_command) if legacy_glomap_command else [GLOMAP_PATH, 'mapper'],
            'label': 'Legacy GLOMAP',
            'subtext': 'Legacy standalone glomap',
        }

    return None


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
    prefix_groups: Dict[str, List[int]] = {}

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
            smooth_steps = sum(1 for left, right in zip(dominant_indices, dominant_indices[1:]) if 0 < (right - left) <= 3)
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
        'matcher_params': refined_matcher_params,
        'reason': reason,
        'overlap_plan': overlap_plan,
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
    }

    if extra:
        framework_state.update(extra)

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

    # Keep ordered video/orbit safeguards active beyond 250 images so the
    # matcher/mapping policy does not abruptly flip for medium-sized captures.
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


def estimate_preview_image_count(config, media_summary):
    input_type = media_summary.get('input_type') or config.get('input_type') or 'images'
    image_count = int(media_summary.get('image_count') or 0)
    video_count = int(media_summary.get('video_count') or 0)

    if input_type == 'images':
        return max(image_count, 0)

    extraction_mode = str(config.get('extraction_mode', 'fps')).lower()
    if extraction_mode in {'frames', 'target_count'}:
        per_video = max(24, int(config.get('max_frames') or 100))
    else:
        try:
            target_fps = float(config.get('target_fps') or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        per_video = max(24, min(240, int(round(target_fps * 60))))

    if input_type == 'video':
        return per_video * max(video_count, 1)

    return image_count + (per_video * max(video_count, 1))


def build_upload_policy_preview(config, media_summary):
    preview_config = dict(config or {})
    preview_config['input_type'] = media_summary.get('input_type') or preview_config.get('input_type') or 'images'
    estimated_num_images = estimate_preview_image_count(preview_config, media_summary)
    preview_config['estimated_num_images'] = estimated_num_images

    image_names = media_summary.get('image_names') or []
    capture_pattern = analyze_capture_pattern_from_names(image_names, preview_config)
    orbit_safe_policy = build_orbit_safe_policy_from_capture(capture_pattern, preview_config, estimated_num_images)
    orbit_safe_mode = orbit_safe_policy is not None

    colmap_cfg = get_colmap_config(
        max(estimated_num_images, 1),
        quality_mode=preview_config.get('quality_mode', 'balanced'),
        custom_params=preview_config if preview_config.get('quality_mode') == 'custom' else preview_config,
        preferred_matcher_type=normalize_matcher_type(preview_config.get('matcher_type')),
        orbit_safe_mode=orbit_safe_mode,
        orbit_safe_policy=orbit_safe_policy,
    )

    input_profile = preview_config['input_type']
    if input_profile not in {'video', 'mixed', 'images'}:
        input_profile = 'unknown'

    tone_key = 'unknown'
    if input_profile == 'video':
        tone_key = 'video'
    elif input_profile == 'mixed':
        tone_key = 'mixed'
    elif input_profile == 'images':
        tone_key = 'images'

    signals: List[Dict[str, Any]] = []

    def add_signal(key: str, label: str, delta: int, detail: str) -> None:
        signals.append({'key': key, 'label': label, 'delta': delta, 'detail': detail})

    score = 88 if input_profile == 'video' else 76 if input_profile == 'images' else 68 if input_profile == 'mixed' else 42
    add_signal('input-profile', 'Input profile', 0, f'Detected input profile: {input_profile}')

    explicit_matcher = normalize_matcher_type(preview_config.get('matcher_type'))
    if explicit_matcher:
        score -= 18
        add_signal('matcher-override', 'Matcher override', -18, f'Explicit matcher override: {explicit_matcher}')
    else:
        add_signal('matcher-auto', 'Matcher auto', 6, 'Auto matcher allows backend policy selection')
        score += 6

    feature_method = str(preview_config.get('feature_method', 'sift'))
    if input_profile in {'images', 'mixed'} and feature_method in {'aliked', 'superpoint'}:
        score += 5
        add_signal('neural-features', 'Neural features', 5, f'{feature_method} can improve photo-heavy coverage and speed')
    elif input_profile == 'video' and feature_method == 'sift':
        score += 2
        add_signal('sift-video', 'SIFT compatibility', 2, 'SIFT remains a stable baseline for video input')

    sfm_engine = str(preview_config.get('sfm_engine', 'glomap'))
    sfm_backend = normalize_sfm_backend(preview_config.get('sfm_backend', 'cli'))
    if input_profile == 'images' and sfm_engine == 'fastmap':
        score -= 20
        add_signal('fastmap-images', 'Engine mismatch', -20, 'FastMap is less reliable on unordered photo collections')
    elif input_profile == 'mixed' and sfm_engine == 'fastmap':
        score -= 14
        add_signal('fastmap-mixed', 'Engine mismatch', -14, 'Mixed inputs can be brittle with FastMap')

    extraction_mode = str(preview_config.get('extraction_mode', 'fps')).lower()
    if input_profile in {'video', 'mixed'} and extraction_mode == 'fps':
        try:
            target_fps = float(preview_config.get('target_fps') or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        if target_fps >= 10:
            score -= 8
            add_signal('dense-fps', 'Dense sampling', -8, f'{target_fps} fps may add many near-duplicate frames')
        elif 2 <= target_fps <= 5:
            score += 4
            add_signal('balanced-fps', 'Balanced sampling', 4, f'{target_fps} fps is a good temporal density for preview policy')
        elif 0 < target_fps < 1:
            score -= 6
            add_signal('sparse-fps', 'Sparse sampling', -6, f'{target_fps} fps may weaken bridge geometry across the orbit')
    elif input_profile in {'video', 'mixed'} and extraction_mode in {'frames', 'target_count'}:
        max_frames = int(preview_config.get('max_frames') or 100)
        if max_frames >= 400:
            score -= 7
            add_signal('dense-frames', 'Dense frame count', -7, f'{max_frames} frames can create redundancy and heavier matching load')
        elif 100 <= max_frames <= 250:
            score += 3
            add_signal('balanced-frames', 'Balanced frame count', 3, f'{max_frames} frames is a reasonable preview density')
        elif max_frames < 80:
            score -= 5
            add_signal('limited-frames', 'Limited frame count', -5, f'{max_frames} frames may be too sparse for stable bridge recovery')

    if input_profile in {'video', 'mixed'} and preview_config.get('use_separate_training_images'):
        score += 2
        add_signal('training-images', 'Training image split', 2, 'Separate high-resolution training images can help final training quality')

    score = max(18, min(96, score))
    if score >= 80:
        confidence = {
            'label': 'High',
            'tone': 'border-emerald-200 bg-emerald-100 text-emerald-900',
            'meterClass': 'bg-emerald-500',
            'score': score,
            'signals': signals,
        }
    elif score >= 60:
        confidence = {
            'label': 'Medium',
            'tone': 'border-amber-200 bg-amber-100 text-amber-900',
            'meterClass': 'bg-amber-500',
            'score': score,
            'signals': signals,
        }
    else:
        confidence = {
            'label': 'Cautious',
            'tone': 'border-rose-200 bg-rose-100 text-rose-900',
            'meterClass': 'bg-rose-500',
            'score': score,
            'signals': signals,
        }

    preview_rules: List[Dict[str, str]] = []

    def add_rule(level: str, text: str) -> None:
        preview_rules.append({'level': level, 'text': text})

    if explicit_matcher:
        add_rule('warning', f'Matcher override is active. The backend will respect {explicit_matcher} instead of choosing automatically.')
    else:
        add_rule('info', 'Matcher is on Auto, so the backend can still adapt from capture ordering and pair geometry.')

    if input_profile == 'images' and sfm_engine == 'fastmap':
        add_rule('warning', 'FastMap with an image-only set is a riskier combination. COLMAP Global SfM or incremental COLMAP is usually safer for unordered photo collections.')
    if input_profile == 'mixed' and sfm_engine == 'fastmap':
        add_rule('warning', 'FastMap on mixed media can be brittle when some inputs behave like unordered photos.')
    if input_profile == 'video' and explicit_matcher == 'exhaustive':
        add_rule('warning', 'Exhaustive matching on video/orbit input may reduce the benefit of orbit-safe sequential policy.')
    if input_profile == 'images' and explicit_matcher == 'sequential':
        add_rule('warning', 'Sequential override assumes the filenames or capture order are meaningful. Use Auto or Exhaustive for unordered photos.')
    if input_profile == 'video' and explicit_matcher == 'vocab_tree':
        add_rule('warning', 'Vocab-tree retrieval is tuned for large unordered photo collections, not ordered video/orbit input.')
    if input_profile == 'images' and explicit_matcher == 'vocab_tree':
        add_rule('info', 'Vocab-tree retrieval is a strong experimental option for larger unordered photo collections.')
    if input_profile in {'video', 'mixed'} and extraction_mode == 'fps':
        try:
            target_fps = float(preview_config.get('target_fps') or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        if target_fps >= 10:
            add_rule('warning', f'Target FPS is set to {target_fps}. Very dense sampling can add near-duplicate frames and reduce policy confidence.')
        elif 0 < target_fps < 1:
            add_rule('warning', f'Target FPS is {target_fps}. Sparse sampling may weaken bridge geometry across the orbit.')
    if input_profile in {'video', 'mixed'} and extraction_mode in {'frames', 'target_count'}:
        max_frames = int(preview_config.get('max_frames') or 100)
        if max_frames >= 400:
            add_rule('warning', f'Maximum frames is {max_frames}. This is dense enough to create redundancy and heavier matching load.')
        elif max_frames < 80:
            add_rule('warning', f'Maximum frames is only {max_frames}. Sparse frame coverage may make loop closure and bridge recovery harder.')
    if input_profile in {'images', 'mixed'} and feature_method in {'aliked', 'superpoint'}:
        add_rule('info', f'{feature_method} + LightGlue should help high-resolution photo coverage and usually raises preview confidence for photo-heavy inputs.')
    if input_profile == 'video' and feature_method != 'sift':
        add_rule('info', f'{feature_method} is enabled. Neural features can speed up matching, but ordered video policy still matters more than descriptor choice.')
    if input_profile in {'video', 'mixed'} and preview_config.get('use_separate_training_images'):
        add_rule('info', 'Separate high-resolution training images are enabled. This improves training quality but does not change the sparse policy directly.')
    if input_profile == 'video' and sfm_engine == 'colmap':
        add_rule('info', 'COLMAP is a conservative choice for video input and aligns well with stricter orbit-safe incremental reconstruction.')
    if sfm_backend == 'pycolmap':
        add_rule('info', 'Experimental backend enabled: pycolmap global mapping will be attempted first, then the backend falls back to CLI global mapping if unsupported.')

    if input_profile == 'video':
        expected_policy = {
            'title': 'Orbit-Safe Video Policy',
            'tone': 'border-emerald-200 bg-emerald-50 text-emerald-900',
            'badgeTone': 'border-emerald-200 bg-emerald-100 text-emerald-900',
            'profileBadge': 'video orbit',
            'matcherBadge': colmap_cfg.get('matcher_type'),
            'engineBadge': 'global sfm + safe fallback' if sfm_engine == 'glomap' else f'{sfm_engine} preferred',
            'summary': 'Ordered frames usually start with sequential matching, then the backend can tighten sparse reconstruction and bridge weak transitions with geometry-aware rules.',
            'toneKey': tone_key,
        }
    elif input_profile == 'mixed':
        expected_policy = {
            'title': 'Mixed Capture Policy',
            'tone': 'border-amber-200 bg-amber-50 text-amber-900',
            'badgeTone': 'border-amber-200 bg-amber-100 text-amber-900',
            'profileBadge': 'mixed input',
            'matcherBadge': colmap_cfg.get('matcher_type'),
            'engineBadge': f'{sfm_engine} preferred',
            'summary': 'Mixed uploads are treated cautiously. The backend inspects whether the set behaves more like ordered frames or unordered photos before locking the matcher and mapper policy.',
            'toneKey': tone_key,
        }
    elif input_profile == 'images':
        expected_policy = {
            'title': 'Photo Set Policy',
            'tone': 'border-sky-200 bg-sky-50 text-sky-900',
            'badgeTone': 'border-sky-200 bg-sky-100 text-sky-900',
            'profileBadge': 'image collection',
            'matcherBadge': colmap_cfg.get('matcher_type'),
            'engineBadge': f'{sfm_engine} preferred',
            'summary': 'For image collections, the backend usually prefers exhaustive matching on smaller unordered sets and sequential only when filenames or capture order look strongly ordered.',
            'toneKey': tone_key,
        }
    else:
        expected_policy = {
            'title': 'Waiting For Media Signal',
            'tone': 'border-gray-200 bg-gray-50 text-gray-800',
            'badgeTone': 'border-gray-200 bg-white text-gray-700',
            'profileBadge': 'no files yet',
            'matcherBadge': colmap_cfg.get('matcher_type'),
            'engineBadge': f'{sfm_engine} preferred',
            'summary': 'Select files first, then this panel will estimate which reconstruction policy the backend is most likely to apply.',
            'toneKey': tone_key,
        }

    return {
        'heuristic_source': 'backend',
        'input_profile': input_profile,
        'estimated_num_images': estimated_num_images,
        'capture_pattern': capture_pattern,
        'expected_policy': expected_policy,
        'confidence': confidence,
        'preview_rules': preview_rules,
        'resolved_matcher_type': colmap_cfg.get('matcher_type'),
        'orbit_safe_mode': orbit_safe_mode,
        'orbit_safe_profile': colmap_cfg.get('orbit_safe_profile'),
        'bridge_risk_score': colmap_cfg.get('bridge_risk_score'),
    }


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
            f'weak_boundaries={geometry_stats["weak_boundary_count"]}/{geometry_stats["image_count"] - 1}'
        )
        append_log_line(
            project_id,
            '🧠 Pair-geometry refinement selected orbit-safe profile: '
            f'{refined_policy["profile_name"]} | '
            f'overlap={colmap_cfg["matcher_params"]["SequentialMatching.overlap"]} | '
            f'min_inliers={colmap_cfg["mapper_params"]["Mapper.abs_pose_min_num_inliers"]} | '
            f'min_ratio={colmap_cfg["mapper_params"]["Mapper.abs_pose_min_inlier_ratio"]} | '
            f'max_reg_trials={colmap_cfg["mapper_params"]["Mapper.max_reg_trials"]}'
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


def get_sequential_matcher_params(num_images, quality_mode, orbit_safe_mode=False, orbit_safe_policy=None):
    if orbit_safe_policy:
        return dict(orbit_safe_policy['matcher_params'])

    if orbit_safe_mode:
        return {
            'SequentialMatching.overlap': '36',
            'SequentialMatching.quadratic_overlap': '1',
            'SequentialMatching.loop_detection': '0',
        }

    if num_images <= 150:
        overlap = (
            "35"
            if quality_mode == "ultra_professional"
            else (
                "30"
                if quality_mode == "professional"
                else ("28" if quality_mode == "hard" else ("25" if quality_mode in ["high", "ultra"] else "20"))
            )
        )
        quadratic_overlap = "1"
    elif num_images <= 400:
        overlap = (
            "30"
            if quality_mode == "ultra_professional"
            else (
                "25"
                if quality_mode == "professional"
                else ("22" if quality_mode == "hard" else ("18" if quality_mode in ["high", "ultra"] else "12"))
            )
        )
        quadratic_overlap = "1"
    elif num_images <= 1000:
        overlap = (
            "25"
            if quality_mode == "ultra_professional"
            else (
                "20"
                if quality_mode == "professional"
                else ("18" if quality_mode == "hard" else ("15" if quality_mode in ["high", "ultra"] else "12"))
            )
        )
        quadratic_overlap = "1"
    else:
        overlap = (
            "18"
            if quality_mode == "ultra_professional"
            else (
                "12"
                if quality_mode == "professional"
                else ("10" if quality_mode == "hard" else ("8" if quality_mode in ["high", "ultra"] else "5"))
            )
        )
        quadratic_overlap = "0"

    matcher_params = {
        "SequentialMatching.overlap": overlap,
        "SequentialMatching.quadratic_overlap": quadratic_overlap,
    }

    if quadratic_overlap == "1":
        matcher_params["SequentialMatching.loop_detection"] = "1"

    return matcher_params


def generate_hloc_pairs(pairs_path, image_list, matcher_type, matcher_params):
    matcher_type = normalize_matcher_type(matcher_type) or "exhaustive"

    if matcher_type == "exhaustive":
        from hloc import pairs_from_exhaustive

        pairs_from_exhaustive.main(pairs_path, image_list=image_list)
        return len(image_list) * (len(image_list) - 1) // 2

    if matcher_type == "vocab_tree":
        raise ValueError("hloc pair generation does not support vocab-tree retrieval yet")

    overlap = max(1, int(matcher_params.get("SequentialMatching.overlap", "10")))
    quadratic_overlap = matcher_params.get("SequentialMatching.quadratic_overlap", "0") == "1"
    pair_set = set()

    for index, image_name in enumerate(image_list):
        upper_bound = min(len(image_list), index + overlap + 1)
        for next_index in range(index + 1, upper_bound):
            pair_set.add((image_name, image_list[next_index]))

        if quadratic_overlap:
            step = 2
            while index + step < len(image_list):
                pair_set.add((image_name, image_list[index + step]))
                step *= 2

    ordered_pairs = sorted(pair_set)
    with open(pairs_path, "w") as pair_file:
        pair_file.write("\n".join(f"{first} {second}" for first, second in ordered_pairs))

    return len(ordered_pairs)


def should_prefer_incremental_sfm(config, paths, num_images):
    if normalize_sfm_engine(config.get('sfm_engine', 'glomap')) != 'glomap':
        return False, None

    if config.get('fast_sfm', False):
        return False, None

    matcher_type = normalize_matcher_type(config.get('matcher_type'))
    capture_pattern = analyze_capture_pattern(paths, config)
    looks_like_video_orbit = capture_pattern['looks_like_video_orbit']

    if config.get('quality_mode') == 'robust':
        return True, 'Robust mode prefers incremental COLMAP SfM for better outlier resistance'

    if matcher_type == 'exhaustive' and num_images <= 250:
        return True, 'Exhaustive matching on small/medium datasets is usually more stable with incremental COLMAP SfM'

    if looks_like_video_orbit and num_images <= ORDERED_CAPTURE_POLICY_IMAGE_LIMIT:
        return True, 'Ordered video/orbit frames are reconstructed more robustly with incremental COLMAP SfM'

    return False, None

def run_processing_pipeline_from_stage(project_id, paths, config, video_files, image_files, from_stage='ingest'):
    """Run the processing pipeline from a specific stage."""
    try:
        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'processing'

        # Skip to the specified stage
        stage_order = [s['key'] for s in app_config.PIPELINE_STAGES]
        start_index = stage_order.index(from_stage) if from_stage in stage_order else 0

        # Import time estimator
        from services.time_estimator import time_estimator

        # Calculate smart time estimate
        num_total_images = len(image_files) + config.get('max_frames', 0) * len(video_files)
        time_estimate = time_estimator.estimate_processing_time(
            num_images=max(num_total_images, 50),
            quality_mode=config.get('quality_mode', 'balanced'),
            has_videos=len(video_files) > 0,
            num_videos=len(video_files)
        )

        processing_start_time = time.time()

        # Handle each stage based on start_index
        if start_index <= stage_order.index('ingest'):
            with project_store.status_lock:
                update_state(project_id, 'ingest', status='running')
            
            # Count uploaded files for progress tracking
            total_files = len(video_files) + len(image_files)
            
            # Show initial progress with file counts
            update_stage_detail(project_id, 'ingest', 
                              text=f'Files received: {total_files}', 
                              subtext=f'{len(image_files)} images, {len(video_files)} videos')
            emit_stage_progress(project_id, 'ingest', 10, {
                'text': f'Files received: {total_files}',
                'current_item': total_files,
                'total_items': total_files,
                'item_name': 'Preparing...'
            })

            append_log_line(project_id, f"🚀 Starting {config.get('quality_mode', 'balanced').title()} Quality Processing")
            append_log_line(project_id, f"📊 Dataset: {num_total_images} images, {len(video_files)} videos")
            append_log_line(project_id, f"⏱️  Estimated time: {time_estimator.format_time_display(time_estimate.total_seconds)}")
            append_log_line(project_id, f"🎯 GPU: {time_estimator.detect_gpu()}")
            
            # Update progress after logging info
            update_state(project_id, 'ingest', progress=50)
            emit_stage_progress(project_id, 'ingest', 50, {
                'text': f'Initializing: {total_files} files',
                'current_item': total_files,
                'total_items': total_files,
                'item_name': 'Initializing pipeline...'
            })

        # Video extraction stage
        total_extracted_frames = 0
        if start_index <= stage_order.index('video_extraction'):
            if video_files:
                total_videos = len(video_files)
                update_state(project_id, 'video_extraction', status='running')
                
                # Check GPU extraction availability and log it
                use_gpu = config.get('use_gpu_extraction', True)
                from ..utils.video_processor import get_gpu_decode_info
                gpu_info = get_gpu_decode_info()
                
                if use_gpu and gpu_info['available']:
                    update_stage_detail(project_id, 'video_extraction', 
                                      text=f'Videos processed: 0/{total_videos}', 
                                      subtext=f'🚀 GPU accelerated ({gpu_info["method"].upper()})')
                    append_log_line(project_id, f"📹 Processing {total_videos} video file(s) with GPU acceleration ({gpu_info['method'].upper()})...")
                    if gpu_info.get('gpu_name'):
                        append_log_line(project_id, f"   🎮 GPU: {gpu_info['gpu_name']}")
                else:
                    update_stage_detail(project_id, 'video_extraction', 
                                      text=f'Videos processed: 0/{total_videos}', 
                                      subtext='Frames extracted: 0')
                    append_log_line(project_id, f"📹 Processing {total_videos} video file(s)...")
                    if use_gpu and not gpu_info['available']:
                        append_log_line(project_id, f"   ⚠️ GPU extraction unavailable, using CPU")
                        # Log details why GPU is not available
                        for detail in gpu_info.get('details', []):
                            append_log_line(project_id, f"      → {detail}")

                # Calculate expected total frames for all videos
                base_estimate_config = {
                    'mode': config.get('extraction_mode', 'frames'),
                    'max_frames': config.get('max_frames', 100),
                    'target_fps': config.get('target_fps', 1.0),
                    'smart_frame_selection': config.get('smart_frame_selection', True),
                    'oversample_factor': config.get('oversample_factor', 10),
                }
                expected_frames_by_video = []
                for video_path in video_files:
                    video_info = video_processor.get_video_info(video_path)
                    if video_info:
                        sampling_plan = video_processor._build_sampling_plan(
                            video_info['total_frames'],
                            video_info['fps'],
                            base_estimate_config,
                        )
                        expected_frames_by_video.append(
                            int(
                                sampling_plan['candidate_count']
                                if sampling_plan['smart_selection']
                                else sampling_plan['target_output_count']
                            )
                        )
                    else:
                        expected_frames_by_video.append(
                            video_processor.estimate_frame_count(video_path, base_estimate_config)
                        )
                total_expected_frames = max(1, sum(expected_frames_by_video))
                
                for i, video_path in enumerate(video_files):
                    append_log_line(project_id, f"Extracting frames from: {Path(video_path).name}")

                    # Get resolution settings
                    colmap_resolution = config.get('colmap_resolution', '2K')
                    training_resolution = config.get('training_resolution', '4K')
                    use_separate = config.get('use_separate_training_images', False)
                    
                    # Base extraction config
                    base_config = {
                        'mode': config.get('extraction_mode', 'frames'),
                        'preview_count': config.get('preview_count', 10),
                        'use_gpu': config.get('use_gpu_extraction', True),
                        'smart_frame_selection': config.get('smart_frame_selection', True),
                        'oversample_factor': config.get('oversample_factor', 10),
                        'replacement_search_radius': config.get('replacement_search_radius', 4),
                        'ffmpeg_cpu_workers': config.get('ffmpeg_cpu_workers', 4),
                        'source_video_path': str(video_path),
                    }
                    
                    if config.get('extraction_mode') == 'fps':
                        base_config['target_fps'] = config.get('target_fps', 1.0)
                    else:
                        base_config['max_frames'] = config.get('max_frames', 100)
                    
                    # Primary extraction (for COLMAP)
                    extraction_config = {
                        **base_config,
                        'resolution': colmap_resolution,
                        'quality': config.get('quality', 100)  # Legacy fallback
                    }
                    
                    append_log_line(project_id, f"   📐 COLMAP resolution: {colmap_resolution}")

                    # Create progress callback for frame-by-frame updates
                    def frame_progress_callback(current_frame, expected_total, frame_path):
                        nonlocal total_extracted_frames
                        # Calculate overall progress across all videos
                        frames_from_prev_videos = sum(expected_frames_by_video[:i])
                        overall_frames = frames_from_prev_videos + current_frame
                        overall_progress = int((overall_frames / total_expected_frames) * 100)
                        progress_label = (
                            'Candidate'
                            if extraction_config.get('smart_frame_selection', False)
                            else 'Frame'
                        )
                        
                        # Update progress every 5 frames to avoid excessive updates
                        if current_frame % 5 == 0 or current_frame == expected_total:
                            emit_stage_progress(project_id, 'video_extraction', min(overall_progress, 99), {
                                'text': f'Video {i + 1}/{total_videos}: {progress_label} {current_frame}/{expected_total}',
                                'current_item': overall_frames,
                                'total_items': total_expected_frames,
                                'item_name': f'{progress_label} {current_frame}'
                            })
                            update_stage_detail(
                                project_id,
                                'video_extraction',
                                text=f'Video {i + 1}/{total_videos}: {progress_label} {current_frame}/{expected_total}',
                                subtext=(
                                    f"Total candidates extracted: {frames_from_prev_videos + current_frame}"
                                    if extraction_config.get('smart_frame_selection', False)
                                    else f'Total extracted: {frames_from_prev_videos + current_frame}'
                                )
                            )

                    def extraction_status_callback(event, payload):
                        payload = payload or {}
                        if event == 'candidate_scoring_start':
                            append_log_line(
                                project_id,
                                "🧠 Scoring oversampled frame candidates before pruning to the requested output rate "
                                f"(radius=±{payload.get('search_radius', 0)})",
                            )
                            update_stage_detail(
                                project_id,
                                'video_extraction',
                                text=f'Video {i + 1}/{total_videos}: Scoring oversampled frame candidates',
                                subtext=(
                                    f"Scoring {payload.get('total', '--')} candidates "
                                    f"for {payload.get('target_count', '--')} targets"
                                ),
                            )
                        elif event == 'candidate_scoring_progress':
                            current = int(payload.get('current', 0) or 0)
                            total = int(payload.get('total', 0) or 0)
                            if total > 0:
                                emit_stage_progress(project_id, 'video_extraction', 99, {
                                    'text': f'Video {i + 1}/{total_videos}: Scoring oversampled candidates {current}/{total}',
                                    'current_item': current,
                                    'total_items': total,
                                    'item_name': 'Candidate scoring',
                                })
                                update_stage_detail(
                                    project_id,
                                    'video_extraction',
                                    text=f'Video {i + 1}/{total_videos}: Scoring oversampled candidates {current}/{total}',
                                    subtext=(
                                        f"Effective window ±{payload.get('search_radius', '--')} · "
                                        f"targets {payload.get('target_count', '--')}"
                                    ),
                                )
                        elif event == 'candidate_selection_start':
                            append_log_line(project_id, "🧠 Selecting the best frames from each temporal bucket")
                        elif event == 'candidate_selection_progress':
                            current = int(payload.get('current', 0) or 0)
                            total = int(payload.get('total', 0) or 0)
                            emit_stage_progress(project_id, 'video_extraction', 99, {
                                'text': f'Video {i + 1}/{total_videos}: Keeping best frames {current}/{total}',
                                'current_item': current,
                                'total_items': total,
                                'item_name': 'Best-frame pruning',
                            })
                            update_stage_detail(
                                project_id,
                                'video_extraction',
                                text=f'Video {i + 1}/{total_videos}: Keeping best frames {current}/{total}',
                                subtext=(
                                    f"Buckets improved: {payload.get('replaced', 0)} · "
                                    f"effective window ±{payload.get('search_radius', '--')}"
                                ),
                            )
                        elif event == 'candidate_selection_complete':
                            append_log_line(
                                project_id,
                                "🧠 Oversample-and-select complete: "
                                f"replaced={payload.get('replaced', 0)} | "
                                f"radius=±{payload.get('search_radius', '--')} | "
                                f"rejected={payload.get('rejected_candidates', 0)}",
                            )

                    extracted = video_processor.extract_frames(
                        video_path,
                        paths['images_path'],
                        extraction_config={
                            **extraction_config,
                            'status_callback': extraction_status_callback,
                        },
                        progress_callback=frame_progress_callback
                    )

                    extraction_stats = video_processor.get_last_extraction_stats()
                    total_extracted_frames += len(extracted)
                    append_log_line(project_id, f"✅ Extracted {len(extracted)} frames from video {i + 1}")
                    if extraction_stats:
                        extraction_stats = {
                            **extraction_stats,
                            'filename': Path(video_path).name,
                        }
                        if total_videos == 1:
                            persist_frame_selection_manifest(paths, extraction_stats)
                        with project_store.status_lock:
                            project_entry = project_store.processing_status.get(project_id)
                            if project_entry is not None:
                                diagnostics = project_entry.setdefault('video_extraction_diagnostics', {
                                    'strategy': extraction_stats.get('strategy'),
                                    'mode': extraction_stats.get('mode'),
                                    'search_radius': extraction_stats.get('search_radius'),
                                    'oversample_factor': extraction_stats.get('oversample_factor'),
                                    'videos': [],
                                })
                                diagnostics['strategy'] = extraction_stats.get('strategy')
                                diagnostics['mode'] = extraction_stats.get('mode')
                                diagnostics['search_radius'] = extraction_stats.get('search_radius')
                                diagnostics['oversample_factor'] = extraction_stats.get('oversample_factor')
                                diagnostics['candidate_count'] = diagnostics.get('candidate_count', 0) + extraction_stats.get('candidate_count', 0)
                                diagnostics['requested_targets'] = diagnostics.get('requested_targets', 0) + extraction_stats.get('requested_targets', 0)
                                diagnostics['saved_frames'] = diagnostics.get('saved_frames', 0) + extraction_stats.get('saved_frames', 0)
                                diagnostics['replaced_targets'] = diagnostics.get('replaced_targets', 0) + extraction_stats.get('replaced_targets', 0)
                                diagnostics['rejected_candidates'] = diagnostics.get('rejected_candidates', 0) + extraction_stats.get('rejected_candidates', 0)
                                diagnostics.setdefault('videos', []).append(extraction_stats)
                                project_entry.setdefault('config', {})['replacement_search_radius'] = extraction_stats.get('search_radius')
                                project_entry['video_extraction_diagnostics'] = diagnostics
                                save_projects_db()
                        append_log_line(
                            project_id,
                            "🧠 Smart frame selection: "
                            f"candidates={extraction_stats.get('candidate_count', 0)} | "
                            f"targets={extraction_stats.get('requested_targets', 0)} | "
                            f"saved={extraction_stats.get('saved_frames', 0)} | "
                            f"replaced={extraction_stats.get('replaced_targets', 0)} | "
                            f"oversample={extraction_stats.get('oversample_factor', '--')}x | "
                            f"window=±{extraction_stats.get('search_radius', 0)}",
                        )
                        selection_samples = [
                            selection
                            for selection in extraction_stats.get('selections', [])
                            if int(selection.get('offset', 0)) != 0
                        ]
                        if selection_samples:
                            fallback_count = sum(
                                1 for selection in selection_samples if selection.get('fallback_used')
                            )
                            avg_abs_offset = sum(
                                abs(int(selection.get('offset', 0))) for selection in selection_samples
                            ) / max(len(selection_samples), 1)
                            append_log_line(
                                project_id,
                                "🧠 Selection offsets: "
                                f"adjusted={len(selection_samples)} | "
                                f"fallbacks={fallback_count} | "
                                f"avg_abs_offset={avg_abs_offset:.1f}",
                            )
                            preview_samples = sorted(
                                selection_samples,
                                key=lambda selection: abs(int(selection.get('offset', 0))),
                                reverse=True,
                            )[:3]
                            for selection in preview_samples:
                                offset = int(selection.get('offset', 0))
                                append_log_line(
                                    project_id,
                                    "   ↳ sample "
                                    f"target {selection.get('target_index')} -> {selection.get('selected_index')} "
                                    f"(offset {offset:+d}, "
                                    f"{'fallback' if selection.get('fallback_used') else 'quality-pass'})",
                                )
                    
                    # Extract high-resolution training images if enabled
                    # Use extract_matching_frames to ensure EXACT same frames as COLMAP
                    if use_separate and training_resolution != colmap_resolution:
                        append_log_line(project_id, f"   📐 Extracting high-res training images: {training_resolution}")
                        append_log_line(project_id, f"   🔗 Matching {len(extracted)} COLMAP frames...")
                        
                        # Extract matching frames at higher resolution
                        training_extracted = video_processor.extract_matching_frames(
                            video_path,
                            paths['images_path'],  # Source COLMAP frames
                            paths['training_images_path'],  # Output training images
                            resolution=training_resolution,
                            progress_callback=None
                        )
                        append_log_line(project_id, f"   ✅ Extracted {len(training_extracted)} high-res training frames (matched)")

                    videos_done = i + 1
                    progress = int((videos_done / total_videos) * 100)
                    update_state(project_id, 'video_extraction', progress=progress)
                    update_stage_detail(
                        project_id,
                        'video_extraction',
                        text=f'Videos processed: {videos_done}/{total_videos}',
                        subtext=f'Frames extracted: {total_extracted_frames}'
                    )

                update_state(project_id, 'video_extraction', status='completed', progress=100)
                append_log_line(project_id, f"🎬 Frame extraction complete. Total frames: {total_extracted_frames}")
                if use_separate:
                    training_frames = len(list(paths['training_images_path'].glob('*')))
                    append_log_line(project_id, f"   🎯 Training images: {training_frames} ({training_resolution})")
            else:
                update_state(project_id, 'video_extraction', status='completed', progress=100)
                update_stage_detail(project_id, 'video_extraction', text='No video files', subtext=None)


        # Complete ingest stage if we started from there
        if start_index <= stage_order.index('ingest'):
            update_state(project_id, 'ingest', status='completed', progress=100)
            total_images = len(list(paths['images_path'].glob('*')))
            append_log_line(project_id, f"📸 Total images for reconstruction: {total_images}")
            update_stage_detail(project_id, 'ingest', text=f'Images ready: {total_images}', subtext=None)

            if total_images < 10:
                raise ValueError(f"Need at least 10 images, but only have {total_images}")

        # Continue with COLMAP and OpenSplat pipeline from the appropriate stage
        # COLMAP stages: feature_extraction, feature_matching, sparse_reconstruction, model_conversion
        colmap_stages = ['feature_extraction', 'feature_matching', 'sparse_reconstruction', 'model_conversion']
        
        if from_stage in colmap_stages:
            # Start from a specific COLMAP stage
            append_log_line(project_id, f"🔄 Resuming from stage: {from_stage}")
            run_colmap_pipeline(project_id, paths, config, processing_start_time, time_estimate, time_estimator, from_stage=from_stage)
        elif start_index <= stage_order.index('feature_extraction'):
            # Start from beginning of COLMAP pipeline
            run_colmap_pipeline(project_id, paths, config, processing_start_time, time_estimate, time_estimator, from_stage='feature_extraction')
        elif start_index <= stage_order.index('gaussian_splatting'):
            # Start from gaussian splatting (skip COLMAP stages)
            # First, ensure we select the best sparse model, rename to 0/, and clean up inferior ones
            append_log_line(project_id, "🔍 Checking sparse reconstruction models...")
            sparse_model_path = select_best_sparse_model(paths['sparse_path'], project_id)

            if not sparse_model_path:
                raise Exception("No valid sparse reconstruction found. Please retry from an earlier stage.")

            run_opensplat_training(project_id, paths, config, processing_start_time, time_estimate, time_estimator)
        else:
            # Just finalize
            finalize_project(project_id)

    except Exception as e:
        logger.error(f"Processing failed for {project_id}: {e}")
        append_log_line(project_id, f"❌ Error: {str(e)}")

        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'failed'
            project_store.processing_status[project_id]['error'] = str(e)
            project_store.processing_status[project_id]['end_time'] = datetime.now().isoformat()
            save_projects_db()


def run_processing_pipeline(project_id, paths, config, video_files, image_files):
    """Run the complete processing pipeline."""
    run_processing_pipeline_from_stage(project_id, paths, config, video_files, image_files, from_stage='ingest')


def get_colmap_executable():
    """Get the appropriate COLMAP executable (GPU version if available, fallback to system version)"""
    for candidate in app_config.COLMAP_CANDIDATE_PATHS:
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue

    if app_config.COLMAP_ENV_PATH:
        return app_config.COLMAP_ENV_PATH

    return 'colmap'  # fallback to system COLMAP


# Vocab tree matching disabled - COLMAP switched from flann to faiss format in May 2025
# Legacy vocab trees are incompatible with current COLMAP version
# Sequential matching provides sufficient coverage for most datasets



def select_best_sparse_model(sparse_path, project_id=None):
    """
    Analyze all sparse reconstruction models and select the best one.
    Returns the path to the best model based on number of registered images.
    Preserves alternate models so split reconstructions remain inspectable.
    """
    if not sparse_path.exists():
        return None

    best_model = None
    best_score = (-1, -1, -1, -1)
    all_models = analyze_sparse_models(sparse_path, project_id, log_each=True)
    for model_info in all_models:
        if model_info['score'] > best_score:
            best_score = model_info['score']
            best_model = model_info['path']

    if best_model and project_id:
        append_log_line(project_id, f"✅ Selected best reconstruction: {best_model.name}")

        # Step 1: Rename all models to temporary names (A, B, C, D...) to avoid conflicts
        append_log_line(project_id, "📦 Step 1: Renaming all models to temporary names...")
        temp_names = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        temp_mappings = {}  # Maps temp name to original model_info

        for idx, model_info in enumerate(all_models):
            if idx >= len(temp_names):
                break
            temp_name = temp_names[idx]
            original_path = model_info['path']
            temp_path = original_path.parent / temp_name

            try:
                shutil.move(str(original_path), str(temp_path))
                temp_mappings[temp_name] = {
                    'path': temp_path,
                    'original_name': original_path.name,
                    'model_info': model_info,
                    'is_best': (original_path == best_model)
                }
                if project_id:
                    append_log_line(project_id, f"  ↳ Renamed {original_path.name} → {temp_name}")

                # Update best_model reference if this was the best
                if original_path == best_model:
                    best_model = temp_path
                    best_temp_name = temp_name
            except Exception as e:
                logger.warning(f"Failed to rename {original_path.name} to {temp_name}: {e}")
                if project_id:
                    append_log_line(project_id, f"⚠️ Failed to rename {original_path.name}: {e}")

        # Step 2: Rename the best model to '0'
        append_log_line(project_id, f"📦 Step 2: Renaming best model ({best_temp_name}) to 0...")
        target_path = best_model.parent / '0'
        try:
            shutil.move(str(best_model), str(target_path))
            best_model = target_path
            append_log_line(project_id, f"✅ Best model renamed to 0/")
        except Exception as e:
            logger.warning(f"Failed to rename best model to 0/: {e}")
            if project_id:
                append_log_line(project_id, f"⚠️ Failed to rename best model: {e}")

        # Step 3: Preserve all other temporary models under alternate names.
        append_log_line(project_id, "📦 Step 3: Preserving alternate sparse models...")
        alt_index = 1
        for temp_name, mapping in temp_mappings.items():
            if not mapping['is_best']:
                temp_path = mapping['path']
                original_name = mapping['original_name']
                model_info = mapping['model_info']

                if temp_path.exists():
                    try:
                        alt_path = temp_path.parent / f'alt_{alt_index}'
                        while alt_path.exists():
                            alt_index += 1
                            alt_path = temp_path.parent / f'alt_{alt_index}'
                        shutil.move(str(temp_path), str(alt_path))
                        append_log_line(
                            project_id,
                            f"📦 Preserved alternate model: {original_name} → {alt_path.name} "
                            f"(cameras={model_info['num_cameras']}, registered={model_info['registered_images']})"
                        )
                        alt_index += 1
                    except Exception as e:
                        logger.warning(f"Failed to preserve {temp_name}: {e}")
                        if project_id:
                            append_log_line(project_id, f"⚠️ Failed to preserve {temp_name}: {e}")

        append_log_line(project_id, "✅ Model organization completed - best model is 0/ and alternate models were preserved")

    return best_model


def analyze_sparse_models(sparse_path, project_id=None, *, log_each=False):
    if not Path(sparse_path).exists():
        return []

    colmap_exe = get_colmap_executable()
    all_models = []

    for item in Path(sparse_path).iterdir():
        if not item.is_dir():
            continue

        cameras_bin = item / 'cameras.bin'
        cameras_txt = item / 'cameras.txt'
        if not (cameras_bin.exists() or cameras_txt.exists()):
            continue

        try:
            result = subprocess.run(
                [colmap_exe, 'model_analyzer', '--path', str(item)],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except Exception as exc:
            logger.warning("Failed to analyze model %s: %s", item, exc)
            continue

        combined_output = ''
        if result.stdout:
            combined_output += result.stdout
        if result.stderr:
            combined_output += result.stderr

        if result.returncode != 0:
            if project_id:
                append_log_line(
                    project_id,
                    f"⚠️ Failed to analyze model {item.name}: return code {result.returncode}",
                )
            continue

        stats = {
            'path': item,
            'name': item.name,
            'num_cameras': 0,
            'num_images': 0,
            'registered_images': 0,
            'num_points': 0,
        }

        for line in combined_output.splitlines():
            match_cameras = re.search(r'Cameras:\s*(\d+)', line)
            if match_cameras:
                stats['num_cameras'] = int(match_cameras.group(1))
                continue

            match_images = re.search(r'Images:\s*(\d+)', line)
            if match_images:
                stats['num_images'] = int(match_images.group(1))
                continue

            match_registered = re.search(r'Registered images:\s*(\d+)', line)
            if match_registered:
                stats['registered_images'] = int(match_registered.group(1))
                continue

            match_points = re.search(r'Points:\s*(\d+)', line)
            if match_points:
                stats['num_points'] = int(match_points.group(1))

        stats['score'] = (
            stats['num_cameras'],
            stats['registered_images'],
            stats['num_points'],
            stats['num_images'],
        )
        all_models.append(stats)

        if project_id and log_each:
            append_log_line(
                project_id,
                f"📊 Model {item.name}: cameras={stats['num_cameras']}, "
                f"registered={stats['registered_images']}, images={stats['num_images']}, points={stats['num_points']}",
            )

    all_models.sort(key=lambda item: item['score'], reverse=True)
    return all_models


def summarize_sparse_model_coverage(num_images, sparse_models):
    if not sparse_models:
        return None

    best_model = sparse_models[0]
    best_registered = int(best_model.get('registered_images') or 0)
    registered_ratio = best_registered / max(num_images, 1)
    alternate_models = sparse_models[1:]
    alternate_registered = max((int(item.get('registered_images') or 0) for item in alternate_models), default=0)

    return {
        'best_registered': best_registered,
        'registered_ratio': round(registered_ratio, 4),
        'model_count': len(sparse_models),
        'alternate_registered': alternate_registered,
        'has_multiple_models': len(sparse_models) > 1,
    }


def report_sparse_model_coverage(project_id, paths, config, colmap_cfg, num_images):
    sparse_models = analyze_sparse_models(paths['sparse_path'], project_id, log_each=True)
    sparse_summary = summarize_sparse_model_coverage(num_images, sparse_models)
    if not sparse_summary:
        return None

    sync_reconstruction_framework(
        project_id,
        config,
        colmap_cfg,
        phase='sparse_evaluated',
        extra={
            'sparse_model_summary': sparse_summary,
            'sparse_models': [
                {
                    'name': item['name'],
                    'registered_images': item['registered_images'],
                    'num_images': item['num_images'],
                    'num_points': item['num_points'],
                }
                for item in sparse_models
            ],
        },
    )

    if sparse_summary['model_count'] == 1:
        append_log_line(
            project_id,
            "✅ Sparse reconstruction unified into a single model: "
            f"{sparse_summary['best_registered']}/{num_images} images registered",
        )
        return sparse_summary

    append_log_line(
        project_id,
        "ℹ️ Sparse reconstruction produced multiple models before organization: "
        f"{sparse_summary['model_count']} models, best={sparse_summary['best_registered']}/{num_images}, "
        f"next_best={sparse_summary['alternate_registered']}",
    )
    return sparse_summary


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


def run_boundary_frame_densification_recovery(project_id, paths, config, colmap_cfg):
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

    # After densifying the image set, recompute the baseline config for the new
    # image count, then clamp it so round 2 cannot become stricter than round 1.
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
    rerun_colmap_cfg = run_feature_extraction_stage(project_id, paths, config, rerun_colmap_cfg)
    rerun_colmap_cfg = run_feature_matching_stage(project_id, paths, config, rerun_colmap_cfg)
    return run_sparse_reconstruction_stage(project_id, paths, config, rerun_colmap_cfg)


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


def get_colmap_config(num_images, project_id=None, quality_mode='balanced', custom_params=None, preferred_matcher_type=None, orbit_safe_mode=False, orbit_safe_policy=None):
    """Configure COLMAP parameters based on image count and quality requirements"""

    if project_id:
        append_log_line(project_id, f"Optimizing COLMAP config for {num_images} images (Quality: {quality_mode})")

    # Quality-based parameter scaling - NEW: Balanced = High quality baseline
    # IMPROVED: Increased matches multiplier for high-feature-count images (75K+ features)
    quality_scales = {
        'fast': {'size': 0.6, 'features': 0.5, 'matches': 0.5, 'octaves': -1},
        'balanced': {'size': 1.0, 'features': 1.0, 'matches': 2.5, 'octaves': 0},  # Increased from 2.0 to 2.5
        'high': {'size': 1.0, 'features': 1.0, 'matches': 3.0, 'octaves': 0},  # Increased from 2.0 to 3.0
        'ultra': {'size': 1.2, 'features': 1.2, 'matches': 3.5, 'octaves': 0},  # Increased from 2.5 to 3.5
        'hard': {'size': 1.4, 'features': 1.75, 'matches': 5.0, 'octaves': -1},
        'professional': {'size': 1.5, 'features': 1.5, 'matches': 4.0, 'octaves': 0},  # Increased from 2.5 to 4.0
        'ultra_professional': {'size': 1.8, 'features': 1.8, 'matches': 4.5, 'octaves': 0},  # Increased from 3.0 to 4.5
        'robust': {'size': 1.0, 'features': 1.0, 'matches': 3.5, 'octaves': 0},  # Increased from 2.5 to 3.5
        'custom': {'size': 1.0, 'features': 1.0, 'matches': 3.0, 'octaves': 0}   # Increased from 2.0 to 3.0
    }

    scale = quality_scales.get(quality_mode, quality_scales['balanced'])

    # Base feature extraction settings - MAXIMUM quality for ALL dataset sizes
    # NO MORE QUALITY REDUCTION regardless of image count
    base_max_image_size = 4160  # High quality size (same as 7000 iter mode)
    base_max_num_features = 32768  # Increased from 12288 for 4K image support
    base_octaves = 4

    # Apply quality scaling for all dataset sizes equally
    max_image_size = int(base_max_image_size * scale['size'])
    max_num_features = int(base_max_num_features * scale['features'])

    # Override with custom parameters if provided (custom mode or retry with params)
    if custom_params:
        if 'max_num_features' in custom_params and custom_params['max_num_features'] is not None:
            max_num_features = int(custom_params['max_num_features'])
            if project_id:
                append_log_line(project_id, f"🔧 Custom max_num_features: {max_num_features}")
        if 'max_image_size' in custom_params and custom_params['max_image_size'] is not None:
            max_image_size = int(custom_params['max_image_size'])
            if project_id:
                append_log_line(project_id, f"🔧 Custom max_image_size: {max_image_size}")

    first_octave = -1 if quality_mode in ['high', 'ultra', 'professional', 'ultra_professional'] else scale['octaves']
    num_octaves = base_octaves + (1 if quality_mode in ['ultra', 'professional', 'ultra_professional'] else 0)

    # Quality-aware matching strategy with GPU memory consideration
    # Auto-detect and limit based on feature count to prevent GPU OOM
    base_matches = 45960  # Base value for feature matching (40K matches)
    max_num_matches = int(base_matches * scale['matches'])

    # Override with custom parameters if provided
    if custom_params:
        if 'max_num_matches' in custom_params and custom_params['max_num_matches'] is not None:
            max_num_matches = int(custom_params['max_num_matches'])
            if project_id:
                append_log_line(project_id, f"🔧 Custom max_num_matches: {max_num_matches}")
    
    # CRITICAL: Prevent GPU OOM by capping max_num_matches using conservative defaults first.
    max_match_limit = 65536 if quality_mode == 'hard' else 45960
    if max_num_matches > max_match_limit:
        if project_id:
            append_log_line(
                project_id,
                f"⚠️ Reducing max_num_matches from {max_num_matches} to {max_match_limit} to prevent GPU memory overflow",
            )
        max_num_matches = max_match_limit

    gpu_total_vram_mb = get_gpu_total_vram_mb()
    gpu_safe_match_limit = estimate_gpu_safe_match_limit(total_vram_mb=gpu_total_vram_mb)
    if gpu_safe_match_limit and gpu_safe_match_limit < max_num_matches:
        if project_id:
            append_log_line(
                project_id,
                "🧠 VRAM-aware config tuning: "
                f"reducing max_num_matches from {max_num_matches} to {gpu_safe_match_limit} "
                f"based on GPU VRAM ({gpu_total_vram_mb} MiB)",
            )
        max_num_matches = gpu_safe_match_limit

    explicit_matcher_type = normalize_matcher_type(preferred_matcher_type)
    orbit_safe_forced_matcher = False

    # Matching strategy based on dataset size and quality requirements
    if quality_mode == 'robust':
        # Robust mode: Always use exhaustive for difficult datasets
        matcher_type = 'exhaustive'
        max_num_matches = min(max_num_matches, 45960)  # Cap for GPU safety
        matcher_params = {}
        if project_id:
            append_log_line(project_id, "🔧 Using ROBUST mode: Exhaustive matching for maximum coverage")
    elif quality_mode == 'hard':
        if num_images <= 250:
            matcher_type = 'exhaustive'
            matcher_params = {}
            max_num_matches = min(max_num_matches, 65536)
        else:
            matcher_type = 'sequential'
            matcher_params = get_sequential_matcher_params(num_images, quality_mode)
        if project_id:
            append_log_line(project_id, "🔧 Using HARD mode: aggressive feature coverage with lighter first-pass training")
    elif quality_mode == 'ultra' and num_images <= 200:
        # Ultra quality: Use exhaustive for smaller datasets
        matcher_type = 'exhaustive'
        max_num_matches = min(max_num_matches, 45960)  # Cap for GPU safety
        matcher_params = {}
    elif num_images <= 50:
        # Small: Use exhaustive for best coverage
        matcher_type = 'exhaustive'
        matcher_params = {}
    elif num_images <= 150:
        # Medium-small: Sequential with enhanced overlap for better coverage
        matcher_type = 'sequential'
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    elif num_images <= 400:
        # Medium-large: Enhanced sequential for better quality
        matcher_type = 'sequential'  # Changed from spatial for better GPU utilization
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    elif num_images <= 1000:
        # Large: Quality-aware sequential with improved coverage
        matcher_type = 'sequential'
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    else:
        # Very large unordered photo sets benefit from retrieval-based pairing.
        matcher_type = 'vocab_tree'
        matcher_params = get_vocab_tree_matcher_params()

    if orbit_safe_mode:
        if explicit_matcher_type == 'exhaustive':
            orbit_safe_forced_matcher = True
        matcher_type = 'sequential'
        matcher_params = get_sequential_matcher_params(
            num_images,
            quality_mode,
            orbit_safe_mode=True,
            orbit_safe_policy=orbit_safe_policy,
        )
        if project_id:
            if orbit_safe_forced_matcher:
                append_log_line(project_id, "🛡️ Orbit-safe mode overriding exhaustive matcher with local sequential matching to preserve temporal continuity")
            else:
                loop_detection_enabled = matcher_params.get('SequentialMatching.loop_detection') == '1'
                if loop_detection_enabled:
                    append_log_line(project_id, "🛡️ Orbit-safe mode enabled: using local sequential matching with bridge-recovery loop closure")
                else:
                    append_log_line(project_id, "🛡️ Orbit-safe mode enabled: using local sequential matching without loop-closure fallback")
            if orbit_safe_policy:
                append_log_line(
                    project_id,
                    "🛡️ Orbit-safe profile: "
                    f"{orbit_safe_policy['profile_name']} | overlap={matcher_params['SequentialMatching.overlap']} "
                    f"| min_inliers={orbit_safe_policy['mapper_params']['Mapper.abs_pose_min_num_inliers']} "
                    f"| min_ratio={orbit_safe_policy['mapper_params']['Mapper.abs_pose_min_inlier_ratio']}"
                )
    elif explicit_matcher_type:
        matcher_type = explicit_matcher_type
        if matcher_type == 'exhaustive':
            matcher_params = {}
            max_num_matches = min(max_num_matches, 45960)
        elif matcher_type == 'vocab_tree':
            matcher_params = get_vocab_tree_matcher_params()
        else:
            matcher_params = get_sequential_matcher_params(num_images, quality_mode)

        if project_id:
            append_log_line(project_id, f"🔧 Using user-selected matcher override: {matcher_type}")

    # Quality-aware reconstruction settings - NEW: Balanced = High quality baseline
    quality_mapper_scales = {
        'fast': {'matches': 1.0, 'trials': 0.5, 'models': 0.5},
        'balanced': {'matches': 0.8, 'trials': 1.5, 'models': 2.0},  # Same as High (aggressive for better results)
        'high': {'matches': 0.8, 'trials': 1.5, 'models': 2.0},  # Aggressive reconstruction
        'ultra': {'matches': 0.7, 'trials': 2.0, 'models': 3.0},  # Very aggressive
        'hard': {'matches': 0.55, 'trials': 2.2, 'models': 4.0},  # Coverage-first without long training
        'professional': {'matches': 0.6, 'trials': 2.5, 'models': 5.0},  # Maximum for 4K+ (30,000 iterations)
        'ultra_professional': {'matches': 0.5, 'trials': 3.0, 'models': 7.0},  # Ultra maximum (60,000 iterations)
        'unlimited': {'matches': 0.6, 'trials': 2.5, 'models': 5.0},  # Maximum for 4K - same as robust
        'robust': {'matches': 0.6, 'trials': 2.5, 'models': 5.0},  # Extremely aggressive for difficult data
        'custom': {'matches': 0.8, 'trials': 1.5, 'models': 2.0}  # Same as High baseline
    }

    mapper_scale = quality_mapper_scales.get(quality_mode, quality_mapper_scales['balanced'])

    # Base mapper settings for reconstruction
    if num_images <= 100:
        base_min_matches = 8  # Reduced from 15 for better registration success
        base_min_model_size = 3  # Reduced from 10 to accept smaller valid models
        base_max_models = 50
        base_init_trials = 200
        max_extra_param = 1  # Always allow extra camera parameters for flexibility
    elif num_images <= 300:
        base_min_matches = 20
        base_min_model_size = 15
        base_max_models = 20
        base_init_trials = 150
        max_extra_param = 1 if quality_mode in ['high', 'ultra', 'hard', 'professional', 'ultra_professional'] else 0
    elif num_images <= 1000:
        base_min_matches = 12  # Reduced from 25 for better registration
        base_min_model_size = 8  # Reduced from 20 to accept smaller valid models
        base_max_models = 15
        base_init_trials = 150  # Increased from 120 for more initialization attempts
        max_extra_param = 1  # Always allow extra camera parameters for flexibility
    else:
        base_min_matches = 30
        base_min_model_size = 25
        base_max_models = 10
        base_init_trials = 100
        max_extra_param = 0

    # Override with custom sequential overlap if provided
    if custom_params and quality_mode == 'custom' and 'sequential_overlap' in custom_params and custom_params['sequential_overlap'] is not None:
        if matcher_type == 'sequential' and matcher_params:
            matcher_params['SequentialMatching.overlap'] = str(custom_params['sequential_overlap'])
            if project_id:
                append_log_line(project_id, f"🔧 Custom sequential_overlap: {custom_params['sequential_overlap']}")

    # Apply quality scaling to mapper settings
    min_num_matches = max(6, int(base_min_matches * mapper_scale['matches']))  # Minimum 6 instead of 10
    min_model_size = base_min_model_size
    max_num_models = int(base_max_models * mapper_scale['models'])
    init_num_trials = int(base_init_trials * mapper_scale['trials'])

    mapper_params = {}

    if orbit_safe_mode:
        min_num_matches = min(min_num_matches, (orbit_safe_policy or {}).get('min_num_matches_cap', 12))
        init_num_trials = max(init_num_trials, (orbit_safe_policy or {}).get('init_num_trials_floor', 200))
        mapper_params.update((orbit_safe_policy or {}).get('mapper_params', {
            'Mapper.structure_less_registration_fallback': '0',
            'Mapper.abs_pose_max_error': '12',
            'Mapper.abs_pose_min_num_inliers': '18',
            'Mapper.abs_pose_min_inlier_ratio': '0.12',
            'Mapper.max_reg_trials': '8',
        }))

    # Override with custom mapper parameters if provided
    if custom_params and quality_mode == 'custom':
        if 'min_num_matches' in custom_params and custom_params['min_num_matches'] is not None:
            min_num_matches = custom_params['min_num_matches']
            if project_id:
                append_log_line(project_id, f"🔧 Custom min_num_matches: {min_num_matches}")
        if 'max_num_models' in custom_params and custom_params['max_num_models'] is not None:
            max_num_models = custom_params['max_num_models']
            if project_id:
                append_log_line(project_id, f"🔧 Custom max_num_models: {max_num_models}")
        if 'init_num_trials' in custom_params and custom_params['init_num_trials'] is not None:
            init_num_trials = custom_params['init_num_trials']
            if project_id:
                append_log_line(project_id, f"🔧 Custom init_num_trials: {init_num_trials}")

    # Enhanced SIFT parameters for better feature quality
    sift_params = {}
    if quality_mode == 'ultra_professional':
        # Ultra Professional mode: Ultra maximum feature quality for highest quality (60,000 iterations)
        sift_params.update({
            'peak_threshold': 0.004,  # Ultra low = maximum features detected
            'edge_threshold': 25,      # Ultra high = most robust edge filtering
            'max_num_orientations': 5,  # Ultra maximum orientations for best matching
        })
    elif quality_mode == 'hard':
        sift_params.update({
            'peak_threshold': 0.005,
            'edge_threshold': 22,
            'max_num_orientations': 4,
        })
    elif quality_mode == 'professional':
        # Professional mode: Maximum feature quality for 4K+ images (30,000 iterations)
        sift_params.update({
            'peak_threshold': 0.006,  # Lower = more features detected
            'edge_threshold': 20,      # Higher = more robust edge filtering
            'max_num_orientations': 4,  # Maximum orientations for best matching
        })
    elif quality_mode in ['high', 'ultra']:
        sift_params.update({
            'peak_threshold': 0.008 if quality_mode == 'ultra' else 0.01,  # Higher = more robust features
            'edge_threshold': 15 if quality_mode == 'ultra' else 15,        # Higher = reduce false edges
            'max_num_orientations': 3 if quality_mode == 'ultra' else 2,    # More orientations
        })
    elif quality_mode == 'balanced':
        # Balanced mode gets same SIFT params as High quality
        sift_params.update({
            'peak_threshold': 0.01,  # Slightly more selective than default
            'edge_threshold': 15,     # More robust edge filtering
            'max_num_orientations': 2  # Same as High quality
        })
    elif quality_mode == 'custom':
        # Custom mode: Use provided params or High quality defaults
        sift_params.update({
            'peak_threshold': (custom_params.get('peak_threshold') or 0.01) if custom_params else 0.01,
            'edge_threshold': (custom_params.get('edge_threshold') or 15) if custom_params else 15,
            'max_num_orientations': (custom_params.get('max_num_orientations') or 2) if custom_params else 2
        })
        if project_id and custom_params:
            if 'peak_threshold' in custom_params and custom_params['peak_threshold'] is not None:
                append_log_line(project_id, f"🔧 Custom peak_threshold: {custom_params['peak_threshold']}")
            if 'edge_threshold' in custom_params and custom_params['edge_threshold'] is not None:
                append_log_line(project_id, f"🔧 Custom edge_threshold: {custom_params['edge_threshold']}")
            if 'max_num_orientations' in custom_params and custom_params['max_num_orientations'] is not None:
                append_log_line(project_id, f"🔧 Custom max_num_orientations: {custom_params['max_num_orientations']}")

    if project_id and matcher_type == 'vocab_tree':
        if matcher_params.get('VocabTreeMatching.vocab_tree_path'):
            append_log_line(project_id, "🌲 Using vocab-tree matching with cached tree")
        else:
            append_log_line(project_id, "🌲 Using vocab-tree matching; modern COLMAP builds can auto-download/cache the tree if needed")

    config = {
        # Feature extraction - Enhanced
        'max_image_size': max_image_size,
        'max_num_features': max_num_features,
        'first_octave': first_octave,
        'num_octaves': num_octaves,

        # Enhanced SIFT parameters
        'sift_params': sift_params,

        # Matching - Quality aware
        'matcher_type': matcher_type,
        'max_num_matches': max_num_matches,
        'matcher_params': matcher_params,

        # Reconstruction - High quality settings
        'min_num_matches': min_num_matches,
        'min_model_size': min_model_size,
        'max_num_models': max_num_models,
        'init_num_trials': init_num_trials,
        'max_extra_param': max_extra_param,
        'mapper_params': mapper_params,

        # Quality metadata
        'quality_mode': quality_mode,
        'total_expected_matches': int(
            num_images * float(matcher_params.get('SequentialMatching.overlap', '10'))
            if matcher_type == 'sequential'
            else (num_images * 100 if matcher_type == 'vocab_tree' else num_images * (num_images - 1) / 2)
        ),
        'orbit_safe_mode': orbit_safe_mode,
        'orbit_safe_profile': orbit_safe_policy['profile_name'] if orbit_safe_policy else None,
        'bridge_risk_score': orbit_safe_policy['bridge_risk_score'] if orbit_safe_policy else None,
        'capture_pattern': orbit_safe_policy['capture_pattern'] if orbit_safe_policy else None,
    }

    return config


def get_opensplat_config(quality_mode='balanced', num_images=100, custom_params=None):
    """Get OpenSplat training configuration based on quality requirements and dataset size"""

    # Quality-based scaling factors - NEW: Balanced = High quality (7000 iter) baseline
    quality_scales = {
        'fast': {
            'iterations': 500,
            'densify_from': 100,
            'densify_until': 300,
            'densify_grad_threshold': 0.0002,
            'opacity_reset_interval': 3000,
            'prune_opacity': 0.005
        },
        'balanced': {
            'iterations': 7000,  # NOW SAME AS HIGH
            'densify_from': 1000,
            'densify_until': 3500,
            'densify_grad_threshold': 0.00015,  # Lower = more dense
            'opacity_reset_interval': 3000,
            'prune_opacity': 0.003  # Lower = more conservative pruning
        },
        'hard': {
            'iterations': 5000,
            'densify_from': 900,
            'densify_until': 3200,
            'densify_grad_threshold': 0.00012,
            'opacity_reset_interval': 2400,
            'prune_opacity': 0.002
        },
        'high': {
            'iterations': 7000,
            'densify_from': 1000,
            'densify_until': 3500,
            'densify_grad_threshold': 0.00015,  # Lower = more dense
            'opacity_reset_interval': 3000,
            'prune_opacity': 0.003  # Lower = more conservative pruning
        },
        'ultra': {
            'iterations': 15000,
            'densify_from': 2000,
            'densify_until': 7500,
            'densify_grad_threshold': 0.0001,  # Even lower = very dense
            'opacity_reset_interval': 2500,   # More frequent resets
            'prune_opacity': 0.002  # Very conservative pruning
        },
        'professional': {
            'iterations': 30000,
            'densify_from': 3000,
            'densify_until': 15000,
            'densify_grad_threshold': 0.00008,  # Extremely dense for 4K+
            'opacity_reset_interval': 2000,     # Very frequent resets
            'prune_opacity': 0.001  # Extremely conservative pruning
        },
        'ultra_professional': {
            'iterations': 60000,
            'densify_from': 4000,
            'densify_until': 30000,
            'densify_grad_threshold': 0.00005,  # Ultra dense for ultra high quality
            'opacity_reset_interval': 1500,     # Even more frequent resets
            'prune_opacity': 0.0005  # Ultra conservative pruning
        },
        'custom': {
            'iterations': 7000,  # NOW SAME AS HIGH baseline
            'densify_from': 1000,
            'densify_until': 3500,
            'densify_grad_threshold': 0.00015,
            'opacity_reset_interval': 3000,
            'prune_opacity': 0.003
        }
    }

    base_config = quality_scales.get(quality_mode, quality_scales['balanced'])

    # Dataset size adjustments
    if num_images > 500:
        # For large datasets, increase iterations for better convergence
        base_config['iterations'] = int(base_config['iterations'] * 1.2)
        base_config['densify_until'] = int(base_config['densify_until'] * 1.2)
    elif num_images < 50:
        # For small datasets, reduce iterations to prevent overfitting
        base_config['iterations'] = max(1000, int(base_config['iterations'] * 0.8))

    # Additional high-quality parameters
    if quality_mode in ['high', 'ultra', 'hard', 'balanced']:
        base_config.update({
            'learning_rate': 0.0025,  # Lower learning rate for stability
            'position_lr_init': 0.00016,
            'position_lr_final': 0.0000016,
            'feature_lr': 0.0025,
            'opacity_lr': 0.05,
            'scaling_lr': 0.005,
            'rotation_lr': 0.001,
            'percent_dense': 0.1 if quality_mode == 'ultra' else (0.05 if quality_mode == 'hard' else 0.01),
        })

    # Override with custom parameters if provided
    if custom_params and quality_mode == 'custom':
        # OpenSplat Training Parameters
        if 'iterations' in custom_params and custom_params['iterations'] is not None:
            base_config['iterations'] = int(custom_params['iterations'])
        if 'densify_grad_threshold' in custom_params and custom_params['densify_grad_threshold'] is not None:
            base_config['densify_grad_threshold'] = float(custom_params['densify_grad_threshold'])
        if 'refine_every' in custom_params and custom_params['refine_every'] is not None:
            base_config['refine_every'] = int(custom_params['refine_every'])
        if 'warmup_length' in custom_params and custom_params['warmup_length'] is not None:
            base_config['warmup_length'] = int(custom_params['warmup_length'])
        if 'ssim_weight' in custom_params and custom_params['ssim_weight'] is not None:
            base_config['ssim_weight'] = float(custom_params['ssim_weight'])

        # OpenSplat Learning Rates
        if 'learning_rate' in custom_params and custom_params['learning_rate'] is not None:
            base_config['learning_rate'] = float(custom_params['learning_rate'])
        if 'position_lr_init' in custom_params and custom_params['position_lr_init'] is not None:
            base_config['position_lr_init'] = float(custom_params['position_lr_init'])
        if 'position_lr_final' in custom_params and custom_params['position_lr_final'] is not None:
            base_config['position_lr_final'] = float(custom_params['position_lr_final'])
        if 'feature_lr' in custom_params and custom_params['feature_lr'] is not None:
            base_config['feature_lr'] = float(custom_params['feature_lr'])
        if 'opacity_lr' in custom_params and custom_params['opacity_lr'] is not None:
            base_config['opacity_lr'] = float(custom_params['opacity_lr'])
        if 'scaling_lr' in custom_params and custom_params['scaling_lr'] is not None:
            base_config['scaling_lr'] = float(custom_params['scaling_lr'])
        if 'rotation_lr' in custom_params and custom_params['rotation_lr'] is not None:
            base_config['rotation_lr'] = float(custom_params['rotation_lr'])
        if 'percent_dense' in custom_params and custom_params['percent_dense'] is not None:
            base_config['percent_dense'] = float(custom_params['percent_dense'])

    return base_config


def get_colmap_config_for_pipeline(paths, config, project_id=None):
    """
    Helper to get COLMAP configuration and common setup for pipeline stages.
    Returns (num_images, colmap_config, colmap_exe, has_cuda)
    """
    images_path = paths['images_path']
    num_images = len([f for f in os.listdir(images_path)
                     if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff'))])
    
    quality_mode = config.get('quality_mode', 'balanced')
    
    # Always extract custom parameters from config (for retry with updated settings)
    custom_params = {
        # SIFT Feature Parameters
        'peak_threshold': config.get('peak_threshold'),
        'edge_threshold': config.get('edge_threshold'),
        'max_num_orientations': config.get('max_num_orientations'),
        # Feature Extraction
        'max_num_features': config.get('max_num_features'),
        'max_image_size': config.get('max_image_size'),
        # Feature Matching
        'max_num_matches': config.get('max_num_matches'),
        'sequential_overlap': config.get('sequential_overlap'),
        # Mapper (Reconstruction)
        'min_num_matches': config.get('min_num_matches'),
        'max_num_models': config.get('max_num_models'),
        'init_num_trials': config.get('init_num_trials')
    }
    
    # Filter out None values to keep only explicitly set parameters
    custom_params = {k: v for k, v in custom_params.items() if v is not None}
    orbit_safe_policy = build_orbit_safe_policy(paths, config, num_images)
    orbit_safe_mode = orbit_safe_policy is not None
    orbit_safe_reason = orbit_safe_policy['reason'] if orbit_safe_policy else None
    if project_id and orbit_safe_mode:
        append_log_line(project_id, f"🛡️ Orbit-safe reconstruction policy enabled: {orbit_safe_reason}")
    
    # Pass custom_params only if there are any non-None values
    colmap_config = get_colmap_config(
        num_images, 
        project_id, 
        quality_mode, 
        custom_params if custom_params else None,
        normalize_matcher_type(config.get('matcher_type')),
        orbit_safe_mode,
        orbit_safe_policy,
    )
    sync_reconstruction_framework(project_id, config, colmap_config, phase='config_ready')
    colmap_exe = get_colmap_executable()
    
    # Check if COLMAP has CUDA support
    colmap_info = subprocess.run([colmap_exe, '-h'], capture_output=True, text=True)
    has_cuda = 'with CUDA' in (colmap_info.stdout or '')
    
    return num_images, colmap_config, colmap_exe, has_cuda


# ===========================================================================
# HLOC Neural Feature Extraction & Matching (ALIKED + LightGlue)
# ===========================================================================

def run_hloc_feature_extraction_stage(project_id, paths, config, colmap_config=None):
    """Run hloc neural feature extraction (ALIKED or SuperPoint) - 10-20x faster than SIFT."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    
    update_state(project_id, 'feature_extraction', status='running')
    update_stage_detail(project_id, 'feature_extraction', text='Initializing neural features...', subtext='hloc ALIKED')
    append_log_line(project_id, "⚡ Running hloc Neural Feature Extraction (ALIKED + LightGlue)")
    append_log_line(project_id, f"🎯 Processing {num_images} images with GPU-accelerated neural features")
    
    try:
        from pathlib import Path
        from hloc import extract_features
        from hloc.utils.io import list_h5_names
        import pycolmap
        import torch
        
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        append_log_line(project_id, f"🎮 Using device: {device}")
        
        images_path = Path(paths['images_path'])
        output_path = Path(paths['project_path'])
        
        # Use ALIKED for fastest extraction (125+ FPS)
        feature_method = config.get('feature_method', 'aliked')
        
        if feature_method == 'superpoint':
            feature_conf = extract_features.confs['superpoint_max']
            append_log_line(project_id, "📌 Using SuperPoint features (best accuracy)")
        else:
            # ALIKED is default - fastest
            feature_conf = extract_features.confs['aliked-n16']
            append_log_line(project_id, "📌 Using ALIKED features (fastest - 125+ FPS)")
        
        # Adjust max keypoints based on quality mode
        quality_mode = config.get('quality_mode', 'balanced')
        if quality_mode == 'fast':
            feature_conf = {**feature_conf, 'max_keypoints': 2048}
        elif quality_mode == 'hard':
            feature_conf = {**feature_conf, 'max_keypoints': 8192}
        elif quality_mode == 'quality':
            feature_conf = {**feature_conf, 'max_keypoints': 8192}
        else:
            feature_conf = {**feature_conf, 'max_keypoints': 4096}
        
        append_log_line(project_id, f"🔧 Max keypoints: {feature_conf.get('max_keypoints', 4096)}")
        
        # Run feature extraction
        features_path = output_path / 'features.h5'
        
        # Progress callback
        def progress_callback(current, total):
            percent = int((current / total) * 100) if total > 0 else 0
            details = {
                'text': f'Images processed: {current}/{total}',
                'current_item': current,
                'total_items': total,
                'item_name': f'Image {current}',
                'feature_method': feature_method
            }
            emit_stage_progress(project_id, 'feature_extraction', percent, details)
            update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
            update_stage_detail(project_id, 'feature_extraction', 
                              text=f'Images processed: {current}/{total}', 
                              subtext=f'hloc {feature_method.upper()}')
        
        # Extract features
        append_log_line(project_id, f"🚀 Starting feature extraction...")
        features_path = extract_features.main(
            feature_conf, 
            images_path, 
            output_path,
            as_half=True  # Use FP16 for speed
        )
        
        append_log_line(project_id, f"✅ Features saved to {features_path}")
        
        # Count extracted features
        feature_names = list_h5_names(features_path)
        append_log_line(project_id, f"📊 Extracted features from {len(feature_names)} images")
        
        update_state(project_id, 'feature_extraction', status='completed', progress=100)
        update_stage_detail(project_id, 'feature_extraction', 
                          text=f'Images processed: {num_images}/{num_images}', 
                          subtext=f'hloc {feature_method.upper()} complete')
        append_log_line(project_id, f"✅ hloc Feature Extraction completed ({feature_method.upper()})")
        
        # Store features path for matching stage
        return {'features_path': str(features_path), 'feature_conf': feature_conf, 'colmap_config': colmap_cfg}
        
    except Exception as e:
        append_log_line(project_id, f"❌ hloc feature extraction failed: {e}")
        append_log_line(project_id, "⚠️ Falling back to COLMAP SIFT...")
        # Fall back to COLMAP
        return run_feature_extraction_stage(project_id, paths, config, colmap_config)


def run_hloc_feature_matching_stage(project_id, paths, config, hloc_data=None):
    """Run hloc LightGlue matching - 4-10x faster than nearest neighbor."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    
    update_state(project_id, 'feature_matching', status='running')
    update_stage_detail(project_id, 'feature_matching', text='Initializing LightGlue...', subtext='Neural matching')
    append_log_line(project_id, "⚡ Running hloc LightGlue Matching (4-10x faster)")
    
    try:
        from pathlib import Path
        from hloc import match_features
        from hloc.utils.io import list_h5_names
        import pycolmap
        import torch
        
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        append_log_line(project_id, f"🎮 Using device: {device}")
        
        images_path = Path(paths['images_path'])
        output_path = Path(paths['project_path'])
        database_path = Path(paths['database_path'])
        
        # Get features path from previous stage
        if hloc_data and 'features_path' in hloc_data:
            features_path = Path(hloc_data['features_path'])
            feature_conf = hloc_data.get('feature_conf', {})
            if hloc_data.get('colmap_config'):
                colmap_cfg = hloc_data['colmap_config']
        else:
            features_path = output_path / 'features.h5'
            feature_conf = {}

        colmap_cfg, _ = apply_no_regression_floor(
            colmap_cfg,
            project_id=project_id,
            reason='before hloc feature matching',
        )
        
        if not features_path.exists():
            raise FileNotFoundError(f"Features file not found: {features_path}")
        
        # Generate image pairs using the resolved matcher strategy.
        pairs_path = output_path / 'pairs.txt'
        
        # Get list of images
        image_list = sorted(
            [
                f.name
                for f in images_path.iterdir()
                if f.suffix.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}
            ]
        )
        
        append_log_line(project_id, f"📊 Found {len(image_list)} images to match")
        append_log_line(project_id, f"🔗 Using {colmap_cfg['matcher_type']} matcher for neural pair generation")
        
        # Generate pairs file
        append_log_line(project_id, "📝 Generating image pairs...")
        total_pairs = generate_hloc_pairs(
            pairs_path,
            image_list,
            colmap_cfg['matcher_type'],
            colmap_cfg['matcher_params'],
        )
        append_log_line(project_id, f"🔗 Total pairs to match: {total_pairs}")
        
        feature_method = config.get('feature_method', 'aliked')
        
        if feature_method == 'superpoint':
            matcher_conf = match_features.confs['superpoint+lightglue']
        else:
            matcher_conf = match_features.confs['aliked+lightglue']
        
        append_log_line(project_id, f"⚡ Using LightGlue matcher for {feature_method.upper()} features")
        
        # Run matching
        matches_path = output_path / 'matches.h5'
        
        append_log_line(project_id, "🚀 Starting LightGlue matching...")
        
        # Update progress periodically
        update_stage_detail(project_id, 'feature_matching', 
                          text=f'Matching pairs...', 
                          subtext='LightGlue neural matching')
        
        matches_path = match_features.main(
            matcher_conf,
            pairs_path,
            feature_conf.get('output', 'feats-aliked-n16'),
            output_path
        )
        
        append_log_line(project_id, f"✅ Matches saved to {matches_path}")
        
        # Import matches into COLMAP database
        append_log_line(project_id, "📥 Importing features and matches to COLMAP database...")
        
        from hloc.triangulation import import_features, import_matches
        
        # Create fresh database if needed
        if not database_path.exists():
            db = pycolmap.Database(str(database_path))
            db.create_tables()
        
        # Import features into database
        import_features(images_path, database_path, features_path)
        append_log_line(project_id, "✅ Features imported to database")
        
        # Import matches into database  
        import_matches(images_path, database_path, pairs_path, matches_path)
        append_log_line(project_id, "✅ Matches imported to database")

        colmap_cfg = refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id)
        sync_reconstruction_framework(project_id, config, colmap_cfg, phase='matching_complete')
        
        update_state(project_id, 'feature_matching', status='completed', progress=100)
        update_stage_detail(project_id, 'feature_matching', 
                          text=f'Matched {total_pairs} pairs', 
                          subtext='LightGlue complete')
        append_log_line(project_id, f"✅ hloc LightGlue Matching completed")
        
        return colmap_cfg
        
    except Exception as e:
        import traceback
        append_log_line(project_id, f"❌ hloc matching failed: {e}")
        append_log_line(project_id, traceback.format_exc())
        append_log_line(project_id, "⚠️ Falling back to COLMAP matching...")
        # Fall back to COLMAP
        return run_feature_matching_stage(project_id, paths, config, hloc_data.get('colmap_config') if hloc_data else None)


# ===========================================================================
# COLMAP Feature Extraction & Matching (Original)
# ===========================================================================

def run_feature_extraction_stage(project_id, paths, config, colmap_config=None):
    """Run COLMAP Feature Extraction stage only."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    max_image_size_flag = get_colmap_feature_extraction_max_image_size_flag(colmap_exe)
    feature_profile = resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe)
    
    update_state(project_id, 'feature_extraction', status='running')
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: 0/{num_images}', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Extraction...")
    append_log_line(project_id, f"📊 Using optimized settings for {num_images} images")
    
    if has_cuda:
        append_log_line(project_id, "🚀 Using GPU-accelerated COLMAP for feature extraction")
    else:
        append_log_line(project_id, "⚠️ COLMAP CUDA support not detected; falling back to CPU mode")

    if max_image_size_flag == '--SiftExtraction.max_image_size':
        append_log_line(project_id, "ℹ️ Detected legacy COLMAP feature_extractor option layout")
    else:
        append_log_line(project_id, "ℹ️ Detected modern COLMAP feature_extractor option layout")

    if feature_profile['is_native_neural']:
        append_log_line(project_id, f"⚡ Using {feature_profile['description']} for feature extraction")
    
    cmd = [
        colmap_exe, 'feature_extractor',
        '--database_path', str(paths['database_path']),
        '--image_path', str(paths['images_path']),
        '--ImageReader.camera_model', config['camera_model'],
        '--ImageReader.single_camera', '1',
        '--FeatureExtraction.use_gpu', '1' if has_cuda else '0',
        max_image_size_flag, str(colmap_cfg['max_image_size']),
    ]

    if feature_profile['extractor_args']:
        cmd.extend(feature_profile['extractor_args'])

    if feature_profile['extractor_type'] == 'SIFT':
        cmd.extend([
            '--SiftExtraction.max_num_features', str(colmap_cfg['max_num_features']),
            '--SiftExtraction.first_octave', str(colmap_cfg['first_octave']),
            '--SiftExtraction.num_octaves', str(colmap_cfg['num_octaves']),
        ])

        # Add enhanced SIFT parameters for high quality modes
        sift_params = colmap_cfg.get('sift_params', {})
        for param, value in sift_params.items():
            if value is not None:
                cmd.extend([f'--SiftExtraction.{param}', str(value)])
    
    progress_tracker = {'count': 0}
    extraction_progress_log = {'last_milestone': -1}
    extraction_health = {
        'gpu_instability': False,
        'failed_images': 0,
    }
    extraction_metrics = {
        'feature_sum': 0,
        'feature_min': None,
        'feature_max': 0,
        'feature_samples': 0,
    }

    def count_featured_images(database_path):
        if not Path(database_path).exists():
            return 0
        try:
            with sqlite3.connect(str(database_path)) as conn:
                row = conn.execute('SELECT COUNT(*) FROM images').fetchone()
                return int(row[0]) if row else 0
        except sqlite3.Error as exc:
            append_log_line(project_id, f"⚠️ Could not inspect COLMAP database after feature extraction: {exc}")
            return 0

    def reset_colmap_database(database_path):
        db_path = Path(database_path)
        for candidate in (db_path, Path(f"{db_path}-shm"), Path(f"{db_path}-wal")):
            try:
                if candidate.exists():
                    candidate.unlink()
            except OSError as exc:
                append_log_line(project_id, f"⚠️ Failed to remove stale database file {candidate.name}: {exc}")

    def build_feature_extractor_cmd(use_gpu: bool):
        rebuilt = []
        skip_next = False
        for index, part in enumerate(cmd):
            if skip_next:
                skip_next = False
                continue
            if part == '--FeatureExtraction.use_gpu' and index + 1 < len(cmd):
                rebuilt.extend([part, '1' if use_gpu else '0'])
                skip_next = True
                continue
            rebuilt.append(part)
        return rebuilt

    def feature_line_handler(line):
        if num_images == 0:
            return

        line_lower = line.lower()
        if 'illegal memory access' in line_lower or 'failed to process the image' in line_lower:
            extraction_health['gpu_instability'] = True
        if 'failed to process the image' in line_lower:
            extraction_health['failed_images'] += 1

        feature_count_match = re.search(r'Features:\s+(\d+)', line, re.IGNORECASE)
        if feature_count_match:
            feature_count = int(feature_count_match.group(1))
            extraction_metrics['feature_sum'] += feature_count
            extraction_metrics['feature_samples'] += 1
            extraction_metrics['feature_max'] = max(extraction_metrics['feature_max'], feature_count)
            current_min = extraction_metrics['feature_min']
            extraction_metrics['feature_min'] = feature_count if current_min is None else min(current_min, feature_count)
        
        patterns = [
            r'Processing image \[(\d+)/(\d+)\]',
            r'Processed file \[(\d+)/(\d+)\]',
            r'Processing image (\d+)/(\d+)',
            r'Processed image (\d+)/(\d+)',
            r'Processing\s+(\d+)\s*\/\s*(\d+)',
            r'Extracting.*\s(\d+)\s*/\s*(\d+)',
            r'Image\s+(\d+)\s*\/\s*(\d+)',
            r'(\d+)\s*/\s*(\d+)\s*images?',
            r'Features\s+(\d+)\s*\/\s*(\d+)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                current = int(match.group(1))
                total = int(match.group(2))
                if total != num_images:
                    total = num_images
                if current > total:
                    current = total
                percent = int((current / total) * 100)
                details = {
                    'text': f'Images processed: {current}/{total}',
                    'current_item': current,
                    'total_items': total,
                    'item_name': f'Image {current}'
                }
                emit_stage_progress(project_id, 'feature_extraction', percent, details)
                update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
                update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {current}/{total}', subtext=None)
                should_log, progress_percent = should_emit_progress_milestone(
                    extraction_progress_log,
                    current,
                    total,
                )
                if should_log:
                    avg_features = (
                        extraction_metrics['feature_sum'] // extraction_metrics['feature_samples']
                        if extraction_metrics['feature_samples']
                        else 0
                    )
                    append_log_line(
                        project_id,
                        "🧩 Feature extraction progress: "
                        f"{current}/{total} images ({progress_percent}%) | "
                        f"avg_features={avg_features:,}",
                    )
                return
        
        if any(keyword in line.lower() for keyword in ['processed', 'processing']):
            progress_tracker['count'] += 1
            processed = min(progress_tracker['count'], num_images)
            percent = int((processed / num_images) * 100)
            details = {
                'text': f'Images processed: {processed}/{num_images}',
                'current_item': processed,
                'total_items': num_images,
                'item_name': f'Image {processed}'
            }
            emit_stage_progress(project_id, 'feature_extraction', percent, details)
            update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
            update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {processed}/{num_images}', subtext=None)
            should_log, progress_percent = should_emit_progress_milestone(
                extraction_progress_log,
                processed,
                num_images,
            )
            if should_log:
                avg_features = (
                    extraction_metrics['feature_sum'] // extraction_metrics['feature_samples']
                    if extraction_metrics['feature_samples']
                    else 0
                )
                append_log_line(
                    project_id,
                    "🧩 Feature extraction progress: "
                    f"{processed}/{num_images} images ({progress_percent}%) | "
                    f"avg_features={avg_features:,}",
                )
    
    try:
        run_command_with_logs(
            project_id,
            cmd,
            line_handler=feature_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )
    except subprocess.CalledProcessError:
        if has_cuda:
            append_log_line(project_id, "⚠️ GPU feature extraction exited with an error; resetting COLMAP database and retrying on CPU")
            reset_colmap_database(paths['database_path'])
            run_command_with_logs(
                project_id,
                build_feature_extractor_cmd(False),
                line_handler=feature_line_handler,
                raw_line_filter=should_log_subprocess_line,
            )
        else:
            raise

    extracted_image_count = count_featured_images(paths['database_path'])
    if has_cuda and (
        extraction_health['gpu_instability']
        or extraction_health['failed_images'] > 0
        or extracted_image_count < num_images
    ):
        append_log_line(
            project_id,
            "⚠️ GPU feature extraction produced incomplete results "
            f"({extracted_image_count}/{num_images} images in database, failures={extraction_health['failed_images']}); retrying on CPU",
        )
        reset_colmap_database(paths['database_path'])
        extraction_health['gpu_instability'] = False
        extraction_health['failed_images'] = 0
        progress_tracker['count'] = 0
        run_command_with_logs(
            project_id,
            build_feature_extractor_cmd(False),
            line_handler=feature_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )
        extracted_image_count = count_featured_images(paths['database_path'])
        append_log_line(project_id, f"✅ CPU feature extraction retry completed with {extracted_image_count}/{num_images} images in database")
    
    update_state(project_id, 'feature_extraction', status='completed', progress=100)
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {num_images}/{num_images}', subtext='Feature extraction complete')
    if extraction_metrics['feature_samples']:
        avg_features = extraction_metrics['feature_sum'] // extraction_metrics['feature_samples']
        append_log_line(
            project_id,
            "📈 Feature extraction summary: "
            f"images={extraction_metrics['feature_samples']}/{num_images} | "
            f"avg={avg_features:,} | "
            f"min={int(extraction_metrics['feature_min'] or 0):,} | "
            f"max={extraction_metrics['feature_max']:,}",
        )
    append_log_line(project_id, "✅ COLMAP Feature Extraction completed")
    
    return colmap_cfg


def run_feature_matching_stage(project_id, paths, config, colmap_config=None):
    """Run COLMAP Feature Matching stage only."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    colmap_cfg, _ = apply_no_regression_floor(
        colmap_cfg,
        project_id=project_id,
        reason='before COLMAP feature matching',
    )
    feature_profile = resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe)

    loop_detection_enabled = colmap_cfg['matcher_params'].get('SequentialMatching.loop_detection') == '1'
    use_gpu_matching = has_cuda
    peak_feature_count = get_peak_feature_count(paths['database_path'])
    gpu_total_vram_mb = get_gpu_total_vram_mb() if use_gpu_matching else None

    if use_gpu_matching:
        gpu_safe_match_limit = estimate_gpu_safe_match_limit(
            total_vram_mb=gpu_total_vram_mb,
            peak_feature_count=peak_feature_count,
        )
        if gpu_safe_match_limit and gpu_safe_match_limit < int(colmap_cfg['max_num_matches']):
            append_log_line(
                project_id,
                "🧠 VRAM-aware COLMAP tuning: "
                f"capping max_num_matches from {colmap_cfg['max_num_matches']} to {gpu_safe_match_limit} "
                f"(VRAM={gpu_total_vram_mb or 'unknown'} MiB, peak_features={peak_feature_count or 'unknown'})",
            )
            colmap_cfg['max_num_matches'] = gpu_safe_match_limit
    
    update_state(project_id, 'feature_matching', status='running')
    update_stage_detail(project_id, 'feature_matching', text='Matching pairs: 0/0', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Matching...")
    
    if use_gpu_matching:
        if loop_detection_enabled:
            append_log_line(project_id, "🧠 Loop-closure matching enabled; attempting GPU matcher first with automatic CPU fallback")
        else:
            append_log_line(project_id, "🚀 Using GPU-accelerated COLMAP for feature matching")
    else:
        append_log_line(project_id, "⚠️ COLMAP CUDA support not detected; falling back to CPU mode for matching")

    append_log_line(project_id, f"🔗 Using {colmap_cfg['matcher_type']} matcher")
    if feature_profile['is_native_neural']:
        append_log_line(project_id, f"⚡ Native matcher profile: {feature_profile['description']}")
    
    matching_progress = {'current': 0, 'total': 0}
    matching_progress_log = {'last_milestone': -1}
    matching_health = {
        'gpu_issue_detected': False,
        'last_gpu_issue': None,
    }
    matching_runtime = {
        'last_use_gpu': use_gpu_matching,
        'cpu_fallback_used': False,
    }
    
    matcher_cmd = f'{colmap_cfg["matcher_type"]}_matcher'
    append_log_line(project_id, f"🔧 Running {colmap_cfg['matcher_type']} matcher...")
    
    cmd = [
        colmap_exe, matcher_cmd,
        '--database_path', str(paths['database_path']),
        '--FeatureMatching.max_num_matches', str(colmap_cfg['max_num_matches']),
        '--FeatureMatching.use_gpu', '1' if use_gpu_matching else '0'
    ]

    if feature_profile['matcher_args']:
        cmd.extend(feature_profile['matcher_args'])
    
    for param, value in colmap_cfg['matcher_params'].items():
        cmd.extend([f'--{param}', value])
    
    def matching_line_handler(line):
        if (
            matching_runtime['last_use_gpu']
            and is_gpu_matching_error_text(line)
        ):
            matching_health['gpu_issue_detected'] = True
            matching_health['last_gpu_issue'] = line.strip()
            append_log_line(project_id, f"⚠️ GPU feature matching issue detected: {line.strip()}")
            return
        
        patterns = [
            r'Matching block \[(\d+)/(\d+)\]',
            r'Matching image \[(\d+)/(\d+)\]',
            r'Matching pair \[(\d+)/(\d+)\]',
            r'Processing pair (\d+)/(\d+)',
            r'Matching\s+(\d+)\s*\/\s*(\d+)',
            r'(\d+)/(\d+)\s+matches',
            r'Pair\s+(\d+)\s*\/\s*(\d+)',
            r'\[(\d+)/(\d+)\]',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                current = int(match.group(1))
                total = int(match.group(2))
                matching_progress['current'] = current
                matching_progress['total'] = total
                
                if total > 0:
                    percent = int((min(current, total) / total) * 100)
                    details = {
                        'text': f'Matching pairs: {current}/{total}',
                        'current_item': current,
                        'total_items': total,
                        'item_name': f'Pair {current}'
                    }
                    emit_stage_progress(project_id, 'feature_matching', percent, details)
                    update_state(project_id, 'feature_matching', progress=min(percent, 99), details=details)
                    update_stage_detail(project_id, 'feature_matching', text=f'Matching pairs: {current}/{total}', subtext=None)
                    should_log, progress_percent = should_emit_progress_milestone(
                        matching_progress_log,
                        current,
                        total,
                    )
                    if should_log:
                        runtime_mode = 'GPU' if matching_runtime['last_use_gpu'] else 'CPU'
                        append_log_line(
                            project_id,
                            "🔗 Feature matching progress: "
                            f"{current}/{total} units ({progress_percent}%) | "
                            f"mode={runtime_mode}",
                        )
                return
    
    def run_matching_command(command):
        run_command_with_logs(
            project_id,
            command,
            line_handler=matching_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )

    def reset_matching_health():
        matching_health['gpu_issue_detected'] = False
        matching_health['last_gpu_issue'] = None

    def build_matching_cmd(max_num_matches, use_gpu):
        rebuilt = [
            colmap_exe,
            matcher_cmd,
            '--database_path', str(paths['database_path']),
            '--FeatureMatching.max_num_matches', str(max_num_matches),
            '--FeatureMatching.use_gpu', '1' if use_gpu else '0',
        ]
        if feature_profile['matcher_args']:
            rebuilt.extend(feature_profile['matcher_args'])
        for param, value in colmap_cfg['matcher_params'].items():
            rebuilt.extend([f'--{param}', value])
        return rebuilt

    def retry_matching_on_gpu_with_backoff(reason):
        if not use_gpu_matching:
            return False

        initial_limit = int(colmap_cfg['max_num_matches'])
        retry_limits = get_gpu_retry_match_limits(initial_limit, peak_feature_count=peak_feature_count)

        if not retry_limits:
            return False

        append_log_line(project_id, f"⚠️ {reason}")

        for retry_matches in retry_limits:
            append_log_line(
                project_id,
                f"🔄 Retrying with GPU-based matching at reduced max_matches={retry_matches}...",
            )
            gpu_cmd = build_matching_cmd(retry_matches, True)
            matching_runtime['last_use_gpu'] = True
            reset_matching_health()

            try:
                run_matching_command(gpu_cmd)
            except subprocess.CalledProcessError as retry_error:
                if matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(retry_error)):
                    append_log_line(
                        project_id,
                        f"⚠️ Reduced GPU matching attempt failed at max_matches={retry_matches}",
                    )
                    continue
                raise

            verified_pairs = count_verified_matching_pairs(paths['database_path'])
            if verified_pairs > 0:
                colmap_cfg['max_num_matches'] = retry_matches
                append_log_line(
                    project_id,
                    f"✅ Reduced GPU-based matching completed successfully ({verified_pairs} verified pairs)",
                )
                return True

            if matching_health['gpu_issue_detected']:
                append_log_line(
                    project_id,
                    f"⚠️ Reduced GPU matching produced 0 verified pairs at max_matches={retry_matches}",
                )
                continue

            colmap_cfg['max_num_matches'] = retry_matches
            append_log_line(project_id, "✅ Reduced GPU-based matching completed successfully")
            return True

        return False

    def retry_matching_on_cpu(reason):
        retry_matches = get_cpu_retry_match_limit(colmap_cfg['max_num_matches'])
        append_log_line(project_id, f"⚠️ {reason}")
        append_log_line(project_id, f"🔄 Retrying with CPU-based matching (max_matches={retry_matches})...")
        cpu_cmd = build_matching_cmd(retry_matches, False)
        matching_runtime['last_use_gpu'] = False
        matching_runtime['cpu_fallback_used'] = True
        run_matching_command(cpu_cmd)
        colmap_cfg['max_num_matches'] = retry_matches
        append_log_line(project_id, "✅ CPU-based matching completed successfully")

    matching_runtime['last_use_gpu'] = use_gpu_matching
    try:
        run_matching_command(cmd)
    except subprocess.CalledProcessError as e:
        if use_gpu_matching and (matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(e))):
            if loop_detection_enabled:
                retry_matching_on_cpu("GPU loop-closure matching failed")
            elif not retry_matching_on_gpu_with_backoff("GPU feature matching failed"):
                retry_matching_on_cpu("GPU feature matching failed after reduced-match retries")
        else:
            raise

    verified_pairs = count_verified_matching_pairs(paths['database_path'])
    if use_gpu_matching and verified_pairs == 0 and matching_health['gpu_issue_detected']:
        if loop_detection_enabled:
            retry_matching_on_cpu(
                "GPU loop-closure matching produced 0 verified pairs after a matcher initialization failure"
            )
        elif not retry_matching_on_gpu_with_backoff(
            "GPU feature matching produced 0 verified pairs after a matcher initialization failure"
        ):
            retry_matching_on_cpu(
                "GPU feature matching produced 0 verified pairs after reduced-match retries"
            )
        verified_pairs = count_verified_matching_pairs(paths['database_path'])

    if verified_pairs == 0:
        append_log_line(project_id, "❌ COLMAP Feature Matching produced 0 verified pairs")
        raise RuntimeError("COLMAP feature matching produced 0 verified pairs")

    if loop_detection_enabled and use_gpu_matching:
        if matching_runtime['cpu_fallback_used']:
            append_log_line(project_id, "🧠 Loop-closure matching final mode: CPU fallback")
        elif matching_runtime['last_use_gpu']:
            append_log_line(project_id, "🧠 Loop-closure matching final mode: GPU")
    
    update_state(project_id, 'feature_matching', status='completed', progress=100)
    current = matching_progress['current'] or matching_progress['total']
    total_pairs = matching_progress['total'] or matching_progress['current']
    colmap_cfg = refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id)
    colmap_cfg = run_orbit_safe_bridge_recovery_matching_pass(
        project_id,
        paths,
        config,
        colmap_exe,
        colmap_cfg,
        has_cuda,
        line_handler=matching_line_handler,
    )
    sync_reconstruction_framework(project_id, config, colmap_cfg, phase='matching_complete')
    if total_pairs:
        update_stage_detail(
            project_id,
            'feature_matching',
            text=f'Matching pairs: {min(current, total_pairs)}/{total_pairs}',
            subtext=f'Feature matching complete ({verified_pairs} verified pairs)',
        )
    else:
        update_stage_detail(
            project_id,
            'feature_matching',
            text='Feature matching complete',
            subtext=f'{verified_pairs} verified pairs',
        )
    append_log_line(project_id, f"✅ COLMAP Feature Matching completed ({verified_pairs} verified pairs)")
    
    return colmap_cfg


def try_run_pycolmap_global_mapping(project_id, paths, config, colmap_cfg, num_images):
    pycolmap = get_pycolmap_module()
    if not pycolmap_supports_global_mapping():
        append_log_line(project_id, "⚠️ Experimental pycolmap global mapping requested, but this environment does not provide pycolmap.global_mapping")
        return False

    try:
        append_log_line(project_id, "🧪 Experimental backend: pycolmap.global_mapping")
        update_stage_detail(
            project_id,
            'sparse_reconstruction',
            text='Initializing experimental pycolmap global mapping...',
            subtext=f'{num_images} images',
        )
        emit_stage_progress(
            project_id,
            'sparse_reconstruction',
            5,
            {
                'text': 'Initializing experimental pycolmap global mapping',
                'current_item': 5,
                'total_items': 100,
                'item_name': 'initializing',
                'sfm_engine': 'glomap',
                'sfm_backend': 'pycolmap',
            },
        )

        bundle_adjustment = pycolmap.BundleAdjustmentOptions()
        for attr in ('refine_focal_length', 'refine_principal_point', 'refine_extra_params'):
            if hasattr(bundle_adjustment, attr):
                setattr(bundle_adjustment, attr, False)
        if hasattr(bundle_adjustment, 'use_gpu'):
            setattr(bundle_adjustment, 'use_gpu', True)
        if hasattr(bundle_adjustment, 'gpu_index'):
            setattr(bundle_adjustment, 'gpu_index', 0)

        mapper_options = pycolmap.GlobalMapperOptions()
        if hasattr(mapper_options, 'bundle_adjustment'):
            mapper_options.bundle_adjustment = bundle_adjustment
        if hasattr(mapper_options, 'num_threads'):
            mapper_options.num_threads = os.cpu_count() or 8
        if hasattr(mapper_options, 'min_num_matches'):
            mapper_options.min_num_matches = int(colmap_cfg['min_num_matches'])

        if hasattr(pycolmap, 'GlobalPipelineOptions'):
            pipeline_options = pycolmap.GlobalPipelineOptions()
            if hasattr(pipeline_options, 'mapper'):
                pipeline_options.mapper = mapper_options
        else:
            pipeline_options = mapper_options

        if config.get('fast_sfm', False):
            for target in (mapper_options, pipeline_options):
                if hasattr(target, 'ba_iteration_num'):
                    setattr(target, 'ba_iteration_num', 2)
                if hasattr(target, 'retriangulation_iteration_num'):
                    setattr(target, 'retriangulation_iteration_num', 0)

        append_log_line(project_id, f"🔧 pycolmap.global_mapping on {num_images} images with {os.cpu_count() or 8} threads")

        pycolmap.global_mapping(
            str(paths['database_path']),
            str(paths['images_path']),
            str(paths['sparse_path']),
            pipeline_options,
        )

        emit_stage_progress(
            project_id,
            'sparse_reconstruction',
            95,
            {
                'text': 'pycolmap global mapping finished',
                'current_item': 95,
                'total_items': 100,
                'item_name': 'finalizing',
                'sfm_engine': 'glomap',
                'sfm_backend': 'pycolmap',
            },
        )
        append_log_line(project_id, "✅ pycolmap.global_mapping completed")
        return True
    except Exception as exc:
        append_log_line(project_id, f"⚠️ pycolmap.global_mapping failed, falling back to CLI global mapper: {exc}")
        logger.warning("pycolmap.global_mapping failed for %s: %s", project_id, exc)
        return False


def run_sparse_reconstruction_stage(project_id, paths, config, colmap_config=None):
    """Run Sparse Reconstruction stage using GLOMAP (fast) or COLMAP (classic)."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    colmap_cfg, _ = apply_no_regression_floor(
        colmap_cfg,
        project_id=project_id,
        reason='before sparse reconstruction',
    )
    colmap_cfg = refine_orbit_safe_profile_from_geometry(paths, colmap_cfg, project_id)
    sync_reconstruction_framework(project_id, config, colmap_cfg, phase='sparse_reconstruction')
    
    sfm_engine = normalize_sfm_engine(config.get('sfm_engine', 'glomap'))
    sfm_backend = normalize_sfm_backend(config.get('sfm_backend'))
    global_backend = resolve_global_sfm_backend(colmap_exe) if sfm_engine == 'glomap' else None
    use_global_sfm = global_backend is not None
    use_legacy_glomap = global_backend is not None and global_backend['mode'] == 'legacy_glomap'
    use_fastmap = sfm_engine == 'fastmap' and FASTMAP_PATH is not None
    use_pycolmap_global = (
        sfm_backend == 'pycolmap'
        and use_global_sfm
        and not use_legacy_glomap
    )
    fastmap_temp_dir = None  # Will be set if using FastMap

    prefer_incremental_sfm, incremental_reason = should_prefer_incremental_sfm(
        config,
        paths,
        num_images,
    )
    if use_global_sfm and prefer_incremental_sfm:
        use_global_sfm = False
        use_legacy_glomap = False
        use_pycolmap_global = False
        append_log_line(project_id, f"🔁 Falling back from global SfM to COLMAP incremental SfM: {incremental_reason}")
    
    update_state(project_id, 'sparse_reconstruction', status='running')
    update_stage_detail(project_id, 'sparse_reconstruction', text=f'Initializing...', subtext=f'{num_images} images')
    
    if use_fastmap:
        import sys
        import shutil
        import tempfile
        append_log_line(project_id, "⚡ Running FastMap Structure-from-Motion (First-Order Optimization)")
        append_log_line(project_id, f"🎯 GPU-native SfM for {num_images} images (best for dense coverage)")
        
        # FastMap requires output_dir to NOT exist - create unique path then remove it
        fastmap_temp_dir = Path(tempfile.mkdtemp(prefix='fastmap_'))
        shutil.rmtree(fastmap_temp_dir)  # Remove so FastMap can create it
        
        cmd = [
            sys.executable or 'python3',
            FASTMAP_PATH,
            '--database', str(paths['database_path']),
            '--image_dir', str(paths['images_path']),
            '--output_dir', str(fastmap_temp_dir),
            '--headless'
        ]
        
        try:
            import torch
            if torch.cuda.is_available():
                cmd.extend(['--device', 'cuda:0'])
                append_log_line(project_id, "🎮 CUDA acceleration enabled")
        except ImportError:
            pass
        
        append_log_line(project_id, f"🔧 FastMap path: {FASTMAP_PATH}")
        
    elif use_global_sfm:
        append_log_line(project_id, f"🚀 Running {global_backend['label']}")
        append_log_line(project_id, f"⚡ Global SfM mapper for {num_images} images")

        cmd = [
            *global_backend['command'],
            '--database_path', str(paths['database_path']),
            '--image_path', str(paths['images_path']),
            '--output_path', str(paths['sparse_path'])
        ]
        
        if has_cuda:
            cmd.extend([
                '--GlobalPositioning.use_gpu', '1',
                '--GlobalPositioning.gpu_index', '0',
                '--BundleAdjustment.use_gpu', '1',
                '--BundleAdjustment.gpu_index', '0',
            ])
            append_log_line(project_id, "🚀 Global SfM GPU acceleration enabled (Global Positioning + Bundle Adjustment)")
        
        fast_sfm = config.get('fast_sfm', False)
        if fast_sfm:
            cmd.extend([
                '--ba_iteration_num', '2',
                '--retriangulation_iteration_num', '0',
            ])
            append_log_line(project_id, "⚡ Fast SfM mode: reduced iterations for speed")

        if use_legacy_glomap:
            append_log_line(project_id, f"🔧 Legacy GLOMAP path: {GLOMAP_PATH}")
        else:
            append_log_line(project_id, f"🔧 Using COLMAP executable for global mapper: {colmap_exe}")
        
    else:
        if sfm_engine == 'glomap' and global_backend is None:
            append_log_line(project_id, "⚠️ Global SfM backend not found, falling back to COLMAP incremental mapper")
        
        append_log_line(project_id, "🔄 Running COLMAP Incremental Sparse Reconstruction...")
        append_log_line(project_id, f"🏗️ Optimized mapper settings for {num_images} images")
        
        cmd = [
            colmap_exe, 'mapper',
            '--database_path', str(paths['database_path']),
            '--image_path', str(paths['images_path']),
            '--output_path', str(paths['sparse_path']),
            '--Mapper.min_num_matches', str(colmap_cfg['min_num_matches']),
            '--Mapper.min_model_size', str(colmap_cfg['min_model_size']),
            '--Mapper.max_num_models', str(colmap_cfg['max_num_models']),
            '--Mapper.init_num_trials', str(colmap_cfg['init_num_trials']),
            '--Mapper.max_extra_param', str(colmap_cfg['max_extra_param']),
            '--Mapper.num_threads', str(os.cpu_count() or 8)
        ]

        for param, value in colmap_cfg.get('mapper_params', {}).items():
            cmd.extend([f'--{param}', str(value)])
        
        if has_cuda:
            cmd.extend([
                '--Mapper.ba_use_gpu', '1',
                '--Mapper.ba_gpu_index', '0'
            ])
            append_log_line(project_id, "🚀 GPU-enabled COLMAP detected - Using GPU for Bundle Adjustment")
        else:
            append_log_line(project_id, "ℹ️ Using CPU-only COLMAP")
        
        append_log_line(project_id, f"🔧 Using {os.cpu_count() or 8} CPU threads for mapper")
    
    # GLOMAP has 8 main sub-stages with approximate progress weights
    glomap_stages = {
        'preprocessing': {'progress': 5, 'label': '🔧 Preprocessing', 'icon': '🔧'},
        'view_graph_calibration': {'progress': 10, 'label': '📊 View Graph Calibration', 'icon': '📊'},
        'relative_pose': {'progress': 20, 'label': '📐 Relative Pose Estimation', 'icon': '📐'},
        'rotation_averaging': {'progress': 35, 'label': '🔄 Rotation Averaging', 'icon': '🔄'},
        'track_establishment': {'progress': 50, 'label': '🔗 Track Establishment', 'icon': '🔗'},
        'global_positioning': {'progress': 65, 'label': '🌍 Global Positioning', 'icon': '🌍'},
        'bundle_adjustment': {'progress': 85, 'label': '⚡ Bundle Adjustment', 'icon': '⚡'},
        'retriangulation': {'progress': 92, 'label': '📐 Retriangulation', 'icon': '📐'},
        'postprocessing': {'progress': 98, 'label': '🏁 Postprocessing', 'icon': '🏁'},
    }
    
    sparse_tracker = {
        'registered': 0,
        'current_glomap_stage': None,
        'last_progress': 0,
        'ba_iteration': 0,
        'ba_total': 3,  # Default BA iterations
        'last_registration_milestone': -1,
        'last_ba_milestone': -1,
    }
    
    fastmap_stages = {
        'focal_estimation': {'progress': 5, 'label': '🔍 Focal Length Estimation'},
        'fundamental': {'progress': 15, 'label': '📐 Fundamental Matrix'},
        'decompose': {'progress': 25, 'label': '🧩 Essential Decomposition'},
        'rotation': {'progress': 40, 'label': '🔄 Global Rotation'},
        'translation': {'progress': 55, 'label': '📍 Global Translation'},
        'tracks': {'progress': 65, 'label': '🔗 Track Building'},
        'epipolar': {'progress': 80, 'label': '⚡ Epipolar Adjustment'},
        'sparse': {'progress': 92, 'label': '🏗️ Sparse Reconstruction'},
        'output': {'progress': 98, 'label': '💾 Writing Results'},
    }
    
    def sparse_line_handler(line):
        if num_images == 0:
            return
        
        line_lower = line.lower()
        line_stripped = line.strip()
        
        if use_fastmap:
            fastmap_patterns = [
                ('focal_estimation', r'(estimating focal|focal length)'),
                ('fundamental', r'(fundamental matrix|estimate fundamental)'),
                ('decompose', r'(decompos|essential matrix)'),
                ('rotation', r'(global rotation|rotation averaging)'),
                ('translation', r'(global translation|translation estimation)'),
                ('tracks', r'(build.*track|track.*build|establishing track)'),
                ('epipolar', r'(epipolar adjustment|epipolar optimization)'),
                ('sparse', r'(sparse reconstruction|triangulat)'),
                ('output', r'(write|writing|output|saving)'),
            ]
            
            for stage_key, pattern in fastmap_patterns:
                if re.search(pattern, line_lower):
                    stage_info = fastmap_stages[stage_key]
                    progress = stage_info['progress']
                    
                    append_log_line(project_id, f"[FastMap] {stage_info['label']}")
                    
                    details = {
                        'text': stage_info['label'],
                        'current_item': progress,
                        'total_items': 100,
                        'item_name': stage_key,
                        'fastmap_stage': stage_key,
                        'sfm_engine': 'fastmap'
                    }
                    emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                    update_state(project_id, 'sparse_reconstruction', progress=progress, details=details)
                    update_stage_detail(project_id, 'sparse_reconstruction', 
                                      text=stage_info['label'], 
                                      subtext=f'FastMap - {num_images} images')
                    return
            
            return
        
        if use_global_sfm:
            # Detect global mapper sub-stages from output. Legacy GLOMAP and COLMAP global_mapper
            # currently use compatible stage wording, so one parser can cover both.
            stage_patterns = [
                ('preprocessing', r'running preprocessing'),
                ('view_graph_calibration', r'running view graph calibration'),
                ('relative_pose', r'(running relative pose estimation|estimating relative pose)'),
                ('rotation_averaging', r'running rotation averaging'),
                ('track_establishment', r'(establishing tracks|track estimation)'),
                ('global_positioning', r'running global positioning'),
                ('bundle_adjustment', r'running bundle adjustment'),
                ('retriangulation', r'running retriangulation'),
                ('postprocessing', r'running postprocessing'),
            ]
            
            for stage_key, pattern in stage_patterns:
                if re.search(pattern, line_lower):
                    previous_stage = sparse_tracker.get('current_glomap_stage')
                    sparse_tracker['current_glomap_stage'] = stage_key
                    stage_info = glomap_stages[stage_key]
                    progress = stage_info['progress']
                    
                    # Log the stage transition
                    if previous_stage != stage_key:
                        append_log_line(project_id, f"[GLOMAP] {stage_info['label']}")
                    
                    details = {
                        'text': stage_info['label'],
                        'current_item': progress,
                        'total_items': 100,
                        'item_name': stage_key,
                        'glomap_stage': stage_key,
                        'sfm_engine': 'glomap'
                    }
                    emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                    update_state(project_id, 'sparse_reconstruction', progress=progress, details=details)
                    update_stage_detail(project_id, 'sparse_reconstruction', 
                                      text=stage_info['label'], 
                                      subtext=f'GLOMAP - {num_images} images')
                    sparse_tracker['last_progress'] = progress
                    return
            
            # Parse percentage progress from relative pose estimation
            relpose_match = re.search(r'estimating relative pose[:\s]*(\d+)%', line_lower)
            if relpose_match:
                rel_percent = int(relpose_match.group(1))
                # Map 0-100% of relative pose to 10-20% overall progress
                progress = 10 + int(rel_percent * 0.1)
                details = {
                    'text': f'📐 Relative Pose: {rel_percent}%',
                    'current_item': rel_percent,
                    'total_items': 100,
                    'item_name': f'{rel_percent}%',
                    'glomap_stage': 'relative_pose',
                    'sfm_engine': 'glomap'
                }
                emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                update_state(project_id, 'sparse_reconstruction', progress=progress, details=details)
                update_stage_detail(project_id, 'sparse_reconstruction', 
                                  text=f'📐 Relative Pose Estimation: {rel_percent}%', 
                                  subtext=f'GLOMAP - {num_images} images')
                return
            
            # Parse track establishment progress (e.g., "Establishing tracks 1234 / 5678")
            track_match = re.search(r'establishing tracks\s*(\d+)\s*/\s*(\d+)', line_lower)
            if track_match:
                current_track = int(track_match.group(1))
                total_tracks = int(track_match.group(2))
                track_percent = min(100, int((current_track / max(total_tracks, 1)) * 100))
                # Map track progress to 50-65% overall
                progress = 50 + int(track_percent * 0.15)
                details = {
                    'text': f'🔗 Tracks: {current_track}/{total_tracks}',
                    'current_item': current_track,
                    'total_items': total_tracks,
                    'item_name': f'Track {current_track}',
                    'glomap_stage': 'track_establishment',
                    'sfm_engine': 'glomap'
                }
                emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                update_state(project_id, 'sparse_reconstruction', progress=progress, details=details)
                update_stage_detail(project_id, 'sparse_reconstruction', 
                                  text=f'🔗 Track Establishment: {current_track}/{total_tracks}', 
                                  subtext=f'GLOMAP - {track_percent}%')
                return
            
            # Parse bundle adjustment iterations
            ba_match = re.search(r'global bundle adjustment iteration\s*(\d+)\s*/\s*(\d+)', line_lower)
            if ba_match:
                ba_current = int(ba_match.group(1))
                ba_total = int(ba_match.group(2))
                sparse_tracker['ba_iteration'] = ba_current
                sparse_tracker['ba_total'] = ba_total
                ba_percent = int((ba_current / max(ba_total, 1)) * 100)
                # Map BA progress to 65-92% overall
                progress = 65 + int(ba_percent * 0.27)
                details = {
                    'text': f'⚡ Bundle Adjustment: {ba_current}/{ba_total}',
                    'current_item': ba_current,
                    'total_items': ba_total,
                    'item_name': f'Iteration {ba_current}',
                    'glomap_stage': 'bundle_adjustment',
                    'sfm_engine': 'glomap'
                }
                emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                update_state(project_id, 'sparse_reconstruction', progress=progress, details=details)
                update_stage_detail(project_id, 'sparse_reconstruction', 
                                  text=f'⚡ Bundle Adjustment: Iteration {ba_current}/{ba_total}', 
                                  subtext=f'GLOMAP - {ba_percent}%')
                ba_log_state = {'last_milestone': sparse_tracker.get('last_ba_milestone', -1)}
                should_log, _ = should_emit_progress_milestone(
                    ba_log_state,
                    ba_current,
                    ba_total,
                    percent_step=25,
                )
                sparse_tracker['last_ba_milestone'] = ba_log_state['last_milestone']
                if should_log:
                    append_log_line(project_id, f"[GLOMAP] Bundle Adjustment {ba_current}/{ba_total}")
                return
            
            # Parse Loading Image Pair progress
            pair_match = re.search(r'loading image pair\s*(\d+)\s*/\s*(\d+)', line_lower)
            if pair_match:
                current_pair = int(pair_match.group(1))
                total_pairs = int(pair_match.group(2))
                pair_percent = min(100, int((current_pair / max(total_pairs, 1)) * 100))
                # This happens during preprocessing, map to 0-5%
                progress = min(5, int(pair_percent * 0.05))
                if current_pair % 500 == 0 or current_pair == total_pairs:  # Update every 500 pairs
                    details = {
                        'text': f'🔧 Loading pairs: {current_pair}/{total_pairs}',
                        'current_item': current_pair,
                        'total_items': total_pairs,
                        'item_name': f'Pair {current_pair}',
                        'glomap_stage': 'preprocessing',
                        'sfm_engine': 'glomap'
                    }
                    emit_stage_progress(project_id, 'sparse_reconstruction', progress, details)
                    update_stage_detail(project_id, 'sparse_reconstruction', 
                                      text=f'🔧 Loading Image Pairs: {current_pair}/{total_pairs}', 
                                      subtext=f'GLOMAP - Preprocessing')
                return
            
        # === COLMAP-specific patterns (fallback) ===
        else:
            # Patterns for COLMAP progress tracking
            patterns = [
                r'Registering image #(\d+)',
                r'Registered image #(\d+)',
                r'Processing image (\d+)/(\d+)',
                r'Reconstruction: (\d+)/(\d+)',
                r'Bundle adjustment: (\d+) images',
                r'Image #(\d+)',
                r'(\d+) images registered',
                r'Registering\s+(\d+)\s*/\s*(\d+)',
            ]
            
            for pattern in patterns:
                match = re.search(pattern, line, re.IGNORECASE)
                if match:
                    if len(match.groups()) == 2:
                        current = int(match.group(1))
                        total = int(match.group(2))
                        if total != num_images:
                            total = num_images
                        if current > total:
                            current = total
                    else:
                        sparse_tracker['registered'] += 1
                        current = min(sparse_tracker['registered'], num_images)
                        total = num_images
                    
                    percent = int((current / total) * 100)
                    details = {
                        'text': f'Images registered: {current}/{total}',
                        'current_item': current,
                        'total_items': total,
                        'item_name': f'Image {current}',
                        'sfm_engine': 'colmap'
                    }
                    emit_stage_progress(project_id, 'sparse_reconstruction', percent, details)
                    update_state(project_id, 'sparse_reconstruction', progress=min(percent, 99), details=details)
                    update_stage_detail(project_id, 'sparse_reconstruction', 
                                      text=f'Images registered: {current}/{total}', 
                                      subtext='COLMAP')
                    registration_log_state = {
                        'last_milestone': sparse_tracker.get('last_registration_milestone', -1)
                    }
                    should_log, progress_percent = should_emit_progress_milestone(
                        registration_log_state,
                        current,
                        total,
                    )
                    sparse_tracker['last_registration_milestone'] = registration_log_state['last_milestone']
                    if should_log:
                        append_log_line(
                            project_id,
                            f"[COLMAP] Registration progress: {current}/{total} images ({progress_percent}%)",
                        )
                    return
    
    pycolmap_completed = False
    if use_pycolmap_global:
        pycolmap_completed = try_run_pycolmap_global_mapping(
            project_id,
            paths,
            config,
            colmap_cfg,
            num_images,
        )

    if not pycolmap_completed:
        run_command_with_logs(
            project_id,
            cmd,
            line_handler=sparse_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )
    
    # FastMap outputs to temp dir - move to sparse_path/0/
    if use_fastmap and fastmap_temp_dir is not None:
        import shutil
        fastmap_output = fastmap_temp_dir / 'sparse' / '0'
        target_path = paths['sparse_path'] / '0'
        
        if fastmap_output.exists():
            # Ensure target directory exists
            target_path.mkdir(parents=True, exist_ok=True)
            
            # Move all files from FastMap output to target
            for item in fastmap_output.iterdir():
                dest = target_path / item.name
                if dest.exists():
                    if dest.is_dir():
                        shutil.rmtree(dest)
                    else:
                        dest.unlink()
                shutil.move(str(item), str(dest))
            
            append_log_line(project_id, f"📁 Moved FastMap output to {target_path}")
        else:
            append_log_line(project_id, f"⚠️ FastMap output not found at {fastmap_output}")
        
        # Cleanup temp directory
        try:
            shutil.rmtree(fastmap_temp_dir)
            append_log_line(project_id, "🧹 Cleaned up FastMap temp directory")
        except Exception as e:
            append_log_line(project_id, f"⚠️ Could not cleanup temp dir: {e}")
    
    update_state(project_id, 'sparse_reconstruction', status='completed', progress=100)
    registered = sparse_tracker['registered'] if sparse_tracker['registered'] else num_images
    if use_fastmap:
        engine_name = "FastMap"
    elif use_global_sfm:
        if use_pycolmap_global and pycolmap_completed:
            engine_name = "pycolmap Global Mapper"
        else:
            engine_name = "Legacy GLOMAP" if use_legacy_glomap else "COLMAP Global Mapper"
    else:
        engine_name = "COLMAP"
    update_stage_detail(project_id, 'sparse_reconstruction', text=f'Images registered: {min(registered, num_images)}/{num_images}', subtext=f'{engine_name} reconstruction complete')
    append_log_line(project_id, f"✅ Sparse Reconstruction completed using {engine_name}")
    sparse_summary = report_sparse_model_coverage(project_id, paths, config, colmap_cfg, num_images)
    if sparse_summary:
        colmap_cfg['last_sparse_summary'] = dict(sparse_summary)
        colmap_cfg['no_regression_floor'] = merge_no_regression_floors(
            colmap_cfg.get('no_regression_floor'),
            capture_no_regression_floor(colmap_cfg),
        )

    if should_run_boundary_frame_densification(config, colmap_cfg, sparse_summary, paths):
        densified_result = run_boundary_frame_densification_recovery(
            project_id,
            paths,
            config,
            colmap_cfg,
        )
        if densified_result is not None:
            return densified_result

    densified_overlap_retry_pass = build_densified_overlap_retry_pass(paths, colmap_cfg, sparse_summary)
    if densified_overlap_retry_pass:
        overlap_plan = densified_overlap_retry_pass.get('overlap_plan') or {}
        colmap_cfg['densified_overlap_retry_attempted'] = True
        colmap_cfg['recovery_matching_pass'] = densified_overlap_retry_pass
        append_log_line(
            project_id,
            "🧠 Sparse reconstruction is still split after boundary densification; "
            "running a data-driven overlap retry with the standard sequential matcher",
        )
        append_log_line(
            project_id,
            "🧠 Densified-set overlap retry: "
            f"{overlap_plan.get('current_overlap', '?')}→{overlap_plan.get('target_overlap', '?')} "
            f"(cap={overlap_plan.get('overlap_cap', '?')}, boost={overlap_plan.get('overlap_boost', '?')})",
        )
        clear_sparse_reconstruction_outputs(paths['sparse_path'])
        colmap_cfg = run_orbit_safe_bridge_recovery_matching_pass(
            project_id,
            paths,
            config,
            colmap_exe,
            colmap_cfg,
            has_cuda,
        )
        return run_sparse_reconstruction_stage(project_id, paths, config, colmap_cfg)

    if should_run_final_loop_detection_recovery(colmap_cfg, sparse_summary, num_images):
        final_recovery_matching_pass = colmap_cfg.get('final_recovery_matching_pass')
        colmap_cfg['loop_detection_fallback_attempted'] = True
        colmap_cfg['recovery_matching_pass'] = final_recovery_matching_pass
        colmap_cfg['final_recovery_matching_pass'] = None

        append_log_line(
            project_id,
            "🧠 Sparse reconstruction is still split after overlap-only recovery; "
            "running final loop-detection fallback and retrying sparse reconstruction once",
        )
        clear_sparse_reconstruction_outputs(paths['sparse_path'])
        colmap_cfg = run_orbit_safe_bridge_recovery_matching_pass(
            project_id,
            paths,
            config,
            colmap_exe,
            colmap_cfg,
            has_cuda,
        )
        return run_sparse_reconstruction_stage(project_id, paths, config, colmap_cfg)
    
    return colmap_cfg


def run_model_conversion_stage(project_id, paths):
    """Run Model Conversion stage (select best sparse model)."""
    update_state(project_id, 'model_conversion', status='running')
    update_stage_detail(project_id, 'model_conversion', text='Organizing sparse model...', subtext=None)
    append_log_line(project_id, "🔄 Organizing Model Structure...")
    
    sparse_model_path = select_best_sparse_model(paths['sparse_path'], project_id)
    
    if not sparse_model_path:
        raise Exception("No sparse reconstruction found")
    
    update_state(project_id, 'model_conversion', status='completed', progress=100)
    update_stage_detail(project_id, 'model_conversion', text='Model organization complete', subtext=None)
    append_log_line(project_id, "✅ Model Organization completed")
    
    return sparse_model_path


def run_colmap_pipeline(project_id, paths, config, processing_start_time, time_estimate, time_estimator, from_stage='feature_extraction'):
    """Run real COLMAP + OpenSplat pipeline from specified stage."""
    try:
        # Set up environment variables for libtorch and headless operation
        libtorch_path = Path('../libtorch')
        env = os.environ.copy()
        env['LD_LIBRARY_PATH'] = f"{libtorch_path}/lib:{env.get('LD_LIBRARY_PATH', '')}"
        # Force headless operation to avoid GUI errors
        env['QT_QPA_PLATFORM'] = 'offscreen'
        env['DISPLAY'] = ''

        # Count images to determine optimal COLMAP configuration
        images_path = paths['images_path']
        num_images = len([f for f in os.listdir(images_path)
                         if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff'))])

        # Get optimized COLMAP configuration with quality mode
        quality_mode = config.get('quality_mode', 'balanced')

        # Extract custom parameters if in custom mode
        custom_params = None
        if quality_mode == 'custom':
            custom_params = {
                # SIFT Feature Parameters
                'peak_threshold': config.get('peak_threshold'),
                'edge_threshold': config.get('edge_threshold'),
                'max_num_orientations': config.get('max_num_orientations'),
                # Feature Extraction & Matching
                'max_num_features': config.get('max_num_features'),
                'max_num_matches': config.get('max_num_matches'),
                'sequential_overlap': config.get('sequential_overlap'),
                # Mapper (Reconstruction)
                'min_num_matches': config.get('min_num_matches'),
                'max_num_models': config.get('max_num_models'),
                'init_num_trials': config.get('init_num_trials')
            }

        orbit_safe_policy = resolve_orbit_safe_policy(paths, config, num_images)
        orbit_safe_mode = orbit_safe_policy is not None
        orbit_safe_reason = orbit_safe_policy['reason'] if orbit_safe_policy else None
        if project_id and orbit_safe_mode:
            append_log_line(project_id, f"🛡️ Orbit-safe reconstruction policy enabled: {orbit_safe_reason}")

        colmap_config = get_colmap_config(
            num_images,
            project_id,
            quality_mode,
            custom_params,
            normalize_matcher_type(config.get('matcher_type')),
            orbit_safe_mode,
            orbit_safe_policy,
        )

        # Define COLMAP stage order for from_stage logic
        colmap_stages = ['feature_extraction', 'feature_matching', 'sparse_reconstruction', 'model_conversion']
        start_index = colmap_stages.index(from_stage) if from_stage in colmap_stages else 0

        # Decide whether neural features should run via native COLMAP or hloc.
        feature_method = normalize_feature_method(config.get('feature_method', 'sift'))
        requested_matcher_type = normalize_matcher_type(config.get('matcher_type'))
        native_feature_profile = resolve_colmap_feature_pipeline_profile(
            config,
            colmap_config,
            get_colmap_executable(),
        )
        use_native_colmap_neural = native_feature_profile['is_native_neural']
        use_hloc = False

        if feature_method == 'superpoint':
            use_hloc = HLOC_AVAILABLE and requested_matcher_type != 'vocab_tree'
            if requested_matcher_type == 'vocab_tree':
                append_log_line(
                    project_id,
                    "ℹ️ SuperPoint stays on native COLMAP fallback for vocab-tree mode because hloc pair generation does not support retrieval yet",
                )
        elif feature_method == 'aliked':
            if use_native_colmap_neural:
                append_log_line(
                    project_id,
                    f"⚡ Using {native_feature_profile['description']} in the native COLMAP pipeline",
                )
            elif HLOC_AVAILABLE and requested_matcher_type != 'vocab_tree':
                use_hloc = True
                append_log_line(
                    project_id,
                    "ℹ️ Native COLMAP ALIKED/LightGlue is unavailable in this environment; falling back to hloc",
                )
            else:
                append_log_line(
                    project_id,
                    "ℹ️ Native COLMAP ALIKED support is unavailable; falling back to classic COLMAP SIFT settings",
                )
        
        hloc_data = None  # Will store hloc feature data for matching stage

        # 1. Feature Extraction (skip if starting from later stage)
        if start_index <= colmap_stages.index('feature_extraction'):
            if use_hloc:
                append_log_line(project_id, f"⚡ Using hloc neural features ({feature_method.upper()}) - 10-20x faster")
                hloc_data = run_hloc_feature_extraction_stage(project_id, paths, config, colmap_config)
                if isinstance(hloc_data, dict) and 'features_path' in hloc_data:
                    colmap_config = hloc_data.get('colmap_config', colmap_config)
                else:
                    # Fallback occurred, hloc_data is actually colmap_config
                    colmap_config = hloc_data
                    hloc_data = None
                    use_hloc = False
            else:
                colmap_config = run_feature_extraction_stage(project_id, paths, config, colmap_config)

        # 2. Feature Matching (skip if starting from later stage)
        if start_index <= colmap_stages.index('feature_matching'):
            if use_hloc and hloc_data:
                append_log_line(project_id, "⚡ Using LightGlue neural matching - 4-10x faster")
                colmap_config = run_hloc_feature_matching_stage(project_id, paths, config, hloc_data)
            else:
                colmap_config = run_feature_matching_stage(project_id, paths, config, colmap_config)

        # 3. Sparse Reconstruction (skip if starting from later stage)
        if start_index <= colmap_stages.index('sparse_reconstruction'):
            colmap_config = run_sparse_reconstruction_stage(project_id, paths, config, colmap_config)

        # 4. Model Conversion (skip if starting from later stage)
        if start_index <= colmap_stages.index('model_conversion'):
            run_model_conversion_stage(project_id, paths)

        # 5. Enhanced OpenSplat Training
        update_state(project_id, 'gaussian_splatting', status='running')

        # Get high-quality OpenSplat configuration
        quality_mode = config.get('quality_mode', 'balanced')

        # Pass config as custom_params if in custom mode
        custom_params = config if quality_mode == 'custom' else None
        opensplat_config = get_opensplat_config(quality_mode, num_images, custom_params)

        # Use custom iterations if provided, otherwise use quality config
        enhanced_iterations = opensplat_config['iterations']
        if quality_mode == 'custom':
            append_log_line(project_id, f"🔧 Using custom quality mode: {enhanced_iterations} iterations")
        else:
            append_log_line(project_id, f"🎯 Using {quality_mode} quality mode: {enhanced_iterations} iterations")

        # Calculate progress and remaining time
        elapsed = time.time() - processing_start_time
        estimated_remaining = max(0, time_estimate.total_seconds - elapsed)
        progress_pct = min(95, int((elapsed / time_estimate.total_seconds) * 100))

        append_log_line(project_id, f"⏱️  Progress: {progress_pct}% | Remaining: ~{time_estimator.format_time_display(estimated_remaining)}")

        update_stage_detail(project_id, 'gaussian_splatting',
                          text=f'Training iterations: 0/{enhanced_iterations}',
                          subtext=f'Quality: {quality_mode.title()}')
        append_log_line(project_id, "🔄 Running High-Quality Gaussian Splatting Training...")

        opensplat_binary = app_config.OPENSPLAT_BINARY_PATH
        if opensplat_binary.is_dir():
            potential_binary = opensplat_binary / 'opensplat'
            if potential_binary.exists():
                opensplat_binary = potential_binary

        if not opensplat_binary.exists():
            raise Exception(f"OpenSplat binary not found at {opensplat_binary}")

        opensplat_working_dir = opensplat_binary.parent if opensplat_binary.is_file() else opensplat_binary

        output_ply = paths['results_path'] / f"{project_id}_{quality_mode}_{enhanced_iterations}iter.ply"

        # Enhanced OpenSplat command with quality parameters
        # OpenSplat expects a COLMAP project folder with images/ and sparse/0/
        cmd = [
            str(opensplat_binary),
            str(paths['project_path'].absolute()),
            '-n', str(enhanced_iterations),
            '--output', str(output_ply.absolute())
        ]

        # Check for crop size (Patch-based training)
        crop_size = config.get('crop_size', 0)
        if crop_size > 0:
            cmd.extend(['--crop-size', str(crop_size)])
            append_log_line(project_id, f"🧩 Using patch-based training with crop size: {crop_size}")
        
        # Use high-resolution training images if available
        use_separate = config.get('use_separate_training_images', False)
        training_images_path = paths.get('training_images_path')
        
        # Check if we need to extract training images (for retry scenarios)
        if use_separate and training_images_path:
            training_images_count = len(list(training_images_path.glob('*'))) if training_images_path.exists() else 0
            
            # If no training images exist but user wants them, try to extract from video
            if training_images_count == 0:
                append_log_line(project_id, "⚠️ Training images folder is empty, attempting to extract...")
                
                # Find video files in project
                project_path = paths['project_path']
                video_files = []
                for ext in ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.MP4', '.MOV', '.AVI', '.MKV', '.WEBM']:
                    video_files.extend(list(project_path.glob(f'*{ext}')))
                
                if video_files:
                    from ..utils.video_processor import VideoProcessor
                    video_processor = VideoProcessor()
                    training_resolution = config.get('training_resolution', '4K')
                    
                    # Ensure training_images folder exists
                    training_images_path.mkdir(parents=True, exist_ok=True)
                    
                    for video_path in video_files:
                        append_log_line(project_id, f"   📹 Extracting training frames from {video_path.name} at {training_resolution}...")
                        
                        training_config = {
                            'max_frames': config.get('max_frames', 200),
                            'min_frames': config.get('min_frames', 30),
                            'resolution': training_resolution,
                            'quality': 100,  # Always max quality for training images
                            'use_gpu': config.get('use_gpu_extraction', True),
                            'ffmpeg_cpu_workers': config.get('ffmpeg_cpu_workers', 4),
                            'replacement_search_radius': config.get('replacement_search_radius', 4),
                            'motion_threshold': config.get('motion_threshold', 0.15),
                            'blur_threshold': config.get('blur_threshold', 100)
                        }
                        
                        training_extracted = video_processor.extract_frames(
                            str(video_path),
                            training_images_path,
                            extraction_config=training_config,
                            progress_callback=None
                        )
                        append_log_line(project_id, f"   ✅ Extracted {len(training_extracted)} high-res training frames")
                    
                    # Re-count after extraction
                    training_images_count = len(list(training_images_path.glob('*')))
                else:
                    append_log_line(project_id, "   ℹ️ No video files found, will use images folder for training")
            
            # Now check if we have training images
            if training_images_count > 0:
                cmd.extend(['--colmap-image-path', str(training_images_path.absolute())])
                append_log_line(project_id, f"🎯 Using high-res training images: {training_images_count} images from {training_images_path.name}")
                training_resolution = config.get('training_resolution', '4K')
                append_log_line(project_id, f"   📐 Training resolution: {training_resolution}")
            else:
                append_log_line(project_id, "⚠️ No training images available, using COLMAP images for training")
        elif use_separate:
            append_log_line(project_id, "⚠️ Training images path not configured, using COLMAP images")

        # Add advanced quality parameters for high/ultra/custom modes (using correct OpenSplat parameter names)
        if quality_mode in ['high', 'ultra', 'hard', 'custom', 'balanced']:
            # Map our config to actual OpenSplat parameters
            densify_threshold = opensplat_config.get('densify_grad_threshold')
            refine_every = 75
            warmup = 750
            ssim = 0.25

            # Learning rates from opensplat_config (High quality defaults)
            learning_rate = opensplat_config.get('learning_rate')
            position_lr_init = opensplat_config.get('position_lr_init')
            position_lr_final = opensplat_config.get('position_lr_final')
            feature_lr = opensplat_config.get('feature_lr')
            opacity_lr = opensplat_config.get('opacity_lr')
            scaling_lr = opensplat_config.get('scaling_lr')
            rotation_lr = opensplat_config.get('rotation_lr')
            percent_dense = opensplat_config.get('percent_dense')

            # Override with custom parameters if provided (only use non-None values)
            if quality_mode == 'custom':
                custom_densify = config.get('densify_grad_threshold')
                custom_refine = config.get('refine_every')
                custom_warmup = config.get('warmup_length')
                custom_ssim = config.get('ssim_weight')

                # Custom learning rates
                custom_lr = config.get('learning_rate')
                custom_pos_lr_init = config.get('position_lr_init')
                custom_pos_lr_final = config.get('position_lr_final')
                custom_feat_lr = config.get('feature_lr')
                custom_opacity_lr = config.get('opacity_lr')
                custom_scaling_lr = config.get('scaling_lr')
                custom_rotation_lr = config.get('rotation_lr')
                custom_percent_dense = config.get('percent_dense')

                # Only override if not None
                if custom_densify is not None:
                    densify_threshold = custom_densify
                if custom_refine is not None:
                    refine_every = custom_refine
                if custom_warmup is not None:
                    warmup = custom_warmup
                if custom_ssim is not None:
                    ssim = custom_ssim

                # Override learning rates if provided
                if custom_lr is not None:
                    learning_rate = custom_lr
                if custom_pos_lr_init is not None:
                    position_lr_init = custom_pos_lr_init
                if custom_pos_lr_final is not None:
                    position_lr_final = custom_pos_lr_final
                if custom_feat_lr is not None:
                    feature_lr = custom_feat_lr
                if custom_opacity_lr is not None:
                    opacity_lr = custom_opacity_lr
                if custom_scaling_lr is not None:
                    scaling_lr = custom_scaling_lr
                if custom_rotation_lr is not None:
                    rotation_lr = custom_rotation_lr
                if custom_percent_dense is not None:
                    percent_dense = custom_percent_dense

                append_log_line(project_id, f"🔧 Custom OpenSplat params: densify={densify_threshold}, refine={refine_every}, warmup={warmup}, ssim={ssim}")
            elif quality_mode == 'ultra':
                refine_every = 50
                warmup = 1000
                ssim = 0.3
            elif quality_mode == 'hard':
                refine_every = 60
                warmup = 900
                ssim = 0.28
            elif quality_mode == 'high':
                refine_every = 75
                warmup = 750
                ssim = 0.25

            # Add only parameters that OpenSplat actually supports
            if densify_threshold is not None:
                cmd.extend(['--densify-grad-thresh', str(densify_threshold)])
            cmd.extend(['--refine-every', str(refine_every)])
            cmd.extend(['--warmup-length', str(warmup)])
            cmd.extend(['--ssim-weight', str(ssim)])

            # OpenSplat 1.1.5 does NOT support learning rate parameters
            # These are internal to the training and cannot be overridden via CLI
            # Available parameters: densify-grad-thresh, refine-every, warmup-length, ssim-weight, reset-alpha-every

            if quality_mode == 'ultra':
                cmd.extend(['--reset-alpha-every', '20'])   # More frequent opacity reset (default: 30)
            elif quality_mode == 'hard':
                cmd.extend(['--reset-alpha-every', '24'])

            append_log_line(project_id, f"⚡ Enhanced parameters: densify_threshold={densify_threshold}, refine_every={refine_every}")

        # Mixed Precision (FP16) Training - reduces VRAM usage by ~30-50%
        mixed_precision = config.get('mixed_precision', False)
        if mixed_precision:
            cmd.extend(['--mixed-precision'])
            append_log_line(project_id, "🔥 Mixed Precision (FP16) enabled - faster training, lower VRAM usage")

        iteration_total = enhanced_iterations

        training_progress = {'current': 0, 'total': iteration_total}
        training_progress_log = {'last_milestone': -1}

        def training_line_handler(line):
            # Enhanced patterns for training progress - OpenSplat specific patterns
            patterns = [
                r'Iteration\s+(\d+)/(\d+)',                     # Standard iteration
                r'Step\s+(\d+)/(\d+)',                          # Step format
                r'Epoch\s+(\d+)/(\d+)',                         # Epoch format
                r'Progress:\s+(\d+)/(\d+)',                     # Progress format
                r'Training\s+(\d+)/(\d+)',                      # Training format
                r'iter\s*:\s*(\d+)\s*/\s*(\d+)',                # iter: format
                r'(\d+)\s*/\s*(\d+)\s*iterations?',             # Generic iterations
                r'Iteration\s+(\d+)\s+\(.*?\)\s*/\s*(\d+)',     # Iteration with loss info
                r'\[(\d+)/(\d+)\]',                             # Bracket format
                r'it\s*(\d+)/(\d+)',                            # it format
                r'step\s*(\d+)\s*\/\s*(\d+)',                   # step format
            ]

            for pattern in patterns:
                match = re.search(pattern, line, re.IGNORECASE)
                if match:
                    current = int(match.group(1))
                    total = int(match.group(2))
                    training_progress['current'] = current
                    training_progress['total'] = total

                    # Validate total against iteration_total
                    if total != iteration_total and iteration_total > 0:
                        total = iteration_total

                    if total > 0:
                        percent = int((min(current, total) / total) * 100)

                        details = {
                            'text': f'Training iterations: {current}/{total}',
                            'current_item': current,
                            'total_items': total,
                            'item_name': f'Iteration {current}'
                        }

                        # Emit real-time progress via WebSocket
                        emit_stage_progress(project_id, 'gaussian_splatting', percent, details)

                        update_state(project_id, 'gaussian_splatting', progress=min(percent, 99), details=details)
                        update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {current}/{total}', subtext=None)
                        should_log, progress_percent = should_emit_progress_milestone(
                            training_progress_log,
                            current,
                            total,
                        )
                        if should_log:
                            append_log_line(
                                project_id,
                                f"🏋️ Training progress: {current}/{total} iterations ({progress_percent}%)",
                            )
                    return

            # Fallback for simple iteration counting
            if any(keyword in line.lower() for keyword in ['iteration', 'step']):
                # Try to extract just a number for simple progress tracking
                number_match = re.search(r'(\d+)', line)
                if number_match:
                    current = int(number_match.group(1))
                    if iteration_total > 0 and current <= iteration_total:
                        percent = int((current / iteration_total) * 100)

                        training_progress['current'] = current
                        training_progress['total'] = iteration_total

                        details = {
                            'text': f'Training iterations: {current}/{iteration_total}',
                            'current_item': current,
                            'total_items': iteration_total,
                            'item_name': f'Step {current}'
                        }

                        emit_stage_progress(project_id, 'gaussian_splatting', percent, details)
                        update_state(project_id, 'gaussian_splatting', progress=min(percent, 99), details=details)
                        update_stage_detail(
                            project_id,
                            'gaussian_splatting',
                            text=f'Training iterations: {current}/{iteration_total}',
                            subtext=None
                        )
                        should_log, progress_percent = should_emit_progress_milestone(
                            training_progress_log,
                            current,
                            iteration_total,
                        )
                        if should_log:
                            append_log_line(
                                project_id,
                                f"🏋️ Training progress: {current}/{iteration_total} iterations ({progress_percent}%)",
                            )

        run_command_with_logs(
            project_id,
            cmd,
            cwd=opensplat_working_dir,
            line_handler=training_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )

        update_state(project_id, 'gaussian_splatting', status='completed', progress=100)
        current = training_progress['current'] or iteration_total or 0
        total = training_progress['total'] or iteration_total or current
        if total:
            update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {min(current, total)}/{total}', subtext='Training complete')
        else:
            update_stage_detail(project_id, 'gaussian_splatting', text='Training complete', subtext=None)
        append_log_line(project_id, "✅ PobimSplats Training completed")

        # Finalize
        update_state(project_id, 'finalizing', status='running')
        update_stage_detail(project_id, 'finalizing', text='Packaging outputs...', subtext=None)
        update_state(project_id, 'finalizing', status='completed', progress=100)
        update_stage_detail(project_id, 'finalizing', text='Processing complete', subtext=None)

        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'completed'
            project_store.processing_status[project_id]['end_time'] = datetime.now().isoformat()
            save_projects_db()

        append_log_line(project_id, "🎉 PobimSplats processing completed successfully!")

    except Exception as e:
        logger.error(f"COLMAP pipeline failed for {project_id}: {e}")
        append_log_line(project_id, f"❌ Pipeline Error: {str(e)}")

        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'failed'
            project_store.processing_status[project_id]['error'] = str(e)
            project_store.processing_status[project_id]['end_time'] = datetime.now().isoformat()
            save_projects_db()

        raise


def run_opensplat_training(project_id, paths, config, processing_start_time, time_estimate, time_estimator):
    """Run OpenSplat training stage only."""
    try:
        images_path = paths['images_path']
        num_images = len([f for f in os.listdir(images_path)
                         if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff'))])

        # 5. Enhanced OpenSplat Training
        update_state(project_id, 'gaussian_splatting', status='running')

        # Get high-quality OpenSplat configuration
        quality_mode = config.get('quality_mode', 'balanced')

        # Pass config as custom_params if in custom mode
        custom_params = config if quality_mode == 'custom' else None
        opensplat_config = get_opensplat_config(quality_mode, num_images, custom_params)

        # Use custom iterations if provided, otherwise use quality config
        enhanced_iterations = opensplat_config['iterations']
        if quality_mode == 'custom':
            append_log_line(project_id, f"🔧 Using custom quality mode: {enhanced_iterations} iterations")
        else:
            append_log_line(project_id, f"🎯 Using {quality_mode} quality mode: {enhanced_iterations} iterations")

        # Calculate progress and remaining time
        elapsed = time.time() - processing_start_time
        estimated_remaining = max(0, time_estimate.total_seconds - elapsed)
        progress_pct = min(95, int((elapsed / time_estimate.total_seconds) * 100))

        append_log_line(project_id, f"⏱️  Progress: {progress_pct}% | Remaining: ~{time_estimator.format_time_display(estimated_remaining)}")

        update_stage_detail(project_id, 'gaussian_splatting',
                          text=f'Training iterations: 0/{enhanced_iterations}',
                          subtext=f'Quality: {quality_mode.title()}')
        append_log_line(project_id, "🔄 Running High-Quality Gaussian Splatting Training...")

        opensplat_binary = app_config.OPENSPLAT_BINARY_PATH
        if opensplat_binary.is_dir():
            potential_binary = opensplat_binary / 'opensplat'
            if potential_binary.exists():
                opensplat_binary = potential_binary

        if not opensplat_binary.exists():
            raise Exception(f"OpenSplat binary not found at {opensplat_binary}")

        opensplat_working_dir = opensplat_binary.parent if opensplat_binary.is_file() else opensplat_binary

        output_ply = paths['results_path'] / f"{project_id}_{quality_mode}_{enhanced_iterations}iter.ply"

        # Enhanced OpenSplat command with quality parameters
        # OpenSplat expects a COLMAP project folder with images/ and sparse/0/
        cmd = [
            str(opensplat_binary),
            str(paths['project_path'].absolute()),
            '-n', str(enhanced_iterations),
            '--output', str(output_ply.absolute())
        ]

        # Check for crop size (Patch-based training)
        crop_size = config.get('crop_size', 0)
        if crop_size > 0:
            cmd.extend(['--crop-size', str(crop_size)])
            append_log_line(project_id, f"🧩 Using patch-based training with crop size: {crop_size}")

        # Add advanced quality parameters for high/ultra/custom modes
        if quality_mode in ['high', 'ultra', 'hard', 'custom', 'balanced']:
            densify_threshold = opensplat_config.get('densify_grad_threshold')
            refine_every = 75
            warmup = 750
            ssim = 0.25

            # Learning rates from opensplat_config (High quality defaults)
            learning_rate = opensplat_config.get('learning_rate')
            position_lr_init = opensplat_config.get('position_lr_init')
            position_lr_final = opensplat_config.get('position_lr_final')
            feature_lr = opensplat_config.get('feature_lr')
            opacity_lr = opensplat_config.get('opacity_lr')
            scaling_lr = opensplat_config.get('scaling_lr')
            rotation_lr = opensplat_config.get('rotation_lr')
            percent_dense = opensplat_config.get('percent_dense')

            # Override with custom parameters if provided (only use non-None values)
            if quality_mode == 'custom':
                custom_densify = config.get('densify_grad_threshold')
                custom_refine = config.get('refine_every')
                custom_warmup = config.get('warmup_length')
                custom_ssim = config.get('ssim_weight')

                # Custom learning rates
                custom_lr = config.get('learning_rate')
                custom_pos_lr_init = config.get('position_lr_init')
                custom_pos_lr_final = config.get('position_lr_final')
                custom_feat_lr = config.get('feature_lr')
                custom_opacity_lr = config.get('opacity_lr')
                custom_scaling_lr = config.get('scaling_lr')
                custom_rotation_lr = config.get('rotation_lr')
                custom_percent_dense = config.get('percent_dense')

                # Only override if not None
                if custom_densify is not None:
                    densify_threshold = custom_densify
                if custom_refine is not None:
                    refine_every = custom_refine
                if custom_warmup is not None:
                    warmup = custom_warmup
                if custom_ssim is not None:
                    ssim = custom_ssim

                # Override learning rates if provided
                if custom_lr is not None:
                    learning_rate = custom_lr
                if custom_pos_lr_init is not None:
                    position_lr_init = custom_pos_lr_init
                if custom_pos_lr_final is not None:
                    position_lr_final = custom_pos_lr_final
                if custom_feat_lr is not None:
                    feature_lr = custom_feat_lr
                if custom_opacity_lr is not None:
                    opacity_lr = custom_opacity_lr
                if custom_scaling_lr is not None:
                    scaling_lr = custom_scaling_lr
                if custom_rotation_lr is not None:
                    rotation_lr = custom_rotation_lr
                if custom_percent_dense is not None:
                    percent_dense = custom_percent_dense

                append_log_line(project_id, f"🔧 Custom OpenSplat params: densify={densify_threshold}, refine={refine_every}, warmup={warmup}, ssim={ssim}")
            elif quality_mode == 'ultra':
                refine_every = 50
                warmup = 1000
                ssim = 0.3
            elif quality_mode == 'hard':
                refine_every = 60
                warmup = 900
                ssim = 0.28
            elif quality_mode == 'high':
                refine_every = 75
                warmup = 750
                ssim = 0.25

            # Add only parameters that OpenSplat actually supports
            if densify_threshold is not None:
                cmd.extend(['--densify-grad-thresh', str(densify_threshold)])
            cmd.extend(['--refine-every', str(refine_every)])
            cmd.extend(['--warmup-length', str(warmup)])
            cmd.extend(['--ssim-weight', str(ssim)])

            # OpenSplat 1.1.5 does NOT support learning rate parameters
            # These are internal to the training and cannot be overridden via CLI
            # Available parameters: densify-grad-thresh, refine-every, warmup-length, ssim-weight, reset-alpha-every

            if quality_mode == 'ultra':
                cmd.extend(['--reset-alpha-every', '20'])
            elif quality_mode == 'hard':
                cmd.extend(['--reset-alpha-every', '24'])

            append_log_line(project_id, f"⚡ Enhanced parameters: densify_threshold={densify_threshold}")

        # Mixed Precision (FP16) Training - reduces VRAM usage by ~30-50%
        mixed_precision = config.get('mixed_precision', False)
        if mixed_precision:
            cmd.extend(['--mixed-precision'])
            append_log_line(project_id, "🔥 Mixed Precision (FP16) enabled - faster training, lower VRAM usage")

        iteration_total = enhanced_iterations
        training_progress = {'current': 0, 'total': iteration_total}
        training_progress_log = {'last_milestone': -1}

        def training_line_handler(line):
            patterns = [
                r'Iteration\s+(\d+)/(\d+)',
                r'Step\s+(\d+)/(\d+)',
                r'iter\s*:\s*(\d+)\s*/\s*(\d+)',
                r'(\d+)\s*/\s*(\d+)\s*iterations?',
            ]

            for pattern in patterns:
                match = re.search(pattern, line, re.IGNORECASE)
                if match:
                    current = int(match.group(1))
                    total = int(match.group(2))
                    training_progress['current'] = current
                    training_progress['total'] = total

                    if total != iteration_total and iteration_total > 0:
                        total = iteration_total

                    if total > 0:
                        percent = int((min(current, total) / total) * 100)
                        details = {
                            'text': f'Training iterations: {current}/{total}',
                            'current_item': current,
                            'total_items': total,
                        }
                        emit_stage_progress(project_id, 'gaussian_splatting', percent, details)
                        update_state(project_id, 'gaussian_splatting', progress=min(percent, 99), details=details)
                        update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {current}/{total}', subtext=None)
                        should_log, progress_percent = should_emit_progress_milestone(
                            training_progress_log,
                            current,
                            total,
                        )
                        if should_log:
                            append_log_line(
                                project_id,
                                f"🏋️ Training progress: {current}/{total} iterations ({progress_percent}%)",
                            )
                    return

        run_command_with_logs(
            project_id,
            cmd,
            cwd=opensplat_working_dir,
            line_handler=training_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )

        update_state(project_id, 'gaussian_splatting', status='completed', progress=100)
        append_log_line(project_id, "✅ PobimSplats Training completed")

        # Finalize
        finalize_project(project_id)

    except Exception as e:
        logger.error(f"OpenSplat training failed for {project_id}: {e}")
        append_log_line(project_id, f"❌ Training Error: {str(e)}")
        raise


def finalize_project(project_id):
    """Finalize project completion."""
    try:
        update_state(project_id, 'finalizing', status='running')
        update_stage_detail(project_id, 'finalizing', text='Packaging outputs...', subtext=None)
        update_state(project_id, 'finalizing', status='completed', progress=100)
        update_stage_detail(project_id, 'finalizing', text='Processing complete', subtext=None)

        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'completed'
            project_store.processing_status[project_id]['end_time'] = datetime.now().isoformat()
            save_projects_db()

        append_log_line(project_id, "🎉 PobimSplats processing completed successfully!")

    except Exception as e:
        logger.error(f"Finalization failed for {project_id}: {e}")
        append_log_line(project_id, f"❌ Finalization Error: {str(e)}")
        raise
