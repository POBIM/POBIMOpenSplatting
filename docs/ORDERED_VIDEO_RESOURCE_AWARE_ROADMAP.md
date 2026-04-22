# Ordered-Video Resource-Aware Roadmap

## Purpose

This document is the execution spec for turning the current ordered-video pipeline into a resource-aware, progressively scheduled workflow across extraction, matching, sparse reconstruction, and later downstream stages.

It is written against the current repo seams, not an abstract system:

- Video extraction and smart frame selection already live in `PobimSplatting/Backend/utils/video_processor.py` and `PobimSplatting/Backend/pipeline/runner.py`.
- Ordered-capture policy and pair-geometry recovery already live in `PobimSplatting/Backend/pipeline/orbit_policy.py`, `config_builders.py`, and `recovery_planners.py`.
- Upload/project surfaces already expose capture-pattern and extraction diagnostics through `PobimSplatting/Frontend/src/lib/api.ts`, `src/app/upload/page.tsx`, and `src/app/projects/[id]/page.tsx`.

The immediate priority is **Phase 1 POC: adaptive frame budget + progressive pair scheduling**. Later phases are included so multiple workers can execute in parallel without inventing the rest of the plan later.

## Outcome Targets

The roadmap should improve ordered video and orbit captures along four axes:

| Axis | Target |
|------|------|
| Runtime | Reduce avoidable extraction and matching work on long ordered videos |
| Memory/GPU safety | Keep jobs within predictable CPU, RAM, VRAM, and database-growth envelopes |
| Reconstruction quality | Preserve or improve sparse registration rate and bridge strength across temporal boundaries |
| Operability | Make the policy visible in backend logs, API payloads, and frontend project diagnostics |

## Current State Anchors

The roadmap should reuse, not replace, the current behavior:

- `runner.py` already emits extraction-stage progress, smart-frame logs, and `video_extraction_diagnostics`.
- `video_processor.py` already supports oversampling, scoring, target selection, GPU decode checks, and exact-frame rematerialization.
- `orbit_policy.py` already detects ordered capture via `ordered_frame_ratio`, `looks_like_video_orbit`, and `bridge_risk_score`.
- `recovery_planners.py` already computes `pair_geometry_stats`, weak boundaries, subset recovery, and boundary densification plans.
- The frontend already renders project-level diagnostics for extraction and orbit-safe reconstruction.

This means the roadmap should add policy control, budgeting, and progressive scheduling around the existing pipeline rather than introducing a parallel implementation path.

## Guiding Rules

1. Phase 1 must stay inside the current Flask thread-based runner model. Do not introduce a queue system or distributed scheduler.
2. Resource-aware behavior must be explainable in logs and API payloads. Silent heuristics are not sufficient.
3. Ordered-video policy must remain restart-safe. Retry from `video_extraction`, `feature_matching`, or `sparse_reconstruction` must preserve enough manifest/diagnostic data to understand what happened.
4. Budgeting decisions should reuse current telemetry names where possible instead of inventing incompatible parallel schemas.
5. Team execution should minimize file collisions. One worker should own one seam per round whenever possible.

## Phase Map

| Phase | Name | Main objective | Primary files |
|------|------|------|------|
| 1 | Adaptive frame budget + progressive pair scheduling POC | Prove that long ordered-video jobs can scale down extraction and matching cost before sparse reconstruction quality degrades | `utils/video_processor.py`, `pipeline/runner.py`, `pipeline/config_builders.py`, `pipeline/orbit_policy.py`, `pipeline/recovery_planners.py`, frontend project/upload surfaces |
| 2 | Recovery-aware refinement loop | Turn pair-geometry feedback into deterministic schedule upgrades and narrow retries | `recovery_planners.py`, `frame_manifest.py`, `stage_features.py`, `stage_sparse.py` |
| 3 | Project-level resource orchestration | Add admission control, concurrency caps, and resource-budget selection per job | `core/projects.py`, `services/time_estimator.py`, `routes/api.py`, frontend status surfaces |
| 4 | Downstream budget propagation | Carry ordered-video budget decisions into training and mesh/export stages | `stage_training.py`, mesh/export services, project diagnostics UI |
| 5 | Rollout hardening and auto-tuning | Convert heuristics into stable defaults with dataset-backed thresholds | docs, validation scripts, runtime config, operator surfaces |

