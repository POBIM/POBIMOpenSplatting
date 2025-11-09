# 📚 POBIMOpenSplat - Complete Installation System Documentation

## 🎯 Overview

ระบบติดตั้งอัตโนมัติแบบครบวงจรสำหรับ POBIMOpenSplat - 3D Gaussian Splatting Platform พร้อม Web Interface

**คุณสมบัติหลัก:**
- ✅ ติดตั้งครบทุกอย่างด้วยคำสั่งเดียว
- ✅ ตรวจสอบระบบอัตโนมัติ (GPU, CUDA, RAM, Disk)
- ✅ ดาวน์โหลดและ compile dependencies ทั้งหมด
- ✅ Setup Python backend + Node.js frontend
- ✅ สร้าง quick-start script สำหรับใช้งานครั้งต่อไป
- ✅ เอกสารครบถ้วนทั้งภาษาไทยและอังกฤษ

---

## 🚀 Quick Start

### สำหรับผู้ที่ต้องการติดตั้งเลย (รีบๆ)

```bash
# Clone repository
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat

# ติดตั้ง (ใช้เวลา 30-60 นาที)
chmod +x install.sh
./install.sh

# เปิดใช้งาน
./quick-start.sh

# เข้าใช้งาน
# http://localhost:3000
```

### สำหรับผู้ที่ต้องการตรวจสอบระบบก่อน

```bash
# ตรวจสอบว่าเครื่องรองรับไหม
chmod +x check-system.sh
./check-system.sh

# ถ้าผ่านแล้ว → ติดตั้ง
./install.sh
```

---

## 📖 Documentation Index

### 1️⃣ **คู่มือหลัก** (เริ่มที่นี่)

| Document | Language | Description |
|----------|----------|-------------|
| [**INSTALLATION.md**](INSTALLATION.md) | 🇬🇧 English | Complete installation guide with troubleshooting |
| [**INSTALLATION_TH.md**](INSTALLATION_TH.md) | 🇹🇭 ไทย | คู่มือติดตั้งฉบับสมบูรณ์พร้อมแก้ปัญหา |

### 2️⃣ **Quick Reference** (สำหรับใช้งานประจำวัน)

| Document | Description |
|----------|-------------|
| [**QUICK_REFERENCE.md**](QUICK_REFERENCE.md) | คำสั่งที่ใช้บ่อย, shortcuts, emergency commands |

### 3️⃣ **Technical Documentation**

| Document | Description |
|----------|-------------|
| [**INSTALLATION_SYSTEM.md**](INSTALLATION_SYSTEM.md) | Overview ของระบบติดตั้งทั้งหมด, features, architecture |
| [**WORKFLOW.md**](WORKFLOW.md) | Visual workflow diagram และ detailed process flow |

### 4️⃣ **Project Documentation**

| Document | Description |
|----------|-------------|
| [**README.md**](README.md) | Project overview และ original OpenSplat documentation |
| [**AGENTS.md**](AGENTS.md) | Repository guidelines และ development practices |

---

## 🛠️ Installation Scripts

### Main Scripts

| Script | Purpose | When to Use |
|--------|---------|-------------|
| `install.sh` | Main installation script | **ครั้งแรกเท่านั้น** - ติดตั้งทุกอย่างตั้งแต่ต้น |
| `quick-start.sh` | Quick start script (auto-generated) | **ทุกครั้งที่ต้องการใช้งาน** - เปิด server |
| `check-system.sh` | System requirements checker | **ก่อนติดตั้ง** - ตรวจสอบว่าเครื่องพร้อมหรือยัง |

### Usage Examples

```bash
# First time installation
./install.sh

# Check system before installing (optional)
./check-system.sh

# Start server (daily use)
./quick-start.sh

# Or use interactive menu
cd PobimSplatting && ./start.sh
```

---

## 🎓 Learning Path

### ฉันเป็น... → ควรอ่านอะไร?

