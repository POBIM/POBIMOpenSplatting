"""Self-calibrating ordered-video policy helpers."""

from __future__ import annotations

import json
import statistics
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..core import config as app_config
from .resource_contract import RESOURCE_AWARE_SCHEMA_VERSION

MAX_EVIDENCE_RECORDS = 200
MIN_RUNS_FOR_TUNING = 3
RECENT_TUNED_HEALTH_WINDOW = 3


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_json(path: Path, default: Dict[str, Any]) -> Dict[str, Any]:
    if not path.exists():
        return deepcopy(default)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(default)


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _median(values: List[float], default: float) -> float:
    cleaned = [float(value) for value in values if value is not None]
    if not cleaned:
        return float(default)
    return float(statistics.median(cleaned))


def _p75(values: List[float], default: float) -> float:
    cleaned = sorted(float(value) for value in values if value is not None)
    if not cleaned:
        return float(default)
    index = int(round((len(cleaned) - 1) * 0.75))
    return float(cleaned[index])


def build_stable_ordered_video_snapshot() -> Dict[str, Any]:
    return {
        "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
        "snapshot_kind": "stable",
        "updated_at": _utc_now(),
        "derived_from_runs": 0,
        "confidence": "stable-default",
        "guardrails_applied": True,
        "frame_budget": {
            "scale": 1.0,
        },
        "progressive_matching": {
            "strong_bridge_p10": 28.0,
            "strong_weak_boundary_ratio": 0.015,
            "stable_bridge_p10": 22.0,
            "stable_weak_boundary_ratio": 0.035,
            "loop_bridge_p10": 20.0,
            "loop_bridge_min": 12.0,
            "loop_weak_boundary_ratio": 0.03,
            "light_pair_coverage_scale": 1.0,
        },
        "recovery": {
            "weak_boundary_stop_ratio": 0.02,
            "weak_boundary_trigger_ratio": 0.08,
            "weak_boundary_quadratic_ratio": 0.03,
            "pair_budget_scale": 1.0,
            "final_loop_trigger_ratio": 0.05,
            "final_loop_registered_ratio": 0.95,
        },
        "orchestration": {
            "wait_delay_scale": 1.0,
            "gpu_constrained_score_threshold": 4,
            "heavy_score_threshold": 5,
        },
    }


def ensure_auto_tuning_files() -> None:
    app_config.AUTO_TUNING_DIR.mkdir(parents=True, exist_ok=True)
    if not app_config.ORDERED_VIDEO_STABLE_SNAPSHOT_FILE.exists():
        _write_json(
            app_config.ORDERED_VIDEO_STABLE_SNAPSHOT_FILE,
            build_stable_ordered_video_snapshot(),
        )
    if not app_config.ORDERED_VIDEO_TUNED_SNAPSHOT_FILE.exists():
        _write_json(
            app_config.ORDERED_VIDEO_TUNED_SNAPSHOT_FILE,
            {
                "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
                "snapshot_kind": "tuned",
                "updated_at": _utc_now(),
                "derived_from_runs": 0,
                "confidence": "insufficient-data",
                "guardrails_applied": True,
                "frame_budget": {"scale": 1.0},
                "progressive_matching": {},
                "recovery": {"pair_budget_scale": 1.0},
                "orchestration": {"wait_delay_scale": 1.0},
            },
        )
    if not app_config.ORDERED_VIDEO_EVIDENCE_FILE.exists():
        _write_json(
            app_config.ORDERED_VIDEO_EVIDENCE_FILE,
            {
                "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
                "updated_at": _utc_now(),
                "records": [],
            },
        )


def load_stable_snapshot() -> Dict[str, Any]:
    ensure_auto_tuning_files()
    return _read_json(
        app_config.ORDERED_VIDEO_STABLE_SNAPSHOT_FILE,
        build_stable_ordered_video_snapshot(),
    )


def load_tuned_snapshot() -> Dict[str, Any]:
    ensure_auto_tuning_files()
    return _read_json(
        app_config.ORDERED_VIDEO_TUNED_SNAPSHOT_FILE,
        {
            "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
            "snapshot_kind": "tuned",
            "updated_at": _utc_now(),
            "derived_from_runs": 0,
            "confidence": "insufficient-data",
            "guardrails_applied": True,
        },
    )