## Phase 1 POC

### Scope

Phase 1 proves two linked ideas:

1. **Adaptive frame budget**: choose a target extracted-frame count based on source duration, fps, image resolution, worker availability, and ordered-video risk indicators.
2. **Progressive pair scheduling**: start matching with a smaller local sequential window, then widen only when the measured bridge geometry says the current schedule is too weak.

This phase should not attempt full automatic sparse re-planning, distributed resource management, or downstream training changes.

### Why Phase 1 Fits This Repo

The repo already has the ingredients for this POC:

- Extraction-side candidate selection and frame manifests already exist.
- Ordered-capture detection already exists.
- Pair-geometry analysis already exists after feature matching.
- Sequential overlap is already configurable and already exposed in upload and retry UI.

The missing piece is a single policy that ties these together with explicit budgets and checkpointed escalation.

### Phase 1 Deliverables

| Deliverable | Description | Owner seam |
|------|------|------|
| Frame-budget policy | Deterministic policy object for `video_extraction` that explains target frame count, clamp reason, worker budget, and expected cost | Backend extraction/pipeline |
| Progressive pair schedule | Ordered list of matching passes such as `local -> balanced -> bridge-recovery` with entry criteria and exit criteria | Backend matching/recovery |
| Diagnostics contract | Persist the chosen frame budget and pair schedule into project status/config for UI and retry visibility | Backend API + frontend types |
| Operator visibility | Show the active budget/schedule and why escalation happened | Frontend project page |
| Validation pack | Repo-local test/benchmark recipe for short orbit, long orbit, mixed capture, and weak-boundary cases | Validation/docs |

### Phase 1 Proposed Behavior

#### A. Adaptive frame budget

For ordered-video or `looks_like_video_orbit` projects:

1. Compute an initial budget from source duration and target motion coverage.
2. Clamp that budget with resource-aware rules:
   - lower cap when source resolution is high and decode/save cost is high,
   - lower cap when `ffmpeg_cpu_workers` is small,
   - lower cap when GPU decode is unavailable,
   - higher floor when `ordered_frame_ratio` is high and orbit-safe risk is high,
   - higher floor when later sequential overlap will be intentionally narrow in the first pass.
3. Persist both `requested_targets` and new policy-side fields such as:
   - `frame_budget_target`
   - `frame_budget_floor`
   - `frame_budget_cap`
   - `frame_budget_reason`
   - `decode_mode`
   - `worker_budget`
   - `estimated_source_duration_seconds`

Recommended first POC policy bands:

| Capture size | Initial POC target |
|------|------|
| Short ordered clip | `max(36, duration_seconds * 1.5)` capped near 96 |
| Medium ordered clip | cap near 144 |
| Long ordered clip | cap near 180 unless risk score forces higher |
| Mixed capture | keep manual/upload request dominant; apply a softer cap |

These are starting bands only. The acceptance gate is measurement, not the exact constants.

#### B. Progressive pair scheduling

For ordered-video/orbit-safe flows:

1. Start feature matching with a conservative local sequential schedule:
   - lower initial overlap than current full orbit-safe recovery settings,
   - keep loop detection off at first,
   - keep the schedule cheap enough to fail fast.
2. After initial feature matching, inspect `pair_geometry_stats`.
3. Escalate only if checkpoints fail:
   - if `bridge_p10`, `bridge_min`, or `weak_boundary_ratio` are under threshold, widen overlap,
   - if still weak, trigger the existing bridge-recovery pass,
   - if still split, defer to Phase 2 recovery workflows such as subset re-match or boundary densification.

Phase 1 should treat escalation as a short, deterministic ladder:

| Step | Schedule intent | Example policy |
|------|------|------|
| Step 1 | Local baseline | lower sequential overlap, cheapest pass |
| Step 2 | Balanced bridge pass | moderate overlap, quadratic local bridge support |
| Step 3 | Bridge recovery pass | reuse existing strongest orbit-safe recovery settings |

### Phase 1 File-Level Execution Plan

#### Workstream A: Extraction budget policy

Primary files:

- `PobimSplatting/Backend/utils/video_processor.py`
- `PobimSplatting/Backend/pipeline/runner.py`
- `PobimSplatting/Backend/routes/api.py`

