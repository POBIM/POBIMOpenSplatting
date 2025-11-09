#!/usr/bin/env python3
"""
PobimSplats Backend
-------------------
This module wires together the Flask application, blueprints, and optional
Socket.IO support. All heavy lifting lives in the specialised packages under
`core/`, `pipeline/`, `routes/`, and `realtime/`.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

# Prefer the bundled virtual environment if the caller forgot to activate it.
_BACKEND_ROOT = Path(__file__).resolve().parent
_REPO_ROOT = _BACKEND_ROOT.parent.parent
for _path in (_REPO_ROOT, _BACKEND_ROOT):
    if _path and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
_VENV_SITE_PACKAGES = list((_BACKEND_ROOT / "venv" / "lib").glob("python*/site-packages"))
for _candidate in _VENV_SITE_PACKAGES:
    python_dir = _candidate.parent.name
    if python_dir != f"python{sys.version_info.major}.{sys.version_info.minor}":
        continue
    if _candidate.exists() and str(_candidate) not in sys.path:
        sys.path.insert(0, str(_candidate))

try:
    from flask import jsonify  # type: ignore  # populated after sys.path adjustment
    from flask_cors import CORS  # type: ignore
    from dotenv import load_dotenv
except ModuleNotFoundError as exc:  # pragma: no cover - guidance for misconfigured envs
    raise ModuleNotFoundError(
        "Flask dependencies not found. Activate the backend virtualenv with "
        "`source PobimSplatting/Backend/venv/bin/activate` before running `python app.py`."
    ) from exc

from PobimSplatting.Backend.core import config as app_config
from PobimSplatting.Backend.core.config import create_flask_app, ensure_runtime_directories
from PobimSplatting.Backend.core.projects import (
    emit_log_message,
    emit_stage_progress,
    load_projects_db,
    save_projects_db,
)
from PobimSplatting.Backend.pipeline.runner import get_colmap_config, get_colmap_executable
from PobimSplatting.Backend.realtime.socket import init_socketio
from PobimSplatting.Backend.routes.api import api_bp
from PobimSplatting.Backend.routes.frontend import frontend_bp

# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = create_flask_app()
CORS(app, resources=app_config.CORS_RESOURCES)

ensure_runtime_directories()
load_projects_db()

socketio = init_socketio(app)
SOCKETIO_AVAILABLE = socketio is not None

app.register_blueprint(frontend_bp)
app.register_blueprint(api_bp)

__all__ = [
    "app",
    "socketio",
    "SOCKETIO_AVAILABLE",
    "get_colmap_executable",
    "get_colmap_config",
    "emit_stage_progress",
    "emit_log_message",
]


@app.errorhandler(413)
def file_too_large(_exc):
    """Handle file too large error."""
    return (
        jsonify(
            {
                "success": False,
                "error": "File too large",
                "message": (
                    "The uploaded file exceeds the maximum size limit of 5GB. "
                    "Please use a smaller file or compress your video."
                ),
                "max_size": "5GB",
            }
        ),
        413,
    )


@app.teardown_appcontext
def persist_projects(_exception=None):
    """Persist the project database whenever the app context tears down."""
    save_projects_db()
    return _exception


def run() -> None:
    """Entry point for running the backend app."""
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))
    debug_enabled = os.getenv("FLASK_DEBUG", "0") == "1"

    if socketio:
        socketio.run(
            app,
            host=host,
            port=port,
            debug=debug_enabled,
            allow_unsafe_werkzeug=True,
        )
    else:
        logger.warning("Starting Flask without Socket.IO support.")
        app.run(host=host, port=port, debug=debug_enabled)


if __name__ == "__main__":
    run()
