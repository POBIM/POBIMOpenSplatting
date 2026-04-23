# POBIMOpenSplat Documentation Hub

This docs set now treats POBIMOpenSplat as a full reconstruction pipeline platform.

Use this page when you need to answer one of these questions:

- How does the end-to-end pipeline work?
- Which tool is responsible for each stage?
- Which document should an operator, developer, or multi-machine installer read next?
- Where do runtime outputs and logs live?

Start with the repo root [README.md](../README.md) for the project overview. Use this page for document routing.

## Start Here By Need

| I need to... | Read this |
|------|------|
| Understand the whole platform and toolchain | [../README.md](../README.md) |
| Understand the product surface under `PobimSplatting/` | [../PobimSplatting/README.md](../PobimSplatting/README.md) |
| See the full processing workflow stage by stage | [WORKFLOW.md](WORKFLOW.md) |
| Run the system day to day | [QUICK_REFERENCE.md](QUICK_REFERENCE.md) |
| Understand the CPU-first hybrid policy for ordered video | [ORDERED_VIDEO_HYBRID_POLICY.md](ORDERED_VIDEO_HYBRID_POLICY.md) |
| See what is still missing in the ordered-video resource-aware work | [ORDERED_VIDEO_NEXT_STEPS.md](ORDERED_VIDEO_NEXT_STEPS.md) |
| Understand how ordered-video self-tuning is supposed to work | [ORDERED_VIDEO_SELF_TUNING_GUIDE.md](ORDERED_VIDEO_SELF_TUNING_GUIDE.md) |
| Review ordered-video evidence and signoff expectations | [ORDERED_VIDEO_BENCHMARK_BASELINE.md](ORDERED_VIDEO_BENCHMARK_BASELINE.md) |
| Install on a new machine | [INSTALLATION.md](INSTALLATION.md) |
| Read the Thai installation guide | [INSTALLATION_TH.md](INSTALLATION_TH.md) |
| Understand the installation scripts themselves | [INSTALLATION_SYSTEM.md](INSTALLATION_SYSTEM.md) |
| Work only on the frontend | [../PobimSplatting/Frontend/README.md](../PobimSplatting/Frontend/README.md) |

## Current Product Framing

The repo is no longer best described as "OpenSplat with a web wrapper".
The real product is a pipeline platform made of:

- Upload and capture ingestion
- Video frame extraction
- Feature extraction and matching
- Sparse reconstruction with multiple SfM engines
- Gaussian training
- Viewer and camera-pose inspection
- Textured mesh export
- Installer, launcher, logs, health checks, and helper scripts

`opensplat` remains important, but it is one stage in the pipeline rather than the main documentation anchor.

## Toolchain Map

| Stage | Main tools | Default or special note |
|------|------|------|
| Install and launch | `install.sh`, `quick-start.sh`, `PobimSplatting/start.sh` | Main entrypoints for most users |
| Capture ingestion | Next.js UI, Flask API, Socket.IO | Handles projects and live progress |
| Frame extraction | `ffmpeg`, OpenCV helpers | Used for video and mixed inputs |
| Feature extraction | COLMAP SIFT, `hloc` ALIKED, `hloc` SuperPoint | Neural path is conditional |
| Matching | COLMAP matchers, LightGlue, experimental vocabulary tree | `auto` lets backend choose |
| Sparse SfM | COLMAP `global_mapper`, `pycolmap.global_mapping`, FastMap, COLMAP mapper, legacy GLOMAP | Ordered video stays CPU-first by default; GPU/global paths remain available for retries and unordered photo sets |
| Training | `build/opensplat` | Gaussian splat training stage |
| Review | Web viewer, camera poses page, COLMAP GUI | Viewer is primary; GUI is optional |
| Mesh export | COLMAP dense reconstruction, `MVSMesher`, `MeshConverter`, `PyMeshLab`, `trimesh` | Produces textured mesh outputs |

## Documents By Topic

### Project overviews

