"""Sparse reconstruction and model organization stages."""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

from ..core.commands import run_command_with_logs
from ..core.projects import (
    append_log_line,
    emit_sparse_pose_update,
    emit_stage_progress,
    update_stage_detail,
    update_state,
)
from .orbit_policy import (
    apply_no_regression_floor,
    capture_no_regression_floor,
    merge_no_regression_floors,
    sync_reconstruction_framework,
)
from .runtime_support import (
    FASTMAP_PATH,
    GLOMAP_PATH,
    describe_colmap_bundle_adjustment_mode,
    get_pycolmap_module,
    normalize_sfm_backend,
    normalize_sfm_engine,
    pycolmap_supports_global_mapping,
    resolve_global_sfm_backend,
    should_emit_progress_milestone,
    should_log_subprocess_line,
)

LIVE_SPARSE_POSE_UPDATE_IMAGE_STEP = 1


SPARSE_RUNTIME_OVERRIDE_KEYS = {
    "min_num_matches",
    "max_num_models",
    "init_num_trials",
    "structure_less_registration_fallback",
    "abs_pose_max_error",
    "abs_pose_min_num_inliers",
    "abs_pose_min_inlier_ratio",
    "max_reg_trials",
    "cpu_sparse_registration_profile",
}


def _has_sparse_runtime_overrides(config) -> bool:
    return any(config.get(key) not in (None, "") for key in SPARSE_RUNTIME_OVERRIDE_KEYS)


def _merge_sparse_runtime_overrides(base_cfg, override_cfg):
    merged = dict(base_cfg or {})
    for key in (
        "min_num_matches",
        "min_model_size",
        "max_num_models",
        "init_num_trials",
        "max_extra_param",
    ):
        if key in (override_cfg or {}):
            merged[key] = override_cfg[key]

    merged_mapper_params = dict((base_cfg or {}).get("mapper_params") or {})
    merged_mapper_params.update(dict((override_cfg or {}).get("mapper_params") or {}))
    if merged_mapper_params:
        merged["mapper_params"] = merged_mapper_params

    return merged


def _resolve_mapper_cpu_threads(config) -> tuple[int, int, int | None]:
    detected_threads = os.cpu_count() or 8
    requested_threads = config.get("mapper_cpu_threads")
    if requested_threads in (None, ""):
        return detected_threads, detected_threads, None

    try:
        requested_threads = int(requested_threads)
    except (TypeError, ValueError):
        return detected_threads, detected_threads, None

    if requested_threads <= 0:
        return detected_threads, detected_threads, requested_threads

    max_reasonable_threads = max(detected_threads, detected_threads * 2)
    return min(requested_threads, max_reasonable_threads), detected_threads, requested_threads


def _choose_live_sparse_snapshot_frequency(num_images: int) -> int:
    return 1


def _log_colmap_ba_plan(project_id, ba_plan):
    if not ba_plan:
        return

    icon = "🚀" if ba_plan.get("mode", "").startswith("gpu") else "ℹ️"
    append_log_line(
        project_id,
        f"{icon} BA mode: {ba_plan.get('runtime_summary', ba_plan.get('summary', 'Bundle adjustment'))}",
    )
    append_log_line(
        project_id,
        f"ℹ️ BA plan: {ba_plan.get('detail', 'COLMAP mapper registration remains CPU-heavy.')}",
    )


def _maybe_log_colmap_ba_runtime_event(project_id, line, sparse_tracker, ba_plan):
    if not ba_plan:
        return False

    line_lower = line.lower()
    mentions_ba = "bundle adjustment" in line_lower
    mentions_solver = "dense_schur" in line_lower or "sparse_schur" in line_lower
    mentions_cpu_fallback = (
        "falling back to cpu" in line_lower
        or "compiled without cuda support" in line_lower
    )

    if not (mentions_ba or mentions_solver or mentions_cpu_fallback):
        return False

    if (
        mentions_ba
        and not sparse_tracker.get("ba_runtime_phase_logged")
        and not re.search(
            r"global bundle adjustment iteration\s*\d+\s*/\s*\d+", line_lower
        )
    ):
        append_log_line(
            project_id,
            f"[COLMAP] Bundle adjustment phase started: {ba_plan.get('runtime_summary', ba_plan.get('summary', 'Bundle adjustment'))}",
        )
        sparse_tracker["ba_runtime_phase_logged"] = True

    solver_label = None
    if "sparse_schur" in line_lower and "cudss" in line_lower:
        solver_label = "GPU sparse BA via cuDSS (SPARSE_SCHUR)"
    elif "dense_schur" in line_lower:
        solver_label = "GPU dense BA (DENSE_SCHUR)"
    elif "sparse_schur" in line_lower:
        solver_label = "GPU sparse BA (SPARSE_SCHUR)"
    elif mentions_cpu_fallback:
        solver_label = "CPU bundle adjustment fallback"

    if solver_label and sparse_tracker.get("last_ba_solver_label") != solver_label:
        append_log_line(project_id, f"[COLMAP] BA solver: {solver_label}")
        sparse_tracker["last_ba_solver_label"] = solver_label

    return (
        sparse_tracker.get("ba_runtime_phase_logged", False) or solver_label is not None
    )


