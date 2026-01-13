# GLOMAP Acceleration - Detailed Implementation Plan

## Executive Summary

จากการวิเคราะห์พบว่า:
1. **COLMAP/GLOMAP ยังไม่ได้ build** - มีแค่ CMakeFiles ใน colmap-build/
2. **ต้อง rebuild COLMAP 3.14+ with CUDA** เพื่อให้ GLOMAP มี GPU support
3. **FastMap สามารถเพิ่มได้ง่าย** - interface เหมือน GLOMAP

---

## Phase 1: Fix GLOMAP CUDA (Priority 1)

### Problem Statement
- GLOMAP binary ปัจจุบันไม่มี CUDA support
- colmap-build/ มีแค่ CMakeFiles (build incomplete)
- ต้อง rebuild ทั้ง COLMAP + GLOMAP with CUDA

### Prerequisites Check

```bash
# ตรวจสอบ CUDA
nvcc --version
nvidia-smi

# ตรวจสอบ Ceres (ต้อง >= 2.2 for CUDA)
pkg-config --modversion ceres || echo "Ceres not found via pkg-config"
```

### Step 1.1: Install/Upgrade Ceres-Solver with CUDA

**ตรวจสอบ Ceres version:**
```bash
# Check if Ceres has CUDA
cat /usr/local/lib/cmake/Ceres/CeresConfig.cmake 2>/dev/null | grep -i cuda
```

**ถ้า Ceres < 2.2 หรือไม่มี CUDA, rebuild:**
```bash
cd /tmp
git clone https://github.com/ceres-solver/ceres-solver.git
cd ceres-solver
git checkout 2.2.0  # หรือ latest stable

mkdir build && cd build
cmake .. \
    -DCMAKE_BUILD_TYPE=Release \
    -DUSE_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89"

make -j$(nproc)
sudo make install
```

### Step 1.2: Rebuild COLMAP with CUDA + GLOMAP

**File to modify:** `/home/pobimgroup/A/POBIMOpenSplatting/rebuild-colmap-with-cuda.sh`

```bash
#!/bin/bash
set -e

PROJECT_ROOT="/home/pobimgroup/A/POBIMOpenSplatting"
COLMAP_SRC="$PROJECT_ROOT/colmap"
COLMAP_BUILD="$PROJECT_ROOT/colmap-build"

# Detect CUDA architecture
GPU_ARCH=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d '.')
echo "Detected GPU architecture: sm_$GPU_ARCH"

# Clean previous build
rm -rf "$COLMAP_BUILD"
mkdir -p "$COLMAP_BUILD"
cd "$COLMAP_BUILD"

# Configure with CUDA enabled
cmake "$COLMAP_SRC" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCUDA_ENABLED=ON \
    -DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCH" \
    -DGLOMAP_CUDA_ENABLED=ON \
    -DCMAKE_INSTALL_PREFIX=/usr/local

# Build
make -j$(nproc)

# Install (optional)
# sudo make install

# Create GLOMAP symlink
GLOMAP_BIN="$COLMAP_BUILD/src/glomap/glomap"
if [ -f "$GLOMAP_BIN" ]; then
    sudo ln -sf "$GLOMAP_BIN" /usr/local/bin/glomap
    echo "GLOMAP installed to /usr/local/bin/glomap"
    
    # Verify CUDA support
    $GLOMAP_BIN --help 2>&1 | head -5
fi

# Create COLMAP symlink
COLMAP_BIN="$COLMAP_BUILD/src/colmap/exe/colmap"
if [ -f "$COLMAP_BIN" ]; then
    sudo ln -sf "$COLMAP_BIN" /usr/local/bin/colmap
    echo "COLMAP installed to /usr/local/bin/colmap"
fi
```

### Step 1.3: Update runner.py with GPU Parameters

**File:** `PobimSplatting/Backend/pipeline/runner.py`
**Location:** After line 1164 (GLOMAP command construction)

