"""REST API endpoints for PobimSplats backend."""

from __future__ import annotations

import json
import logging
import math
import os
import shutil
import subprocess
import threading
import tempfile
import uuid
from itertools import islice
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from ..core import config as app_config
from ..core import projects as project_store
from ..core.files import (
    allowed_file,
    get_file_type,
    secure_unicode_filename,
    setup_project_directories,
)
from ..core.projects import (
    append_log_line,
    get_recent_log_lines,
    initialize_project_entry,
    save_projects_db,
    update_stage_detail,
    update_state,
)
from ..pipeline.config_builders import build_upload_adaptive_policy_comparisons
from ..pipeline.runner import (
    build_upload_policy_preview,
    finalize_project,
    get_colmap_executable,
    get_pycolmap_module,
    pycolmap_supports_global_mapping,
    run_processing_pipeline,
    run_processing_pipeline_from_stage,
    select_best_sparse_model,
)
from ..utils.video_processor import VideoProcessor
from ..services.mesh_converter import MeshConverter
from ..services.mvs_mesher import MVSMesher

api_bp = Blueprint("api", __name__, url_prefix="/api")

logger = logging.getLogger(__name__)

video_processor = VideoProcessor()

TRAINING_PREVIEW_FILENAME = "preview_latest.ply"
TRAINING_PREVIEW_METADATA_FILENAME = "preview_latest.json"
LIVE_PREVIEW_PERCENT_STEP = 5


def _calculate_progress_percent(current: int, total: int) -> int:
    if total <= 0:
        return 0
    return max(0, min(100, int((min(current, total) / total) * 100)))


def _count_project_images(project_id: str) -> int:
    images_path = app_config.UPLOAD_FOLDER / project_id / "images"
    if not images_path.exists():
        return 0
    return sum(
        1
        for child in images_path.iterdir()
        if child.is_file() and child.suffix.lower() in app_config.IMAGE_EXTENSIONS
    )


def _clear_directory_contents(path: Path) -> None:
    if not path.exists():
        return
    for child in path.iterdir():
        if child.is_dir():
            shutil.rmtree(child, ignore_errors=True)
        else:
            try:
                child.unlink()
            except FileNotFoundError:
                pass


def _preview_url_with_version(base_url: str, file_path: Path) -> str:
    try:
        version = file_path.stat().st_mtime_ns
    except FileNotFoundError:
        return base_url
    return f"{base_url}?v={version}"


def _send_uncached_preview(file_path: Path):
    response = send_file(
        file_path, mimetype="image/jpeg", as_attachment=False, max_age=0
    )
    response.cache_control.no_cache = True
    response.cache_control.no_store = True
    response.cache_control.must_revalidate = True
    response.expires = 0
    return response


def _send_uncached_binary(
    file_path: Path, mimetype: str = "application/octet-stream"
):
    response = send_file(file_path, mimetype=mimetype, as_attachment=False, max_age=0)
    response.cache_control.no_cache = True
    response.cache_control.no_store = True
    response.cache_control.must_revalidate = True
    response.expires = 0
    return response


def _get_training_preview_paths(project_id: str) -> tuple[Path, Path]:
    results_dir = app_config.RESULTS_FOLDER / project_id
    return (
        results_dir / TRAINING_PREVIEW_FILENAME,
        results_dir / TRAINING_PREVIEW_METADATA_FILENAME,
    )


def _load_training_preview_metadata(project_id: str):
    preview_path, metadata_path = _get_training_preview_paths(project_id)
    if not preview_path.exists():
        raise FileNotFoundError("No training preview available for this project")

    metadata = {}
    if metadata_path.exists():
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            metadata = {}

    stat = preview_path.stat()
    metadata.setdefault("filename", preview_path.name)
    metadata.setdefault("iteration", 0)
    metadata.setdefault("total_iterations", 0)
    metadata.setdefault(
        "progress_percent",
        _calculate_progress_percent(
            int(metadata.get("iteration") or 0),
            int(metadata.get("total_iterations") or 0),
        ),
    )
    metadata.setdefault("update_interval_percent", LIVE_PREVIEW_PERCENT_STEP)
    metadata.setdefault("is_final", False)
    metadata.setdefault("updated_at", datetime.fromtimestamp(stat.st_mtime).isoformat())
    metadata["size_bytes"] = stat.st_size
    metadata["version"] = stat.st_mtime_ns
    metadata["preview_url"] = (
        f"/api/project/{project_id}/training_preview_file?v={metadata['version']}"
    )
    return preview_path, metadata


def _prepare_retry_artifacts(project_id: str, paths: dict, from_stage: str) -> None:
    cleanup_targets = []

    if from_stage == "ingest":
        cleanup_targets.extend(
            [
                ("dir", paths["images_path"]),
                ("dir", paths["training_images_path"]),
                ("dir", paths["frames_path"]),
                ("file", paths["database_path"]),
                ("file", Path(f"{paths['database_path']}-shm")),
                ("file", Path(f"{paths['database_path']}-wal")),
                ("dir", paths["sparse_path"]),
                ("dir", paths["sparse_snapshots_path"]),
                ("dir", paths["text_path"]),
                ("dir", paths["results_path"]),
            ]
        )
    elif from_stage == "video_extraction":
        cleanup_targets.extend(
            [
                ("dir", paths["images_path"]),
                ("dir", paths["training_images_path"]),
                ("file", paths["database_path"]),
                ("file", Path(f"{paths['database_path']}-shm")),
                ("file", Path(f"{paths['database_path']}-wal")),
                ("dir", paths["sparse_path"]),
                ("dir", paths["sparse_snapshots_path"]),
                ("dir", paths["text_path"]),
                ("dir", paths["results_path"]),
            ]
        )
    elif from_stage == "feature_extraction":
        cleanup_targets.extend(
            [
                ("file", paths["database_path"]),
                ("file", Path(f"{paths['database_path']}-shm")),
                ("file", Path(f"{paths['database_path']}-wal")),
                ("dir", paths["sparse_path"]),
                ("dir", paths["sparse_snapshots_path"]),
                ("dir", paths["text_path"]),
                ("dir", paths["results_path"]),
            ]
        )
    elif from_stage == "feature_matching":
        cleanup_targets.extend(
            [
                ("dir", paths["sparse_path"]),
                ("dir", paths["sparse_snapshots_path"]),
                ("dir", paths["text_path"]),
                ("dir", paths["results_path"]),
            ]
        )
    elif from_stage in {"sparse_reconstruction", "model_conversion"}:
        cleanup_targets.extend(
            [
                ("dir", paths["sparse_path"]),
                ("dir", paths["sparse_snapshots_path"]),
                ("dir", paths["text_path"]),
                ("dir", paths["results_path"]),
            ]
        )
    elif from_stage == "gaussian_splatting":
        cleanup_targets.append(("dir", paths["results_path"]))

    for target_type, target_path in cleanup_targets:
        if target_type == "dir":
            _clear_directory_contents(target_path)
            target_path.mkdir(parents=True, exist_ok=True)
        else:
            try:
                target_path.unlink()
            except FileNotFoundError:
                pass

    if cleanup_targets:
        append_log_line(project_id, f"🧹 Cleared retry artifacts for stage: {from_stage}")


def _quaternion_to_rotation_matrix(qw, qx, qy, qz):
    return [
        [
            1 - 2 * (qy * qy + qz * qz),
            2 * (qx * qy - qz * qw),
            2 * (qx * qz + qy * qw),
        ],
        [
            2 * (qx * qy + qz * qw),
            1 - 2 * (qx * qx + qz * qz),
            2 * (qy * qz - qx * qw),
        ],
        [
            2 * (qx * qz - qy * qw),
            2 * (qy * qz + qx * qw),
            1 - 2 * (qx * qx + qy * qy),
        ],
    ]


def _matrix_transpose(matrix):
    return [
        [matrix[0][0], matrix[1][0], matrix[2][0]],
        [matrix[0][1], matrix[1][1], matrix[2][1]],
        [matrix[0][2], matrix[1][2], matrix[2][2]],
    ]


def _mat3_vec3_mul(matrix, vector):
    return [
        matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2],
        matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2],
        matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2],
    ]


def _quaternion_multiply(q1, q2):
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return [
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ]


def _normalize_quaternion(quaternion):
    length = math.sqrt(sum(component * component for component in quaternion))
    if length <= 1e-12:
        return [1.0, 0.0, 0.0, 0.0]
    return [component / length for component in quaternion]


def _extract_intrinsics(camera_model, params):
    if not params:
        return None, None

    shared_focal_models = {
        "SIMPLE_PINHOLE",
        "SIMPLE_RADIAL",
        "RADIAL",
        "SIMPLE_RADIAL_FISHEYE",
        "FOV",
    }
    separate_focal_models = {
        "PINHOLE",
        "OPENCV",
        "FULL_OPENCV",
        "OPENCV_FISHEYE",
        "THIN_PRISM_FISHEYE",
    }

    if camera_model in shared_focal_models:
        focal = float(params[0])
        return focal, focal

    if camera_model in separate_focal_models and len(params) >= 2:
        return float(params[0]), float(params[1])

    focal = float(params[0])
    return focal, focal


