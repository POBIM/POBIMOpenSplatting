# สรุปการแก้ไขให้ Sparse Reconstruction ใช้ GPU (COLMAP Global Mapper)

**วันที่:** 2026-04-22
**Commits:** `71d8e42`, `e8c64c8`, `0f25f1f`
**ผล:** Sparse phase เร็วขึ้นจาก ~6 นาที → **46 วินาที** (~8× speedup), 200/200 ภาพ registered

---

## 1. ปัญหาเดิม (Root Cause)

จาก log ของ project `9f4a1d5b-0564-4903-9d4c-a72848a9ef33`:

```
🔁 Falling back from global SfM to COLMAP incremental SfM:
   Ordered video/orbit frames...
```

Pipeline เลือกใช้ **COLMAP incremental mapper** (CPU-only) แทน **global_mapper** (GPU) ทุกครั้งที่พบรูปแบบ ordered video/orbit หรือ exhaustive matching — ทำให้ GPU idle ใน sparse phase

### สาเหตุย่อย 3 จุด

1. **`should_prefer_incremental_sfm()` default = `True`**
   ฟังก์ชันนี้มี heuristic 3 ข้อ (robust / exhaustive / ordered-video) ที่ push ให้ใช้ incremental โดยอัตโนมัติ แม้ GPU พร้อม

2. **`colmap mapper` รับ flag ผิด**
   โค้ดส่ง `--BundleAdjustmentCeres.*` เข้า `colmap mapper` ซึ่งเป็น flag ของ `colmap bundle_adjuster` เท่านั้น → mapper reject args, fallback ต่อ

3. **`start.sh` ไม่ set `LD_LIBRARY_PATH`**
   pycolmap/lightglue โหลด `libonnxruntime.so.1` ไม่เจอตอน backend start → feature extractor path ล้ม

---

## 2. การแก้ไข

### 2.1 Backend Pipeline — commit `71d8e42`

**`PobimSplatting/Backend/pipeline/config_builders.py` (บรรทัด 399-428)**
- กลับ default ของ `should_prefer_incremental_sfm()` → คืน `(False, None)` โดย default
- Heuristic 3 ข้อย้ายไปเป็น **opt-in** ผ่าน `config['prefer_incremental_sfm'] = True`
- ผลลัพธ์: ทุกโปรเจกต์เริ่มต้นด้วย **COLMAP global_mapper (GPU)** ก่อนเสมอ

**`PobimSplatting/Backend/pipeline/stage_sparse.py`**
- ลบ `--BundleAdjustmentCeres.*` ออกจาก `colmap mapper` args (flag ไม่มีจริง)
- แยก args ของ global_mapper ตาม backend:
  - **GLOMAP legacy**: `--GlobalPositioning.*`, `--BundleAdjustment.*`
  - **COLMAP global_mapper**: `--GlobalMapper.gp_use_gpu 1`, `--GlobalMapper.ba_ceres_use_gpu 1`
- เพิ่ม `_log_colmap_ba_plan()` log แผน Bundle Adjustment ก่อนรัน

**`PobimSplatting/Backend/pipeline/runtime_support.py`**
- เพิ่ม `runtime_summary` ใน `describe_colmap_bundle_adjustment_mode()` รายงาน Ceres/CUDA/cuDSS capability

### 2.2 Launcher / Scripts — commit `e8c64c8`

**`PobimSplatting/start.sh` → `start_backend()`**
```bash
export LD_LIBRARY_PATH="${REPO_ROOT}/colmap-build/_deps/onnxruntime-build/lib:${LD_LIBRARY_PATH}"
```
ทำให้ pycolmap โหลด onnxruntime สำเร็จ (lightglue feature matcher ใช้ได้)

**`scripts/colmap-build-common.sh` (ใหม่)**
Factor logic ร่วมของ 3 สคริปต์ rebuild (`rebuild-colmap-{cloud,with-cuda,with-gui}.sh`) + `install.sh` — ลดโค้ดซ้ำ

### 2.3 Frontend Sync — commit `0f25f1f`
Bulk sync UI drift ที่ค้างอยู่ (32 ไฟล์ .tsx/.css) — ไม่เกี่ยวกับ GPU fix โดยตรง

---

## 3. ผลลัพธ์ (Verified Live Run)

| ตัวชี้วัด | ก่อนแก้ | หลังแก้ |
|---|---|---|
| Sparse backend | COLMAP incremental (CPU) | COLMAP global_mapper (GPU) |
| Sparse duration | ~6 นาที | **46 วินาที** |
| Registered images | 200/200 | 200/200 |
| 3D points | — | 29,510 |
| Training splats | — | 467,485 |
| Fallback line | ปรากฏ 🔁 | **ไม่ปรากฏ** |
| Pipeline completed | ✅ | ✅ |

Log ที่ยืนยัน GPU ถูกใช้จริง:
```
🚀 Running COLMAP Global Mapper
  --GlobalMapper.gp_use_gpu 1
  --GlobalMapper.ba_ceres_use_gpu 1
[GLOMAP] Rotation Averaging
[GLOMAP] Global Positioning
[GLOMAP] Bundle Adjustment 1/3, 2/3, 3/3
🎉 PobimSplats processing completed successfully!
```

---

## 4. สิ่งที่ควรรู้เพิ่มเติม

### ทำไม incremental mapper ถึงดู "GPU idle"
COLMAP **incremental mapper's registration loop ออกแบบให้เป็น CPU-only** โดยดีไซน์ — มีเพียง Bundle Adjustment step เท่านั้นที่ข้ามไป GPU ได้ ดังนั้น
หากต้องการ GPU เต็มรูปแบบใน sparse phase ต้องใช้ **global_mapper** (GLOMAP-style) เท่านั้น

### Ceres / cuDSS behavior
- COLMAP binary ที่ build ไว้ link `libcudss.so.0`, `libcusolver`, `libcublas`, `libcusparse`
- BA ที่ ≤200 ภาพใช้ **DENSE_SCHUR (cuSolver)** — ไม่ใช่ SPARSE_SCHUR (cuDSS)
- Threshold สลับไป cuDSS: `num_images > 200`
- System libceres (2.2.0 Ubuntu) **ไม่เกี่ยวข้อง** — COLMAP ใช้ Ceres ที่ statically linked ของตัวเอง

### การเปิด fallback กลับ (ถ้าจำเป็น)
```python
config['prefer_incremental_sfm'] = True  # opt-in กลับ
```

---

## 5. ไฟล์ที่แก้ไขทั้งหมด

```
PobimSplatting/Backend/pipeline/config_builders.py
PobimSplatting/Backend/pipeline/stage_sparse.py
PobimSplatting/Backend/pipeline/stage_training.py
PobimSplatting/Backend/pipeline/runner.py
PobimSplatting/Backend/pipeline/runtime_support.py
PobimSplatting/Backend/test_pipeline_stage_smoke.py        (9/9 pass)
PobimSplatting/start.sh
install.sh
scripts/rebuild-colmap-{cloud,with-cuda,with-gui}.sh
scripts/colmap-build-common.sh                              (ใหม่)
.gitignore                                                  (+ceres-build/, ceres-solver/, cudss-shim/, .opencode/)
```

## 6. คำสั่ง Verify

```bash
source PobimSplatting/Backend/venv/bin/activate
export LD_LIBRARY_PATH=/home/pobimgroup/A/POBIMOpenSplatting/colmap-build/_deps/onnxruntime-build/lib
python -m unittest PobimSplatting.Backend.test_pipeline_stage_smoke
# Expected: Ran 9 tests ... OK
```
