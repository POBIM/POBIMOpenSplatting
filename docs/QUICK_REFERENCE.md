# POBIMOpenSplat Quick Reference

Use this page for day-to-day operation of the pipeline platform.

For the broader docs map, start at [DOCS_INDEX.md](DOCS_INDEX.md).

## Start And Stop

```bash
./quick-start.sh
```

```bash
cd PobimSplatting
./start.sh start
./start.sh status
./start.sh stop
```

## URLs

| Surface | URL |
|------|------|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5000 |
| Health endpoint | http://localhost:5000/api/health |

## Health And Tool Checks

```bash
curl http://localhost:5000/api/health
```

```bash
./build/opensplat --version
./colmap-build/install/bin/colmap --version
python3 -c "import pycolmap; print(pycolmap.__version__)"
python3 -c "import hloc; print('hloc ok')"
python3 fastmap/run.py --help
ffmpeg -version
```

## Pipeline Defaults

- Default global SfM: `COLMAP global_mapper`
- Experimental Python-native global SfM: `pycolmap.global_mapping`
- Dense-coverage GPU SfM option: `FastMap`
- Incremental fallback: COLMAP `mapper`
- Legacy fallback: standalone `GLOMAP`
- Neural features: `ALIKED` or `SuperPoint` through `hloc`
- Matcher default: let backend choose with `auto`
- Large unordered photo sets: experimental `vocab_tree`

## Main Tool Roles

| Tool | Role |
|------|------|
| `install.sh` | One-time installation |
| `quick-start.sh` | Fast launch for regular use |
| `PobimSplatting/start.sh` | Status, stop, restart, logs, port clearing |
| `ffmpeg` | Frame extraction |
| COLMAP | Features, matching, sparse/dense reconstruction, GUI |
| `pycolmap` | Experimental Python-native global mapping |
| `hloc` | Neural features and pair generation |
| LightGlue | Neural matching path |
| FastMap | GPU-native SfM alternative |
| `opensplat` | Gaussian training |
| `MVSMesher` / `MeshConverter` | Mesh export |

## Common Operations

### View logs

```bash
tail -f PobimSplatting/logs/install.log
tail -f PobimSplatting/logs/backend.log
tail -f PobimSplatting/logs/frontend.log
```

### Clear stuck ports

```bash
cd PobimSplatting
./start.sh
```

Then choose the force-clear option from the menu.

### Rebuild COLMAP with GUI

```bash
./scripts/rebuild-colmap-with-gui.sh
```

### Rebuild COLMAP for cloud/global flow

```bash
./scripts/rebuild-colmap-cloud.sh
```

### Rebuild only the training binary

```bash
./scripts/compile-opensplat-cuda126.sh
```

### Run sparse reconstruction helper directly

```bash
./scripts/run_sparse_reconstruction.sh
```

## Runtime Paths

| Path | Contents |
|------|------|
| `PobimSplatting/Backend/uploads/` | Uploaded media |
| `PobimSplatting/Backend/frames/` | Extracted frames |
| `PobimSplatting/Backend/results/` | Splats and mesh outputs |
| `PobimSplatting/Backend/projects_db.json` | Project metadata |
| `PobimSplatting/logs/` | Logs |
| `PobimSplatting/runtime/` | PID files |

## Common Fixes

### CUDA not in path

```bash
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
```

### Reset backend venv

```bash
cd PobimSplatting/Backend
rm -rf venv
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Reset frontend deps

```bash
cd PobimSplatting/Frontend
rm -rf node_modules package-lock.json
npm install
```

### Force restart everything

```bash
pkill -f "next start"
pkill -f "python app.py"
./quick-start.sh
```
