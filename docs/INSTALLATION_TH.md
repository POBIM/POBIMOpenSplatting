# คู่มือติดตั้ง POBIMOpenSplat

> หมายเหตุเรื่องการนำทางเอกสาร: ให้ใช้ [DOCS_INDEX.md](DOCS_INDEX.md) เป็นศูนย์กลางเอกสารหลัก และใช้ `README.md` ที่ root ของ repo สำหรับภาพรวมของโปรเจค

## 📋 สิ่งที่ต้องเตรียม

### ฮาร์ดแวร์ที่จำเป็น
- ✅ **GPU**: NVIDIA GPU พร้อม CUDA support (แนะนำ RTX 3060 ขึ้นไป)
- ✅ **RAM**: 16GB ขึ้นไป (แนะนำ 32GB)
- ✅ **พื้นที่ว่าง**: 50GB ขึ้นไป
- ✅ **CPU**: 4 cores ขึ้นไป

### ซอฟต์แวร์ที่ต้องมี
- ✅ **OS**: Ubuntu 20.04/22.04 หรือ Debian-based Linux
- ✅ **NVIDIA Driver**: เวอร์ชันล่าสุด
- ✅ **CUDA Toolkit**: 11.8, 12.1 หรือ 12.6 (ติดตั้งก่อนใช้ script)
- ✅ **Python**: รองรับ 3.10-3.12 (แนะนำ 3.12; `install.sh` จะเลือก 3.12 ก่อนถ้ามี)

### Runtime Matrix

| Platform | GPU Runtime | สถานะ | หมายเหตุ |
|----------|-------------|-------|----------|
| Ubuntu 20.04/22.04/24.04 | NVIDIA CUDA 11.8 / 12.1 / 12.6 | เส้นทางหลัก | `install.sh` และ `quick-start.sh` รองรับ flow นี้เป็นหลัก โดยแนะนำ CUDA 12.6 |
| Ubuntu 22.04 | AMD ROCm 5.7 / 6.0 / 6.3 (HIP) | ขั้นสูง / Docker | ดู `Dockerfile.rocm`, `Dockerfile.rocm6`, และ `Dockerfile.rocm6.3.3` |
| Ubuntu 24.04 | AMD ROCm 6.4 (HIP) | ขั้นสูง / Docker | ดู `Dockerfile.rocm6.4.0` |
| macOS (Apple Silicon) | Metal / MPS | build แบบ manual | อ้างอิงขั้นตอนใน `README.md` หลักของโปรเจค |
| Windows | CUDA 11.8 | build แบบ manual | อ้างอิงขั้นตอน Windows ใน `README.md` หลักของโปรเจค |
| ทุกระบบที่รองรับ | CPU-only | รองรับ | ใช้งานได้แม้ไม่มี GPU แต่จะช้ากว่า CUDA/HIP/MPS มาก |

---

## 🚀 วิธีติดตั้งแบบอัตโนมัติ (แนะนำ)

### ขั้นตอนที่ 1: ติดตั้ง CUDA (ถ้ายังไม่มี)

```bash
# ตรวจสอบว่ามี CUDA หรือยัง
nvidia-smi

# ถ้ายังไม่มี ให้ติดตั้ง CUDA 12.6 (แนะนำ)
wget https://developer.download.nvidia.com/compute/cuda/12.6.0/local_installers/cuda_12.6.0_560.28.03_linux.run
sudo sh cuda_12.6.0_560.28.03_linux.run
```

### ขั้นตอนที่ 2: Clone โปรเจค

```bash
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
```

### ขั้นตอนที่ 3: รัน Installation Script

```bash
# ให้สิทธิ์ execute
chmod +x install.sh

# รันการติดตั้ง (ใช้เวลาประมาณ 30-60 นาที)
./install.sh
```

Script จะทำงานดังนี้:
1. ✅ ตรวจสอบ GPU, CUDA, RAM, Disk space
2. ✅ ติดตั้ง dependencies ทั้งหมด (build tools, Python, Node.js, libraries)
3. ✅ ดาวน์โหลดและติดตั้ง LibTorch ที่เหมาะสมกับ CUDA ของคุณ
4. ✅ Compile COLMAP
5. ✅ Compile OpenSplat
6. ✅ ติดตั้ง Python backend dependencies
7. ✅ ติดตั้ง Node.js frontend dependencies
8. ✅ สร้าง quick-start script สำหรับเปิดใช้งานครั้งต่อไป

**หมายเหตุ**: ระหว่างติดตั้ง script จะถามคำถามต่างๆ ให้ตอบ `y` (yes) หรือ `n` (no)

---

## 🎯 วิธีเปิดใช้งาน

### ครั้งแรกหลังติดตั้งเสร็จ

```bash
# เปิดใช้งานทันที
./quick-start.sh
```

### ครั้งต่อไปที่ต้องการใช้

```bash
# วิธีที่ 1: ใช้ quick-start script
./quick-start.sh

# วิธีที่ 2: เข้าไปที่โฟลเดอร์ PobimSplatting
cd PobimSplatting
./start.sh start

# วิธีที่ 3: เปิดแบบ interactive menu
cd PobimSplatting
./start.sh
```

