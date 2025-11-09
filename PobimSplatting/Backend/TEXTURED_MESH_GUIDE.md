# คู่มือสร้าง Textured Mesh แบบ OpenDroneMap

ระบบนี้รองรับการสร้าง **Textured Mesh** ที่มีสีและ texture จริงๆ จากภาพต้นฉบับ ไม่ใช่แค่ point cloud หรือ Gaussian Splat

---

## 🎯 ความแตกต่างระหว่าง Export Mesh 2 แบบ

### 1. **Export Mesh จาก Gaussian Splat** (เดิม)
- ใช้ไฟล์ PLY จาก Gaussian Splatting
- ไม่มี texture แท้จริง (แค่ vertex colors)
- เร็ว แต่เป็นแค่ "ก้อนๆ" ไม่มีรายละเอียด surface

### 2. **Textured Mesh จาก Dense Reconstruction** (ใหม่!) ⭐
- ใช้ COLMAP dense reconstruction สร้าง point cloud หนาแน่น
- มี triangle mesh พร้อม texture mapping
- **เหมือน OpenDroneMap** - มีสี texture จากภาพจริง
- ช้ามาก (10-60 นาที) แต่คุณภาพสูง

---

## 📦 ขั้นตอนการทำงาน

```
1. Sparse Reconstruction (COLMAP)
   └─> มีอยู่แล้วจากการประมวลผลปกติ

2. Dense Reconstruction (COLMAP)
   ├─> image_undistorter: แก้ distortion และ resize
   ├─> patch_match_stereo: สร้าง depth map (ช้ามาก!)
   └─> stereo_fusion: รวม depth maps เป็น dense point cloud

3. Mesh Generation
   ├─> poisson_mesher: สร้าง smooth surface (แนะนำ)
   └─> delaunay_mesher: สร้าง mesh จาก triangulation

4. Texturing
   └─> ใช้ภาพต้นฉบับสร้าง texture atlas
```

---

## 🚀 วิธีใช้งาน

### ผ่าน API

```bash
POST /api/project/{project_id}/create_textured_mesh
Content-Type: application/json

{
  "method": "poisson",      # หรือ "delaunay"
  "quality": "medium",       # "low", "medium", "high"
  "format": "obj"            # "ply", "obj", "glb", "dae"
}
```

**Response:**
```json
{
  "success": true,
  "filename": "project-id_textured_mesh_poisson.obj",
  "format": "obj",
  "method": "poisson",
  "quality": "medium",
  "size": 15728640,
  "size_mb": 15.0,
  "download_url": "/api/project/{project_id}/download_mesh/..."
}
```

### ผ่าน curl

```bash
# สร้าง textured mesh แบบ Poisson, คุณภาพ medium
curl -X POST http://localhost:5000/api/project/YOUR_PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "medium",
    "format": "obj"
  }'

# ดาวน์โหลดไฟล์
curl -O http://localhost:5000/api/project/YOUR_PROJECT_ID/download_mesh/YOUR_PROJECT_ID_textured_mesh_poisson.obj
```

### ผ่าน Python

```python
from services.mvs_mesher import create_textured_mesh

success = create_textured_mesh(
    project_path="uploads/project-id",
    sparse_model_path="uploads/project-id/sparse/0",
    output_path="results/project-id/textured_mesh.obj",
    method="poisson",
    quality="medium",
    colmap_executable="colmap"
)
```

---

## ⚙️ พารามิเตอร์

### Method (วิธีการสร้าง mesh)

| Method | คำอธิบาย | ข้อดี | ข้อเสีย |
|--------|----------|-------|---------|
| **poisson** | Poisson Surface Reconstruction | Smooth, watertight | อาจเพิ่ม geometry ที่ไม่มีจริง |
| **delaunay** | Delaunay Triangulation | รักษา geometry ตรงต้นฉบับ | อาจมี holes |

### Quality (คุณภาพ)

| Quality | Max Image Size | ความเร็ว | ใช้เมื่อ |
|---------|----------------|----------|----------|
| **low** | 1000px | ⚡⚡ เร็ว | ทดสอบ, preview |
| **medium** | 2000px | ⚡ ปานกลาง | ใช้งานทั่วไป (แนะนำ) |
| **high** | 3000px | 🐌 ช้า | คุณภาพสูงสุด, 3D printing |

### Format (รูปแบบไฟล์)