def load_evidence_store() -> Dict[str, Any]:
    ensure_auto_tuning_files()
    return _read_json(
        app_config.ORDERED_VIDEO_EVIDENCE_FILE,
        {
            "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
            "updated_at": _utc_now(),
            "records": [],
        },
    )


def _is_ordered_video_project(project_entry: Dict[str, Any]) -> bool:
    input_type = str(project_entry.get("input_type") or "").lower()
    if input_type in {"video", "mixed"}:
        return True
    framework = project_entry.get("reconstruction_framework") or {}
    capture_pattern = framework.get("capture_pattern") or {}
    return bool(capture_pattern.get("looks_like_video_orbit"))


def _make_project_evidence(project_id: str, project_entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not _is_ordered_video_project(project_entry):
        return None

    framework = project_entry.get("reconstruction_framework") or {}
    video_diagnostics = project_entry.get("video_extraction_diagnostics") or {}
    recovery_summary = framework.get("recovery_loop_summary") or {}
    pair_geometry = framework.get("pair_geometry_stats") or {}
    sparse_summary = framework.get("sparse_model_summary") or {}
    resource_coordination = project_entry.get("resource_coordination") or {}
    auto_tuning_summary = framework.get("auto_tuning_summary") or {}
    adaptive_budget = video_diagnostics.get("adaptive_frame_budget") or {}
    progressive_plan = framework.get("progressive_matching_plan") or {}
    progressive_checkpoints = framework.get("progressive_matching_checkpoints") or []
    training_budget_summary = framework.get("training_budget_summary") or {}
    stage_details = project_entry.get("stage_details") or {}

    def _runtime_for(stage_key: str) -> Optional[float]:
        state = next(
            (item for item in (project_entry.get("progress_states") or []) if item.get("key") == stage_key),
            None,
        )
        if not state or not state.get("started_at") or not state.get("completed_at"):
            return None
        try:
            start = datetime.fromisoformat(state["started_at"])
            end = datetime.fromisoformat(state["completed_at"])
            return max(0.0, (end - start).total_seconds())
        except Exception:
            return None

    return {
        "project_id": project_id,
        "captured_at": _utc_now(),
        "status": project_entry.get("status"),
        "input_type": project_entry.get("input_type"),
        "quality_mode": (project_entry.get("config") or {}).get("quality_mode"),
        "resource_lane": framework.get("resource_lane") or resource_coordination.get("resource_lane"),
        "resource_profile_class": (
            (framework.get("resource_profile") or {}).get("profile_class")
            or resource_coordination.get("profile_class")
        ),
        "auto_tuning_mode": auto_tuning_summary.get("active_mode", "stable"),
        "auto_tuning_confidence": auto_tuning_summary.get("confidence"),
        "effective_frame_budget_scale": adaptive_budget.get("density_scale"),
        "effective_oversample_factor": adaptive_budget.get("effective_oversample_factor"),
        "requested_oversample_factor": adaptive_budget.get("requested_oversample_factor"),
        "progressive_final_overlap": progressive_plan.get("final_overlap"),
        "progressive_checkpoint_count": len(progressive_checkpoints),
        "pair_budget_capped": any(
            bool(step.get("pair_budget_capped"))
            for step in (framework.get("recovery_history") or [])
        ),
        "pair_budget_cap": max(
            [int(step.get("pair_budget_cap") or 0) for step in (framework.get("recovery_history") or [])] or [0]
        ),
        "bridge_p10": pair_geometry.get("bridge_p10"),
        "bridge_min": pair_geometry.get("bridge_min"),
        "weak_boundary_ratio": pair_geometry.get("weak_boundary_ratio"),
        "zero_boundary_ratio": pair_geometry.get("zero_boundary_ratio"),
        "registered_image_ratio": sparse_summary.get("registered_ratio"),
        "recovery_state": recovery_summary.get("state"),
        "recovery_final_path": recovery_summary.get("final_path"),
        "recovery_reason_code": recovery_summary.get("final_reason_code"),
        "training_uses_repaired_capture": training_budget_summary.get("uses_repaired_capture"),
        "stage_runtimes": {
            "video_extraction": _runtime_for("video_extraction"),
            "feature_matching": _runtime_for("feature_matching"),
            "sparse_reconstruction": _runtime_for("sparse_reconstruction"),
            "gaussian_splatting": _runtime_for("gaussian_splatting"),
        },
        "total_runtime_seconds": _runtime_for("ingest") or (
            (
                sum(
                    value for value in [
                        _runtime_for("video_extraction"),
                        _runtime_for("feature_matching"),
                        _runtime_for("sparse_reconstruction"),
                        _runtime_for("gaussian_splatting"),
                    ]
                    if value is not None
                )
            )
            or None
        ),
        "summary_hint": resource_coordination.get("summary") or stage_details.get("gaussian_splatting", {}).get("text"),
    }


def _derive_tuned_snapshot(records: List[Dict[str, Any]], stable_snapshot: Dict[str, Any]) -> Dict[str, Any]:
    successful = [
        item for item in records
        if item.get("status") == "completed"
        and item.get("registered_image_ratio") is not None
    ]
    recent = records[-8:]
    fallback_rate = (
        sum(1 for item in recent if item.get("recovery_final_path") == "broad_fallback")
        / max(len(recent), 1)
    )
    unresolved_rate = (
        sum(1 for item in recent if item.get("recovery_state") == "unresolved")
        / max(len(recent), 1)
    )
    pair_cap_rate = (
        sum(1 for item in recent if item.get("pair_budget_capped"))
        / max(len(recent), 1)
    )
    registered_ratio_median = _median(
        [item.get("registered_image_ratio") for item in successful],
        stable_snapshot["recovery"]["final_loop_registered_ratio"],
    )
    frame_scale_median = _median(
        [item.get("effective_frame_budget_scale") for item in successful],
        1.0,
    )
    matching_runtime_p75 = _p75(
        [((item.get("stage_runtimes") or {}).get("feature_matching")) for item in recent],
        60.0,
    )

    tuned = deepcopy(stable_snapshot)
    tuned["snapshot_kind"] = "tuned"
    tuned["updated_at"] = _utc_now()
    tuned["derived_from_runs"] = len(successful)
    tuned["guardrails_applied"] = True

    if len(successful) < MIN_RUNS_FOR_TUNING:
        tuned["confidence"] = "insufficient-data"
        return tuned

    if fallback_rate >= 0.3 or unresolved_rate >= 0.2 or registered_ratio_median < 0.6:
        geometry_bias = "protect-quality"
    elif matching_runtime_p75 >= 180 and registered_ratio_median >= 0.75:
        geometry_bias = "save-runtime"
    else:
        geometry_bias = "balanced"

    tuned["confidence"] = "medium" if len(successful) < 6 else "high"
    tuned["source_summary"] = {
        "recent_fallback_rate": round(float(fallback_rate), 4),
        "recent_unresolved_rate": round(float(unresolved_rate), 4),
        "recent_pair_cap_rate": round(float(pair_cap_rate), 4),
        "registered_ratio_median": round(float(registered_ratio_median), 4),
        "matching_runtime_p75": round(float(matching_runtime_p75), 4),
        "geometry_bias": geometry_bias,
    }

    frame_scale = _clamp(frame_scale_median, 0.9, 1.1)
    if geometry_bias == "protect-quality":
        frame_scale = _clamp(frame_scale * 1.03, 0.9, 1.1)
    elif geometry_bias == "save-runtime":
        frame_scale = _clamp(frame_scale * 0.97, 0.9, 1.1)
    tuned["frame_budget"]["scale"] = round(float(frame_scale), 4)

    strong_bridge = stable_snapshot["progressive_matching"]["strong_bridge_p10"]
    stable_bridge = stable_snapshot["progressive_matching"]["stable_bridge_p10"]
    strong_ratio = stable_snapshot["progressive_matching"]["strong_weak_boundary_ratio"]
    stable_ratio = stable_snapshot["progressive_matching"]["stable_weak_boundary_ratio"]
    light_scale = stable_snapshot["progressive_matching"]["light_pair_coverage_scale"]

    if geometry_bias == "protect-quality":
        strong_bridge += 2.0
        stable_bridge += 1.0
        strong_ratio *= 0.9
        stable_ratio *= 0.9
        light_scale *= 1.05
    elif geometry_bias == "save-runtime":
        strong_bridge -= 2.0
        stable_bridge -= 1.0
        strong_ratio *= 1.1
        stable_ratio *= 1.1
        light_scale *= 0.95

    tuned["progressive_matching"].update(
        {
            "strong_bridge_p10": round(_clamp(strong_bridge, 22.0, 34.0), 4),
            "strong_weak_boundary_ratio": round(_clamp(strong_ratio, 0.01, 0.03), 4),
            "stable_bridge_p10": round(_clamp(stable_bridge, 18.0, 28.0), 4),
            "stable_weak_boundary_ratio": round(_clamp(stable_ratio, 0.02, 0.05), 4),
            "light_pair_coverage_scale": round(_clamp(light_scale, 0.85, 1.15), 4),
        }
    )

    pair_budget_scale = 1.0
    if pair_cap_rate >= 0.3 and geometry_bias != "save-runtime":
        pair_budget_scale = 1.1
    elif pair_cap_rate <= 0.1 and geometry_bias == "save-runtime":
        pair_budget_scale = 0.95

    tuned["recovery"].update(
        {
            "weak_boundary_stop_ratio": round(
                _clamp(
                    0.02 * (1.1 if geometry_bias == "save-runtime" else 0.9 if geometry_bias == "protect-quality" else 1.0),
                    0.015,
                    0.03,
                ),
                4,
            ),
            "weak_boundary_trigger_ratio": round(
                _clamp(
                    0.08 * (0.9 if geometry_bias == "save-runtime" else 1.1 if geometry_bias == "protect-quality" else 1.0),
                    0.05,
                    0.1,
                ),
                4,
            ),
            "pair_budget_scale": round(_clamp(pair_budget_scale, 0.9, 1.15), 4),
            "final_loop_trigger_ratio": round(
                _clamp(
                    0.05 * (0.9 if geometry_bias == "save-runtime" else 1.1 if geometry_bias == "protect-quality" else 1.0),
                    0.03,
                    0.08,
                ),
                4,
            ),
        }
    )

    wait_delay_scale = 1.0
    if matching_runtime_p75 >= 180:
        wait_delay_scale = 1.15
    elif matching_runtime_p75 <= 75:
        wait_delay_scale = 0.95
    tuned["orchestration"]["wait_delay_scale"] = round(_clamp(wait_delay_scale, 0.9, 1.2), 4)

    return tuned


def rebuild_tuned_snapshot() -> Dict[str, Any]:
    store = load_evidence_store()
    stable = load_stable_snapshot()
    records = list(store.get("records") or [])
    tuned = _derive_tuned_snapshot(records, stable)
    _write_json(app_config.ORDERED_VIDEO_TUNED_SNAPSHOT_FILE, tuned)
    return tuned


def _recent_tuned_health_requires_fallback(records: List[Dict[str, Any]]) -> bool:
    tuned_recent = [
        item for item in records
        if item.get("auto_tuning_mode") == "tuned"
    ][-RECENT_TUNED_HEALTH_WINDOW:]
    if len(tuned_recent) < 2:
        return False
    poor_count = sum(
        1 for item in tuned_recent
        if item.get("status") != "completed"
        or item.get("recovery_state") == "unresolved"
        or (item.get("registered_image_ratio") or 0.0) < 0.45
    )
    return poor_count >= 2


def get_active_auto_tuning_policy() -> Dict[str, Any]:
    stable = load_stable_snapshot()
    tuned = load_tuned_snapshot()
    store = load_evidence_store()
    records = list(store.get("records") or [])

    fallback_active = _recent_tuned_health_requires_fallback(records)
    if tuned.get("confidence") in {"medium", "high"} and not fallback_active:
        active_mode = "tuned"
        active_snapshot = tuned
    else:
        active_mode = "stable"
        active_snapshot = stable

    active_label = "Tuned policy" if active_mode == "tuned" else "Stable defaults"
    extraction_scale = float((active_snapshot.get("frame_budget") or {}).get("scale") or 1.0)
    progressive = dict(active_snapshot.get("progressive_matching") or {})
    recovery = dict(active_snapshot.get("recovery") or {})
    orchestration = dict(active_snapshot.get("orchestration") or {})

    summary = {
        "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
        "active_mode": active_mode,
        "mode": active_mode,
        "active_snapshot": active_mode,
        "active_label": active_label,
        "source_label": active_label,
        "derived_from_runs": int(tuned.get("derived_from_runs") or 0),
        "confidence": tuned.get("confidence", "insufficient-data"),
        "summary": (
            f"{active_label} with {int(tuned.get('derived_from_runs') or 0)} learned run(s) "
            f"and {tuned.get('confidence', 'insufficient-data')} confidence"
        ),
        "last_updated_at": tuned.get("updated_at") or stable.get("updated_at"),
        "guardrails_applied": True,
        "fallback_active": bool(fallback_active),
        "fallback_to_stable": bool(fallback_active),
        "fallback_reason": (
            "recent tuned runs regressed, so stable defaults are active"
            if fallback_active
            else None
        ),
        "stable_snapshot_updated_at": stable.get("updated_at"),
        "tuned_snapshot_updated_at": tuned.get("updated_at"),
        "extraction": {
            "label": "Frame budget",
            "status": "tuned" if active_mode == "tuned" else "stable",
            "summary": f"frame budget scale {extraction_scale:.2f}x",
        },
        "matching": {
            "label": "Progressive matching",
            "status": "tuned" if active_mode == "tuned" else "stable",
            "summary": (
                "strong bridge "
                f"{float(progressive.get('strong_bridge_p10') or 28.0):.1f} / "
                f"stable weak ratio {float(progressive.get('stable_weak_boundary_ratio') or 0.035):.3f}"
            ),
        },
        "recovery": {
            "label": "Recovery ladder",
            "status": "tuned" if active_mode == "tuned" else "stable",
            "summary": (
                "trigger "
                f"{float(recovery.get('weak_boundary_trigger_ratio') or 0.08):.3f} / "
                f"pair budget {float(recovery.get('pair_budget_scale') or 1.0):.2f}x"
            ),
        },
        "orchestration": {
            "label": "Resource lanes",
            "status": "tuned" if active_mode == "tuned" else "stable",
            "summary": (
                "wait delay "
                f"{float(orchestration.get('wait_delay_scale') or 1.0):.2f}x / "
                f"heavy score {int(orchestration.get('heavy_score_threshold') or 5)}"
            ),
        },
        "training": {
            "label": "Training handoff",
            "status": "contextual",
            "summary": "training receives capture and recovery context from the active resource-aware policy",
        },
        "export": {
            "label": "Export handoff",
            "status": "contextual",
            "summary": "export surfaces keep the active policy state visible even when heavy post-process remains conservative",
        },
    }

    return {
        "active_mode": active_mode,
        "active_snapshot": active_snapshot,
        "stable_snapshot": stable,
        "tuned_snapshot": tuned,
        "summary": summary,
    }


def record_project_evidence(project_id: str, project_entry: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    evidence = _make_project_evidence(project_id, project_entry)
    if not evidence:
        return None

    store = load_evidence_store()
    records = list(store.get("records") or [])
    records.append(evidence)
    store["records"] = records[-MAX_EVIDENCE_RECORDS:]
    store["updated_at"] = _utc_now()
    _write_json(app_config.ORDERED_VIDEO_EVIDENCE_FILE, store)
    tuned = rebuild_tuned_snapshot()
    return {
        "evidence_record": evidence,
        "tuned_snapshot": tuned,
    }


def attach_auto_tuning_to_config(config: Dict[str, Any]) -> Dict[str, Any]:
    policy = get_active_auto_tuning_policy()
    merged = dict(config or {})
    merged["_auto_tuning_policy"] = policy
    merged["auto_tuning_summary"] = policy["summary"]
    return merged


def attach_auto_tuning_to_colmap_cfg(colmap_cfg: Dict[str, Any], policy: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not policy:
        return colmap_cfg
    colmap_cfg = dict(colmap_cfg or {})
    snapshot = dict(policy.get("active_snapshot") or {})
    summary = dict(policy.get("summary") or {})
    colmap_cfg["auto_tuning"] = snapshot
    colmap_cfg["auto_tuning_summary"] = summary
    colmap_cfg["auto_tuning_policy_mode"] = summary.get("active_mode")
    return colmap_cfg
