"""Frame-manifest helpers used by the reconstruction pipeline."""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime
from pathlib import Path

from ..core.projects import append_log_line
from ..utils.video_processor import VideoProcessor

logger = logging.getLogger(__name__)

FRAME_SELECTION_MANIFEST_NAME = 'frame_selection_manifest.json'

video_processor = VideoProcessor()


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

    extraction_requests_by_video = {}
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
