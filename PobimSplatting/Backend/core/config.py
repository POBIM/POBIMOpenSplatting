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
RUNTIME_ROOT: Path = PROJECT_ROOT / "runtime"

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


def _first_existing_file(candidates: Iterable[Path]) -> Path | None:
    """Return the first candidate that exists as a file."""
    for candidate in candidates:
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def _resolve_env_path(env_value: str | None) -> Path | None:
    """Resolve an optional environment path to an absolute Path."""
    if not env_value:
        return None
    return Path(env_value).expanduser().resolve()


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
VOCAB_TREE_CACHE_FOLDER: Path = VOCAB_TREE_FOLDER / "cache"
PROJECTS_DB_FILE: Path = BACKEND_ROOT / "projects_db.json"
AUTO_TUNING_DIR: Path = RUNTIME_ROOT / "auto_tuning"
ORDERED_VIDEO_EVIDENCE_FILE: Path = AUTO_TUNING_DIR / "ordered_video_evidence.json"
ORDERED_VIDEO_TUNED_SNAPSHOT_FILE: Path = AUTO_TUNING_DIR / "ordered_video_tuned_snapshot.json"
ORDERED_VIDEO_STABLE_SNAPSHOT_FILE: Path = AUTO_TUNING_DIR / "ordered_video_stable_snapshot.json"


