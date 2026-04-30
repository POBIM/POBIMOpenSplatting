#!/usr/bin/env python3
"""Collect lightweight metrics for the MapAnything hybrid experiment."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path


MODEL_PATTERNS = {
    "rigs": re.compile(r"Rigs:\s+(\d+)"),
    "cameras": re.compile(r"Cameras:\s+(\d+)"),
    "frames": re.compile(r"Frames:\s+(\d+)"),
    "registered_frames": re.compile(r"Registered frames:\s+(\d+)"),
    "images": re.compile(r"Images:\s+(\d+)"),
    "registered_images": re.compile(r"Registered images:\s+(\d+)"),
    "points": re.compile(r"Points:\s+(\d+)"),
    "observations": re.compile(r"Observations:\s+(\d+)"),
    "mean_track_length": re.compile(r"Mean track length:\s+([0-9.]+)"),
    "mean_observations_per_image": re.compile(r"Mean observations per image:\s+([0-9.]+)"),
    "mean_reprojection_error_px": re.compile(r"Mean reprojection error:\s+([0-9.]+)px"),
}

SPLATS_PATTERNS = (
    re.compile(r"Max splats:\s*([0-9,]+)", re.IGNORECASE),
    re.compile(r"max\s+([0-9,]+)\)", re.IGNORECASE),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--experiment-root", required=True, type=Path)
    parser.add_argument("--source-project", required=True, type=Path)
    parser.add_argument("--results-root", required=True, type=Path)
    parser.add_argument("--output-json", type=Path)
    parser.add_argument("--output-md", type=Path)
    return parser.parse_args()


def run_model_analyzer(model_path: Path) -> dict:
    if not model_path.exists():
        return {"exists": False}
    result = subprocess.run(
        ["colmap", "model_analyzer", "--path", str(model_path)],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    data: dict[str, object] = {
        "exists": True,
        "returncode": result.returncode,
        "raw": result.stdout.strip(),
    }
    for key, pattern in MODEL_PATTERNS.items():
        match = pattern.search(result.stdout)
        if not match:
            continue
        value = match.group(1)
        data[key] = float(value) if "." in value else int(value)
    return data


def count_images(project_path: Path) -> int:
    images = project_path / "images"
    if not images.exists():
        return 0
    return sum(
        1
        for item in images.iterdir()
        if item.is_file() and item.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".tif", ".tiff"}
    )


def ply_size_mb(path: Path) -> float | None:
    if not path.exists():
        return None
    return round(path.stat().st_size / (1024 * 1024), 2)


def ply_vertex_count(path: Path) -> int | None:
    if not path.exists():
        return None
    try:
        with path.open("rb") as handle:
            for raw_line in handle:
                line = raw_line.decode("ascii", errors="ignore").strip()
                if line.startswith("element vertex "):
                    return int(line.split()[-1])
                if line == "end_header":
                    return None
    except OSError:
        return None
    return None


def parse_training_log(log_path: Path) -> dict:
    if not log_path.exists():
        return {"exists": False}
    text = log_path.read_text(errors="replace")
    max_splats = None
    for pattern in SPLATS_PATTERNS:
        for match in pattern.finditer(text):
            max_splats = int(match.group(1).replace(",", ""))
    return {
        "exists": True,
        "max_splats": max_splats,
        "completed": "completed" in text.lower() or "wrote" in text.lower(),
        "tail": "\n".join(text.strip().splitlines()[-12:]),
    }


def training_metrics(results_root: Path, logs_root: Path, variant: str) -> dict:
    metrics = {}
    for iteration_dir in sorted(results_root.glob(f"{variant}_*iter")):
        iteration_key = iteration_dir.name.removeprefix(f"{variant}_")
        ply_files = sorted(iteration_dir.glob("*.ply"))
        log_path = logs_root / f"train_{variant}_{iteration_key}.log"
        metrics[iteration_key] = {
            "ply": str(ply_files[0]) if ply_files else None,
            "ply_size_mb": ply_size_mb(ply_files[0]) if ply_files else None,
            "ply_vertices": ply_vertex_count(ply_files[0]) if ply_files else None,
            "log": parse_training_log(log_path),
        }
    return metrics


def render_markdown(metrics: dict) -> str:
    lines = [
        "# MapAnything Hybrid Metrics",
        "",
        f"Experiment root: `{metrics['experiment_root']}`",
        f"Source project: `{metrics['source_project']}`",
        "",
        "## Geometry",
        "",
        "| Variant | Images | Registered | Points | Mean reproj px | Track length |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for key, label in (("a", "A baseline"), ("b", "B MapAnything-only"), ("c", "C COLMAP-guided")):
        item = metrics["variants"].get(key, {})
        model = item.get("model", {})
        lines.append(
            "| {label} | {images} | {registered} | {points} | {reproj} | {track} |".format(
                label=label,
                images=item.get("image_count", 0),
                registered=model.get("registered_images", "-"),
                points=model.get("points", "-"),
                reproj=model.get("mean_reprojection_error_px", "-"),
                track=model.get("mean_track_length", "-"),
            )
        )
    lines.extend(["", "## Training", ""])
    for key, item in metrics["variants"].items():
        if key == "a":
            continue
        lines.append(f"### {key.upper()}")
        training = item.get("training", {})
        if not training:
            lines.append("No training outputs found.")
            lines.append("")
            continue
        for iteration_key, train_data in training.items():
            log = train_data.get("log", {})
            lines.append(
                f"- `{iteration_key}`: ply={train_data.get('ply_size_mb')} MB, "
                f"vertices={train_data.get('ply_vertices')}, "
                f"max_splats={log.get('max_splats')}, completed={log.get('completed')}"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    args = parse_args()
    experiment_root = args.experiment_root.resolve()
    source_project = args.source_project.resolve()
    results_root = args.results_root.resolve()
    logs_root = experiment_root / "logs"

    variants = {
        "a": source_project,
        "b": experiment_root / "b_opensplat_project",
        "c": experiment_root / "c_opensplat_project",
    }
    metrics = {
        "experiment_root": str(experiment_root),
        "source_project": str(source_project),
        "variants": {},
    }
    for key, project in variants.items():
        model_path = project / "sparse" / "0"
        metrics["variants"][key] = {
            "project": str(project),
            "image_count": count_images(project),
            "model": run_model_analyzer(model_path),
        }
        if key in {"b", "c"}:
            metrics["variants"][key]["training"] = training_metrics(results_root, logs_root, key)

    output_json = args.output_json or experiment_root / "metrics.json"
    output_md = args.output_md or experiment_root / "metrics.md"
    output_json.parent.mkdir(parents=True, exist_ok=True)
    output_json.write_text(json.dumps(metrics, indent=2), encoding="utf-8")
    output_md.write_text(render_markdown(metrics), encoding="utf-8")
    print(f"Wrote {output_json}")
    print(f"Wrote {output_md}")


if __name__ == "__main__":
    main()
