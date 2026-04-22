"""Configuration builders and policy preview helpers for the pipeline."""

from __future__ import annotations

import os
import subprocess
from typing import Any, Dict, List

from ..core import config as app_config
from ..core.projects import append_log_line
from .orbit_policy import (
    ORDERED_CAPTURE_POLICY_IMAGE_LIMIT,
    analyze_capture_pattern,
    analyze_capture_pattern_from_names,
    build_orbit_safe_policy,
    build_orbit_safe_policy_from_capture,
    sync_reconstruction_framework,
)
from .runtime_support import (
    estimate_gpu_safe_match_limit,
    get_gpu_total_vram_mb,
    get_vocab_tree_matcher_params,
    normalize_matcher_type,
    normalize_sfm_backend,
    normalize_sfm_engine,
)
from .resource_contract import build_resource_aware_contract


def get_colmap_executable():
    """Get the preferred COLMAP executable for this environment."""
    for candidate in app_config.COLMAP_CANDIDATE_PATHS:
        try:
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
        except OSError:
            continue

    if app_config.COLMAP_ENV_PATH:
        return app_config.COLMAP_ENV_PATH

    return "colmap"


def estimate_preview_image_count(config, media_summary):
    input_type = media_summary.get("input_type") or config.get("input_type") or "images"
    image_count = int(media_summary.get("image_count") or 0)
    video_count = int(media_summary.get("video_count") or 0)

    if input_type == "images":
        return max(image_count, 0)

    extraction_mode = str(config.get("extraction_mode", "fps")).lower()
    if extraction_mode in {"frames", "target_count"}:
        per_video = max(24, int(config.get("max_frames") or 100))
    else:
        try:
            target_fps = float(config.get("target_fps") or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        per_video = max(24, min(240, int(round(target_fps * 60))))

    if input_type == "video":
        return per_video * max(video_count, 1)

    return image_count + (per_video * max(video_count, 1))


def _build_upload_adaptive_policy_state(
    preview_config: Dict[str, Any], input_profile: str, resolved_matcher_type: str | None
) -> Dict[str, Dict[str, Any]]:
    smart_frame_selection = bool(preview_config.get("smart_frame_selection", True))
    frame_budget_available = (
        input_profile in {"video", "mixed"} and smart_frame_selection
    )
    frame_budget_enabled = frame_budget_available and bool(
        preview_config.get("adaptive_frame_budget", True)
    )

    pair_scheduling_available = (
        input_profile in {"video", "mixed"} and resolved_matcher_type == "sequential"
    )
    pair_scheduling_enabled = pair_scheduling_available and bool(
        preview_config.get("adaptive_pair_scheduling", True)
    )

    return {
        "frame_budget": {
            "enabled": frame_budget_enabled,
            "available": frame_budget_available,
            "label": "Adaptive Frame Budget",
            "effect": "Content-aware candidate extraction for ordered video",
            "current_summary": (
                "Adaptive frame budgeting is active, so the backend can trim duplicate-heavy frame windows before COLMAP."
                if frame_budget_enabled
                else (
                    "Frame extraction is using a fixed oversample budget. This is simpler, but it can waste candidate density on redundant video spans."
                    if frame_budget_available
                    else "Adaptive frame budgeting only applies when smart frame selection is enabled on video-like input."
                )
            ),
            "disabled_summary": "Fixed oversample budget with no video-aware adjustment.",
            "gate": (
                "Enable smart frame selection first to unlock adaptive frame budgeting."
                if input_profile in {"video", "mixed"} and not smart_frame_selection
                else None
            ),
        },
        "pair_scheduling": {
            "enabled": pair_scheduling_enabled,
            "available": pair_scheduling_available,
            "label": "Adaptive Pair Scheduling",
            "effect": "Progressive sequential matching passes with staged expansion",
            "current_summary": (
                "Progressive pair scheduling is active, so sequential matching can expand in stages instead of paying the full overlap cost immediately."
                if pair_scheduling_enabled
                else (
                    "Sequential matching will run as one fixed pass. This is predictable, but it usually wastes pair budget on easier video spans."
                    if pair_scheduling_available
                    else "Progressive pair scheduling only becomes active when the preview resolves to sequential matching."
                )
            ),
            "disabled_summary": "Single-pass sequential matching without staged expansion.",
            "gate": (
                "The current preview does not resolve to sequential matching, so staged pair expansion is not active yet."
                if input_profile in {"video", "mixed"}
                and resolved_matcher_type != "sequential"
                else None
            ),
        },
    }


def build_upload_policy_preview(config, media_summary):
    preview_config = dict(config or {})
    preview_config["input_type"] = (
        media_summary.get("input_type") or preview_config.get("input_type") or "images"
    )
    estimated_num_images = estimate_preview_image_count(preview_config, media_summary)
    preview_config["estimated_num_images"] = estimated_num_images

    image_names = media_summary.get("image_names") or []
    capture_pattern = analyze_capture_pattern_from_names(image_names, preview_config)
    orbit_safe_policy = build_orbit_safe_policy_from_capture(
        capture_pattern, preview_config, estimated_num_images
    )
    orbit_safe_mode = orbit_safe_policy is not None

    colmap_cfg = get_colmap_config(
        max(estimated_num_images, 1),
        quality_mode=preview_config.get("quality_mode", "balanced"),
        custom_params=preview_config
        if preview_config.get("quality_mode") == "custom"
        else preview_config,
        preferred_matcher_type=normalize_matcher_type(
            preview_config.get("matcher_type")
        ),
        orbit_safe_mode=orbit_safe_mode,
        orbit_safe_policy=orbit_safe_policy,
    )

    input_profile = preview_config["input_type"]
    if input_profile not in {"video", "mixed", "images"}:
        input_profile = "unknown"

    tone_key = "unknown"
    if input_profile == "video":
        tone_key = "video"
    elif input_profile == "mixed":
        tone_key = "mixed"
    elif input_profile == "images":
        tone_key = "images"

    adaptive_policy = _build_upload_adaptive_policy_state(
        preview_config, input_profile, colmap_cfg.get("matcher_type")
    )

    signals: List[Dict[str, Any]] = []

    def add_signal(key: str, label: str, delta: int, detail: str) -> None:
        signals.append({"key": key, "label": label, "delta": delta, "detail": detail})

    score = (
        88
        if input_profile == "video"
        else 76
        if input_profile == "images"
        else 68
        if input_profile == "mixed"
        else 42
    )
    add_signal(
        "input-profile", "Input profile", 0, f"Detected input profile: {input_profile}"
    )

    explicit_matcher = normalize_matcher_type(preview_config.get("matcher_type"))
    if explicit_matcher:
        score -= 18
        add_signal(
            "matcher-override",
            "Matcher override",
            -18,
            f"Explicit matcher override: {explicit_matcher}",
        )
    else:
        add_signal(
            "matcher-auto",
            "Matcher auto",
            6,
            "Auto matcher allows backend policy selection",
        )
        score += 6

    feature_method = str(preview_config.get("feature_method", "sift"))
    if input_profile in {"images", "mixed"} and feature_method in {
        "aliked",
        "superpoint",
    }:
        score += 5
        add_signal(
            "neural-features",
            "Neural features",
            5,
            f"{feature_method} can improve photo-heavy coverage and speed",
        )
    elif input_profile == "video" and feature_method == "sift":
        score += 2
        add_signal(
            "sift-video",
            "SIFT compatibility",
            2,
            "SIFT remains a stable baseline for video input",
        )

    sfm_engine = str(preview_config.get("sfm_engine", "glomap"))
    sfm_backend = normalize_sfm_backend(preview_config.get("sfm_backend", "cli"))
    if input_profile == "images" and sfm_engine == "fastmap":
        score -= 20
        add_signal(
            "fastmap-images",
            "Engine mismatch",
            -20,
            "FastMap is less reliable on unordered photo collections",
        )
    elif input_profile == "mixed" and sfm_engine == "fastmap":
        score -= 14
        add_signal(
            "fastmap-mixed",
            "Engine mismatch",
            -14,
            "Mixed inputs can be brittle with FastMap",
        )

    extraction_mode = str(preview_config.get("extraction_mode", "fps")).lower()
    if input_profile in {"video", "mixed"} and extraction_mode == "fps":
        try:
            target_fps = float(preview_config.get("target_fps") or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        if target_fps >= 10:
            score -= 8
            add_signal(
                "dense-fps",
                "Dense sampling",
                -8,
                f"{target_fps} fps may add many near-duplicate frames",
            )
        elif 2 <= target_fps <= 5:
            score += 4
            add_signal(
                "balanced-fps",
                "Balanced sampling",
                4,
                f"{target_fps} fps is a good temporal density for preview policy",
            )
        elif 0 < target_fps < 1:
            score -= 6
            add_signal(
                "sparse-fps",
                "Sparse sampling",
                -6,
                f"{target_fps} fps may weaken bridge geometry across the orbit",
            )
    elif input_profile in {"video", "mixed"} and extraction_mode in {
        "frames",
        "target_count",
    }:
        max_frames = int(preview_config.get("max_frames") or 100)
        if max_frames >= 400:
            score -= 7
            add_signal(
                "dense-frames",
                "Dense frame count",
                -7,
                f"{max_frames} frames can create redundancy and heavier matching load",
            )
        elif 100 <= max_frames <= 250:
            score += 3
            add_signal(
                "balanced-frames",
                "Balanced frame count",
                3,
                f"{max_frames} frames is a reasonable preview density",
            )
        elif max_frames < 80:
            score -= 5
            add_signal(
                "limited-frames",
                "Limited frame count",
                -5,
                f"{max_frames} frames may be too sparse for stable bridge recovery",
            )

    frame_budget_state = adaptive_policy["frame_budget"]
    if frame_budget_state["enabled"]:
        score += 5
        add_signal(
            "adaptive-frame-budget",
            "Adaptive frame budget",
            5,
            "Video frame extraction can reduce duplicate-heavy candidate pools before COLMAP.",
        )
    elif frame_budget_state["available"]:
        score -= 4
        add_signal(
            "fixed-frame-budget",
            "Fixed frame budget",
            -4,
            "Smart frame selection is on, but adaptive frame budgeting is disabled so oversampling stays static.",
        )
    elif input_profile in {"video", "mixed"}:
        score -= 9
        add_signal(
            "smart-selection-off",
            "Static frame extraction",
            -9,
            "Smart frame selection is disabled, so ordered-video extraction cannot adapt to redundant windows.",
        )

    pair_scheduling_state = adaptive_policy["pair_scheduling"]
    if pair_scheduling_state["enabled"]:
        score += 6
        add_signal(
            "adaptive-pair-scheduling",
            "Adaptive pair schedule",
            6,
            "Sequential matching can expand in staged passes instead of paying the full pair budget up front.",
        )
    elif pair_scheduling_state["available"]:
        score -= 6
        add_signal(
            "single-pass-sequential",
            "Single-pass schedule",
            -6,
            "Sequential matching is active, but adaptive staged expansion is disabled.",
        )

    if input_profile in {"video", "mixed"} and preview_config.get(
        "use_separate_training_images"
    ):
        score += 2
        add_signal(
            "training-images",
            "Training image split",
            2,
            "Separate high-resolution training images can help final training quality",
        )

    score = max(18, min(96, score))
    if score >= 80:
        confidence = {
            "label": "High",
            "tone": "border-emerald-200 bg-emerald-100 text-emerald-900",
            "meterClass": "bg-emerald-500",
            "score": score,
            "signals": signals,
        }
    elif score >= 60:
        confidence = {
            "label": "Medium",
            "tone": "border-amber-200 bg-amber-100 text-amber-900",
            "meterClass": "bg-amber-500",
            "score": score,
            "signals": signals,
        }
    else:
        confidence = {
            "label": "Cautious",
            "tone": "border-rose-200 bg-rose-100 text-rose-900",
            "meterClass": "bg-rose-500",
            "score": score,
            "signals": signals,
        }

    preview_rules: List[Dict[str, str]] = []

    def add_rule(level: str, text: str) -> None:
        preview_rules.append({"level": level, "text": text})

    if explicit_matcher:
        add_rule(
            "warning",
            f"Matcher override is active. The backend will respect {explicit_matcher} instead of choosing automatically.",
        )
    else:
        add_rule(
            "info",
            "Matcher is on Auto, so the backend can still adapt from capture ordering and pair geometry.",
        )

    if frame_budget_state["enabled"]:
        add_rule(
            "info",
            "Adaptive frame budget is active. The backend will keep smart frame selection but spend candidate density more selectively across the video.",
        )
    elif frame_budget_state["available"]:
        add_rule(
            "warning",
            "Adaptive frame budget is off. The extractor will keep a fixed oversample budget even if the video contains long redundant spans.",
        )
    elif input_profile in {"video", "mixed"}:
        add_rule(
            "warning",
            "Smart frame selection is off, so the ordered-video extractor cannot adapt frame density before matching.",
        )

    if pair_scheduling_state["enabled"]:
        add_rule(
            "info",
            "Adaptive pair scheduling is active. Sequential matching can bootstrap locally, then expand bridge and loop pairs only when geometry needs it.",
        )
    elif pair_scheduling_state["available"]:
        add_rule(
            "warning",
            "Adaptive pair scheduling is off. Sequential matching will pay its overlap budget in one pass instead of expanding progressively.",
        )

    if input_profile == "images" and sfm_engine == "fastmap":
        add_rule(
            "warning",
            "FastMap with an image-only set is a riskier combination. COLMAP Global SfM or incremental COLMAP is usually safer for unordered photo collections.",
        )
    if input_profile == "mixed" and sfm_engine == "fastmap":
        add_rule(
            "warning",
            "FastMap on mixed media can be brittle when some inputs behave like unordered photos.",
        )
    if input_profile == "video" and explicit_matcher == "exhaustive":
        add_rule(
            "warning",
            "Exhaustive matching on video/orbit input may reduce the benefit of orbit-safe sequential policy.",
        )
    if input_profile == "images" and explicit_matcher == "sequential":
        add_rule(
            "warning",
            "Sequential override assumes the filenames or capture order are meaningful. Use Auto or Exhaustive for unordered photos.",
        )
    if input_profile == "video" and explicit_matcher == "vocab_tree":
        add_rule(
            "warning",
            "Vocab-tree retrieval is tuned for large unordered photo collections, not ordered video/orbit input.",
        )
    if input_profile == "images" and explicit_matcher == "vocab_tree":
        add_rule(
            "info",
            "Vocab-tree retrieval is a strong experimental option for larger unordered photo collections.",
        )
    if input_profile in {"video", "mixed"} and extraction_mode == "fps":
        try:
            target_fps = float(preview_config.get("target_fps") or 2.0)
        except (TypeError, ValueError):
            target_fps = 2.0
        if target_fps >= 10:
            add_rule(
                "warning",
                f"Target FPS is set to {target_fps}. Very dense sampling can add near-duplicate frames and reduce policy confidence.",
            )
        elif 0 < target_fps < 1:
            add_rule(
                "warning",
                f"Target FPS is {target_fps}. Sparse sampling may weaken bridge geometry across the orbit.",
            )
    if input_profile in {"video", "mixed"} and extraction_mode in {
        "frames",
        "target_count",
    }:
        max_frames = int(preview_config.get("max_frames") or 100)
        if max_frames >= 400:
            add_rule(
                "warning",
                f"Maximum frames is {max_frames}. This is dense enough to create redundancy and heavier matching load.",
            )
        elif max_frames < 80:
            add_rule(
                "warning",
                f"Maximum frames is only {max_frames}. Sparse frame coverage may make loop closure and bridge recovery harder.",
            )
    if input_profile in {"images", "mixed"} and feature_method in {
        "aliked",
        "superpoint",
    }:
        add_rule(
            "info",
            f"{feature_method} + LightGlue should help high-resolution photo coverage and usually raises preview confidence for photo-heavy inputs.",
        )
    if input_profile == "video" and feature_method != "sift":
        add_rule(
            "info",
            f"{feature_method} is enabled. Neural features can speed up matching, but ordered video policy still matters more than descriptor choice.",
        )
    if input_profile in {"video", "mixed"} and preview_config.get(
        "use_separate_training_images"
    ):
        add_rule(
            "info",
            "Separate high-resolution training images are enabled. This improves training quality but does not change the sparse policy directly.",
        )
    if input_profile == "video" and sfm_engine == "colmap":
        add_rule(
            "info",
            "COLMAP is a conservative choice for video input and aligns well with stricter orbit-safe incremental reconstruction.",
        )
    if sfm_backend == "pycolmap":
        add_rule(
            "info",
            "Experimental backend enabled: pycolmap global mapping will be attempted first, then the backend falls back to CLI global mapping if unsupported.",
        )

    if input_profile == "video":
        if frame_budget_state["enabled"] and pair_scheduling_state["enabled"]:
            policy_summary = (
                "Ordered frames will start with adaptive extraction and staged sequential matching, so the backend can spend frame and pair budget where bridge geometry actually needs it."
            )
        elif frame_budget_state["enabled"]:
            policy_summary = (
                "Ordered frames will start with adaptive extraction, but matching is still closer to a fixed sequential pass."
            )
        elif pair_scheduling_state["enabled"]:
            policy_summary = (
                "Ordered frames will keep a fixed extraction budget, but sequential matching can still expand progressively from local to bridge-heavy passes."
            )
        else:
            policy_summary = (
                "Ordered frames will follow a more static orbit-safe policy with fixed extraction and matching budgets."
            )
        expected_policy = {
            "title": "Orbit-Safe Video Policy",
            "tone": "border-emerald-200 bg-emerald-50 text-emerald-900",
            "badgeTone": "border-emerald-200 bg-emerald-100 text-emerald-900",
            "profileBadge": "video orbit",
            "matcherBadge": colmap_cfg.get("matcher_type"),
            "engineBadge": "global sfm + safe fallback"
            if sfm_engine == "glomap"
            else f"{sfm_engine} preferred",
            "summary": policy_summary,
            "toneKey": tone_key,
        }
    elif input_profile == "mixed":
        expected_policy = {
            "title": "Mixed Capture Policy",
            "tone": "border-amber-200 bg-amber-50 text-amber-900",
            "badgeTone": "border-amber-200 bg-amber-100 text-amber-900",
            "profileBadge": "mixed input",
            "matcherBadge": colmap_cfg.get("matcher_type"),
            "engineBadge": f"{sfm_engine} preferred",
            "summary": "Mixed uploads are treated cautiously. The backend inspects whether the set behaves more like ordered frames or unordered photos before locking the matcher and mapper policy.",
            "toneKey": tone_key,
        }
    elif input_profile == "images":
        expected_policy = {
            "title": "Photo Set Policy",
            "tone": "border-sky-200 bg-sky-50 text-sky-900",
            "badgeTone": "border-sky-200 bg-sky-100 text-sky-900",
            "profileBadge": "image collection",
            "matcherBadge": colmap_cfg.get("matcher_type"),
            "engineBadge": f"{sfm_engine} preferred",
            "summary": "For image collections, the backend usually prefers exhaustive matching on smaller unordered sets and sequential only when filenames or capture order look strongly ordered.",
            "toneKey": tone_key,
        }
    else:
        expected_policy = {
            "title": "Waiting For Media Signal",
            "tone": "border-gray-200 bg-gray-50 text-gray-800",
            "badgeTone": "border-gray-200 bg-white text-gray-700",
            "profileBadge": "no files yet",
            "matcherBadge": colmap_cfg.get("matcher_type"),
            "engineBadge": f"{sfm_engine} preferred",
            "summary": "Select files first, then this panel will estimate which reconstruction policy the backend is most likely to apply.",
            "toneKey": tone_key,
        }

    return {
        "resource_contract": build_resource_aware_contract(),
        "heuristic_source": "backend",
        "input_profile": input_profile,
        "estimated_num_images": estimated_num_images,
        "capture_pattern": capture_pattern,
        "expected_policy": expected_policy,
        "confidence": confidence,
        "preview_rules": preview_rules,
        "resolved_matcher_type": colmap_cfg.get("matcher_type"),
        "orbit_safe_mode": orbit_safe_mode,
        "orbit_safe_profile": colmap_cfg.get("orbit_safe_profile"),
        "bridge_risk_score": colmap_cfg.get("bridge_risk_score"),
        "adaptive_policy": adaptive_policy,
    }


def build_upload_adaptive_policy_comparisons(
    config: Dict[str, Any],
    media_summary: Dict[str, Any],
    current_preview: Dict[str, Any] | None = None,
) -> List[Dict[str, Any]]:
    preview = current_preview or build_upload_policy_preview(config, media_summary)
    current_policy = preview.get("adaptive_policy") or {}
    comparisons: List[Dict[str, Any]] = []

    for key, config_key in (
        ("frame_budget", "adaptive_frame_budget"),
        ("pair_scheduling", "adaptive_pair_scheduling"),
    ):
        current_state = current_policy.get(key) or {}
        enabled_config = dict(config)
        enabled_config[config_key] = True
        disabled_config = dict(config)
        disabled_config[config_key] = False

        enabled_preview = build_upload_policy_preview(enabled_config, media_summary)
        disabled_preview = build_upload_policy_preview(disabled_config, media_summary)
        enabled_state = (enabled_preview.get("adaptive_policy") or {}).get(key) or {}
        disabled_state = (disabled_preview.get("adaptive_policy") or {}).get(key) or {}

        enabled_score = int(enabled_preview.get("confidence", {}).get("score") or 0)
        disabled_score = int(disabled_preview.get("confidence", {}).get("score") or 0)
        current_enabled = bool(current_state.get("enabled"))
        available = bool(
            current_state.get("available")
            or enabled_state.get("available")
            or disabled_state.get("available")
        )
        current_score = enabled_score if current_enabled else disabled_score
        alternative_score = disabled_score if current_enabled else enabled_score

        comparisons.append(
            {
                "key": key,
                "label": current_state.get("label") or enabled_state.get("label") or key,
                "effect": current_state.get("effect")
                or enabled_state.get("effect")
                or "",
                "available": available,
                "current_enabled": current_enabled,
                "recommended_enabled": available and enabled_score >= disabled_score,
                "score_delta_enabled_vs_disabled": enabled_score - disabled_score,
                "current_score": current_score,
                "alternative_score": alternative_score,
                "current_summary": current_state.get("current_summary")
                or enabled_state.get("current_summary")
                or "",
                "alternative_summary": (
                    disabled_state.get("current_summary")
                    if current_enabled
                    else enabled_state.get("current_summary")
                )
                or "",
                "gate": current_state.get("gate")
                or enabled_state.get("gate")
                or disabled_state.get("gate"),
            }
        )

    return comparisons


def get_sequential_matcher_params(
    num_images, quality_mode, orbit_safe_mode=False, orbit_safe_policy=None
):
    if orbit_safe_policy:
        return dict(orbit_safe_policy["matcher_params"])

    if orbit_safe_mode:
        return {
            "SequentialMatching.overlap": "36",
            "SequentialMatching.quadratic_overlap": "1",
            "SequentialMatching.loop_detection": "0",
        }

    if num_images <= 150:
        overlap = (
            "35"
            if quality_mode == "ultra_professional"
            else (
                "30"
                if quality_mode == "professional"
                else (
                    "28"
                    if quality_mode == "hard"
                    else ("25" if quality_mode in ["high", "ultra"] else "20")
                )
            )
        )
        quadratic_overlap = "1"
    elif num_images <= 400:
        overlap = (
            "30"
            if quality_mode == "ultra_professional"
            else (
                "25"
                if quality_mode == "professional"
                else (
                    "22"
                    if quality_mode == "hard"
                    else ("18" if quality_mode in ["high", "ultra"] else "12")
                )
            )
        )
        quadratic_overlap = "1"
    elif num_images <= 1000:
        overlap = (
            "25"
            if quality_mode == "ultra_professional"
            else (
                "20"
                if quality_mode == "professional"
                else (
                    "18"
                    if quality_mode == "hard"
                    else ("15" if quality_mode in ["high", "ultra"] else "12")
                )
            )
        )
        quadratic_overlap = "1"
    else:
        overlap = (
            "18"
            if quality_mode == "ultra_professional"
            else (
                "12"
                if quality_mode == "professional"
                else (
                    "10"
                    if quality_mode == "hard"
                    else ("8" if quality_mode in ["high", "ultra"] else "5")
                )
            )
        )
        quadratic_overlap = "0"

    matcher_params = {
        "SequentialMatching.overlap": overlap,
        "SequentialMatching.quadratic_overlap": quadratic_overlap,
    }

    if quadratic_overlap == "1":
        matcher_params["SequentialMatching.loop_detection"] = "1"

    return matcher_params


def generate_hloc_pairs(pairs_path, image_list, matcher_type, matcher_params):
    matcher_type = normalize_matcher_type(matcher_type) or "exhaustive"

    if matcher_type == "exhaustive":
        from hloc import pairs_from_exhaustive

        pairs_from_exhaustive.main(pairs_path, image_list=image_list)
        return len(image_list) * (len(image_list) - 1) // 2

    if matcher_type == "vocab_tree":
        raise ValueError(
            "hloc pair generation does not support vocab-tree retrieval yet"
        )

    overlap = max(1, int(matcher_params.get("SequentialMatching.overlap", "10")))
    quadratic_overlap = (
        matcher_params.get("SequentialMatching.quadratic_overlap", "0") == "1"
    )
    pair_set = set()

    for index, image_name in enumerate(image_list):
        upper_bound = min(len(image_list), index + overlap + 1)
        for next_index in range(index + 1, upper_bound):
            pair_set.add((image_name, image_list[next_index]))

        if quadratic_overlap:
            step = 2
            while index + step < len(image_list):
                pair_set.add((image_name, image_list[index + step]))
                step *= 2

    ordered_pairs = sorted(pair_set)
    with open(pairs_path, "w") as pair_file:
        pair_file.write(
            "\n".join(f"{first} {second}" for first, second in ordered_pairs)
        )

    return len(ordered_pairs)


def should_prefer_incremental_sfm(config, paths, num_images):
    # Default behaviour: always prefer global SfM (colmap global_mapper / legacy GLOMAP)
    # so the GPU-heavy Global Positioning + batch BA path runs instead of the CPU-bound
    # incremental registration loop. The previous heuristics (robust mode, exhaustive
    # matcher on small sets, ordered video/orbit frames) are preserved as an explicit
    # opt-in via `config['prefer_incremental_sfm'] = True`.
    if normalize_sfm_engine(config.get("sfm_engine", "glomap")) != "glomap":
        return False, None

    if config.get("fast_sfm", False):
        return False, None

    if not config.get("prefer_incremental_sfm", False):
        return False, None

    matcher_type = normalize_matcher_type(config.get("matcher_type"))
    capture_pattern = analyze_capture_pattern(paths, config)
    looks_like_video_orbit = capture_pattern["looks_like_video_orbit"]

    if config.get("quality_mode") == "robust":
        return (
            True,
            "Robust mode prefers incremental COLMAP SfM for better outlier resistance",
        )

    if matcher_type == "exhaustive" and num_images <= 250:
        return (
            True,
            "Exhaustive matching on small/medium datasets is usually more stable with incremental COLMAP SfM",
        )

    if looks_like_video_orbit and num_images <= ORDERED_CAPTURE_POLICY_IMAGE_LIMIT:
        return (
            True,
            "Ordered video/orbit frames are reconstructed more robustly with incremental COLMAP SfM",
        )

    return False, None


def get_colmap_config(
    num_images,
    project_id=None,
    quality_mode="balanced",
    custom_params=None,
    preferred_matcher_type=None,
    orbit_safe_mode=False,
    orbit_safe_policy=None,
):
    """Configure COLMAP parameters based on image count and quality requirements."""

    if project_id:
        append_log_line(
            project_id,
            f"Optimizing COLMAP config for {num_images} images (Quality: {quality_mode})",
        )

    quality_scales = {
        "fast": {"size": 0.6, "features": 0.5, "matches": 0.5, "octaves": -1},
        "balanced": {"size": 1.0, "features": 1.0, "matches": 2.5, "octaves": 0},
        "high": {"size": 1.0, "features": 1.0, "matches": 3.0, "octaves": 0},
        "ultra": {"size": 1.2, "features": 1.2, "matches": 3.5, "octaves": 0},
        "hard": {"size": 1.4, "features": 1.75, "matches": 5.0, "octaves": -1},
        "professional": {"size": 1.5, "features": 1.5, "matches": 4.0, "octaves": 0},
        "ultra_professional": {
            "size": 1.8,
            "features": 1.8,
            "matches": 4.5,
            "octaves": 0,
        },
        "robust": {"size": 1.0, "features": 1.0, "matches": 3.5, "octaves": 0},
        "custom": {"size": 1.0, "features": 1.0, "matches": 3.0, "octaves": 0},
    }

    scale = quality_scales.get(quality_mode, quality_scales["balanced"])

    base_max_image_size = 4160
    base_max_num_features = 32768
    base_octaves = 4

    max_image_size = int(base_max_image_size * scale["size"])
    max_num_features = int(base_max_num_features * scale["features"])

    if custom_params:
        if (
            "max_num_features" in custom_params
            and custom_params["max_num_features"] is not None
        ):
            max_num_features = int(custom_params["max_num_features"])
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom max_num_features: {max_num_features}"
                )
        if (
            "max_image_size" in custom_params
            and custom_params["max_image_size"] is not None
        ):
            max_image_size = int(custom_params["max_image_size"])
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom max_image_size: {max_image_size}"
                )

    first_octave = (
        -1
        if quality_mode in ["high", "ultra", "professional", "ultra_professional"]
        else scale["octaves"]
    )
    num_octaves = base_octaves + (
        1 if quality_mode in ["ultra", "professional", "ultra_professional"] else 0
    )

    base_matches = 45960
    max_num_matches = int(base_matches * scale["matches"])

    if custom_params:
        if (
            "max_num_matches" in custom_params
            and custom_params["max_num_matches"] is not None
        ):
            max_num_matches = int(custom_params["max_num_matches"])
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom max_num_matches: {max_num_matches}"
                )

    max_match_limit = 65536 if quality_mode == "hard" else 45960
    if max_num_matches > max_match_limit:
        if project_id:
            append_log_line(
                project_id,
                f"⚠️ Reducing max_num_matches from {max_num_matches} to {max_match_limit} to prevent GPU memory overflow",
            )
        max_num_matches = max_match_limit

    gpu_total_vram_mb = get_gpu_total_vram_mb()
    gpu_safe_match_limit = estimate_gpu_safe_match_limit(
        total_vram_mb=gpu_total_vram_mb
    )
    if gpu_safe_match_limit and gpu_safe_match_limit < max_num_matches:
        if project_id:
            append_log_line(
                project_id,
                "🧠 VRAM-aware config tuning: "
                f"reducing max_num_matches from {max_num_matches} to {gpu_safe_match_limit} "
                f"based on GPU VRAM ({gpu_total_vram_mb} MiB)",
            )
        max_num_matches = gpu_safe_match_limit

    explicit_matcher_type = normalize_matcher_type(preferred_matcher_type)
    orbit_safe_forced_matcher = False

    if quality_mode == "robust":
        matcher_type = "exhaustive"
        max_num_matches = min(max_num_matches, 45960)
        matcher_params = {}
        if project_id:
            append_log_line(
                project_id,
                "🔧 Using ROBUST mode: Exhaustive matching for maximum coverage",
            )
    elif quality_mode == "hard":
        if num_images <= 250:
            matcher_type = "exhaustive"
            matcher_params = {}
            max_num_matches = min(max_num_matches, 65536)
        else:
            matcher_type = "sequential"
            matcher_params = get_sequential_matcher_params(num_images, quality_mode)
        if project_id:
            append_log_line(
                project_id,
                "🔧 Using HARD mode: aggressive feature coverage with lighter first-pass training",
            )
    elif quality_mode == "ultra" and num_images <= 200:
        matcher_type = "exhaustive"
        max_num_matches = min(max_num_matches, 45960)
        matcher_params = {}
    elif num_images <= 50:
        matcher_type = "exhaustive"
        matcher_params = {}
    elif num_images <= 150:
        matcher_type = "sequential"
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    elif num_images <= 400:
        matcher_type = "sequential"
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    elif num_images <= 1000:
        matcher_type = "sequential"
        matcher_params = get_sequential_matcher_params(num_images, quality_mode)
    else:
        matcher_type = "vocab_tree"
        matcher_params = get_vocab_tree_matcher_params()

    if orbit_safe_mode:
        if explicit_matcher_type == "exhaustive":
            orbit_safe_forced_matcher = True
        matcher_type = "sequential"
        matcher_params = get_sequential_matcher_params(
            num_images,
            quality_mode,
            orbit_safe_mode=True,
            orbit_safe_policy=orbit_safe_policy,
        )
        if project_id:
            if orbit_safe_forced_matcher:
                append_log_line(
                    project_id,
                    "🛡️ Orbit-safe mode overriding exhaustive matcher with local sequential matching to preserve temporal continuity",
                )
            else:
                loop_detection_enabled = (
                    matcher_params.get("SequentialMatching.loop_detection") == "1"
                )
                if loop_detection_enabled:
                    append_log_line(
                        project_id,
                        "🛡️ Orbit-safe mode enabled: using local sequential matching with bridge-recovery loop closure",
                    )
                else:
                    append_log_line(
                        project_id,
                        "🛡️ Orbit-safe mode enabled: using local sequential matching without loop-closure fallback",
                    )
            if orbit_safe_policy:
                append_log_line(
                    project_id,
                    "🛡️ Orbit-safe profile: "
                    f"{orbit_safe_policy['profile_name']} | overlap={matcher_params['SequentialMatching.overlap']} "
                    f"| min_inliers={orbit_safe_policy['mapper_params']['Mapper.abs_pose_min_num_inliers']} "
                    f"| min_ratio={orbit_safe_policy['mapper_params']['Mapper.abs_pose_min_inlier_ratio']}",
                )
    elif explicit_matcher_type:
        matcher_type = explicit_matcher_type
        if matcher_type == "exhaustive":
            matcher_params = {}
            max_num_matches = min(max_num_matches, 45960)
        elif matcher_type == "vocab_tree":
            matcher_params = get_vocab_tree_matcher_params()
        else:
            matcher_params = get_sequential_matcher_params(num_images, quality_mode)

        if project_id:
            append_log_line(
                project_id, f"🔧 Using user-selected matcher override: {matcher_type}"
            )

    quality_mapper_scales = {
        "fast": {"matches": 1.0, "trials": 0.5, "models": 0.5},
        "balanced": {"matches": 0.8, "trials": 1.5, "models": 2.0},
        "high": {"matches": 0.8, "trials": 1.5, "models": 2.0},
        "ultra": {"matches": 0.7, "trials": 2.0, "models": 3.0},
        "hard": {"matches": 0.55, "trials": 2.2, "models": 4.0},
        "professional": {"matches": 0.6, "trials": 2.5, "models": 5.0},
        "ultra_professional": {"matches": 0.5, "trials": 3.0, "models": 7.0},
        "unlimited": {"matches": 0.6, "trials": 2.5, "models": 5.0},
        "robust": {"matches": 0.6, "trials": 2.5, "models": 5.0},
        "custom": {"matches": 0.8, "trials": 1.5, "models": 2.0},
    }

    mapper_scale = quality_mapper_scales.get(
        quality_mode, quality_mapper_scales["balanced"]
    )

    if num_images <= 100:
        base_min_matches = 8
        base_min_model_size = 3
        base_max_models = 50
        base_init_trials = 200
        max_extra_param = 1
    elif num_images <= 300:
        base_min_matches = 20
        base_min_model_size = 15
        base_max_models = 20
        base_init_trials = 150
        max_extra_param = (
            1
            if quality_mode
            in ["high", "ultra", "hard", "professional", "ultra_professional"]
            else 0
        )
    elif num_images <= 1000:
        base_min_matches = 12
        base_min_model_size = 8
        base_max_models = 15
        base_init_trials = 150
        max_extra_param = 1
    else:
        base_min_matches = 30
        base_min_model_size = 25
        base_max_models = 10
        base_init_trials = 100
        max_extra_param = 0

    if (
        custom_params
        and quality_mode == "custom"
        and "sequential_overlap" in custom_params
        and custom_params["sequential_overlap"] is not None
    ):
        if matcher_type == "sequential" and matcher_params:
            matcher_params["SequentialMatching.overlap"] = str(
                custom_params["sequential_overlap"]
            )
            if project_id:
                append_log_line(
                    project_id,
                    f"🔧 Custom sequential_overlap: {custom_params['sequential_overlap']}",
                )

    min_num_matches = max(6, int(base_min_matches * mapper_scale["matches"]))
    min_model_size = base_min_model_size
    max_num_models = int(base_max_models * mapper_scale["models"])
    init_num_trials = int(base_init_trials * mapper_scale["trials"])

    mapper_params = {}

    if orbit_safe_mode:
        min_num_matches = min(
            min_num_matches, (orbit_safe_policy or {}).get("min_num_matches_cap", 12)
        )
        init_num_trials = max(
            init_num_trials, (orbit_safe_policy or {}).get("init_num_trials_floor", 200)
        )
        mapper_params.update(
            (orbit_safe_policy or {}).get(
                "mapper_params",
                {
                    "Mapper.structure_less_registration_fallback": "0",
                    "Mapper.abs_pose_max_error": "12",
                    "Mapper.abs_pose_min_num_inliers": "18",
                    "Mapper.abs_pose_min_inlier_ratio": "0.12",
                    "Mapper.max_reg_trials": "8",
                },
            )
        )

    if custom_params and quality_mode == "custom":
        if (
            "min_num_matches" in custom_params
            and custom_params["min_num_matches"] is not None
        ):
            min_num_matches = custom_params["min_num_matches"]
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom min_num_matches: {min_num_matches}"
                )
        if (
            "max_num_models" in custom_params
            and custom_params["max_num_models"] is not None
        ):
            max_num_models = custom_params["max_num_models"]
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom max_num_models: {max_num_models}"
                )
        if (
            "init_num_trials" in custom_params
            and custom_params["init_num_trials"] is not None
        ):
            init_num_trials = custom_params["init_num_trials"]
            if project_id:
                append_log_line(
                    project_id, f"🔧 Custom init_num_trials: {init_num_trials}"
                )

    sift_params = {}
    if quality_mode == "ultra_professional":
        sift_params.update(
            {
                "peak_threshold": 0.004,
                "edge_threshold": 25,
                "max_num_orientations": 5,
            }
        )
    elif quality_mode == "hard":
        sift_params.update(
            {
                "peak_threshold": 0.005,
                "edge_threshold": 22,
                "max_num_orientations": 4,
            }
        )
    elif quality_mode == "professional":
        sift_params.update(
            {
                "peak_threshold": 0.006,
                "edge_threshold": 20,
                "max_num_orientations": 4,
            }
        )
    elif quality_mode in ["high", "ultra"]:
        sift_params.update(
            {
                "peak_threshold": 0.008 if quality_mode == "ultra" else 0.01,
                "edge_threshold": 15 if quality_mode == "ultra" else 15,
                "max_num_orientations": 3 if quality_mode == "ultra" else 2,
            }
        )
    elif quality_mode == "balanced":
        sift_params.update(
            {
                "peak_threshold": 0.01,
                "edge_threshold": 15,
                "max_num_orientations": 2,
            }
        )
    elif quality_mode == "custom":
        sift_params.update(
            {
                "peak_threshold": (custom_params.get("peak_threshold") or 0.01)
                if custom_params
                else 0.01,
                "edge_threshold": (custom_params.get("edge_threshold") or 15)
                if custom_params
                else 15,
                "max_num_orientations": (custom_params.get("max_num_orientations") or 2)
                if custom_params
                else 2,
            }
        )
        if project_id and custom_params:
            if (
                "peak_threshold" in custom_params
                and custom_params["peak_threshold"] is not None
            ):
                append_log_line(
                    project_id,
                    f"🔧 Custom peak_threshold: {custom_params['peak_threshold']}",
                )
            if (
                "edge_threshold" in custom_params
                and custom_params["edge_threshold"] is not None
            ):
                append_log_line(
                    project_id,
                    f"🔧 Custom edge_threshold: {custom_params['edge_threshold']}",
                )
            if (
                "max_num_orientations" in custom_params
                and custom_params["max_num_orientations"] is not None
            ):
                append_log_line(
                    project_id,
                    f"🔧 Custom max_num_orientations: {custom_params['max_num_orientations']}",
                )

    if project_id and matcher_type == "vocab_tree":
        if matcher_params.get("VocabTreeMatching.vocab_tree_path"):
            append_log_line(project_id, "🌲 Using vocab-tree matching with cached tree")
        else:
            append_log_line(
                project_id,
                "🌲 Using vocab-tree matching; modern COLMAP builds can auto-download/cache the tree if needed",
            )

    return {
        "max_image_size": max_image_size,
        "max_num_features": max_num_features,
        "first_octave": first_octave,
        "num_octaves": num_octaves,
        "sift_params": sift_params,
        "matcher_type": matcher_type,
        "max_num_matches": max_num_matches,
        "matcher_params": matcher_params,
        "min_num_matches": min_num_matches,
        "min_model_size": min_model_size,
        "max_num_models": max_num_models,
        "init_num_trials": init_num_trials,
        "max_extra_param": max_extra_param,
        "mapper_params": mapper_params,
        "quality_mode": quality_mode,
        "total_expected_matches": int(
            num_images * float(matcher_params.get("SequentialMatching.overlap", "10"))
            if matcher_type == "sequential"
            else (
                num_images * 100
                if matcher_type == "vocab_tree"
                else num_images * (num_images - 1) / 2
            )
        ),
        "orbit_safe_mode": orbit_safe_mode,
        "orbit_safe_profile": orbit_safe_policy["profile_name"]
        if orbit_safe_policy
        else None,
        "bridge_risk_score": orbit_safe_policy["bridge_risk_score"]
        if orbit_safe_policy
        else None,
        "capture_pattern": orbit_safe_policy["capture_pattern"]
        if orbit_safe_policy
        else None,
    }


