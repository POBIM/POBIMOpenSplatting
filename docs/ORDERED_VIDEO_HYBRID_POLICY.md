# Ordered Video Hybrid Policy

This branch combines the `origin/main` resource-aware pipeline with the selective GPU features from the `GPU` branch.

## Default behavior

- Ordered video and orbit-style captures stay on the CPU-first incremental COLMAP path by default.
- Auto-tuning may adjust extraction density, matching expansion, and recovery thresholds.
- Auto-tuning must not silently switch ordered-video runs to a GPU-first global mapper policy.

## Where GPU still helps

- Video extraction can continue to use GPU acceleration when available.
- Gaussian splat training remains GPU-first.
- Unordered photo sets can still use global/GPU sparse reconstruction when policy allows it.
- Sparse retry can explicitly override the engine to `glomap` or `fastmap`.
- Sparse retry can explicitly force CPU-only sparse reconstruction for A/B comparison.

## Operator-facing surfaces

- Upload preview still shows adaptive frame budget, adaptive pair scheduling, and auto-tuning summaries from `origin/main`.
- Project detail now exposes the execution-policy summary, live sparse camera-pose snapshots, and training splat previews.
- Sparse retry exposes engine override and CPU-force options without adding a separate mode system.

## Intended outcome

- Ordered video stays stable by default.
- GPU remains available where it provides the most value.
- Runtime adaptation remains visible and explicit rather than silently changing the reconstruction family.