def ensure_runtime_directories() -> None:
    """Create directories that the application expects at runtime."""
    for directory in (
        UPLOAD_FOLDER,
        RESULTS_FOLDER,
        FRAMES_FOLDER,
        RUNTIME_ROOT,
        AUTO_TUNING_DIR,
        VOCAB_TREE_FOLDER,
        VOCAB_TREE_CACHE_FOLDER,
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
COLMAP_EXECUTABLE_NAME = "colmap"
COLMAP_GLOBAL_MAPPER_SUBCOMMAND = "global_mapper"
COLMAP_CANDIDATE_PATHS = []
_colmap_env_path = _resolve_env_path(COLMAP_ENV_PATH)
if _colmap_env_path:
    COLMAP_CANDIDATE_PATHS.append(_colmap_env_path)
    if _colmap_env_path.is_dir():
        COLMAP_CANDIDATE_PATHS.append(_colmap_env_path / COLMAP_EXECUTABLE_NAME)

COLMAP_CANDIDATE_PATHS.extend(
    [
        # Installed repo-local prefix from install.sh / manual rebuilds
        (REPO_ROOT / "colmap-build" / "install" / "bin" / "colmap").resolve(),
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
COLMAP_BINARY_PATH: Path | None = _first_existing_file(COLMAP_CANDIDATE_PATHS)
COLMAP_PATH: Path | None = COLMAP_BINARY_PATH
COLMAP_AVAILABLE: bool = COLMAP_BINARY_PATH is not None
COLMAP_GLOBAL_MAPPER_PATH: Path | None = COLMAP_BINARY_PATH
COLMAP_GLOBAL_MAPPER_AVAILABLE: bool = COLMAP_AVAILABLE
COLMAP_GLOBAL_MAPPER_COMMAND: tuple[str, ...] = (
    str(COLMAP_BINARY_PATH) if COLMAP_BINARY_PATH else COLMAP_EXECUTABLE_NAME,
    COLMAP_GLOBAL_MAPPER_SUBCOMMAND,
)

# GLOMAP binary discovery (must be compatible with COLMAP version)
GLOMAP_ENV_PATH = os.getenv("GLOMAP_PATH")
GLOMAP_EXECUTABLE_NAME = "glomap"
GLOMAP_MAPPER_SUBCOMMAND = "mapper"
GLOMAP_CANDIDATE_PATHS = []
_glomap_env_path = _resolve_env_path(GLOMAP_ENV_PATH)
if _glomap_env_path:
    GLOMAP_CANDIDATE_PATHS.append(_glomap_env_path)
    if _glomap_env_path.is_dir():
        GLOMAP_CANDIDATE_PATHS.append(_glomap_env_path / GLOMAP_EXECUTABLE_NAME)

GLOMAP_CANDIDATE_PATHS.extend(
    [
        # GLOMAP built with COLMAP 3.14+ (must match COLMAP version for database compatibility)
        # This is the recommended path - ensures GLOMAP and COLMAP share the same database format
        (REPO_ROOT / "colmap-build" / "src" / "glomap" / "glomap").resolve(),
        # System-wide installation (symlink to colmap-build version)
        Path("/usr/local/bin/glomap"),
    ]
)
GLOMAP_BINARY_PATH: Path | None = _first_existing_file(GLOMAP_CANDIDATE_PATHS)
GLOMAP_PATH: Path | None = GLOMAP_BINARY_PATH
GLOMAP_AVAILABLE: bool = GLOMAP_BINARY_PATH is not None
LEGACY_GLOMAP_PATH: Path | None = GLOMAP_BINARY_PATH
LEGACY_GLOMAP_AVAILABLE: bool = GLOMAP_AVAILABLE
GLOMAP_COMMAND: tuple[str, ...] = (
    str(GLOMAP_BINARY_PATH) if GLOMAP_BINARY_PATH else GLOMAP_EXECUTABLE_NAME,
    GLOMAP_MAPPER_SUBCOMMAND,
)

FASTMAP_ENV_PATH = os.getenv("FASTMAP_PATH")
FASTMAP_CANDIDATE_PATHS = []
_fastmap_env_path = _resolve_env_path(FASTMAP_ENV_PATH)
if _fastmap_env_path:
    FASTMAP_CANDIDATE_PATHS.append(_fastmap_env_path)
    if _fastmap_env_path.is_dir():
        FASTMAP_CANDIDATE_PATHS.append(_fastmap_env_path / "run.py")

FASTMAP_CANDIDATE_PATHS.extend(
    [
        (REPO_ROOT / "fastmap" / "run.py").resolve(),
        Path("/usr/local/bin/fastmap"),
    ]
)
FASTMAP_BINARY_PATH: Path | None = _first_existing_file(FASTMAP_CANDIDATE_PATHS)


def get_fastmap_executable():
    if FASTMAP_BINARY_PATH is not None:
        return str(FASTMAP_BINARY_PATH)
    return None

FASTMAP_PATH = get_fastmap_executable()

# hloc (Hierarchical Localization) configuration
# hloc provides neural feature extraction (ALIKED/SuperPoint) + LightGlue matching
# Much faster than COLMAP SIFT for high-resolution images
HLOC_PATH = (REPO_ROOT / "hloc").resolve()
HLOC_AVAILABLE = HLOC_PATH.exists() and (HLOC_PATH / "hloc").exists()

def check_hloc_available():
    """Check if hloc is available and properly installed."""
    try:
        import hloc
        from lightglue import LightGlue, ALIKED
        return True
    except ImportError:
        return False

HLOC_INSTALLED = check_hloc_available()

# Vocabulary tree configuration
VOCAB_TREE_URL = "https://demuc.de/colmap/vocab_tree_flickr100K_words32K.bin"
VOCAB_TREE_FILENAME = "vocab_tree_flickr100K_words32K.bin"
VOCAB_TREE_ENV_PATH = os.getenv("VOCAB_TREE_PATH") or os.getenv("COLMAP_VOCAB_TREE_PATH")
VOCAB_TREE_DEFAULT_PATH: Path = VOCAB_TREE_FOLDER / VOCAB_TREE_FILENAME
VOCAB_TREE_CACHE_PATH: Path = VOCAB_TREE_CACHE_FOLDER / VOCAB_TREE_FILENAME
VOCAB_TREE_CANDIDATE_PATHS = []
_vocab_tree_env_path = _resolve_env_path(VOCAB_TREE_ENV_PATH)
if _vocab_tree_env_path:
    VOCAB_TREE_CANDIDATE_PATHS.append(_vocab_tree_env_path)
    if _vocab_tree_env_path.is_dir():
        VOCAB_TREE_CANDIDATE_PATHS.append(_vocab_tree_env_path / VOCAB_TREE_FILENAME)

VOCAB_TREE_CANDIDATE_PATHS.extend(
    [
        VOCAB_TREE_CACHE_PATH,
        VOCAB_TREE_DEFAULT_PATH,
        (REPO_ROOT / VOCAB_TREE_FILENAME).resolve(),
    ]
)
VOCAB_TREE_PATH: Path | None = _first_existing_file(VOCAB_TREE_CANDIDATE_PATHS)
VOCAB_TREE_AVAILABLE: bool = VOCAB_TREE_PATH is not None

# Preferred SfM engine order for the migration path.
SFM_ENGINE_PREFERENCE = (
    "colmap_global_mapper",
    "glomap",
    "colmap",
)

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
