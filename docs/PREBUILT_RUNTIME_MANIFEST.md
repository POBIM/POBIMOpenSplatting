# Prebuilt Runtime Artifacts

ไฟล์กลุ่มนี้คือของที่เหมาะสำหรับแพ็กขึ้น Google Drive แล้วใช้เป็น `prebuilt artifacts` แทนการ build ใหม่ทั้งชุดบนเครื่องปลายทาง

## ควรใส่ในแพ็ก

ไฟล์หลัก:

- `build/opensplat`
- `build/simple_trainer`
- `colmap-build/install/bin/colmap`
- `colmap-build/src/glomap/glomap`

runtime library ที่ตาม `colmap`:

- `colmap-build/install/lib/*.so*`

FastMap:

- `fastmap/run.py`
- `fastmap/fastmap/*.py`
- `fastmap/fastmap/cuda.so`

hloc source ที่ backend อ้างใช้:

- `hloc/setup.py`
- `hloc/requirements.txt`
- `hloc/hloc/*.py`

## ไม่ควรใส่ในแพ็ก

- `PobimSplatting/Backend/uploads/`
- `PobimSplatting/Backend/results/`
- `PobimSplatting/Backend/frames/`
- `PobimSplatting/Backend/projects_db.json`
- `PobimSplatting/logs/`
- `PobimSplatting/runtime/`
- `.venv`, `venv`, `node_modules`, `.next`
- `.git`, build temp files, cache files, `__pycache__`

## วิธีแพ็ก

ใช้สคริปต์นี้:

```bash
./scripts/package_prebuilt_runtime.sh
```

หรือระบุ output dir:

```bash
./scripts/package_prebuilt_runtime.sh /tmp/pobim-prebuilt
```

สคริปต์จะสร้าง tarball ที่แตกทับลง root repo ได้ทันที

## หมายเหตุ

- แพ็กนี้ช่วยเลี่ยงเวลาคอมไพล์ `opensplat` / `colmap` / `glomap`
- ยังต้องคุม compatibility ของ `glibc`, CUDA/ROCm, driver และ architecture ของเครื่องปลายทาง
- ถ้าเครื่องปลายทางต่าง environment มาก ควรแยกแพ็กตาม platform เช่น `ubuntu22.04-cuda12.1`, `ubuntu24.04-rocm6.4`
