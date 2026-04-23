# Ordered Video Next Steps

This document is the working closeout guide for the ordered-video resource-aware pipeline.

Use it together with:

- [ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md](ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md) for the phase map and implementation history
- [ORDERED_VIDEO_BENCHMARK_BASELINE.md](ORDERED_VIDEO_BENCHMARK_BASELINE.md) for the evidence and signoff contract

## Closeout Strategy

The closeout path is now split into two layers:

1. Runtime evidence and self-tuning are the primary learning loop.
2. Benchmarks and manual review are the signoff loop.

This means the team does not need to block all progress on finding 3-5 perfect benchmark videos before the system gets smarter. The system should learn from accumulated real runs, while validation and benchmark notes remain the promotion gate for defaults and release decisions.

## Current Implementation Anchors

Implemented already:

- adaptive frame budget
- progressive pair scheduling
- upload and retry controls for adaptive flags
- project diagnostics for extraction, matching, and recovery
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

## Docs And Validation Track Deliverables

This track owns operator-facing closeout material and lightweight inspection tooling. It does not change backend policy logic directly.

Deliverables in this track:

- keep the rollout docs aligned with the current contract
- define how runtime evidence should be reviewed round by round
- keep benchmark material as signoff guidance, not the only path to confidence
- provide a lightweight operator script to inspect accumulated ordered-video evidence

## What Is Still Missing For A Full Rollout

### 1. Contract And Evidence Need To Become Durable

The contract exists, but the rollout is not complete until the repo consistently emits and reviews these fields:

- `resource_profile`
- `resource_lane`
- `capture_budget_summary`
- `recovery_loop_summary`
- `training_budget_summary`
- future `auto_tuning_summary`

Still needed:

- persistent runtime evidence store under `PobimSplatting/runtime/auto_tuning/`
- stable snapshot and tuned snapshot persistence
- explicit operator visibility for which values are default and which are tuned
- drift checks when payload shape or naming changes

### 2. Phase 2 Is Strong But Not Yet Self-Calibrated

The recovery loop is already much stronger than the original POC, but the remaining work is now about safe self-calibration rather than only adding more passes.

Still needed:

- tuned thresholds for strong geometry and weak-boundary escalation
- tuned pair-budget cap scaling
- automatic fallback to stable defaults if tuned behavior degrades
- consistent `tuned_decision_used` markers in recovery history
- repeated review of unresolved and fallback-heavy cases from accumulated runs

### 3. Phase 3 Needs Machine-Aware Coordination

Current state:

- project resource profile exists
- resource lane exists
- admission reason and downgrade reason exist
- heavy-stage wait gate exists

Still needed:

- resource-lane tuning from recent run history, not only static rules
- clearer delay estimation from actual active-job timings
- stronger downgrade and defer semantics for large concurrent jobs
- operator-facing visibility for lane decisions outside the detail page

### 4. Phase 4 Needs End-To-End Lifecycle Continuity

Current state:

- training receives budget context
- project diagnostics can show training context

Still needed:

- export and mesh services consume the same resource-aware context
- constrained jobs take a conservative export path
- heavy repaired jobs can take staged or delayed heavy post-processing
- review/result surfaces show continuity from extraction through export

### 5. Phase 5 Is Mostly Hardening And Release Work

Still needed:

- stable defaults versus experimental overrides policy
- default-on decision for the ordered-video path
- rollback switch documentation
- release checklist
- final cleanup of debug-only naming or fields that operators no longer need
- final operator workflow docs for the default path

## Recommended Execution Order

Follow this order unless a production bug interrupts it.

### Step A: Build The Runtime Evidence Loop

Do this first.

- persist ordered-video run evidence
- persist stable and tuned snapshot files
- expose clear source metadata for tuned values
- review evidence with the operator helper after each serious round

Exit gate:

- the repo has durable evidence records from real runs
- the team can inspect current defaults, tuned values, and recovery outcomes without reading raw logs first

### Step B: Use Evidence To Close Phase 2