#### 👤 **End User** (ใช้งาน 3D Gaussian Splatting)
1. อ่าน [INSTALLATION_TH.md](INSTALLATION_TH.md) หรือ [INSTALLATION.md](INSTALLATION.md)
2. รัน `./install.sh`
3. รัน `./quick-start.sh`
4. Bookmark [QUICK_REFERENCE.md](QUICK_REFERENCE.md) ไว้ใช้งาน

#### 💻 **Developer** (พัฒนาโปรเจค)
1. อ่าน [README.md](README.md) - เข้าใจโปรเจค
2. อ่าน [AGENTS.md](AGENTS.md) - เข้าใจ structure และ guidelines
3. อ่าน [INSTALLATION_SYSTEM.md](INSTALLATION_SYSTEM.md) - เข้าใจ installation architecture
4. ดู [WORKFLOW.md](WORKFLOW.md) - เข้าใจ process flow
5. รัน `./install.sh`

#### 🏢 **System Administrator** (Setup หลายเครื่อง)
1. อ่าน [INSTALLATION.md](INSTALLATION.md) - System requirements
2. รัน `./check-system.sh` บนทุกเครื่อง
3. เตรียม CUDA บนเครื่องที่ยังไม่มี
4. รัน `./install.sh` บนแต่ละเครื่อง
5. Bookmark [QUICK_REFERENCE.md](QUICK_REFERENCE.md) สำหรับ troubleshooting

#### 🔍 **Technical Writer / Reviewer**
1. อ่าน [INSTALLATION_SYSTEM.md](INSTALLATION_SYSTEM.md) - Overview
2. ดู [WORKFLOW.md](WORKFLOW.md) - Visual diagrams
3. ตรวจสอบ [INSTALLATION.md](INSTALLATION.md) และ [INSTALLATION_TH.md](INSTALLATION_TH.md)
4. ทดสอบ scripts: `check-system.sh`, `install.sh`

---

## 📊 File Structure Overview

```
POBIMOpenSplat/
│
├── 📜 Scripts
│   ├── install.sh ..................... Main installation (run once)
│   ├── quick-start.sh ................. Quick start (daily use)
│   └── check-system.sh ................ System checker (optional)
│
├── 📚 Documentation (English)
│   ├── INSTALLATION.md ................ Installation guide
│   ├── QUICK_REFERENCE.md ............. Quick commands
│   ├── INSTALLATION_SYSTEM.md ......... System overview
│   ├── WORKFLOW.md .................... Visual workflow
│   └── README.md ...................... Project overview
│
├── 📚 Documentation (Thai)
│   └── INSTALLATION_TH.md ............. คู่มือติดตั้ง
│
├── 🔧 Generated Files (after installation)
│   ├── install.log .................... Installation log
│   └── .env.local ..................... Environment config
│
├── 🏗️ Build Outputs
│   ├── build/opensplat ................ OpenSplat binary
│   ├── colmap-build/colmap ............ COLMAP binary
│   └── libtorch-cuda126/ .............. PyTorch library
│
└── 🌐 Web Platform
    └── PobimSplatting/
        ├── start.sh ................... Server manager
        ├── Backend/ ................... Flask API
        └── Frontend/ .................. Next.js UI
```

---

## ❓ FAQ - คำถามที่พบบ่อย

### Q: ต้องติดตั้งอะไรก่อนรัน install.sh?

**A:** ต้องมี:
- NVIDIA GPU + Driver
- CUDA Toolkit (11.8, 12.1 หรือ 12.6)
- Ubuntu/Debian Linux

ที่เหลือ script จะติดตั้งให้เอง

---

### Q: ใช้เวลาติดตั้งนานแค่ไหน?

**A:** ประมาณ **30-60 นาที** ขึ้นอยู่กับ:
- ความเร็ว internet (ดาวน์โหลด LibTorch ~2GB)
- จำนวน CPU cores (compile COLMAP + OpenSplat)
- ว่าต้องติดตั้ง dependencies หรือไม่

---

### Q: Binary ที่ compile แล้วเอาไปใช้เครื่องอื่นได้ไหม?

**A:** **ไม่ได้** เพราะ:
- LibTorch paths hardcoded
- CUDA version specific
- Library dependencies ต่างกัน