def _parse_colmap_cameras_txt(cameras_path):
    cameras = {}
    with cameras_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            if len(parts) < 5:
                continue

            camera_id = int(parts[0])
            model = parts[1]
            width = int(parts[2])
            height = int(parts[3])
            params = [float(value) for value in parts[4:]]
            fx, fy = _extract_intrinsics(model, params)

            cameras[camera_id] = {
                "camera_id": camera_id,
                "model": model,
                "width": width,
                "height": height,
                "params": params,
                "fx": fx,
                "fy": fy,
            }

    return cameras


def _parse_colmap_images_txt(images_path, cameras):
    images = []
    with images_path.open("r", encoding="utf-8") as handle:
        lines = iter(handle)
        for raw_line in lines:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            if len(parts) < 10:
                continue

            image_id = int(parts[0])
            qvec = [float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])]
            tvec = [float(parts[5]), float(parts[6]), float(parts[7])]
            camera_id = int(parts[8])
            image_name = " ".join(parts[9:])
            camera = cameras.get(camera_id)

            if not camera:
                continue

            qw, qx, qy, qz = qvec
            rotation_world_to_camera = _quaternion_to_rotation_matrix(qw, qx, qy, qz)
            rotation_camera_to_world = _matrix_transpose(rotation_world_to_camera)
            rotated_translation = _mat3_vec3_mul(rotation_camera_to_world, tvec)
            camera_position = [
                -rotated_translation[0],
                -rotated_translation[1],
                -rotated_translation[2],
            ]

            q_cam_to_world = [qw, -qx, -qy, -qz]
            q_flip_x = [0.0, 1.0, 0.0, 0.0]
            viewer_quaternion = _normalize_quaternion(
                _quaternion_multiply(q_cam_to_world, q_flip_x)
            )

            images.append(
                {
                    "image_id": image_id,
                    "image_name": image_name,
                    "camera_id": camera_id,
                    "position": [
                        float(camera_position[0]),
                        float(camera_position[1]),
                        float(camera_position[2]),
                    ],
                    "quaternion": [
                        float(viewer_quaternion[0]),
                        float(viewer_quaternion[1]),
                        float(viewer_quaternion[2]),
                        float(viewer_quaternion[3]),
                    ],
                    "fx": camera["fx"],
                    "fy": camera["fy"],
                    "width": camera["width"],
                    "height": camera["height"],
                    "image_url": f"/api/project/{{project_id}}/image_preview/{image_name}",
                }
            )

            next(lines, None)

    images.sort(key=lambda item: item["image_name"])
    return images


