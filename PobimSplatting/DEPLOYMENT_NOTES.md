# 🚀 Deployment Notes - Mesh Export Feature

## สิ่งที่เพิ่มเข้ามาใหม่

### Backend (Python/Flask)
- ✅ `services/mvs_mesher.py` - Dense reconstruction + Poisson/Delaunay meshing
- ✅ `services/mesh_converter.py` - Point cloud to GLTF/GLB/DAE
- ✅ `add_colors_to_mesh.py` - Transfer vertex colors from dense point cloud
- ✅ 3 API endpoints ใหม่:
  - `POST /api/project/{id}/create_textured_mesh` - สร้าง textured mesh
  - `GET /api/project/{id}/download_mesh/{filename}` - ดาวน์โหลด
  - `GET /api/project/{id}/available_exports` - ดูรายการที่ export แล้ว
- ✅ Updated `requirements.txt` with: pymeshlab, scipy, pygltflib

### Frontend (Next.js/React)
- ✅ `components/MeshExportPanel.tsx` - UI สำหรับ export mesh
- ✅ `components/ExportedMeshesList.tsx` - แสดงรายการ exports
- ✅ `app/api/projects/[id]/create_textured_mesh/route.ts` - API proxy
- ✅ `app/api/projects/[id]/available_exports/route.ts` - API proxy
- ✅ Updated `app/projects/[id]/page.tsx` - เพิ่ม mesh export UI

## 📦 Dependencies ที่ต้องติดตั้ง

```bash
cd Backend
source venv/bin/activate
pip install pymeshlab==2023.12 scipy==1.11.4 pygltflib==1.16.1
```

## ⚙️ System Requirements

- COLMAP with dense reconstruction support (patch_match_stereo)
- CUDA recommended for fast processing (แต่ CPU ก็ทำงานได้)
- RAM: 8GB+ recommended
- Disk space: ~5-10 GB per project (for dense workspace)

## 🔥 การ Deploy

### 1. Backend
```bash
cd Backend
git pull
source venv/bin/activate
pip install -r requirements.txt

# Production-style backend start
gunicorn --config gunicorn.conf.py "PobimSplatting.Backend.app:app"

# หรือใช้ launcher จาก root ของ PobimSplatting
cd ..
FLASK_ENV=production ./start.sh start
```

> หมายเหตุ: production path นี้ใช้ Gunicorn แบบ `gthread` และเก็บ `workers=1` เพื่อให้ Flask-SocketIO ที่ใช้ room state ใน process เดียวกันทำงานได้อย่างปลอดภัย

### 2. Frontend
```bash
cd Frontend
git pull
npm install  # ถ้ามี dependencies ใหม่
npm run build
# Restart frontend
```

### 3. ทดสอบ
```bash
# เรียก API ทดสอบ
curl -X POST http://localhost:5000/api/project/PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"format": "glb", "quality": "low", "method": "poisson"}'
```

## 🎯 Features Overview

1. **Two Workflows:**
   - Gaussian Splat (existing) - Real-time rendering
   - Textured Mesh (new) - Traditional 3D model with colors

2. **3 Meshing Methods:**
   - Point Cloud export - Fast, no surface
   - Poisson - Smooth, watertight surfaces
   - Alpha Shapes - Convex hull approximation

3. **4 Output Formats:**
   - GLB - Binary glTF (recommended for Blender)
   - OBJ - Wavefront (universal)
   - PLY - Point cloud format
   - DAE - Collada (XML-based)

4. **3 Quality Levels:**
   - Low - Fast preview (~5 min)
   - Medium - Production use (~15 min)
   - High - Best quality (~30+ min)

## 📝 User Guide

Comprehensive user guide available at:
- `MESH_EXPORT_USER_GUIDE.md` - คู่มือผู้ใช้ภาษาไทย
- `TEXTURED_MESH_GUIDE.md` - คู่มือเทคนิคสำหรับ dev

## ⚠️ Known Issues

1. **First export takes longer** - COLMAP needs to build dense workspace
2. **Large projects (200+ images)** - May take 30-60 minutes even on low quality
3. **Without CUDA** - Processing is 10-50x slower
4. **Texture not appearing in Blender** - Need to enable vertex colors (see user guide)

## 🔧 Troubleshooting

### Backend not responding during mesh export
- Normal - dense reconstruction takes time
- Check `backend.log` for progress
- Monitor COLMAP processes: `ps aux | grep colmap`

### Out of memory
- Use quality="low"
- Reduce number of images
- Close other applications

### Export failed
- Check COLMAP installation: `colmap -h | grep patch_match_stereo`
- Ensure sparse reconstruction completed
- Check disk space

## 📊 Performance Benchmarks

Tested on: COLMAP 3.13.0 with CUDA, 135 images

| Quality | Time (CUDA) | Output Size |
|---------|-------------|-------------|
| Low | 5-8 min | 135 MB (GLB) |
| Medium | 15-20 min | 200-300 MB |
| High | 30-45 min | 400-600 MB |

## 🎓 For Developers

### API Endpoints

```python
# Create textured mesh
POST /api/project/{id}/create_textured_mesh
{
  "method": "poisson",  # or "delaunay"
  "quality": "medium",  # or "low", "high"  
  "format": "glb"       # or "obj", "ply", "dae"
}

# Download mesh
GET /api/project/{id}/download_mesh/{filename}

# List exports
GET /api/project/{id}/available_exports
```

### Python Usage

```python
from services.mvs_mesher import create_textured_mesh

success = create_textured_mesh(
    project_path="uploads/project-id",
    sparse_model_path="uploads/project-id/sparse/0",
    output_path="results/project-id/mesh.glb",
    method="poisson",
    quality="medium"
)
```

## ✅ Deployment Checklist

- [ ] Backend dependencies installed
- [ ] Frontend built and deployed
- [ ] COLMAP with dense reconstruction available
- [ ] Test mesh export with sample project
- [ ] User guide accessible to users
- [ ] Monitor logs for errors

---

Deployed: 2025-11-02
Version: 1.0.0
