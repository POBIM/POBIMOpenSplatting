# 🎨 Textured Mesh Export Guide

## คู่มือการ Export Mesh แบบมีสีสำหรับ PobimSplatting

---

## 📋 สารบัญ

1. [ภาพรวม](#ภาพรวม)
2. [วิธีใช้งานผ่าน Frontend (UI)](#วิธีใช้งานผ่าน-frontend-ui)
3. [วิธีใช้งานผ่าน Backend (API)](#วิธีใช้งานผ่าน-backend-api)
4. [วิธีใช้งานผ่าน Command Line](#วิธีใช้งานผ่าน-command-line)
5. [ตัวเลือกและค่าที่แนะนำ](#ตัวเลือกและค่าที่แนะนำ)
6. [การนำไฟล์ไปใช้งาน](#การนำไฟล์ไปใช้งาน)
7. [แก้ปัญหาที่พบบ่อย](#แก้ปัญหาที่พบบ่อย)

---

## ภาพรวม

### ✨ Mesh Export ทำอะไรได้บ้าง?

Textured Mesh Export สร้าง **3D Model แบบมี Surface และสีจริง** จาก Gaussian Splat โดย:

- ✅ สร้าง **Triangle Mesh** (มี surface จริง ไม่ใช่แค่ point cloud)
- ✅ ถ่ายโอน**สีจากภาพต้นฉบับ** มาลงบน mesh (vertex colors)
- ✅ Export เป็น **GLB, OBJ, PLY, DAE** - เข้ากันได้กับโปรแกรม 3D ทั่วไป
- ✅ พร้อมใช้งานใน **Blender, Maya, Unity, Unreal Engine, Three.js**

### 🎯 ความแตกต่างระหว่าง Gaussian Splat และ Textured Mesh

| คุณสมบัติ | Gaussian Splat (PLY) | Textured Mesh (GLB/OBJ) |
|-----------|---------------------|------------------------|
| **Surface** | ❌ ไม่มี (point cloud) | ✅ มี triangle mesh |
| **สี** | ✅ มี (splat colors) | ✅ มี (vertex colors) |
| **ขนาดไฟล์** | ~165 MB | ~135-400 MB |
| **Blender Import** | ⚠️ ต้องใช้ plugin | ✅ Import ได้ทันที |
| **Web Viewer** | ✅ เร็วมาก | ✅ ปานกลาง |
| **3D Print** | ❌ ไม่ได้ | ✅ ได้ |
| **Game Engine** | ⚠️ จำกัด | ✅ รองรับเต็มที่ |

---

## วิธีใช้งานผ่าน Frontend (UI)

### ขั้นตอนที่ 1: เข้าสู่หน้า Project Detail

1. ไปที่ **Projects** page
2. คลิกที่ project ที่ต้องการ export
3. รอให้ project **สถานะ Completed**

### ขั้นตอนที่ 2: Export Textured Mesh

ในหน้า Project Detail จะมี section **"Export Textured Mesh"**:

#### 1️⃣ เลือก **Meshing Method**:

- **Poisson** (แนะนำ) - สร้าง smooth, watertight surface
  - ✅ เหมาะกับ: วัตถุ, ตึก, รูปปั้น
  - ✅ ผิวเรียบ, ไม่มีรู
  
- **Delaunay** - รักษารูปทรงเดิม
  - ✅ เหมาะกับ: ภูมิประเทศ, พื้นที่กว้าง
  - ⚠️ อาจมีรู

#### 2️⃣ เลือก **Quality**:

| Quality | เวลา | คำอธิบาย |
|---------|------|----------|
| **Low** | 5-10 นาที | ✅ ดีสำหรับ preview/testing |
| **Medium** | 10-15 นาที | ✅ แนะนำ - สมดุลระหว่างคุณภาพและเวลา |
| **High** | 20-40 นาที | ✅ คุณภาพสูงสุด สำหรับงาน production |

#### 3️⃣ เลือก **Output Format**:

| Format | ขนาด | ใช้กับโปรแกรม |
|--------|------|---------------|
| **GLB** | ~135 MB | ✅ **แนะนำ** - Blender, Unity, Three.js |
| **OBJ** | ~400 MB | Maya, 3ds Max, Cinema 4D |
| **PLY** | ~142 MB | MeshLab, CloudCompare |
| **DAE** | ~300 MB | SketchUp, Collada |

#### 4️⃣ กด **"Create Textured Mesh"**

- รอ 5-40 นาที (ขึ้นอยู่กับ quality)
- Progress จะแสดงใน UI
- เมื่อเสร็จจะมีปุ่ม **Download** ปรากฏ

### ขั้นตอนที่ 3: ดาวน์โหลดและใช้งาน

- กดปุ่ม **Download GLB File** (หรือ format ที่เลือก)
- นำไฟล์ไป import ใน Blender หรือโปรแกรมที่ต้องการ

---

## วิธีใช้งานผ่าน Backend (API)

### 1. Create Textured Mesh

```bash
curl -X POST http://localhost:5000/api/project/<PROJECT_ID>/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "medium",
    "format": "glb"
  }'
```

**Response:**
```json
{
  "success": true,
  "filename": "f487f0a3_colored_mesh.glb",
  "format": "glb",
  "method": "poisson",
  "quality": "medium",
  "size": 141234567,
  "size_mb": 134.7,
  "download_url": "/api/project/<PROJECT_ID>/download_mesh/f487f0a3_colored_mesh.glb",
  "message": "Successfully created textured mesh using poisson method with medium quality"
}
```

### 2. List Available Exports

```bash
curl http://localhost:5000/api/project/<PROJECT_ID>/available_exports
```

**Response:**
```json
{
  "exports": [
    {
      "filename": "f487f0a3_colored_mesh.glb",
      "format": "glb",
      "size": 141234567,
      "size_mb": 134.7,
      "created_at": 1730561234,
      "download_url": "/api/project/<PROJECT_ID>/download_mesh/f487f0a3_colored_mesh.glb"
    },
    {
      "filename": "f487f0a3_colored_mesh.obj",
      "format": "obj",
      "size": 419876543,
      "size_mb": 400.2,
      "created_at": 1730561234,
      "download_url": "/api/project/<PROJECT_ID>/download_mesh/f487f0a3_colored_mesh.obj"
    }
  ]
}
```

### 3. Download Mesh

```bash
curl -O http://localhost:5000/api/project/<PROJECT_ID>/download_mesh/f487f0a3_colored_mesh.glb
```

---

## วิธีใช้งานผ่าน Command Line

### Quick Export (ใช้ไฟล์ที่มีอยู่แล้ว)

ถ้ามี dense reconstruction และ mesh อยู่แล้ว (จากการรัน full pipeline):

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate

python quick_mesh_export.py <PROJECT_ID>
```

**ผลลัพธ์:**
- ✅ GLB file (135 MB)
- ✅ OBJ file (400 MB)
- ✅ PLY file (142 MB)
- ⏱️ เวลา: ~24 วินาที (เร็วมาก!)

### Full Pipeline (สร้างใหม่ทั้งหมด)

ถ้ายังไม่มี dense reconstruction:

```bash
cd /home/pobimgroup/POBIMOpenSplat/PobimSplatting/Backend
source venv/bin/activate

python run_textured_mesh_direct.py
```

จากนั้นเลือก:
- Project ID
- Quality (low/medium/high)

**ผลลัพธ์:**
- Dense reconstruction
- Poisson mesh
- Colored mesh (GLB, OBJ, PLY)
- ⏱️ เวลา: ~20-40 นาที (ขึ้นอยู่กับ quality และจำนวนภาพ)

---

## ตัวเลือกและค่าที่แนะนำ

### สำหรับ Preview/Testing

```json
{
  "method": "poisson",
  "quality": "low",
  "format": "glb"
}
```

- ⏱️ เวลา: 5-10 นาที
- 📦 ขนาด: ~100-150 MB
- ✅ เหมาะกับ: ดูผลลัพธ์ก่อนทำ final render

### สำหรับงานทั่วไป (แนะนำ)

```json
{
  "method": "poisson",
  "quality": "medium",
  "format": "glb"
}
```

- ⏱️ เวลา: 10-15 นาที
- 📦 ขนาด: ~130-180 MB
- ✅ เหมาะกับ: งานส่วนใหญ่, balanced quality

### สำหรับ Production/Final

```json
{
  "method": "poisson",
  "quality": "high",
  "format": "glb"
}
```

- ⏱️ เวลา: 20-40 นาที
- 📦 ขนาด: ~200-300 MB
- ✅ เหมาะกับ: งาน production, presentation

---

## การนำไฟล์ไปใช้งาน

### 🎨 Blender

#### ขั้นตอนที่ 1: Import ไฟล์

```
File → Import → glTF 2.0 (.glb/.gltf)
เลือกไฟล์: <project_id>_colored_mesh.glb
```

#### ขั้นตอนที่ 2: เปิดใช้ Vertex Colors

1. กด `Z` → เลือก **Solid** mode
2. มุมขวาบน → **Shading dropdown**
3. เปลี่ยนจาก `Material` → `Attribute`
4. เลือก `Col`

#### ขั้นตอนที่ 3: Smooth Shading (Optional)

- คลิกขวาที่ mesh
- เลือก **Shade Smooth**

### 🎮 Unity

```csharp
// Import GLB ลงใน Assets/
// Drag & drop ไฟล์เข้า Scene
// Vertex colors จะแสดงอัตโนมัติ
```

### 🌐 Three.js (Web)

```javascript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
loader.load('model.glb', (gltf) => {
  scene.add(gltf.scene);
  // Vertex colors จะแสดงอัตโนมัติ
});
```

### 🖨️ 3D Printing

1. Import ไฟล์ OBJ หรือ PLY ลงใน slicer software
2. Scale และ orient ตามต้องการ
3. Export เป็น STL สำหรับ printing
4. ใช้ colorful filament หรือ full-color printing service

---

## แก้ปัญหาที่พบบ่อย

### ❌ ไม่เห็นสีใน Blender

**สาเหตุ:** Viewport shading ไม่ถูกต้อง

**วิธีแก้:**
1. กด `Z` → เลือก **Solid**
2. Shading dropdown → เปลี่ยนเป็น **Attribute** → เลือก **Col**

---

### ❌ Export ล้มเหลว: "COLMAP not found"

**สาเหตุ:** ไม่พบ COLMAP binary

**วิธีแก้:**
```bash
# ตรวจสอบว่ามี COLMAP
which colmap

# ถ้าไม่มี ติดตั้ง:
sudo apt install colmap  # Ubuntu/Debian
brew install colmap      # macOS
```

---

### ❌ Export ล้มเหลด: "Sparse reconstruction not found"

**สาเหตุ:** Project ยังไม่ complete COLMAP sparse reconstruction

**วิธีแก้:**
1. รอให้ project status เป็น **Completed**
2. ตรวจสอบว่ามี folder `sparse/0/` ใน project
3. ถ้าไม่มี ให้ retry project จาก stage **sparse_reconstruction**

---

### ❌ ใช้เวลานานกว่าที่คาดไว้

**สาเหตุ:** Dense reconstruction ต้องประมวลผลทุกภาพ

**แนวทางแก้:**
- ใช้ **quality: low** สำหรับทดสอบก่อน
- ลดจำนวนภาพ (extraction_mode: auto, max_frames: 100)
- รอให้ COLMAP ทำงานเสร็จ (GPU acceleration ช่วยให้เร็วขึ้น)

---

### ❌ ไฟล์ขนาดใหญ่เกินไป

**แนวทางแก้:**
1. ใช้ **GLB** แทน **OBJ** (ไฟล์เล็กกว่า)
2. ใช้ **quality: low** หรือ **medium**
3. ใน Blender: Decimate modifier เพื่อลด polygon count

---

## 💡 Tips & Best Practices

### ⚡ เพิ่มความเร็ว

- ✅ ใช้ COLMAP with CUDA support (เร็วขึ้น 10-50x)
- ✅ ลดจำนวนภาพ (100-150 ภาพเพียงพอ)
- ✅ ใช้ quality: low สำหรับ preview

### 🎯 คุณภาพดีขึ้น

- ✅ ใช้ quality: medium หรือ high
- ✅ ถ่ายภาพ overlap มาก (70-80%)
- ✅ แสงสม่ำเสมอ ไม่แรงเกินไป

### 💾 ประหยัดพื้นที่

- ✅ Export เฉพาะ format ที่ต้องการ
- ✅ ลบ intermediate files (dense/stereo/) หลัง export เสร็จ
- ✅ ใช้ compression tools สำหรับ archive

---

## 📚 เอกสารเพิ่มเติม

- [COLMAP Documentation](https://colmap.github.io/)
- [Blender Manual - Vertex Colors](https://docs.blender.org/manual/en/latest/sculpt_paint/vertex_paint/index.html)
- [GLB/GLTF Format Specification](https://www.khronos.org/gltf/)

---

## 🎉 สรุป

ตอนนี้คุณสามารถ export **Textured Mesh แบบมีสี** จาก Gaussian Splat แล้ว! 

**Quick Reference:**

```bash
# UI: Projects → Project Detail → Export Textured Mesh → Create

# API:
curl -X POST http://localhost:5000/api/project/<ID>/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"method":"poisson","quality":"medium","format":"glb"}'

# CLI (Quick):
python quick_mesh_export.py <PROJECT_ID>

# CLI (Full):
python run_textured_mesh_direct.py
```

**แนะนำสำหรับเริ่มต้น:**
- Method: **Poisson**
- Quality: **Medium**
- Format: **GLB**

มีคำถามเพิ่มเติมหรือพบปัญหา? เปิด issue ใน GitHub หรือติดต่อทีมพัฒนา! 🚀
