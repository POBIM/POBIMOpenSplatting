# 🚀 Quick Start - Textured Mesh Export

## ติดตั้งและทดสอบ Mesh Export Feature

---

## ✅ ขั้นตอนที่ 1: ตรวจสอบ Dependencies

### Backend Dependencies

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate

# ตรวจสอบ Python packages
pip list | grep -E "trimesh|scipy|plyfile|pymeshlab"

# ถ้าไม่มี ให้ติดตั้ง:
pip install trimesh scipy python-ply file pymeshlab
```

### COLMAP with CUDA

```bash
# ตรวจสอบว่ามี COLMAP พร้อม CUDA support
/home/pobimgroup/triangle-splatting/colmap-build/colmap/build_gpu/src/colmap/exe/colmap -h | head -5

# ควรเห็น:
# COLMAP 3.13.0.dev0 -- Structure-from-Motion and Multi-View Stereo
# (Commit db4686e7 on 2025-09-23 with CUDA)
```

---

## ✅ ขั้นตอนที่ 2: ทดสอบ Backend API

### 2.1 เริ่มต้น Backend Server

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate
python app.py
```

### 2.2 ทดสอบ API Endpoints

```bash
# Health Check
curl http://localhost:5000/api/health

# List Available Exports (ใช้ project ID จริง)
curl http://localhost:5000/api/project/f487f0a3-7c6d-4524-9f7e-6c23e249142b/available_exports

# Create Textured Mesh
curl -X POST http://localhost:5000/api/project/f487f0a3-7c6d-4524-9f7e-6c23e249142b/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "low",
    "format": "glb"
  }'
```

---

## ✅ ขั้นตอนที่ 3: ทดสอบ Frontend

### 3.1 เริ่มต้น Frontend Dev Server

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Frontend
npm run dev
```

### 3.2 เข้าถึง UI

```
http://localhost:3000/projects/f487f0a3-7c6d-4524-9f7e-6c23e249142b
```

### 3.3 ทดสอบ Mesh Export

1. Scroll ลงไปหา section **"Export Textured Mesh"**
2. เลือก:
   - Method: **Poisson**
   - Quality: **Low** (เร็วสุด - 5-10 นาที)
   - Format: **GLB**
3. กด **"Create Textured Mesh"**
4. รอจน progress แสดง 100%
5. กด **"Download GLB File"**

---

## ✅ ขั้นตอนที่ 4: ทดสอบ Command Line

### Quick Export (ถ้ามีไฟล์อยู่แล้ว)

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate

python quick_mesh_export.py f487f0a3-7c6d-4524-9f7e-6c23e249142b
```

**Output:**
```
======================================================================
  VERTEX COLOR TRANSFER & EXPORT
======================================================================
Project ID:   f487f0a3-7c6d-4524-9f7e-6c23e249142b
Dense Cloud:  fused.ply (40.7 MB)
Mesh File:    mesh_poisson.ply (151.6 MB)
======================================================================

🔄 Transferring vertex colors...
✅ Success! Mesh now has vertex colors

📦 Exporting to multiple formats...
✅ GLB File: 134.7 MB
✅ OBJ File: 400.2 MB
✅ PLY File: 141.4 MB

Duration: 24.1 seconds
======================================================================
```

---

## ✅ ขั้นตอนที่ 5: ทดสอบ Import ใน Blender

### 5.1 Import GLB File

```
Blender → File → Import → glTF 2.0 (.glb/.gltf)
เลือก: results/f487f0a3-7c6d-4524-9f7e-6c23e249142b/f487f0a3_colored_mesh.glb
```

### 5.2 เปิดใช้ Vertex Colors

1. กด `Z` → เลือก **Solid**
2. มุมขวาบน → Shading dropdown
3. เปลี่ยนจาก `Material` → `Attribute`
4. เลือก `Col`

### 5.3 ตรวจสอบผลลัพธ์

- ✅ ควรเห็น mesh พร้อมสีจากภาพต้นฉบับ
- ✅ ไม่ใช่สีเทาหรือสีเดียว
- ✅ รายละเอียดตรงกับภาพที่ถ่าย

---

## 🔧 Troubleshooting

### ❌ Backend API Error: "ModuleNotFoundError: trimesh"

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate
pip install trimesh scipy python-plyfile pymeshlab
```

### ❌ Frontend Error: "Cannot connect to backend"

```bash
# ตรวจสอบว่า Backend กำลังรันอยู่
curl http://localhost:5000/api/health