```python
# After: cmd = [GLOMAP_PATH, 'mapper', ...]

# Add GPU acceleration parameters
if has_cuda:
    cmd.extend([
        '--GlobalPositioning.use_gpu', '1',
        '--GlobalPositioning.gpu_index', '0',
        '--GlobalPositioning.min_num_images_gpu_solver', '50',
        '--BundleAdjustment.use_gpu', '1', 
        '--BundleAdjustment.gpu_index', '0',
        '--BundleAdjustment.min_num_images_gpu_solver', '50',
    ])
    append_log_line(project_id, "🚀 GLOMAP GPU acceleration enabled (Global Positioning + Bundle Adjustment)")

# Add optional speed parameters
fast_sfm = config.get('fast_sfm', False)
if fast_sfm:
    cmd.extend([
        '--ba_iteration_num', '2',
        '--retriangulation_iteration_num', '0',
    ])
    append_log_line(project_id, "⚡ Fast SfM mode: reduced iterations")
```

### Step 1.4: Fix Frontend-Backend Bug

**File:** `PobimSplatting/Backend/routes/api.py`
**Location:** Line ~116, add to config extraction:

```python
config = {
    'quality_mode': quality_mode,
    'sfm_engine': request.form.get('sfm_engine', 'glomap'),  # ADD THIS
    'camera_model': request.form.get('camera_model', 'SIMPLE_RADIAL'),
    # ... rest of config
}
```

### Expected Results Phase 1

| Metric | Before | After |
|--------|--------|-------|
| GLOMAP CUDA | ❌ None | ✅ Enabled |
| Global Positioning | CPU | GPU (5-10x faster) |
| Bundle Adjustment | CPU | GPU (5-10x faster) |
| 100 images | ~2 min | ~20-30 sec |
| 500 images | ~15 min | ~2-3 min |

---

## Phase 2: Add FastMap Option (Priority 2)

### Overview
FastMap = PyTorch-based SfM ที่เร็วกว่า GLOMAP 10x แต่ robust น้อยกว่า

### Step 2.1: Clone FastMap

```bash
cd /home/pobimgroup/A/POBIMOpenSplatting
git clone https://github.com/pals-ttic/fastmap.git

# Install dependencies
cd fastmap
pip install trimesh "pyglet<2" pyyaml dacite loguru prettytable psutil
pip install git+https://github.com/jiahaoli95/pyrender.git

# Build CUDA kernels (highly recommended)
python setup.py build_ext --inplace
```

### Step 2.2: Add Binary Discovery

**File:** `PobimSplatting/Backend/core/config.py`
**Location:** After line 165 (after GLOMAP discovery)

```python
# FastMap discovery
FASTMAP_CANDIDATE_PATHS = [
    REPO_ROOT / "fastmap" / "run.py",
    Path("/usr/local/bin/fastmap"),
]

def get_fastmap_executable():
    """Get FastMap executable (Python script)."""
    for candidate in FASTMAP_CANDIDATE_PATHS:
        if candidate.is_file():
            return str(candidate)
    return None

FASTMAP_PATH = get_fastmap_executable()
```

### Step 2.3: Update Pipeline Runner

**File:** `PobimSplatting/Backend/pipeline/runner.py`

**At top (imports):**
```python
import sys
from .core import config as app_config
FASTMAP_PATH = app_config.get_fastmap_executable() if hasattr(app_config, 'get_fastmap_executable') else None
```

**In `run_sparse_reconstruction_stage()` (line ~1146):**
```python
sfm_engine = config.get('sfm_engine', 'glomap')
use_glomap = sfm_engine == 'glomap' and GLOMAP_PATH is not None
use_fastmap = sfm_engine == 'fastmap' and FASTMAP_PATH is not None

if use_fastmap:
    append_log_line(project_id, "⚡ Running FastMap Structure-from-Motion (First-Order Optimization)")
    append_log_line(project_id, f"🎯 Best for dense scene coverage ({num_images} images)")
    
    cmd = [
        sys.executable or 'python3',
        FASTMAP_PATH,
        '--database', str(paths['database_path']),
        '--image_dir', str(paths['images_path']),
        '--output_dir', str(paths['sparse_path']),
        '--headless'
    ]
    
    # Add GPU if available
    try:
        import torch
        if torch.cuda.is_available():
            cmd.extend(['--device', 'cuda:0'])
            append_log_line(project_id, "🎮 CUDA acceleration enabled")
    except ImportError:
        pass
    
    # FastMap outputs to sparse/0/ automatically (COLMAP format)
    
elif use_glomap:
    # ... existing GLOMAP code
else:
    # ... existing COLMAP code
```

### Step 2.4: Update Frontend UI

**File:** `PobimSplatting/Frontend/src/app/upload/page.tsx`

