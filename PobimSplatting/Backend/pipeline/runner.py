"""High-level processing pipeline orchestration."""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path

from ..core import config as app_config
from ..core import projects as project_store
from ..core.projects import (
    append_log_line,
    emit_stage_progress,
    save_projects_db,
    update_stage_detail,
    update_state,
)
from ..utils.video_processor import VideoProcessor
from .config_builders import (
    build_upload_policy_preview,
    generate_hloc_pairs,
    get_colmap_config,
    get_colmap_config_for_pipeline,
    get_colmap_executable,
    get_opensplat_config,
    should_prefer_incremental_sfm,
)
from .frame_manifest import (
    get_frame_selection_manifest_path,
    load_frame_selection_manifest,
    persist_frame_selection_manifest,
    should_run_boundary_frame_densification,
)
from .orbit_policy import (
    resolve_orbit_safe_policy,
    sync_reconstruction_framework,
)
from .recovery_planners import (
    build_densified_overlap_retry_pass,
    clear_sparse_reconstruction_outputs,
    refine_orbit_safe_profile_from_geometry,
    run_boundary_frame_densification_recovery as _run_boundary_frame_densification_recovery_impl,
    run_orbit_safe_bridge_recovery_matching_pass,
    should_run_final_loop_detection_recovery,
)
from .runtime_support import (
    HLOC_AVAILABLE,
    normalize_feature_method,
    normalize_matcher_type,
    resolve_colmap_feature_pipeline_profile,
)
from .stage_features import (
    run_feature_extraction_stage as _run_feature_extraction_stage_impl,
    run_feature_matching_stage as _run_feature_matching_stage_impl,
    run_hloc_feature_extraction_stage as _run_hloc_feature_extraction_stage_impl,
    run_hloc_feature_matching_stage as _run_hloc_feature_matching_stage_impl,
)
from .stage_sparse import (
    run_model_conversion_stage as _run_model_conversion_stage_impl,
    run_sparse_reconstruction_stage as _run_sparse_reconstruction_stage_impl,
)
from .stage_training import (
    finalize_project as _finalize_project_impl,
    run_opensplat_training as _run_opensplat_training_impl,
)

logger = logging.getLogger(__name__)

video_processor = VideoProcessor()


def _feature_stage_helpers():
    return {
        'generate_hloc_pairs': generate_hloc_pairs,
        'get_colmap_config_for_pipeline': get_colmap_config_for_pipeline,
        'refine_orbit_safe_profile_from_geometry': refine_orbit_safe_profile_from_geometry,
        'run_orbit_safe_bridge_recovery_matching_pass': run_orbit_safe_bridge_recovery_matching_pass,
    }


def _sparse_stage_helpers():
    return {
        'build_densified_overlap_retry_pass': build_densified_overlap_retry_pass,
        'clear_sparse_reconstruction_outputs': clear_sparse_reconstruction_outputs,
        'get_colmap_config_for_pipeline': get_colmap_config_for_pipeline,
        'refine_orbit_safe_profile_from_geometry': refine_orbit_safe_profile_from_geometry,
        'report_sparse_model_coverage': report_sparse_model_coverage,
        'run_boundary_frame_densification_recovery': run_boundary_frame_densification_recovery,
        'run_orbit_safe_bridge_recovery_matching_pass': run_orbit_safe_bridge_recovery_matching_pass,
        'select_best_sparse_model': select_best_sparse_model,
        'should_prefer_incremental_sfm': should_prefer_incremental_sfm,
        'should_run_boundary_frame_densification': should_run_boundary_frame_densification,
        'should_run_final_loop_detection_recovery': should_run_final_loop_detection_recovery,
    }


def _training_stage_helpers():
    return {
        'get_opensplat_config': get_opensplat_config,
    }


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




# ===========================================================================
# HLOC Neural Feature Extraction & Matching (ALIKED + LightGlue)
# ===========================================================================

def run_hloc_feature_extraction_stage(project_id, paths, config, colmap_config=None):
    return _run_hloc_feature_extraction_stage_impl(
        project_id,
        paths,
        config,
        colmap_config,
        helpers=_feature_stage_helpers(),
    )


def run_hloc_feature_matching_stage(project_id, paths, config, hloc_data=None):
    return _run_hloc_feature_matching_stage_impl(
        project_id,
        paths,
        config,
        hloc_data,
        helpers=_feature_stage_helpers(),
    )


def run_feature_extraction_stage(project_id, paths, config, colmap_config=None):
    return _run_feature_extraction_stage_impl(
        project_id,
        paths,
        config,
        colmap_config,
        helpers=_feature_stage_helpers(),
    )


