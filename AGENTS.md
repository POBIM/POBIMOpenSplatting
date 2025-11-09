# Repository Guidelines

## Project Structure & Module Organization
The C++ gaussian splatting engine lives at the repo root (`model.cpp`, `rasterize_gaussians.cpp`, `rasterizer/`) with build outputs in `build/` and vendored COLMAP under `colmap-build/`. Media inputs and generated splats stay under `datasets/`, `frames/`, `uploads/`, and `results/`. The orchestration stacks are `PobimSplats/` (Flask backend plus Tailwind viewer assets) and `PobimSplatting/` (Next.js frontend in `Frontend/`, Flask API in `Backend/`). Treat `uploads/` and `results/` as ephemeral; keep third-party binaries out of git.

## Build, Test, and Development Commands
Build the native engine via:
```bash
mkdir -p build && cd build
cmake -DCMAKE_PREFIX_PATH=/path/to/libtorch .. && make -j$(nproc)
```
Add `-DGPU_RUNTIME=HIP` or `-DGPU_RUNTIME=MPS` for AMD or Apple targets. Start PobimSplats with `cd PobimSplats && ./start.sh`. For PobimSplatting run `npm run dev` inside `PobimSplatting/Frontend` and `source venv/bin/activate && python app.py` inside `PobimSplatting/Backend`. Validate GPU integration through `./simple_gpu_test.sh` or `python test_gpu_colmap.py`.

## Coding Style & Naming Conventions
C++ sources use 4-space indentation, braces on the same line, camelCase functions, and PascalCase types; keep constants in ALL_CAPS and prefer `torch::` utilities over raw CUDA calls. Python services follow snake_case functions with module-level ALL_CAPS configuration, while React/Next components stay PascalCase with kebab-case filenames and Tailwind utilities rather than bespoke CSS. Apply `clang-format` or `black` only if you introduce tooling hooks—otherwise mirror the surrounding style.

## Testing Guidelines
Run `pytest PobimSplats/test_websocket.py` for WebSocket regressions and `python test_gpu_colmap.py` whenever COLMAP paths or GPU detection change. After native edits rebuild with `cmake --build .` (add `-DOPENSPLAT_BUILD_SIMPLE_TRAINER=ON` if training code is touched). Capture manual reproduction steps and sample output paths in PR notes, especially for GPU-only fixes.

## Commit & Pull Request Guidelines
Use conventional commits (`feat: …`, `fix: …`, `docs: …`) mirroring existing history. Keep commits focused and include configuration or documentation updates alongside code. PRs should explain motivation, list local testing across CPU/GPU, call out new environment variables, and attach screenshots or sample splat paths in `results/` for UI changes.

## Security & Configuration Tips
Store secrets in `.env` files (`PobimSplats/.env`, `PobimSplatting/Backend/.env`) and never commit credentials, database files, or large artifacts. Reuse `secure_filename` and the existing validation helpers for uploads. Gate new hardware-specific paths or binaries behind configuration toggles so shared CI environments can remain CPU-only.