| Format | คำอธิบาย | Texture Support | ใช้กับ |
|--------|----------|-----------------|---------|
| **PLY** | Point Cloud / Mesh | Vertex colors only | MeshLab, CloudCompare |
| **OBJ** | Wavefront OBJ | ✅ Full texture (MTL) | Blender, Maya, 3ds Max |
| **GLB** | Binary glTF | ✅ Embedded textures | Web viewers, Unity, Unreal |
| **DAE** | Collada | ✅ XML-based | SketchUp, Unity |

---

## 📊 ประมาณเวลาและขนาดไฟล์

### เวลาประมวลผล (โดยประมาณ)

**สำหรับ project ที่มี ~50 ภาพ:**

| Quality | มี GPU (CUDA) | ไม่มี GPU (CPU) |
|---------|---------------|----------------|
| Low | 5-10 นาที | 15-30 นาที |
| Medium | 10-20 นาที | 30-60 นาที |
| High | 20-40 นาที | 60-120 นาที |

**หมายเหตุ:**
- COLMAP 3.9.1 on this system: **ไม่มี CUDA** → ใช้เวลานานมาก
- ภาพยิ่งมากยิ่งช้า (เพิ่ม 30-50% ต่อ 50 ภาพเพิ่ม)
- Poisson meshing เร็วกว่า Delaunay

### ขนาดไฟล์ผลลัพธ์

| Format | ขนาดโดยประมาณ | หมายเหตุ |
|--------|---------------|----------|
| PLY | 5-20 MB | ไม่มี texture แยก |
| OBJ + MTL | 10-50 MB + textures | Texture แยกไฟล์ |
| GLB | 15-60 MB | Texture รวมในไฟล์เดียว |
| DAE | 10-40 MB + textures | XML format |

---

## 🔧 ข้อกำหนดระบบ

### ซอฟต์แวร์
- ✅ COLMAP 3.9.1+ พร้อม dense reconstruction support
- ✅ PyMeshLab (ติดตั้งแล้วใน requirements.txt)
- ⚠️ CUDA (optional แต่แนะนำมาก - เร็วกว่า 10-50 เท่า)

### ฮาร์ดแวร์
- **RAM**: อย่างน้อย 8GB (แนะนำ 16GB+)
- **CPU**: Multi-core (ยิ่งมากยิ่งดี)
- **GPU**: NVIDIA GPU + CUDA (optional แต่จะเร็วมาก)
- **Storage**: ~5-10 GB ต่อ project (สำหรับ dense workspace)

---

## 🐛 การแก้ปัญหา

### ❌ "COLMAP without CUDA" - ช้ามาก

**ปัญหา:** COLMAP ไม่มี CUDA support → ใช้ CPU → ช้ามาก

**วิธีแก้:**
1. **ติดตั้ง COLMAP ที่มี CUDA:**
   ```bash
   # Build COLMAP from source with CUDA support
   # See: https://colmap.github.io/install.html
   ```

2. **ใช้ quality="low" ขณะทดสอบ:**
   ```json
   {"quality": "low", "method": "poisson"}
   ```

3. **ลดจำนวนภาพ:**
   - เลือกภาพที่ดีที่สุด ~30-50 ภาพ
   - ไม่ต้องใช้ทุกภาพ

### ❌ Out of Memory

**ปัญหา:** RAM ไม่พอ

**วิธีแก้:**
1. ใช้ `quality="low"`
2. ลดจำนวนภาพ
3. ปิดโปรแกรมอื่นๆ

### ❌ "No sparse reconstruction found"

**ปัญหา:** ยังไม่มี sparse reconstruction

**วิธีแก้:**
- ประมวลผล project ให้เสร็จก่อน (sparse reconstruction stage)
- ตรวจสอบว่ามีโฟลเดอร์ `uploads/{project_id}/sparse/0/`

### ❌ Mesh มี holes หรือ artifacts

**ปัญหา:** Dense reconstruction ไม่สมบูรณ์

**วิธีแก้:**
1. ใช้ `method="poisson"` แทน `delaunay` (fill holes อัตโนมัติ)
2. เพิ่ม `quality="high"` สำหรับ dense point cloud หนาแน่นขึ้น
3. ถ่ายภาพเพิ่มเติมเฉพาะบริเวณที่มีปัญหา

### ❌ Texture ไม่สวย / มีสีผิดปกติ

**ปัญหา:** Texture mapping ไม่ดี