**ต้องรัน install.sh บนทุกเครื่อง**

---

### Q: ถ้าติดตั้งล้มเหลวทำยังไง?

**A:**
1. ดู `install.log` ก่อนเสมอ
2. รัน `./check-system.sh` ใหม่
3. แก้ไขปัญหาที่พบ
4. รัน `./install.sh` ใหม่ (มันจะ skip ส่วนที่ติดตั้งแล้ว)

---

### Q: จะ update dependencies ยังไง?

**A:**
```bash
# Python
cd PobimSplatting/Backend
source venv/bin/activate
pip install --upgrade -r requirements.txt

# Node.js
cd PobimSplatting/Frontend
npm update

# OpenSplat/COLMAP - ต้อง compile ใหม่
rm -rf build colmap-build
./install.sh
```

---

### Q: Port 3000/5000 ถูกใช้อยู่แก้ยังไง?

**A:**
```bash
cd PobimSplatting
./start.sh
# เลือก: 8) Force clear default ports
```

---

## 🆘 Getting Help

### ถ้าพบปัญหา:

1. **ตรวจสอบ logs**
   ```bash
   cat install.log                           # Installation
   tail -f PobimSplatting/Backend/backend.log   # Backend
   tail -f PobimSplatting/Frontend/frontend.log # Frontend
   ```

2. **รัน system check**
   ```bash
   ./check-system.sh
   ```

3. **อ่าน documentation**
   - [INSTALLATION.md](INSTALLATION.md) → Troubleshooting section
   - [QUICK_REFERENCE.md](QUICK_REFERENCE.md) → Common fixes

4. **ติดต่อทีมพัฒนา**
   - GitHub Issues
   - แนบ `install.log`
   - ระบุ OS, GPU, CUDA version

---

## 🌟 Key Features Summary

| Feature | Benefit |
|---------|---------|
| **One-Command Install** | `./install.sh` ติดตั้งทุกอย่าง |
| **Smart CUDA Detection** | เลือก LibTorch ให้อัตโนมัติ |
| **System Validation** | ตรวจสอบก่อนติดตั้ง |
| **Comprehensive Logging** | Debug ง่ายด้วย install.log |
| **Quick Start** | `./quick-start.sh` ใช้งานได้ทันที |
| **Multi-Language Docs** | ภาษาไทย + อังกฤษ |
| **Interactive Prompts** | User-friendly installation |
| **Error Recovery** | Resume ได้ถ้าติดตั้งค้าง |

---

## 📈 Version History

| Date | Version | Changes |
|------|---------|---------|
| 2025-11-07 | 1.0.0 | Initial release - Complete installation system |

---

## 📜 License

POBIMOpenSplat is licensed under AGPLv3. See [LICENSE.txt](LICENSE.txt) for details.

---

## 🙏 Acknowledgments

Built on top of:
- [OpenSplat](https://github.com/pierotofy/OpenSplat) - Original 3D Gaussian Splatting implementation
- [COLMAP](https://colmap.github.io/) - Structure from Motion
- [PyTorch](https://pytorch.org/) - Deep learning framework
- [Next.js](https://nextjs.org/) - React framework
- [Flask](https://flask.palletsprojects.com/) - Python web framework

---

## 🚀 Start Here

### แนะนำสำหรับมือใหม่

```bash
# 1. Clone
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat

# 2. อ่านคู่มือ (เลือก 1 อย่าง)
less INSTALLATION_TH.md  # ภาษาไทย
less INSTALLATION.md     # English

# 3. ตรวจสอบระบบ (ถ้าไม่แน่ใจ)
./check-system.sh

# 4. ติดตั้ง
./install.sh

# 5. เปิดใช้งาน
./quick-start.sh

# 6. เข้าใช้งานที่ browser
# http://localhost:3000
```

**ตัวอย่างผลลัพธ์:**
- ✅ Frontend running at http://localhost:3000
- ✅ Backend API at http://localhost:5000
- ✅ Upload images → COLMAP → Train → View 3D model

---

**Happy 3D Gaussian Splatting! 🎨✨**

*Documentation created: November 7, 2025*
