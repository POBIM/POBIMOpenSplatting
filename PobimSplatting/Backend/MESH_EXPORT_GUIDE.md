# Mesh Export Guide - PLY to GLTF/GLB/DAE Converter

คู่มือการใช้งานเครื่องมือแปลง Gaussian Splat PLY เป็นรูปแบบ GLTF/GLB/DAE

## 📚 ภาพรวม

เครื่องมือนี้สามารถแปลงไฟล์ PLY จาก Gaussian Splatting เป็นรูปแบบ 3D mesh ต่างๆ ได้ 3 วิธี:

### 🎯 วิธีการแปลง

1. **Point Cloud** - Export point cloud โดยตรง (เร็ว, ไฟล์ใหญ่, คุณภาพสูง)
2. **Poisson Surface Reconstruction** - สร้าง smooth surface mesh (ช้า, ไฟล์กลาง, เหมาะสำหรับ 3D modeling)
3. **Alpha Shapes** - สร้าง convex hull approximation (เร็ว, ไฟล์เล็ก, เหมาะสำหรับ preview)

### 📦 รูปแบบไฟล์ที่รองรับ

- **GLTF** (`.gltf`) - JSON-based, human-readable
- **GLB** (`.glb`) - Binary GLTF, compact
- **DAE** (`.dae`) - Collada format

---

## 🚀 การใช้งาน

### 1. ผ่าน API (สำหรับ Frontend/External Apps)

#### Export Mesh

```bash
POST /api/project/{project_id}/export_mesh
Content-Type: application/json

{
  "format": "glb",           # gltf, glb, หรือ dae
  "method": "poisson",       # point_cloud, poisson, หรือ alpha_shapes
  "options": {               # Optional parameters
    "depth": 9,              # สำหรับ Poisson (7-12, ยิ่งสูงยิ่งละเอียด)
    "scale": 1.1,            # สำหรับ Poisson
    "point_size": 0.01       # สำหรับ Point Cloud
  }
}
```

**Response:**
```json
{
  "success": true,
  "filename": "project-id_export.glb",
  "format": "glb",
  "method": "poisson",
  "size": 2395648,
  "size_mb": 2.29,
  "download_url": "/api/project/{project_id}/download_mesh/project-id_export.glb",
  "message": "Successfully converted to GLB using poisson method"
}
```

#### Download Exported File

```bash
GET /api/project/{project_id}/download_mesh/{filename}
```

#### List Available Exports

```bash
GET /api/project/{project_id}/available_exports
```

**Response:**
```json
{
  "exports": [
    {
      "filename": "project-id_export.glb",
      "format": "glb",
      "size": 2395648,
      "size_mb": 2.29,
      "created_at": 1699012345.67,
      "download_url": "/api/project/{project_id}/download_mesh/project-id_export.glb"
    }
  ],
  "count": 1
}
```

---

### 2. ผ่าน Python Script

```python
from pathlib import Path
from services.mesh_converter import convert_ply_to_gltf

# Point Cloud Export
convert_ply_to_gltf(
    input_path="model.ply",
    output_path="output.glb",
    method="point_cloud"
)

# Poisson Surface Reconstruction
convert_ply_to_gltf(
    input_path="model.ply",
    output_path="output.glb",
    method="poisson",
    depth=10,          # Higher = more detail (7-12)
    scale=1.1          # Reconstruction scale
)

# Alpha Shapes (Convex Hull)
convert_ply_to_gltf(
    input_path="model.ply",
    output_path="output.dae",
    method="alpha_shapes"
)
```

---

### 3. ผ่าน Command Line (ใช้ curl)

```bash
# Export เป็น GLB ด้วย Poisson method
curl -X POST http://localhost:5000/api/project/PROJECT_ID/export_mesh \
  -H "Content-Type: application/json" \
  -d '{
    "format": "glb",
    "method": "poisson",
    "options": {"depth": 9}
  }'

# ดาวน์โหลดไฟล์
curl -O http://localhost:5000/api/project/PROJECT_ID/download_mesh/PROJECT_ID_export.glb
```

---

## 📊 การเปรียบเทียบวิธีการแปลง

| วิธี | ขนาดไฟล์ | ความเร็ว | คุณภาพ | Use Case |
|------|----------|---------|--------|----------|
| **Point Cloud** | ใหญ่ (15+ MB) | ⚡ เร็ว | ⭐⭐⭐⭐⭐ | Visualization, Detail work |
| **Poisson** | กลาง (2-5 MB) | 🐌 ช้า | ⭐⭐⭐⭐ | 3D Modeling, Printing |
| **Alpha Shapes** | เล็ก (<1 MB) | ⚡⚡ เร็วมาก | ⭐⭐ | Preview, Quick view |