def get_opensplat_config(quality_mode="balanced", num_images=100, custom_params=None):
    """Get OpenSplat training configuration based on quality requirements and dataset size."""

    quality_scales = {
        "fast": {
            "iterations": 500,
            "densify_from": 100,
            "densify_until": 300,
            "densify_grad_threshold": 0.0002,
            "opacity_reset_interval": 3000,
            "prune_opacity": 0.005,
        },
        "balanced": {
            "iterations": 7000,
            "densify_from": 1000,
            "densify_until": 3500,
            "densify_grad_threshold": 0.00015,
            "opacity_reset_interval": 3000,
            "prune_opacity": 0.003,
        },
        "hard": {
            "iterations": 5000,
            "densify_from": 900,
            "densify_until": 3200,
            "densify_grad_threshold": 0.00012,
            "opacity_reset_interval": 2400,
            "prune_opacity": 0.002,
        },
        "high": {
            "iterations": 7000,
            "densify_from": 1000,
            "densify_until": 3500,
            "densify_grad_threshold": 0.00015,
            "opacity_reset_interval": 3000,
            "prune_opacity": 0.003,
        },
        "ultra": {
            "iterations": 15000,
            "densify_from": 2000,
            "densify_until": 7500,
            "densify_grad_threshold": 0.0001,
            "opacity_reset_interval": 2500,
            "prune_opacity": 0.002,
        },
        "professional": {
            "iterations": 30000,
            "densify_from": 3000,
            "densify_until": 15000,
            "densify_grad_threshold": 0.00008,
            "opacity_reset_interval": 2000,
            "prune_opacity": 0.001,
        },
        "ultra_professional": {
            "iterations": 60000,
            "densify_from": 4000,
            "densify_until": 30000,
            "densify_grad_threshold": 0.00005,
            "opacity_reset_interval": 1500,
            "prune_opacity": 0.0005,
        },
        "custom": {
            "iterations": 7000,
            "densify_from": 1000,
            "densify_until": 3500,
            "densify_grad_threshold": 0.00015,
            "opacity_reset_interval": 3000,
            "prune_opacity": 0.003,
        },
    }

    base_config = dict(quality_scales.get(quality_mode, quality_scales["balanced"]))

    if num_images > 500:
        base_config["iterations"] = int(base_config["iterations"] * 1.2)
        base_config["densify_until"] = int(base_config["densify_until"] * 1.2)
    elif num_images < 50:
        base_config["iterations"] = max(1000, int(base_config["iterations"] * 0.8))

    if quality_mode in ["high", "ultra", "hard", "balanced"]:
        base_config.update(
            {
                "learning_rate": 0.0025,
                "position_lr_init": 0.00016,
                "position_lr_final": 0.0000016,
                "feature_lr": 0.0025,
                "opacity_lr": 0.05,
                "scaling_lr": 0.005,
                "rotation_lr": 0.001,
                "percent_dense": 0.1
                if quality_mode == "ultra"
                else (0.05 if quality_mode == "hard" else 0.01),
            }
        )

    if custom_params and quality_mode == "custom":
        if "iterations" in custom_params and custom_params["iterations"] is not None:
            base_config["iterations"] = int(custom_params["iterations"])
        if (
            "densify_grad_threshold" in custom_params
            and custom_params["densify_grad_threshold"] is not None
        ):
            base_config["densify_grad_threshold"] = float(
                custom_params["densify_grad_threshold"]
            )
        if (
            "refine_every" in custom_params
            and custom_params["refine_every"] is not None
        ):
            base_config["refine_every"] = int(custom_params["refine_every"])
        if (
            "warmup_length" in custom_params
            and custom_params["warmup_length"] is not None
        ):
            base_config["warmup_length"] = int(custom_params["warmup_length"])
        if "ssim_weight" in custom_params and custom_params["ssim_weight"] is not None:
            base_config["ssim_weight"] = float(custom_params["ssim_weight"])
        if (
            "learning_rate" in custom_params
            and custom_params["learning_rate"] is not None
        ):
            base_config["learning_rate"] = float(custom_params["learning_rate"])
        if (
            "position_lr_init" in custom_params
            and custom_params["position_lr_init"] is not None
        ):
            base_config["position_lr_init"] = float(custom_params["position_lr_init"])
        if (
            "position_lr_final" in custom_params
            and custom_params["position_lr_final"] is not None
        ):
            base_config["position_lr_final"] = float(custom_params["position_lr_final"])
        if "feature_lr" in custom_params and custom_params["feature_lr"] is not None:
            base_config["feature_lr"] = float(custom_params["feature_lr"])
        if "opacity_lr" in custom_params and custom_params["opacity_lr"] is not None:
            base_config["opacity_lr"] = float(custom_params["opacity_lr"])
        if "scaling_lr" in custom_params and custom_params["scaling_lr"] is not None:
            base_config["scaling_lr"] = float(custom_params["scaling_lr"])
        if "rotation_lr" in custom_params and custom_params["rotation_lr"] is not None:
            base_config["rotation_lr"] = float(custom_params["rotation_lr"])
        if (
            "percent_dense" in custom_params
            and custom_params["percent_dense"] is not None
        ):
            base_config["percent_dense"] = float(custom_params["percent_dense"])

    return base_config


