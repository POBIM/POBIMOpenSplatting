# POBIMOpenSplat Processing Workflow

This file explains the actual product workflow, not just the installer.

The pipeline is organized so the user can start from raw captures and end with:

- a sparse reconstruction,
- a trained gaussian splat,
- review pages for cameras and outputs,
- and optional textured mesh exports.

## Operator View

```text
Upload or create project
        |
        v
Ingest images / videos / mixed inputs
        |
        v
Extract frames when needed
        |
        v
Choose feature + matcher strategy
        |
        v
Run sparse SfM
        |
        v
Convert sparse model for training
        |
        v
Train gaussian splats with opensplat
        |
        +--> Inspect in viewer
        |
        +--> Inspect camera poses
        |
        +--> Open COLMAP GUI when available
        |
        +--> Export textured mesh
```

## Stage Breakdown

| Stage | What happens | Main tools | Main outputs |
|------|------|------|------|
| `ingest` | Create project, validate uploads, classify input type | Next.js UI, Flask API | Project metadata, uploaded media |
| `video_extraction` | Extract frames from video or mixed input | `ffmpeg`, OpenCV utilities | `Backend/frames/`, `Backend/uploads/<project>/images` |
| `feature_extraction` | Build local or neural features | COLMAP SIFT, `hloc` ALIKED, `hloc` SuperPoint | COLMAP DB or neural feature artifacts |
| `feature_matching` | Match image pairs | COLMAP matchers, LightGlue, vocabulary tree | Matched pairs in DB / hloc artifacts |
| `sparse_reconstruction` | Build sparse camera graph and points | COLMAP `global_mapper`, `pycolmap`, FastMap, COLMAP mapper, legacy GLOMAP | `sparse/0` model |
| `model_conversion` | Prepare sparse results for downstream training and inspection | COLMAP model conversion helpers | text/bin camera model outputs |
| `gaussian_splatting` | Train the final splat representation | `build/opensplat` | `.ply` or `.splat` result |
| `review` | Inspect result quality and geometry | Viewer, camera poses page, COLMAP GUI | Human validation |
| `mesh_export` | Build dense and textured mesh outputs | COLMAP dense tools, `MVSMesher`, `MeshConverter` | `glb`, `gltf`, `dae`, mesh files |

## Tool Selection Rules

### Feature stage

- `feature_method=sift`: classic COLMAP path
- `feature_method=aliked`: prefer native COLMAP support when available, otherwise fall back to `hloc`
- `feature_method=superpoint`: use `hloc` when available unless the matcher choice forces native fallback

### Matcher stage

- `matcher_type=sequential`: best for ordered capture such as orbit/video
- `matcher_type=exhaustive`: good default for smaller unordered image sets
- `matcher_type=vocab_tree`: experimental path for large unordered image sets
- `matcher_type=auto`: let the backend infer the best option from the input pattern

### Sparse SfM stage

- Default global path: COLMAP `global_mapper`
- Experimental Python-native path: `pycolmap.global_mapping`
- GPU-native alternative: FastMap
- Fallback path: COLMAP incremental mapper
- Legacy compatibility only: standalone GLOMAP

## Review Surfaces

After training or sparse reconstruction you can use:

- Project detail page: stage state, live logs, retry, export actions
- Camera poses page: inspect sparse reconstruction and camera coverage
- Viewer page: inspect gaussian splat output
- COLMAP GUI bridge: open the active project in desktop COLMAP when GUI support is built

## Retry Model

The backend supports restart from a chosen stage.
When you retry, it clears only the downstream artifacts needed for that restart point.

Typical restart points:

- `feature_extraction`: rebuild features, matches, sparse model, and downstream outputs
- `feature_matching`: keep features, rebuild matches and later stages
- `sparse_reconstruction`: keep features and matches, rebuild sparse/training outputs
- `gaussian_splatting`: keep sparse outputs, rerun training only

## Output Locations

| Path | Purpose |
|------|------|
| `PobimSplatting/Backend/uploads/` | Raw uploads |
| `PobimSplatting/Backend/frames/` | Extracted frames |
| `PobimSplatting/Backend/results/` | Splats, mesh exports, derived outputs |
| `PobimSplatting/Backend/projects_db.json` | Project index and metadata |
| `PobimSplatting/logs/` | Install/backend/frontend logs |

## Installation And Runtime Relationship

The installer is still important, but it supports this runtime workflow rather than defining it.

- `install.sh` prepares the toolchain
- `quick-start.sh` launches the platform
- `PobimSplatting/start.sh` manages backend/frontend runtime
- the user-facing pipeline then runs inside the web UI and backend stages above

For installation details, use [INSTALLATION.md](INSTALLATION.md).
For daily commands, use [QUICK_REFERENCE.md](QUICK_REFERENCE.md).