def _ensure_sparse_text_model(sparse_model_path):
    cameras_txt = sparse_model_path / "cameras.txt"
    images_txt = sparse_model_path / "images.txt"
    points_txt = sparse_model_path / "points3D.txt"

    if cameras_txt.exists() and images_txt.exists() and points_txt.exists():
        return cameras_txt, images_txt, points_txt

    cameras_bin = sparse_model_path / "cameras.bin"
    images_bin = sparse_model_path / "images.bin"
    points_bin = sparse_model_path / "points3D.bin"
    if not cameras_bin.exists() or not images_bin.exists() or not points_bin.exists():
        raise FileNotFoundError(
            "Sparse model is missing required camera/image/point files"
        )

    with tempfile.TemporaryDirectory(prefix="colmap_model_txt_") as temp_dir:
        temp_path = os.path.join(temp_dir, "model_txt")
        os.makedirs(temp_path, exist_ok=True)

        result = subprocess.run(
            [
                get_colmap_executable(),
                "model_converter",
                "--input_path",
                str(sparse_model_path),
                "--output_path",
                temp_path,
                "--output_type",
                "TXT",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )

        if result.returncode != 0:
            raise RuntimeError(
                f"Failed to convert sparse model to text: {(result.stderr or result.stdout or 'unknown error').strip()}"
            )

        temp_cameras = os.path.join(temp_path, "cameras.txt")
        temp_images = os.path.join(temp_path, "images.txt")
        temp_points = os.path.join(temp_path, "points3D.txt")
        if (
            not os.path.exists(temp_cameras)
            or not os.path.exists(temp_images)
            or not os.path.exists(temp_points)
        ):
            raise FileNotFoundError(
                "Converted sparse model text files were not created"
            )

        with tempfile.NamedTemporaryFile(
            "w+", delete=False, suffix="_cameras.txt", encoding="utf-8"
        ) as cam_file:
            with open(temp_cameras, "r", encoding="utf-8") as src:
                cam_file.write(src.read())
            cameras_copy = cam_file.name

        with tempfile.NamedTemporaryFile(
            "w+", delete=False, suffix="_images.txt", encoding="utf-8"
        ) as img_file:
            with open(temp_images, "r", encoding="utf-8") as src:
                img_file.write(src.read())
            images_copy = img_file.name

        with tempfile.NamedTemporaryFile(
            "w+", delete=False, suffix="_points3D.txt", encoding="utf-8"
        ) as points_file:
            with open(temp_points, "r", encoding="utf-8") as src:
                points_file.write(src.read())
            points_copy = points_file.name

    return cameras_copy, images_copy, points_copy


def _parse_colmap_points3d_txt(points_path, max_points=5000):
    records = []
    with points_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue

            parts = line.split()
            if len(parts) < 7:
                continue

            records.append(
                {
                    "position": [
                        float(parts[1]),
                        float(parts[2]),
                        float(parts[3]),
                    ],
                    "color": [
                        int(parts[4]),
                        int(parts[5]),
                        int(parts[6]),
                    ],
                }
            )

    total_points = len(records)
    if total_points <= max_points:
        return records, total_points

    step = max(1, math.ceil(total_points / max_points))
    sampled = list(islice(records, 0, None, step))[:max_points]
    return sampled, total_points


def _is_sparse_model_dir(model_path: Path) -> bool:
    if not model_path.exists() or not model_path.is_dir():
        return False

    has_binary_model = all(
        (model_path / filename).exists()
        for filename in ("cameras.bin", "images.bin", "points3D.bin")
    )
    has_text_model = all(
        (model_path / filename).exists()
        for filename in ("cameras.txt", "images.txt", "points3D.txt")
    )
    return has_binary_model or has_text_model


def _find_latest_sparse_snapshot(project_path: Path) -> Path | None:
    snapshots_root = project_path / "sparse_snapshots"
    if not snapshots_root.exists():
        return None

    candidates = sorted(
        [child for child in snapshots_root.iterdir() if child.is_dir()],
        key=lambda child: (child.stat().st_mtime_ns, child.name),
        reverse=True,
    )
    for candidate in candidates:
        if _is_sparse_model_dir(candidate):
            return candidate
    return None


def _resolve_project_camera_pose_model_path(
    project_id: str, *, prefer_live: bool = True
) -> tuple[Path | None, str]:
    project_path = (app_config.UPLOAD_FOLDER / project_id).resolve()
    sparse_path = project_path / "sparse"

    project_data = project_store.processing_status.get(project_id, {})
    progress_states = project_data.get("progress_states") or []
    sparse_stage = next(
        (
            state
            for state in progress_states
            if state.get("key") == "sparse_reconstruction"
        ),
        None,
    )
    sparse_running = bool(sparse_stage and sparse_stage.get("status") == "running")

    if prefer_live and sparse_running:
        live_snapshot_path = _find_latest_sparse_snapshot(project_path)
        if live_snapshot_path:
            return live_snapshot_path, "snapshot"

    final_sparse_path = select_best_sparse_model(sparse_path)
    if final_sparse_path and final_sparse_path.exists():
        return final_sparse_path, "final"

    fallback_snapshot_path = _find_latest_sparse_snapshot(project_path)
    if fallback_snapshot_path:
        return fallback_snapshot_path, "snapshot"

    return None, "missing"


def _load_project_camera_poses(project_id, *, prefer_live: bool = True):
    project_path = (app_config.UPLOAD_FOLDER / project_id).resolve()
    if not project_path.exists():
        raise FileNotFoundError("Project not found")

    sparse_model_path, source_type = _resolve_project_camera_pose_model_path(
        project_id, prefer_live=prefer_live
    )
    if not sparse_model_path or not sparse_model_path.exists():
        raise FileNotFoundError("No sparse reconstruction found for this project")

    cleanup_paths = []
    try:
        cameras_ref, images_ref, points_ref = _ensure_sparse_text_model(
            sparse_model_path
        )
        if isinstance(cameras_ref, str):
            cleanup_paths.append(cameras_ref)
            cameras_path = Path(cameras_ref)
        else:
            cameras_path = cameras_ref
        if isinstance(images_ref, str):
            cleanup_paths.append(images_ref)
            images_path = Path(images_ref)
        else:
            images_path = images_ref
        if isinstance(points_ref, str):
            cleanup_paths.append(points_ref)
            points_path = Path(points_ref)
        else:
            points_path = points_ref

        cameras = _parse_colmap_cameras_txt(cameras_path)
        images = _parse_colmap_images_txt(images_path, cameras)
        for image in images:
            image["image_url"] = image["image_url"].format(project_id=project_id)
        sparse_points, sparse_point_count = _parse_colmap_points3d_txt(points_path)
        return (
            str(sparse_model_path),
            images,
            sparse_points,
            sparse_point_count,
            source_type,
        )
    finally:
        for path in cleanup_paths:
            try:
                os.unlink(path)
            except OSError:
                pass


@api_bp.route("/health", methods=["GET"])
def health_check():
    pycolmap_module = get_pycolmap_module()
    pycolmap_version = getattr(pycolmap_module, "__version__", None) if pycolmap_module else None
    pycolmap_ready = pycolmap_supports_global_mapping()

    return jsonify(
        {
            "status": "healthy",
            "timestamp": datetime.now().isoformat(),
            "services": {
                "backend": "running",
                "opensplat": "available"
                if app_config.OPENSPLAT_BINARY_PATH.exists()
                else "not_found",
                "colmap": "available"
                if shutil.which(get_colmap_executable())
                else "not_found",
                "pycolmap": "available" if pycolmap_module else "not_found",
                "pycolmap_global_mapping": "ready" if pycolmap_ready else "not_ready",
            },
            "experimental": {
                "pycolmap": {
                    "installed": pycolmap_module is not None,
                    "version": pycolmap_version,
                    "global_mapping_ready": pycolmap_ready,
                }
            },
        }
    )


@api_bp.route("/upload/policy_preview", methods=["POST"])
def upload_policy_preview():
    payload = request.get_json(silent=True) or {}

    files = payload.get("files") or []
    file_names = [str(file.get("name") or "") for file in files if file.get("name")]
    image_names = [
        name for name in file_names if get_file_type(name) == "image"
    ]
    video_count = sum(1 for name in file_names if get_file_type(name) == "video")
    image_count = len(image_names)

    input_type = payload.get("input_type")
    if input_type not in {"images", "video", "mixed"}:
        if video_count and image_count:
            input_type = "mixed"
        elif video_count:
            input_type = "video"
        elif image_count:
            input_type = "images"
        else:
            input_type = "unknown"

    def parse_int(value, default):
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def parse_float(value, default):
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def parse_bool(value, default=False):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() == "true"
        if value is None:
            return default
        return bool(value)

    config = {
        "camera_model": payload.get("camera_model", "SIMPLE_RADIAL"),
        "matcher_type": payload.get("matcher_type"),
        "quality_mode": payload.get("quality_mode", "balanced"),
        "sfm_engine": payload.get("sfm_engine", "glomap"),
        "sfm_backend": payload.get("sfm_backend", "cli"),
        "fast_sfm": parse_bool(payload.get("fast_sfm"), False),
        "feature_method": payload.get("feature_method", "sift"),
        "extraction_mode": payload.get("extraction_mode", "fps"),
        "max_frames": parse_int(payload.get("max_frames"), 100),
        "target_fps": parse_float(payload.get("target_fps"), 1.0),
        "quality": parse_int(payload.get("quality"), 100),
        "preview_count": parse_int(payload.get("preview_count"), 10),
        "smart_frame_selection": parse_bool(payload.get("smart_frame_selection"), True),
        "adaptive_frame_budget": parse_bool(
            payload.get("adaptive_frame_budget"), True
        ),
        "oversample_factor": parse_int(payload.get("oversample_factor"), 10),
        "replacement_search_radius": parse_int(payload.get("replacement_search_radius"), 4),
        "ffmpeg_cpu_workers": parse_int(payload.get("ffmpeg_cpu_workers"), 4),
        "use_gpu_extraction": parse_bool(payload.get("use_gpu_extraction"), True),
        "colmap_resolution": payload.get("colmap_resolution", "2K"),
        "training_resolution": payload.get("training_resolution", "4K"),
        "use_separate_training_images": parse_bool(payload.get("use_separate_training_images"), False),
        "crop_size": parse_int(payload.get("crop_size"), 0),
        "mixed_precision": parse_bool(payload.get("mixed_precision"), False),
        "adaptive_pair_scheduling": parse_bool(
            payload.get("adaptive_pair_scheduling"), True
        ),
        "input_type": input_type,
        "resource_override_source": "automatic",
    }

    for key in (
        "iterations",
        "max_num_features",
        "max_num_matches",
        "sequential_overlap",
        "min_num_matches",
        "max_num_models",
        "init_num_trials",
    ):
        if payload.get(key) is not None:
            config[key] = parse_int(payload.get(key), 0)

    for key in (
        "densify_grad_threshold",
        "refine_every",
        "warmup_length",
        "ssim_weight",
        "learning_rate",
        "position_lr_init",
        "position_lr_final",
        "feature_lr",
        "opacity_lr",
        "scaling_lr",
        "rotation_lr",
        "percent_dense",
        "peak_threshold",
        "edge_threshold",
        "max_num_orientations",
    ):
        if payload.get(key) is not None:
            try:
                config[key] = float(payload.get(key))
            except (TypeError, ValueError):
                pass

    preview = build_upload_policy_preview(
        config,
        {
            "input_type": input_type,
            "file_names": file_names,
            "image_names": image_names,
            "image_count": image_count,
            "video_count": video_count,
        },
    )
    if input_type in {"video", "mixed"}:
        preview["adaptive_comparisons"] = build_upload_adaptive_policy_comparisons(
            config,
            {
                "input_type": input_type,
                "file_names": file_names,
                "image_names": image_names,
                "image_count": image_count,
                "video_count": video_count,
            },
            current_preview=preview,
        )
    return jsonify(preview)


@api_bp.route("/upload", methods=["POST"])
def upload_files():
    """Handle file upload (images and/or videos)."""
    # Normalise incoming payload – support both `files` list and single `file`
    files = request.files.getlist("files")

    if not files:
        single_file = request.files.get("file")
        if single_file:
            files = [single_file]

    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    project_id = str(uuid.uuid4())
    paths = setup_project_directories(project_id)

    saved_files = []
    video_files = []
    image_files = []

    for file in files:
        if not file or file.filename == "":
            continue

        if allowed_file(file.filename):
            filename = secure_unicode_filename(file.filename)
            file_type = get_file_type(filename)

            if file_type == "video":
                # Save video file
                video_path = paths["project_path"] / filename
                file.save(video_path)
                video_files.append(str(video_path))
                saved_files.append(filename)

            elif file_type == "image":
                # Save image file directly to images folder
                image_path = paths["images_path"] / filename
                file.save(image_path)
                image_files.append(str(image_path))
                saved_files.append(filename)

    if not saved_files:
        return jsonify({"error": "No valid files uploaded"}), 400

    # Determine input type
    if video_files and image_files:
        input_type = "mixed"
    elif video_files:
        input_type = "video"
    else:
        input_type = "images"

    # Get processing configuration
    quality_mode = request.form.get("quality_mode", "balanced")

    matcher_type = request.form.get("matcher_type") or None
    if matcher_type and matcher_type.strip().lower() == "auto":
        matcher_type = None

    config = {
        "camera_model": request.form.get("camera_model", "SIMPLE_RADIAL"),
        "matcher_type": matcher_type,
        "quality_mode": quality_mode,
        "sfm_engine": request.form.get("sfm_engine", "glomap"),
        "sfm_backend": request.form.get("sfm_backend", "cli"),
        "fast_sfm": request.form.get("fast_sfm", "false").lower() == "true",
        "feature_method": request.form.get("feature_method", "sift"),
        # Frame extraction configuration for videos
        "extraction_mode": request.form.get(
            "extraction_mode", "fps"
        ),  # 'frames' or 'fps'
        "max_frames": int(request.form.get("max_frames", 100)),
        "target_fps": float(request.form.get("target_fps", 1.0)),
        "quality": int(
            request.form.get("quality", 100)
        ),  # Legacy - kept for backward compatibility
        "preview_count": int(request.form.get("preview_count", 10)),
        "smart_frame_selection": request.form.get("smart_frame_selection", "true").lower()
        == "true",
        "adaptive_frame_budget": request.form.get(
            "adaptive_frame_budget", "true"
        ).lower()
        == "true",
        "oversample_factor": int(request.form.get("oversample_factor", 10)),
        "replacement_search_radius": int(request.form.get("replacement_search_radius", 4)),
        "ffmpeg_cpu_workers": int(request.form.get("ffmpeg_cpu_workers", 4)),
        # GPU acceleration for video frame extraction (5-10x faster)
        "use_gpu_extraction": request.form.get("use_gpu_extraction", "true").lower()
        == "true",
        # Resolution-based extraction settings (new)
        "colmap_resolution": request.form.get(
            "colmap_resolution", "2K"
        ),  # 720p, 1080p, 2K, 4K, 8K, original
        "training_resolution": request.form.get(
            "training_resolution", "4K"
        ),  # Higher res for 3DGS training
        "use_separate_training_images": request.form.get(
            "use_separate_training_images", "false"
        ).lower()
        == "true",
        # 8K Optimization - Patch-based training (works with all quality modes)
        "crop_size": int(request.form.get("crop_size", 0)),
        # Mixed Precision (FP16) training for reduced VRAM usage
        "mixed_precision": request.form.get("mixed_precision", "false").lower()
        == "true",
        "adaptive_pair_scheduling": request.form.get(
            "adaptive_pair_scheduling", "true"
        ).lower()
        == "true",
        "resource_override_source": "automatic",
    }

    # Add custom parameters if in custom mode
    if quality_mode == "custom":
        # OpenSplat Training Parameters
        if request.form.get("iterations"):
            config["iterations"] = int(request.form.get("iterations"))
        if request.form.get("densify_grad_threshold"):
            config["densify_grad_threshold"] = float(
                request.form.get("densify_grad_threshold")
            )
        if request.form.get("refine_every"):
            config["refine_every"] = int(request.form.get("refine_every"))
        if request.form.get("warmup_length"):
            config["warmup_length"] = int(request.form.get("warmup_length"))
        if request.form.get("ssim_weight"):
            config["ssim_weight"] = float(request.form.get("ssim_weight"))

        # OpenSplat Learning Rates
        if request.form.get("learning_rate"):
            config["learning_rate"] = float(request.form.get("learning_rate"))
        if request.form.get("position_lr_init"):
            config["position_lr_init"] = float(request.form.get("position_lr_init"))
        if request.form.get("position_lr_final"):
            config["position_lr_final"] = float(request.form.get("position_lr_final"))
        if request.form.get("feature_lr"):
            config["feature_lr"] = float(request.form.get("feature_lr"))
        if request.form.get("opacity_lr"):
            config["opacity_lr"] = float(request.form.get("opacity_lr"))
        if request.form.get("scaling_lr"):
            config["scaling_lr"] = float(request.form.get("scaling_lr"))
        if request.form.get("rotation_lr"):
            config["rotation_lr"] = float(request.form.get("rotation_lr"))
        if request.form.get("percent_dense"):
            config["percent_dense"] = float(request.form.get("percent_dense"))

        # COLMAP SIFT Feature Parameters
        if request.form.get("peak_threshold"):
            config["peak_threshold"] = float(request.form.get("peak_threshold"))
        if request.form.get("edge_threshold"):
            config["edge_threshold"] = float(request.form.get("edge_threshold"))
        if request.form.get("max_num_orientations"):
            config["max_num_orientations"] = int(
                request.form.get("max_num_orientations")
            )

        # COLMAP Feature Extraction & Matching
        if request.form.get("max_num_features"):
            config["max_num_features"] = int(request.form.get("max_num_features"))
        if request.form.get("max_num_matches"):
            config["max_num_matches"] = int(request.form.get("max_num_matches"))
        if request.form.get("sequential_overlap"):
            config["sequential_overlap"] = int(request.form.get("sequential_overlap"))

        # COLMAP Mapper (Reconstruction)
        if request.form.get("min_num_matches"):
            config["min_num_matches"] = int(request.form.get("min_num_matches"))
        if request.form.get("max_num_models"):
            config["max_num_models"] = int(request.form.get("max_num_models"))
        if request.form.get("init_num_trials"):
            config["init_num_trials"] = int(request.form.get("init_num_trials"))
    else:
        # For non-custom modes, use default iterations from quality mode
        if request.form.get("iterations"):
            config["iterations"] = int(request.form.get("iterations"))

    now_iso = datetime.now().isoformat()
    metadata = {
        "name": request.form.get("project_name") or f"PobimSplats {project_id[:8]}",
        "description": request.form.get("project_description", ""),
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    entry = initialize_project_entry(
        project_id,
        metadata=metadata,
        config=config,
        file_count=len(saved_files),
        files=saved_files,
        log_file=paths["log_file"],
        input_type=input_type,
    )

    with project_store.status_lock:
        project_store.processing_status[project_id] = entry
        save_projects_db()

    append_log_line(
        project_id, f"Project created: {input_type} input with {len(saved_files)} files"
    )
    append_log_line(
        project_id, f"Videos: {len(video_files)}, Images: {len(image_files)}"
    )
    if video_files:
        append_log_line(
            project_id,
            "Adaptive policy: "
            f"frame_budget={'on' if config.get('adaptive_frame_budget', True) else 'off'} | "
            f"pair_scheduling={'on' if config.get('adaptive_pair_scheduling', True) else 'off'}",
        )
        if config["extraction_mode"] == "fps":
            append_log_line(
                project_id,
                f"Frame extraction: {config['target_fps']} FPS, oversample={config.get('oversample_factor', 10)}x, workers={config['ffmpeg_cpu_workers']}, quality={config['quality']}%",
            )
        elif config["extraction_mode"] == "target_count":
            append_log_line(
                project_id,
                f"Frame extraction: exact {config['max_frames']} frames with FPS-style spacing, oversample={config.get('oversample_factor', 10)}x, workers={config['ffmpeg_cpu_workers']}, quality={config['quality']}%",
            )
        else:
            append_log_line(
                project_id,
                f"Frame extraction: max {config['max_frames']} frames, oversample={config.get('oversample_factor', 10)}x, workers={config['ffmpeg_cpu_workers']}, quality={config['quality']}%",
            )

    # Start background processing
    thread = threading.Thread(
        target=run_processing_pipeline,
        args=(project_id, paths, config, video_files, image_files),
    )
    thread.daemon = True
    thread.start()

    return jsonify(
        {
            "success": True,
            "project_id": project_id,
            "filename": saved_files[0] if saved_files else "",
            "path": video_files[0]
            if video_files
            else (image_files[0] if image_files else ""),
            "input_type": input_type,
            "total_files": len(saved_files),
            "video_files": len(video_files),
            "image_files": len(image_files),
            "message": f"Successfully uploaded {len(saved_files)} files",
        }
    )


@api_bp.route("/video_compatibility", methods=["POST"])
def check_video_compatibility():
    """Check if an uploaded video is compatible for processing"""
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if file.filename == "":
        return jsonify({"error": "No file selected"}), 400

    if not file.filename.lower().endswith(tuple(app_config.VIDEO_EXTENSIONS)):
        return jsonify({"error": "File is not a supported video format"}), 400

    try:
        # Save temporary file
        temp_filename = secure_unicode_filename(file.filename)
        temp_path = app_config.UPLOAD_FOLDER / f"temp_{uuid.uuid4()}_{temp_filename}"
        file.save(temp_path)

        # Initialize video processor and check compatibility
        video_processor = VideoProcessor()
        validation = video_processor.validate_video_compatibility(temp_path)

        # Get basic video info for display
        video_info = video_processor.get_video_info(temp_path)

        # Clean up temp file
        temp_path.unlink()

        result = {
            "is_compatible": validation["is_compatible"],
            "codec_name": validation["codec_name"],
            "issues": validation["issues"],
            "recommendations": validation["recommendations"],
            "video_info": video_info,
        }

        return jsonify(result)

    except Exception as e:
        # Clean up temp file if it exists
        if "temp_path" in locals() and temp_path.exists():
            temp_path.unlink()

        logger.error(f"Video compatibility check failed: {e}")
        return jsonify(
            {
                "error": f"Failed to check video compatibility: {str(e)}",
                "is_compatible": False,
                "issues": ["Unable to analyze video file"],
                "recommendations": ["Try converting to H.264 format"],
            }
        ), 500


@api_bp.route("/process/<project_id>", methods=["POST", "OPTIONS"])
def process_project(project_id):
    """Start processing for a project."""
    # Handle CORS preflight
    if request.method == "OPTIONS":
        response = jsonify({"status": "ok"})
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        return response

    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    # Project already being processed
    return jsonify(
        {
            "success": True,
            "project_id": project_id,
            "status": project_store.processing_status[project_id]["status"],
        }
    )


@api_bp.route("/status/<project_id>")
def get_status(project_id):
    """Get project processing status."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    with project_store.status_lock:
        data = project_store.processing_status[project_id].copy()

        recent_logs, log_count = get_recent_log_lines(project_id)
        data["recent_logs"] = recent_logs
        data["log_count"] = log_count
        data["log_visible_count"] = len(recent_logs)
        data["log_truncated"] = log_count > len(recent_logs)
        data["stage_details"] = data.get("stage_details", {})

    return jsonify(data)


@api_bp.route("/project/<project_id>/logs")
def download_project_logs(project_id):
    """Download the full persisted processing log."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    with project_store.status_lock:
        log_file = Path(project_store.processing_status[project_id]["log_file"])

    if not log_file.exists():
        return jsonify({"error": "Log file not found"}), 404

    download_name = f"{project_id}_processing.log"
    return send_file(
        log_file,
        mimetype="text/plain; charset=utf-8",
        as_attachment=True,
        download_name=download_name,
        max_age=0,
    )


@api_bp.route("/ply/<project_id>")
def serve_ply(project_id):
    """Serve PLY file with CORS headers."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    # Try different PLY file naming patterns
    ply_path = (
        app_config.RESULTS_FOLDER / project_id / f"{project_id}_high_7000iter.ply"
    )
    if not ply_path.exists():
        ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_2000iter.ply"

    if not ply_path.exists():
        # Try to find any PLY file in the directory
        project_dir = app_config.RESULTS_FOLDER / project_id
        if project_dir.exists():
            ply_files = list(project_dir.glob("*.ply"))
            if ply_files:
                ply_path = ply_files[0]  # Use the first PLY file found
            else:
                return jsonify({"error": "PLY file not found"}), 404
        else:
            return jsonify({"error": "PLY file not found"}), 404

    response = send_file(
        ply_path, mimetype="application/octet-stream", as_attachment=False
    )

    # Add CORS headers for SuperSplat viewer
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET"
    response.headers["Cache-Control"] = "public, max-age=3600"

    return response


@api_bp.route("/frame_previews/<project_id>")
def get_frame_previews(project_id):
    """Get extracted frame previews for display."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    project_path = app_config.UPLOAD_FOLDER / project_id
    images_path = project_path / "images"
    training_images_path = project_path / "training_images"

    result = {
        "colmap_frames": [],
        "training_frames": [],
        "frames": [],  # Legacy - combined list for backward compatibility
        "has_separate_training": False,
    }

    # Get COLMAP frames
    if images_path.exists():
        frame_files = sorted(images_path.glob("frame_*.jpg"))
        for frame_file in frame_files:
            frame_info = {
                "name": frame_file.name,
                "url": _preview_url_with_version(
                    f"/api/frame_preview/{project_id}/{frame_file.name}",
                    frame_file,
                ),
                "type": "colmap",
            }
            result["colmap_frames"].append(frame_info)
            result["frames"].append(frame_info)

    # Get high-res training frames (if separate extraction was used)
    if training_images_path.exists():
        training_files = sorted(training_images_path.glob("frame_*.jpg"))
        if training_files:
            result["has_separate_training"] = True
            for frame_file in training_files:
                frame_info = {
                    "name": frame_file.name,
                    "url": _preview_url_with_version(
                        f"/api/training_frame_preview/{project_id}/{frame_file.name}",
                        frame_file,
                    ),
                    "type": "training",
                }
                result["training_frames"].append(frame_info)

    result["count"] = len(result["frames"])
    result["training_count"] = len(result["training_frames"])

    if not result["frames"]:
        result["message"] = "No frames extracted yet"

    response = jsonify(result)
    response.cache_control.no_cache = True
    response.cache_control.no_store = True
    response.cache_control.must_revalidate = True
    response.expires = 0
    return response


@api_bp.route("/training_frame_preview/<project_id>/<filename>")
def serve_training_frame_preview(project_id, filename):
    """Serve individual high-res training frame preview."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    frame_path = app_config.UPLOAD_FOLDER / project_id / "training_images" / filename

    if not frame_path.exists():
        return jsonify({"error": "Training frame not found"}), 404

    return _send_uncached_preview(frame_path)


@api_bp.route("/project/<project_id>/image_preview/<path:filename>")
def serve_project_image_preview(project_id, filename):
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    candidate_paths = [
        app_config.UPLOAD_FOLDER / project_id / "images" / filename,
        app_config.UPLOAD_FOLDER / project_id / "training_images" / filename,
    ]

    for candidate in candidate_paths:
        if candidate.exists():
            return _send_uncached_preview(candidate)

    return jsonify({"error": "Image not found"}), 404


@api_bp.route("/frame_preview/<project_id>/<filename>")
def serve_frame_preview(project_id, filename):
    """Serve individual frame preview."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    frame_path = app_config.UPLOAD_FOLDER / project_id / "images" / filename

    if not frame_path.exists():
        return jsonify({"error": "Frame not found"}), 404

    return _send_uncached_preview(frame_path)


@api_bp.route("/project/<project_id>/thumbnail")
def get_project_thumbnail(project_id):
    """Get thumbnail image for a project (first available image)."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    images_path = app_config.UPLOAD_FOLDER / project_id / "images"

    if not images_path.exists():
        return jsonify({"error": "No images found"}), 404

    # Try to find the first image file
    image_files = []
    for ext in [".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"]:
        image_files.extend(sorted(images_path.glob(f"*{ext}")))

    if not image_files:
        return jsonify({"error": "No images found"}), 404

    # Return the first image
    thumbnail_path = image_files[0]

    return _send_uncached_preview(thumbnail_path)


@api_bp.route("/download/<project_id>")
def download_ply(project_id):
    """Download PLY file as attachment."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    project = project_store.processing_status[project_id]

    # Try different PLY file naming patterns
    ply_path = (
        app_config.RESULTS_FOLDER / project_id / f"{project_id}_high_7000iter.ply"
    )
    if not ply_path.exists():
        ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_2000iter.ply"

    if not ply_path.exists():
        # Try to find any PLY file in the directory
        project_dir = app_config.RESULTS_FOLDER / project_id
        if project_dir.exists():
            ply_files = list(project_dir.glob("*.ply"))
            if ply_files:
                ply_path = ply_files[0]  # Use the first PLY file found
            else:
                return jsonify({"error": "PLY file not found"}), 404
        else:
            return jsonify({"error": "PLY file not found"}), 404

    # Create a safe filename
    project_name = project.get("metadata", {}).get(
        "name", f"PobimSplats_{project_id[:8]}"
    )
    safe_filename = "".join(
        c for c in project_name if c.isalnum() or c in (" ", "-", "_")
    ).rstrip()
    download_filename = f"{safe_filename}_{project_id[:8]}.ply"

    return send_file(
        ply_path,
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=download_filename,
    )


@api_bp.route("/project/<project_id>/ply_files")
def list_ply_files(project_id):
    """List all PLY files available for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    project = project_store.processing_status[project_id]
    project_name = project.get("metadata", {}).get(
        "name", f"PobimSplats_{project_id[:8]}"
    )

    project_dir = app_config.RESULTS_FOLDER / project_id
    ply_files = []

    if project_dir.exists():
        for ply_path in sorted(
            project_dir.glob("*.ply"), key=lambda p: p.stat().st_mtime, reverse=True
        ):
            # Parse filename to extract info
            filename = ply_path.name
            file_size = ply_path.stat().st_size
            created_at = ply_path.stat().st_mtime

            # Try to extract quality mode and iterations from filename
            # Format: {project_id}_{quality}_{iterations}iter.ply
            parts = filename.replace(".ply", "").split("_")
            quality_mode = "unknown"
            iterations = 0

            for i, part in enumerate(parts):
                if part.endswith("iter"):
                    try:
                        iterations = int(part.replace("iter", ""))
                    except ValueError:
                        pass
                elif part in [
                    "fast",
                    "balanced",
                    "high",
                    "ultra",
                    "professional",
                    "ultra_professional",
                    "custom",
                ]:
                    quality_mode = part

            ply_files.append(
                {
                    "filename": filename,
                    "path": str(ply_path),
                    "size": file_size,
                    "size_mb": round(file_size / (1024 * 1024), 2),
                    "created_at": created_at,
                    "quality_mode": quality_mode,
                    "iterations": iterations,
                    "download_url": f"/api/download/{project_id}/{filename}",
                }
            )

    return jsonify(
        {
            "project_id": project_id,
            "project_name": project_name,
            "ply_files": ply_files,
            "total": len(ply_files),
        }
    )


@api_bp.route("/download/<project_id>/<filename>")
def download_specific_ply(project_id, filename):
    """Download a specific PLY file by filename."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    project = project_store.processing_status[project_id]

    # Security: prevent path traversal
    if ".." in filename or "/" in filename or "\\" in filename:
        return jsonify({"error": "Invalid filename"}), 400

    ply_path = app_config.RESULTS_FOLDER / project_id / filename
    if not ply_path.exists():
        return jsonify({"error": "PLY file not found"}), 404

    # Create a safe download filename
    project_name = project.get("metadata", {}).get(
        "name", f"PobimSplats_{project_id[:8]}"
    )
    safe_filename = "".join(
        c for c in project_name if c.isalnum() or c in (" ", "-", "_")
    ).rstrip()

    # Keep original filename info but prefix with project name
    download_filename = f"{safe_filename}_{filename}"

    return send_file(
        ply_path,
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=download_filename,
    )


@api_bp.route("/project/<project_id>/retry", methods=["POST"])
def retry_project(project_id):
    """Retry processing from a specific stage."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    data = request.get_json() or {}
    from_stage = data.get("from_stage", "ingest")  # Default to start from beginning

    project = project_store.processing_status[project_id]

    # Check if project is already processing
    if project["status"] == "processing":
        return jsonify({"error": "Project is already processing"}), 400

    # Validate stage
    valid_stages = [s["key"] for s in app_config.PIPELINE_STAGES]
    if from_stage not in valid_stages:
        return jsonify({"error": f"Invalid stage: {from_stage}"}), 400

    try:
        # Get project paths
        paths = setup_project_directories(project_id)
        config = project.get("config", {}).copy()
        _prepare_retry_artifacts(project_id, paths, from_stage)

        # Merge new parameters if provided (for retry with updated settings)
        new_params = data.get("params", {})
        if new_params:
            append_log_line(project_id, "🔧 Updating configuration with new parameters")
            config["resource_override_source"] = "manual_retry"

            # Update OpenSplat training parameters if provided
            for param_key in [
                "iterations",
                "densify_grad_threshold",
                "refine_every",
                "warmup_length",
                "ssim_weight",
                "learning_rate",
                "position_lr_init",
                "position_lr_final",
                "feature_lr",
                "opacity_lr",
                "scaling_lr",
                "rotation_lr",
                "percent_dense",
                "crop_size",
            ]:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(
                        project_id, f"  • {param_key}: {new_params[param_key]}"
                    )

            # Update COLMAP Feature Extraction parameters if provided
            for param_key in [
                "max_num_features",
                "max_image_size",
                "peak_threshold",
                "edge_threshold",
            ]:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(
                        project_id, f"  • {param_key}: {new_params[param_key]}"
                    )

            # Update COLMAP Feature Matching parameters if provided
            for param_key in ["matcher_type", "max_num_matches", "sequential_overlap"]:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(
                        project_id, f"  • {param_key}: {new_params[param_key]}"
                    )

            # Update COLMAP Sparse Reconstruction parameters if provided
            for param_key in [
                "min_num_matches",
                "max_num_models",
                "init_num_trials",
                "force_cpu_sparse_reconstruction",
                "sparse_retry_sfm_engine",
            ]:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(
                        project_id, f"  • {param_key}: {new_params[param_key]}"
                    )

            # Update resolution settings if provided
            for param_key in [
                "extraction_mode",
                "max_frames",
                "target_fps",
                "colmap_resolution",
                "training_resolution",
                "use_separate_training_images",
                "smart_frame_selection",
                "adaptive_frame_budget",
                "oversample_factor",
                "replacement_search_radius",
                "ffmpeg_cpu_workers",
                "adaptive_pair_scheduling",
            ]:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(
                        project_id, f"  • {param_key}: {new_params[param_key]}"
                    )

            # Update quality mode if provided
            if "quality_mode" in new_params and new_params["quality_mode"]:
                config["quality_mode"] = new_params["quality_mode"]
                append_log_line(
                    project_id, f"  • quality_mode: {new_params['quality_mode']}"
                )

            # Save updated config to project
            with project_store.status_lock:
                project_store.processing_status[project_id]["config"] = config
                save_projects_db()
        else:
            config["resource_override_source"] = "manual_retry"

        # Determine video and image files
        video_files = []
        image_files = []

        # Check for existing video files
        project_path = app_config.UPLOAD_FOLDER / project_id
        for ext in app_config.VIDEO_EXTENSIONS:
            video_files.extend([str(p) for p in project_path.glob(f"*{ext}")])

        # Check for existing image files
        images_path = paths["images_path"]
        for ext in app_config.IMAGE_EXTENSIONS:
            image_files.extend([str(p) for p in images_path.glob(f"*{ext}")])

        # Reset project status
        with project_store.status_lock:
            project_store.processing_status[project_id]["status"] = "processing"
            project_store.processing_status[project_id]["error"] = None
            project_store.processing_status[project_id]["end_time"] = None

            if from_stage in {"video_extraction", "feature_extraction", "feature_matching", "sparse_reconstruction"}:
                project_store.processing_status[project_id].pop("video_extraction_diagnostics", None)

            # Reset stages from the specified stage onwards
            stage_found = False
            for state in project_store.processing_status[project_id].get(
                "progress_states", []
            ):
                if state["key"] == from_stage:
                    stage_found = True

                if stage_found:
                    state["status"] = "pending"
                    state["progress"] = 0
                    state["started_at"] = None
                    state["completed_at"] = None

            save_projects_db()

        append_log_line(project_id, f"🔄 Retrying processing from stage: {from_stage}")

        # Start background processing from the specified stage
        thread = threading.Thread(
            target=run_processing_pipeline_from_stage,
            args=(project_id, paths, config, video_files, image_files, from_stage),
        )
        thread.daemon = True
        thread.start()

        return jsonify(
            {
                "success": True,
                "project_id": project_id,
                "from_stage": from_stage,
                "message": f"Processing restarted from {from_stage}",
            }
        )

    except Exception as e:
        logger.error(f"Failed to retry project {project_id}: {e}")
        return jsonify({"error": str(e)}), 500


@api_bp.route("/projects")
def list_projects():
    """API endpoint to list all projects."""
    with project_store.status_lock:
        projects = [
            {
                "id": pid,
                "metadata": data["metadata"],
                "status": data["status"],
                "progress": data.get("progress", 0),
                "input_type": data.get("input_type", "images"),
                "file_count": data.get("file_count", 0),
                "created_at": data.get("start_time"),
                "quality_mode": (data.get("config") or {}).get("quality_mode"),
                "reconstruction_framework": data.get("reconstruction_framework"),
                "resource_coordination": data.get("resource_coordination"),
                "auto_tuning_summary": (
                    (data.get("reconstruction_framework") or {}).get("auto_tuning_summary")
                    or (data.get("resource_coordination") or {}).get("auto_tuning_summary")
                    or data.get("auto_tuning_summary")
                ),
            }
            for pid, data in project_store.processing_status.items()
        ]

    projects.sort(key=lambda x: x["created_at"], reverse=True)
    return jsonify({"projects": projects})


@api_bp.route("/project/<project_id>/delete", methods=["POST"])
def delete_project(project_id):
    """Delete a project and its files."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        # Remove project files
        project_paths = [
            app_config.UPLOAD_FOLDER / project_id,
            app_config.FRAMES_FOLDER / project_id,
            app_config.RESULTS_FOLDER / project_id,
        ]

        for path in project_paths:
            if path.exists():
                shutil.rmtree(path)

        # Remove from database
        with project_store.status_lock:
            del project_store.processing_status[project_id]
            save_projects_db()

        return jsonify({"success": True})

    except Exception as e:
        logger.error(f"Failed to delete project {project_id}: {e}")
        return jsonify({"error": str(e)}), 500


@api_bp.route("/project/<project_id>/transformation", methods=["GET"])
def get_transformation(project_id):
    """Get saved transformation data for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    with project_store.status_lock:
        transformation = project_store.processing_status[project_id].get(
            "transformation",
            {
                "position": {"x": 0, "y": 0, "z": 0},
                "rotation": {"x": 0, "y": 0, "z": 0},
                "scale": {"x": 1, "y": 1, "z": 1},
            },
        )

    return jsonify({"transformation": transformation})


@api_bp.route("/project/<project_id>/transformation", methods=["POST"])
def save_transformation(project_id):
    """Save transformation data for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        data = request.get_json()
        if not data or "transformation" not in data:
            return jsonify({"error": "Missing transformation data"}), 400

        transformation = data["transformation"]

        # Validate transformation structure
        required_keys = ["position", "rotation"]
        for key in required_keys:
            if key not in transformation:
                return jsonify({"error": f"Missing {key} in transformation"}), 400
            if not all(axis in transformation[key] for axis in ["x", "y", "z"]):
                return jsonify({"error": f"Invalid {key} format"}), 400

        # Save transformation to project data
        with project_store.status_lock:
            project_store.processing_status[project_id]["transformation"] = (
                transformation
            )
            save_projects_db()

        return jsonify({"success": True, "transformation": transformation})

    except Exception as e:
        logger.error(f"Failed to save transformation for project {project_id}: {e}")
        return jsonify({"error": str(e)}), 500


@api_bp.route("/project/<project_id>/open_colmap_gui", methods=["POST"])
def open_colmap_gui(project_id):
    """Get COLMAP GUI command for project inspection."""
    try:
        # Get project paths (convert to absolute paths)
        project_path = (app_config.UPLOAD_FOLDER / project_id).resolve()

        # Check if project folder exists
        if not project_path.exists():
            return jsonify({"error": "Project not found"}), 404

        database_path = (project_path / "database.db").resolve()
        images_path = (project_path / "images").resolve()
        sparse_path = (project_path / "sparse").resolve()

        # Check if required files exist
        if not database_path.exists():
            return jsonify(
                {
                    "error": "COLMAP database not found. Please complete COLMAP processing first."
                }
            ), 404

        if not images_path.exists():
            return jsonify({"error": "Images folder not found"}), 404

        # Select the best sparse model (with most registered images)
        sparse_model_path = None
        if sparse_path.exists():
            sparse_model_path = select_best_sparse_model(sparse_path)
            if sparse_model_path:
                sparse_model_path = sparse_model_path.resolve()

        # Get COLMAP executable
        colmap_exe = get_colmap_executable()

        # Build command with absolute paths
        cmd_parts = [colmap_exe, "gui"]
        cmd_parts.extend(["--database_path", str(database_path)])
        cmd_parts.extend(["--image_path", str(images_path)])

        # Add import path if sparse model exists
        if sparse_model_path and sparse_model_path.exists():
            cmd_parts.extend(["--import_path", str(sparse_model_path)])

        # Format command as string
        command_str = " ".join(cmd_parts)

        logger.info(f"Generated COLMAP GUI command for project {project_id}")
        logger.info(f"Command: {command_str}")

        return jsonify(
            {
                "success": True,
                "command": command_str,
                "working_directory": str(app_config.BACKEND_ROOT),
                "paths": {
                    "database": str(database_path),
                    "images": str(images_path),
                    "sparse": str(sparse_model_path) if sparse_model_path else None,
                },
            }
        )

    except Exception as e:
        logger.error(
            f"Failed to generate COLMAP GUI command for project {project_id}: {e}"
        )
        return jsonify({"error": str(e)}), 500


@api_bp.route("/project/<project_id>/camera_poses", methods=["GET"])
def get_camera_poses(project_id):
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        prefer_live = request.args.get("prefer_live", "1").lower() not in {
            "0",
            "false",
            "no",
        }
        sparse_model_path, cameras, sparse_points, sparse_point_count, source_type = (
            _load_project_camera_poses(project_id, prefer_live=prefer_live)
        )
        project_data = project_store.processing_status.get(project_id, {})
        metadata = project_data.get("metadata") or {}
        config = project_data.get("config") or {}
        total_images = _count_project_images(project_id)
        capture_progress_percent = _calculate_progress_percent(len(cameras), total_images)
        if source_type == "snapshot":
            source_label = (
                f"Live sparse snapshot at {capture_progress_percent}% "
                f"({len(cameras)}/{total_images} cameras)"
                if total_images > 0
                else "Live sparse snapshot"
            )
        else:
            source_label = (
                f"Final sparse model with {len(cameras)}/{total_images} cameras"
                if total_images > 0
                else "Final sparse model"
            )

        return jsonify(
            {
                "project_id": project_id,
                "project_name": metadata.get("name"),
                "sfm_engine": config.get("sfm_engine"),
                "camera_count": len(cameras),
                "total_images": total_images,
                "capture_progress_percent": capture_progress_percent,
                "update_interval_percent": LIVE_PREVIEW_PERCENT_STEP,
                "sparse_model_path": sparse_model_path,
                "sparse_point_count": sparse_point_count,
                "sparse_points": sparse_points,
                "cameras": cameras,
                "is_live": bool(prefer_live and source_type == "snapshot"),
                "source_type": source_type,
                "source_label": source_label,
            }
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except RuntimeError as exc:
        logger.error(f"Failed to load camera poses for project {project_id}: {exc}")
        return jsonify({"error": str(exc)}), 500
    except Exception as exc:
        logger.exception(
            f"Unexpected error loading camera poses for project {project_id}"
        )
        return jsonify({"error": str(exc)}), 500


@api_bp.route("/project/<project_id>/training_preview", methods=["GET"])
def get_training_preview(project_id):
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        _, metadata = _load_training_preview_metadata(project_id)
        project_data = project_store.processing_status.get(project_id, {})
        progress_states = project_data.get("progress_states") or []
        training_stage = next(
            (
                state
                for state in progress_states
                if state.get("key") == "gaussian_splatting"
            ),
            None,
        )
        return jsonify(
            {
                "project_id": project_id,
                "available": True,
                "is_live": bool(training_stage and training_stage.get("status") == "running"),
                **metadata,
            }
        )
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc), "available": False}), 404
    except Exception as exc:
        logger.exception(
            f"Unexpected error loading training preview for project {project_id}"
        )
        return jsonify({"error": str(exc), "available": False}), 500


