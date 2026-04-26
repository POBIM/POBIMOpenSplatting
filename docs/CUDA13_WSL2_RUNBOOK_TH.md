# CUDA 13.0 WSL2 Runbook

เอกสารนี้เป็นฐานความรู้สำหรับการใช้ POBIMOpenSplatting กับ CUDA 13.0 บน WSL2 โดยยังเก็บ CUDA 12.6 ไว้เป็น fallback.

## สรุปมาตรฐาน

- CUDA toolkit หลัก: `/usr/local/cuda-13.0`
- CUDA fallback: `/usr/local/cuda-12.6`
- OpenSplat LibTorch: `libtorch-cuda130`
- Local GPU architecture: `89` สำหรับ RTX 4060 Laptop
- CUDA 13 compatibility architectures: `75;80;86;89`
- COLMAP default build: CUDA on, headless, GUI off
- `/usr/local/cuda` ไม่จำเป็นต้องชี้ CUDA 13 เพราะ scripts ใช้ path explicit

## ทำไมใช้ CUDA 13

CUDA 13 เหมาะกับ RTX 4060 Laptop เพราะเป็น Ada Lovelace compute capability `8.9`, ใช้ runtime ใหม่กว่า, และมี LibTorch `cu130` ที่ตรงกับ toolkit. โปรเจกต์จึงตั้ง default เป็น CUDA 13 แต่ไม่ลบ CUDA 12.6 เพื่อให้ rollback ได้.

ข้อควรจำ: CUDA 13 ไม่ควรใช้ default arch เก่าอย่าง `70`; โปรเจกต์ใช้ `75;80;86;89` แทน และ focused local build ใช้ `89`.

## Install Flow

คำสั่งหลัก:

```bash
./install.sh
```

พฤติกรรมปัจจุบัน:

1. ถ้ายังไม่มี `/usr/local/cuda-13.0/bin/nvcc`, installer จะเสนอให้ติดตั้ง CUDA 13.0
2. บน WSL2 จะใช้ `scripts/setup-cuda130-wsl.sh`
3. สคริปต์ CUDA 13 ติดตั้ง toolkit-only และไม่ติดตั้ง Linux driver package ใน WSL
4. CUDA 12.6 ที่มีอยู่จะถูกเก็บไว้เป็น fallback
5. Build flow จะ detect CUDA 13 ก่อน CUDA 12.6

ถ้ารันแบบไม่มี TTY และ sudo ต้องใช้ password:

```bash
CUDA_SUDO_PASSWORD=123456 ./install.sh
```

## OpenSplat CUDA 13

Focused rebuild:

```bash
./scripts/compile-opensplat-cuda130.sh
```

สคริปต์นี้ใช้:

- `CUDA_DIR=/usr/local/cuda-13.0`
- `CUDA_ARCH=89`
- LibTorch `2.10.0+cu130`
- install dir `libtorch-cuda130`
- output `build/opensplat`

ตรวจผล:

```bash
LD_LIBRARY_PATH="$PWD/libtorch-cuda130/lib:/usr/local/cuda-13.0/lib64:$LD_LIBRARY_PATH" ./build/opensplat --version
```

ตรวจ linkage:

```bash
LD_LIBRARY_PATH="$PWD/libtorch-cuda130/lib:/usr/local/cuda-13.0/lib64:$LD_LIBRARY_PATH" \
  ldd build/opensplat | rg 'libtorch|libcudart|not found'
```

ควรเห็น `libtorch-cuda130` และ `libcudart.so.13`.

## COLMAP / Ceres CUDA 13

Focused rebuild:

```bash
CUDA_HOME=/usr/local/cuda-13.0 ./scripts/rebuild-colmap-cloud.sh
```

ค่า default:

- CUDA: `/usr/local/cuda-13.0`
- GPU arch: `89`
- Ceres install: `ceres-build/install`
- COLMAP binary: `colmap-build/src/colmap/exe/colmap`
- system symlink: `/usr/local/bin/colmap`

สำหรับ CUDA 13 สคริปต์จะปิด cuDSS CUDA 12 shim อัตโนมัติ เพื่อไม่ให้ binary ต้องหา `libcublas.so.12`.

ตรวจผล:

```bash
colmap -h | head -1
ldd colmap-build/src/colmap/exe/colmap | rg 'libcudart|libcublas|libcudss|not found'
```

ผลที่ต้องการ:

- `COLMAP ... with CUDA`
- `libcudart.so.13`
- `libcublas.so.13`
- ไม่มี `not found`
- ไม่มี `libcudss` CUDA 12 ปนใน CUDA 13 build

## Runtime Detection

`start.sh` และ quick-start ที่ `install.sh` สร้างใหม่จะเลือก LibTorch ตามลำดับ:

1. `libtorch-cuda130`
2. `libtorch-cuda126`
3. `libtorch-cuda121`
4. `libtorch-cuda118`
5. `libtorch-cpu`

ดังนั้นถ้า CUDA 13 build พร้อม ระบบจะใช้ CUDA 13 ก่อน.

## Health Checks

```bash
bash ./check-system.sh
python3 test_gpu_colmap.py
bash ./scripts/simple_gpu_test.sh
./start.sh status
```

ผลที่ต้องการ:

- CUDA 13.0 detected ที่ `/usr/local/cuda-13.0`
- COLMAP: GPU-enabled
- OpenSplat: Built
- GPU: NVIDIA GeForce RTX 4060 Laptop GPU

## Troubleshooting

### `libcublas.so.12: not found`

มักเกิดจาก Ceres/COLMAP ลิงก์ cuDSS CUDA 12 shim ใน CUDA 13 build.

แก้ด้วย:

```bash
CUDA_HOME=/usr/local/cuda-13.0 COLMAP_ENABLE_CUDSS=OFF ./scripts/rebuild-colmap-cloud.sh
```

### `nvcc not in PATH`

ไม่จำเป็นต้องเป็น error ใน side-by-side mode เพราะ scripts ใช้ path explicit.

ถ้าต้องการใช้ CUDA 13 ใน shell:

```bash
export CUDA_HOME=/usr/local/cuda-13.0
export PATH=/usr/local/cuda-13.0/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-13.0/lib64:$LD_LIBRARY_PATH
```

### ใช้ CUDA 12.6 fallback

```bash
export CUDA_HOME=/usr/local/cuda-12.6
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
./scripts/compile-opensplat-cuda126.sh
```

## Files ที่เกี่ยวข้อง

- `install.sh`: installer หลัก ค่า default เป็น CUDA 13.0
- `scripts/setup-cuda130-wsl.sh`: ติดตั้ง CUDA 13.0 toolkit-only สำหรับ WSL2
- `scripts/compile-opensplat-cuda130.sh`: build OpenSplat + LibTorch cu130
- `scripts/colmap-build-common.sh`: shared CUDA/Ceres/COLMAP helper
- `scripts/rebuild-colmap-cloud.sh`: rebuild COLMAP headless CUDA
- `check-system.sh`: report CUDA 13.0, 12.6 และ `/usr/local/cuda`
- `start.sh`: runtime LibTorch detection
