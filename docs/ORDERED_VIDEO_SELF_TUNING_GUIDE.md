# Ordered Video Self-Tuning Guide

This guide explains how the ordered-video resource-aware pipeline is supposed to work after the self-tuning substrate was added.

Use it when you need to answer questions like:

- What does the system learn from real ordered-video runs?
- Which decisions are still stable defaults and which ones can be tuned?
- How should operators read the project page and upload preview?
- How should developers extend the policy without breaking the contract?

Use it together with:

- [ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md](ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md) for the phase history
- [ORDERED_VIDEO_NEXT_STEPS.md](ORDERED_VIDEO_NEXT_STEPS.md) for remaining work
- [ORDERED_VIDEO_BENCHMARK_BASELINE.md](ORDERED_VIDEO_BENCHMARK_BASELINE.md) for signoff expectations

## Core Idea

The ordered-video path now has two loops:

1. Runtime learning loop
   The backend records evidence from real project runs and derives a conservative tuned snapshot.
2. Signoff loop
   Operators still review evidence reports and optional benchmark notes before changing defaults or release behavior.

This means the system can get smarter from accumulated real work without waiting for a perfectly curated benchmark pack first.

## What The System Tunes

The active policy can influence these surfaces:

### 1. Extraction

- adaptive frame budget scale
- effective oversample pressure for redundant or difficult video

### 2. Matching

- progressive matching thresholds for strong and stable geometry
- whether later matching passes are still justified

### 3. Recovery

- weak-boundary escalation sensitivity
- targeted pair-budget cap scale
- broad fallback trigger sensitivity

### 4. Orchestration

- heavy-stage wait delay scaling
- resource-profile thresholds used to choose lanes

### 5. Training And Downstream Handoff

- training receives capture and recovery context
- export and mesh surfaces should remain aware of the active resource context

## What Is Not Allowed To Drift Freely

Self-tuning is intentionally bounded.

The system is not allowed to:

- overwrite stable defaults with unbounded values
- bypass guardrails silently
- skip the stable fallback when tuned behavior regresses
- change payload naming ad hoc

Stable defaults remain the source of truth when:

- evidence is sparse
- recent tuned runs regress
- the tuned snapshot confidence is still too low

## Runtime Files

The self-tuning substrate uses these runtime files:

- `PobimSplatting/runtime/auto_tuning/ordered_video_evidence.json`
- `PobimSplatting/runtime/auto_tuning/ordered_video_stable_snapshot.json`
- `PobimSplatting/runtime/auto_tuning/ordered_video_tuned_snapshot.json`

These files represent:

- evidence store: what the system observed from recent runs
- stable snapshot: bounded default policy
- tuned snapshot: derived policy candidate from evidence

## Mental Model For Operators

When reading the UI, think in this order:

### Upload Preview

The upload page answers:

- does this input look like ordered video?
- will adaptive frame budget be useful?
- will progressive pair scheduling be active?
- is the active policy currently stable or tuned?

The preview is not a final promise of exact runtime behavior, but it should be directionally aligned with the backend policy.

### Project List

The project list answers:

- which jobs are waiting for heavy slots
- which jobs are downgraded
- which jobs are using tuned policy versus stable defaults

This page should be enough to spot queue pressure before opening each project.

### Project Detail

The project page answers:

- which resource lane the job used
- what progressive matching plan was selected
- what recovery path happened in practice
- whether tuned decisions were used on specific repair steps
- what training context was inherited from upstream capture and recovery

## Mental Model For Developers

When extending the policy, keep this order:

1. Stable defaults define the safe baseline.
2. Evidence store records what happened.
3. Tuned snapshot derives bounded adjustments.
4. Runtime code consumes only the active snapshot.
5. UI and scripts explain the same decision story.

Do not jump straight to changing frontend language or docs before the backend contract is real.

## Minimum Contract

These fields are the core resource-aware contract:

- `resource_profile`
- `resource_lane`
- `capture_budget_summary`
- `recovery_loop_summary`
- `training_budget_summary`
- `auto_tuning_summary`

The contract should remain visible in:

- logs
- project detail API payload
- project list API payload where relevant
- upload policy preview
- evidence report tooling

## How The Evidence Loop Works

For ordered-video or mixed ordered capture, the backend records at least:

- input profile
- effective frame budget
- progressive matching checkpoints
- recovery path
- pair-budget cap usage
- bridge and weak-boundary metrics
- registered image ratio
- stage runtimes
- final status

Then the tuned snapshot is rebuilt conservatively from recent evidence.

The current implementation is designed to prefer:

