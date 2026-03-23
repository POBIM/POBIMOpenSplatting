# 🚀 CUDA Auto-Installation Feature

## สรุปการเปลี่ยนแปลง

ไฟล์ `install.sh` ได้รับการปรับปรุงให้มีความสามารถในการตรวจสอบและติดตั้ง CUDA Toolkit อัตโนมัติ

## คุณสมบัติใหม่

### 1. ฟังก์ชัน `install_cuda_toolkit()`

ฟังก์ชันใหม่ที่จะ:
- ✅ ตรวจสอบว่ามี CUDA Toolkit (nvcc) ติดตั้งอยู่แล้วหรือไม่
- ✅ ตรวจสอบว่ามี NVIDIA Driver ติดตั้งอยู่หรือไม่
- ✅ ตรวจสอบ version ของ CUDA ที่ driver รองรับ
- ✅ ดาวน์โหลดและติดตั้ง CUDA Toolkit 12.6 อัตโนมัติ
- ✅ ตั้งค่า environment variables (PATH, LD_LIBRARY_PATH)
- ✅ เพิ่ม CUDA paths ลงใน `~/.bashrc` เพื่อใช้งานถาวร
- ✅ ยืนยันการติดตั้งสำเร็จ

### 2. การทำงานอัตโนมัติ

Script จะตรวจสอบอัตโนมัติและติดตั้ง CUDA หากพบว่า:
- มี NVIDIA GPU (ตรวจสอบด้วย `nvidia-smi`)
- มี NVIDIA Driver ติดตั้งแล้ว
- แต่ยังไม่มี CUDA Toolkit (ไม่มี `nvcc`)

## วิธีใช้งาน

### การติดตั้งแบบปกติ

```bash
# รันสคริปต์ติดตั้งตามปกติ
./install.sh
```

Script จะ:
1. ตรวจสอบระบบ
2. **พบว่าไม่มี CUDA Toolkit → ถามว่าจะติดตั้งหรือไม่**
3. ถ้าตอบ "Y" → ติดตั้ง CUDA 12.6 อัตโนมัติ
4. ดำเนินการติดตั้งส่วนอื่นๆ ต่อ

### กรณีที่มี CUDA อยู่แล้ว

```bash
# ถ้ามี CUDA อยู่แล้ว script จะข้ามขั้นตอนนี้
./install.sh
```

Output:
```
✓ CUDA Toolkit already installed: 12.6
✓ CUDA Toolkit already available
```

### การติดตั้ง CUDA เฉพาะส่วน

ถ้าต้องการติดตั้งเฉพาะ CUDA โดยไม่รัน script ทั้งหมด สามารถใช้คำสั่งนี้:

```bash
# ดึงฟังก์ชันจาก install.sh
source <(grep -A 100 "install_cuda_toolkit()" install.sh | head -n 100)

# เรียกใช้ฟังก์ชัน
install_cuda_toolkit
```

## ข้อกำหนดเบื้องต้น

### ต้องมีก่อนติดตั้ง CUDA:

1. **NVIDIA GPU** 
   ```bash
   lspci | grep -i nvidia
   ```

2. **NVIDIA Driver** (version 525+)
   ```bash
   nvidia-smi
   ```

### ถ้ายังไม่มี NVIDIA Driver:

```bash
# สำหรับ Ubuntu 22.04
sudo apt-get update
sudo apt-get install -y nvidia-driver-550
sudo reboot

# หลัง reboot ตรวจสอบ
nvidia-smi
```

## รายละเอียดการติดตั้ง

### CUDA Toolkit 12.6 ประกอบด้วย:

- **nvcc**: CUDA compiler
- **cuBLAS**: Linear algebra libraries
- **cuDNN**: Deep learning libraries
- **cuFFT**: Fast Fourier Transform
- **cuSPARSE**: Sparse matrix operations
- **Nsight**: Profiling tools
- และอื่นๆ

### ขนาดการติดตั้ง:

- ขนาดดาวน์โหลด: ~3 GB
- ขนาดติดตั้ง: ~6.7 GB

### Path ที่ติดตั้ง:

```
/usr/local/cuda-12.6/
├── bin/          # nvcc และเครื่องมืออื่นๆ
├── include/      # header files
├── lib64/        # libraries
└── samples/      # ตัวอย่างโค้ด
```

### Environment Variables ที่ถูกตั้งค่า:

```bash
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
```

## การตรวจสอบหลังติดตั้ง

