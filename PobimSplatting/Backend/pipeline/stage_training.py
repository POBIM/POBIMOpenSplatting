"""OpenSplat training and finalization stages."""

from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime
from pathlib import Path

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
from .runtime_support import should_emit_progress_milestone, should_log_subprocess_line

logger = logging.getLogger(__name__)


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
    except Exception as exc:
        logger.error("Finalization failed for %s: %s", project_id, exc)
        append_log_line(project_id, f"❌ Finalization Error: {str(exc)}")
        raise


def run_opensplat_training(project_id, paths, config, processing_start_time, time_estimate, time_estimator, *, helpers):
    """Run OpenSplat training and finalize the project."""
    try:
        images_path = paths['images_path']
        num_images = len([f for f in os.listdir(images_path) if f.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.tiff'))])

        update_state(project_id, 'gaussian_splatting', status='running')

        quality_mode = config.get('quality_mode', 'balanced')
        custom_params = config if quality_mode == 'custom' else None
        opensplat_config = helpers['get_opensplat_config'](quality_mode, num_images, custom_params)

        enhanced_iterations = opensplat_config['iterations']
        if quality_mode == 'custom':
            append_log_line(project_id, f"🔧 Using custom quality mode: {enhanced_iterations} iterations")
        else:
            append_log_line(project_id, f"🎯 Using {quality_mode} quality mode: {enhanced_iterations} iterations")

        elapsed = time.time() - processing_start_time
        estimated_remaining = max(0, time_estimate.total_seconds - elapsed)
        progress_pct = min(95, int((elapsed / time_estimate.total_seconds) * 100))
        append_log_line(project_id, f"⏱️  Progress: {progress_pct}% | Remaining: ~{time_estimator.format_time_display(estimated_remaining)}")

        update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: 0/{enhanced_iterations}', subtext=f'Quality: {quality_mode.title()}')
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
        cmd = [str(opensplat_binary), str(paths['project_path'].absolute()), '-n', str(enhanced_iterations), '--output', str(output_ply.absolute())]

        crop_size = config.get('crop_size', 0)
        if crop_size > 0:
            cmd.extend(['--crop-size', str(crop_size)])
            append_log_line(project_id, f"🧩 Using patch-based training with crop size: {crop_size}")

        use_separate = config.get('use_separate_training_images', False)
        training_images_path = paths.get('training_images_path')
        if use_separate and training_images_path:
            training_images_count = len(list(training_images_path.glob('*'))) if training_images_path.exists() else 0
            if training_images_count == 0:
                append_log_line(project_id, "⚠️ Training images folder is empty, attempting to extract...")
                project_path = paths['project_path']
                video_files = []
                for ext in ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.MP4', '.MOV', '.AVI', '.MKV', '.WEBM']:
                    video_files.extend(list(project_path.glob(f'*{ext}')))
                if video_files:
                    video_processor = VideoProcessor()
                    training_resolution = config.get('training_resolution', '4K')
                    training_images_path.mkdir(parents=True, exist_ok=True)
                    for video_path in video_files:
                        append_log_line(project_id, f"   📹 Extracting training frames from {video_path.name} at {training_resolution}...")
                        training_config = {
                            'max_frames': config.get('max_frames', 200),
                            'min_frames': config.get('min_frames', 30),
                            'resolution': training_resolution,
                            'quality': 100,
                            'use_gpu': config.get('use_gpu_extraction', True),
                            'ffmpeg_cpu_workers': config.get('ffmpeg_cpu_workers', 4),
                            'replacement_search_radius': config.get('replacement_search_radius', 4),
                            'motion_threshold': config.get('motion_threshold', 0.15),
                            'blur_threshold': config.get('blur_threshold', 100),
                        }
                        training_extracted = video_processor.extract_frames(str(video_path), training_images_path, extraction_config=training_config, progress_callback=None)
                        append_log_line(project_id, f"   ✅ Extracted {len(training_extracted)} high-res training frames")
                    training_images_count = len(list(training_images_path.glob('*')))
                else:
                    append_log_line(project_id, "   ℹ️ No video files found, will use images folder for training")
            if training_images_count > 0:
                cmd.extend(['--colmap-image-path', str(training_images_path.absolute())])
                append_log_line(project_id, f"🎯 Using high-res training images: {training_images_count} images from {training_images_path.name}")
                append_log_line(project_id, f"   📐 Training resolution: {config.get('training_resolution', '4K')}")
            else:
                append_log_line(project_id, "⚠️ No training images available, using COLMAP images for training")
        elif use_separate:
            append_log_line(project_id, "⚠️ Training images path not configured, using COLMAP images")

        if quality_mode in ['high', 'ultra', 'hard', 'custom', 'balanced']:
            densify_threshold = opensplat_config.get('densify_grad_threshold')
            refine_every = 75
            warmup = 750
            ssim = 0.25

            if quality_mode == 'custom':
                custom_densify = config.get('densify_grad_threshold')
                custom_refine = config.get('refine_every')
                custom_warmup = config.get('warmup_length')
                custom_ssim = config.get('ssim_weight')
                if custom_densify is not None:
                    densify_threshold = custom_densify
                if custom_refine is not None:
                    refine_every = custom_refine
                if custom_warmup is not None:
                    warmup = custom_warmup
                if custom_ssim is not None:
                    ssim = custom_ssim
                append_log_line(project_id, f"🔧 Custom OpenSplat params: densify={densify_threshold}, refine={refine_every}, warmup={warmup}, ssim={ssim}")
            elif quality_mode == 'ultra':
                refine_every = 50
                warmup = 1000
                ssim = 0.3
            elif quality_mode == 'hard':
                refine_every = 60
                warmup = 900
                ssim = 0.28

            if densify_threshold is not None:
                cmd.extend(['--densify-grad-thresh', str(densify_threshold)])
            cmd.extend(['--refine-every', str(refine_every)])
            cmd.extend(['--warmup-length', str(warmup)])
            cmd.extend(['--ssim-weight', str(ssim)])
            if quality_mode == 'ultra':
                cmd.extend(['--reset-alpha-every', '20'])
            elif quality_mode == 'hard':
                cmd.extend(['--reset-alpha-every', '24'])
            append_log_line(project_id, f"⚡ Enhanced parameters: densify_threshold={densify_threshold}, refine_every={refine_every}")

        if config.get('mixed_precision', False):
            cmd.extend(['--mixed-precision'])
            append_log_line(project_id, "🔥 Mixed Precision (FP16) enabled - faster training, lower VRAM usage")

        iteration_total = enhanced_iterations
        training_progress = {'current': 0, 'total': iteration_total}
        training_progress_log = {'last_milestone': -1}

        def training_line_handler(line):
            patterns = [
                r'Iteration\s+(\d+)/(\d+)',
                r'Step\s+(\d+)/(\d+)',
                r'Epoch\s+(\d+)/(\d+)',
                r'Progress:\s+(\d+)/(\d+)',
                r'Training\s+(\d+)/(\d+)',
                r'iter\s*:\s*(\d+)\s*/\s*(\d+)',
                r'(\d+)\s*/\s*(\d+)\s*iterations?',
                r'Iteration\s+(\d+)\s+\(.*?\)\s*/\s*(\d+)',
                r'\[(\d+)/(\d+)\]',
                r'it\s*(\d+)/(\d+)',
                r'step\s*(\d+)\s*\/\s*(\d+)',
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
                        details = {'text': f'Training iterations: {current}/{total}', 'current_item': current, 'total_items': total, 'item_name': f'Iteration {current}'}
                        emit_stage_progress(project_id, 'gaussian_splatting', percent, details)
                        update_state(project_id, 'gaussian_splatting', progress=min(percent, 99), details=details)
                        update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {current}/{total}', subtext=None)
                        should_log, progress_percent = should_emit_progress_milestone(training_progress_log, current, total)
                        if should_log:
                            append_log_line(project_id, f"🏋️ Training progress: {current}/{total} iterations ({progress_percent}%)")
                    return
            if any(keyword in line.lower() for keyword in ['iteration', 'step']):
                number_match = re.search(r'(\d+)', line)
                if number_match:
                    current = int(number_match.group(1))
                    if iteration_total > 0 and current <= iteration_total:
                        percent = int((current / iteration_total) * 100)
                        training_progress['current'] = current
                        training_progress['total'] = iteration_total
                        details = {'text': f'Training iterations: {current}/{iteration_total}', 'current_item': current, 'total_items': iteration_total, 'item_name': f'Step {current}'}
                        emit_stage_progress(project_id, 'gaussian_splatting', percent, details)
                        update_state(project_id, 'gaussian_splatting', progress=min(percent, 99), details=details)
                        update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {current}/{iteration_total}', subtext=None)
                        should_log, progress_percent = should_emit_progress_milestone(training_progress_log, current, iteration_total)
                        if should_log:
                            append_log_line(project_id, f"🏋️ Training progress: {current}/{iteration_total} iterations ({progress_percent}%)")

        run_command_with_logs(project_id, cmd, cwd=opensplat_working_dir, line_handler=training_line_handler, raw_line_filter=should_log_subprocess_line)

        update_state(project_id, 'gaussian_splatting', status='completed', progress=100)
        current = training_progress['current'] or iteration_total or 0
        total = training_progress['total'] or iteration_total or current
        if total:
            update_stage_detail(project_id, 'gaussian_splatting', text=f'Training iterations: {min(current, total)}/{total}', subtext='Training complete')
        else:
            update_stage_detail(project_id, 'gaussian_splatting', text='Training complete', subtext=None)
        append_log_line(project_id, "✅ PobimSplats Training completed")
        finalize_project(project_id)
    except Exception as exc:
        logger.error("OpenSplat training failed for %s: %s", project_id, exc)
        append_log_line(project_id, f"❌ Training Error: {str(exc)}")
        raise