@api_bp.route("/project/<project_id>/training_preview_file", methods=["GET"])
def get_training_preview_file(project_id):
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        preview_path, _ = _load_training_preview_metadata(project_id)
        return _send_uncached_binary(preview_path)
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:
        logger.exception(
            f"Unexpected error serving training preview for project {project_id}"
        )
        return jsonify({"error": str(exc)}), 500


@api_bp.route("/project/<project_id>/export_mesh", methods=["POST"])
def export_mesh(project_id):
    """
    Export PLY file to mesh format (GLTF/GLB/DAE).

    Request body:
        format: Output format ('gltf', 'glb', or 'dae')
        method: Conversion method ('point_cloud', 'poisson', or 'alpha_shapes')
        options: Optional parameters for conversion (depth, scale, etc.)
    """
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        data = request.get_json() or {}
        output_format = data.get("format", "glb").lower()
        method = data.get("method", "point_cloud").lower()
        options = data.get("options", {})

        # Validate format
        if output_format not in ["gltf", "glb", "dae"]:
            return jsonify({"error": f"Unsupported format: {output_format}"}), 400

        # Validate method
        if method not in ["point_cloud", "poisson", "alpha_shapes"]:
            return jsonify({"error": f"Unsupported method: {method}"}), 400

        # Find PLY file for this project
        project_dir = app_config.RESULTS_FOLDER / project_id
        if not project_dir.exists():
            return jsonify({"error": "Project results not found"}), 404

        ply_files = list(project_dir.glob("*.ply"))
        if not ply_files:
            return jsonify({"error": "No PLY file found for this project"}), 404

        # Use the first (or largest) PLY file
        ply_path = max(ply_files, key=lambda p: p.stat().st_size)

        # Create output path
        output_filename = f"{project_id}_export.{output_format}"
        output_path = project_dir / output_filename

        # Convert using MeshConverter
        converter = MeshConverter()
        logger.info(
            f"Converting {ply_path.name} to {output_format} using {method} method"
        )

        success = converter.convert(
            input_path=ply_path, output_path=output_path, method=method, **options
        )

        if not success:
            return jsonify({"error": "Conversion failed. Check logs for details."}), 500

        # Check if output file was created
        if not output_path.exists():
            return jsonify({"error": "Output file was not created"}), 500

        # Return file info
        file_size = output_path.stat().st_size

        return jsonify(
            {
                "success": True,
                "filename": output_filename,
                "format": output_format,
                "method": method,
                "size": file_size,
                "size_mb": round(file_size / (1024 * 1024), 2),
                "download_url": f"/api/project/{project_id}/download_mesh/{output_filename}",
                "message": f"Successfully converted to {output_format.upper()} using {method} method",
            }
        )

    except Exception as e:
        logger.error(f"Failed to export mesh for project {project_id}: {e}")
        import traceback

        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@api_bp.route("/project/<project_id>/download_mesh/<filename>")
