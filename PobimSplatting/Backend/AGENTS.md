# BACKEND KNOWLEDGE BASE

## OVERVIEW
Flask API + Socket.IO service that orchestrates uploads, project state, and long-running native reconstruction/training jobs.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| App wiring | `app.py` | composition root; registers blueprints + socket layer |
| Paths/runtime config | `core/config.py` | repo-root-relative binary discovery and runtime dirs |
| Project state/logging | `core/projects.py` | shared status store and persistence |
| Pipeline orchestration | `pipeline/runner.py` | highest-risk backend area; bridges to COLMAP/GLOMAP/OpenSplat/FastMap |
| HTTP routes | `routes/` | API and frontend-serving blueprints |
| Realtime events | `realtime/socket.py` | Socket.IO setup and room behavior |

## STRUCTURE
```text
Backend/
├── app.py
├── core/
├── pipeline/
├── realtime/
├── routes/
├── services/
└── utils/
```

## CONVENTIONS
- Start local dev with `source venv/bin/activate && python app.py`.
- Production-style run is Gunicorn via `gunicorn.conf.py`; launcher assumes single-process threaded behavior for Socket.IO room state.
- Resolve paths relative to `REPO_ROOT`/`PROJECT_ROOT` from `core/config.py`; do not hardcode caller working directory assumptions.
- External binary discovery prefers repo-local or install-managed paths (`build/opensplat`, `colmap-build/...`, `fastmap/run.py`, `hloc/`).
- Runtime directories (`uploads/`, `results/`, `frames/`, vocab trees) are created lazily and treated as ephemeral data.

## ANTI-PATTERNS
- Do not bypass `core/config.py` for binary/path lookup.
- Do not introduce background job logic directly in routes when `pipeline/runner.py` or services can own it.
- Do not rely on interactive/manual test scripts as if they were stable automated coverage.
- Do not assume frontend build artifacts exist; `create_flask_app()` has a fallback path and logs when `.next` assets are absent.

## COMMANDS
```bash
source venv/bin/activate
python app.py

gunicorn --config gunicorn.conf.py "PobimSplatting.Backend.app:app"

python test_mesh_converter.py
python test_textured_mesh.py
```

## NOTES
- Tests here are mostly smoke/integration scripts, not a formal pytest suite.
- `pipeline/runner.py` is large and cross-cutting; change it surgically and verify downstream file outputs/logging behavior.
- When changing environment/runtime behavior, sync `PobimSplatting/start.sh` and top-level docs.
