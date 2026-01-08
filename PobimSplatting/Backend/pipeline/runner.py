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
from typing import Optional

from ..core import config as app_config
from ..core import projects as project_store
from ..core.commands import run_command_with_logs
from ..core.projects import (
    append_log_line,
    emit_stage_progress,
    save_projects_db,
    update_stage_detail,
    update_state,
)
from ..utils.video_processor import VideoProcessor

logger = logging.getLogger(__name__)

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
                expected_frames_per_video = config.get('max_frames', 100)
                total_expected_frames = expected_frames_per_video * total_videos
                
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
                        'use_gpu': config.get('use_gpu_extraction', True)
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
                        frames_from_prev_videos = i * expected_frames_per_video
                        overall_frames = frames_from_prev_videos + current_frame
                        overall_progress = int((overall_frames / total_expected_frames) * 100)
                        
                        # Update progress every 5 frames to avoid excessive updates
                        if current_frame % 5 == 0 or current_frame == expected_total:
                            emit_stage_progress(project_id, 'video_extraction', min(overall_progress, 99), {
                                'text': f'Video {i + 1}/{total_videos}: Frame {current_frame}/{expected_total}',
                                'current_item': overall_frames,
                                'total_items': total_expected_frames,
                                'item_name': f'Frame {current_frame}'
                            })
                            update_stage_detail(
                                project_id,
                                'video_extraction',
                                text=f'Video {i + 1}/{total_videos}: Frame {current_frame}/{expected_total}',
                                subtext=f'Total extracted: {frames_from_prev_videos + current_frame}'
                            )

                    extracted = video_processor.extract_frames(
                        video_path,
                        paths['images_path'],
                        extraction_config=extraction_config,
                        progress_callback=frame_progress_callback
                    )

                    total_extracted_frames += len(extracted)
                    append_log_line(project_id, f"✅ Extracted {len(extracted)} frames from video {i + 1}")
                    
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
    Also deletes all inferior models to keep only the best one.
    """
    if not sparse_path.exists():
        return None

    colmap_exe = get_colmap_executable()
    best_model = None
    best_score = (-1, -1, -1, -1)
    all_models = []  # Store all models with their scores for later cleanup

    # Analyze each sparse model directory
    for item in sparse_path.iterdir():
        if not item.is_dir():
            continue

        # Check if this is a valid COLMAP model (has cameras.bin or cameras.txt)
        cameras_bin = item / 'cameras.bin'
        cameras_txt = item / 'cameras.txt'
        images_bin = item / 'images.bin'
        images_txt = item / 'images.txt'

        if not (cameras_bin.exists() or cameras_txt.exists()):
            continue

        try:
            # Use colmap model_analyzer to get statistics
            result = subprocess.run(
                [colmap_exe, 'model_analyzer', '--path', str(item)],
                capture_output=True,
                text=True,
                timeout=30
            )

            combined_output = ''
            if result.stdout:
                combined_output += result.stdout
            if result.stderr:
                combined_output += result.stderr

            if result.returncode != 0:
                if project_id:
                    append_log_line(
                        project_id,
                        f"⚠️ Failed to analyze model {item.name}: return code {result.returncode}"
                    )
                    if combined_output:
                        append_log_line(project_id, f"[DEBUG] model_analyzer output: {combined_output.strip()[:500]}")
                continue

            # Parse output for COLMAP model stats
            num_cameras = 0
            num_images = 0
            registered_images = 0
            num_points = 0

            for line in combined_output.splitlines():
                match_cameras = re.search(r'Cameras:\s*(\d+)', line)
                if match_cameras:
                    num_cameras = int(match_cameras.group(1))
                    continue

                match_images = re.search(r'Images:\s*(\d+)', line)
                if match_images:
                    num_images = int(match_images.group(1))
                    continue

                match_images = re.search(r'Registered images:\s*(\d+)', line)
                if match_images:
                    registered_images = int(match_images.group(1))
                    continue

                match_points = re.search(r'Points:\s*(\d+)', line)
                if match_points:
                    num_points = int(match_points.group(1))

            # Score prioritizes highest camera count, then registered images, then points
            score = (num_cameras, registered_images, num_points, num_images)

            if project_id:
                append_log_line(
                    project_id,
                    f"📊 Model {item.name}: cameras={num_cameras}, registered={registered_images}, images={num_images}, points={num_points}"
                )

            # Store model info for later cleanup
            all_models.append({
                'path': item,
                'score': score,
                'num_cameras': num_cameras,
                'registered_images': registered_images
            })

            if score > best_score:
                best_score = score
                best_model = item

        except Exception as e:
            logger.warning(f"Failed to analyze model {item}: {e}")
            continue

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

        # Step 3: Delete all other temporary models
        append_log_line(project_id, "📦 Step 3: Removing inferior models...")
        for temp_name, mapping in temp_mappings.items():
            if not mapping['is_best']:
                temp_path = mapping['path']
                original_name = mapping['original_name']
                model_info = mapping['model_info']

                if temp_path.exists():
                    try:
                        shutil.rmtree(temp_path)
                        append_log_line(
                            project_id,
                            f"🗑️ Removed inferior model: {original_name} (cameras={model_info['num_cameras']}, registered={model_info['registered_images']})"
                        )
                    except Exception as e:
                        logger.warning(f"Failed to delete {temp_name}: {e}")
                        if project_id:
                            append_log_line(project_id, f"⚠️ Failed to delete {temp_name}: {e}")

        append_log_line(project_id, "✅ Model organization completed - only best model (0/) remains")

    return best_model


def get_colmap_config(num_images, project_id=None, quality_mode='balanced', custom_params=None):
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
    
    # CRITICAL: Prevent GPU OOM by capping max_num_matches based on expected feature count
    # For images with 70K-80K features, max_num_matches should be <= 40K to avoid GPU memory issues
    # This is especially important for CUDA-based feature matching
    if max_num_matches > 65536:
        if project_id:
            append_log_line(project_id, f"⚠️ Reducing max_num_matches from {max_num_matches} to 45960 to prevent GPU memory overflow")
        max_num_matches = 45960  # Safe limit for high-feature images

    # Matching strategy based on dataset size and quality requirements
    if quality_mode == 'robust':
        # Robust mode: Always use exhaustive for difficult datasets
        matcher_type = 'exhaustive'
        max_num_matches = min(max_num_matches, 45960)  # Cap for GPU safety
        matcher_params = {}
        if project_id:
            append_log_line(project_id, "🔧 Using ROBUST mode: Exhaustive matching for maximum coverage")
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
        overlap = '35' if quality_mode == 'ultra_professional' else ('30' if quality_mode == 'professional' else ('25' if quality_mode in ['high', 'ultra'] else '20'))
        quadratic = '1'  # Always enable quadratic overlap
        matcher_params = {
            'SequentialMatching.overlap': overlap,
            'SequentialMatching.quadratic_overlap': quadratic,
            'SequentialMatching.loop_detection': '1'  # Enable loop detection
        }
    elif num_images <= 400:
        # Medium-large: Enhanced sequential for better quality
        matcher_type = 'sequential'  # Changed from spatial for better GPU utilization
        overlap = '30' if quality_mode == 'ultra_professional' else ('25' if quality_mode == 'professional' else ('18' if quality_mode in ['high', 'ultra'] else '12'))
        quadratic = '1'  # Always enable quadratic overlap
        matcher_params = {
            'SequentialMatching.overlap': overlap,
            'SequentialMatching.quadratic_overlap': quadratic,
            'SequentialMatching.loop_detection': '1'
        }
    elif num_images <= 1000:
        # Large: Quality-aware sequential with improved coverage
        matcher_type = 'sequential'
        overlap = '25' if quality_mode == 'ultra_professional' else ('20' if quality_mode == 'professional' else ('15' if quality_mode in ['high', 'ultra'] else '12'))
        quadratic = '1'  # Always enable quadratic overlap
        matcher_params = {
            'SequentialMatching.overlap': overlap,
            'SequentialMatching.quadratic_overlap': quadratic,
            'SequentialMatching.loop_detection': '1'  # Enable loop detection
        }
    else:
        # Very large: Optimized sequential
        matcher_type = 'sequential'
        overlap = '18' if quality_mode == 'ultra_professional' else ('12' if quality_mode == 'professional' else ('8' if quality_mode in ['high', 'ultra'] else '5'))
        matcher_params = {
            'SequentialMatching.overlap': overlap,
            'SequentialMatching.quadratic_overlap': '0'
        }

    # Quality-aware reconstruction settings - NEW: Balanced = High quality baseline
    quality_mapper_scales = {
        'fast': {'matches': 1.0, 'trials': 0.5, 'models': 0.5},
        'balanced': {'matches': 0.8, 'trials': 1.5, 'models': 2.0},  # Same as High (aggressive for better results)
        'high': {'matches': 0.8, 'trials': 1.5, 'models': 2.0},  # Aggressive reconstruction
        'ultra': {'matches': 0.7, 'trials': 2.0, 'models': 3.0},  # Very aggressive
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
        max_extra_param = 1 if quality_mode in ['high', 'ultra', 'professional', 'ultra_professional'] else 0
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

    # Vocab tree matching disabled due to format incompatibility
    # Sequential/exhaustive matching provides sufficient coverage
    use_vocab_tree = False

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

        # Quality metadata
        'quality_mode': quality_mode,
        'total_expected_matches': int(num_images * float(matcher_params.get('SequentialMatching.overlap', '10')) if matcher_type == 'sequential' else num_images * (num_images - 1) / 2)
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
    if quality_mode in ['high', 'ultra', 'balanced']:
        base_config.update({
            'learning_rate': 0.0025,  # Lower learning rate for stability
            'position_lr_init': 0.00016,
            'position_lr_final': 0.0000016,
            'feature_lr': 0.0025,
            'opacity_lr': 0.05,
            'scaling_lr': 0.005,
            'rotation_lr': 0.001,
            'percent_dense': 0.1 if quality_mode == 'ultra' else 0.01,
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
    
    # Pass custom_params only if there are any non-None values
    colmap_config = get_colmap_config(
        num_images, 
        project_id, 
        quality_mode, 
        custom_params if custom_params else None
    )
    colmap_exe = get_colmap_executable()
    
    # Check if COLMAP has CUDA support
    colmap_info = subprocess.run([colmap_exe, '-h'], capture_output=True, text=True)
    has_cuda = 'with CUDA' in (colmap_info.stdout or '')
    
    return num_images, colmap_config, colmap_exe, has_cuda


def run_feature_extraction_stage(project_id, paths, config, colmap_config=None):
    """Run COLMAP Feature Extraction stage only."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    
    update_state(project_id, 'feature_extraction', status='running')
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: 0/{num_images}', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Extraction...")
    append_log_line(project_id, f"📊 Using optimized settings for {num_images} images")
    
    if has_cuda:
        append_log_line(project_id, "🚀 Using GPU-accelerated COLMAP for feature extraction")
    else:
        append_log_line(project_id, "⚠️ COLMAP CUDA support not detected; falling back to CPU mode")
    
    cmd = [
        colmap_exe, 'feature_extractor',
        '--database_path', str(paths['database_path']),
        '--image_path', str(paths['images_path']),
        '--ImageReader.camera_model', config['camera_model'],
        '--ImageReader.single_camera', '1',
        '--FeatureExtraction.use_gpu', '1' if has_cuda else '0',
        '--SiftExtraction.max_image_size', str(colmap_cfg['max_image_size']),
        '--SiftExtraction.max_num_features', str(colmap_cfg['max_num_features']),
        '--SiftExtraction.first_octave', str(colmap_cfg['first_octave']),
        '--SiftExtraction.num_octaves', str(colmap_cfg['num_octaves'])
    ]
    
    # Add enhanced SIFT parameters for high quality modes
    sift_params = colmap_cfg.get('sift_params', {})
    for param, value in sift_params.items():
        if value is not None:
            cmd.extend([f'--SiftExtraction.{param}', str(value)])
    
    progress_tracker = {'count': 0}
    
    def feature_line_handler(line):
        if num_images == 0:
            return
        
        if any(keyword in line.lower() for keyword in ['processing', 'processed', 'image', 'file', 'features']):
            append_log_line(project_id, f"[DEBUG] Feature extraction: {line.strip()}")
        
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
    
    run_command_with_logs(project_id, cmd, line_handler=feature_line_handler)
    
    update_state(project_id, 'feature_extraction', status='completed', progress=100)
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {num_images}/{num_images}', subtext='Feature extraction complete')
    append_log_line(project_id, "✅ COLMAP Feature Extraction completed")
    
    return colmap_cfg


