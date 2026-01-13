# GLOMAP Acceleration Plan

## Executive Summary

GLOMAP ใน POBIMOpenSplatting ปัจจุบัน **ไม่ได้ compile กับ CUDA** ทำให้ GPU acceleration ไม่ทำงาน แม้จะเป็น Global SfM ที่เร็วกว่า COLMAP 10-100x แต่ยังมี bottlenecks และ bugs ที่ต้องแก้

---

## Current State Analysis

### ✅ What Works
- GLOMAP binary exists at `/usr/local/bin/glomap`
- Pipeline integration complete (runner.py lines 1139-1420)
- Progress tracking for 9 sub-stages
- Falls back to COLMAP if GLOMAP unavailable

### ❌ Critical Issues
1. **NO CUDA**: Binary reports "NOT compiled CUDA!" - GPU options exist but don't work
2. **Frontend Bug**: `sfm_engine` selection NOT sent to backend (api.ts missing parameter)
3. **No GPU params passed**: Even if CUDA was available, GPU parameters not in command

### 📊 Current Bottlenecks (from research)
| Stage | Time Impact | Root Cause |
|-------|-------------|------------|
| Relative Pose Estimation | 1-30+ mins | 50,000 RANSAC iterations default |
| Global Bundle Adjustment | Hours on large datasets | Second-order Gauss-Newton |
| Feature Matching | Variable | Sequential matching overhead |

---

## Implementation Plan

### Phase 1: Quick Wins (No Rebuild Required)
**Effort: Low | Impact: Medium | Time: 1-2 days**

#### Task 1.1: Fix Frontend-Backend Bug
**Files:**
- `PobimSplatting/Frontend/src/lib/api.ts`
- `PobimSplatting/Backend/routes/api.py`

**Changes:**
```typescript
// api.ts - Add to upload FormData
formData.append('sfm_engine', config.sfm_engine);
```

```python
# api.py - Add to config parsing
'sfm_engine': request.form.get('sfm_engine', 'glomap')
```

#### Task 1.2: Add GLOMAP Parameter Tuning
**File:** `PobimSplatting/Backend/pipeline/runner.py` (after line 1164)

**Changes:**
```python
# Speed optimization parameters
cmd.extend([
    '--ba_iteration_num', '2',           # Reduce from 3 (default)
    '--retriangulation_iteration_num', '0',  # Skip retriangulation
])

# For ultra-fast mode (optional flag)
if config.get('fast_sfm', False):
    cmd.extend([
        '--skip_retriangulation', '1',
        '--skip_pruning', '1',
    ])
```

#### Task 1.3: Add Fast SfM Toggle to Frontend
**File:** `PobimSplatting/Frontend/src/app/upload/page.tsx`

**Changes:**
- Add `fast_sfm: false` to config state
- Add toggle UI similar to GPU Acceleration toggle
- Label: "Fast SfM Mode" / "ลด iterations เพื่อความเร็ว (อาจลดคุณภาพเล็กน้อย)"

---

### Phase 2: Rebuild GLOMAP with CUDA
**Effort: Medium | Impact: High | Time: 2-3 days**

#### Prerequisites
- Ceres-Solver ≥ 2.3 compiled with `USE_CUDA=ON`
- cuDSS library (for sparse CUDA support)
- COLMAP compiled with CUDA

#### Task 2.1: Rebuild Ceres with CUDA
```bash
cd /tmp
git clone https://github.com/ceres-solver/ceres-solver.git
cd ceres-solver
mkdir build && cd build
cmake .. \
    -DUSE_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89" \
    -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
sudo make install
```

#### Task 2.2: Rebuild COLMAP + GLOMAP with CUDA
```bash
cd /home/pobimgroup/A/POBIMOpenSplatting
# Modify rebuild script or run manually:
cd colmap-build
cmake .. \
    -DCUDA_ENABLED=ON \
    -DGLOMAP_CUDA_ENABLED=ON \
    -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89"
make -j$(nproc)
```

#### Task 2.3: Add GPU Parameters to Runner
**File:** `PobimSplatting/Backend/pipeline/runner.py`