def download_mesh(project_id, filename):
    """Download exported mesh file."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        # Validate filename to prevent directory traversal
        if ".." in filename or "/" in filename:
            return jsonify({"error": "Invalid filename"}), 400

        # Check if file exists
        file_path = app_config.RESULTS_FOLDER / project_id / filename
        if not file_path.exists():
            return jsonify({"error": "File not found"}), 404

        # Determine MIME type
        mime_types = {
            ".gltf": "model/gltf+json",
            ".glb": "model/gltf-binary",
            ".dae": "model/vnd.collada+xml",
        }
        suffix = file_path.suffix.lower()
        mime_type = mime_types.get(suffix, "application/octet-stream")

        # Send file
        return send_file(
            file_path, mimetype=mime_type, as_attachment=True, download_name=filename
        )

    except Exception as e:
        logger.error(f"Failed to download mesh for project {project_id}: {e}")
        return jsonify({"error": str(e)}), 500


@api_bp.route("/project/<project_id>/available_exports")
def list_available_exports(project_id):
    """List all available exported mesh files for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        project_dir = app_config.RESULTS_FOLDER / project_id
        if not project_dir.exists():
            return jsonify({"exports": []})

        # Find all exported mesh files
        export_files = []
        for ext in [".gltf", ".glb", ".dae"]:
            for file_path in project_dir.glob(f"*{ext}"):
                export_files.append(
                    {
                        "filename": file_path.name,
                        "format": ext.replace(".", ""),
                        "size": file_path.stat().st_size,
                        "size_mb": round(file_path.stat().st_size / (1024 * 1024), 2),
                        "created_at": file_path.stat().st_mtime,
                        "download_url": f"/api/project/{project_id}/download_mesh/{file_path.name}",
                    }
                )

        # Sort by creation time (newest first)
        export_files.sort(key=lambda x: x["created_at"], reverse=True)

        return jsonify({"exports": export_files, "count": len(export_files)})

    except Exception as e:
        logger.error(f"Failed to list exports for project {project_id}: {e}")
        return jsonify({"error": str(e)}), 500