### ผลการทดสอบ (จากไฟล์ PLY 235 MB):

- Point Cloud → GLB: **15.18 MB** (เก็บทุก point)
- Poisson → GLB: **2.29 MB** (surface reconstruction)
- Alpha Shapes → GLB: **2.7 KB** (convex hull)

---

## ⚙️ พารามิเตอร์สำหรับแต่ละวิธี

### Point Cloud
```json
{
  "point_size": 0.01    // ขนาดของ points (default: 0.01)
}
```

### Poisson Surface Reconstruction
```json
{
  "depth": 9,           // Octree depth (7-12)
                        // ต่ำ = เร็ว, ไฟล์เล็ก, detail น้อย
                        // สูง = ช้า, ไฟล์ใหญ่, detail มาก
  "scale": 1.1          // Scale factor (default: 1.1)
}
```

### Alpha Shapes
```json
{
  "alpha": 0.1          // Alpha value (ไม่ได้ใช้ใน convex hull)
}
```

---

## 🎨 ตัวอย่างการใช้งานใน Frontend (React/TypeScript)

```typescript
// Export mesh
async function exportMesh(projectId: string) {
  const response = await fetch(`/api/project/${projectId}/export_mesh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: 'glb',
      method: 'poisson',
      options: { depth: 9 }
    })
  });

  const result = await response.json();
  console.log(`File created: ${result.filename} (${result.size_mb} MB)`);

  // Download the file
  window.location.href = result.download_url;
}

// List available exports
async function listExports(projectId: string) {
  const response = await fetch(`/api/project/${projectId}/available_exports`);
  const data = await response.json();

  data.exports.forEach(exp => {
    console.log(`${exp.filename}: ${exp.size_mb} MB`);
  });
}
```

---

## 🔧 การติดตั้ง Dependencies

Dependencies ถูกเพิ่มใน `requirements.txt` แล้ว:

```bash
cd Backend
source venv/bin/activate
pip install -r requirements.txt
```

Dependencies ที่จำเป็น:
- `pymeshlab==2023.12` - Poisson reconstruction
- `scipy==1.11.4` - Scientific computing
- `pygltflib==1.16.1` - GLTF support
- `trimesh==4.0.5` - Mesh operations (มีอยู่แล้ว)
- `plyfile==1.0.2` - PLY file reading (มีอยู่แล้ว)

---

## 🐛 การแก้ปัญหา

### ❌ PyMeshLab import error
```bash
pip install pymeshlab --upgrade
```

### ❌ GLTF export failed
ตรวจสอบว่า trimesh และ pygltflib ถูกติดตั้งแล้ว:
```bash
pip install trimesh pygltflib
```

### ❌ Poisson reconstruction too slow
ลด `depth` parameter ลง (เช่น จาก 10 เป็น 8):
```json
{"depth": 8}
```

### ❌ Point cloud too large
ลด `point_size` หรือใช้ Poisson method แทน

---

## 📝 หมายเหตุ

- Gaussian Splat PLY มี spherical harmonics และ opacity ที่จะหายไปเมื่อแปลงเป็น mesh
- สี RGB จะถูก extract จาก spherical harmonics DC component
- Poisson reconstruction อาจสร้าง geometry ที่ไม่มีใน point cloud ต้นฉบับ
- Alpha Shapes ปัจจุบันใช้ convex hull approximation (ไม่ใช่ alpha shapes แบบเต็ม)

---

## 🎯 Use Cases แนะนำ

### 1. สำหรับ Web Viewer (Three.js, Babylon.js)
```json
{"format": "glb", "method": "point_cloud"}
```
→ ไฟล์ใหญ่แต่คุณภาพดีที่สุด

### 2. สำหรับ 3D Printing
```json
{"format": "glb", "method": "poisson", "options": {"depth": 10}}
```
→ ได้ watertight mesh ที่พร้อมสำหรับ slicing

### 3. สำหรับ Preview/Thumbnail
```json
{"format": "glb", "method": "alpha_shapes"}
```
→ ไฟล์เล็ก load เร็ว

### 4. สำหรับ Import เข้า Blender/Maya
```json
{"format": "dae", "method": "poisson", "options": {"depth": 9}}
```
→ DAE format รองรับหลาย DCC tools

---

## 📄 License

MIT License - Free to use and modify

---

## 👨‍💻 Developer Notes

### File Structure
```
Backend/
├── services/
│   └── mesh_converter.py      # Main converter service
├── routes/
│   └── api.py                 # API endpoints (+3 new endpoints)
├── requirements.txt           # Updated with new dependencies
└── test_mesh_converter.py     # Test script
```

### Testing
```bash
cd Backend
source venv/bin/activate
python test_mesh_converter.py
```

---

สร้างโดย Claude Code 🤖
