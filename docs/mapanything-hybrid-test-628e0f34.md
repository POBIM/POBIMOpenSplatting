# MapAnything Hybrid Test: 628e0f34

This runbook keeps the MapAnything experiment standalone. It does not modify the
existing upload project, active COLMAP sparse model, Flask backend pipeline, or
existing OpenSplat result.

## Baseline A

- Project: `PobimSplatting/Backend/uploads/628e0f34-331b-4d78-be13-1d595e2662d8`
- Images in source folder: `106`
- Active COLMAP model: `57` registered images, `3,464` points, mean reprojection error `0.971876px`
- Existing OpenSplat output: `PobimSplatting/Backend/results/628e0f34-331b-4d78-be13-1d595e2662d8/628e0f34-331b-4d78-be13-1d595e2662d8_high_8400iter.ply`
- Existing training peak: `2,113,345` splats

## Layout

The standalone experiment writes to:

```text
PobimSplatting/Backend/experiments/mapanything_628e0f34/
├── a_colmap_baseline -> ../../uploads/628e0f34-331b-4d78-be13-1d595e2662d8
├── b_mapanything_image_only/
├── b_opensplat_project/
├── c_colmap_input/
├── c_colmap_guided_mapanything/
├── c_opensplat_project/
├── logs/
├── metrics.json
├── metrics.md
└── results/
```

External MapAnything checkout and environment:

```text
/home/pobimgroup/tools/map-anything      # checked out at v1.1.1
/home/pobimgroup/venvs/mapanything       # Python venv for MapAnything
```

## Run

First run the full standalone short-pass experiment:

```bash
./scripts/run-mapanything-hybrid-experiment.sh
```

This performs:

1. clone/fetch MapAnything and checkout `v1.1.1`
2. install MapAnything with the `colmap` extra
3. run CUDA and MapAnything help preflights
4. analyze baseline A with `colmap model_analyzer`
5. run B: image-only MapAnything COLMAP export
6. run C: COLMAP-guided MapAnything MVS export
7. train B and C through OpenSplat for `1200` iterations
8. write `metrics.json` and `metrics.md`

To run only preflight and geometry export without OpenSplat training:

```bash
RUN_TRAINING=0 ./scripts/run-mapanything-hybrid-experiment.sh
```

To skip install after the venv is ready:

```bash
SKIP_INSTALL=1 ./scripts/run-mapanything-hybrid-experiment.sh
```

To run only C:

```bash
RUN_B=0 RUN_C=1 ./scripts/run-mapanything-hybrid-experiment.sh
```

If the RTX 4060 8 GB path cannot run all 106 images in B, run a bounded
image-only smoke export first:

```bash
SKIP_INSTALL=1 RUN_TRAINING=0 B_MAX_IMAGES=24 RUN_C=0 \
  ./scripts/run-mapanything-hybrid-experiment.sh
```

If C needs to reduce view count, use COLMAP stride:

```bash
SKIP_INSTALL=1 RUN_TRAINING=0 RUN_B=0 C_STRIDE=2 \
  ./scripts/run-mapanything-hybrid-experiment.sh
```

To run the full `8400` iteration comparison after the short pass looks sane:

```bash
SKIP_INSTALL=1 RUN_FULL=1 ./scripts/run-mapanything-hybrid-experiment.sh
```

## Metrics

Metrics can be refreshed independently:

```bash
python3 scripts/collect-mapanything-hybrid-metrics.py \
  --experiment-root PobimSplatting/Backend/experiments/mapanything_628e0f34 \
  --source-project PobimSplatting/Backend/uploads/628e0f34-331b-4d78-be13-1d595e2662d8 \
  --results-root PobimSplatting/Backend/experiments/mapanything_628e0f34/results
```

Review:

- `metrics.md` for a compact human-readable summary
- `logs/analyze_*.log` for COLMAP geometry stats
- `logs/train_b_1200iter.log` and `logs/train_c_1200iter.log` for OpenSplat behavior
- `results/*/*.ply` for produced splats

## Current Smoke Results

Completed on 2026-04-30 with the external MapAnything `v1.1.1` checkout:

| Variant | Settings | Images | Points | 1200-iter PLY |
|---|---|---:|---:|---:|
| A baseline | existing COLMAP/OpenSplat result | 57 registered from 106 source images | 3,464 COLMAP points | existing 8400-iter PLY ~487 MB |
| B | `B_MAX_IMAGES=24` | 24 | 785,321 | 185.74 MB |
| C | `C_STRIDE=8` | 14 | 26,404 | 6.25 MB |

Observed limits:

- B with all 106 images failed during CUDA inference with `CUDA driver error: device not ready`.
- C with `C_STRIDE=4` loaded 27 views and failed with CUDA OOM on the 8 GB RTX 4060.
- B 24-image and C stride-8 smoke exports both produced COLMAP-style projects and completed OpenSplat `1200` iteration training.

## Continue Criteria

Run full `8400` iteration B/C only if:

- B or C exports a valid COLMAP-style project with `images/` and `sparse/0`
- `colmap model_analyzer` succeeds for the generated project
- short OpenSplat training reaches `1200` iterations without CUDA OOM
- C camera layout is coherent when compared with A
- B/C splat count does not grow wildly beyond baseline without visual benefit

## Notes

- The RTX 4060 Laptop GPU has about 8 GB VRAM, so MapAnything may need its default memory-efficient inference behavior.
- MapAnything C staging flattens the source active model from `sparse/0` into the `sparse/` layout expected by `demo_inference_on_colmap_outputs.py`.
- The generated B output uses MapAnything processed images if present, because those images match the exported intrinsics.
