# OpenSplat Web Frontend

> Legacy note: this document describes an older standalone web-frontend flow and contains historical path assumptions. For the current supported platform setup, use the repo root `README.md`, [DOCS_INDEX.md](DOCS_INDEX.md), and the installation guides.

เว็บอินเตอร์เฟสสำหรับการใช้งาน OpenSplat แบบง่าย สามารถอัพโหลดรูปภาพและสร้างโมเดล 3D Gaussian Splatting ได้โดยอัตโนมัติ

## ฟีเจอร์หลัก

- 🎯 **อัพโหลดรูปภาพ** - Drag & Drop หรือเลือกไฟล์
- ⚙️ **ตั้งค่าการประมวลผล** - Iterations, Camera Model, Feature Matching
- 📊 **ติดตามความคืบหน้า** - Real-time progress tracking
- 📁 **จัดการโปรเจค** - ดู, ลบ, ลองใหม่โปรเจคต่างๆ
- 📥 **ดาวน์โหลดผลลัพธ์** - ไฟล์ PLY สำหรับโมเดล 3D
- 👁️ **ดูโมเดล 3D** - Web viewer สำหรับ PLY files

## การติดตั้งและใช้งาน

### ความต้องการระบบ

- Python 3.10-3.12 (3.12 recommended)
- OpenSplat (compiled ด้วย CUDA support)
- COLMAP
- Flask และ dependencies

### การรันระบบ

1. **เข้าไปในโฟลเดอร์ web-frontend:**
   ```bash
   cd /home/pobimgroup/MyOpenSplat/web-frontend
   ```

2. **รันเซิร์ฟเวอร์:**
   ```bash
   python3 app.py
   ```

3. **เปิดเบราว์เซอร์:**
   ```
   http://localhost:5001
   ```

## โครงสร้างไฟล์

```
web-frontend/
├── app.py                 # Flask backend หลัก
├── templates/             # HTML templates
│   ├── index.html        # หน้าอัพโหลด
│   ├── projects.html     # หน้าจัดการโปรเจค
│   └── viewer.html       # หน้าดูโมเดล 3D
├── uploads/              # โฟลเดอร์เก็บรูปภาพที่อัพโหลด
├── results/              # โฟลเดอร์เก็บไฟล์ PLY ผลลัพธ์
└── projects_db.json     # ฐานข้อมูลโปรเจค
```

## การใช้งาน

### 1. อัพโหลดรูปภาพ

- **รูปภาพขั้นต่ำ:** 10 รูป
- **รูปภาพสูงสุด:** ไม่จำกัด (แนะนำ 50-200 รูป)
- **รูปแบบไฟล์:** JPG, JPEG, PNG
- **ขนาดไฟล์สูงสุด:** 500MB รวม

### 2. ตั้งค่าการประมวลผล

- **Training Iterations:**
  - 500: Quick (5-10 นาที)
  - 2000: Good (15-25 นาที)
  - 5000: High Quality (30-60 นาที)

- **Camera Model:**
  - **SIMPLE_RADIAL:** แนะนำ (รองรับ distortion)
  - SIMPLE_PINHOLE: สำหรับกล้องที่ไม่มี distortion
  - OPENCV: สำหรับกล้องที่ซับซ้อน

- **Max Feature Matches:**
  - 4096: Fast
  - 8192: Balanced (แนะนำ)
  - 16384: Detailed

### 3. ขั้นตอนการประมวลผล

1. **Feature Extraction** - สกัดจุดสำคัญจากรูปภาพ
2. **Feature Matching** - จับคู่จุดสำคัญระหว่างรูป
3. **Sparse Reconstruction** - สร้างโครงสร้าง 3D เบื้องต้น
4. **Gaussian Splatting** - สร้างโมเดล 3D สมบูรณ์

## การแก้ไขปัญหา

### โปรเจคล้มเหลว

1. **ตรวจสอบรูปภาพ:**
   - ใช้รูปจากกล้องเดียวกัน
   - รูปต้องมีส่วนทับซ้อนกัน
   - คุณภาพรูปดี ไม่เบลอ

2. **ลองเปลี่ยนการตั้งค่า:**
   - ใช้ Camera Model: SIMPLE_RADIAL
   - ลด Iterations เป็น 500
   - ลด Max Matches เป็น 4096

3. **ใช้ฟีเจอร์ Retry:**
   - ไปหน้า Projects
   - กดปุ่ม "Retry" ของโปรเจคที่ล้มเหลว

### ปัญหาประสิทธิภาพ

- **หน่วยความจำไม่พอ:** ลดจำนวนรูป หรือลดขนาดรูป
- **ช้า:** ตรวจสอบ GPU ทำงานหรือไม่
- **พื้นที่ดิสก์เต็ม:** ลบโปรเจคเก่า

## ข้อมูลทางเทคนิค

### การทำงานภายใน

1. **COLMAP Pipeline:**
   - Feature extraction ด้วย SIFT
   - Sequential matching สำหรับประสิทธิภาพ
   - Sparse reconstruction
   - Text format conversion

2. **OpenSplat Integration:**
   - รองรับ COLMAP dataset format
   - CUDA acceleration
   - Output: PLY format

3. **Directory Structure:**
   ```
   project_id/
   ├── images/          # รูปภาพต้นฉบับ
   ├── database.db      # COLMAP database
   └── sparse/          # COLMAP reconstruction
       └── 0/           # cameras.txt, images.txt, points3D.txt
   ```

### API Endpoints

- `POST /upload` - อัพโหลดรูปภาพ
- `GET /status/<project_id>` - เช็คสถานะ
- `GET /download/<project_id>` - ดาวน์โหลด PLY
- `GET /projects` - ดูรายการโปรเจค
- `DELETE /delete/<project_id>` - ลบโปรเจค
- `POST /retry/<project_id>` - ลองใหม่

### การพัฒนาต่อ

1. **เพิ่ม Dense Reconstruction** สำหรับคุณภาพสูงขึ้น
2. **Multi-GPU Support** สำหรับโปรเจคใหญ่
3. **Real-time Viewer** ใน browser
4. **Batch Processing** หลายโปรเจคพร้อมกัน
5. **Export Options** (OBJ, GLTF)

## อัปเดตล่าสุด

### v1.1 - เซ็ตอัป Web Frontend
- ✅ สร้าง Flask web application
- ✅ อินเตอร์เฟสอัพโหลดรูปภาพ
- ✅ ระบบติดตามความคืบหน้า
- ✅ การจัดการโปรเจค
- ✅ แก้ไขปัญหา directory structure
- ✅ แก้ไขปัญหา camera model compatibility
- ✅ แก้ไขปัญหา absolute path resolution

### การปรับปรุงสำคัญ

1. **โครงสร้างไดเรกทอรี่:** เปลี่ยนจาก `processed/` subfolder เป็น COLMAP standard format
2. **Camera Model:** เปลี่ยน default จาก SIMPLE_PINHOLE เป็น SIMPLE_RADIAL
3. **Path Resolution:** ใช้ absolute paths สำหรับความเสถียร

---

พัฒนาโดย: POBIM Team
วันที่: 21 กันยายน 2025