def _run_mesh_export_background(project_id, method, quality, output_format):
    """Background worker for mesh export."""
    try:
        logger.info(
            f"[Mesh Export] Starting background export for project {project_id}"
        )

        # Find project paths
        project_path = app_config.UPLOAD_FOLDER / project_id
        sparse_path = project_path / "sparse" / "0"

        if not sparse_path.exists():
            # Try to find any sparse model
            sparse_parent = project_path / "sparse"
            if sparse_parent.exists():
                sparse_models = [p for p in sparse_parent.iterdir() if p.is_dir()]
                if sparse_models:
                    sparse_path = sparse_models[0]
                else:
                    logger.error(
                        f"[Mesh Export] No sparse reconstruction found for {project_id}"
                    )
                    return
            else:
                logger.error(f"[Mesh Export] No sparse folder found for {project_id}")
                return

        # Create output path
        results_dir = app_config.RESULTS_FOLDER / project_id
        results_dir.mkdir(exist_ok=True, parents=True)

        output_filename = f"{project_id}_textured_mesh_{method}.{output_format}"
        output_path = results_dir / output_filename

        # Get COLMAP executable
        colmap_exe = get_colmap_executable()

        # Create MVS mesher
        mesher = MVSMesher(colmap_exe)

        # Run the full pipeline
        logger.info(f"[Mesh Export] Creating textured mesh for project {project_id}...")
        logger.info(
            f"[Mesh Export]   Method: {method}, Quality: {quality}, Format: {output_format}"
        )

        success = mesher.create_full_textured_mesh(
            project_path=project_path,
            sparse_model_path=sparse_path,
            output_path=output_path,
            method=method,
            quality=quality,
            export_format=output_format,
        )

        if success and output_path.exists():
            file_size = output_path.stat().st_size
            logger.info(
                f"[Mesh Export] ✅ Successfully created mesh: {output_filename} ({file_size / (1024 * 1024):.1f} MB)"
            )
        else:
            logger.error(f"[Mesh Export] ❌ Failed to create mesh for {project_id}")

    except Exception as e:
        logger.error(
            f"[Mesh Export] Exception in background export for {project_id}: {e}"
        )
        import traceback

        traceback.print_exc()


