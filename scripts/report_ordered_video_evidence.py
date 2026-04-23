#!/usr/bin/env python3
"""Summarize ordered-video runtime evidence for operators."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from PobimSplatting.Backend.pipeline.resource_contract import (  # noqa: E402
    RESOURCE_AWARE_SCHEMA_VERSION,
    build_resource_aware_contract,
)

DEFAULT_PROJECTS_DB = REPO_ROOT / "PobimSplatting" / "Backend" / "projects_db.json"
DEFAULT_EVIDENCE_FILE = (
    REPO_ROOT / "PobimSplatting" / "runtime" / "auto_tuning" / "ordered_video_evidence.json"
)
DEFAULT_TUNED_SNAPSHOT = (
    REPO_ROOT
    / "PobimSplatting"
    / "runtime"
    / "auto_tuning"
    / "ordered_video_tuned_snapshot.json"
)
DEFAULT_STABLE_SNAPSHOT = (
    REPO_ROOT
    / "PobimSplatting"
    / "runtime"
    / "auto_tuning"
    / "ordered_video_stable_snapshot.json"
)


def _load_json(path: Path) -> Any:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    rows: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            rows.append(payload)
    return rows


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    candidate = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(candidate)
    except ValueError:
        return None


def _safe_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _safe_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _project_items(payload: Any) -> Iterable[tuple[str, Dict[str, Any]]]:
    if not isinstance(payload, dict):
        return []
    return [(str(key), value) for key, value in payload.items() if isinstance(value, dict)]


def _is_ordered_video_project(project: Dict[str, Any]) -> bool:
    framework = project.get("reconstruction_framework") or {}
    capture_pattern = framework.get("capture_pattern") or {}
    if str(project.get("input_type") or "").lower() == "video":
        return True
    if bool(capture_pattern.get("looks_like_video_orbit")):
        return True
    if project.get("video_extraction_diagnostics"):
        return True
    if framework.get("progressive_matching_plan"):
        return True
    if framework.get("recovery_history"):
        return True
    if framework.get("resource_lane"):
        return True
    return False


def _extract_stage_runtime_seconds(project: Dict[str, Any]) -> Dict[str, float]:
    stage_details = project.get("stage_details") or {}
    durations: Dict[str, float] = {}
    if not isinstance(stage_details, dict):
        return durations
    for stage, detail in stage_details.items():
        if not isinstance(detail, dict):
            continue
        for key in ("duration_seconds", "elapsed_seconds", "runtime_seconds", "seconds"):
            value = _safe_float(detail.get(key))
            if value is not None:
                durations[str(stage)] = value
                break
    return durations


def _extract_total_runtime_seconds(project: Dict[str, Any]) -> Optional[float]:
    start = _parse_iso(project.get("start_time"))
    end = _parse_iso(project.get("end_time"))
    if start and end:
        return round(max(0.0, (end - start).total_seconds()), 3)
    return None


def _extract_extracted_image_count(video_diag: Dict[str, Any]) -> Optional[int]:
    if not isinstance(video_diag, dict):
        return None
    for key in ("saved_frames", "extracted_image_count"):
        value = _safe_int(video_diag.get(key))
        if value is not None:
            return value
    videos = video_diag.get("videos") or []
    total = 0
    seen = False
    for item in videos:
        if not isinstance(item, dict):
            continue
        value = _safe_int(item.get("saved_frames"))
        if value is not None:
            total += value
            seen = True
    return total if seen else None


def _snapshot_summary(payload: Any, *, source_path: Path) -> Dict[str, Any]:
    if payload is None:
        return {
            "found": False,
            "path": str(source_path),
            "value_count": 0,
            "updated_at": None,
            "confidence": None,
            "derived_from_runs": None,
        }
    values = None
    if isinstance(payload, dict):
        for key in ("values", "thresholds", "tuned_values", "snapshot"):
            candidate = payload.get(key)
            if isinstance(candidate, dict):
                values = candidate
                break
        if values is None:
            values = {k: v for k, v in payload.items() if not isinstance(v, (dict, list))}
    else:
        values = {}
    return {
        "found": True,
        "path": str(source_path),
        "value_count": len(values),
        "updated_at": (
            payload.get("last_updated_at")
            or payload.get("updated_at")
            or payload.get("generated_at")
            if isinstance(payload, dict)
            else None
        ),
        "confidence": payload.get("confidence") if isinstance(payload, dict) else None,
        "derived_from_runs": payload.get("derived_from_runs") if isinstance(payload, dict) else None,
        "keys_preview": sorted(list(values.keys()))[:10],
    }


def _evidence_summary(payload: Any, *, source_path: Path) -> Dict[str, Any]:
    if payload is None:
        return {"found": False, "path": str(source_path), "entry_count": 0, "top_level_keys": []}
    entries: List[Any]
    top_level_keys: List[str]
    if isinstance(payload, list):
        entries = payload
        top_level_keys = []
    elif isinstance(payload, dict):
        top_level_keys = sorted(payload.keys())
        for key in ("entries", "evidence", "runs", "projects"):
            candidate = payload.get(key)
            if isinstance(candidate, list):
                entries = candidate
                break
        else:
            entries = [payload]
    else:
        entries = [payload]
        top_level_keys = []
    return {
        "found": True,
        "path": str(source_path),
        "entry_count": len(entries),
        "top_level_keys": top_level_keys[:12],
    }


def _build_project_record(project_id: str, project: Dict[str, Any]) -> Dict[str, Any]:
    framework = project.get("reconstruction_framework") or {}
    video_diag = project.get("video_extraction_diagnostics") or {}
    pair_stats = framework.get("pair_geometry_stats") or {}
    recovery_history = list(framework.get("recovery_history") or [])
    recovery_summary = framework.get("recovery_loop_summary") or {}
    resource_profile = framework.get("resource_profile") or {}
    training_summary = framework.get("training_budget_summary") or {}
    runtimes = _extract_stage_runtime_seconds(project)
    pair_budget_capped = any(
        bool(step.get("pair_budget_capped"))
        or any(bool(boundary.get("pair_budget_capped")) for boundary in (step.get("targeted_boundaries") or []))
        for step in recovery_history
        if isinstance(step, dict)
    )
    return {
        "project_id": project_id,
        "status": project.get("status") or "unknown",
        "input_type": project.get("input_type") or "unknown",
        "resource_profile_class": resource_profile.get("profile_class") or "unknown",
        "resource_lane": framework.get("resource_lane") or "unknown",
        "admission_reason": framework.get("admission_reason"),
        "downgrade_reason": framework.get("downgrade_reason"),
        "estimated_start_delay": framework.get("estimated_start_delay"),
        "final_path": recovery_summary.get("final_path") or "unknown",
        "recovery_state": recovery_summary.get("state") or "unknown",
        "final_reason_code": recovery_summary.get("final_reason_code"),
        "local_repair_count": _safe_int(recovery_summary.get("local_repair_count")) or len(recovery_history),
        "broad_fallback_used": bool(recovery_summary.get("broad_fallback_used")),
        "pair_budget_capped": pair_budget_capped,
        "failed_recovery_steps": sum(
            1 for step in recovery_history if isinstance(step, dict) and step.get("status") == "failed"
        ),
        "extracted_image_count": _extract_extracted_image_count(video_diag),
        "candidate_count": _safe_int(video_diag.get("candidate_count")),
        "requested_targets": _safe_int(video_diag.get("requested_targets")),
        "bridge_p10": _safe_float(pair_stats.get("bridge_p10")),
        "bridge_min": _safe_float(pair_stats.get("bridge_min")),
        "weak_boundary_ratio": _safe_float(pair_stats.get("weak_boundary_ratio")),
        "zero_boundary_ratio": _safe_float(pair_stats.get("zero_boundary_ratio")),
        "weak_boundary_count": _safe_int(pair_stats.get("weak_boundary_count")),
        "zero_boundary_count": _safe_int(pair_stats.get("zero_boundary_count")),
        "matching_runtime_seconds": runtimes.get("feature_matching"),
        "sparse_runtime_seconds": runtimes.get("sparse_reconstruction"),
        "training_runtime_seconds": runtimes.get("gaussian_splatting"),
        "total_runtime_seconds": _extract_total_runtime_seconds(project),
        "uses_repaired_capture": bool(training_summary.get("uses_repaired_capture")),
        "repair_step_count": _safe_int(training_summary.get("repair_step_count")),
        "updated_at": (
            (project.get("metadata") or {}).get("updated_at")
            or project.get("end_time")
            or project.get("start_time")
        ),
    }


def _mean(records: List[Dict[str, Any]], key: str) -> Optional[float]:
    values = [_safe_float(item.get(key)) for item in records]
    clean = [value for value in values if value is not None]
    if not clean:
        return None
    return round(sum(clean) / len(clean), 4)


def _format_metric(value: Optional[float]) -> str:
    if value is None:
        return "--"
    if abs(value) >= 100:
        return f"{value:.1f}"
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _build_report(
    *,
    projects_db_path: Path,
    evidence_path: Path,
    tuned_snapshot_path: Path,
    stable_snapshot_path: Path,
    benchmark_jsonl_path: Optional[Path],
    limit: int,
) -> Dict[str, Any]:
    projects_payload = _load_json(projects_db_path)
    evidence_payload = _load_json(evidence_path)
    tuned_payload = _load_json(tuned_snapshot_path)
    stable_payload = _load_json(stable_snapshot_path)
    benchmark_rows = _load_jsonl(benchmark_jsonl_path) if benchmark_jsonl_path else []

    project_records = [
        _build_project_record(project_id, project)
        for project_id, project in _project_items(projects_payload)
        if _is_ordered_video_project(project)
    ]
    project_records.sort(
        key=lambda item: _parse_iso(item.get("updated_at")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    status_counts = Counter(item["status"] for item in project_records)
    lane_counts = Counter(item["resource_lane"] for item in project_records)
    final_path_counts = Counter(item["final_path"] for item in project_records)
    recovery_state_counts = Counter(item["recovery_state"] for item in project_records)
    profile_counts = Counter(item["resource_profile_class"] for item in project_records)

    warnings: List[str] = []
    if not evidence_payload:
        warnings.append("No persisted ordered-video evidence file found yet.")
    if not tuned_payload:
        warnings.append("No tuned snapshot found yet.")
    if not stable_payload:
        warnings.append("No stable snapshot found yet.")
    unresolved_count = recovery_state_counts.get("unresolved", 0)
    if unresolved_count:
        warnings.append(f"{unresolved_count} ordered-video project(s) still report unresolved recovery state.")
    broad_fallback_count = sum(1 for item in project_records if item["broad_fallback_used"])
    if broad_fallback_count:
        warnings.append(f"{broad_fallback_count} project(s) used broad fallback recovery.")

    contract = build_resource_aware_contract()
    return {
        "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "contract": contract,
        "sources": {
            "projects_db": {
                "path": str(projects_db_path),
                "found": projects_db_path.exists(),
                "project_count": len(list(_project_items(projects_payload))),
                "ordered_video_project_count": len(project_records),
            },
            "ordered_video_evidence": _evidence_summary(evidence_payload, source_path=evidence_path),
            "tuned_snapshot": _snapshot_summary(tuned_payload, source_path=tuned_snapshot_path),
            "stable_snapshot": _snapshot_summary(stable_payload, source_path=stable_snapshot_path),
            "benchmark_jsonl": {
                "path": str(benchmark_jsonl_path) if benchmark_jsonl_path else None,
                "found": bool(benchmark_jsonl_path and benchmark_jsonl_path.exists()),
                "report_count": len(benchmark_rows),
                "labels": [row.get("label") for row in benchmark_rows if isinstance(row, dict) and row.get("label")][:5],
            },
        },
        "summary": {
            "ordered_video_project_count": len(project_records),
            "status_counts": dict(status_counts),
            "resource_lane_counts": dict(lane_counts),
            "resource_profile_counts": dict(profile_counts),
            "final_path_counts": dict(final_path_counts),
            "recovery_state_counts": dict(recovery_state_counts),
            "pair_budget_capped_project_count": sum(1 for item in project_records if item["pair_budget_capped"]),
            "uses_repaired_capture_count": sum(1 for item in project_records if item["uses_repaired_capture"]),
            "avg_bridge_p10": _mean(project_records, "bridge_p10"),
            "avg_bridge_min": _mean(project_records, "bridge_min"),
            "avg_weak_boundary_ratio": _mean(project_records, "weak_boundary_ratio"),
            "avg_zero_boundary_ratio": _mean(project_records, "zero_boundary_ratio"),
            "avg_total_runtime_seconds": _mean(project_records, "total_runtime_seconds"),
        },
        "recent_projects": project_records[: max(1, limit)],
        "warnings": warnings,
    }


def _render_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# Ordered Video Evidence Report",
        "",
        f"- Schema: {report.get('schema_version', '--')}",
        f"- Generated: {report.get('generated_at', '--')}",
    ]
    sources = report.get("sources") or {}
    lines.extend(
        [
            "",
            "## Source Status",
            "",
            "| Source | Found | Notes |",
            "|------|------|------|",
            "| Projects DB | {found} | {count} total project(s), {ordered} ordered-video candidate(s) |".format(
                found="yes" if (sources.get("projects_db") or {}).get("found") else "no",
                count=(sources.get("projects_db") or {}).get("project_count", 0),
                ordered=(sources.get("projects_db") or {}).get("ordered_video_project_count", 0),
            ),
            "| Ordered-video evidence | {found} | {count} entries |".format(
                found="yes" if (sources.get("ordered_video_evidence") or {}).get("found") else "no",
                count=(sources.get("ordered_video_evidence") or {}).get("entry_count", 0),
            ),
            "| Tuned snapshot | {found} | values={count}, confidence={confidence} |".format(
                found="yes" if (sources.get("tuned_snapshot") or {}).get("found") else "no",
                count=(sources.get("tuned_snapshot") or {}).get("value_count", 0),
                confidence=(sources.get("tuned_snapshot") or {}).get("confidence") or "--",
            ),
            "| Stable snapshot | {found} | values={count} |".format(
                found="yes" if (sources.get("stable_snapshot") or {}).get("found") else "no",
                count=(sources.get("stable_snapshot") or {}).get("value_count", 0),
            ),
            "| Benchmark JSONL | {found} | {count} report(s) |".format(
                found="yes" if (sources.get("benchmark_jsonl") or {}).get("found") else "no",
                count=(sources.get("benchmark_jsonl") or {}).get("report_count", 0),
            ),
        ]
    )

    summary = report.get("summary") or {}
    lines.extend(
        [
            "",
            "## Ordered-Video Summary",
            "",
            f"- Ordered-video projects: {summary.get('ordered_video_project_count', 0)}",
            f"- Status counts: {summary.get('status_counts') or {}}",
            f"- Resource lanes: {summary.get('resource_lane_counts') or {}}",
            f"- Resource profiles: {summary.get('resource_profile_counts') or {}}",
            f"- Final paths: {summary.get('final_path_counts') or {}}",
            f"- Recovery states: {summary.get('recovery_state_counts') or {}}",
            f"- Pair-budget capped projects: {summary.get('pair_budget_capped_project_count', 0)}",
            f"- Repaired-capture projects: {summary.get('uses_repaired_capture_count', 0)}",
            f"- Avg bridge_p10: {_format_metric(summary.get('avg_bridge_p10'))}",
            f"- Avg bridge_min: {_format_metric(summary.get('avg_bridge_min'))}",
            f"- Avg weak_boundary_ratio: {_format_metric(summary.get('avg_weak_boundary_ratio'))}",
            f"- Avg zero_boundary_ratio: {_format_metric(summary.get('avg_zero_boundary_ratio'))}",
            f"- Avg total_runtime_seconds: {_format_metric(summary.get('avg_total_runtime_seconds'))}",
            "",
            "## Recent Ordered-Video Projects",
            "",
            "| Project | Status | Lane | Final path | State | Weak ratio | Bridge p10 | Pair cap |",
            "|------|------|------|------|------|------:|------:|------|",
        ]
    )
    for item in report.get("recent_projects") or []:
        lines.append(
            "| {project_id} | {status} | {lane} | {final_path} | {state} | {weak_ratio} | {bridge_p10} | {pair_cap} |".format(
                project_id=item.get("project_id", "--"),
                status=item.get("status", "--"),
                lane=item.get("resource_lane", "--"),
                final_path=item.get("final_path", "--"),
                state=item.get("recovery_state", "--"),
                weak_ratio=_format_metric(item.get("weak_boundary_ratio")),
                bridge_p10=_format_metric(item.get("bridge_p10")),
                pair_cap="yes" if item.get("pair_budget_capped") else "no",
            )
        )

    lines.extend(["", "## Warnings", ""])
    warnings = report.get("warnings") or []
    if warnings:
        for warning in warnings:
            lines.append(f"- {warning}")
    else:
        lines.append("- none")

    contract = report.get("contract") or {}
    lines.extend(
        [
            "",
            "## Contract Preview",
            "",
            f"- Recovery precedence: {contract.get('recovery_precedence') or []}",
            f"- Final recovery paths: {contract.get('recovery_final_paths') or []}",
            f"- Resource lanes: {contract.get('resource_lanes') or []}",
        ]
    )
    return "\n".join(lines)


def _write_output(path: Optional[str], content: str) -> None:
    if not path:
        return
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect ordered-video runtime evidence and render an operator summary."
    )
    parser.add_argument("--projects-db", default=str(DEFAULT_PROJECTS_DB))
    parser.add_argument("--evidence-file", default=str(DEFAULT_EVIDENCE_FILE))
    parser.add_argument("--tuned-snapshot", default=str(DEFAULT_TUNED_SNAPSHOT))
    parser.add_argument("--stable-snapshot", default=str(DEFAULT_STABLE_SNAPSHOT))
    parser.add_argument("--benchmark-jsonl", help="Optional JSONL file from benchmark_ordered_video_policy.py")
    parser.add_argument("--project-limit", type=int, default=10)
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    parser.add_argument("--output", help="Optional output path for the rendered report.")
    args = parser.parse_args()

    report = _build_report(
        projects_db_path=Path(args.projects_db),
        evidence_path=Path(args.evidence_file),
        tuned_snapshot_path=Path(args.tuned_snapshot),
        stable_snapshot_path=Path(args.stable_snapshot),
        benchmark_jsonl_path=Path(args.benchmark_jsonl) if args.benchmark_jsonl else None,
        limit=max(1, args.project_limit),
    )

    if args.format == "json":
        rendered = json.dumps(report, indent=2, ensure_ascii=False)
    else:
        rendered = _render_markdown(report)

    print(rendered)
    _write_output(args.output, rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