**Add FastMap radio button (after GLOMAP option, ~line 810):**
```tsx
{/* FastMap Option */}
<label className={`flex-1 p-4 rounded-xl border-2 cursor-pointer transition-all ${
  config.sfm_engine === 'fastmap'
    ? 'border-purple-500 bg-purple-50 shadow-md'
    : 'border-gray-200 bg-white hover:border-purple-300'
}`}>
  <input
    type="radio"
    name="sfm_engine"
    value="fastmap"
    checked={config.sfm_engine === 'fastmap'}
    onChange={(e) => setConfig({ ...config, sfm_engine: e.target.value })}
    className="sr-only"
  />
  <div className="flex items-center justify-between">
    <div>
      <span className="font-bold text-purple-700 text-lg">⚡ FastMap</span>
      <span className="ml-2 px-2 py-0.5 bg-purple-500 text-white text-xs rounded-full">NEW</span>
    </div>
    <span className="text-purple-600 font-semibold">10x Faster</span>
  </div>
  <p className="text-sm text-gray-600 mt-2">
    First-order SfM optimized for GPU. 
    <strong className="text-purple-700"> Best for video/dense scenes.</strong>
  </p>
  <div className="mt-2 text-xs">
    <span className="text-green-600">✓ GPU-native</span>
    <span className="text-green-600 ml-2">✓ Dense coverage</span>
    <span className="text-yellow-600 ml-2">⚠️ Less robust</span>
  </div>
</label>
```

### Step 2.5: Add Warning for FastMap

**In upload page, add warning when FastMap selected:**
```tsx
{config.sfm_engine === 'fastmap' && (
  <div className="mt-3 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
    <p className="text-sm text-yellow-800">
      <strong>⚠️ FastMap Notice:</strong> Best for video frames with dense scene coverage. 
      May fail on sparse photo collections or low-quality images. 
      Use GLOMAP or COLMAP for more robust results.
    </p>
  </div>
)}
```

### Expected Results Phase 2

| Engine | Speed | Robustness | Best For |
|--------|-------|------------|----------|
| COLMAP | 1x | ⭐⭐⭐⭐⭐ | Any scene |
| GLOMAP | 10-100x | ⭐⭐⭐⭐ | Most scenes |
| FastMap | 100-1000x | ⭐⭐⭐ | Dense/video |

---

## File Change Summary

### Phase 1 (GLOMAP CUDA)
| File | Change Type | Priority |
|------|-------------|----------|
| `rebuild-colmap-with-cuda.sh` | Create/Update | High |
| `runner.py:1164+` | Add GPU params | High |
| `api.py:116` | Fix sfm_engine extraction | High |

### Phase 2 (FastMap)
| File | Change Type | Priority |
|------|-------------|----------|
| `config.py:165+` | Add FASTMAP discovery | Medium |
| `runner.py:1+,1146+` | Add FastMap branch | Medium |
| `upload/page.tsx:810+` | Add FastMap UI | Medium |
| `projects/[id]/page.tsx:35+` | Add FastMap labels | Low |

---

## Testing Checklist

### Phase 1 Tests
- [ ] `nvcc --version` shows CUDA
- [ ] `glomap --help` shows "with CUDA" (not "NOT compiled CUDA")
- [ ] Small dataset (50 images) completes faster than before
- [ ] GPU utilization visible in `nvidia-smi` during GLOMAP

### Phase 2 Tests
- [ ] FastMap option visible in upload UI
- [ ] FastMap processes video frames successfully
- [ ] Output compatible with OpenSplat (sparse/0/ format)
- [ ] Warning shown when FastMap selected

---

## Rollback Plan

### Phase 1 Rollback
```bash
# Restore old COLMAP binary if issues
sudo rm /usr/local/bin/glomap
sudo rm /usr/local/bin/colmap
# Pipeline will fallback to COLMAP without GPU
```

### Phase 2 Rollback
- Simply don't select "FastMap" in UI
- Remove FastMap code from runner.py
- No impact on existing COLMAP/GLOMAP functionality

---

## Timeline Estimate

| Phase | Tasks | Time |
|-------|-------|------|
| Phase 1 | Rebuild COLMAP+GLOMAP, update runner.py, fix API bug | 2-3 days |
| Phase 2 | Clone FastMap, integrate pipeline, update UI | 1-2 days |
| Testing | Test both phases on various datasets | 1 day |
| **Total** | | **4-6 days** |

---

*Plan created: 2026-01-13*
*Author: Sisyphus Planner*
