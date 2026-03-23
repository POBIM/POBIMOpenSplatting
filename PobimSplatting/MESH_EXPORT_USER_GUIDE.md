# 🎨 คู่มือการ Export Textured Mesh

ระบบ PobimSplatting ตอนนี้รองรับ **2 แบบ** ในการสร้าง 3D model:

## 📦 สองแบบที่ใช้ได้:

### 1. **Gaussian Splat** (เดิม)
- ✅ Real-time rendering
- ✅ คุณภาพสูงมาก
- ✅ ดูได้ใน web viewer
- ❌ ไม่สามารถแก้ไขใน Blender ได้ดี

### 2. **Textured Mesh (GLB)** (ใหม่!) ⭐
- ✅ นำเข้า Blender, Maya, Unity ได้
- ✅ มีสีจากภาพจริง
- ✅ เหมาะสำหรับ 3D printing
- ✅ แก้ไข texture ได้
- ⏱️ ใช้เวลานาน (5-20 นาที)

---

## 🚀 วิธีใช้งาน

### ขั้นตอนที่ 1: Upload และ Process
1. เข้า **Upload** page
2. อัปโหลดภาพหรือวิดีโอ
3. เลือก quality settings
4. กด **Start Processing**
5. รอให้ process เสร็จ (จะได้ Gaussian Splat อัตโนมัติ)

### ขั้นตอนที่ 2: Export เป็น Textured Mesh
1. ไปที่ **Projects** → เลือก project ของคุณ
2. เลื่อนลงมาหา **"Export Textured Mesh"** panel
3. เลือก settings:

#### 🔧 Settings ที่แนะนำ:

| การใช้งาน | Method | Quality | Format | เวลา |
|-----------|--------|---------|--------|------|
| **Preview เร็ว** | Poisson | Low | GLB | ~5 min |
| **ใช้งานทั่วไป** | Poisson | Medium | GLB | ~15 min |
| **3D Printing** | Poisson | High | OBJ | ~30 min |
| **Blender/Unity** | Poisson | Medium | GLB | ~15 min |

4. กด **"Create Textured Mesh"**
5. รอ 5-20 นาที (ขึ้นกับ quality และจำนวนภาพ)
6. เมื่อเสร็จ จะมีปุ่ม **"Download GLB File"**

---

## 📥 Import เข้า Blender

### วิธีที่ 1: Import GLB (แนะนำ)

```
1. เปิด Blender
2. File → Import → glTF 2.0 (.glb/.gltf)
3. เลือกไฟล์ GLB ที่ดาวน์โหลดมา
4. Import!
```

### เปิดใช้ Vertex Colors:

**Option A: Solid View**
```
1. กด Z → เลือก Solid
2. มุมขวาบน → Shading dropdown
3. Color → Vertex
```

**Option B: Material/Rendered View**
```
1. ไปที่ Shading workspace
2. เลือก mesh
3. Add → Input → Attribute
4. ชื่อ: "Col"
5. เชื่อม Color output → Base Color ของ Principled BSDF
```

### วิธีที่ 2: Import OBJ

```
1. File → Import → Wavefront (.obj)
2. เลือก Settings:
   - ✅ Image Search (หาก texture แยกไฟล์)
   - ✅ Keep Vert Order
3. Import
4. ทำตาม "เปิดใช้ Vertex Colors" ด้านบน
```

---

## 🎨 ตัวอย่างการใช้งาน

### Use Case 1: สร้าง Asset สำหรับเกม

**Pipeline:**
```
Upload Images/Video
  ↓
Process (Get Gaussian Splat + Sparse Recon)
  ↓
Export Mesh (GLB, Medium Quality, Poisson)
  ↓
Import to Unity/Unreal
  ↓
ปรับแต่ง materials, colliders
```

**ข้อดี:**
- GLB มี vertex colors พร้อมใช้
- Poisson watertight mesh → ทำ collider ง่าย
- Medium quality = balance ระหว่างคุณภาพกับไฟล์ไม่ใหญ่เกิน

---

### Use Case 2: 3D Printing

**Pipeline:**
```
Upload Images
  ↓
Process
  ↓
Export Mesh (OBJ, High Quality, Poisson)
  ↓
Import to Blender
  ↓
Check mesh (ปิด holes, smooth)
  ↓
Export to STL
  ↓
Slice & Print
```

**ข้อดี:**
- Poisson สร้าง watertight mesh (สำคัญสำหรับ 3D printing)
- High quality = detail เยอะ
- OBJ = universal format

---

### Use Case 3: Virtual Tour / Web Viewer

**Pipeline:**
```
Upload Video
  ↓
Process
  ↓
Use Gaussian Splat (ในตัว viewer)
```

**ไม่ต้อง export mesh!** - Gaussian Splat ดูสวยกว่าสำหรับ web viewer

---

## 🔧 Parameters Explained

### Meshing Method

| Method | คำอธิบาย | เหมาะสำหรับ |
|--------|----------|-------------|
| **Poisson** | สร้าง smooth surface, watertight | Objects, buildings, products |
| **Delaunay** | รักษา geometry ตรงต้นฉบับ | Terrain, landscapes |

### Quality Levels

| Quality | Resolution | ความเร็ว | ใช้เมื่อ |
|---------|-----------|----------|----------|
| **Low** | 1000px | ⚡⚡⚡ เร็ว | Preview, test |
| **Medium** | 2000px | ⚡⚡ ปานกลาง | Production, ส่วนใหญ่ |
| **High** | 3000px | ⚡ ช้า | Final output, printing |

### Output Formats