### ตรวจสอบว่า CUDA ติดตั้งสำเร็จ:

```bash
# ตรวจสอบ nvcc
nvcc --version

# ตรวจสอบ GPU
nvidia-smi

# ทดสอบ CUDA sample (optional)
cd /usr/local/cuda-12.6/samples/1_Utilities/deviceQuery
sudo make
./deviceQuery
```

### ผลลัพธ์ที่คาดหวัง:

```
nvcc: NVIDIA (R) Cuda compiler driver
Copyright (c) 2005-2024 NVIDIA Corporation
Built on Tue_Oct_29_23:50:19_PDT_2024
Cuda compilation tools, release 12.6, V12.6.85
Build cuda_12.6.r12.6/compiler.35059454_0
```

## การแก้ปัญหา (Troubleshooting)

### ปัญหา: ไม่พบ nvcc หลังติดตั้ง

**วิธีแก้:**
```bash
# โหลด environment variables ใหม่
source ~/.bashrc

# หรือเพิ่ม path ด้วยตนเอง
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
```

### ปัญหา: Driver version เก่าเกินไป

**วิธีแก้:**
```bash
# อัพเกรด NVIDIA Driver
sudo apt-get update
sudo apt-get install --upgrade nvidia-driver-550
sudo reboot
```

### ปัญหา: พื้นที่ดิสก์ไม่พอ

**วิธีแก้:**
```bash
# ตรวจสอบพื้นที่ว่าง
df -h

# ล้างแคช apt (ถ้าจำเป็น)
sudo apt-get clean
sudo apt-get autoclean
```

### ปัญหา: การดาวน์โหลดช้า

**วิธีแก้:**
- ใช้เครือข่ายที่เร็วกว่า
- หรือติดตั้ง CUDA ด้วยตนเองจาก [NVIDIA Developer](https://developer.nvidia.com/cuda-downloads)

## ความเข้ากันได้

### GPU ที่รองรับ:

- ✅ NVIDIA GeForce RTX 40xx Series (Ada Lovelace)
- ✅ NVIDIA GeForce RTX 30xx Series (Ampere)
- ✅ NVIDIA GeForce RTX 20xx Series (Turing)
- ✅ NVIDIA Tesla/Quadro GPUs
- ✅ NVIDIA Data Center GPUs (A100, H100, L4, etc.)

### OS ที่รองรับ:

- ✅ Ubuntu 22.04 LTS (ทดสอบแล้ว)
- ✅ Ubuntu 20.04 LTS
- ⚠️ Debian/Red Hat (ต้องปรับแต่งเล็กน้อย)

### CUDA Version Compatibility:

| CUDA Version | Min Driver | Recommended Driver |
|--------------|------------|-------------------|
| 12.6         | 550.54.15  | 550.90.07+        |
| 12.1         | 525.60.13  | 530.30.02+        |
| 11.8         | 520.61.05  | 520.61.05+        |

## การอัพเกรด CUDA

ถ้าต้องการอัพเกรดเป็น version ใหม่:

```bash
# ลบ version เก่า (optional)
sudo apt-get remove --purge cuda-toolkit-12-6

# ติดตั้ง version ใหม่
sudo apt-get install cuda-toolkit-12-x
```

## เอกสารเพิ่มเติม

- [CUDA Toolkit Documentation](https://docs.nvidia.com/cuda/)
- [CUDA Installation Guide Linux](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)
- [CUDA C++ Programming Guide](https://docs.nvidia.com/cuda/cuda-c-programming-guide/)

## ประวัติการเปลี่ยนแปลง

### Version 1.0 (2025-11-12)
- ✨ เพิ่มฟังก์ชัน `install_cuda_toolkit()` อัตโนมัติ
- ✨ ตรวจสอบและติดตั้ง CUDA 12.6
- ✨ ตั้งค่า environment variables อัตโนมัติ
- ✨ รองรับ Ubuntu 22.04 LTS
- ✨ เพิ่มการตรวจสอบและ validation หลายขั้นตอน

## การสนับสนุน

หากพบปัญหาหรือต้องการความช่วยเหลือ:
- เปิด Issue บน GitHub repository
- ตรวจสอบ log file: `install.log`
- อ่าน troubleshooting guide ด้านบน

---

**หมายเหตุ**: การติดตั้ง CUDA จำเป็นต้องใช้สิทธิ์ sudo และใช้เวลาประมาณ 5-10 นาที ขึ้นอยู่กับความเร็วของอินเทอร์เน็ต