@api_bp.route("/project/<project_id>/create_textured_mesh", methods=["POST"])
def create_textured_mesh(project_id):
    """
    Create textured mesh using COLMAP dense reconstruction.
    This creates a proper textured mesh similar to OpenDroneMap.

    This endpoint starts the export in background and returns immediately.
    Use /available_exports to check when it's done.

    Request body:
        method: Meshing method ('poisson' or 'delaunay')
        quality: Reconstruction quality ('low', 'medium', 'high')
        format: Output format ('ply', 'obj', 'glb', 'dae')
    """
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    try:
        data = request.get_json() or {}
        method = data.get("method", "poisson").lower()
        quality = data.get("quality", "medium").lower()
        output_format = data.get("format", "glb").lower()

        # Validate parameters
        if method not in ["poisson", "delaunay"]:
            return jsonify(
                {"error": f'Invalid method: {method}. Use "poisson" or "delaunay"'}
            ), 400

        if quality not in ["low", "medium", "high"]:
            return jsonify(
                {"error": f'Invalid quality: {quality}. Use "low", "medium", or "high"'}
            ), 400

        if output_format not in ["ply", "obj", "glb", "dae"]:
            return jsonify({"error": f"Invalid format: {output_format}"}), 400

        # Check if project has completed sparse reconstruction
        project = project_store.processing_status[project_id]
        if project["status"] not in ["completed", "error"]:
            return jsonify(
                {"error": "Project must complete sparse reconstruction first"}
            ), 400

        # Check if sparse reconstruction exists
        project_path = app_config.UPLOAD_FOLDER / project_id
        sparse_path = project_path / "sparse" / "0"

        if not sparse_path.exists():
            sparse_parent = project_path / "sparse"
            if not sparse_parent.exists() or not any(sparse_parent.iterdir()):
                return jsonify(
                    {
                        "error": "No sparse reconstruction found",
                        "hint": "Project must complete COLMAP sparse reconstruction first",
                    }
                ), 404

        # Start background export
        output_filename = f"{project_id}_textured_mesh_{method}.{output_format}"

        thread = threading.Thread(
            target=_run_mesh_export_background,
            args=(project_id, method, quality, output_format),
            daemon=True,
        )
        thread.start()

        logger.info(
            f"Started mesh export in background for {project_id}: {output_filename}"
        )

        return jsonify(
            {
                "success": True,
                "status": "processing",
                "filename": output_filename,
                "format": output_format,
                "method": method,
                "quality": quality,
                "message": f"Mesh export started. This will take 5-30 minutes depending on quality and image count.",
                "hint": "Use /api/project/{project_id}/available_exports to check when export is complete",
                "check_url": f"/api/project/{project_id}/available_exports",
            }
        )

    except Exception as e:
        logger.error(f"Failed to start mesh export for project {project_id}: {e}")
        import traceback

        traceback.print_exc()
        return jsonify(
            {
                "error": str(e),
                "hint": "Check that COLMAP is installed with dense reconstruction support",
            }
        ), 500


