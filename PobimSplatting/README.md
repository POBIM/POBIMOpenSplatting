# PobimSplatting Platform

`PobimSplatting/` is the product surface for the repo: the launcher, API, realtime pipeline orchestration, review UI, and export tools all live here.

This layer is responsible for turning raw captures into reviewable gaussian splats and mesh assets. It does not just call `opensplat`; it manages the full reconstruction workflow around it.

## Architecture

```text
PobimSplatting/
├── Frontend/                 # Next.js 16 UI
├── Backend/                  # Flask API + Socket.IO + pipeline runner
├── start.sh                  # Production-style launcher and status manager
├── logs/                     # Backend/frontend/install logs
├── runtime/                  # PID files and runtime state
├── MESH_EXPORT_GUIDE.md      # Mesh export documentation
└── QUICK_PERFORMANCE_GUIDE.md
```

## End-To-End Pipeline

| Stage | Owned by | Main tools | Output |
|------|------|------|------|
| Project creation and upload | Frontend + Backend API | Next.js, Flask | Project entry, uploaded files |
| Frame preparation | Backend | `ffmpeg`, OpenCV | Image frames for SfM |
| Policy preview | Backend | upload policy analyzer | Suggested matcher and capture strategy |
| Feature extraction | Backend pipeline | COLMAP SIFT, `hloc` ALIKED, `hloc` SuperPoint | Feature database or neural feature artifacts |
| Feature matching | Backend pipeline | COLMAP matchers, LightGlue, vocabulary tree | Matched pairs / COLMAP DB |
| Sparse reconstruction | Backend pipeline | COLMAP `global_mapper`, `pycolmap`, FastMap, COLMAP mapper, legacy GLOMAP | Sparse model in `sparse/0` |
| Model conversion | Backend pipeline | COLMAP model conversion helpers | Training-ready text/bin outputs |
| Gaussian training | Backend pipeline | `build/opensplat` | `.ply` or `.splat` result |
| Review | Frontend | viewer page, project page, camera poses page | Interactive inspection |
| Mesh export | Backend services | COLMAP dense reconstruction, `MVSMesher`, `MeshConverter`, `PyMeshLab`, `trimesh` | `glb`, `gltf`, `dae`, and mesh derivatives |

## Tool Roles

### User-facing tools

- Project dashboard: upload, configure, run, retry, inspect status
- Project detail page: stage progress, logs, retry from stage, export actions
- Camera poses page: inspect sparse reconstruction coverage
- Viewer page: inspect gaussian splat outputs
- Mesh export panel: create textured meshes from completed reconstructions
- COLMAP GUI bridge: open the active project in desktop COLMAP when GUI support exists

### Backend pipeline tools

- `ffmpeg`: video frame extraction
- OpenCV utilities: frame handling and media support
- COLMAP SIFT: classic local features
- `hloc`: neural feature extraction and matching
- LightGlue: neural matching path used with hloc
- COLMAP `global_mapper`: default global SfM engine
- `pycolmap.global_mapping`: experimental Python-native global backend
- FastMap: GPU-native SfM alternative
- COLMAP `mapper`: incremental fallback
- standalone `GLOMAP`: legacy fallback only
- `build/opensplat`: gaussian training stage
- `MVSMesher` and `MeshConverter`: mesh generation and conversion

## Default Behavior

- `sfm_engine=glomap` maps to the repo's preferred global COLMAP workflow.
- `sfm_backend=pycolmap` is only meaningful when `pycolmap.global_mapping` is actually available.
- `feature_method=aliked` or `superpoint` can switch the feature stage to `hloc`.
- `matcher_type=auto` lets the backend pick between sequential, exhaustive, and experimental vocabulary-tree matching.
- Retry is stage-aware. The backend clears only the downstream artifacts for the chosen restart point.

## Runtime Surfaces

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:5000`
- Health endpoint: `GET /api/health`
- WebSocket room model: events are keyed by `project_id`

## Start And Operate

### Recommended launcher flow

```bash
./start.sh start
./start.sh status
./start.sh stop
```

### Development flows

```bash
cd Frontend
npm run build
npm run start
```

```bash
cd Backend
source venv/bin/activate
python app.py
```

Use `npm run dev` only for local hot-reload development. The documented stable path stays `npm run build` then `npm run start`.

## Key Files

- `Backend/app.py`: Flask composition root
- `Backend/routes/api.py`: upload, process, retry, viewer, mesh, health endpoints
- `Backend/pipeline/runner.py`: cross-stage orchestration
- `Backend/pipeline/stage_features.py`: feature extraction and matching stages
- `Backend/pipeline/stage_sparse.py`: global/incremental/FastMap sparse reconstruction
- `Backend/pipeline/stage_training.py`: gaussian training
- `Backend/services/mvs_mesher.py`: textured mesh generation from COLMAP outputs
- `Frontend/src/app/projects/[id]/page.tsx`: main project detail and retry UI
- `Frontend/src/lib/api.ts`: shared REST client
- `Frontend/src/lib/websocket.ts`: shared realtime client

## Logs And Runtime Data

- Installation log: `logs/install.log`
- Backend log: `logs/backend.log`
- Frontend log: `logs/frontend.log`
- Runtime PID files: `runtime/*.pid`
- Uploads: `Backend/uploads/`
- Frames: `Backend/frames/`
- Results: `Backend/results/`
- Project index: `Backend/projects_db.json`

## Related Docs

- [../docs/WORKFLOW.md](../docs/WORKFLOW.md)
- [../docs/QUICK_REFERENCE.md](../docs/QUICK_REFERENCE.md)
- [../docs/INSTALLATION.md](../docs/INSTALLATION.md)
- [MESH_EXPORT_GUIDE.md](MESH_EXPORT_GUIDE.md)
- [QUICK_PERFORMANCE_GUIDE.md](QUICK_PERFORMANCE_GUIDE.md)
