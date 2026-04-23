# Ordered Video Evidence And Signoff Baseline

Use this document as the canonical contract for ordered-video evidence review and optional benchmark signoff.

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

## Evidence Sources

Review ordered-video progress from these sources in priority order:

1. runtime evidence and snapshots under `PobimSplatting/runtime/auto_tuning/`
2. project-derived state in `PobimSplatting/Backend/projects_db.json`
3. saved synthetic or manual benchmark reports from `scripts/benchmark_ordered_video_policy.py`

The benchmark sheet is now the signoff layer, not the only learning layer.

## Runtime Evidence Review Template

For each serious implementation round, record at least:

- evidence source used
- run window or date range
- ordered-video project count
- completed, failed, and in-progress counts
- recovery final path distribution
- recovery state distribution
- resource lane distribution
- pair-budget capped project count
- fallback-heavy project count
- unresolved project count
- threshold or behavior notes

Also record whether these files were present:

- stable snapshot
- tuned snapshot
- persisted ordered-video evidence file

## Optional Benchmark Signoff Template

Use this only when validating a release candidate or a risky threshold change.

For each benchmark round, record:

- run label
- dataset profile
- baseline policy result
- adaptive current result
- adaptive candidate result
- threshold notes
- regression notes

## Threshold Notes

- Severity tiers:
- Pair-budget caps:
- Stubborn escalation trigger:
- Broad fallback trigger:
- Lane downgrade trigger:
- Stable-default fallback trigger:

## Promotion Gate

Promote only when:

- runtime evidence shows the adaptive path is stable enough to explain
- unresolved and broad-fallback cases are not rising unexpectedly
- long ordered-video cases show pair-count or runtime savings
- sparse continuity stays acceptable
- project diagnostics clearly explain the chosen repair path
- stable defaults and tuned values are distinguishable

## Commands

Inspect accumulated evidence:

```bash
python3 scripts/report_ordered_video_evidence.py --format markdown
```

Save a synthetic benchmark report:

```bash
python3 scripts/benchmark_ordered_video_policy.py \
  --format markdown \
  --label "ordered-video-round" \
  --output /tmp/ordered_video_policy_benchmark.md \
  --json-output /tmp/ordered_video_policy_benchmark.json
```
