#!/usr/bin/env python3
"""Benchmark the ordered-video adaptive policy planners with synthetic cases."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from PobimSplatting.Backend.pipeline.progressive_matching import (  # noqa: E402
    build_progressive_sequential_matching_plan,
    should_continue_progressive_matching,
)
from PobimSplatting.Backend.pipeline.resource_contract import (  # noqa: E402
    ORDERED_VIDEO_BENCHMARK_PROFILES,
    ORDERED_VIDEO_METRIC_KEYS,
    RESOURCE_AWARE_SCHEMA_VERSION,
)
from PobimSplatting.Backend.utils.video_processor import VideoProcessor  # noqa: E402


DEFAULT_CASES: List[Dict[str, Any]] = [
    {
        "name": "short_orbit_clean",
        "sampling": {
            "total_frames": 3600,
            "fps": 30.0,
            "extraction_config": {
                "mode": "fps",
                "target_fps": 2.0,
                "smart_frame_selection": True,
                "adaptive_frame_budget": True,
                "oversample_factor": 10,
                "quality": 100,
            },
            "video_info": {
                "width": 1920,
                "height": 1080,
                "duration": 120.0,
                "bit_rate": 24_000_000,
                "codec_name": "h264",
            },
            "quality_telemetry": {
                "accepted_ratio": 0.95,
                "blur_failure_ratio": 0.04,
                "duplicate_failure_ratio": 0.33,
                "median_sharpness": 88.0,
                "median_blur_threshold": 50.0,
            },
        },
        "matching": {
            "num_images": 180,
            "colmap_cfg": {
                "matcher_type": "sequential",
                "matcher_params": {
                    "SequentialMatching.overlap": "32",
                    "SequentialMatching.quadratic_overlap": "1",
                    "SequentialMatching.loop_detection": "1",
                },
                "max_num_matches": 45960,
                "capture_pattern": {
                    "looks_like_video_orbit": True,
                    "ordered_frame_ratio": 1.0,
                },
            },
            "gpu_total_vram_mb": 12288,
            "peak_feature_count": 12000,
            "geometry_after_pass": {
                "image_count": 180,
                "weak_boundary_ratio": 0.01,
                "weak_boundary_count": 1,
                "zero_boundary_count": 0,
                "bridge_p10": 30.0,
                "bridge_min": 18.0,
            },
            "verified_pairs": 900,
        },
    },
    {
        "name": "long_4k_hevc_difficult",
        "sampling": {
            "total_frames": 21600,
            "fps": 60.0,
            "extraction_config": {
                "mode": "fps",
                "target_fps": 2.0,
                "smart_frame_selection": True,
                "adaptive_frame_budget": True,
                "oversample_factor": 10,
                "quality": 100,
            },
            "video_info": {
                "width": 3840,
                "height": 2160,
                "duration": 360.0,
                "bit_rate": 110_000_000,
                "codec_name": "hevc",
            },
            "quality_telemetry": {
                "accepted_ratio": 0.43,
                "blur_failure_ratio": 0.39,
                "duplicate_failure_ratio": 0.08,
                "median_sharpness": 41.0,
                "median_blur_threshold": 30.0,
            },
        },
        "matching": {
            "num_images": 320,
            "colmap_cfg": {
                "matcher_type": "sequential",
                "matcher_params": {
                    "SequentialMatching.overlap": "36",
                    "SequentialMatching.quadratic_overlap": "1",
                    "SequentialMatching.loop_detection": "1",
                },
                "max_num_matches": 45960,
                "capture_pattern": {
                    "looks_like_video_orbit": True,
                    "ordered_frame_ratio": 1.0,
                },
            },
            "gpu_total_vram_mb": 8192,
            "peak_feature_count": 19000,
            "geometry_after_pass": {
                "image_count": 320,
                "weak_boundary_ratio": 0.08,
                "weak_boundary_count": 20,
                "zero_boundary_count": 2,
                "bridge_p10": 16.0,
                "bridge_min": 8.0,
            },
            "verified_pairs": 700,
        },
    },
]


def _load_cases(path: str | None) -> List[Dict[str, Any]]:
    if not path:
        return DEFAULT_CASES
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return list(payload.get("cases") or [])
    return list(payload or [])


def _run_sampling_case(processor: VideoProcessor, case: Dict[str, Any]) -> Dict[str, Any]:
    sampling = case["sampling"]
    plan = processor._build_sampling_plan(
        total_frames=int(sampling["total_frames"]),
        fps=float(sampling["fps"]),
        extraction_config=dict(sampling["extraction_config"]),
        video_info=dict(sampling.get("video_info") or {}),
        quality_telemetry=dict(sampling.get("quality_telemetry") or {}),
    )
    budget = plan.get("adaptive_frame_budget") or {}
    return {
        "target_output_count": plan["target_output_count"],
        "candidate_count": plan["candidate_count"],
        "requested_oversample_factor": plan.get("requested_oversample_factor"),
        "effective_oversample_factor": plan.get("oversample_factor"),
        "candidate_density_ratio": plan.get("candidate_density_ratio"),
        "adaptive_adjustments": budget.get("adjustments") or [],
    }


def _run_matching_case(case: Dict[str, Any]) -> Dict[str, Any]:
    matching = case["matching"]
    plan = build_progressive_sequential_matching_plan(
        int(matching["num_images"]),
        dict(matching["colmap_cfg"]),
        gpu_total_vram_mb=matching.get("gpu_total_vram_mb"),
        peak_feature_count=matching.get("peak_feature_count"),
    )
    if not plan:
        return {"plan": None, "continue_decision": None}

    next_pass = plan["passes"][1] if len(plan["passes"]) > 1 else None
    continue_decision = None
    if next_pass:
        continue_decision = should_continue_progressive_matching(
            next_pass,
            dict(matching.get("geometry_after_pass") or {}),
            verified_pairs=int(matching.get("verified_pairs") or 0),
        )
    return {
        "plan": {
            "resource_tier": plan.get("resource_tier"),
            "reason": plan.get("reason"),
            "final_overlap": plan.get("final_overlap"),
            "passes": [
                {
                    "key": item.get("key"),
                    "label": item.get("label"),
                    "overlap": item.get("matcher_params", {}).get(
                        "SequentialMatching.overlap"
                    ),
                    "loop_detection": item.get("matcher_params", {}).get(
                        "SequentialMatching.loop_detection"
                    ),
                    "max_num_matches": item.get("max_num_matches"),
                }
                for item in plan.get("passes") or []
            ],
        },
        "continue_decision": continue_decision,
    }


def _render_markdown(results: List[Dict[str, Any]]) -> str:
    return _render_markdown_report(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "case_count": len(results),
            "cases_source": "inline",
            "cases": results,
        }
    )


def _render_markdown_report(report: Dict[str, Any]) -> str:
    results = list(report.get("cases") or [])
    lines = [
        "# Ordered Video Policy Benchmark",
        "",
        f"- Schema: {report.get('schema_version', '--')}",
        f"- Generated: {report.get('generated_at', '--')}",
        f"- Cases: {report.get('case_count', len(results))}",
        f"- Cases source: {report.get('cases_source', 'inline')}",
    ]

    if report.get("label"):
        lines.append(f"- Label: {report['label']}")
    if report.get("notes"):
        lines.append(f"- Notes: {report['notes']}")

    lines.extend(
        [
            "",
        "| Case | Target | Candidates | Oversample req->eff | Density | Matching passes | Next-step decision |",
        "|------|------:|------:|------|------:|------|------|",
        ]
    )
    for result in results:
        sampling = result["sampling"]
        matching = result["matching"]
        plan = matching.get("plan") or {}
        passes = ", ".join(item["key"] for item in plan.get("passes") or []) or "--"
        continue_decision = matching.get("continue_decision")
        decision_text = continue_decision[1] if continue_decision else "--"
        lines.append(
            "| {name} | {target} | {candidates} | {req}x -> {eff}x | {density}x | {passes} | {decision} |".format(
                name=result["name"],
                target=sampling.get("target_output_count", "--"),
                candidates=sampling.get("candidate_count", "--"),
                req=sampling.get("requested_oversample_factor", "--"),
                eff=sampling.get("effective_oversample_factor", "--"),
                density=sampling.get("candidate_density_ratio", "--"),
                passes=passes,
                decision=decision_text.replace("|", "/"),
            )
        )

    lines.append("")
    lines.append("## Benchmark Contract")
    lines.append("")
    lines.append("### Required Profiles")
    lines.append("")
    for profile in report.get("benchmark_profiles") or []:
        lines.append(
            f"- `{profile.get('id', '--')}`: {profile.get('label', '--')} - {profile.get('description', '--')}"
        )
    lines.append("")
    lines.append("### Metric Keys")
    lines.append("")
    for key in report.get("metric_keys") or []:
        lines.append(f"- `{key}`")
    lines.append("")
    lines.append("## Case Notes")
    lines.append("")

    for result in results:
        sampling = result["sampling"]
        matching = result["matching"]
        plan = matching.get("plan") or {}
        adjustments = sampling.get("adaptive_adjustments") or []
        continue_decision = matching.get("continue_decision")
        lines.append(f"### {result['name']}")
        lines.append(
            "- Sampling: target={target}, candidates={candidates}, oversample={req}x->{eff}x, density={density}x".format(
                target=sampling.get("target_output_count", "--"),
                candidates=sampling.get("candidate_count", "--"),
                req=sampling.get("requested_oversample_factor", "--"),
                eff=sampling.get("effective_oversample_factor", "--"),
                density=sampling.get("candidate_density_ratio", "--"),
            )
        )
        if adjustments:
            lines.append(
                "- Adaptive adjustments: " + "; ".join(str(item) for item in adjustments)
            )
        else:
            lines.append("- Adaptive adjustments: none")
        if plan:
            lines.append(
                "- Matching: resource_tier={tier}, final_overlap={overlap}, passes={passes}".format(
                    tier=plan.get("resource_tier", "--"),
                    overlap=plan.get("final_overlap", "--"),
                    passes=", ".join(
                        f"{item.get('key')}[{item.get('overlap')}]"
                        for item in plan.get("passes") or []
                    )
                    or "--",
                )
            )
        else:
            lines.append("- Matching: no progressive plan generated")
        if continue_decision:
            lines.append(
                f"- Next-step decision: {continue_decision[0]} ({continue_decision[1]})"
            )
        else:
            lines.append("- Next-step decision: --")
        lines.append("")
    return "\n".join(lines)


def _build_report(
    results: List[Dict[str, Any]], *, cases_source: str, label: str | None, notes: str | None
) -> Dict[str, Any]:
    return {
        "schema_version": RESOURCE_AWARE_SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "label": label,
        "notes": notes,
        "case_count": len(results),
        "cases_source": cases_source,
        "benchmark_profiles": list(ORDERED_VIDEO_BENCHMARK_PROFILES),
        "metric_keys": list(ORDERED_VIDEO_METRIC_KEYS),
        "cases": results,
    }


def _write_text(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def _append_jsonl(path: str, payload: Dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark the ordered-video adaptive frame budget and progressive matching planners."
    )
    parser.add_argument(
        "--cases",
        help="Path to a JSON file containing benchmark cases. Defaults to built-in synthetic cases.",
    )
    parser.add_argument(
        "--format",
        choices=("json", "markdown"),
        default="markdown",
        help="Output format.",
    )
    parser.add_argument(
        "--label",
        help="Optional benchmark run label for saved reports.",
    )
    parser.add_argument(
        "--notes",
        help="Optional operator notes stored in markdown/json outputs.",
    )
    parser.add_argument(
        "--output",
        help="Optional file path for the primary rendered output (`--format`).",
    )
    parser.add_argument(
        "--json-output",
        help="Optional file path for a canonical JSON report snapshot.",
    )
    parser.add_argument(
        "--append-jsonl",
        help="Optional JSONL path to append one report object per benchmark run.",
    )
    args = parser.parse_args()

    processor = VideoProcessor()
    results = []
    cases = _load_cases(args.cases)
    for case in cases:
        results.append(
            {
                "name": case.get("name", "case"),
                "sampling": _run_sampling_case(processor, case),
                "matching": _run_matching_case(case),
            }
        )

    report = _build_report(
        results,
        cases_source=args.cases or "built-in synthetic cases",
        label=args.label,
        notes=args.notes,
    )

    if args.format == "json":
        rendered = json.dumps(report, indent=2)
    else:
        rendered = _render_markdown_report(report)

    print(rendered)

    if args.output:
        _write_text(args.output, rendered)
    if args.json_output:
        _write_text(args.json_output, json.dumps(report, indent=2))
    if args.append_jsonl:
        _append_jsonl(args.append_jsonl, report)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
