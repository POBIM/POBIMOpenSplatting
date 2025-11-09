# 🎨 วิธีสร้างไฟล์ GLB แบบมีสี

## TL;DR - Quick Commands

### 🖥️ ผ่าน UI (ง่ายที่สุด)

1. เปิด `http://localhost:3000/projects/<PROJECT_ID>`
2. Scroll ลงไปหา **"Export Textured Mesh"**
3. เลือก:
   - Method: **Poisson**
   - Quality: **Medium**
   - Format: **GLB**
4. กด **"Create Textured Mesh"**
5. รอ 10-15 นาที
6. กด **"Download GLB File"**

---

### ⚡ ผ่าน Command Line (เร็วที่สุด - ถ้ามีไฟล์แล้ว)

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate
python quick_mesh_export.py <PROJECT_ID>
```

**เวลา:** ~24 วินาที
**ผลลัพธ์:** GLB + OBJ + PLY

---

### 🔧 ผ่าน API

```bash
curl -X POST http://localhost:5000/api/project/<PROJECT_ID>/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"method":"poisson","quality":"medium","format":"glb"}'
```

---

## 📥 ดาวน์โหลดไฟล์ที่สร้างแล้ว

### ผ่าน UI
- กดปุ่ม **Download** ในหน้า Project Detail

### ผ่าน Browser
```
http://localhost:5000/api/project/<PROJECT_ID>/download_mesh/<FILENAME>.glb
```

### ผ่าน Command Line
```bash
curl -O http://localhost:5000/api/project/<PROJECT_ID>/download_mesh/<FILENAME>.glb
```

---

## 🎨 เปิดใน Blender (ให้เห็นสี)

### 1. Import
```
File → Import → glTF 2.0 (.glb)
```

### 2. เปิด Vertex Colors
```
กด Z → Solid
Shading (มุมขวาบน) → Attribute → Col
```

### 3. Smooth Shading (Optional)
```
คลิกขวาที่ mesh → Shade Smooth
```

---

## 📍 ตำแหน่งไฟล์

```
/home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend/
└── results/
    └── <PROJECT_ID>/
        ├── <PROJECT_ID>_colored_mesh.glb  ✅ (แนะนำ)
        ├── <PROJECT_ID>_colored_mesh.obj
        └── <PROJECT_ID>_colored_mesh.ply
```

---

## ⏱️ เวลาที่ใช้

| Method | เวลา |
|--------|------|
| **Quick Export** (CLI - ใช้ไฟล์ที่มีแล้ว) | ~24 วินาที |
| **UI Export - Low** | 5-10 นาที |
| **UI Export - Medium** | 10-15 นาที |
| **UI Export - High** | 20-40 นาที |

---

## 🎯 ตัวเลือกที่แนะนำ

| สถานการณ์ | Method | Quality | Format |
|-----------|--------|---------|--------|
| **Preview/Test** | Poisson | Low | GLB |
| **ทั่วไป** (แนะนำ) | Poisson | Medium | GLB |
| **Production** | Poisson | High | GLB |
| **3D Software** | Poisson | Medium | OBJ |
| **Analysis** | Poisson | Medium | PLY |

---

## ❓ FAQ

### Q: ทำไมไม่เห็นสีใน Blender?
**A:** กด `Z` → Solid, แล้วเปลี่ยน Shading เป็น **Attribute → Col**

### Q: ใช้เวลานานเกินไปหรือเปล่า?
**A:** ปกติครับ Dense reconstruction ต้องประมวลผลทุกภาพ

### Q: GLB vs OBJ ต่างกันยังไง?
**A:** 
- **GLB** - ไฟล์เล็กกว่า, binary format, เร็วกว่า
- **OBJ** - text format, universal support, แก้ไขง่ายกว่า

### Q: Export แล้วขนาดใหญ่เกินไป?
**A:**
- ใช้ **GLB** แทน OBJ (เล็กกว่า ~3x)
- ใช้ quality **low** หรือ **medium**
- ใน Blender: ใช้ Decimate modifier

---

## 📚 เอกสารเพิ่มเติม

- [คู่มือฉบับเต็ม](./MESH_EXPORT_GUIDE.md)
- [Quick Start Guide](./MESH_EXPORT_QUICKSTART.md)
- [User Guide](./MESH_EXPORT_USER_GUIDE.md)

---

**Made with ❤️ by POBIM Team**