---

## 🌐 เข้าใช้งานระบบ

หลังจาก server เริ่มทำงาน สามารถเข้าใช้งานได้ที่:

- **Frontend (หน้าเว็บหลัก)**: http://localhost:3000
- **Backend API**: http://localhost:5000

---

## 🔧 การแก้ไขปัญหาที่พบบ่อย

### ปัญหา: Port ถูกใช้งานอยู่

```bash
# ล้าง port ที่ค้างอยู่
cd PobimSplatting
./start.sh

# เลือก option 8) Force clear default ports
```

### ปัญหา: CUDA not found

```bash
# ตรวจสอบ CUDA path
echo $PATH
echo $LD_LIBRARY_PATH

# เพิ่ม CUDA ใน PATH (ถ้าจำเป็น)
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
```

### ปัญหา: LibTorch not found

```bash
# ตรวจสอบว่า LibTorch ถูกดาวน์โหลดแล้วหรือยัง
ls -la libtorch-*

# ถ้ายังไม่มี ให้รัน install.sh ใหม่
./install.sh
```

### ปัญหา: COLMAP GUI ไม่สามารถเปิดได้

```bash
# Error: "Cannot start colmap GUI; colmap was built without GUI support"

# ถ้าต้องการใช้ COLMAP GUI (สำหรับแก้ไข point cloud ด้วยมือ)
./rebuild-colmap-with-gui.sh

# หรือถ้าต้องการ rebuild ตอนติดตั้งใหม่
./install.sh
# เมื่อถาม "Enable COLMAP GUI support?" ให้ตอบ: y
```

**หมายเหตุ:** 
- COLMAP GUI ต้องใช้ Qt5 และ desktop environment
- ถ้ารันบน server ผ่าน SSH อาจต้องใช้ X11 forwarding หรือ VNC
- สำหรับ server แนะนำใช้แบบ headless (ไม่มี GUI) เพื่อประหยัดทรัพยากร

### ปัญหา: Python dependencies ติดตั้งไม่ได้

```bash
# เข้าไปที่ Backend
cd PobimSplatting/Backend

# ลบ virtual environment เก่า
rm -rf venv

# สร้างใหม่
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### ปัญหา: Node.js dependencies ติดตั้งไม่ได้

```bash
# เข้าไปที่ Frontend
cd PobimSplatting/Frontend

# ลบ node_modules เก่า
rm -rf node_modules package-lock.json

# ติดตั้งใหม่
npm install
```

---

## 📦 การติดตั้งบนเครื่องอื่น

### วิธีที่ 1: ใช้ Installation Script (แนะนำ)

```bash
# บนเครื่องใหม่
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
./install.sh
```

### วิธีที่ 2: ใช้ Docker (สำหรับความสะดวก)

```bash
# Build Docker image (ยังไม่พร้อมใช้งาน - อยู่ระหว่างพัฒนา)
docker build -t pobim-opensplat -f Dockerfile.rocm6 .

# Run container
docker run -it --gpus all -p 3000:3000 -p 5000:5000 pobim-opensplat
```

**หมายเหตุ**: ไฟล์ binary ที่ compile แล้ว (`build/opensplat`, `colmap-build/colmap`) **ไม่สามารถ** คัดลอกไปใช้กับเครื่องอื่นได้โดยตรง เพราะมี dependencies ที่ผูกติดกับเครื่องต้นทาง ต้องใช้ installation script compile ใหม่บนแต่ละเครื่อง

---

## 📝 Log Files

การติดตั้งและการทำงานจะมี log files ดังนี้:

- **Installation log**: `PobimSplatting/logs/install.log`
- **Backend log**: `PobimSplatting/logs/backend.log`
- **Frontend log**: `PobimSplatting/logs/frontend.log`

สามารถดู log ได้ด้วยคำสั่ง:

```bash
# ดู installation log
tail -f PobimSplatting/logs/install.log

# ดู backend log
tail -f PobimSplatting/logs/backend.log

# ดู frontend log
tail -f PobimSplatting/logs/frontend.log
```

---

## 🆘 ขอความช่วยเหลือ

ถ้าพบปัญหาในการติดตั้ง:

1. ตรวจสอบ `PobimSplatting/logs/install.log` ก่อนเสมอ
2. ตรวจสอบว่า GPU และ CUDA ทำงานได้ด้วย `nvidia-smi`
3. ตรวจสอบว่ามีพื้นที่ว่างเพียงพอด้วย `df -h`
4. ติดต่อทีมพัฒนาพร้อม log file

---

## ⚡ Quick Reference

```bash
# ติดตั้งครั้งแรก
./install.sh

# เปิดใช้งาน
./quick-start.sh

# หยุดการทำงาน
cd PobimSplatting && ./start.sh stop

# ตรวจสอบสถานะ
cd PobimSplatting && ./start.sh status

# ล้าง ports
cd PobimSplatting && ./start.sh clear-ports
```

---

**สนุกกับการสร้าง 3D Gaussian Splatting! 🎨✨**