# ถ้าไม่ได้ ให้เริ่มต้น Backend:
cd Backend && source venv/bin/activate && python app.py
```

### ❌ Import ใน Blender แล้วไม่มีสี

**วิธีแก้:**
1. กด `Z` → **Solid**
2. Shading → **Attribute** → **Col**
3. ถ้ายังไม่มีสี ลองใช้ **Shade Smooth**

### ❌ Mesh Export ใช้เวลานาน

**เป็นปกติ:**
- Low quality: 5-10 นาที
- Medium quality: 10-15 นาที
- High quality: 20-40 นาที

**วิธีเร่ง:**
- ✅ ใช้ COLMAP with CUDA (เร็วกว่า CPU 10-50x)
- ✅ ลดจำนวนภาพ (100-150 ภาพเพียงพอ)

---

## 📊 Test Cases

### Test Case 1: UI Export

**Steps:**
1. เข้า `http://localhost:3000/projects/<PROJECT_ID>`
2. Scroll ไปที่ "Export Textured Mesh"
3. เลือก Poisson + Low + GLB
4. Click "Create Textured Mesh"

**Expected:**
- ✅ Progress bar แสดง 0% → 100%
- ✅ Success message ปรากฏ
- ✅ Download button ปรากฏ
- ✅ ดาวน์โหลดได้ไฟล์ GLB

### Test Case 2: API Export

**Steps:**
```bash
curl -X POST http://localhost:5000/api/project/<ID>/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"method":"poisson","quality":"low","format":"glb"}'
```

**Expected:**
```json
{
  "success": true,
  "filename": "..._colored_mesh.glb",
  "size_mb": 134.7,
  "download_url": "/api/project/.../download_mesh/..."
}
```

### Test Case 3: CLI Export

**Steps:**
```bash
python quick_mesh_export.py <PROJECT_ID>
```

**Expected:**
```
✅ GLB File: results/.../..._colored_mesh.glb (134.7 MB)
✅ OBJ File: results/.../..._colored_mesh.obj (400.2 MB)
✅ PLY File: results/.../..._colored_mesh.ply (141.4 MB)
Duration: 24.1 seconds
```

### Test Case 4: Blender Import

**Steps:**
1. Import GLB ใน Blender
2. เปิด Vertex Colors (Z → Solid → Attribute → Col)

**Expected:**
- ✅ Mesh มีสีตรงกับภาพต้นฉบับ
- ✅ ไม่มี error
- ✅ Smooth shading ทำงาน

---

## 📁 ไฟล์ที่เกี่ยวข้อง

### Backend Files

```
PobimSplatting/Backend/
├── services/
│   ├── mvs_mesher.py          # COLMAP dense reconstruction + meshing
│   └── mesh_converter.py      # Mesh format conversion
├── routes/
│   └── api.py                 # API endpoints for mesh export
├── add_colors_to_mesh.py      # Color transfer script
├── quick_mesh_export.py       # Quick CLI export (ใช้ไฟล์ที่มีแล้ว)
└── run_textured_mesh_direct.py # Full pipeline CLI export
```

### Frontend Files

```
PobimSplatting/Frontend/
├── src/
│   ├── components/
│   │   ├── MeshExportPanel.tsx      # UI สำหรับ export mesh
│   │   └── ExportedMeshesList.tsx   # แสดงรายการ mesh ที่ export แล้ว
│   ├── lib/
│   │   └── api.ts                   # API wrapper functions
│   └── app/
│       └── projects/[id]/page.tsx   # Project detail page
```

---

## 🎯 Next Steps

หลังจากทดสอบสำเร็จแล้ว:

1. **ปรับแต่ง UI**
   - เพิ่ม progress indicator สำหรับ mesh export
   - แสดง preview ของ mesh ก่อน download
   - เพิ่ม batch export (หลาย format พร้อมกัน)

2. **เพิ่ม Features**
   - Mesh simplification (ลด polygon count)
   - Texture baking (สร้าง texture map แทน vertex colors)
   - Normal map generation
   - LOD (Level of Detail) generation

3. **Performance Optimization**
   - Cache intermediate results
   - Parallel processing
   - Resume support (ถ้ายกเลิกครึ่งทาง)

4. **Documentation**
   - เพิ่ม video tutorial
   - เพิ่ม example projects
   - API documentation (Swagger/OpenAPI)

---

## 📞 Support

พบปัญหาหรือมีคำถาม?

- 📧 Email: support@pobim.com
- 💬 GitHub Issues: [POBIMOpenSplat/issues](https://github.com/POBIM/POBIMOpenSplat/issues)
- 📚 Documentation: [MESH_EXPORT_GUIDE.md](./MESH_EXPORT_GUIDE.md)

---

**สร้างโดย:** POBIM Team
**อัปเดตล่าสุด:** 2025-11-02