Do this before widening orchestration aggressively.

- review weak-boundary and fallback-heavy runs
- tune escalation thresholds conservatively
- tune pair-budget cap behavior
- confirm stable-default fallback is ready if tuned behavior regresses

Exit gate:

- local repair wins more often without making the state harder to read
- unresolved and broad-fallback cases are explainable from evidence reports

### Step C: Strengthen Phase 3 Resource Orchestration

- use accumulated runtime evidence to refine lane selection
- improve heavy-stage admission and downgrade behavior
- refine start-delay estimates from recent stage timing
- improve operator visibility for deferred and downgraded jobs

Exit gate:

- two large video projects on one machine do not thrash CPU or GPU as before
- operators can tell why a job is waiting or downgraded

### Step D: Complete Phase 4 Downstream Propagation

- wire resource-aware context into mesh and export services
- add conservative and staged downstream paths where appropriate
- surface lifecycle continuity in review and export-facing diagnostics

Exit gate:

- lifecycle diagnostics stay coherent from extraction through training and export

### Step E: Finish Phase 5 Hardening

- decide defaults
- document rollback
- publish release checklist
- reduce debug-heavy surfaces after the policy stabilizes

Exit gate:

- ordered-video path can ship default-on with rollback preserved

## Evidence Sources And Operator Workflow

### Primary Evidence Sources

- `PobimSplatting/Backend/projects_db.json`
- `PobimSplatting/runtime/auto_tuning/ordered_video_evidence.json`
- `PobimSplatting/runtime/auto_tuning/ordered_video_tuned_snapshot.json`
- `PobimSplatting/runtime/auto_tuning/ordered_video_stable_snapshot.json`
- optional benchmark JSON or JSONL outputs from `scripts/benchmark_ordered_video_policy.py`

### Operator Helper

Use the lightweight inspection helper to summarize what the system knows right now:

```bash
python3 scripts/report_ordered_video_evidence.py --format markdown
```

To save a report:

```bash
python3 scripts/report_ordered_video_evidence.py \
  --format markdown \
  --output /tmp/ordered_video_evidence_report.md
```

To combine project-derived evidence with benchmark JSONL notes:

```bash
python3 scripts/report_ordered_video_evidence.py \
  --benchmark-jsonl /path/to/ordered_video_policy_runs.jsonl
```

### Practical Review Loop

Run this loop after each meaningful backend round:

1. Run ordered-video jobs normally.
2. Inspect the evidence report.
3. Check whether unresolved, fallback-heavy, or pair-budget-capped cases are rising.
4. Adjust policy logic in the owning backend seam.
5. Re-run the evidence report and only then decide whether a synthetic or manual benchmark signoff round is needed.

## Team Handoff By Seam

### Docs And Validation Track

Owns:

- this closeout guide
- the benchmark and signoff sheet
- evidence inspection helper
- rollout checklists and operator-facing review instructions

Does not own:

- backend tuning math
- frontend operator pages
- recovery branching logic

### Backend Teams

Need to provide:

- persisted evidence records
- tuned snapshot persistence
- stable snapshot fallback behavior
- lane and recovery summaries that stay contract-compatible

### Frontend Team

Needs to surface:

- stable versus tuned value visibility
- concise project-level summaries for lane, recovery, and downstream context
- override impact messaging without increasing operator noise

## Release Gate

Do not call the ordered-video path finished until all of these are true:

- runtime evidence exists and is readable
- stable and tuned snapshots are distinguishable
- recovery summaries remain deterministic and operator-readable
- resource-lane decisions are explainable
- training and export surfaces preserve upstream context
- rollback instructions exist

## Practical Next Command

If the next round is docs or validation work, the best next step is:

1. run `python3 scripts/report_ordered_video_evidence.py --format markdown`
2. inspect which evidence files are present and which are still missing
3. use that report to drive the next backend or frontend implementation round

Do not treat manual benchmark sheets as the only source of truth anymore. Use them to sign off a release candidate, not to replace the runtime evidence loop.