def run_feature_matching_stage(project_id, paths, config, colmap_config=None):
    """Run COLMAP Feature Matching stage only."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    
    update_state(project_id, 'feature_matching', status='running')
    update_stage_detail(project_id, 'feature_matching', text='Matching pairs: 0/0', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Matching...")
    
    if has_cuda:
        append_log_line(project_id, "🚀 Using GPU-accelerated COLMAP for feature matching")
    else:
        append_log_line(project_id, "⚠️ COLMAP CUDA support not detected; falling back to CPU mode for matching")
    
    append_log_line(project_id, f"🔗 Using {colmap_cfg['matcher_type']} matcher")
    
    matching_progress = {'current': 0, 'total': 0}
    
    matcher_cmd = f'{colmap_cfg["matcher_type"]}_matcher'
    append_log_line(project_id, f"🔧 Running {colmap_cfg['matcher_type']} matcher...")
    
    cmd = [
        colmap_exe, matcher_cmd,
        '--database_path', str(paths['database_path']),
        '--FeatureMatching.max_num_matches', str(colmap_cfg['max_num_matches']),
        '--FeatureMatching.use_gpu', '1' if has_cuda else '0'
    ]
    
    for param, value in colmap_cfg['matcher_params'].items():
        cmd.extend([f'--{param}', value])
    
    def matching_line_handler(line):
        if any(keyword in line.lower() for keyword in ['matching', 'match', 'pair', 'block']):
            append_log_line(project_id, f"[DEBUG] Feature matching: {line.strip()}")
        
        if 'not enough gpu memory' in line.lower() or 'failed to create feature matcher' in line.lower():
            append_log_line(project_id, f"⚠️ GPU Memory Error detected: {line.strip()}")
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
                return
    
    try:
        run_command_with_logs(project_id, cmd, line_handler=matching_line_handler)
    except subprocess.CalledProcessError as e:
        if has_cuda and ('not enough gpu memory' in str(e).lower() or 
                       'failed to create feature matcher' in str(e).lower()):
            append_log_line(project_id, "⚠️ GPU feature matching failed due to memory constraints")
            append_log_line(project_id, f"🔄 Retrying with CPU-based matching (reduced max_matches={colmap_cfg['max_num_matches'] // 2})...")
            
            cmd_cpu = [
                colmap_exe, matcher_cmd,
                '--database_path', str(paths['database_path']),
                '--FeatureMatching.max_num_matches', str(colmap_cfg['max_num_matches'] // 2),
                '--FeatureMatching.use_gpu', '0'
            ]
            
            for param, value in colmap_cfg['matcher_params'].items():
                cmd_cpu.extend([f'--{param}', value])
            
            run_command_with_logs(project_id, cmd_cpu, line_handler=matching_line_handler)
            append_log_line(project_id, "✅ CPU-based matching completed successfully")
        else:
            raise
    
    update_state(project_id, 'feature_matching', status='completed', progress=100)
    current = matching_progress['current'] or matching_progress['total']
    total_pairs = matching_progress['total'] or matching_progress['current']
    if total_pairs:
        update_stage_detail(project_id, 'feature_matching', text=f'Matching pairs: {min(current, total_pairs)}/{total_pairs}', subtext='Feature matching complete')
    else:
        update_stage_detail(project_id, 'feature_matching', text='Feature matching complete', subtext=None)
    append_log_line(project_id, "✅ COLMAP Feature Matching completed")
    
    return colmap_cfg


def run_sparse_reconstruction_stage(project_id, paths, config, colmap_config=None):
    """Run Sparse Reconstruction stage using GLOMAP (fast) or COLMAP (classic)."""
    num_images, colmap_cfg, colmap_exe, has_cuda = get_colmap_config_for_pipeline(paths, config, project_id)
    if colmap_config:
        colmap_cfg = colmap_config
    
    # Determine which SfM engine to use
    sfm_engine = config.get('sfm_engine', 'glomap')  # Default to GLOMAP
    use_glomap = sfm_engine == 'glomap' and GLOMAP_PATH is not None
    
    update_state(project_id, 'sparse_reconstruction', status='running')
    update_stage_detail(project_id, 'sparse_reconstruction', text=f'Initializing...', subtext=f'{num_images} images')
    
    if use_glomap:
        append_log_line(project_id, "🚀 Running GLOMAP Global Structure-from-Motion (10-100x faster)")
        append_log_line(project_id, f"⚡ Global SfM mapper for {num_images} images")
        
        # GLOMAP command - simpler than COLMAP, uses database directly
        cmd = [
            GLOMAP_PATH, 'mapper',
            '--database_path', str(paths['database_path']),
            '--image_path', str(paths['images_path']),
            '--output_path', str(paths['sparse_path'])
        ]
        
        append_log_line(project_id, f"🔧 GLOMAP path: {GLOMAP_PATH}")
        
    else:
        if sfm_engine == 'glomap' and GLOMAP_PATH is None:
            append_log_line(project_id, "⚠️ GLOMAP not found, falling back to COLMAP")
        
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
    }
    
    def sparse_line_handler(line):
        if num_images == 0:
            return
        
        line_lower = line.lower()
        line_stripped = line.strip()
        
        # === GLOMAP-specific stage detection ===
        if use_glomap:
            # Detect GLOMAP sub-stages from output
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
                    sparse_tracker['current_glomap_stage'] = stage_key
                    stage_info = glomap_stages[stage_key]
                    progress = stage_info['progress']
                    
                    # Log the stage transition
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
                append_log_line(project_id, f"[GLOMAP] Bundle Adjustment iteration {ba_current}/{ba_total}")
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
            
            # Log important GLOMAP messages
            important_keywords = ['error', 'warning', 'failed', 'done', 'finished', 'seconds', 'images', 'tracks', 'cameras']
            if any(kw in line_lower for kw in important_keywords):
                append_log_line(project_id, f"[GLOMAP] {line_stripped}")
        
        # === COLMAP-specific patterns (fallback) ===
        else:
            # Log relevant lines for debugging
            keywords = ['registering', 'registered', 'reconstruction', 'bundle', 'mapper', 'image', 'track', 'camera']
            if any(keyword in line_lower for keyword in keywords):
                append_log_line(project_id, f"[COLMAP] {line_stripped}")
            
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
                    return
    
    run_command_with_logs(project_id, cmd, line_handler=sparse_line_handler)
    
    update_state(project_id, 'sparse_reconstruction', status='completed', progress=100)
    registered = sparse_tracker['registered'] if sparse_tracker['registered'] else num_images
    engine_name = "GLOMAP" if use_glomap else "COLMAP"
    update_stage_detail(project_id, 'sparse_reconstruction', text=f'Images registered: {min(registered, num_images)}/{num_images}', subtext=f'{engine_name} reconstruction complete')
    append_log_line(project_id, f"✅ Sparse Reconstruction completed using {engine_name}")
    
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

        colmap_config = get_colmap_config(num_images, project_id, quality_mode, custom_params)

        # Define COLMAP stage order for from_stage logic
        colmap_stages = ['feature_extraction', 'feature_matching', 'sparse_reconstruction', 'model_conversion']
        start_index = colmap_stages.index(from_stage) if from_stage in colmap_stages else 0

        # 1. Feature Extraction (skip if starting from later stage)
        if start_index <= colmap_stages.index('feature_extraction'):
            colmap_config = run_feature_extraction_stage(project_id, paths, config, colmap_config)

        # 2. Feature Matching (skip if starting from later stage)
        if start_index <= colmap_stages.index('feature_matching'):
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
        if quality_mode in ['high', 'ultra', 'custom', 'balanced']:
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

            append_log_line(project_id, f"⚡ Enhanced parameters: densify_threshold={densify_threshold}, refine_every={refine_every}")

        iteration_total = enhanced_iterations

        training_progress = {'current': 0, 'total': iteration_total}

        def training_line_handler(line):
            # Debug logging for training
            if any(keyword in line.lower() for keyword in ['iteration', 'step', 'epoch', 'training', 'iter']):
                append_log_line(project_id, f"[DEBUG] Training: {line.strip()}")

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

        run_command_with_logs(project_id, cmd, cwd=opensplat_working_dir, line_handler=training_line_handler)

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
        if quality_mode in ['high', 'ultra', 'custom', 'balanced']:
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

            append_log_line(project_id, f"⚡ Enhanced parameters: densify_threshold={densify_threshold}")

        iteration_total = enhanced_iterations
        training_progress = {'current': 0, 'total': iteration_total}

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
                    return

        run_command_with_logs(project_id, cmd, cwd=opensplat_working_dir, line_handler=training_line_handler)

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