- [../README.md](../README.md): high-level repo overview, pipeline, tool matrix, and native-engine reference
- [../PobimSplatting/README.md](../PobimSplatting/README.md): platform-level guide for launcher, backend, frontend, and runtime data
- [../PobimSplatting/Frontend/README.md](../PobimSplatting/Frontend/README.md): frontend-specific routes and responsibilities

### Workflow and operations

- [WORKFLOW.md](WORKFLOW.md): stage-by-stage processing workflow
- [QUICK_REFERENCE.md](QUICK_REFERENCE.md): daily commands, health checks, and common operator actions
- [ORDERED_VIDEO_HYBRID_POLICY.md](ORDERED_VIDEO_HYBRID_POLICY.md): CPU-first ordered-video policy plus the retained GPU paths for extraction, training, retries, and unordered inputs
- [INSTALLATION.md](INSTALLATION.md): English installation guide
- [INSTALLATION_TH.md](INSTALLATION_TH.md): Thai installation guide
- [INSTALLATION_SYSTEM.md](INSTALLATION_SYSTEM.md): explanation of installer mechanics

### Specialized guides

- [ORDERED_VIDEO_NEXT_STEPS.md](ORDERED_VIDEO_NEXT_STEPS.md): current status, remaining work, and recommended next execution order for the ordered-video resource-aware pipeline
- [ORDERED_VIDEO_SELF_TUNING_GUIDE.md](ORDERED_VIDEO_SELF_TUNING_GUIDE.md): how the runtime learning loop, tuned snapshots, operator surfaces, and guardrails are intended to work
- [ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md](ORDERED_VIDEO_RESOURCE_AWARE_ROADMAP.md): full roadmap and phase map
- [ORDERED_VIDEO_BENCHMARK_BASELINE.md](ORDERED_VIDEO_BENCHMARK_BASELINE.md): evidence review contract, optional benchmark signoff sheet, and promotion gate
- [../PobimSplatting/MESH_EXPORT_GUIDE.md](../PobimSplatting/MESH_EXPORT_GUIDE.md): mesh export flow and formats
- [../PobimSplatting/QUICK_PERFORMANCE_GUIDE.md](../PobimSplatting/QUICK_PERFORMANCE_GUIDE.md): performance tuning notes
- [compile-cuda.md](compile-cuda.md): native CUDA compile reference
- [compile.md](compile.md): legacy native compile notes
- [web-frontend-setup.md](web-frontend-setup.md): historical frontend setup reference

## Runtime Paths

| Path | What it contains |
|------|------|
| `PobimSplatting/Backend/uploads/` | Uploaded source files |
| `PobimSplatting/Backend/frames/` | Extracted frames |
| `PobimSplatting/Backend/results/` | Pipeline results and exports |
| `PobimSplatting/Backend/projects_db.json` | Persistent project index |
| `PobimSplatting/logs/` | Install and runtime logs |
| `PobimSplatting/runtime/` | PID files and launcher runtime state |

## Helper Scripts

These are the main focused helpers under `scripts/`:

- `rebuild-colmap-cloud.sh`
- `rebuild-colmap-with-gui.sh`
- `rebuild-colmap-with-cuda.sh`
- `run_sparse_reconstruction.sh`
- `package_prebuilt_runtime.sh`
- `monitor.sh`
- `simple_gpu_test.sh`
- `compile-opensplat-cuda126.sh`
- `report_ordered_video_evidence.py`

## Health And Debug Entry Points

- Backend health: `GET /api/health`
- Main logs:
  - `PobimSplatting/logs/install.log`
  - `PobimSplatting/logs/backend.log`
  - `PobimSplatting/logs/frontend.log`
- Launcher status: `cd PobimSplatting && ./start.sh status`

## Legacy Notes

- `opensplat` build and upstream-native usage still matter for low-level training work, but they are no longer the best top-level explanation of the repo.
- `compile.md`, `compile-cuda.md`, and `web-frontend-setup.md` remain useful as references, not as the primary product docs.
