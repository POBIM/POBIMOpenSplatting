"""
Routes serving HTML pages and static fallbacks.
"""

from __future__ import annotations

import json
import logging
from typing import Callable, Optional

from flask import Blueprint, jsonify, render_template, send_file

from ..core import config as app_config
from ..core import projects as project_store

logger = logging.getLogger(__name__)

frontend_bp = Blueprint("frontend", __name__)


def serve_frontend_page(page_name: str, *, fallback: Optional[Callable[[], str]] = None):
    """Return a rendered Next.js HTML page or fall back to a legacy renderer."""
    html_path = app_config.NEXT_SERVER_APP_DIR / page_name

    if html_path.exists():
        try:
            return send_file(html_path)
        except Exception as exc:
            logger.error("Failed to serve Next.js page %s: %s", html_path, exc)

    if fallback:
        logger.debug("Falling back to legacy renderer for %s", page_name)
        return fallback()

    message = (
        "Next.js build artifacts not found. Run `npm run build` inside "
        "`PobimSplatting/Frontend` to generate *.html files."
    )
    logger.error("Frontend page %s unavailable: %s", page_name, message)
    return jsonify(
        {
            "success": False,
            "error": "frontend_not_built",
            "message": message,
            "page": page_name,
        }
    ), 503


@frontend_bp.route("/")
def index():
    """Main dashboard page served by the Next.js frontend build."""
    return serve_frontend_page("index.html")


@frontend_bp.route("/upload")
def upload_page():
    """Upload page provided by the Next.js frontend."""
    return serve_frontend_page("upload.html")


@frontend_bp.route("/projects")
def projects_page():
    """Projects listing page."""

    def legacy_renderer():
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
                }
                for pid, data in project_store.processing_status.items()
            ]

        projects.sort(key=lambda item: item["created_at"], reverse=True)
        return render_template("projects.html", projects=projects)

    return serve_frontend_page("projects.html", fallback=legacy_renderer)


@frontend_bp.route("/settings")
def settings_page():
    """Pipeline settings page rendered by the Next.js frontend."""
    return serve_frontend_page("settings.html")


@frontend_bp.route("/viewer")
def viewer_page():
    """Viewer shell served by the Next.js frontend."""
    return serve_frontend_page("viewer.html")


@frontend_bp.route("/favicon.ico")
def favicon_asset():
    """Serve favicon from the Next.js public directory."""
    favicon_path = app_config.NEXT_PUBLIC_DIR / "favicon.ico"
    if favicon_path.exists():
        return send_file(favicon_path)
    return "", 404


@frontend_bp.route("/processing/<project_id>")
def processing_page(project_id: str):
    """Dedicated processing progress view."""
    with project_store.status_lock:
        project = project_store.processing_status.get(project_id)
        project_data = json.loads(json.dumps(project, default=str)) if project else None

    if not project_data:
        return (
            render_template(
                "processing.html",
                project_id=project_id,
                project=None,
                pipeline_stages=list(app_config.PIPELINE_STAGES),
            ),
            404,
        )

    return render_template(
        "processing.html",
        project_id=project_id,
        project=project_data,
        pipeline_stages=list(app_config.PIPELINE_STAGES),
    )


@frontend_bp.route("/viewer/<project_id>")
def legacy_viewer(project_id: str):
    """3D model viewer page."""
    if project_id not in project_store.processing_status:
        return "Project not found", 404

    project = project_store.processing_status[project_id]
    ply_file = app_config.RESULTS_FOLDER / project_id / f"{project_id}_2000iter.ply"

    if not ply_file.exists():
        return render_template(
            "processing.html", project_id=project_id, project=project
        )

    return render_template(
        "viewer.html",
        project_id=project_id,
        project=project,
        ply_url=f"/api/ply/{project_id}",
    )
