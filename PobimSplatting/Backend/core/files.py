"""
File and directory helper utilities.
"""

from __future__ import annotations

import os
import re
import unicodedata
import uuid
from pathlib import Path
from typing import Dict

from . import config


def allowed_file(filename: str) -> bool:
    """Check if file extension is allowed."""
    return Path(filename).suffix.lower() in config.ALLOWED_EXTENSIONS


def get_file_type(filename: str) -> str:
    """Determine if file is an image or a video."""
    suffix = Path(filename).suffix.lower()
    if suffix in config.IMAGE_EXTENSIONS:
        return "image"
    if suffix in config.VIDEO_EXTENSIONS:
        return "video"
    return "unknown"


def secure_unicode_filename(filename: str) -> str:
    """Return a filesystem-safe filename while preserving non-ASCII characters."""
    if not filename:
        return f"upload_{uuid.uuid4().hex[:8]}"

    basename = os.path.basename(filename)
    basename = unicodedata.normalize("NFKC", basename).replace("\x00", "")
    name, ext = os.path.splitext(basename)

    name = re.sub(r"[^\w\s\-.]", "_", name, flags=re.UNICODE)
    name = re.sub(r"\s+", "_", name, flags=re.UNICODE).strip("._")

    if not name:
        name = f"upload_{uuid.uuid4().hex[:8]}"

    cleaned_ext = re.sub(r"[^.\w-]", "", ext, flags=re.UNICODE)
    if cleaned_ext and not cleaned_ext.startswith("."):
        cleaned_ext = f".{cleaned_ext}"

    return f"{name}{cleaned_ext}"


def setup_project_directories(project_id: str) -> Dict[str, Path]:
    """Set up directory structure for a project and return the paths."""
    project_path = config.UPLOAD_FOLDER / project_id

    paths = {
        "project_path": project_path,
        "images_path": project_path / "images",
        "frames_path": config.FRAMES_FOLDER / project_id,
        "results_path": config.RESULTS_FOLDER / project_id,
        "log_file": project_path / "processing.log",
        "database_path": project_path / "database.db",
        "sparse_path": project_path / "sparse",
        "text_path": project_path / "text",
    }

    for path in paths.values():
        if isinstance(path, Path) and not path.name.endswith(".log") and not path.name.endswith(".db"):
            path.mkdir(parents=True, exist_ok=True)

    return paths