def try_run_pycolmap_global_mapping(project_id, paths, config, colmap_cfg, num_images):
    pycolmap = get_pycolmap_module()
    if not pycolmap_supports_global_mapping():
        append_log_line(
            project_id,
            "⚠️ Experimental pycolmap global mapping requested, but this environment does not provide pycolmap.global_mapping",
        )
        return False

    try:
        append_log_line(project_id, "🧪 Experimental backend: pycolmap.global_mapping")
        update_stage_detail(
            project_id,
            "sparse_reconstruction",
            text="Initializing experimental pycolmap global mapping...",
            subtext=f"{num_images} images",
        )
        emit_stage_progress(
            project_id,
            "sparse_reconstruction",
            5,
            {
                "text": "Initializing experimental pycolmap global mapping",
                "current_item": 5,
                "total_items": 100,
                "item_name": "initializing",
                "sfm_engine": "glomap",
                "sfm_backend": "pycolmap",
            },
        )

        mapper_options = pycolmap.GlobalMapperOptions()
        bundle_adjustment = pycolmap.BundleAdjustmentOptions()
        pipeline_options = pycolmap.IncrementalPipelineOptions()

        for attr, target in (
            ("min_num_matches", mapper_options),
            ("min_model_size", mapper_options),
            ("max_num_models", mapper_options),
            ("init_num_trials", mapper_options),
        ):
            if hasattr(target, attr):
                setattr(target, attr, int(colmap_cfg.get(attr)))

        append_log_line(project_id, "🧪 Running pycolmap.global_mapping")
        pycolmap.global_mapping(
            str(paths["database_path"]),
            str(paths["image_path"] if "image_path" in paths else paths["images_path"]),
            str(paths["sparse_path"]),
            mapper_options=mapper_options,
            bundle_adjustment_options=bundle_adjustment,
            options=pipeline_options,
        )
        append_log_line(project_id, "✅ pycolmap.global_mapping completed")
        return True
    except Exception as exc:
        append_log_line(
            project_id,
            f"⚠️ pycolmap.global_mapping failed, falling back to CLI backend: {exc}",
        )
        return False