def get_colmap_config_for_pipeline(paths, config, project_id=None):
    """
    Helper to get COLMAP configuration and common setup for pipeline stages.
    Returns (num_images, colmap_config, colmap_exe, has_cuda)
    """
    images_path = paths["images_path"]
    num_images = len(
        [
            f
            for f in os.listdir(images_path)
            if f.lower().endswith((".jpg", ".jpeg", ".png", ".bmp", ".tiff"))
        ]
    )

    quality_mode = config.get("quality_mode", "balanced")

    custom_params = {
        "peak_threshold": config.get("peak_threshold"),
        "edge_threshold": config.get("edge_threshold"),
        "max_num_orientations": config.get("max_num_orientations"),
        "max_num_features": config.get("max_num_features"),
        "max_image_size": config.get("max_image_size"),
        "max_num_matches": config.get("max_num_matches"),
        "sequential_overlap": config.get("sequential_overlap"),
        "min_num_matches": config.get("min_num_matches"),
        "max_num_models": config.get("max_num_models"),
        "init_num_trials": config.get("init_num_trials"),
    }
    custom_params = {
        key: value for key, value in custom_params.items() if value is not None
    }

    orbit_safe_policy = build_orbit_safe_policy(paths, config, num_images)
    orbit_safe_mode = orbit_safe_policy is not None
    orbit_safe_reason = orbit_safe_policy["reason"] if orbit_safe_policy else None
    if project_id and orbit_safe_mode:
        append_log_line(
            project_id,
            f"🛡️ Orbit-safe reconstruction policy enabled: {orbit_safe_reason}",
        )

    colmap_config = get_colmap_config(
        num_images,
        project_id,
        quality_mode,
        custom_params if custom_params else None,
        normalize_matcher_type(config.get("matcher_type")),
        orbit_safe_mode,
        orbit_safe_policy,
    )
    sync_reconstruction_framework(
        project_id, config, colmap_config, phase="config_ready"
    )
    colmap_exe = get_colmap_executable()

    colmap_info = subprocess.run([colmap_exe, "-h"], capture_output=True, text=True)
    has_cuda = "with CUDA" in (colmap_info.stdout or "")

    return num_images, colmap_config, colmap_exe, has_cuda