Tasks:

1. Introduce a budget resolver near extraction config assembly, not deep inside route parsing.
2. Keep raw extraction mechanics in `video_processor.py`; keep project-level policy selection in `runner.py` or a small helper beside pipeline policy code.
3. Extend extraction diagnostics so the chosen budget survives completion and retry.
4. Keep frame-manifest compatibility intact for later densification/rebuild work.

Checkpoint exit criteria:

- Project logs clearly show budget selection and clamp reasons.
- `video_extraction_diagnostics` exposes budget fields for the frontend.
- Retry from `video_extraction` preserves or recomputes the same policy deterministically.

#### Workstream B: Progressive pair scheduling

Primary files:

- `PobimSplatting/Backend/pipeline/config_builders.py`
- `PobimSplatting/Backend/pipeline/orbit_policy.py`
- `PobimSplatting/Backend/pipeline/recovery_planners.py`
- `PobimSplatting/Backend/pipeline/stage_features.py`

Tasks:

1. Encode a multi-step schedule instead of a single orbit-safe overlap decision.
2. Keep schedule generation in policy/config layers, not hardcoded deep in stage functions.
3. Reuse `pair_geometry_stats` and weak-boundary analysis as the escalation trigger.
4. Log each escalation with explicit reason and before/after overlap.

Checkpoint exit criteria:

- First pass uses the cheap schedule for ordered-video captures.
- The second and third passes only run when geometry thresholds fail.
- Final project diagnostics include which schedule step succeeded.

#### Workstream C: Frontend visibility

Primary files:

- `PobimSplatting/Frontend/src/lib/api.ts`
- `PobimSplatting/Frontend/src/app/upload/page.tsx`
- `PobimSplatting/Frontend/src/app/projects/[id]/page.tsx`

Tasks:

1. Extend TypeScript types for budget and progressive schedule diagnostics.
2. Show policy summary on the project page before digging into logs.
3. Keep the upload page lightweight: expose policy preview only if it helps the operator understand automatic choices.

Checkpoint exit criteria:

- The project page shows the chosen frame budget and pair-schedule outcome.
- Retry UI can explain when a manual sequential-overlap override is bypassing the adaptive policy.

### Phase 1 Rounds And Checkpoints

| Round | Goal | Owners | Dependencies | Exit gate |
|------|------|------|------|------|
| 1A | Define budget schema and scheduling schema | Backend policy owner + frontend API owner | none | agreed payload keys and log language |
| 1B | Implement extraction-side adaptive frame budget | Backend extraction owner | 1A | budget fields persisted and visible in logs |
| 1C | Implement progressive pair schedule ladder | Backend matching owner | 1A | cheap-first schedule runs and can escalate |
| 1D | Surface diagnostics in project page | Frontend owner | 1B, 1C | UI shows active budget, schedule, and escalation reason |
| 1E | Dataset validation and threshold adjustment | Validation owner | 1B, 1C, 1D | measured thresholds recorded and acceptance call made |

### Phase 1 Acceptance Metrics

Measure the POC with the same categories on every validation set:

| Metric | Why it matters | Existing seam |
|------|------|------|
| Total extracted frames | Confirms budget actually changes work | `video_extraction_diagnostics` |
| Candidate count / rejected count | Shows extraction search pressure | `video_extraction_diagnostics` |
| Feature matching duration | Primary runtime win target | stage timing/logs |
| Database size / pair count | Proxy for memory and matching cost | COLMAP DB and logs |
| `bridge_p10` / `bridge_min` | Ordered-video continuity health | `pair_geometry_stats` |
| Weak boundary ratio | Trigger for schedule escalation | `pair_geometry_stats` |
| Registered image ratio / model count | Sparse reconstruction outcome | sparse summary |
| End-to-end runtime | Final operator-visible win | project timing/logs |

Phase 1 success should require both:

- at least one meaningful cost reduction on long ordered-video cases, and
- no material regression in registered-image ratio or final usable sparse model rate.

## Phase 2: Recovery-Aware Refinement Loop

### Objective

Convert Phase 1’s deterministic ladder into a stronger recovery loop for cases that still fragment after progressive scheduling.

### Scope

