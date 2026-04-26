# POBIMOpenSplat

POBIMOpenSplat is now primarily a reconstruction pipeline platform, not just a thin wrapper around `opensplat`.
The repo combines capture ingestion, feature extraction, matching, sparse reconstruction, gaussian training, review tools, and mesh export in one flow across a Flask backend, a Next.js frontend, and a local native toolchain.

`opensplat` is still part of the stack, but it is one stage inside the pipeline rather than the main product surface.

## What This Repo Does

The main product flow is:

1. Upload images, videos, or mixed captures.
2. Extract frames when video is present.
3. Choose a feature and matcher strategy.
4. Run sparse SfM with the best available engine.
5. Convert the sparse model into training-ready inputs.
6. Train gaussian splats with `opensplat`.
7. Inspect the result in the web viewer, camera-pose view, or COLMAP GUI.
8. Export splat outputs or build textured meshes from the reconstruction.

The recommended user entrypoint is the web platform:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:5000`

## Pipeline And Tools

| Stage | Primary tools | Notes |
|------|------|------|
| Launch and orchestration | `install.sh`, `quick-start.sh`, `PobimSplatting/start.sh` | Install, boot, stop, inspect logs, clear ports |
| Upload and ingestion | Next.js UI, Flask API, Socket.IO | Project creation, upload, live progress |
| Video frame extraction | `ffmpeg`, OpenCV helpers | Handles `video`, `images`, and `mixed` inputs |
| Feature extraction | COLMAP SIFT, `hloc` ALIKED, `hloc` SuperPoint | Neural features are used when available and appropriate |
| Feature matching | COLMAP matchers, LightGlue, vocabulary tree | `sequential`, `exhaustive`, and experimental `vocab_tree` paths |
| Sparse SfM | COLMAP `global_mapper`, `pycolmap.global_mapping`, FastMap, COLMAP mapper, legacy GLOMAP | Backend chooses among global, incremental, and fallback paths |
| Training | `build/opensplat` | Trains gaussian splats from the prepared sparse model |
| Inspection | Web viewer, camera poses page, COLMAP GUI | Review coverage, cameras, and outputs |
| Mesh export | COLMAP dense reconstruction, `MVSMesher`, `MeshConverter`, `PyMeshLab`, `trimesh` | Builds textured or converted mesh outputs |

## Default Decision Rules

- Default global SfM path: `COLMAP global_mapper`
- Experimental Python-native global SfM: `pycolmap.global_mapping` when the backend reports it as ready
- Dense-coverage GPU SfM option: `FastMap`
- Legacy fallback only: standalone `GLOMAP`
- Ordered video/orbit captures: `sequential` matcher
- Small unordered image sets: `exhaustive` matcher
- Large unordered photo sets: experimental `vocab_tree`
- Neural feature path: `hloc` with `ALIKED` or `SuperPoint` plus LightGlue when supported

## Repository Map

```text
.
├── apps/                     # Native CLI entrypoints (opensplat, simple_trainer, visualizer)
├── src/                      # Native engine implementation
├── include/opensplat/        # Native engine headers
├── rasterizer/               # CPU/CUDA/HIP/Metal raster backends
├── PobimSplatting/
│   ├── Backend/              # Flask API, pipeline runner, mesh services
│   ├── Frontend/             # Next.js 16 app router UI
│   ├── start.sh              # Server manager
│   └── README.md             # Platform-specific guide
├── scripts/                  # Focused build and operator helpers
├── docs/                     # Canonical docs hub and workflows
├── colmap/                   # Vendored upstream COLMAP source
├── hloc/                     # Neural features and LightGlue toolbox
├── fastmap/                  # GPU-native SfM path
└── README.md                 # This overview
```

## Important Runtime Paths

- Uploads: `PobimSplatting/Backend/uploads/`
- Frames: `PobimSplatting/Backend/frames/`
- Results: `PobimSplatting/Backend/results/`
- Project index: `PobimSplatting/Backend/projects_db.json`
- Logs: `PobimSplatting/logs/`
- PIDs and runtime state: `PobimSplatting/runtime/`

## Quick Start

### Install once

```bash
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
chmod +x install.sh
./install.sh
```

### Run the platform

```bash
./quick-start.sh
```

### Daily operations

```bash
cd PobimSplatting
./start.sh start
./start.sh status
./start.sh stop
```

## Focused Helpers

The `scripts/` directory is for targeted maintenance and advanced flows:

- `scripts/rebuild-colmap-cloud.sh`: rebuild COLMAP with the current cloud/global workflow expectations
- `scripts/rebuild-colmap-with-gui.sh`: rebuild COLMAP with GUI enabled for manual inspection
- `scripts/rebuild-colmap-with-cuda.sh`: rebuild COLMAP with CUDA support
- `scripts/run_sparse_reconstruction.sh`: run sparse reconstruction outside the full web flow
- `scripts/package_prebuilt_runtime.sh`: stage a reusable runtime bundle
- `scripts/simple_gpu_test.sh`: quick GPU sanity check
- `scripts/monitor.sh`: runtime monitoring helper
- `scripts/setup-cuda130-wsl.sh`: install CUDA 13.0 toolkit-only side-by-side on WSL2
- `scripts/compile-opensplat-cuda130.sh`: rebuild OpenSplat against CUDA 13.0 and LibTorch cu130
- `scripts/compile-opensplat-cuda126.sh`: focused native training-binary rebuild

## Documentation

- [docs/DOCS_INDEX.md](docs/DOCS_INDEX.md): main docs hub
- [docs/WORKFLOW.md](docs/WORKFLOW.md): end-to-end processing workflow
- [docs/QUICK_REFERENCE.md](docs/QUICK_REFERENCE.md): daily commands and checks
- [docs/INSTALLATION.md](docs/INSTALLATION.md): installation guide
- [PobimSplatting/README.md](PobimSplatting/README.md): platform-specific guide
- [PobimSplatting/Frontend/README.md](PobimSplatting/Frontend/README.md): frontend-specific guide

## Native Engine Reference

The native fork is still important when you need to rebuild or debug training:

```bash
mkdir -p build && cd build
cmake -DCMAKE_PREFIX_PATH=/path/to/libtorch ..
cmake --build .
```

Key native locations:

- Entry points: `apps/`
- Engine code: `src/`
- Headers: `include/opensplat/`
- Output binary: `build/opensplat`

Use the native layer when working on training/runtime internals. Use the web platform when operating the full capture-to-result pipeline.

## License

See the repository license files for the applicable terms:

- `LICENSE.txt`
- `PobimSplatting/LICENSE.txt`
- `PobimSplatting/POBIMOpenSplatting_LICENSE.txt`
