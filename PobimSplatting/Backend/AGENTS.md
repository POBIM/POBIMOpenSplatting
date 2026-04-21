# BACKEND KNOWLEDGE BASE

## OVERVIEW
Flask API + Socket.IO service that orchestrates uploads, project state, and long-running native reconstruction/training jobs.

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| App wiring | `app.py` | composition root; CORS + Socket.IO + blueprints + lifecycle hooks |
| Paths/runtime config | `core/config.py` | repo-root-relative binary discovery and runtime dirs |
| Project state/logging | `core/projects.py` | shared status store, bounded log tail, Socket.IO emit hooks |
| Subprocess bridge | `core/commands.py` | streams stdout, registers PIDs for cancel |
| Pipeline orchestration | `pipeline/runner.py` | highest-risk backend area; coordinates stages + retries |
| Stage modules | `pipeline/stage_features.py`, `stage_sparse.py`, `stage_training.py` | SIFT/hloc, COLMAP/GLOMAP/FastMap/pycolmap, OpenSplat |
| Stage helpers | `pipeline/runtime_support.py`, `config_builders.py`, `orbit_policy.py`, `recovery_planners.py`, `frame_manifest.py` | capability detection, policy previews, recovery |
| HTTP routes | `routes/api.py`, `routes/frontend.py` | REST + Next.js static fallback |
| Realtime events | `realtime/socket.py` | Socket.IO rooms keyed by `project_id` |
| Mesh services | `services/mesh_converter.py`, `mvs_mesher.py` | PLY → textured mesh export |

## STRUCTURE
```text
Backend/
├── app.py
├── core/         # config, projects, commands
├── pipeline/     # runner.py + stage_*.py + support helpers
├── realtime/     # socket.py
├── routes/       # api.py, frontend.py
├── services/     # mesh_converter, mvs_mesher
├── utils/        # video_processor
└── tui/          # terminal UI helpers
```

## CONVENTIONS
- Start local dev with `source venv/bin/activate && python app.py`.
- Production-style run is Gunicorn via `gunicorn.conf.py`; launcher assumes `workers=1` + threaded async mode so Socket.IO room state stays in-process.
- Resolve paths relative to `REPO_ROOT`/`PROJECT_ROOT` from `core/config.py`; do not hardcode caller working directory assumptions.
- External binary discovery prefers repo-local or install-managed paths (`build/opensplat`, `colmap-build/...`, `fastmap/run.py`, `hloc/`) via env vars (`OPENSPLAT_PATH`, `COLMAP_PATH`, `GLOMAP_PATH`, `FASTMAP_PATH`, `VOCAB_TREE_PATH`).
- Runtime directories (`uploads/`, `results/`, `frames/`, `vocab_trees/`) are created lazily and treated as ephemeral data.
- Background jobs run in `threading.Thread` with `RLock`-guarded project state; no Celery/queue.
- Subprocess output is streamed line-by-line via `core/commands.py` into both project logs and Socket.IO rooms.

## ANTI-PATTERNS
- Do not bypass `core/config.py` for binary/path lookup.
- Do not add background job logic in routes; push it into `pipeline/` stage modules or `services/`.
- Do not rely on interactive/manual test scripts (`test_*.py`, `run_*_test.py`) as if they were stable automated coverage - they are smoke/manual.
- Do not assume frontend build artifacts exist; `create_flask_app()` has a fallback path and logs when `.next` assets are absent.
- Do not introduce new Socket.IO state outside `project_id` rooms - threading model assumes in-process room state.

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
- `pipeline/stage_sparse.py` chooses among FastMap / COLMAP global mapper / legacy GLOMAP / incremental COLMAP / pycolmap - respect the preference order when modifying.
- `projects_db.json` is the persistent project index; `test.db*` files are SQLite artifacts from older flows.
- When changing environment/runtime behavior, sync `PobimSplatting/start.sh` and top-level docs.
