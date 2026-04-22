# Ordered Video Benchmark Baseline

Use this document as the canonical benchmark note sheet for the ordered-video resource-aware pipeline.

## Contract

- Schema version: `2026-04-23-ordered-video-v1`
- Profiles:
  - `short_clean_orbit`
  - `long_redundant_orbit`
  - `mixed_stills_video`
  - `weak_boundary_capture`
- Metric keys:
  - `extracted_image_count`
  - `pair_count`
  - `bridge_p10`
  - `bridge_min`
  - `weak_boundary_ratio`
  - `zero_boundary_ratio`
  - `registered_image_ratio`
  - `extraction_runtime_seconds`
  - `matching_runtime_seconds`
  - `sparse_runtime_seconds`
  - `total_runtime_seconds`

## Run Template

For each benchmark round, record:

- Run label
- Dataset profile
- Baseline policy result
- Adaptive current result
- Adaptive candidate result
- Threshold notes
- Regression notes

## Threshold Notes

- Severity tiers:
- Pair-budget caps:
- Stubborn escalation trigger:
- Broad fallback trigger:

## Promotion Gate

Promote only when:

- long ordered-video cases show pair-count or runtime savings
- sparse continuity stays acceptable
- project diagnostics clearly explain the chosen repair path