| Format | ขนาด | Vertex Colors | ใช้กับ |
|--------|------|---------------|---------|
| **GLB** | เล็ก | ✅ Yes | Blender, Unity, Web |
| **OBJ** | ใหญ่ | ✅ Yes | Universal (all 3D apps) |
| **PLY** | กลาง | ✅ Yes | MeshLab, CloudCompare |
| **DAE** | กลาง | ✅ Yes | SketchUp, Maya |

---

## ⚡ Performance Tips

### ลดเวลา Processing:

1. **ใช้ Low Quality สำหรับ test** - ดูก่อนว่าผลลัพธ์เป็นอย่างไร
2. **ลดจำนวนภาพ** - 30-50 ภาพก็พอสำหรับ object เล็กๆ
3. **Export ตอนกลางคืน** - High quality ใช้เวลานาน
4. **ใช้ COLMAP CUDA** - เร็วกว่า 10-50 เท่า (ระบบนี้มี CUDA อยู่แล้ว!)

### ลดขนาดไฟล์:

```
GLB (ขนาดเล็ก) < PLY < OBJ (ขนาดใหญ่)
```

ถ้าต้องการไฟล์เล็ก:
- เลือก GLB format
- ใช้ Medium หรือ Low quality
- ใน Blender: Decimate modifier เพื่อลด polygon count

---

## 🐛 Troubleshooting

### ❌ "ไม่มีสีใน Blender"

**วิธีแก้:**
1. ตรวจสอบว่า import GLB (ไม่ใช่ OBJ ที่ไม่มี vertex colors)
2. Viewport Shading → Color → Vertex
3. ถ้ายังไม่มี: ใช้ Attribute node (ชื่อ "Col")

### ❌ "Export ล้มเหลว"

**สาเหตุที่เป็นไปได้:**
1. **Project ยังไม่เสร็จ** - รอให้ sparse reconstruction เสร็จก่อน
2. **No sparse reconstruction** - ลอง retry project
3. **Out of Memory** - ลดเป็น Low quality หรือลดจำนวนภาพ

### ❌ "Mesh มี Holes"

**วิธีแก้:**
1. ใช้ **Poisson** method แทน Delaunay (fill holes อัตโนมัติ)
2. เพิ่ม quality เป็น **Medium** หรือ **High**
3. ถ่ายภาพเพิ่มในบริเวณที่มีปัญหา

### ❌ "ใช้เวลานานเกินไป"

**ปกติ:**
- Low: 5-10 นาที
- Medium: 10-20 นาที
- High: 20-40 นาที

**ถ้านานกว่านี้:** อาจมี issue - ดู backend logs หรือลอง retry

---

## 💡 Best Practices

### 1. **เริ่มจาก Gaussian Splat เสมอ**
- Process แบบปกติ → ได้ Splat
- ถ้าต้องการ mesh → Export ภายหลัง

### 2. **ทดสอบด้วย Low Quality ก่อน**
```
Low Quality (5 min) → ดูผลลัพธ์
  ↓
ถ้าโอเค → Export Medium/High
```

### 3. **เลือก Format ตามการใช้งาน**
- Blender/Maya → **GLB** (ขนาดเล็ก, มีสี)
- 3D Printing → **OBJ** (universal)
- MeshLab → **PLY**

### 4. **ใช้ Gaussian Splat สำหรับ Viewer**
- Web viewer → Splat (สวยกว่า)
- 3D modeling → Mesh

---

## 📊 เปรียบเทียบ Gaussian Splat vs Mesh

| Feature | Gaussian Splat | Textured Mesh |
|---------|----------------|---------------|
| **คุณภาพการดู** | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **Real-time rendering** | ✅ Yes | ❌ No |
| **Edit ใน Blender** | ❌ ยาก | ✅ ง่าย |
| **3D Printing** | ❌ ไม่ได้ | ✅ ได้ |
| **ขนาดไฟล์** | กลาง | เล็ก-กลาง |
| **เวลา process** | เร็ว | ช้า (+15 min) |
| **Use in Unity/Unreal** | ⚠️ ต้อง plugin | ✅ ใช้ได้เลย |

**สรุป:**
- **Viewer/Web** → Gaussian Splat
- **3D Modeling/Printing** → Textured Mesh

---

## 🎓 Video Tutorials

### แนะนำสำหรับผู้เริ่มต้น:

1. **Basic Workflow** (5 min)
   - Upload → Process → Export GLB → Import Blender

2. **Blender Vertex Colors** (3 min)
   - วิธีเปิดใช้ vertex colors ใน Blender

3. **3D Printing Workflow** (10 min)
   - Export OBJ → Check mesh → Export STL → Print

*(TODO: สร้าง video tutorials)*

---

## 📞 ต้องการความช่วยเหลือ?

- **Backend Logs**: ดูที่ `logs/backend.log`
- **Frontend Console**: กด F12 ใน browser
- **GitHub Issues**: https://github.com/your-repo/issues

---

## ✨ Tips & Tricks

### 1. **Batch Export**
ถ้ามีหลาย projects:
```python
# ใช้ Backend script
for project_id in project_list:
    create_textured_mesh(project_id, quality="medium", format="glb")
```

### 2. **Custom Pipeline**
```python
# ใน Backend
python add_colors_to_mesh.py  # สำหรับ mesh ที่ไม่มีสี
```

### 3. **API Usage**
```bash
# Export ผ่าน API
curl -X POST http://localhost:5000/api/project/PROJECT_ID/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"format": "glb", "quality": "medium", "method": "poisson"}'
```

---

สร้างโดย Claude Code 🤖 | Updated: 2025-11-02
