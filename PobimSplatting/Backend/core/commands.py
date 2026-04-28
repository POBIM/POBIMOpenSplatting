"""
Utility helpers for launching subprocesses with streaming logs.
"""

from __future__ import annotations

import os
import subprocess
import threading
from pathlib import Path
from typing import Callable, Iterable, Optional

from .projects import append_log_line, register_process, unregister_process


def _prepend_env_paths(env: dict[str, str], key: str, paths: Iterable[Path]) -> None:
    existing = [part for part in env.get(key, "").split(":") if part]
    prefix: list[str] = []
    managed: set[str] = set()

    for path in paths:
        try:
            if not path.exists():
                continue
            resolved = str(path.resolve())
        except OSError:
            continue
        if resolved not in managed:
            prefix.append(resolved)
            managed.add(resolved)

    # Normalize repo-managed runtime paths even when the parent shell already
    # provided them. A stale LibTorch earlier in LD_LIBRARY_PATH can override
    # the binary's RUNPATH and fail at symbol lookup time.
    existing = [
        part
        for part in existing
        if str(Path(part).resolve()) not in managed
    ]

    if prefix or existing:
        env[key] = ":".join(prefix + existing)


def build_native_runtime_env(base_env: Optional[dict[str, str]] = None) -> dict[str, str]:
    """Return an environment that can launch repo-native CUDA binaries."""
    env = dict(base_env or os.environ)
    repo_root = Path(__file__).resolve().parents[3]

    _prepend_env_paths(
        env,
        "LD_LIBRARY_PATH",
        (
            repo_root / "libtorch-cuda130" / "lib",
            Path("/usr/local/cuda-13.0/lib64"),
            Path("/usr/local/cuda-13.0/targets/x86_64-linux/lib"),
            repo_root / "libtorch-cuda126" / "lib",
            Path("/usr/local/cuda-12.6/lib64"),
            Path("/usr/local/cuda-12.6/targets/x86_64-linux/lib"),
            repo_root / "libtorch-cuda121" / "lib",
            repo_root / "libtorch-cuda118" / "lib",
            repo_root / "libtorch-cpu" / "lib",
            Path(__file__).parent.parent / "libtorch" / "lib",
        ),
    )
    _prepend_env_paths(
        env,
        "PATH",
        (
            Path("/usr/local/cuda-13.0/bin"),
            Path("/usr/local/cuda-12.6/bin"),
        ),
    )

    if "CUDA_HOME" not in env and Path("/usr/local/cuda-13.0/bin/nvcc").exists():
        env["CUDA_HOME"] = "/usr/local/cuda-13.0"

    env["QT_QPA_PLATFORM"] = "offscreen"
    env["DISPLAY"] = ""
    env["LIBGL_ALWAYS_SOFTWARE"] = "1"
    env["MESA_GL_VERSION_OVERRIDE"] = "3.3"
    return env


def run_command_with_logs(
    project_id: str,
    cmd: Iterable[str],
    *,
    cwd: Optional[Path] = None,
    line_handler: Optional[Callable[[str], None]] = None,
    raw_line_filter: Optional[Callable[[str], bool | str | None]] = None,
    progress_monitor: Optional[Callable[[], None]] = None,
    progress_interval: float = 15.0,
) -> None:
    """Execute a shell command while streaming logs into the project log."""
    pretty_cmd = " ".join(str(part) for part in cmd)
    if cwd:
        append_log_line(project_id, f"$ (cd {cwd}) {pretty_cmd}")
    else:
        append_log_line(project_id, f"$ {pretty_cmd}")

    env = build_native_runtime_env()

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
    monitor_stop = threading.Event()
    monitor_thread = None

    if progress_monitor is not None:
        def _monitor_loop():
            while not monitor_stop.wait(progress_interval):
                if process.poll() is not None:
                    return
                try:
                    progress_monitor()
                except Exception as monitor_error:  # pragma: no cover - defensive log only
                    append_log_line(project_id, f"[progress_monitor error] {monitor_error}")

        monitor_thread = threading.Thread(target=_monitor_loop, daemon=True)
        monitor_thread.start()

    assert process.stdout is not None

    try:
        for raw_line in process.stdout:
            line = raw_line.rstrip("\n")

            if line_handler:
                try:
                    line_handler(line)
                except Exception as handler_error:  # pragma: no cover - defensive log only
                    append_log_line(project_id, f"[line_handler error] {handler_error}")

            if raw_line_filter is None:
                append_log_line(project_id, line.rstrip())
                continue

            filtered = raw_line_filter(line)
            if isinstance(filtered, str):
                append_log_line(project_id, filtered.rstrip())
            elif filtered:
                append_log_line(project_id, line.rstrip())

        returncode = process.wait()
        if returncode != 0:
            raise subprocess.CalledProcessError(returncode, list(cmd))
    finally:
        monitor_stop.set()
        if monitor_thread is not None:
            monitor_thread.join(timeout=1.0)
        # Always unregister the process when done
        unregister_process(project_id)