- Use `weak_boundaries` to trigger targeted subset matching before global retries.
- Use frame-manifest densification only at weak temporal boundaries, not across the full sequence.
- Persist recovery history so operators can see whether the job succeeded by baseline schedule, bridge recovery, subset retry, or boundary densification.

### Primary files

- `PobimSplatting/Backend/pipeline/recovery_planners.py`
- `PobimSplatting/Backend/pipeline/frame_manifest.py`
- `PobimSplatting/Backend/pipeline/stage_features.py`
- `PobimSplatting/Backend/pipeline/stage_sparse.py`

### Exit gate

On weak-boundary datasets, the system should repair continuity with narrower retries more often than it falls back to full expensive reruns.

## Phase 3: Project-Level Resource Orchestration

### Objective

Make budget selection aware of machine-level concurrency and project queue pressure.

### Scope

- Add job admission rules for large ordered-video projects.
- Cap concurrent heavy stages based on decode mode, CPU workers, and GPU presence.
- Improve time estimates so the UI reflects when a project is in a budget-constrained lane.

### Primary files

- `PobimSplatting/Backend/core/projects.py`
- `PobimSplatting/Backend/routes/api.py`
- `PobimSplatting/Backend/services/time_estimator.py`
- `PobimSplatting/Frontend/src/app/projects/[id]/page.tsx`

### Exit gate

Two simultaneous large video projects should avoid thrashing CPU/GPU resources and should surface visible reasons when one job is downgraded or queued.

## Phase 4: Downstream Budget Propagation

### Objective

Carry ordered-video resource policy through training and export so upstream savings are not lost downstream.

### Scope

- Reuse frame-budget knowledge when estimating training cost.
- Feed project-size/resource class into mesh export and later post-processing.
- Expose project resource profile in review/export surfaces.

### Primary files

- `PobimSplatting/Backend/pipeline/stage_training.py`
- `PobimSplatting/Backend/services/mesh_converter.py`
- `PobimSplatting/Backend/services/mvs_mesher.py`
- frontend result/review surfaces as needed

### Exit gate

The chosen capture budget is visible as part of full project lifecycle diagnostics, not isolated to extraction/matching only.

## Phase 5: Rollout Hardening And Auto-Tuning

### Objective

Move from POC thresholds to stable defaults backed by dataset evidence.

### Scope

- Store benchmark results and threshold notes in docs.
- Decide which heuristics become default-on for ordered video.
- Keep manual overrides for advanced users, but make the auto policy the normal path.

### Exit gate

The feature can ship as default behavior for ordered-video projects with a rollback switch and a documented validation baseline.

## Cross-Phase Dependencies

| Dependency | Used by | Notes |
|------|------|------|
| Stable extraction diagnostics schema | Phases 1-5 | Must not churn every round or frontend/docs will drift |
| Stable pair-geometry thresholds | Phases 1-3 | Needed for schedule escalation and recovery branching |
| Frame manifest continuity | Phases 1-2 | Required for exact-frame rebuild and boundary densification |
| Project-level timing/resource telemetry | Phases 1-5 | Required to prove resource-aware wins |
| Retry safety | Phases 1-4 | Every phase depends on stage restart staying understandable |

## Risks And Mitigations

| Risk | Impact | Mitigation |
|------|------|------|
| Frame budget is too aggressive on low-texture orbit footage | Sparse model fragments early | Keep risk-based floors and validate on weak-boundary datasets first |
| Progressive schedule adds too many passes and erases runtime savings | POC looks clever but is slower | Limit ladder length in Phase 1 and require measured win on long videos |
| Diagnostics schema grows ad hoc across backend and frontend | UI and retry logic drift | Lock the schema in Round 1A before code changes |
| Multiple workers edit `runner.py` or `projects/[id]/page.tsx` simultaneously | Merge conflicts and partial behavior | Use file ownership by round and sequence integration |
| Policy becomes impossible to debug | Operators distrust auto mode | Every escalation must log input metrics, threshold breach, and chosen next step |
| Resource rules depend on machine-specific assumptions | Policy behaves differently across environments | Gate decisions off observed capabilities such as GPU decode availability and configured worker counts |

## Metrics And Evidence Plan

### Required benchmark set

Use at least these four capture profiles:

1. Short, clean ordered orbit video.
2. Long ordered orbit video with redundant adjacent frames.
3. Mixed input project with both stills and video.
4. Weak-texture or weak-boundary ordered capture that currently needs orbit-safe recovery.

### Record for each run

- upload config
- chosen frame budget and reason
- chosen pair schedule and escalation history
- extraction duration
- feature matching duration
- sparse reconstruction duration
- total runtime
- extracted image count
- `bridge_p10`, `bridge_min`, `weak_boundary_ratio`, `zero_boundary_ratio`
- registered image ratio
- final sparse model count and chosen model
- peak CPU/GPU/RAM observations if available

### Decision rule

Promote to the next phase only if the benchmark sheet shows:

- consistent runtime or pair-count savings on long ordered-video cases,
- no unacceptable sparse fragmentation increase,
- understandable operator diagnostics in project logs and UI.

## Rollout Strategy

### Rollout mode

Phase 1 should ship behind a backend config flag or guarded auto-policy branch for ordered-video input only.

Recommended rollout progression:

1. Off by default in code while validation is incomplete.
2. On for manual/internal test projects.
3. On for ordered-video projects only, with manual override preserved.
4. Default-on after benchmark signoff in Phase 5.

### Validation surfaces

- Backend logs under `PobimSplatting/logs/`
- Project detail diagnostics page
- Retry flow from `video_extraction`, `feature_matching`, and `sparse_reconstruction`
- Sparse outputs under `PobimSplatting/Backend/results/`

## Team And Agent Split

The safest split is by seam, not by broad layer name.

### Agent 1: Extraction and budget policy

Own:

- `PobimSplatting/Backend/utils/video_processor.py`
- extraction-policy logic near `PobimSplatting/Backend/pipeline/runner.py`

Do not touch in the same round:

- frontend pages
- sparse recovery files unless blocked

### Agent 2: Pair scheduling and recovery policy

Own:

- `PobimSplatting/Backend/pipeline/config_builders.py`
- `PobimSplatting/Backend/pipeline/orbit_policy.py`
- `PobimSplatting/Backend/pipeline/recovery_planners.py`
- stage integration in `stage_features.py` and `stage_sparse.py`

Do not touch in the same round:

- upload/project frontend surfaces unless a contract mismatch requires it

### Agent 3: Frontend diagnostics and operator controls

Own:

- `PobimSplatting/Frontend/src/lib/api.ts`
- `PobimSplatting/Frontend/src/app/upload/page.tsx`
- `PobimSplatting/Frontend/src/app/projects/[id]/page.tsx`

Focus:

- keep UI concise,
- show policy summary first,
- expose manual override impact clearly.

### Agent 4: Validation, rollout, and docs

Own:

- benchmark notes
- rollout checklists
- validation scripts or operator docs if added later under `docs/` or script helpers

Focus:

- compare POC runs,
- maintain acceptance checklist,
- keep threshold history written down.

## Suggested Execution Order For A Small Team

1. Round 1A: Agents 1, 2, and 3 agree the shared payload contract before code changes.
2. Round 1B: Agent 1 lands frame-budget policy while Agent 3 prepares type-safe UI placeholders.
3. Round 1C: Agent 2 lands progressive pair scheduling after Agent 1’s payload shape is stable.
4. Round 1D: Agent 3 lands the final diagnostics UI after both backend contracts are real.
5. Round 1E: Agent 4 runs validation and publishes go/no-go notes.
6. Phase 2+: keep the same seam ownership so workers do not collide in `runner.py` and the main project page every round.

## Checkpoint Checklist

Use this checklist at the end of each round:

- Are the new policy decisions visible in logs?
- Are the same decisions visible in the project API payload?
- Does retry from the relevant stage preserve understandable state?
- Did runtime drop on long ordered-video cases?
- Did sparse continuity stay acceptable?
- Did any worker edit a file outside their assigned seam without coordinating the contract first?

## Recommendation

Execute Phase 1 first with narrow ambition:

- adaptive frame budget for ordered-video inputs,
- a three-step progressive sequential schedule,
- visible diagnostics,
- dataset-backed acceptance gates.

Do not start Phase 3 or later platform-wide resource orchestration until Phase 1 proves that the current extraction and matching telemetry is sufficient to drive correct decisions.
