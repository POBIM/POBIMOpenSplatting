"""Image preprocessing helpers for reconstruction inputs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np

COLMAP_SHARPENING_MARKER = ".colmap_image_sharpening.json"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"}


def normalize_colmap_sharpness_boost(value: Any, default: int = 0) -> int:
    try:
        boost = int(float(value))
    except (TypeError, ValueError):
        boost = default
    return max(0, min(100, boost))


def _image_signature(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_size}:{stat.st_mtime_ns}"


def _load_marker(marker_path: Path) -> dict[str, Any]:
    try:
        return json.loads(marker_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _write_marker(marker_path: Path, payload: dict[str, Any]) -> None:
    marker_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _laplacian_variance(image: np.ndarray) -> float:
    if image.ndim == 2:
        gray = image
    else:
        channels = image[:, :, :3] if image.shape[2] >= 3 else image
        gray = cv2.cvtColor(channels, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _unsharp_mask(image: np.ndarray, boost: int) -> np.ndarray:
    amount = 1.2 * (boost / 100.0)
    sigma = 1.0

    if image.ndim == 2:
        blurred = cv2.GaussianBlur(image, (0, 0), sigmaX=sigma, sigmaY=sigma)
        return cv2.addWeighted(image, 1.0 + amount, blurred, -amount, 0)

    sharpened = image.copy()
    color = image[:, :, :3]
    blurred = cv2.GaussianBlur(color, (0, 0), sigmaX=sigma, sigmaY=sigma)
    sharpened[:, :, :3] = cv2.addWeighted(color, 1.0 + amount, blurred, -amount, 0)
    return sharpened


def _imwrite(path: Path, image: np.ndarray) -> bool:
    suffix = path.suffix.lower()
    params: list[int] = []
    if suffix in {".jpg", ".jpeg"}:
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 95]
    elif suffix == ".webp":
        params = [int(cv2.IMWRITE_WEBP_QUALITY), 95]
    return bool(cv2.imwrite(str(path), image, params))


def apply_colmap_sharpness_boost(
    images_path: Path,
    project_path: Path,
    boost: Any,
) -> dict[str, Any]:
    normalized_boost = normalize_colmap_sharpness_boost(boost)
    if normalized_boost <= 0:
        return {"enabled": False, "boost": 0, "processed": 0, "skipped": 0, "failed": 0}

    image_files = sorted(
        child
        for child in images_path.iterdir()
        if child.is_file() and child.suffix.lower() in IMAGE_EXTENSIONS
    )
    marker_path = project_path / COLMAP_SHARPENING_MARKER
    marker = _load_marker(marker_path)
    processed_signatures = dict(marker.get("processed_signatures") or {})

    stats = {
        "enabled": True,
        "boost": normalized_boost,
        "processed": 0,
        "skipped": 0,
        "failed": 0,
        "before_sharpness": [],
        "after_sharpness": [],
    }
    next_signatures: dict[str, str] = {}

    for image_path in image_files:
        try:
            current_signature = _image_signature(image_path)
        except OSError:
            stats["failed"] += 1
            continue

        if (
            marker.get("boost") == normalized_boost
            and processed_signatures.get(image_path.name) == current_signature
        ):
            stats["skipped"] += 1
            next_signatures[image_path.name] = current_signature
            continue

        image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
        if image is None:
            stats["failed"] += 1
            continue

        before = _laplacian_variance(image)
        sharpened = _unsharp_mask(image, normalized_boost)
        if not _imwrite(image_path, sharpened):
            stats["failed"] += 1
            continue

        after_image = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
        after = _laplacian_variance(after_image if after_image is not None else sharpened)
        stats["processed"] += 1
        stats["before_sharpness"].append(before)
        stats["after_sharpness"].append(after)
        try:
            next_signatures[image_path.name] = _image_signature(image_path)
        except OSError:
            pass

    for name, signature in processed_signatures.items():
        next_signatures.setdefault(name, signature)

    _write_marker(
        marker_path,
        {
            "boost": normalized_boost,
            "processed_signatures": next_signatures,
        },
    )

    before_scores = stats.pop("before_sharpness")
    after_scores = stats.pop("after_sharpness")
    if before_scores:
        stats["before_mean_sharpness"] = round(float(np.mean(before_scores)), 2)
        stats["after_mean_sharpness"] = round(float(np.mean(after_scores)), 2)
    return stats
