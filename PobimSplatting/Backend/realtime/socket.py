"""
Socket.IO initialisation and helpers.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from flask import request

from ..core import projects as project_store
from ..core.projects import register_emitters

logger = logging.getLogger(__name__)

try:
    from flask_socketio import SocketIO, emit, join_room, leave_room
except ImportError:  # pragma: no cover - optional dependency
    SocketIO = None  # type: ignore[assignment]
    emit = join_room = leave_room = None  # type: ignore[assignment]
    logger.warning("Flask-SocketIO not available. Real-time updates disabled.")

socketio: Optional["SocketIO"] = None


def init_socketio(app) -> Optional["SocketIO"]:
    """
    Initialise Socket.IO if the dependency is available.
    """
    global socketio

    if SocketIO is None:
        register_emitters()
        return None

    socketio = SocketIO(app, cors_allowed_origins="*", logger=True)
    register_emitters(
        emit_stage_progress=_emit_stage_progress,
        emit_log_message=_emit_log_message,
    )
    _register_handlers()
    return socketio


def _emit_progress_update(project_id: str, event_type: str, data: Dict[str, Any]) -> None:
    """Emit a websocket event to clients subscribed to the project room."""
    if not socketio:
        return

    try:
        socketio.emit(event_type, data, room=project_id)
        logger.debug("Emitted %s to room %s: %s", event_type, project_id, data)
    except Exception as exc:  # pragma: no cover - logging only
        logger.error("Failed to emit progress update: %s", exc)


def _emit_stage_progress(project_id: str, stage_key: str, progress: int, details: Optional[Dict[str, Any]] = None) -> None:
    payload: Dict[str, Any] = {
        "stage": stage_key,
        "progress": progress,
    }
    if details:
        payload["details"] = details
    _emit_progress_update(project_id, "stage_progress", payload)


def _emit_log_message(project_id: str, message: str, timestamp: str) -> None:
    payload = {"message": message, "timestamp": timestamp}
    _emit_progress_update(project_id, "log_message", payload)


def _register_handlers() -> None:
    """Bind Socket.IO event handlers."""
    if not socketio or SocketIO is None:
        return

    @socketio.on("connect")
    def on_connect():
        logger.info("Client connected: %s", request.sid)
        emit("connected", {"status": "Connected to PobimSplats"})

    @socketio.on("disconnect")
    def on_disconnect():
        logger.info("Client disconnected: %s", request.sid)

    @socketio.on("join_project")
    def on_join_project(data):
        project_id = data.get("project_id")
        if project_id and project_id in project_store.processing_status:
            join_room(project_id)
            logger.info("Client %s joined project %s", request.sid, project_id)

            with project_store.status_lock:
                project_data = project_store.processing_status[project_id].copy()
            emit("project_status", project_data)
        else:
            emit("error", {"message": "Invalid project ID"})

    @socketio.on("leave_project")
    def on_leave_project(data):
        project_id = data.get("project_id")
        if project_id:
            leave_room(project_id)
            logger.info("Client %s left project %s", request.sid, project_id)
