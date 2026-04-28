"""OpenSplat training and finalization stages."""

from __future__ import annotations

import json
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
    emit_training_live_preview,
    save_projects_db,
    update_stage_detail,
    update_reconstruction_framework,
    update_state,
)
from ..utils.video_processor import VideoProcessor
from .runtime_support import should_emit_progress_milestone, should_log_subprocess_line

logger = logging.getLogger(__name__)

TRAINING_LIVE_RENDER_DIRNAME = "live_training_preview"
TRAINING_LIVE_CONTROL_FILENAME = "live_training_preview_control.json"
DEFAULT_TRAINING_LIVE_RENDER_PERCENT_STEP = 2
ALLOWED_TRAINING_LIVE_RENDER_PERCENT_STEPS = {1, 2, 5}


def _calculate_progress_percent(current: int, total: int) -> int:
    if total <= 0:
        return 0
    return max(0, min(100, int((min(current, total) / total) * 100)))


def _training_live_render_percent_step(config: dict) -> int:
    try:
        value = int(config.get("training_live_preview_interval_percent"))
    except (TypeError, ValueError):
        return DEFAULT_TRAINING_LIVE_RENDER_PERCENT_STEP
    if value in ALLOWED_TRAINING_LIVE_RENDER_PERCENT_STEPS:
        return value
    return DEFAULT_TRAINING_LIVE_RENDER_PERCENT_STEP


def _reference_url_for_project_image(project_id: str, image_name: str) -> str | None:
    if not image_name:
        return None

    project_path = app_config.UPLOAD_FOLDER / project_id
    for folder, route in (
        ("images", "frame_preview"),
        ("training_images", "training_frame_preview"),
    ):
        candidate = project_path / folder / image_name
        if candidate.exists():
            try:
                version = candidate.stat().st_mtime_ns
            except FileNotFoundError:
                version = 0
            return f"/api/{route}/{project_id}/{image_name}?v={version}"
    return None


def _write_training_live_control(project_id: str, control_path: Path) -> None:
    control_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "project_id": project_id,
        "camera_id": 0,
        "image_name": "",
        "enabled": True,
        "version": int(datetime.now().timestamp() * 1_000_000_000),
        "updated_at": datetime.now().isoformat(),
    }
    temp_path = control_path.with_suffix(".tmp")
    temp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.replace(temp_path, control_path)


def _build_training_live_payload(project_id: str, render_data: dict) -> dict:
    filename = str(render_data.get("filename") or "")
    image_name = str(render_data.get("image_name") or "")
    render_path = app_config.RESULTS_FOLDER / project_id / TRAINING_LIVE_RENDER_DIRNAME / filename
    try:
        render_version = render_path.stat().st_mtime_ns
    except FileNotFoundError:
        render_version = int(datetime.now().timestamp() * 1_000_000_000)

    payload = {
        "project_id": project_id,
        "camera_id": render_data.get("camera_id"),
        "image_name": image_name,
        "filename": filename,
        "render_url": f"/api/project/{project_id}/training_live_preview/{filename}?v={render_version}",
        "frame_mime": "image/jpeg",
        "frame_bytes": None,
        "reference_url": _reference_url_for_project_image(project_id, image_name),
        "iteration": render_data.get("iteration"),
        "total_iterations": render_data.get("total_iterations"),
        "progress_percent": render_data.get("progress_percent"),
        "width": render_data.get("width"),
        "height": render_data.get("height"),
        "version": render_data.get("version", render_version),
        "updated_at": datetime.now().isoformat(),
    }
    try:
        payload["frame_bytes"] = render_path.read_bytes()
    except OSError:
        payload["frame_bytes"] = None
    return payload



def finalize_project(project_id):
    """Finalize project completion."""
    try:
        update_state(project_id, "finalizing", status="running")
        update_stage_detail(
            project_id, "finalizing", text="Packaging outputs...", subtext=None
        )
        update_state(project_id, "finalizing", status="completed", progress=100)
        update_stage_detail(
            project_id, "finalizing", text="Processing complete", subtext=None
        )

        with project_store.status_lock:
            project_store.processing_status[project_id]["status"] = "completed"
            project_store.processing_status[project_id]["end_time"] = (
                datetime.now().isoformat()
            )
            save_projects_db()

        append_log_line(project_id, "🎉 PobimSplats processing completed successfully!")
    except Exception as exc:
        logger.error("Finalization failed for %s: %s", project_id, exc)
        append_log_line(project_id, f"❌ Finalization Error: {str(exc)}")
        raise