- protect quality when fallback rate or unresolved rate rises
- save runtime when geometry remains healthy and matching cost stays high
- stay balanced otherwise

## Stable Versus Tuned

Read the active mode like this:

- `stable`
  The system is using safe defaults because evidence is still insufficient or tuned behavior was not trusted.
- `tuned`
  The system has enough recent evidence to apply bounded adjustments.
- `fallback_to_stable`
  The system observed recent tuned regressions and temporarily reactivated stable defaults.

This is the intended safe behavior. Falling back to stable is not itself a failure.

## Recovery Ladder

The intended deterministic recovery order is:

1. progressive pair scheduling
2. weak-window subset rematch
3. survivor-only boundary densification
4. stubborn-boundary subset rematch
5. pair-targeted stubborn rematch
6. broad fallback only when still necessary

The important rule is local repair first.

The system should not jump to full broad fallback when the failure is only around a narrow boundary window.

## What To Review After A Run

Review these signals first:

- `resource_lane`
- `resource_lane_state`
- `auto_tuning_summary.active_mode`
- `recovery_loop_summary.final_path`
- `recovery_loop_summary.state`
- `pair_geometry_stats.bridge_p10`
- `pair_geometry_stats.bridge_min`
- `pair_geometry_stats.weak_boundary_ratio`
- `pair_budget_capped`
- `training_budget_summary.uses_repaired_capture`

Quick interpretation:

- good sign: local repair count increased but broad fallback stayed low
- warning sign: pair-budget capped cases rise while weak boundaries stay unresolved
- warning sign: tuned mode is active but registered image ratio drops repeatedly
- safe fallback sign: tuned mode regressed and stable fallback was activated

## Operator Workflow

Use this loop:

1. Upload or retry normally.
2. Check upload preview to see expected policy direction.
3. Watch project list for lane pressure and tuned/stable status.
4. Open project detail if the run waits, downgrades, falls back, or repairs heavily.
5. Review the evidence report if several runs show the same pattern.

Generate the current report with:

```bash
python3 scripts/report_ordered_video_evidence.py --format markdown
```

Save it if needed:

```bash
python3 scripts/report_ordered_video_evidence.py \
  --format markdown \
  --output /tmp/ordered_video_evidence_report.md
```

## Developer Workflow

When changing policy logic:

1. change the owning seam only
2. keep stable defaults bounded
3. update the derived snapshot logic if the new rule should be tunable
4. keep `auto_tuning_summary` readable
5. validate compile and UI contract
6. inspect the evidence report again

Good seam ownership:

- extraction budget: `video_processor.py`
- tuned snapshot derivation: `auto_tuning.py`
- recovery logic: `recovery_planners.py`
- orchestration: `time_estimator.py` and `runner.py`
- framework payload contract: `orbit_policy.py`
- upload preview and list/detail surfaces: frontend pages and `api.ts`

## Troubleshooting

### The UI shows stable forever

Check:

- whether ordered-video evidence is actually being written
- whether recent runs were successful enough to cross the minimum tuning threshold
- whether tuned fallback was activated because recent tuned runs regressed

### Recovery feels too aggressive

Check:

- weak-boundary trigger ratios
- pair-budget scale
- whether recent evidence is pushing the geometry bias toward protect-quality

### Recovery feels too weak

Check:

- unresolved rate in recent evidence
- fallback rate
- whether pair-budget caps are preventing useful targeted rematch expansion

### Project list shows little lane information

Check:

- whether `resource_coordination` is being populated during the active stage
- whether project list API is returning framework and coordination summaries

## Practical Guardrails

Keep these rules:

- do not widen tuned ranges casually
- do not hide fallback-to-stable behavior
- do not invent new payload names when existing ones can be extended
- do not make upload preview promise behavior the backend cannot actually execute
- do not let UI wording outrun backend contract reality

## Current Status

At the current stage of implementation:

- self-tuning substrate exists
- evidence and snapshot paths are defined
- extraction, matching, recovery, orchestration, and training consume resource-aware context
- project list, upload preview, and project detail can surface tuned versus stable behavior
- docs and evidence reporting helper are in place

Still incomplete for full ship-ready rollout:

- runtime evidence needs to accumulate from real jobs
- export and mesh services still need deeper resource-aware behavior
- final default-on decision and rollback docs still belong to release hardening

## Recommended Next Action

If you want to continue from the current state, do this next:

1. run real ordered-video jobs
2. inspect the evidence report
3. confirm tuned snapshot confidence rises only when recent runs stay healthy
4. review fallback-to-stable behavior if regressions appear
5. then continue hardening export/downstream behavior and release docs
