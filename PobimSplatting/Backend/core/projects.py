"""
Shared project state and persistence helpers.

The functions in this module keep track of per-project progress, logs, and
metadata.  Socket emission callbacks are injected at runtime so the module
remains usable even when WebSocket support is unavailable.
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional

from . import config

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------------
# Runtime state
# ----------------------------------------------------------------------------

processing_status: Dict[str, Dict[str, Any]] = {}
status_lock = threading.RLock()

# Store active process handles for cancellation
active_processes: Dict[str, Any] = {}

_emit_stage_progress: Optional[
    Callable[[str, str, int, Optional[Dict[str, Any]]], None]
] = None
_emit_log_message: Optional[Callable[[str, str, str], None]] = None


def register_emitters(
    *,
    emit_stage_progress: Optional[
        Callable[[str, str, int, Optional[Dict[str, Any]]], None]
    ] = None,
    emit_log_message: Optional[Callable[[str, str, str], None]] = None,
) -> None:
    """
    Register callbacks used to push realtime updates.
    """

    global _emit_stage_progress, _emit_log_message
    _emit_stage_progress = emit_stage_progress
    _emit_log_message = emit_log_message


# ----------------------------------------------------------------------------
# Persistence
# ----------------------------------------------------------------------------


def load_projects_db() -> None:
    """Load the on-disk project database into memory."""
    global processing_status
    database_path = config.PROJECTS_DB_FILE

    if database_path.exists():
        try:
            with database_path.open("r", encoding="utf-8") as handle:
                processing_status = json.load(handle)
                logger.info("Loaded %d projects from database", len(processing_status))
        except Exception as exc:
            logger.error("Failed to load projects database: %s", exc)
            processing_status = {}
    else:
        processing_status = {}


def save_projects_db() -> None:
    """Persist the in-memory project database to disk."""
    try:
        with config.PROJECTS_DB_FILE.open("w", encoding="utf-8") as handle:
            json.dump(processing_status, handle, indent=2, default=str)
    except Exception as exc:
        logger.error("Failed to save projects database: %s", exc)


# ----------------------------------------------------------------------------
# State helpers
# ----------------------------------------------------------------------------


def make_progress_states() -> Iterable[Dict[str, Any]]:
    """Return a fresh copy of the pipeline progress state objects."""
    return [
        {
            "key": stage["key"],
            "label": stage["label"],
            "status": "pending",
            "progress": 0,
            "started_at": None,
            "completed_at": None,
        }
        for stage in config.PIPELINE_STAGES
    ]


def recalculate_overall_progress(project_id: str) -> None:
    """Recalculate overall weighted progress for a project."""
    states = processing_status[project_id].get("progress_states", [])
    total = 0.0
    for state in states:
        weight = config.STAGE_WEIGHTS.get(state["key"], 0)
        total += weight * (state.get("progress", 0) / 100)
    processing_status[project_id]["progress"] = int(round(total * 100))


def update_stage_detail(
    project_id: str, key: str, *, text: Optional[str] = None, subtext: Optional[str] = None
) -> None:
    """Store human-readable progress detail for a pipeline stage."""
    with status_lock:
        project = processing_status.get(project_id)
        if not project:
            return

        stage_details = project.setdefault("stage_details", {})
        detail = stage_details.setdefault(key, {})

        if text is not None:
            detail["text"] = text
        if subtext is not None:
            detail["subtext"] = subtext


def update_state(
    project_id: str,
    key: str,
    *,
    status: Optional[str] = None,
    progress: Optional[int] = None,
    timestamp: Optional[datetime] = None,
    details: Optional[Dict[str, Any]] = None,
) -> None:
    """Update the status or progress timestamp of a given pipeline state."""
    states = processing_status[project_id].get("progress_states", [])
    for state in states:
        if state["key"] == key:
            if status:
                state["status"] = status
                if status == "running" and state["started_at"] is None:
                    state["started_at"] = (timestamp or datetime.now()).isoformat()
                if status == "completed":
                    state["completed_at"] = (timestamp or datetime.now()).isoformat()
            if progress is not None:
                state["progress"] = progress
            break

    recalculate_overall_progress(project_id)

    if progress is not None and _emit_stage_progress:
        _emit_stage_progress(project_id, key, progress, details)


def append_log_line(project_id: str, message: str) -> None:
    """Append a log line to the on-disk log and keep a short in-memory tail."""
    timestamp = datetime.now().isoformat()
    entry = f"[{timestamp}] {message}\n"

    with status_lock:
        status = processing_status.get(project_id)
        if not status:
            return
        log_path = Path(status["log_file"])

        log_tail = status.setdefault("log_tail", [])
        log_tail.append({"time": timestamp, "message": message})
        if len(log_tail) > config.MAX_LOG_LINES_IN_RESPONSE:
            del log_tail[:-config.MAX_LOG_LINES_IN_RESPONSE]

    try:
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(entry)
    except Exception as exc:
        logger.error("Failed writing log for %s: %s", project_id, exc)

    if _emit_log_message:
        _emit_log_message(project_id, message, timestamp)


def initialize_project_entry(
    project_id: str,
    *,
    metadata: Dict[str, Any],
    config: Dict[str, Any],
    file_count: int,
    files: Iterable[str],
    log_file: Path,
    input_type: str = "images",
) -> Dict[str, Any]:
    """Create the base metadata object stored in processing_status."""
    return {
        "status": "queued",
        "step": "ingest",
        "progress": 0,
        "start_time": datetime.now().isoformat(),
        "end_time": None,
        "config": config,
        "file_count": file_count,
        "files": list(files),
        "metadata": metadata,
        "progress_states": list(make_progress_states()),
        "log_file": str(log_file),
        "log_tail": [],
        "input_type": input_type,
        "stage_details": {},
    }


def touch_project_updated(project_id: str) -> None:
    """Update the metadata timestamp for last modification."""
    processing_status[project_id]["metadata"]["updated_at"] = datetime.now().isoformat()


def emit_stage_progress(project_id: str, stage_key: str, progress: int, details: Optional[Dict[str, Any]] = None) -> None:
    """Proxy for emitting progress updates. Kept for backwards compatibility."""
    if _emit_stage_progress:
        _emit_stage_progress(project_id, stage_key, progress, details)


def emit_log_message(project_id: str, message: str) -> None:
    """Proxy for emitting log messages. Kept for backwards compatibility."""
    if _emit_log_message:
        _emit_log_message(project_id, message, datetime.now().isoformat())


# ----------------------------------------------------------------------------
# Process management for cancellation
# ----------------------------------------------------------------------------


def register_process(project_id: str, process: Any) -> None:
    """Register an active process for potential cancellation."""
    with status_lock:
        active_processes[project_id] = process


def unregister_process(project_id: str) -> None:
    """Remove a process from active tracking."""
    with status_lock:
        active_processes.pop(project_id, None)


def cancel_processing(project_id: str) -> bool:
    """
    Cancel the active processing for a project.
    Returns True if a process was found and terminated, False otherwise.
    """
    import signal
    
    with status_lock:
        process = active_processes.get(project_id)
        
        if not process:
            logger.warning(f"No active process found for project {project_id}")
            return False
        
        try:
            # Try graceful termination first
            process.terminate()
            
            # Wait a bit for graceful shutdown
            try:
                process.wait(timeout=5)
            except Exception:
                # Force kill if still running
                process.kill()
                process.wait()
            
            # Update project status
            if project_id in processing_status:
                processing_status[project_id]["status"] = "cancelled"
                processing_status[project_id]["end_time"] = datetime.now().isoformat()
                
                # Mark current running stage as cancelled
                for state in processing_status[project_id].get("progress_states", []):
                    if state.get("status") == "running":
                        state["status"] = "cancelled"
                        state["completed_at"] = datetime.now().isoformat()
                
                append_log_line(project_id, "⚠️ Processing cancelled by user")
                save_projects_db()
            
            # Clean up process reference
            unregister_process(project_id)
            
            logger.info(f"Successfully cancelled processing for project {project_id}")
            return True
            
        except Exception as exc:
            logger.error(f"Failed to cancel process for {project_id}: {exc}")
            return False