**Changes:**
```python
# After GLOMAP command construction (line 1164)
if has_cuda:
    cmd.extend([
        '--GlobalPositioning.use_gpu', '1',
        '--GlobalPositioning.gpu_index', '0',
        '--GlobalPositioning.min_num_images_gpu_solver', '50',
        '--BundleAdjustment.use_gpu', '1',
        '--BundleAdjustment.gpu_index', '0',
        '--BundleAdjustment.min_num_images_gpu_solver', '50',
    ])
    append_log_line(project_id, "🚀 GLOMAP GPU acceleration enabled")
```

#### Task 2.4: Update Install Script
**File:** `install.sh`

Add CUDA detection and conditional GLOMAP build with GPU support.

---

### Phase 3: Advanced Optimizations (Optional)
**Effort: High | Impact: Very High | Time: 1-2 weeks**

#### Option A: Integrate FastMap (2025)
- 10x faster than GLOMAP with GPU
- First-order optimization (better scalability)
- Requires significant integration work
- Paper: https://arxiv.org/abs/2505.04612

#### Option B: Hybrid Pipeline
- Use GLOMAP for initial reconstruction
- Use COLMAP for refinement (has working GPU BA)
- Best of both worlds

#### Option C: Distributed Matching
- For very large datasets (>1000 images)
- Split matching across multiple GPUs/nodes
- Requires infrastructure changes

---

## File Change Summary

| File | Phase | Type |
|------|-------|------|
| `Frontend/src/lib/api.ts` | 1 | Bug Fix |
| `Backend/routes/api.py` | 1 | Bug Fix |
| `Backend/pipeline/runner.py` | 1, 2 | Feature |
| `Frontend/src/app/upload/page.tsx` | 1 | UI |
| `install.sh` | 2 | Build |
| Ceres/COLMAP rebuild | 2 | Infrastructure |

---

## Expected Performance Gains

| Scenario | Current | After Phase 1 | After Phase 2 |
|----------|---------|---------------|---------------|
| 100 images | ~2 min | ~1.5 min | ~30 sec |
| 500 images | ~15 min | ~10 min | ~2 min |
| 1000 images | ~45 min | ~30 min | ~5 min |
| 3000 images | 2+ hours | ~1.5 hours | ~15 min |

*Estimates based on GLOMAP paper benchmarks and CUDA acceleration factors*

---

## Testing Strategy

1. **Unit Test**: Verify sfm_engine parameter flows from frontend to backend
2. **Integration Test**: Run small dataset (50 images) with each configuration
3. **Benchmark Test**: Compare COLMAP vs GLOMAP vs GLOMAP+CUDA on standardized dataset
4. **Regression Test**: Ensure reconstruction quality not degraded

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Ceres CUDA build fails | High | Use pre-built binaries or Docker |
| Quality degradation with fast mode | Medium | Make fast_sfm optional, warn users |
| GPU OOM on large datasets | Medium | Add min_num_images_gpu_solver threshold |
| Version mismatch errors | High | Build GLOMAP with exact COLMAP version |

---

## Recommendation

**Start with Phase 1** (1-2 days) - immediate wins without rebuilding:
1. Fix frontend bug (critical)
2. Add parameter tuning
3. Test improvement

**Then Phase 2** if Phase 1 shows promise and GPU acceleration is priority.

---

## References

- GLOMAP Paper: https://arxiv.org/abs/2407.20219
- GLOMAP GitHub: https://github.com/colmap/glomap
- Ceres CUDA: https://github.com/ceres-solver/ceres-solver
- FastMap (2025): https://arxiv.org/abs/2505.04612

---

## Appendix: FastMap Deep Dive

### What is FastMap?

**FastMap** เป็น Global SfM pipeline ใหม่ล่าสุด (3DV 2026 Oral) เขียนด้วย **PyTorch** ออกแบบมาสำหรับ dense 3D reconstruction (NeRF, 3DGS)