def run_opensplat_training(
    project_id,
    paths,
    config,
    processing_start_time,
    time_estimate,
    time_estimator,
    *,
    helpers,
):
    """Run OpenSplat training and finalize the project."""
    try:
        images_path = paths["images_path"]
        num_images = len(
            [
                f
                for f in os.listdir(images_path)
                if f.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".tiff"))
            ]
        )

        update_state(project_id, "gaussian_splatting", status="running")
        project_entry = project_store.processing_status.get(project_id, {})
        framework = project_entry.get("reconstruction_framework") or {}
        resource_coordination = project_entry.get("resource_coordination") or {}
        recovery_history = framework.get("recovery_history") or []
        auto_tuning_summary = framework.get('auto_tuning_summary') or config.get('auto_tuning_summary') or {}
        capture_budget_summary = framework.get('capture_budget_summary') or resource_coordination.get('capture_budget_summary') or {}
        recovery_loop_summary = framework.get('recovery_loop_summary') or {}
        training_budget_summary = {
            'resource_profile_class': (
                (framework.get('resource_profile') or {}).get('profile_class')
                or resource_coordination.get('profile_class')
            ),
            'resource_lane': framework.get('resource_lane') or resource_coordination.get('resource_lane'),
            'resource_lane_state': framework.get('resource_lane_state') or resource_coordination.get('resource_lane_state'),
            'training_resolution': config.get('training_resolution', '4K'),
            'colmap_resolution': config.get('colmap_resolution', '2K'),
            'use_separate_training_images': bool(config.get('use_separate_training_images', False)),
            'adaptive_frame_budget': bool(config.get('adaptive_frame_budget', True)),
            'adaptive_pair_scheduling': bool(config.get('adaptive_pair_scheduling', True)),
            'repair_step_count': len(recovery_history),
            'uses_repaired_capture': len(recovery_history) > 0,
            'repair_depth': recovery_loop_summary.get('state'),
            'recovery_final_path': recovery_loop_summary.get('final_path'),
            'auto_tuning_mode': auto_tuning_summary.get('active_mode'),
            'auto_tuning_confidence': auto_tuning_summary.get('confidence'),
            'effective_image_budget': capture_budget_summary.get('num_images') or num_images,
            'effective_oversample_factor': capture_budget_summary.get('effective_oversample_factor'),
        }
        update_reconstruction_framework(
            project_id,
            {
                'training_budget_summary': training_budget_summary,
            },
        )

        quality_mode = config.get("quality_mode", "balanced")
        training_recommendation = helpers["get_opensplat_runtime_recommendation"](
            quality_mode,
            num_images,
            config,
        )

        enhanced_iterations = training_recommendation["iterations"]
        live_render_percent_step = _training_live_render_percent_step(config)
        if quality_mode == "custom":
            append_log_line(
                project_id,
                f"🔧 Using custom quality mode: {enhanced_iterations} iterations",
            )
        else:
            append_log_line(
                project_id,
                f"🎯 Using {quality_mode} quality mode: {enhanced_iterations} iterations",
            )

        elapsed = time.time() - processing_start_time
        estimated_remaining = max(0, time_estimate.total_seconds - elapsed)
        progress_pct = min(95, int((elapsed / time_estimate.total_seconds) * 100))
        append_log_line(
            project_id,
            f"⏱️  Progress: {progress_pct}% | Remaining: ~{time_estimator.format_time_display(estimated_remaining)}",
        )

        update_stage_detail(
            project_id,
            "gaussian_splatting",
            text=f"Training iterations: 0/{enhanced_iterations}",
            subtext=f"Quality: {quality_mode.title()}",
        )
        append_log_line(
            project_id, "🔄 Running High-Quality Gaussian Splatting Training..."
        )
        append_log_line(
            project_id,
            "🧠 Training budget context: "
            f"profile={training_budget_summary.get('resource_profile_class', '--')} | "
            f"lane={training_budget_summary.get('resource_lane', '--')} | "
            f"repair_steps={training_budget_summary.get('repair_step_count', 0)} | "
            f"separate_training={'yes' if training_budget_summary.get('use_separate_training_images') else 'no'}",
        )
        append_log_line(
            project_id,
            "🧮 Upload-resolved training plan: "
            f"{training_recommendation.get('summary')}",
        )

        opensplat_binary = app_config.OPENSPLAT_BINARY_PATH
        if opensplat_binary.is_dir():
            potential_binary = opensplat_binary / "opensplat"
            if potential_binary.exists():
                opensplat_binary = potential_binary
        if not opensplat_binary.exists():
            raise Exception(f"OpenSplat binary not found at {opensplat_binary}")
        opensplat_working_dir = (
            opensplat_binary.parent if opensplat_binary.is_file() else opensplat_binary
        )

        output_ply = (
            paths["results_path"]
            / f"{project_id}_{quality_mode}_{enhanced_iterations}iter.ply"
        )
        live_render_dir = paths["results_path"] / TRAINING_LIVE_RENDER_DIRNAME
        live_render_control_path = (
            paths["results_path"] / TRAINING_LIVE_CONTROL_FILENAME
        )
        live_render_dir.mkdir(parents=True, exist_ok=True)
        _write_training_live_control(project_id, live_render_control_path)
        cmd = [
            str(opensplat_binary),
            str(paths["project_path"].absolute()),
            "-n",
            str(enhanced_iterations),
            "--output",
            str(output_ply.absolute()),
            "--live-render-dir",
            str(live_render_dir.absolute()),
            "--live-render-control",
            str(live_render_control_path.absolute()),
            "--live-render-every-percent",
            str(live_render_percent_step),
        ]
        append_log_line(
            project_id,
            f"📡 Native live comparison renders enabled every {live_render_percent_step}% "
            "(source resolution, binary websocket delivery)",
        )

        crop_size = config.get("crop_size", 0)
        if crop_size > 0:
            cmd.extend(["--crop-size", str(crop_size)])
            append_log_line(
                project_id, f"🧩 Using patch-based training with crop size: {crop_size}"
            )

        use_separate = config.get("use_separate_training_images", False)
        training_images_path = paths.get("training_images_path")
        if use_separate and training_images_path:
            training_images_count = (
                len(list(training_images_path.glob("*")))
                if training_images_path.exists()
                else 0
            )
            if training_images_count == 0:
                append_log_line(
                    project_id,
                    "⚠️ Training images folder is empty, attempting to extract...",
                )
                project_path = paths["project_path"]
                video_files = []
                for ext in [
                    ".mp4",
                    ".mov",
                    ".avi",
                    ".mkv",
                    ".webm",
                    ".MP4",
                    ".MOV",
                    ".AVI",
                    ".MKV",
                    ".WEBM",
                ]:
                    video_files.extend(list(project_path.glob(f"*{ext}")))
                if video_files:
                    video_processor = VideoProcessor()
                    training_resolution = config.get("training_resolution", "4K")
                    training_images_path.mkdir(parents=True, exist_ok=True)
                    for video_path in video_files:
                        append_log_line(
                            project_id,
                            f"   📹 Extracting training frames from {video_path.name} at {training_resolution}...",
                        )
                        training_config = {
                            "max_frames": config.get("max_frames", 200),
                            "min_frames": config.get("min_frames", 30),
                            "resolution": training_resolution,
                            "quality": 100,
                            "use_gpu": config.get("use_gpu_extraction", True),
                            "ffmpeg_cpu_workers": config.get("ffmpeg_cpu_workers", 8),
                            "replacement_search_radius": config.get(
                                "replacement_search_radius", 4
                            ),
                            "motion_threshold": config.get("motion_threshold", 0.15),
                            "blur_threshold": config.get("blur_threshold", 100),
                        }
                        training_extracted = video_processor.extract_frames(
                            str(video_path),
                            training_images_path,
                            extraction_config=training_config,
                            progress_callback=None,
                        )
                        append_log_line(
                            project_id,
                            f"   ✅ Extracted {len(training_extracted)} high-res training frames",
                        )
                    training_images_count = len(list(training_images_path.glob("*")))
                else:
                    append_log_line(
                        project_id,
                        "   ℹ️ No video files found, will use images folder for training",
                    )
            if training_images_count > 0:
                cmd.extend(
                    ["--colmap-image-path", str(training_images_path.absolute())]
                )
                append_log_line(
                    project_id,
                    f"🎯 Using high-res training images: {training_images_count} images from {training_images_path.name}",
                )
                append_log_line(
                    project_id,
                    f"   📐 Training resolution: {config.get('training_resolution', '4K')}",
                )
            else:
                append_log_line(
                    project_id,
                    "⚠️ No training images available, using COLMAP images for training",
                )
        elif use_separate:
            append_log_line(
                project_id, "⚠️ Training images path not configured, using COLMAP images"
            )

        if training_recommendation.get("refine_every") is not None:
            densify_threshold = training_recommendation.get("densify_grad_threshold")
            refine_every = training_recommendation.get("refine_every")
            warmup = training_recommendation.get("warmup_length")
            ssim = training_recommendation.get("ssim_weight")
            reset_alpha_every = training_recommendation.get("reset_alpha_every")

            if densify_threshold is not None:
                cmd.extend(["--densify-grad-thresh", str(densify_threshold)])
            cmd.extend(["--refine-every", str(refine_every)])
            cmd.extend(["--warmup-length", str(warmup)])
            cmd.extend(["--ssim-weight", str(ssim)])
            if reset_alpha_every is not None:
                cmd.extend(["--reset-alpha-every", str(reset_alpha_every)])
            append_log_line(
                project_id,
                f"⚡ Enhanced parameters: densify_threshold={densify_threshold}, refine_every={refine_every}, warmup={warmup}, ssim={ssim}",
            )

        if config.get("mixed_precision", False):
            cmd.extend(["--mixed-precision"])
            append_log_line(
                project_id,
                "🔥 Mixed Precision (FP16) enabled - faster training, lower VRAM usage",
            )

        iteration_total = enhanced_iterations
        training_progress = {"current": 0, "total": iteration_total}
        training_progress_log = {"last_bucket": -1}
        splats_state = {"current": 0, "max": 0}

        splats_patterns = (
            re.compile(r"new count\s+(\d+)", re.IGNORECASE),
            re.compile(r"remaining\s+(\d+)", re.IGNORECASE),
            re.compile(r"Loaded\s+(\d+)\s+gaussians", re.IGNORECASE),
        )

        def _update_splats_from_line(line):
            for pattern in splats_patterns:
                match = pattern.search(line)
                if match:
                    try:
                        count = int(match.group(1))
                    except (TypeError, ValueError):
                        return
                    splats_state["current"] = count
                    if count > splats_state["max"]:
                        splats_state["max"] = count
                    return

        def _format_count(value):
            try:
                return f"{int(value):,}"
            except (TypeError, ValueError):
                return str(value)

        def _splats_suffix():
            max_count = splats_state["max"]
            if max_count <= 0:
                return ""
            current = splats_state["current"] or max_count
            return (
                f" | Splats: {_format_count(current)} (max {_format_count(max_count)})"
            )

        def training_line_handler(line):
            _update_splats_from_line(line)
            line_stripped = line.strip()
            if line_stripped:
                if line_stripped.startswith("LIVE_RENDER "):
                    try:
                        render_data = json.loads(
                            line_stripped.removeprefix("LIVE_RENDER ").strip()
                        )
                        live_payload = _build_training_live_payload(
                            project_id, render_data
                        )
                        emit_training_live_preview(project_id, live_payload)
                    except Exception as exc:
                        append_log_line(
                            project_id,
                            f"[live_render error] {exc}",
                        )
                    return

            patterns = [
                r"Iteration\s+(\d+)/(\d+)",
                r"Step\s+(\d+)/(\d+)",
                r"Epoch\s+(\d+)/(\d+)",
                r"Progress:\s+(\d+)/(\d+)",
                r"Training\s+(\d+)/(\d+)",
                r"iter\s*:\s*(\d+)\s*/\s*(\d+)",
                r"(\d+)\s*/\s*(\d+)\s*iterations?",
                r"Iteration\s+(\d+)\s+\(.*?\)\s*/\s*(\d+)",
                r"\[(\d+)/(\d+)\]",
                r"it\s*(\d+)/(\d+)",
                r"step\s*(\d+)\s*\/\s*(\d+)",
            ]
            for pattern in patterns:
                match = re.search(pattern, line, re.IGNORECASE)
                if match:
                    current = int(match.group(1))
                    total = int(match.group(2))
                    training_progress["current"] = current
                    training_progress["total"] = total
                    if total != iteration_total and iteration_total > 0:
                        total = iteration_total
                    if total > 0:
                        percent = int((min(current, total) / total) * 100)
                        splats_subtext = None
                        if splats_state["max"] > 0:
                            splats_subtext = (
                                f"Splats: {_format_count(splats_state['current'] or splats_state['max'])} "
                                f"(max {_format_count(splats_state['max'])})"
                            )
                        details = {
                            "text": f"Training iterations: {current}/{total}",
                            "current_item": current,
                            "total_items": total,
                            "item_name": f"Iteration {current}",
                        }
                        if splats_state["max"] > 0:
                            details["max_splats"] = splats_state["max"]
                            details["current_splats"] = (
                                splats_state["current"] or splats_state["max"]
                            )
                        emit_stage_progress(
                            project_id, "gaussian_splatting", percent, details
                        )
                        update_state(
                            project_id,
                            "gaussian_splatting",
                            progress=min(percent, 99),
                            details=details,
                        )
                        update_stage_detail(
                            project_id,
                            "gaussian_splatting",
                            text=f"Training iterations: {current}/{total}",
                            subtext=splats_subtext,
                        )
                        should_log, progress_percent = should_emit_progress_milestone(
                            training_progress_log, current, total, percent_step=1
                        )
                        if should_log:
                            append_log_line(
                                project_id,
                                f"🏋️ Training progress: {current}/{total} iterations ({progress_percent}%){_splats_suffix()}",
                            )
                    return
            if any(keyword in line.lower() for keyword in ["iteration", "step"]):
                number_match = re.search(r"(\d+)", line)
                if number_match:
                    current = int(number_match.group(1))
                    if iteration_total > 0 and current <= iteration_total:
                        percent = int((current / iteration_total) * 100)
                        training_progress["current"] = current
                        training_progress["total"] = iteration_total
                        splats_subtext = None
                        if splats_state["max"] > 0:
                            splats_subtext = (
                                f"Splats: {_format_count(splats_state['current'] or splats_state['max'])} "
                                f"(max {_format_count(splats_state['max'])})"
                            )
                        details = {
                            "text": f"Training iterations: {current}/{iteration_total}",
                            "current_item": current,
                            "total_items": iteration_total,
                            "item_name": f"Step {current}",
                        }
                        if splats_state["max"] > 0:
                            details["max_splats"] = splats_state["max"]
                            details["current_splats"] = (
                                splats_state["current"] or splats_state["max"]
                            )
                        emit_stage_progress(
                            project_id, "gaussian_splatting", percent, details
                        )
                        update_state(
                            project_id,
                            "gaussian_splatting",
                            progress=min(percent, 99),
                            details=details,
                        )
                        update_stage_detail(
                            project_id,
                            "gaussian_splatting",
                            text=f"Training iterations: {current}/{iteration_total}",
                            subtext=splats_subtext,
                        )
                        should_log, progress_percent = should_emit_progress_milestone(
                            training_progress_log,
                            current,
                            iteration_total,
                            percent_step=1,
                        )
                        if should_log:
                            append_log_line(
                                project_id,
                                f"🏋️ Training progress: {current}/{iteration_total} iterations ({progress_percent}%){_splats_suffix()}",
                            )

        run_command_with_logs(
            project_id,
            cmd,
            cwd=opensplat_working_dir,
            line_handler=training_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )

        update_state(project_id, "gaussian_splatting", status="completed", progress=100)
        current = training_progress["current"] or iteration_total or 0
        total = training_progress["total"] or iteration_total or current
        final_subtext = "Training complete"
        if splats_state["max"] > 0:
            final_subtext = (
                f"Training complete | Max splats: {_format_count(splats_state['max'])}"
            )
        if total:
            update_stage_detail(
                project_id,
                "gaussian_splatting",
                text=f"Training iterations: {min(current, total)}/{total}",
                subtext=final_subtext,
            )
        else:
            update_stage_detail(
                project_id, "gaussian_splatting", text="Training complete", subtext=None
            )
        if splats_state["max"] > 0:
            append_log_line(
                project_id,
                f"✅ PobimSplats Training completed | Max splats: {_format_count(splats_state['max'])}",
            )
        else:
            append_log_line(project_id, "✅ PobimSplats Training completed")
        finalize_project(project_id)
    except Exception as exc:
        logger.error("OpenSplat training failed for %s: %s", project_id, exc)
        append_log_line(project_id, f"❌ Training Error: {str(exc)}")
        raise