@api_bp.route("/project/<project_id>/cancel", methods=["POST"])
def cancel_project_processing(project_id):
    """
    Cancel active processing for a project.

    This will terminate the currently running process (COLMAP or OpenSplat training).
    The project status will be updated to 'cancelled'.
    """
    if project_id not in project_store.processing_status:
        return jsonify({"error": "Project not found"}), 404

    project = project_store.processing_status[project_id]

    # Check if project is currently processing
    if project["status"] != "processing":
        return jsonify(
            {
                "error": f"Project is not currently processing (status: {project['status']})",
                "status": project["status"],
            }
        ), 400

    try:
        # Import the cancel function
        from ..core.projects import cancel_processing

        # Attempt to cancel the processing
        success = cancel_processing(project_id)

        if success:
            return jsonify(
                {
                    "success": True,
                    "message": "Processing cancelled successfully",
                    "project_id": project_id,
                    "status": "cancelled",
                }
            )
        else:
            return jsonify(
                {
                    "error": "No active process found to cancel",
                    "hint": "The process may have already completed or failed",
                    "status": project["status"],
                }
            ), 404

    except Exception as e:
        logger.error(f"Failed to cancel processing for project {project_id}: {e}")
        import traceback

        traceback.print_exc()
        return jsonify({"error": f"Failed to cancel processing: {str(e)}"}), 500


# =============================================================================
# ArUco Marker Generation Endpoints
# =============================================================================


@api_bp.route("/markers/sheet", methods=["GET"])
def generate_marker_sheet_endpoint():
    """
    Generate a printable sheet of ArUco markers.

    Query params:
        start_id: Starting marker ID (default: 0)
        count: Number of markers (default: 12)
        size_cm: Marker size in centimeters (default: 10)
        dict: ArUco dictionary name (default: 6x6_250)
        format: Output format - pdf, png or jpg (default: pdf)
    """
    try:
        from ..utils.aruco_generator import (
            get_marker_sheet_bytes,
            get_marker_sheet_pdf_bytes,
            ARUCO_DICTS,
        )

        start_id = request.args.get("start_id", 0, type=int)
        count = min(request.args.get("count", 12, type=int), 48)  # Max 48 markers
        size_cm = request.args.get("size_cm", 10.0, type=float)
        dict_name = request.args.get("dict", "6x6_250")
        format_type = request.args.get("format", "pdf").lower()

        # Validate dictionary
        if dict_name not in ARUCO_DICTS:
            dict_name = "6x6_250"

        from io import BytesIO

        if format_type == "pdf":
            # Generate PDF for accurate A4 printing
            pdf_bytes = get_marker_sheet_pdf_bytes(
                start_id=start_id,
                count=count,
                marker_size_cm=size_cm,
                dict_name=dict_name,
            )
            filename = (
                f"aruco_markers_{start_id}-{start_id + count - 1}_{size_cm}cm.pdf"
            )
            return send_file(
                BytesIO(pdf_bytes),
                mimetype="application/pdf",
                as_attachment=True,
                download_name=filename,
            )
        else:
            # Generate image (PNG/JPG)
            image_bytes = get_marker_sheet_bytes(
                start_id=start_id,
                count=count,
                marker_size_cm=size_cm,
                dict_name=dict_name,
                format=format_type,
            )
            mimetype = "image/png" if format_type == "png" else "image/jpeg"
            filename = f"aruco_markers_{start_id}-{start_id + count - 1}_{size_cm}cm.{format_type}"
            return send_file(
                BytesIO(image_bytes),
                mimetype=mimetype,
                as_attachment=True,
                download_name=filename,
            )

    except Exception as e:
        logger.error(f"Failed to generate marker sheet: {e}")
        import traceback

        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@api_bp.route("/markers/single/<int:marker_id>", methods=["GET"])
def generate_single_marker_endpoint(marker_id: int):
    """
    Generate a single ArUco marker.

    Query params:
        size_px: Marker size in pixels (default: 200)
        size_cm: Physical size in cm for label (default: 10)
        dict: ArUco dictionary name (default: 6x6_250)
        format: Output format - png or jpg (default: png)
    """
    try:
        from ..utils.aruco_generator import get_marker_image_bytes, ARUCO_DICTS

        size_px = request.args.get("size_px", 200, type=int)
        dict_name = request.args.get("dict", "6x6_250")
        format_type = request.args.get("format", "png")

        if dict_name not in ARUCO_DICTS:
            dict_name = "6x6_250"

        image_bytes = get_marker_image_bytes(
            marker_id=marker_id,
            size_pixels=size_px,
            dict_name=dict_name,
            format=format_type,
        )

        mimetype = "image/png" if format_type == "png" else "image/jpeg"

        from io import BytesIO

        return send_file(BytesIO(image_bytes), mimetype=mimetype, as_attachment=False)

    except Exception as e:
        logger.error(f"Failed to generate marker: {e}")
        return jsonify({"error": str(e)}), 500


@api_bp.route("/markers/presets", methods=["GET"])
def get_marker_presets():
    """
    Get available marker presets and dictionary options.
    """
    from ..utils.aruco_generator import ARUCO_DICTS

    return jsonify(
        {
            "dictionaries": list(ARUCO_DICTS.keys()),
            "default_dictionary": "6x6_250",
            "presets": [
                {
                    "name": "room_standard",
                    "description": "Standard markers for room scanning (10cm)",
                    "count": 12,
                    "size_cm": 10.0,
                    "use_case": "General indoor scanning",
                },
                {
                    "name": "room_large",
                    "description": "Large floor markers (15cm)",
                    "count": 8,
                    "size_cm": 15.0,
                    "use_case": "Floor and open areas",
                },
                {
                    "name": "corner_small",
                    "description": "Small corner markers (8cm)",
                    "count": 8,
                    "size_cm": 8.0,
                    "start_id": 100,
                    "use_case": "Corners and edges",
                },
                {
                    "name": "object_tiny",
                    "description": "Tiny markers for small objects (5cm)",
                    "count": 6,
                    "size_cm": 5.0,
                    "start_id": 200,
                    "use_case": "Small object scanning",
                },
            ],
            "tips": [
                "Print at 100% scale for accurate size",
                "Use matte paper to reduce reflections",
                "Place markers at different heights",
                "Ensure at least 3-4 markers visible per photo",
                "Avoid placing markers on curved surfaces",
            ],
        }
    )


@api_bp.route("/markers/analyze", methods=["POST"])
def analyze_markers_in_image():
    """
    Analyze an uploaded image for marker detection.
    Useful for checking if markers are properly detected before full processing.
    """
    try:
        from ..utils.aruco_generator import (
            analyze_marker_coverage,
            draw_detected_markers,
            detect_aruco_markers,
        )
        import cv2
        import numpy as np

        if "image" not in request.files:
            return jsonify({"error": "No image file provided"}), 400

        file = request.files["image"]
        dict_name = request.form.get("dict", "6x6_250")
        return_annotated = request.form.get("annotated", "false").lower() == "true"

        # Read image
        file_bytes = np.frombuffer(file.read(), np.uint8)
        image = cv2.imdecode(file_bytes, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"error": "Invalid image file"}), 400

        # Analyze
        analysis = analyze_marker_coverage(image, dict_name)

        if return_annotated:
            # Return annotated image
            corners, ids, _ = detect_aruco_markers(image, dict_name)
            annotated = draw_detected_markers(image, corners, ids)

            _, buffer = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 90])

            from io import BytesIO

            return send_file(BytesIO(buffer.tobytes()), mimetype="image/jpeg")
        else:
            return jsonify(analysis)

    except Exception as e:
        logger.error(f"Failed to analyze markers: {e}")
        return jsonify({"error": str(e)}), 500
