"""
Application-wide configuration values and filesystem paths.

This module centralises constants so the rest of the codebase can import
them without depending on `app.py`.  All paths are resolved relative to the
backend package to keep behaviour consistent regardless of the working
directory used to start the server.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Dict, Iterable

from flask import Flask

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

BACKEND_ROOT: Path = Path(__file__).resolve().parent.parent
PROJECT_ROOT: Path = BACKEND_ROOT.parent
REPO_ROOT: Path = PROJECT_ROOT.parent
FRONTEND_ROOT: Path = PROJECT_ROOT / "Frontend"

NEXT_BUILD_DIR: Path = FRONTEND_ROOT / ".next"
NEXT_STATIC_DIR: Path = NEXT_BUILD_DIR / "static"
NEXT_SERVER_APP_DIR: Path = NEXT_BUILD_DIR / "server" / "app"
NEXT_PUBLIC_DIR: Path = FRONTEND_ROOT / "public"

# ---------------------------------------------------------------------------
# Core configuration
# ---------------------------------------------------------------------------

DEFAULT_SECRET_KEY = "pobim-splats-secret-key"
MAX_CONTENT_LENGTH = 5 * 1024 * 1024 * 1024  # 5GB

logger = logging.getLogger(__name__)


def create_flask_app() -> Flask:
    """
    Create the Flask application instance with static configuration applied.
    """
    if NEXT_STATIC_DIR.exists():
        app = Flask(
            __name__,
            static_folder=str(NEXT_STATIC_DIR),
            static_url_path="/_next/static",
        )
        logger.info("Serving Next.js static assets from %s", NEXT_STATIC_DIR)
    else:
        app = Flask(__name__)
        logger.warning(
            "Next.js static assets not found at %s. "
            "Frontend pages will fall back to legacy templates if available.",
            NEXT_STATIC_DIR,
        )

    app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", DEFAULT_SECRET_KEY)
    app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
    return app


# ---------------------------------------------------------------------------
# CORS configuration
# ---------------------------------------------------------------------------

CORS_RESOURCES: Dict[str, Dict[str, Iterable[str]]] = {
    r"/api/*": {
        "origins": "*",
        "methods": ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        "allow_headers": ["Content-Type", "Authorization"],
    },
    r"/static/viewer/*": {"origins": "*"},
}

# ---------------------------------------------------------------------------
# Filesystem locations
# ---------------------------------------------------------------------------

UPLOAD_FOLDER: Path = BACKEND_ROOT / "uploads"
RESULTS_FOLDER: Path = BACKEND_ROOT / "results"
FRAMES_FOLDER: Path = BACKEND_ROOT / "frames"
VOCAB_TREE_FOLDER: Path = BACKEND_ROOT / "vocab_trees"
PROJECTS_DB_FILE: Path = BACKEND_ROOT / "projects_db.json"


def ensure_runtime_directories() -> None:
    """Create directories that the application expects at runtime."""
    for directory in (
        UPLOAD_FOLDER,
        RESULTS_FOLDER,
        FRAMES_FOLDER,
        VOCAB_TREE_FOLDER,
    ):
        directory.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# External binary discovery
# ---------------------------------------------------------------------------

DEFAULT_OPENSPLAT_BINARY: Path = (REPO_ROOT / "build" / "opensplat").resolve()
OPENSPLAT_ENV_PATH = os.getenv("OPENSPLAT_PATH")
if OPENSPLAT_ENV_PATH:
    OPENSPLAT_BINARY_PATH: Path = Path(OPENSPLAT_ENV_PATH).expanduser().resolve()
else:
    OPENSPLAT_BINARY_PATH = DEFAULT_OPENSPLAT_BINARY
OPENSPLAT_BUILD_PATH: Path = OPENSPLAT_BINARY_PATH.parent

COLMAP_ENV_PATH = os.getenv("COLMAP_PATH")
COLMAP_CANDIDATE_PATHS = []
if COLMAP_ENV_PATH:
    COLMAP_CANDIDATE_PATHS.append(Path(COLMAP_ENV_PATH).expanduser())

COLMAP_CANDIDATE_PATHS.extend(
    [
        # System-wide installation (highest priority if installed via install.sh)
        Path("/usr/local/bin/colmap"),
        # GPU-enabled COLMAP (highest priority) - actual build location
        (REPO_ROOT / "colmap-build" / "src" / "colmap" / "exe" / "colmap").resolve(),
        # Legacy paths for backwards compatibility
        (
            REPO_ROOT
            / "colmap-build"
            / "colmap"
            / "build_gpu"
            / "src"
            / "colmap"
            / "exe"
            / "colmap"
        ).resolve(),
        # CPU fallbacks
        (REPO_ROOT / "colmap" / "colmap").resolve(),
        (
            REPO_ROOT
            / "colmap-build"
            / "colmap"
            / "build"
            / "src"
            / "colmap"
            / "exe"
            / "colmap"
        ).resolve(),
    ]
)

# Vocabulary tree configuration
VOCAB_TREE_URL = "https://demuc.de/colmap/vocab_tree_flickr100K_words32K.bin"
VOCAB_TREE_FILENAME = "vocab_tree_flickr100K_words32K.bin"

# ---------------------------------------------------------------------------
# File types
# ---------------------------------------------------------------------------

IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".JPG",
    ".JPEG",
    ".PNG",
    ".webp",
    ".tiff",
    ".bmp",
}
VIDEO_EXTENSIONS = {
    ".mp4",
    ".avi",
    ".mov",
    ".mkv",
    ".webm",
    ".m4v",
    ".flv",
    ".wmv",
}
ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS

# ---------------------------------------------------------------------------
# Pipeline stages
# ---------------------------------------------------------------------------

PIPELINE_STAGES = [
    {"key": "ingest", "label": "Processing Upload", "weight": 0.05},
    {"key": "video_extraction", "label": "Video Frame Extraction", "weight": 0.1},
    {"key": "feature_extraction", "label": "COLMAP Feature Extraction", "weight": 0.15},
    {"key": "feature_matching", "label": "COLMAP Feature Matching", "weight": 0.1},
    {"key": "sparse_reconstruction", "label": "Sparse Reconstruction", "weight": 0.2},
    {"key": "model_conversion", "label": "Model Conversion", "weight": 0.05},
    {"key": "gaussian_splatting", "label": "PobimSplats Training", "weight": 0.3},
    {"key": "finalizing", "label": "Finalizing Model", "weight": 0.05},
]

STAGE_WEIGHTS = {stage["key"]: stage["weight"] for stage in PIPELINE_STAGES}
STAGE_LABELS = {stage["key"]: stage["label"] for stage in PIPELINE_STAGES}
MAX_LOG_LINES_IN_RESPONSE = 500