def run_feature_matching_stage(project_id, paths, config, colmap_config=None):
    return _run_feature_matching_stage_impl(
        project_id,
        paths,
        config,
        colmap_config,
        helpers=_feature_stage_helpers(),
    )




def run_boundary_frame_densification_recovery(project_id, paths, config, colmap_cfg):
    return _run_boundary_frame_densification_recovery_impl(
        project_id,
        paths,
        config,
        colmap_cfg,
        rerun_feature_extraction_stage=run_feature_extraction_stage,
        rerun_feature_matching_stage=run_feature_matching_stage,
        rerun_sparse_reconstruction_stage=run_sparse_reconstruction_stage,
    )


def run_sparse_reconstruction_stage(project_id, paths, config, colmap_config=None):
    return _run_sparse_reconstruction_stage_impl(
        project_id,
        paths,
        config,
        colmap_config,
        helpers=_sparse_stage_helpers(),
    )


def run_model_conversion_stage(project_id, paths):
    return _run_model_conversion_stage_impl(
        project_id,
        paths,
        helpers=_sparse_stage_helpers(),
    )


def run_colmap_pipeline(project_id, paths, config, processing_start_time, time_estimate, time_estimator, from_stage='feature_extraction'):
    """Run real COLMAP + OpenSplat pipeline from specified stage."""
    try:
        images_path = paths['images_path']
        num_images = len([
            f for f in os.listdir(images_path)
            if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff'))
        ])

        quality_mode = config.get('quality_mode', 'balanced')
        custom_params = None
        if quality_mode == 'custom':
            custom_params = {
                'peak_threshold': config.get('peak_threshold'),
                'edge_threshold': config.get('edge_threshold'),
                'max_num_orientations': config.get('max_num_orientations'),
                'max_num_features': config.get('max_num_features'),
                'max_num_matches': config.get('max_num_matches'),
                'sequential_overlap': config.get('sequential_overlap'),
                'min_num_matches': config.get('min_num_matches'),
                'max_num_models': config.get('max_num_models'),
                'init_num_trials': config.get('init_num_trials'),
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

        colmap_stages = ['feature_extraction', 'feature_matching', 'sparse_reconstruction', 'model_conversion']
        start_index = colmap_stages.index(from_stage) if from_stage in colmap_stages else 0

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
                    'ℹ️ SuperPoint stays on native COLMAP fallback for vocab-tree mode because hloc pair generation does not support retrieval yet',
                )
        elif feature_method == 'aliked':
            if use_native_colmap_neural:
                append_log_line(project_id, f"⚡ Using {native_feature_profile['description']} in the native COLMAP pipeline")
            elif HLOC_AVAILABLE and requested_matcher_type != 'vocab_tree':
                use_hloc = True
                append_log_line(project_id, 'ℹ️ Native COLMAP ALIKED/LightGlue is unavailable in this environment; falling back to hloc')
            else:
                append_log_line(project_id, 'ℹ️ Native COLMAP ALIKED support is unavailable; falling back to classic COLMAP SIFT settings')

        hloc_data = None

        if start_index <= colmap_stages.index('feature_extraction'):
            if use_hloc:
                append_log_line(project_id, f"⚡ Using hloc neural features ({feature_method.upper()}) - 10-20x faster")
                hloc_data = run_hloc_feature_extraction_stage(project_id, paths, config, colmap_config)
                if isinstance(hloc_data, dict) and 'features_path' in hloc_data:
                    colmap_config = hloc_data.get('colmap_config', colmap_config)
                else:
                    colmap_config = hloc_data
                    hloc_data = None
                    use_hloc = False
            else:
                colmap_config = run_feature_extraction_stage(project_id, paths, config, colmap_config)

        if start_index <= colmap_stages.index('feature_matching'):
            if use_hloc and hloc_data:
                append_log_line(project_id, '⚡ Using LightGlue neural matching - 4-10x faster')
                colmap_config = run_hloc_feature_matching_stage(project_id, paths, config, hloc_data)
            else:
                colmap_config = run_feature_matching_stage(project_id, paths, config, colmap_config)

        if start_index <= colmap_stages.index('sparse_reconstruction'):
            colmap_config = run_sparse_reconstruction_stage(project_id, paths, config, colmap_config)

        if start_index <= colmap_stages.index('model_conversion'):
            run_model_conversion_stage(project_id, paths)

        run_opensplat_training(
            project_id,
            paths,
            config,
            processing_start_time,
            time_estimate,
            time_estimator,
        )

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
    return _run_opensplat_training_impl(
        project_id,
        paths,
        config,
        processing_start_time,
        time_estimate,
        time_estimator,
        helpers=_training_stage_helpers(),
    )


def finalize_project(project_id):
    return _finalize_project_impl(project_id)
