"""Helpers for progressive sequential matching on ordered video-like captures."""

from __future__ import annotations

from typing import Any, Dict, Optional


def _int_value(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _looks_like_ordered_video(capture_pattern: Optional[Dict[str, Any]]) -> bool:
    capture = capture_pattern or {}
    if capture.get("looks_like_video_orbit"):
        return True
    return float(capture.get("ordered_frame_ratio") or 0.0) >= 0.8


def _progressive_tuning(colmap_cfg: Dict[str, Any]) -> Dict[str, float]:
    snapshot = dict((colmap_cfg or {}).get("auto_tuning") or {})
    tuning = dict(snapshot.get("progressive_matching") or {})
    return {
        "strong_bridge_p10": float(tuning.get("strong_bridge_p10") or 28.0),
        "strong_weak_boundary_ratio": float(tuning.get("strong_weak_boundary_ratio") or 0.015),
        "stable_bridge_p10": float(tuning.get("stable_bridge_p10") or 22.0),
        "stable_weak_boundary_ratio": float(tuning.get("stable_weak_boundary_ratio") or 0.035),
        "loop_bridge_p10": float(tuning.get("loop_bridge_p10") or 20.0),
        "loop_bridge_min": float(tuning.get("loop_bridge_min") or 12.0),
        "loop_weak_boundary_ratio": float(tuning.get("loop_weak_boundary_ratio") or 0.03),
        "light_pair_coverage_scale": float(tuning.get("light_pair_coverage_scale") or 1.0),
    }


def _budgeted_max_matches(
    final_max_matches: int,
    ratio: float,
    *,
    floor: int,
    resource_tier: str,
    feature_pressure: bool,
) -> int:
    effective_ratio = ratio
    if resource_tier == "tight":
        effective_ratio -= 0.08
    elif resource_tier == "constrained":
        effective_ratio -= 0.04
    if feature_pressure:
        effective_ratio -= 0.05

    scaled_value = int(round(final_max_matches * max(0.45, effective_ratio)))
    return min(final_max_matches, max(floor, scaled_value))


def _build_loop_limited_params(
    matcher_params: Dict[str, str], num_images: int
) -> Dict[str, str]:
    loop_params = dict(matcher_params)
    loop_params["SequentialMatching.loop_detection"] = "1"
    loop_num_images = min(24, max(10, num_images // 32))
    loop_params.setdefault(
        "SequentialMatching.loop_detection_num_images", str(loop_num_images)
    )
    loop_params.setdefault(
        "SequentialMatching.loop_detection_num_nearest_neighbors", "1"
    )
    loop_params.setdefault("SequentialMatching.loop_detection_num_checks", "24")
    loop_params.setdefault(
        "SequentialMatching.loop_detection_num_images_after_verification",
        str(min(12, max(6, loop_num_images // 2))),
    )
    return loop_params


def build_progressive_sequential_matching_plan(
    num_images: int,
    colmap_cfg: Dict[str, Any],
    *,
    capture_pattern: Optional[Dict[str, Any]] = None,
    gpu_total_vram_mb: Optional[int] = None,
    peak_feature_count: Optional[int] = None,
) -> Optional[Dict[str, Any]]:
    if colmap_cfg.get("matcher_type") != "sequential":
        return None

    matcher_params = dict(colmap_cfg.get("matcher_params") or {})
    if not matcher_params:
        return None

    capture = capture_pattern or colmap_cfg.get("capture_pattern") or {}
    if not _looks_like_ordered_video(capture):
        return None

    final_overlap = max(
        1, _int_value(matcher_params.get("SequentialMatching.overlap"), 12)
    )
    final_max_matches = max(1, _int_value(colmap_cfg.get("max_num_matches"), 32768))
    quadratic_enabled = (
        str(matcher_params.get("SequentialMatching.quadratic_overlap", "0")) == "1"
    )
    loop_detection_enabled = (
        str(matcher_params.get("SequentialMatching.loop_detection", "0")) == "1"
    )

    if num_images < 48 and final_overlap <= 16 and not loop_detection_enabled:
        return None
    if final_overlap <= 12 and not quadratic_enabled and not loop_detection_enabled:
        return None

    thresholds = _progressive_tuning(colmap_cfg)

    if gpu_total_vram_mb is not None and gpu_total_vram_mb < 8192:
        resource_tier = "tight"
    elif gpu_total_vram_mb is not None and gpu_total_vram_mb < 12288:
        resource_tier = "constrained"
    else:
        resource_tier = "normal"

    feature_pressure = (peak_feature_count or 0) >= 18000

    if num_images <= 120:
        bootstrap_overlap_cap = 8
    elif num_images <= 240:
        bootstrap_overlap_cap = 10
    elif num_images <= 480:
        bootstrap_overlap_cap = 12
    else:
        bootstrap_overlap_cap = 14

    bootstrap_overlap = min(final_overlap, bootstrap_overlap_cap)
    bridge_overlap = min(final_overlap, max(bootstrap_overlap + 6, int(round(final_overlap * 0.72))))
    target_overlap = final_overlap

    passes = []

    bootstrap_params = dict(matcher_params)
    bootstrap_params["SequentialMatching.overlap"] = str(bootstrap_overlap)
    bootstrap_params["SequentialMatching.quadratic_overlap"] = "0"
    bootstrap_params["SequentialMatching.loop_detection"] = "0"
    passes.append(
        {
            "key": "local-bootstrap",
            "label": "local bootstrap",
            "required": True,
            "kind": "bootstrap",
            "matcher_params": bootstrap_params,
            "max_num_matches": _budgeted_max_matches(
                final_max_matches,
                0.78,
                floor=12288,
                resource_tier=resource_tier,
                feature_pressure=feature_pressure,
            ),
                "continue_if": "weak_boundaries",
                "checkpoint_note": "cheap local temporal pairs first",
                "auto_tuning_thresholds": thresholds,
            }
        )

    bridge_params = dict(matcher_params)
    bridge_params["SequentialMatching.overlap"] = str(bridge_overlap)
    bridge_params["SequentialMatching.quadratic_overlap"] = "1"
    bridge_params["SequentialMatching.loop_detection"] = "0"
    if bridge_overlap > bootstrap_overlap or quadratic_enabled:
        passes.append(
            {
                "key": "bridge-expand",
                "label": "bridge expansion",
                "required": False,
                "kind": "bridge",
                "matcher_params": bridge_params,
                "max_num_matches": _budgeted_max_matches(
                    final_max_matches,
                    0.88,
                    floor=16384,
                    resource_tier=resource_tier,
                    feature_pressure=feature_pressure,
                ),
                "continue_if": "persistent_weak_boundaries",
                "checkpoint_note": "expand across weak transitions before heavier recovery",
                "auto_tuning_thresholds": thresholds,
            }
        )

    target_params = dict(matcher_params)
    target_params["SequentialMatching.overlap"] = str(target_overlap)
    target_params["SequentialMatching.loop_detection"] = "0"
    if target_overlap > bridge_overlap:
        passes.append(
            {
                "key": "target-expand",
                "label": "target overlap",
                "required": False,
                "kind": "target",
                "matcher_params": target_params,
                "max_num_matches": _budgeted_max_matches(
                    final_max_matches,
                    0.96,
                    floor=20480,
                    resource_tier=resource_tier,
                    feature_pressure=feature_pressure,
                ),
                "continue_if": "severe_boundary_gaps",
                "checkpoint_note": "reach the planned overlap only if earlier passes still look weak",
                "auto_tuning_thresholds": thresholds,
            }
        )

    if loop_detection_enabled:
        passes.append(
            {
                "key": "loop-expand",
                "label": "loop expansion",
                "required": False,
                "kind": "loop",
                "matcher_params": _build_loop_limited_params(matcher_params, num_images),
                "max_num_matches": _budgeted_max_matches(
                    final_max_matches,
                    0.72,
                    floor=12288,
                    resource_tier=resource_tier,
                    feature_pressure=feature_pressure,
                ),
                "continue_if": "never",
                "checkpoint_note": "bounded loop closure only if boundary gaps remain",
                "auto_tuning_thresholds": thresholds,
            }
        )

    if len(passes) <= 1:
        return None

    return {
        "enabled": True,
        "reason": (
            "ordered-video progressive sequential matching: start local, widen only "
            "when pair geometry still shows weak boundaries"
        ),
        "resource_tier": resource_tier,
        "peak_feature_count": peak_feature_count,
        "gpu_total_vram_mb": gpu_total_vram_mb,
        "final_overlap": final_overlap,
        "auto_tuning_thresholds": thresholds,
        "passes": passes,
    }


def summarize_progressive_geometry(geometry_stats: Optional[Dict[str, Any]]) -> str:
    if not geometry_stats:
        return "pair geometry unavailable"

    image_count = max(1, _int_value(geometry_stats.get("image_count"), 1))
    weak_boundary_count = _int_value(geometry_stats.get("weak_boundary_count"), 0)
    zero_boundary_count = _int_value(geometry_stats.get("zero_boundary_count"), 0)
    bridge_p10 = float(geometry_stats.get("bridge_p10") or 0.0)
    bridge_min = float(geometry_stats.get("bridge_min") or 0.0)

    return (
        f"bridge_p10={bridge_p10:g}, bridge_min={bridge_min:g}, "
        f"weak={weak_boundary_count}/{max(image_count - 1, 1)}, "
        f"zero={zero_boundary_count}"
    )


def should_continue_progressive_matching(
    next_pass: Dict[str, Any],
    geometry_stats: Optional[Dict[str, Any]],
    *,
    verified_pairs: int,
) -> tuple[bool, str]:
    if not next_pass:
        return False, "no later progressive pass is scheduled"

    if not geometry_stats:
        return True, "pair geometry checkpoint is unavailable, so the safer path is to continue"

    image_count = max(1, _int_value(geometry_stats.get("image_count"), 1))
    weak_boundary_count = _int_value(geometry_stats.get("weak_boundary_count"), 0)
    zero_boundary_count = _int_value(geometry_stats.get("zero_boundary_count"), 0)
    weak_boundary_ratio = float(geometry_stats.get("weak_boundary_ratio") or 0.0)
    bridge_p10 = float(geometry_stats.get("bridge_p10") or 0.0)
    bridge_min = float(geometry_stats.get("bridge_min") or 0.0)
    thresholds = dict(next_pass.get("auto_tuning_thresholds") or {})
    strong_bridge_p10 = float(thresholds.get("strong_bridge_p10") or 28.0)
    strong_weak_boundary_ratio = float(thresholds.get("strong_weak_boundary_ratio") or 0.015)
    stable_bridge_p10 = float(thresholds.get("stable_bridge_p10") or 22.0)
    stable_weak_boundary_ratio = float(thresholds.get("stable_weak_boundary_ratio") or 0.035)
    loop_bridge_p10 = float(thresholds.get("loop_bridge_p10") or 20.0)
    loop_bridge_min = float(thresholds.get("loop_bridge_min") or 12.0)
    loop_weak_boundary_ratio = float(thresholds.get("loop_weak_boundary_ratio") or 0.03)
    light_pair_scale = float(thresholds.get("light_pair_coverage_scale") or 1.0)

    strong_geometry = (
        zero_boundary_count == 0
        and weak_boundary_ratio <= strong_weak_boundary_ratio
        and bridge_p10 >= strong_bridge_p10
    )
    stable_geometry = (
        zero_boundary_count == 0
        and weak_boundary_ratio <= stable_weak_boundary_ratio
        and bridge_p10 >= stable_bridge_p10
    )
    light_pair_coverage = verified_pairs < max(int(round(image_count * 3 * light_pair_scale)), 120)

    if next_pass.get("kind") == "loop":
        should_continue = (
            zero_boundary_count > 0
            or weak_boundary_ratio >= loop_weak_boundary_ratio
            or bridge_min < loop_bridge_min
            or bridge_p10 < loop_bridge_p10
        )
        if should_continue:
            return True, "boundary gaps remain severe enough to justify bounded loop expansion"
        return False, "loop expansion is unnecessary after the current geometry checkpoint"

    if strong_geometry and not light_pair_coverage:
        return (
            False,
            "bridge geometry already looks stable enough to stop before heavier passes",
        )

    if stable_geometry and next_pass.get("kind") in {"target", "loop"} and not light_pair_coverage:
        return False, "current bridge coverage looks stable enough to avoid the heavier target pass"

    if light_pair_coverage:
        return True, "verified pair coverage is still light for an ordered sequence"

    return True, "weak boundary signals still justify the next progressive expansion pass"