def run_sparse_reconstruction_stage(
    project_id, paths, config, colmap_config=None, *, helpers
):
    """Run sparse reconstruction using FastMap, global mapper, or incremental COLMAP."""
    num_images, colmap_cfg, colmap_exe, has_cuda = helpers[
        "get_colmap_config_for_pipeline"
    ](paths, config, project_id)
    if colmap_config:
        if _has_sparse_runtime_overrides(config):
            colmap_cfg = _merge_sparse_runtime_overrides(colmap_config, colmap_cfg)
        else:
            colmap_cfg = colmap_config
    colmap_cfg, _ = apply_no_regression_floor(
        colmap_cfg, project_id=project_id, reason="before sparse reconstruction"
    )
    colmap_cfg = helpers["refine_orbit_safe_profile_from_geometry"](
        paths, colmap_cfg, project_id
    )
    sync_reconstruction_framework(
        project_id, config, colmap_cfg, phase="sparse_reconstruction"
    )
    if (
        colmap_cfg.get("recovery_matching_pass")
        and not colmap_cfg.get("pre_sparse_recovery_attempted")
    ):
        colmap_cfg["pre_sparse_recovery_attempted"] = True
        append_log_line(
            project_id,
            "🧠 Running the queued recovery matching pass before mapper registration starts",
        )
        helpers["clear_sparse_reconstruction_outputs"](paths["sparse_path"])
        colmap_cfg = helpers["run_orbit_safe_bridge_recovery_matching_pass"](
            project_id, paths, config, colmap_exe, colmap_cfg, has_cuda
        )
        return run_sparse_reconstruction_stage(
            project_id, paths, config, colmap_cfg, helpers=helpers
        )

    sfm_engine = normalize_sfm_engine(config.get("sfm_engine", "glomap"))
    sparse_retry_sfm_engine = config.get("sparse_retry_sfm_engine")
    if sparse_retry_sfm_engine:
        sfm_engine = normalize_sfm_engine(sparse_retry_sfm_engine)
        append_log_line(
            project_id,
            f"🔁 Sparse retry override: using {sfm_engine} engine for this reconstruction pass",
        )

    force_cpu_sparse_reconstruction = bool(
        config.get("force_cpu_sparse_reconstruction", True)
    )
    sparse_has_cuda = has_cuda and not force_cpu_sparse_reconstruction
    if force_cpu_sparse_reconstruction:
        append_log_line(
            project_id,
            "ℹ️ CPU-only sparse reconstruction is enabled for this pass",
        )

    sfm_backend = normalize_sfm_backend(config.get("sfm_backend"))
    global_backend = (
        resolve_global_sfm_backend(colmap_exe) if sfm_engine == "glomap" else None
    )
    use_global_sfm = global_backend is not None
    use_legacy_glomap = (
        global_backend is not None and global_backend["mode"] == "legacy_glomap"
    )
    use_fastmap = sfm_engine == "fastmap" and FASTMAP_PATH is not None
    use_pycolmap_global = (
        sfm_backend == "pycolmap" and use_global_sfm and not use_legacy_glomap
    )
    fastmap_temp_dir = None
    ba_plan = None

    prefer_incremental_sfm, incremental_reason = helpers[
        "should_prefer_incremental_sfm"
    ](config, paths, num_images)
    if use_global_sfm and prefer_incremental_sfm:
        use_global_sfm = False
        use_legacy_glomap = False
        use_pycolmap_global = False
        append_log_line(
            project_id,
            f"🔁 Falling back from global SfM to COLMAP incremental SfM: {incremental_reason}",
        )

    update_state(project_id, "sparse_reconstruction", status="running")
    update_stage_detail(
        project_id,
        "sparse_reconstruction",
        text="Initializing...",
        subtext=f"{num_images} images",
    )

    if use_fastmap:
        append_log_line(
            project_id,
            "⚡ Running FastMap Structure-from-Motion (First-Order Optimization)",
        )
        append_log_line(
            project_id,
            f"🎯 GPU-native SfM for {num_images} images (best for dense coverage)",
        )
        fastmap_temp_dir = Path(tempfile.mkdtemp(prefix="fastmap_"))
        shutil.rmtree(fastmap_temp_dir)
        cmd = [
            sys.executable or "python3",
            FASTMAP_PATH,
            "--database",
            str(paths["database_path"]),
            "--image_dir",
            str(paths["images_path"]),
            "--output_dir",
            str(fastmap_temp_dir),
            "--headless",
        ]
        try:
            import torch

            if sparse_has_cuda and torch.cuda.is_available():
                cmd.extend(["--device", "cuda:0"])
                append_log_line(project_id, "🎮 CUDA acceleration enabled")
            elif force_cpu_sparse_reconstruction:
                append_log_line(project_id, "ℹ️ FastMap is running on CPU")
        except ImportError:
            pass
        append_log_line(project_id, f"🔧 FastMap path: {FASTMAP_PATH}")
    elif use_global_sfm:
        append_log_line(project_id, f"🚀 Running {global_backend['label']}")
        append_log_line(project_id, f"⚡ Global SfM mapper for {num_images} images")
        cmd = [
            *global_backend["command"],
            "--database_path",
            str(paths["database_path"]),
            "--image_path",
            str(paths["images_path"]),
            "--output_path",
            str(paths["sparse_path"]),
        ]
        if sparse_has_cuda:
            if use_legacy_glomap:
                cmd.extend(
                    [
                        "--GlobalPositioning.use_gpu",
                        "1",
                        "--GlobalPositioning.gpu_index",
                        "0",
                        "--BundleAdjustment.use_gpu",
                        "1",
                        "--BundleAdjustment.gpu_index",
                        "0",
                    ]
                )
            else:
                cmd.extend(
                    [
                        "--GlobalMapper.gp_use_gpu",
                        "1",
                        "--GlobalMapper.gp_gpu_index",
                        "0",
                        "--GlobalMapper.ba_ceres_use_gpu",
                        "1",
                        "--GlobalMapper.ba_ceres_gpu_index",
                        "0",
                    ]
                )
            append_log_line(
                project_id,
                "🚀 Global SfM GPU acceleration enabled (Global Positioning + Bundle Adjustment)",
            )
        else:
            append_log_line(project_id, "ℹ️ Global SfM retry is running on CPU")
        if config.get("fast_sfm", False):
            cmd.extend(
                ["--ba_iteration_num", "2", "--retriangulation_iteration_num", "0"]
            )
            append_log_line(
                project_id, "⚡ Fast SfM mode: reduced iterations for speed"
            )
        append_log_line(
            project_id,
            f"🔧 Legacy GLOMAP path: {GLOMAP_PATH}"
            if use_legacy_glomap
            else f"🔧 Using COLMAP executable for global mapper: {colmap_exe}",
        )
    else:
        if sfm_engine == "glomap" and global_backend is None:
            append_log_line(
                project_id,
                "⚠️ Global SfM backend not found, falling back to COLMAP incremental mapper",
            )
        append_log_line(
            project_id, "🔄 Running COLMAP Incremental Sparse Reconstruction..."
        )
        append_log_line(
            project_id, f"🏗️ Optimized mapper settings for {num_images} images"
        )
        mapper_cpu_threads, detected_cpu_threads, requested_mapper_cpu_threads = (
            _resolve_mapper_cpu_threads(config)
        )
        cmd = [
            colmap_exe,
            "mapper",
            "--database_path",
            str(paths["database_path"]),
            "--image_path",
            str(paths["images_path"]),
            "--output_path",
            str(paths["sparse_path"]),
            "--Mapper.min_num_matches",
            str(colmap_cfg["min_num_matches"]),
            "--Mapper.min_model_size",
            str(colmap_cfg["min_model_size"]),
            "--Mapper.max_num_models",
            str(colmap_cfg["max_num_models"]),
            "--Mapper.init_num_trials",
            str(colmap_cfg["init_num_trials"]),
            "--Mapper.max_extra_param",
            str(colmap_cfg["max_extra_param"]),
            "--Mapper.num_threads",
            str(mapper_cpu_threads),
        ]
        snapshot_path = paths.get("sparse_snapshots_path")
        if snapshot_path:
            snapshot_frequency = _choose_live_sparse_snapshot_frequency(num_images)
            snapshot_path = Path(snapshot_path)
            shutil.rmtree(snapshot_path, ignore_errors=True)
            snapshot_path.mkdir(parents=True, exist_ok=True)
            cmd.extend(
                [
                    "--Mapper.snapshot_path",
                    str(snapshot_path),
                    "--Mapper.snapshot_frames_freq",
                    str(snapshot_frequency),
                ]
            )
            append_log_line(
                project_id,
                "📸 Live sparse snapshots enabled per registered image "
                f"({snapshot_frequency} registered image per update)",
            )
        for param, value in colmap_cfg.get("mapper_params", {}).items():
            cmd.extend([f"--{param}", str(value)])
        mapper_params = colmap_cfg.get("mapper_params", {})
        if mapper_params:
            append_log_line(
                project_id,
                "🧠 COLMAP mapper registration controls: "
                f"init_trials={colmap_cfg['init_num_trials']} | "
                f"max_reg_trials={mapper_params.get('Mapper.max_reg_trials', 'default')} | "
                f"abs_pose_max_error={mapper_params.get('Mapper.abs_pose_max_error', 'default')} | "
                f"min_inliers={mapper_params.get('Mapper.abs_pose_min_num_inliers', 'default')} | "
                f"min_ratio={mapper_params.get('Mapper.abs_pose_min_inlier_ratio', 'default')}",
            )
        if sparse_has_cuda:
            ba_plan = describe_colmap_bundle_adjustment_mode(
                colmap_exe, num_images, sparse_has_cuda
            )
            cmd.extend(["--Mapper.ba_use_gpu", "1", "--Mapper.ba_gpu_index", "0"])
            _log_colmap_ba_plan(project_id, ba_plan)
        else:
            append_log_line(project_id, "ℹ️ Using CPU-only COLMAP sparse reconstruction")
        if requested_mapper_cpu_threads and requested_mapper_cpu_threads > mapper_cpu_threads:
            append_log_line(
                project_id,
                "⚠️ Mapper CPU threads capped: "
                f"requested={requested_mapper_cpu_threads}, using={mapper_cpu_threads}, "
                f"detected={detected_cpu_threads}",
            )
        append_log_line(
            project_id,
            f"🔧 Using {mapper_cpu_threads} CPU threads for mapper "
            f"(detected={detected_cpu_threads})",
        )

    glomap_stages = {
        "preprocessing": {"progress": 5, "label": "🔧 Preprocessing"},
        "view_graph_calibration": {
            "progress": 10,
            "label": "📊 View Graph Calibration",
        },
        "relative_pose": {"progress": 20, "label": "📐 Relative Pose Estimation"},
        "rotation_averaging": {"progress": 35, "label": "🔄 Rotation Averaging"},
        "track_establishment": {"progress": 50, "label": "🔗 Track Establishment"},
        "global_positioning": {"progress": 65, "label": "🌍 Global Positioning"},
        "bundle_adjustment": {"progress": 85, "label": "⚡ Bundle Adjustment"},
        "retriangulation": {"progress": 92, "label": "📐 Retriangulation"},
        "postprocessing": {"progress": 98, "label": "🏁 Postprocessing"},
    }
    fastmap_stages = {
        "focal_estimation": {"progress": 5, "label": "🔍 Focal Length Estimation"},
        "fundamental": {"progress": 15, "label": "📐 Fundamental Matrix"},
        "decompose": {"progress": 25, "label": "🧩 Essential Decomposition"},
        "rotation": {"progress": 40, "label": "🔄 Global Rotation"},
        "translation": {"progress": 55, "label": "📍 Global Translation"},
        "tracks": {"progress": 65, "label": "🔗 Track Building"},
        "epipolar": {"progress": 80, "label": "⚡ Epipolar Adjustment"},
        "sparse": {"progress": 92, "label": "🏗️ Sparse Reconstruction"},
        "output": {"progress": 98, "label": "💾 Writing Results"},
    }
    sparse_tracker = {
        "registered": 0,
        "current_glomap_stage": None,
        "last_progress": 0,
        "ba_iteration": 0,
        "ba_total": 3,
        "last_registration_milestone": -1,
        "last_ba_milestone": -1,
        "last_pose_update_registered": 0,
    }

    def sparse_line_handler(line):
        if num_images == 0:
            return
        line_lower = line.lower()
        if use_fastmap:
            for stage_key, pattern in [
                ("focal_estimation", r"(estimating focal|focal length)"),
                ("fundamental", r"(fundamental matrix|estimate fundamental)"),
                ("decompose", r"(decompos|essential matrix)"),
                ("rotation", r"(global rotation|rotation averaging)"),
                ("translation", r"(global translation|translation estimation)"),
                ("tracks", r"(build.*track|track.*build|establishing track)"),
                ("epipolar", r"(epipolar adjustment|epipolar optimization)"),
                ("sparse", r"(sparse reconstruction|triangulat)"),
                ("output", r"(write|writing|output|saving)"),
            ]:
                if re.search(pattern, line_lower):
                    stage_info = fastmap_stages[stage_key]
                    progress = stage_info["progress"]
                    append_log_line(project_id, f"[FastMap] {stage_info['label']}")
                    details = {
                        "text": stage_info["label"],
                        "current_item": progress,
                        "total_items": 100,
                        "item_name": stage_key,
                        "fastmap_stage": stage_key,
                        "sfm_engine": "fastmap",
                    }
                    emit_stage_progress(
                        project_id, "sparse_reconstruction", progress, details
                    )
                    update_state(
                        project_id,
                        "sparse_reconstruction",
                        progress=progress,
                        details=details,
                    )
                    update_stage_detail(
                        project_id,
                        "sparse_reconstruction",
                        text=stage_info["label"],
                        subtext=f"FastMap - {num_images} images",
                    )
                    return
            return

        if use_global_sfm:
            for stage_key, pattern in [
                ("preprocessing", r"running preprocessing"),
                ("view_graph_calibration", r"running view graph calibration"),
                (
                    "relative_pose",
                    r"(running relative pose estimation|estimating relative pose)",
                ),
                ("rotation_averaging", r"running rotation averaging"),
                ("track_establishment", r"(establishing tracks|track estimation)"),
                ("global_positioning", r"running global positioning"),
                ("bundle_adjustment", r"running bundle adjustment"),
                ("retriangulation", r"running retriangulation"),
                ("postprocessing", r"running postprocessing"),
            ]:
                if re.search(pattern, line_lower):
                    previous_stage = sparse_tracker.get("current_glomap_stage")
                    sparse_tracker["current_glomap_stage"] = stage_key
                    stage_info = glomap_stages[stage_key]
                    progress = stage_info["progress"]
                    if previous_stage != stage_key:
                        append_log_line(project_id, f"[GLOMAP] {stage_info['label']}")
                    details = {
                        "text": stage_info["label"],
                        "current_item": progress,
                        "total_items": 100,
                        "item_name": stage_key,
                        "glomap_stage": stage_key,
                        "sfm_engine": "glomap",
                    }
                    emit_stage_progress(
                        project_id, "sparse_reconstruction", progress, details
                    )
                    update_state(
                        project_id,
                        "sparse_reconstruction",
                        progress=progress,
                        details=details,
                    )
                    update_stage_detail(
                        project_id,
                        "sparse_reconstruction",
                        text=stage_info["label"],
                        subtext=f"GLOMAP - {num_images} images",
                    )
                    sparse_tracker["last_progress"] = progress
                    return

            relpose_match = re.search(
                r"estimating relative pose[:\s]*(\d+)%", line_lower
            )
            if relpose_match:
                rel_percent = int(relpose_match.group(1))
                progress = 10 + int(rel_percent * 0.1)
                details = {
                    "text": f"📐 Relative Pose: {rel_percent}%",
                    "current_item": rel_percent,
                    "total_items": 100,
                    "item_name": f"{rel_percent}%",
                    "glomap_stage": "relative_pose",
                    "sfm_engine": "glomap",
                }
                emit_stage_progress(
                    project_id, "sparse_reconstruction", progress, details
                )
                update_state(
                    project_id,
                    "sparse_reconstruction",
                    progress=progress,
                    details=details,
                )
                update_stage_detail(
                    project_id,
                    "sparse_reconstruction",
                    text=f"📐 Relative Pose Estimation: {rel_percent}%",
                    subtext=f"GLOMAP - {num_images} images",
                )
                return

            track_match = re.search(
                r"establishing tracks\s*(\d+)\s*/\s*(\d+)", line_lower
            )
            if track_match:
                current_track = int(track_match.group(1))
                total_tracks = int(track_match.group(2))
                track_percent = min(
                    100, int((current_track / max(total_tracks, 1)) * 100)
                )
                progress = 50 + int(track_percent * 0.15)
                details = {
                    "text": f"🔗 Tracks: {current_track}/{total_tracks}",
                    "current_item": current_track,
                    "total_items": total_tracks,
                    "item_name": f"Track {current_track}",
                    "glomap_stage": "track_establishment",
                    "sfm_engine": "glomap",
                }
                emit_stage_progress(
                    project_id, "sparse_reconstruction", progress, details
                )
                update_state(
                    project_id,
                    "sparse_reconstruction",
                    progress=progress,
                    details=details,
                )
                update_stage_detail(
                    project_id,
                    "sparse_reconstruction",
                    text=f"🔗 Track Establishment: {current_track}/{total_tracks}",
                    subtext=f"GLOMAP - {track_percent}%",
                )
                return

            ba_match = re.search(
                r"global bundle adjustment iteration\s*(\d+)\s*/\s*(\d+)", line_lower
            )
            if ba_match:
                ba_current = int(ba_match.group(1))
                ba_total = int(ba_match.group(2))
                sparse_tracker["ba_iteration"] = ba_current
                sparse_tracker["ba_total"] = ba_total
                ba_percent = int((ba_current / max(ba_total, 1)) * 100)
                progress = 65 + int(ba_percent * 0.27)
                details = {
                    "text": f"⚡ Bundle Adjustment: {ba_current}/{ba_total}",
                    "current_item": ba_current,
                    "total_items": ba_total,
                    "item_name": f"Iteration {ba_current}",
                    "glomap_stage": "bundle_adjustment",
                    "sfm_engine": "glomap",
                }
                emit_stage_progress(
                    project_id, "sparse_reconstruction", progress, details
                )
                update_state(
                    project_id,
                    "sparse_reconstruction",
                    progress=progress,
                    details=details,
                )
                update_stage_detail(
                    project_id,
                    "sparse_reconstruction",
                    text=f"⚡ Bundle Adjustment: Iteration {ba_current}/{ba_total}",
                    subtext=f"GLOMAP - {ba_percent}%",
                )
                ba_log_state = {
                    "last_milestone": sparse_tracker.get("last_ba_milestone", -1)
                }
                should_log, _ = should_emit_progress_milestone(
                    ba_log_state, ba_current, ba_total, percent_step=25
                )
                sparse_tracker["last_ba_milestone"] = ba_log_state["last_milestone"]
                if should_log:
                    append_log_line(
                        project_id,
                        f"[GLOMAP] Bundle Adjustment {ba_current}/{ba_total}",
                    )
                return

            pair_match = re.search(
                r"loading image pair\s*(\d+)\s*/\s*(\d+)", line_lower
            )
            if pair_match:
                current_pair = int(pair_match.group(1))
                total_pairs = int(pair_match.group(2))
                pair_percent = min(100, int((current_pair / max(total_pairs, 1)) * 100))
                progress = min(5, int(pair_percent * 0.05))
                if current_pair % 500 == 0 or current_pair == total_pairs:
                    details = {
                        "text": f"🔧 Loading pairs: {current_pair}/{total_pairs}",
                        "current_item": current_pair,
                        "total_items": total_pairs,
                        "item_name": f"Pair {current_pair}",
                        "glomap_stage": "preprocessing",
                        "sfm_engine": "glomap",
                    }
                    emit_stage_progress(
                        project_id, "sparse_reconstruction", progress, details
                    )
                    update_stage_detail(
                        project_id,
                        "sparse_reconstruction",
                        text=f"🔧 Loading Image Pairs: {current_pair}/{total_pairs}",
                        subtext="GLOMAP - Preprocessing",
                    )
                return

        for pattern in [
            r"Registering image #(\d+)",
            r"Registered image #(\d+)",
            r"Processing image (\d+)/(\d+)",
            r"Reconstruction: (\d+)/(\d+)",
            r"Bundle adjustment: (\d+) images",
            r"Image #(\d+)",
            r"(\d+) images registered",
            r"Registering\s+(\d+)\s*/\s*(\d+)",
        ]:
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
                    sparse_tracker["registered"] += 1
                    current = min(sparse_tracker["registered"], num_images)
                    total = num_images
                percent = int((current / total) * 100)
                details = {
                    "text": f"Images registered: {current}/{total}",
                    "current_item": current,
                    "total_items": total,
                    "item_name": f"Image {current}",
                    "sfm_engine": "colmap",
                }
                emit_stage_progress(
                    project_id, "sparse_reconstruction", percent, details
                )
                update_state(
                    project_id,
                    "sparse_reconstruction",
                    progress=min(percent, 99),
                    details=details,
                )
                update_stage_detail(
                    project_id,
                    "sparse_reconstruction",
                    text=f"Images registered: {current}/{total}",
                    subtext="COLMAP",
                )
                last_pose_update_registered = int(
                    sparse_tracker.get("last_pose_update_registered", 0)
                )
                if (
                    current > last_pose_update_registered
                    and current - last_pose_update_registered >= LIVE_SPARSE_POSE_UPDATE_IMAGE_STEP
                ):
                    sparse_tracker["last_pose_update_registered"] = current
                    emit_sparse_pose_update(
                        project_id,
                        {
                            "project_id": project_id,
                            "camera_count": current,
                            "total_images": total,
                            "capture_progress_percent": percent,
                            "snapshot_version": None,
                            "source_type": "registration",
                            "update_mode": "per_image",
                        },
                    )
                registration_log_state = {
                    "last_milestone": sparse_tracker.get(
                        "last_registration_milestone", -1
                    )
                }
                should_log, progress_percent = should_emit_progress_milestone(
                    registration_log_state, current, total
                )
                sparse_tracker["last_registration_milestone"] = registration_log_state[
                    "last_milestone"
                ]
                if should_log:
                    append_log_line(
                        project_id,
                        f"[COLMAP] Registration progress: {current}/{total} images ({progress_percent}%)",
                    )
                return

        if not use_global_sfm and _maybe_log_colmap_ba_runtime_event(
            project_id, line, sparse_tracker, ba_plan
        ):
            return

        if not use_global_sfm and "creating snapshot" in line_lower:
            registered = max(int(sparse_tracker.get("registered", 0)), 0)
            snapshot_percent = int((registered / max(num_images, 1)) * 100)
            append_log_line(
                project_id,
                f"[COLMAP] Live sparse snapshot exported "
                f"({registered}/{num_images} images registered, {snapshot_percent}%)",
            )
            return

    pycolmap_completed = False
    if use_pycolmap_global:
        pycolmap_completed = try_run_pycolmap_global_mapping(
            project_id, paths, config, colmap_cfg, num_images
        )
    if not pycolmap_completed:
        run_command_with_logs(
            project_id,
            cmd,
            line_handler=sparse_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )

    if use_fastmap and fastmap_temp_dir is not None:
        fastmap_output = fastmap_temp_dir / "sparse" / "0"
        target_path = paths["sparse_path"] / "0"
        if fastmap_output.exists():
            target_path.mkdir(parents=True, exist_ok=True)
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
            append_log_line(
                project_id, f"⚠️ FastMap output not found at {fastmap_output}"
            )
        try:
            shutil.rmtree(fastmap_temp_dir)
            append_log_line(project_id, "🧹 Cleaned up FastMap temp directory")
        except Exception as exc:
            append_log_line(project_id, f"⚠️ Could not cleanup temp dir: {exc}")

    update_state(project_id, "sparse_reconstruction", status="completed", progress=100)
    registered = (
        sparse_tracker["registered"] if sparse_tracker["registered"] else num_images
    )
    if use_fastmap:
        engine_name = "FastMap"
    elif use_global_sfm:
        engine_name = (
            "pycolmap Global Mapper"
            if use_pycolmap_global and pycolmap_completed
            else ("Legacy GLOMAP" if use_legacy_glomap else "COLMAP Global Mapper")
        )
    else:
        engine_name = "COLMAP"
    update_stage_detail(
        project_id,
        "sparse_reconstruction",
        text=f"Images registered: {min(registered, num_images)}/{num_images}",
        subtext=f"{engine_name} reconstruction complete",
    )
    append_log_line(
        project_id, f"✅ Sparse Reconstruction completed using {engine_name}"
    )

    sparse_summary = helpers["report_sparse_model_coverage"](
        project_id, paths, config, colmap_cfg, num_images
    )
    if sparse_summary:
        colmap_cfg["last_sparse_summary"] = dict(sparse_summary)
        colmap_cfg["no_regression_floor"] = merge_no_regression_floors(
            colmap_cfg.get("no_regression_floor"),
            capture_no_regression_floor(colmap_cfg),
        )

    weak_window_subset_recovery_pass = helpers[
        "build_weak_window_subset_recovery_pass"
    ](paths, colmap_cfg, sparse_summary)
    if weak_window_subset_recovery_pass:
        overlap_plan = weak_window_subset_recovery_pass.get("overlap_plan") or {}
        boundary_subset = weak_window_subset_recovery_pass.get("boundary_subset") or {}
        if weak_window_subset_recovery_pass.get("kind") == "stubborn_boundary_subset":
            colmap_cfg["stubborn_boundary_recovery_attempted"] = True
        else:
            colmap_cfg["weak_window_recovery_attempted"] = True
        colmap_cfg["recovery_matching_pass"] = weak_window_subset_recovery_pass
        if weak_window_subset_recovery_pass.get("kind") == "stubborn_boundary_subset":
            pair_plan = weak_window_subset_recovery_pass.get("pair_plan") or {}
            append_log_line(
                project_id,
                "🧠 Some heavily densified boundaries are still failing; "
                "escalating to a stubborn-boundary subset rematch instead of adding more frames first",
            )
            append_log_line(
                project_id,
                "🧠 Stubborn-boundary subset rematch: "
                f"subset={len(boundary_subset.get('image_ids') or [])} images | "
                f"stubborn_boundaries={len(boundary_subset.get('target_boundaries') or [])} | "
                f"padding={boundary_subset.get('padding', 0)} | "
                f"overlap={overlap_plan.get('current_overlap', '?')}→{overlap_plan.get('target_overlap', weak_window_subset_recovery_pass['matcher_params'].get('SequentialMatching.overlap', '?'))} | "
                f"loop={weak_window_subset_recovery_pass['matcher_params'].get('SequentialMatching.loop_detection', '0')} | "
                f"pairs={pair_plan.get('pair_count', 0)}",
            )
        else:
            append_log_line(
                project_id,
                "🧠 Sparse reconstruction is split across weak temporal windows; "
                "running a targeted subset rematch before frame densification",
            )
            append_log_line(
                project_id,
                "🧠 Weak-window subset rematch: "
                f"subset={len(boundary_subset.get('image_ids') or [])} images | "
                f"weak_boundaries={boundary_subset.get('weak_boundary_count', 0)} | "
                f"padding={boundary_subset.get('padding', 0)} | "
                f"overlap={overlap_plan.get('current_overlap', '?')}→{overlap_plan.get('target_overlap', weak_window_subset_recovery_pass['matcher_params'].get('SequentialMatching.overlap', '?'))}",
            )
        helpers["clear_sparse_reconstruction_outputs"](paths["sparse_path"])
        colmap_cfg = helpers["run_orbit_safe_bridge_recovery_matching_pass"](
            project_id, paths, config, colmap_exe, colmap_cfg, has_cuda
        )
        return run_sparse_reconstruction_stage(
            project_id, paths, config, colmap_cfg, helpers=helpers
        )

    if helpers["should_run_boundary_frame_densification"](
        config, colmap_cfg, sparse_summary, paths
    ):
        densified_result = helpers["run_boundary_frame_densification_recovery"](
            project_id, paths, config, colmap_cfg
        )
        if densified_result is not None:
            return densified_result

    densified_overlap_retry_pass = helpers["build_densified_overlap_retry_pass"](
        paths, colmap_cfg, sparse_summary
    )
    if densified_overlap_retry_pass:
        overlap_plan = densified_overlap_retry_pass.get("overlap_plan") or {}
        colmap_cfg["densified_overlap_retry_attempted"] = True
        colmap_cfg["recovery_matching_pass"] = densified_overlap_retry_pass
        append_log_line(
            project_id,
            "🧠 Sparse reconstruction is still split after boundary densification; running a data-driven overlap retry with the standard sequential matcher",
        )
        append_log_line(
            project_id,
            f"🧠 Densified-set overlap retry: {overlap_plan.get('current_overlap', '?')}→{overlap_plan.get('target_overlap', '?')} (cap={overlap_plan.get('overlap_cap', '?')}, boost={overlap_plan.get('overlap_boost', '?')})",
        )
        helpers["clear_sparse_reconstruction_outputs"](paths["sparse_path"])
        colmap_cfg = helpers["run_orbit_safe_bridge_recovery_matching_pass"](
            project_id, paths, config, colmap_exe, colmap_cfg, has_cuda
        )
        return run_sparse_reconstruction_stage(
            project_id, paths, config, colmap_cfg, helpers=helpers
        )

    if helpers["should_run_final_loop_detection_recovery"](
        colmap_cfg, sparse_summary, num_images
    ):
        final_recovery_matching_pass = colmap_cfg.get("final_recovery_matching_pass")
        colmap_cfg["loop_detection_fallback_attempted"] = True
        colmap_cfg["recovery_matching_pass"] = final_recovery_matching_pass
        colmap_cfg["final_recovery_matching_pass"] = None
        append_log_line(
            project_id,
            "🧠 Sparse reconstruction is still split after overlap-only recovery; running final loop-detection fallback and retrying sparse reconstruction once",
        )
        helpers["clear_sparse_reconstruction_outputs"](paths["sparse_path"])
        colmap_cfg = helpers["run_orbit_safe_bridge_recovery_matching_pass"](
            project_id, paths, config, colmap_exe, colmap_cfg, has_cuda
        )
        return run_sparse_reconstruction_stage(
            project_id, paths, config, colmap_cfg, helpers=helpers
        )

    automatic_split_retry = helpers["build_ordered_split_auto_retry"](
        project_id,
        paths,
        config,
        colmap_cfg,
        sparse_summary,
        rerun_feature_extraction_stage=helpers["rerun_feature_extraction_stage"],
        rerun_feature_matching_stage=helpers["rerun_feature_matching_stage"],
        rerun_sparse_reconstruction_stage=helpers["rerun_sparse_reconstruction_stage"],
    )
    if automatic_split_retry is not None:
        return automatic_split_retry

    matcher_fallback_retry = helpers['run_matcher_fallback_retry'](
        project_id,
        paths,
        config,
        colmap_cfg,
        sparse_summary,
        num_images,
        rerun_feature_extraction_stage=helpers['rerun_feature_extraction_stage'],
        rerun_feature_matching_stage=helpers['rerun_feature_matching_stage'],
        rerun_sparse_reconstruction_stage=helpers['rerun_sparse_reconstruction_stage'],
    )
    if matcher_fallback_retry is not None:
        return matcher_fallback_retry

    return colmap_cfg


def run_model_conversion_stage(project_id, paths, *, helpers):
    """Select the best sparse model and mark conversion complete."""
    update_state(project_id, "model_conversion", status="running")
    update_stage_detail(
        project_id, "model_conversion", text="Organizing sparse model...", subtext=None
    )
    append_log_line(project_id, "🔄 Organizing Model Structure...")
    sparse_model_path = helpers["select_best_sparse_model"](
        paths["sparse_path"], project_id
    )
    if not sparse_model_path:
        raise Exception("No sparse reconstruction found")
    update_state(project_id, "model_conversion", status="completed", progress=100)
    update_stage_detail(
        project_id, "model_conversion", text="Model organization complete", subtext=None
    )
    append_log_line(project_id, "✅ Model Organization completed")
    return sparse_model_path
