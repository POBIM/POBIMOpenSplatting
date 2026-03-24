# 🚀 คู่มือเร่งความเร็ว Sparse Reconstruction (ฉบับย่อ)

## TL;DR - ทำอะไรได้บ้าง?

### ✅ สิ่งที่ระบบทำให้อัตโนมัติแล้ว
1. **ใช้ GPU bundle adjustment** (PBA) - เร็วขึ้น 2-3x เมื่อมี CUDA
2. **ใช้ multi-threading** - ใช้ CPU ทุก core

### ⚡ ความเร็วที่ได้รับ
- **เร็วขึ้น 1.5-2x** เมื่อใช้ GPU-enabled COLMAP
- **CPU usage**: ใช้ทุก cores อย่างเต็มประสิทธิภาพ

---

## �️ ตรวจสอบว่า GPU ทำงานหรือไม่?

ดูใน log:
```
🚀 Using GPU-accelerated bundle adjustment (PBA)
🔧 Using 16 CPU threads for mapper
```

ถ้าเห็น:
```
ℹ️ Using CPU-only bundle adjustment
```

**แปลว่า**: COLMAP ไม่มี CUDA → ช้ากว่า

**แก้ไข**: Rebuild COLMAP with CUDA:
```bash
cd /home/pobimgroup/POBIMOpenSplat
./scripts/rebuild-colmap-with-cuda.sh
```

---

## 🎯 การเพิ่มความเร็วเพิ่มเติม

### 1. ใช้ Sequential Matcher (สำหรับวิดีโอ/ภาพเรียงลำดับ)
```json
{
  "matcher_type": "sequential",
  "custom_params": {
    "sequential_overlap": 10
  }
}
```
**ผล**: เร็วขึ้น 5-10x ใน matching + reconstruction

### 2. ลด Image Size (สำหรับภาพ >4K)
```json
{
  "custom_params": {
    "max_image_size": 2400
  }
}
```
**ผล**: เร็วขึ้น 30-50% ทุกขั้นตอน

### 3. ถ่ายภาพให้ดี
- ✅ ภาพชัด, แสงเพียงพอ
- ✅ เรียงลำดับชัดเจน (ไม่กระโดดมุม)
- ❌ หลีกเลี่ยงภาพซ้ำซ้อนมาก

---

## 🔧 Technical Details

### GPU Bundle Adjustment (PBA)
- ใช้ GPU แก้ sparse systems ใน bundle adjustment
- เร็วกว่า CPU-based Ceres solver 2-3x
- ต้อง COLMAP compile ด้วย CUDA

### Multi-threading
- ใช้ทุก CPU cores สำหรับ image registration
- ตั้งค่าอัตโนมัติด้วย `os.cpu_count()`

---

**สร้างเมื่อ**: November 7, 2025  
**เวอร์ชัน**: 1.0 (GPU + Multi-threading only)
