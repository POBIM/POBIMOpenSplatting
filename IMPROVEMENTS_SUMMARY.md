# ระบบปรับปรุงการเลือกเฟรมและ COLMAP Configuration

## การปรับปรุงที่ทำ

### 1. VideoProcessor ที่ปรับปรุงแล้ว

#### กลยุทธ์การเลือกเฟรมใหม่:
- **Smart Strategy**: ปรับอัตโนมัติตามความยาววิดีโอ
  - วิดีโอ ≤1 นาที: 2 FPS
  - วิดีโอ 1-3 นาที: 1.5 FPS
  - วิดีโอ 3-5 นาที: 1 FPS
  - วิดีโอ 5-10 นาที: 0.7 FPS
  - วิดีโอ >10 นาที: 0.5 FPS

- **Target FPS**: กำหนด FPS ที่ต้องการ (0.5, 1, 1.5, 2, 3)
- **Fixed Count**: จำนวนเฟรมคงที่ (50, 100, 200, 500, 1000)
- **Time Interval**: ระยะห่างเวลา (1, 2, 3, 5, 10 วินาที)

#### การตรวจสอบคุณภาพขั้นสูง:
- **Motion Blur Detection**: ใช้ Laplacian variance (threshold 150)
- **Edge Density Analysis**: ตรวจสอบความหนาแน่นของ edge (>5%)
- **Brightness/Contrast Validation**: กรองภาพมืด/สว่างเกินไป
- **Advanced Similarity Check**: ใช้ histogram correlation
- **Focus Quality Assessment**: ใช้ gradient magnitude

### 2. Dynamic COLMAP Configuration

#### การปรับตามจำนวนภาพ:

**≤100 ภาพ (Small Dataset)**:
- Max Image Size: 3200px
- Max Features: 8192
- Matcher: Exhaustive
- Max Matches: 32768

**101-300 ภาพ (Medium Dataset)**:
- Max Image Size: 2400px
- Max Features: 6144
- Matcher: Sequential (overlap 10)
- Max Matches: 16384

**301-500 ภาพ (Large Dataset)**:
- Max Image Size: 2000px
- Max Features: 4096
- Matcher: Spatial
- Max Matches: 8192

**>500 ภาพ (Very Large Dataset)**:
- Max Image Size: 1600px
- Max Features: 3072
- Matcher: Sequential (overlap 5)
- Max Matches: 4096

### 3. User Interface ใหม่

#### ตัวเลือกการเลือกเฟรม:
- Dropdown สำหรับเลือก Strategy
- ตัวเลือกย่อยที่แสดง/ซ่อนตาม Strategy
- Preview แสดงผลลัพธ์ที่คาดการณ์
- คำอธิบายแต่ละโหมด

#### การแสดงผล:
- แสดงจำนวนเฟรมที่คาดว่าจะได้
- แสดงระดับคุณภาพ (High/Good/Moderate)
- แสดงคำอธิบายการทำงาน

### 4. Backend Integration

#### การรับ Configuration:
```python
config = {
    'extraction_strategy': 'smart',
    'target_fps': 1.0,
    'max_frames': 100,
    'time_interval': 3.0,
    'quality_threshold': 0.7
}
```

#### Logging ที่ปรับปรุง:
- แสดงจำนวนภาพทั้งหมด
- แสดงกลยุทธ์ COLMAP ที่เลือก
- แสดงการตั้งค่าที่ optimize แล้ว

## ประโยชน์ที่ได้รับ

### คุณภาพ:
- ภาพที่คุณภาพดีขึ้น (ไม่เบลอ, มี texture)
- การกรองภาพซ้ำซ้อนที่แม่นยำ
- COLMAP parameters ที่เหมาะสมกับข้อมูล

### ความเร็ว:
- ลดเวลา processing สำหรับวิดีโอยาว
- COLMAP ทำงานเร็วขึ้นด้วย parameters ที่ optimize
- ลดการใช้ memory และ CPU

### ความยืดหยุ่น:
- ผู้ใช้เลือกได้ตามลักษณะวิดีโอ
- Auto-scaling สำหรับวิดีโอยาว (5+ นาที)
- แสดงการคาดการณ์ผลลัพธ์ล่วงหน้า

## การใช้งาน

1. **สำหรับวิดีโอสั้น (≤3 นาที)**: ใช้ Smart Strategy
2. **สำหรับวิดีโอยาว (>5 นาที)**: ใช้ Target FPS หรือ Time Interval
3. **สำหรับจำนวนเฟรมที่ควบคุมได้**: ใช้ Fixed Count
4. **สำหรับคุณภาพสูงสุด**: ใช้ Target FPS สูง (2-3 FPS)

## ไฟล์ที่ปรับปรุง

- `utils/video_processor.py`: ระบบ extraction ใหม่
- `templates/index.html`: UI และ JavaScript
- `app.py`: Backend integration และ COLMAP config