**วิธีแก้:**
1. ใช้ภาพต้นฉบับคุณภาพสูง (ไม่มีความมืด/สว่างผิดปกติ)
2. ลองเปลี่ยนจาก OBJ เป็น GLB format
3. นำไปแก้ใน Blender/MeshLab (UV unwrapping ใหม่)

---

## 💡 เคล็ดลับ

### 1. **เริ่มต้นด้วย Low Quality**
```json
{"quality": "low", "method": "poisson", "format": "ply"}
```
- ดู preview ก่อนว่าผลลัพธ์เป็นอย่างไร
- ถ้าพอใจค่อยทำแบบ medium/high

### 2. **Poisson สำหรับ object, Delaunay สำหรับ terrain**
- **Poisson**: เหมาะกับวัตถุปิด (รถ, อาคาร, คน)
- **Delaunay**: เหมาะกับพื้นผิว (ภูมิประเทศ, ถนน)

### 3. **ใช้ OBJ สำหรับ import เข้า Blender**
```json
{"format": "obj"}
```
- OBJ + MTL + textures
- Blender อ่านได้ดีที่สุด
- แก้ไข UV, textures ได้ง่าย

### 4. **ใช้ GLB สำหรับ web viewer**
```json
{"format": "glb"}
```
- ไฟล์เดียว รวม textures
- Three.js, Babylon.js โหลดได้เลย

### 5. **ทำ Dense Reconstruction ช่วงกลางคืน**
- ใช้เวลานาน ไม่ต้องดูแล
- ตั้งค่า quality="medium" หรือ "high"

---

## 📝 เปรียบเทียบกับ OpenDroneMap

| Feature | OpenDroneMap | PobimSplatting |
|---------|--------------|----------------|
| **Input** | Drone images | Any images/videos |
| **Sparse Recon** | OpenSfM | COLMAP |
| **Dense Recon** | OpenMVS | COLMAP PatchMatch |
| **Meshing** | OpenMVS Poisson | COLMAP Poisson/Delaunay |
| **Texturing** | MVS Texturing | PyMeshLab + Vertex Colors |
| **Output** | OBJ + MTL + JPG | OBJ/PLY/GLB/DAE |
| **Speed** | ช้า | ช้าพอๆ กัน |
| **Quality** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |

**ข้อแตกต่างหลัก:**
- OpenDroneMap มี **MVS Texturing** ที่ดีกว่า (multi-band blending)
- PobimSplatting มี **Gaussian Splatting** เพิ่มเติม (real-time rendering)
- PobimSplatting **flexible** กว่า (รองรับ video, custom parameters)

---

## 🎨 ตัวอย่างการใช้งาน

### Use Case 1: สร้าง 3D model สำหรับ 3D Printing

```bash
curl -X POST http://localhost:5000/api/project/PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "high",
    "format": "obj"
  }'
```

→ ได้ watertight mesh พร้อม texture สำหรับ print

### Use Case 2: สร้าง asset สำหรับ game engine

```bash
curl -X POST http://localhost:5000/api/project/PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "medium",
    "format": "glb"
  }'
```

→ ได้ GLB import เข้า Unity/Unreal Engine ได้เลย

### Use Case 3: Preview เร็วๆ

```bash
curl -X POST http://localhost:5000/api/project/PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "method": "poisson",
    "quality": "low",
    "format": "ply"
  }'
```

→ ได้ preview ภายใน 10-15 นาที

---

## 📚 แหล่งข้อมูลเพิ่มเติม

- **COLMAP Documentation**: https://colmap.github.io/
- **PyMeshLab**: https://pymeshlab.readthedocs.io/
- **OpenDroneMap**: https://www.opendronemap.org/
- **glTF Format**: https://www.khronos.org/gltf/

---

## ✅ Checklist ก่อนเริ่มใช้งาน

- [ ] Project ประมวลผลเสร็จแล้ว (มี sparse reconstruction)
- [ ] COLMAP ติดตั้งพร้อมใช้งาน (`colmap -h`)
- [ ] มี RAM อย่างน้อย 8GB ว่าง
- [ ] มีพื้นที่ disk ~10GB ว่างสำหรับ dense workspace
- [ ] เข้าใจว่าจะใช้เวลานาน (10-60 นาที)
- [ ] เตรียม coffee/tea ไว้รอ ☕

---

สร้างโดย Claude Code 🤖
