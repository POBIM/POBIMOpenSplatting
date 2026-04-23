"""Shared contracts for ordered-video resource-aware orchestration."""

from __future__ import annotations

from typing import Any, Dict, List

RESOURCE_AWARE_SCHEMA_VERSION = "2026-04-23-ordered-video-v1"

ORDERED_VIDEO_BENCHMARK_PROFILES: List[Dict[str, str]] = [
    {
        "id": "short_clean_orbit",
        "label": "Short clean orbit",
        "description": "Short ordered orbit video with stable geometry and low redundancy.",
    },
    {
        "id": "long_redundant_orbit",
        "label": "Long redundant orbit",
        "description": "Long ordered orbit video with many adjacent near-duplicate frames.",
    },
    {
        "id": "mixed_stills_video",
        "label": "Mixed stills plus video",
        "description": "Project that mixes ordered video with still-image coverage.",
    },
    {
        "id": "weak_boundary_capture",
        "label": "Weak-boundary capture",
        "description": "Ordered capture with low-texture or weak temporal bridge windows.",
    },
]

ORDERED_VIDEO_METRIC_KEYS: List[str] = [
    "extracted_image_count",
    "pair_count",
    "bridge_p10",
    "bridge_min",
    "weak_boundary_ratio",
    "zero_boundary_ratio",
    "registered_image_ratio",
    "extraction_runtime_seconds",
    "matching_runtime_seconds",
    "sparse_runtime_seconds",
    "total_runtime_seconds",
]

RECOVERY_PRECEDENCE: List[str] = [
    "progressive_pair_scheduling",
    "weak_window_subset",
    "boundary_frame_densification",
    "stubborn_boundary_subset",
    "pair_targeted_stubborn_rematch",
    "final_loop_detection_subset",
]

RECOVERY_FINAL_PATHS: List[str] = [
    "baseline",
    "bridge_recovery",
    "subset_repair",
    "densification",
    "stubborn_targeted_pairs",
    "broad_fallback",
]

RESOURCE_PROFILE_CLASSES: List[str] = [
    "light",
    "balanced",
    "heavy",
    "gpu_constrained",
]

RESOURCE_LANES: List[str] = [
    "running",
    "deferred",
    "downgraded",
    "waiting_for_heavy_slot",
]

RESOURCE_REQUIRED_FIELDS: List[str] = [
    "resource_profile",
    "resource_lane",
    "capture_budget_summary",
    "recovery_loop_summary",
    "training_budget_summary",
    "auto_tuning_summary",
]

HEAVY_STAGE_KEYS: List[str] = [
    "feature_matching",
    "sparse_reconstruction",
    "gaussian_splatting",
]


def build_resource_aware_contract() -> Dict[str, Any]:
    return {
        "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
        "benchmark_profiles": list(ORDERED_VIDEO_BENCHMARK_PROFILES),
        "metric_keys": list(ORDERED_VIDEO_METRIC_KEYS),
        "recovery_precedence": list(RECOVERY_PRECEDENCE),
        "recovery_final_paths": list(RECOVERY_FINAL_PATHS),
        "resource_profile_classes": list(RESOURCE_PROFILE_CLASSES),
        "resource_lanes": list(RESOURCE_LANES),
        "heavy_stage_keys": list(HEAVY_STAGE_KEYS),
        "required_fields": list(RESOURCE_REQUIRED_FIELDS),
    }


def missing_required_resource_fields(
    payload: Dict[str, Any],
    *,
    required_fields: List[str] | None = None,
) -> List[str]:
    payload = dict(payload or {})
    fields = list(required_fields or RESOURCE_REQUIRED_FIELDS)
    return [field for field in fields if payload.get(field) is None]
