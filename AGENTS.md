# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-24T01:59:30Z
**Commit:** e2c95c8
**Branch:** main

## OVERVIEW
Monorepo for a local OpenSplat fork plus a web platform. Core stacks: C++/CMake native engine, Flask backend, Next.js 16 frontend, plus bundled `fastmap`, `hloc`, and vendored `colmap` code.

## STRUCTURE
```text
./
├── apps/                 # native CLI entrypoints
├── src/                  # native engine implementation
├── include/opensplat/    # native engine headers
├── rasterizer/           # GPU/CPU backend sources kept in place
├── PobimSplatting/       # web platform wrapper
│   ├── Backend/          # Flask API + pipeline orchestration
│   └── Frontend/         # Next.js app router UI
├── scripts/              # operational helpers; call these directly
├── docs/                 # canonical operator/install docs
├── colmap/               # vendored upstream source tree
├── hloc/                 # bundled localization toolbox
└── fastmap/              # bundled SfM package with optional CUDA extension
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Native engine build/layout | `CMakeLists.txt`, `apps/`, `src/`, `include/opensplat/` | `build/opensplat` output stays stable even if sources move |
| Web launch/orchestration | `install.sh`, `quick-start.sh`, `start.sh`, `PobimSplatting/start.sh` | root scripts are user-facing entrypoints |
| Backend runtime/config | `PobimSplatting/Backend/` | has child AGENTS.md |
| Frontend UI/client flow | `PobimSplatting/Frontend/` | has child AGENTS.md |
| Operator docs | `docs/DOCS_INDEX.md` | canonical docs hub |
| GPU/COLMAP helpers | `scripts/` | root wrappers were intentionally removed |

## CODE MAP
| Symbol / Root | Type | Location | Role |
|---------------|------|----------|------|
| `opensplat` | executable | `apps/opensplat.cpp` | native CLI entrypoint |
| `simple_trainer` | executable | `apps/simple_trainer.cpp` | native smoke/demo trainer |
| `Model` | C++ struct | `include/opensplat/model.hpp` + `src/model.cpp` | training/render core |
| `app` | Flask app | `PobimSplatting/Backend/app.py` | backend composition root |
| `runner.py` | pipeline module | `PobimSplatting/Backend/pipeline/runner.py` | bridges backend to native/CLI tools |
| `api.ts` | TS client | `PobimSplatting/Frontend/src/lib/api.ts` | shared REST client |
| `websocket.ts` | TS client | `PobimSplatting/Frontend/src/lib/websocket.ts` | shared realtime client |

## CONVENTIONS
- Native engine uses local fork layout: `apps/` + `src/` + `include/opensplat/`, while `rasterizer/` remains top-level.
- Treat `build/`, `colmap-build/`, `PobimSplatting/logs/`, `PobimSplatting/runtime/`, `uploads/`, `results/`, and similar runtime/generated areas as artifacts, not source.
- Call helper scripts through `./scripts/...`; only `install.sh`, `quick-start.sh`, `start.sh`, and `check-system.sh` should remain as root shell entrypoints.
- Python support is 3.10–3.12, with 3.12 preferred.
- Frontend production-style flow is `npm run build` then `npm run start`; hot reload is `npm run dev` only for local dev.

## ANTI-PATTERNS (THIS PROJECT)
- Never commit credentials, `.env` secrets, database files, or large/generated artifacts.
- Do not scatter runtime files outside their documented paths (`PobimSplatting/logs/`, `PobimSplatting/runtime/`, backend uploads/results folders).
- Do not reintroduce root-level wrapper scripts for helpers already living in `scripts/`.
- Do not assume vendored trees (`colmap/`, `hloc/third_party/`, libtorch headers) follow local project conventions.

## UNIQUE STYLES
- C++: 4-space indentation, same-line braces, camelCase functions, PascalCase types, ALL_CAPS constants.
- Python: snake_case functions, module-level ALL_CAPS config, practical script-heavy backend tests.
- React/Next: PascalCase components, kebab-case filenames where established, Tailwind over bespoke CSS.
- Prefer matching surrounding style over introducing formatter churn unless adding tooling hooks.

## COMMANDS
```bash
# native engine
mkdir -p build && cd build
cmake -DCMAKE_PREFIX_PATH=/path/to/libtorch ..
cmake --build .

# launcher / platform
./install.sh
./quick-start.sh
./start.sh status

# focused helpers
./scripts/simple_gpu_test.sh
python test_gpu_colmap.py
```

## NOTES
- Child AGENTS exist only for `PobimSplatting/Backend` and `PobimSplatting/Frontend`; keep native engine guidance here unless ownership splits further.
- `fastmap/` and `hloc/` are bundled toolboxes with their own upstream-style docs; mention them when relevant, but do not overfit root rules onto vendored/third-party subtrees.
- `docs/compile.md` and `docs/web-frontend-setup.md` are legacy-reference docs; prefer `README.md` and `docs/DOCS_INDEX.md`.
