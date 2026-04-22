# Ordered Video Next Steps

This document is the working follow-up guide for the ordered-video resource-aware pipeline.

Use it together with:

- [ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md](ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md) for the full roadmap
- [ORDERED_VIDEO_BENCHMARK_BASELINE.md](ORDERED_VIDEO_BENCHMARK_BASELINE.md) for the benchmark contract and run notes

## Current Status

The repo is no longer at POC-only stage.

Implemented already:

- adaptive frame budget
- progressive pair scheduling
- upload and retry controls for adaptive flags
- project diagnostics for extraction and progressive matching
- benchmark script with saved report support
- weak-window subset rematch
- survivor-only boundary densification
- severity-aware densification
- stubborn-boundary escalation
- pair-targeted stubborn rematch
- per-boundary pair diagnostics
- deterministic recovery summary
- project resource profile and resource lane foundation
- training budget summary propagation

## What Is Still Missing For A Full Rollout

### 1. Phase 2 Signoff Is Not Finished

The recovery loop is much stronger now, but it is not fully closed operationally until real-video evidence exists.

Still needed:

- run 3-5 real ordered-video benchmark sets
- compare `baseline` vs `adaptive current` vs `adaptive candidate`
- tune pair-budget caps from real footage instead of synthetic-only validation
- confirm weak-boundary datasets repair locally more often than they fall back broadly
- record threshold notes for:
  - severity tiers
  - pair-budget caps
  - stubborn escalation trigger
  - broad fallback trigger

### 2. Phase 3 Is Only Foundation-Level

Current state:

- project resource profile exists
- resource lane exists
- admission reason and downgrade reason exist
- heavy-stage wait gate exists

Still needed:

- stronger concurrency policy across more than one active large project
- lane-specific downgrade behavior instead of only visibility and waiting
- better estimated delay calculation from active stage durations
- clearer project-list visibility for queued/downgraded jobs, not only project-detail visibility
- retry semantics that clearly distinguish manual override from automatic downgrade in every stage

### 3. Phase 4 Is Only Partially Wired

Current state:

- training receives budget context
- project diagnostics can show training context

Still needed:

- mesh/export services use `resource_profile` or `capture_budget_summary`
- conservative export path for constrained jobs
- staged or deferred heavy post-processing for large repaired datasets
- review/result surfaces show lifecycle continuity through export, not just reconstruction

### 4. Phase 5 Has Not Started Properly

Still needed:

- stable defaults vs experimental overrides policy
- default-on decision for ordered-video path
- rollback switch documentation
- release checklist
- cleanup of debug-heavy field names that operators no longer need
- operator docs for the final default workflow

## Recommended Execution Order

Follow this order unless a production bug interrupts it.

### Step A: Close Phase 2 With Real Evidence

Do this first.

- collect 3-5 real videos
- fill `ORDERED_VIDEO_BENCHMARK_BASELINE.md`
- tune threshold notes
- verify that local repair wins on weak-boundary cases

Exit gate:

- long ordered-video cases show pair-count or runtime savings
- sparse continuity remains acceptable
- project page clearly explains final repair path

### Step B: Strengthen Phase 3 Resource Orchestration

Do this only after Phase 2 thresholds are credible.

- improve lane selection from active machine load
- add better heavy-stage blocking logic
- refine delay estimates from active projects
- show lane/downgrade reasons in project list and status surfaces

Exit gate:

- two large video projects on one machine do not thrash CPU/GPU as before
- operators can see why a job is waiting or downgraded

### Step C: Complete Phase 4 Downstream Propagation

- wire `resource_profile` into mesh/export services
- introduce conservative export behavior for constrained jobs
- surface repaired-capture context in review/export UI

Exit gate:

- lifecycle diagnostics stay coherent from extraction through training and export

### Step D: Finish Phase 5 Hardening

- decide defaults
- document rollback path
- publish release checklist
- trim debug-only surfaces if they are no longer needed

Exit gate:

- ordered-video path can ship default-on with rollback preserved

## Concrete Work Items By Seam

### Backend Recovery And Matching

Main files:

- `PobimSplatting/Backend/pipeline/recovery_planners.py`
- `PobimSplatting/Backend/pipeline/stage_sparse.py`
- `PobimSplatting/Backend/pipeline/stage_features.py`

Next tasks:

- tune pair-budget caps from real data
- refine fallback trigger conditions
- ensure every failed recovery pass leaves understandable history
- keep recovery precedence stable

### Backend Resource Orchestration

Main files:

- `PobimSplatting/Backend/services/time_estimator.py`
- `PobimSplatting/Backend/core/projects.py`
- `PobimSplatting/Backend/pipeline/runner.py`
- `PobimSplatting/Backend/routes/api.py`

Next tasks:

- improve lane selection from actual active-stage pressure
- strengthen delay estimates
- expose lane state consistently in status and project list APIs

### Downstream Training And Export

Main files:

- `PobimSplatting/Backend/pipeline/stage_training.py`
- `PobimSplatting/Backend/services/mesh_converter.py`
- `PobimSplatting/Backend/services/mvs_mesher.py`

Next tasks:

- carry budget class into export behavior
- add conservative path for constrained or repaired projects
- keep logs and diagnostics aligned with upstream policy

### Frontend Operator Surfaces

Main files:

- `PobimSplatting/Frontend/src/lib/api.ts`
- `PobimSplatting/Frontend/src/app/projects/[id]/page.tsx`
- `PobimSplatting/Frontend/src/app/upload/page.tsx`

Next tasks:

- keep project-detail diagnostics high-signal
- add project-list lane visibility
- reduce debug noise after thresholds stabilize

## Benchmark And Validation Checklist

Run this for each serious round:

- `baseline`
- `adaptive current`
- `adaptive plus candidate change`

Record at least:

- extracted image count
- pair count
- bridge p10
- bridge min
- weak boundary ratio
- zero boundary ratio
- registered image ratio
- extraction runtime
- matching runtime
- sparse runtime
- total runtime

Also record:

- final recovery path
- final reason code
- whether pair budget was capped
- whether broad fallback was used
- whether the result is operator-readable from UI alone

## Practical Next Command

If the next round is implementation, the best next step is:

1. benchmark real videos and fill the baseline note sheet
2. tune Phase 2 thresholds from that evidence
3. then continue Phase 3 orchestration work

Do not widen Phase 3 or Phase 4 aggressively before Phase 2 benchmark signoff is credible.
