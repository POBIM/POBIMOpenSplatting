"""
Utility helpers for launching subprocesses with streaming logs.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Callable, Iterable, Optional

from .projects import append_log_line, register_process, unregister_process


def run_command_with_logs(
    project_id: str,
    cmd: Iterable[str],
    *,
    cwd: Optional[Path] = None,
    line_handler: Optional[Callable[[str], None]] = None,
) -> None:
    """Execute a shell command while streaming logs into the project log."""
    pretty_cmd = " ".join(str(part) for part in cmd)
    if cwd:
        append_log_line(project_id, f"$ (cd {cwd}) {pretty_cmd}")
    else:
        append_log_line(project_id, f"$ {pretty_cmd}")

    env = os.environ.copy()
    libtorch_path = Path(__file__).parent.parent / "libtorch" / "lib"
    if "LD_LIBRARY_PATH" in env:
        env["LD_LIBRARY_PATH"] = f"{libtorch_path}:{env['LD_LIBRARY_PATH']}"
    else:
        env["LD_LIBRARY_PATH"] = str(libtorch_path)

    env["QT_QPA_PLATFORM"] = "offscreen"
    env["DISPLAY"] = ""
    env["LIBGL_ALWAYS_SOFTWARE"] = "1"
    env["MESA_GL_VERSION_OVERRIDE"] = "3.3"

    process = subprocess.Popen(
        list(cmd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        cwd=str(cwd) if cwd else None,
        env=env,
    )

    # Register the process for potential cancellation
    register_process(project_id, process)

    assert process.stdout is not None

    try:
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")

            if line_handler:
                try:
                    line_handler(line)
                except Exception as handler_error:  # pragma: no cover - defensive log only
                    append_log_line(project_id, f"[line_handler error] {handler_error}")

            append_log_line(project_id, line.rstrip())

        returncode = process.wait()
        if returncode != 0:
            raise subprocess.CalledProcessError(returncode, list(cmd))
    finally:
        # Always unregister the process when done
        unregister_process(project_id)