- **Paper**: https://arxiv.org/abs/2505.04612
- **GitHub**: https://github.com/pals-ttic/fastmap (MIT License)
- **Authors**: Jiahao Li et al. (TTIC - Toyota Technological Institute at Chicago)

### Key Technical Innovation

#### 1. First-Order Optimization Only
| Aspect | COLMAP/GLOMAP | FastMap |
|--------|---------------|---------|
| Optimization | Second-order Gauss-Newton | First-order only |
| Complexity per step | O(keypoints × 3D points) | O(image pairs) |
| Memory | High for large scenes | Efficient |

#### 2. Epipolar Adjustment (replaces Bundle Adjustment)
- ใช้ IRLS (Iterative Re-weighted Least Squares)
- L1 loss minimization สำหรับ robustness
- Complexity เป็น **linear** กับจำนวน image pairs

#### 3. GPU-Native Design
- Custom CUDA kernels with kernel fusion
- ลด overhead จาก deep learning frameworks
- สามารถ compile kernel เพิ่มเติม: `python setup.py build_ext --inplace`

### Installation Requirements

```bash
# 1. PyTorch (ต้องมี CUDA)
pip install torch torchvision

# 2. Dependencies
pip install trimesh "pyglet<2" pyyaml dacite loguru prettytable psutil
pip install git+https://github.com/jiahaoli95/pyrender.git

# 3. COLMAP (for feature matching only)
# FastMap uses COLMAP's database format

# 4. (Highly Recommended) Custom CUDA kernels
python setup.py build_ext --inplace
```

### Usage Pattern

```bash
# Step 1: Feature extraction (COLMAP)
colmap feature_extractor --database_path db.db --image_path images/

# Step 2: Feature matching (COLMAP)
colmap exhaustive_matcher --database_path db.db

# Step 3: Pose estimation (FastMap - 10x faster!)
python run.py --database db.db --image_dir images/ --output_dir output/
```

### Performance Numbers

| Dataset | COLMAP | GLOMAP | FastMap | Speedup |
|---------|--------|--------|---------|---------|
| Small (100s imgs) | mins | tens of secs | secs | 5-10x |
| Medium (1000s imgs) | hours | mins | mins | 10x |
| Large (thousands) | days | hours | tens of mins | 10-100x |

### Limitations (Important!)

1. **ต้องการ dense coverage** - ภาพต้องถ่ายครอบคลุมดี
2. **Less robust than COLMAP/GLOMAP** สำหรับ:
   - Sparse scene coverage
   - Low quality matching
   - Degenerate motions (colinear translation)
3. **Prone to catastrophic failures** ในบาง edge cases
4. **Single GPU only** - ยังไม่ support multi-GPU

### Integration Options for POBIMOpenSplatting

#### Option A: Side-by-side (Recommended)
- เพิ่ม FastMap เป็น SfM engine option ที่ 3
- User เลือก: COLMAP / GLOMAP / FastMap
- ไม่กระทบ code เดิม

#### Option B: Hybrid Pipeline
- ใช้ FastMap สำหรับ initial pose estimation (fast)
- ใช้ COLMAP/GLOMAP refinement (accurate)

#### Option C: Full Replacement
- แทนที่ GLOMAP ด้วย FastMap
- Risk: Less robust, อาจ fail บาง datasets

### Recommendation

**สำหรับ POBIMOpenSplatting:**

1. **Phase 1 (แนะนำ)**: Fix GLOMAP CUDA ก่อน - เพราะ GLOMAP มี robustness สูงกว่า
2. **Phase 2 (ถ้าต้องการเร็วกว่าอีก)**: เพิ่ม FastMap เป็น option ที่ 3
3. **Target use case**: FastMap เหมาะกับ video frames (dense coverage) มากกว่า random photos

### Configuration Reference

FastMap config options (`fastmap/config.py`):
```yaml
distortion: 
  num_levels: 5
epipolar_adjustment:
  num_irls_steps: 4
  num_prune_steps: 2
sparse_reconstruction:
  reproj_err_thr: 10.0
```

---

*Plan updated with FastMap research - 2026-01-13*
