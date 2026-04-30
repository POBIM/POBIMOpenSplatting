# แนวทาง Hybrid Pipeline: COLMAP + MapAnything สำหรับ 3D Reconstruction และ Gaussian Splatting

## 1. บทสรุป

แนวทางที่แนะนำคือการใช้ **COLMAP เป็นฐานความน่าเชื่อถือของกล้องและ geometry เบื้องต้น** แล้วใช้ **MapAnything ช่วยเติม depth / dense geometry / point cloud** ในบริเวณที่ COLMAP มักอ่อน เช่น ผนังเรียบ พื้นเงา พื้นผิวสีเดียว พื้นผิวซ้ำ ๆ หรือพื้นที่ indoor ที่ feature matching ทำงานยาก

แนวคิดหลักคือ:

```text
COLMAP = geometry anchor / camera pose ที่ตรวจสอบได้
MapAnything = learned dense reconstruction / depth completion / weak-texture recovery
Gaussian Splatting = downstream renderer / scene representation
```

ดังนั้นไม่ควรมองว่า MapAnything ต้องมาแทน COLMAP ทั้งหมด แต่ควรใช้เป็น **ตัวเสริมหลัง COLMAP** เพื่อเพิ่ม coverage และช่วย reconstruction ในจุดที่ classical pipeline มีข้อจำกัด

---

## 2. MapAnything คล้าย COLMAP หรือไม่

**คล้ายในเป้าหมาย แต่ต่างในวิธีทำ**

| ประเด็น | COLMAP | MapAnything |
|---|---|---|
| แนวทางหลัก | Classical SfM + MVS | Learned feed-forward transformer model |
| วิธีประเมินกล้อง | Feature matching + geometric verification + bundle adjustment | Model inference จาก image / pose / intrinsic / depth input |
| จุดแข็ง | ตรวจสอบได้ดี, ecosystem ใหญ่, ใช้จริงใน production เยอะ | เติม geometry ได้ดีในบางเคส, รองรับ input หลายรูปแบบ, อาจช่วย texture-poor scenes |
| จุดอ่อน | fail ได้ถ้า match feature ไม่ติด | อาจ hallucinate geometry หรือ scale/pose เพี้ยนถ้า input/scene ยาก |
| ใช้กับ 3DGS | เป็นมาตรฐาน de facto | export/ทำงานร่วมกับ COLMAP output ได้ |

สรุปสั้น ๆ:

```text
COLMAP = classical geometry pipeline
MapAnything = AI foundation model สำหรับทำนาย geometry / depth / camera-related outputs
```

---

## 3. ทำไมควรใช้ COLMAP ก่อน แล้วค่อยส่งต่อให้ MapAnything

การรัน COLMAP ก่อนให้ประโยชน์สำคัญคือได้:

1. Camera intrinsics
2. Camera extrinsics / poses
3. Sparse point cloud
4. Reprojection error สำหรับตรวจสอบคุณภาพ
5. Coordinate system ที่ค่อนข้างน่าเชื่อถือ
6. ข้อมูลตั้งต้นที่ downstream tools เช่น Gaussian Splatting ใช้งานได้ดี

จากนั้น MapAnything สามารถใช้ข้อมูลเหล่านี้เป็น anchor แล้วไปเน้นงานที่ COLMAP อ่อนกว่า เช่น:

1. เติม depth ในพื้นที่ sparse
2. เติม dense points บนผนัง พื้น เพดาน
3. ช่วย MVS ในพื้นที่ที่ classical stereo ไม่ดี
4. สร้าง confidence / mask เพื่อช่วยกรองจุดที่ไม่น่าเชื่อถือ
5. เพิ่ม geometry initialization ก่อน train Gaussian Splatting

---

## 4. Pipeline หลักที่แนะนำ

```text
Input Images / Video Frames
        ↓
COLMAP Reconstruction
        ↓
ตรวจสอบ camera registration / reprojection error / sparse point cloud
        ↓
MapAnything inference โดยใช้ COLMAP poses + intrinsics
        ↓
ได้ depth maps / pts3d / confidence / mask
        ↓
Depth filtering + confidence filtering
        ↓
Plane-aware cleanup สำหรับ floor / wall / ceiling
        ↓
Export เป็น point cloud หรือ COLMAP-compatible structure
        ↓
Gaussian Splatting / OpenSplat / gsplat
```

---

## 5. โครงสร้างข้อมูลโดยรวม

ตัวอย่างโฟลเดอร์ที่แนะนำ:

```text
project_scene_001/
├── images/
│   ├── frame_000001.jpg
│   ├── frame_000002.jpg
│   └── ...
├── colmap/
│   ├── database.db
│   ├── sparse/
│   │   └── 0/
│   │       ├── cameras.bin
│   │       ├── images.bin
│   │       └── points3D.bin
│   └── dense/
├── mapanything/
│   ├── depth/
│   ├── confidence/
│   ├── masks/
│   ├── pts3d/
│   └── export/
├── merged/
│   ├── points_filtered.ply
│   ├── points_plane_cleaned.ply
│   └── sparse/
└── gaussian_splatting/
    ├── input/
    └── output/
```

---

## 6. ขั้นตอนที่ 1: เตรียมภาพ

ถ้ามาจากวิดีโอ ควร extract frame โดยไม่ถี่เกินไป เพื่อหลีกเลี่ยงภาพซ้ำและ motion blur

แนวทางเบื้องต้น:

```text
- เดินกล้องช้า
- overlap ระหว่างภาพประมาณ 70-85%
- หลีกเลี่ยงภาพเบลอ
- หลีกเลี่ยง auto exposure กระโดดแรง
- ถ่ายให้เห็นมุมผนัง พื้น เพดาน และ reference object
- หลีกเลี่ยงการหมุนกล้องเร็วเกินไป
```

ตัวอย่าง extract frame ด้วย ffmpeg:

```bash
ffmpeg -i input_video.mp4 -vf "fps=2" images/frame_%06d.jpg
```

ถ้าวิดีโอเดินช้ามาก อาจใช้ 2-3 fps ได้ แต่ถ้าเดินเร็วควรทดสอบหลายค่า เช่น 1 fps, 2 fps, 3 fps แล้วดูว่า COLMAP register ได้ดีแค่ไหน

---

## 7. ขั้นตอนที่ 2: รัน COLMAP ก่อน

ตัวอย่าง pipeline แบบ command line:

```bash
colmap feature_extractor \
  --database_path colmap/database.db \
  --image_path images

colmap exhaustive_matcher \
  --database_path colmap/database.db

mkdir -p colmap/sparse

colmap mapper \
  --database_path colmap/database.db \
  --image_path images \
  --output_path colmap/sparse
```

ถ้าเป็นชุดภาพใหญ่ อาจเปลี่ยนจาก `exhaustive_matcher` เป็น sequential หรือ vocab tree matcher ตามลักษณะข้อมูล

สำหรับวิดีโอหรือภาพเรียงลำดับ:

```bash
colmap sequential_matcher \
  --database_path colmap/database.db
```

---

## 8. ขั้นตอนที่ 3: ตรวจสอบผล COLMAP

ก่อนส่งต่อให้ MapAnything ควรตรวจสอบ:

| รายการ | เกณฑ์ที่ควรดู |
|---|---|
| Registered images | ภาพถูก register มากพอหรือไม่ |
| Reprojection error | error สูงผิดปกติหรือไม่ |
| Sparse point cloud | scene บิด ยุบ หรือแตกหรือไม่ |
| Camera trajectory | เส้นทางกล้องต่อเนื่องหรือกระโดดหรือไม่ |
| Scale / orientation | อยู่ในแนวที่ควบคุมได้หรือไม่ |

ถ้า COLMAP pose แย่มาก ไม่ควรเอาไปเป็น anchor ต่อ เพราะ MapAnything จะรับ anchor ที่ผิดไปด้วย

---

## 9. ขั้นตอนที่ 4: ส่ง COLMAP output เข้า MapAnything

MapAnything มีแนวทางรองรับการรัน inference บน COLMAP outputs โดยตรง โดยใช้ calibration และ camera poses จาก COLMAP เป็น input เพื่อทำงานแนว MVS / dense reconstruction ต่อ

ตัวอย่างแนวคำสั่ง:

```bash
python scripts/demo_inference_on_colmap_outputs.py \
  --colmap_path /path/to/project_scene_001/colmap/sparse/0 \
  --viz
```

หมายเหตุ: path จริงอาจต้องปรับตามโครงสร้าง script และ version ของ repo ที่ใช้งาน

---

## 10. Output ที่คาดหวังจาก MapAnything

สิ่งที่ควรนำมาใช้ต่อ:

| Output | ใช้ทำอะไร |
|---|---|
| depth maps | เติม geometry รายภาพ |
| pts3d | point cloud / world-space geometry |
| confidence | กรองจุดที่ไม่น่าเชื่อถือ |
| mask | ระบุ valid region |
| intrinsics | ตรวจสอบ/เทียบกับ COLMAP |
| camera poses | ตรวจสอบ alignment กับ COLMAP |
| metric scaling factor | ช่วยเรื่อง scale ถ้าจำเป็น |

---

## 11. Strategy การ Merge COLMAP + MapAnything

แนวทางที่ปลอดภัยคือ:

```text
COLMAP sparse points = trusted anchor
MapAnything dense points = supplemental geometry
```

ไม่ควร overwrite COLMAP ทั้งหมดทันที แต่ควรเติมเฉพาะบริเวณที่ COLMAP sparse และ MapAnything confidence สูง

### กฎการตัดสินใจเบื้องต้น

| เงื่อนไข | การตัดสินใจ |
|---|---|
| COLMAP point หนาแน่นและ reprojection ดี | ใช้ COLMAP เป็นหลัก |
| COLMAP sparse แต่ MapAnything confidence สูง | เติม MapAnything points |
| MapAnything confidence ต่ำ | ทิ้ง |
| จุดอยู่บนกระจก/สะท้อน/วัตถุ dynamic | ทิ้งหรือ mask ออก |
| depth กระโดดผิดปกติ | ทิ้ง |
| จุดอยู่ใกล้ plane หลัก เช่น ผนัง/พื้น/เพดาน | เก็บและอาจ regularize |

---

## 12. Plane-aware Cleanup สำหรับงานอาคาร

สำหรับอาคาร ภายในห้อง โถง หรือ corridor ควรใช้ geometric prior เพิ่มเติม เช่น:

1. พื้นเป็นระนาบแนวนอน
2. ผนังเป็นระนาบแนวตั้ง
3. เพดานเป็นระนาบแนวนอน
4. เสามีแนวตั้ง
5. ขอบผนัง/พื้นมักตั้งฉากกัน

ขั้นตอนที่แนะนำ:

```text
1. รวม point cloud จาก COLMAP และ MapAnything
2. ใช้ confidence threshold กรองจุดจาก MapAnything
3. ใช้ RANSAC หา plane หลัก
4. แยก floor / wall / ceiling
5. Snap หรือ regularize จุดที่ใกล้ plane
6. ลบ floaters และ outliers
7. Export point cloud ที่สะอาดกว่าเดิม
```

ตัวอย่าง threshold แนวคิด:

```text
- confidence > 0.6 หรือ 0.7
- depth consistency ผ่านหลาย view
- ระยะจาก plane < 2-5 cm สำหรับงานภายใน
- ลบจุดที่ isolated หรือไม่มี neighbor ใกล้เคียง
```

ค่าจริงต้องปรับตาม scale และคุณภาพข้อมูล

---

## 13. ประเด็นเฉพาะ: ผนังเรียบ

COLMAP มัก reconstruct ผนังเรียบได้ sparse มาก เพราะไม่มี texture ให้ match

MapAnything อาจช่วยได้โดย:

1. เติม depth จาก context ของห้อง
2. ใช้ขอบพื้น/เพดาน/มุมห้องเป็น clue
3. เติม point map บนพื้นที่ texture ต่ำ
4. ทำให้ Gaussian Splatting มี initialization ที่ไม่บางเกินไป

แต่ต้องระวัง:

```text
ผนังที่เติมมาอาจดูเรียบและสวย แต่ต้องตรวจว่าไม่บิด ไม่ยุบ และไม่ลอยจาก plane จริง
```

ดังนั้นสำหรับผนัง ควรใช้ plane fitting ช่วยตรวจซ้ำ

---

## 14. ประเด็นเฉพาะ: พื้นเงา

พื้นเงาเป็นปัญหาหนัก เพราะ reflection อาจหลอกทั้ง COLMAP และ model learned-based

แนวทางจัดการ:

1. ใช้ COLMAP pose เป็นหลัก ห้ามให้ MapAnything เดา pose เองถ้าไม่จำเป็น
2. ใช้ confidence mask อย่างเข้ม
3. ตรวจ depth consistency หลาย view
4. ใช้ RANSAC หา floor plane
5. จุดที่ลอยเหนือ/ต่ำกว่าพื้นมากผิดปกติให้ลบ
6. ถ้าพื้นเงามาก ควร mask reflection region ออกบางส่วน

ตัวอย่าง rule:

```text
ถ้าจุดบนพื้นห่างจาก floor plane มากกว่า threshold → ลบ
ถ้า confidence ต่ำ → ลบ
ถ้าจุดปรากฏแค่ view เดียว → ลบ
ถ้าจุดเกิดจาก reflection ชัดเจน → mask ออก
```

---

## 15. ประเด็นเฉพาะ: กระจก

กระจกเป็นบริเวณที่ควรระวังมากที่สุด เพราะ geometry ที่เห็นในกระจกไม่ใช่ตำแหน่งจริง

แนวทาง:

```text
- mask กระจกออกก่อน reconstruction ถ้าทำได้
- อย่าใช้ point จากกระจกเป็น geometry จริง
- ถ้า MapAnything เติมจุดหลังกระจก ควรลบออก
- ใช้ semantic/manual mask สำหรับกระจกใน scene สำคัญ
```

---

## 16. Workflow สำหรับ Gaussian Splatting

### Option A: ใช้ COLMAP ล้วน

```text
images → COLMAP → Gaussian Splatting
```

เหมาะสำหรับ scene ที่ texture ดีและ COLMAP register ได้ครบ

### Option B: ใช้ MapAnything แทน COLMAP บางส่วน

```text
images → MapAnything export COLMAP-compatible → Gaussian Splatting
```

เหมาะสำหรับทดลองเร็ว หรือกรณี COLMAP fail

### Option C: Hybrid แบบแนะนำ

```text
images → COLMAP → MapAnything MVS/depth → filtered dense points → Gaussian Splatting
```

เหมาะสำหรับ production test ในอาคารจริง

---

## 17. A/B Test ที่ควรทำ

ใช้ชุดภาพเดียวกัน แล้วทดลอง 3 pipeline:

```text
Pipeline A: COLMAP → Gaussian Splatting
Pipeline B: MapAnything → Gaussian Splatting
Pipeline C: COLMAP → MapAnything → Filtering → Gaussian Splatting
```

### Metric เปรียบเทียบ

| Metric | ความหมาย |
|---|---|
| Registered images | ภาพที่ COLMAP register สำเร็จ |
| Reprojection error | ความน่าเชื่อถือของ pose |
| Point cloud coverage | ผนัง พื้น เพดานเต็มขึ้นหรือไม่ |
| Floaters | จุดลอยใน 3DGS ลดลงหรือเพิ่มขึ้น |
| Novel view quality | มุมกล้องใหม่ดูนิ่งหรือบิด |
| Training stability | loss และ visual output ระหว่าง train |
| Geometry consistency | พื้น/ผนัง/เพดานไม่ยุบ ไม่โก่ง |

---

## 18. Checklist ก่อนเก็บภาพจริง

```text
[ ] ใช้กล้องที่ exposure ค่อนข้างนิ่ง
[ ] ถ่าย overlap สูงพอ
[ ] เดินกล้องช้า
[ ] ถ่ายมุมกว้างและมุมเฉียงต่อผนัง
[ ] อย่าถ่ายผนังเรียบแบบตรง ๆ อย่างเดียว
[ ] เก็บมุมห้อง ขอบพื้น ขอบเพดาน ให้พอ
[ ] หลีกเลี่ยงคนเดินหรือวัตถุเคลื่อนที่
[ ] ถ้าพื้นเงามาก ให้ถ่ายหลายมุมเพื่อช่วยแยก reflection
[ ] ถ้ามีกระจก ให้เตรียม mask หรือหลีกเลี่ยงการใช้เป็น geometry
[ ] ถ้ามี scale สำคัญ ให้มี known object / marker / measured distance
```

---

## 19. Checklist หลังรัน COLMAP

```text
[ ] Registered images มากพอ
[ ] Camera trajectory ต่อเนื่อง
[ ] Sparse point cloud ไม่บิด
[ ] Reprojection error อยู่ในระดับรับได้
[ ] ไม่มี image cluster แยกผิดกลุ่ม
[ ] Intrinsics ไม่ผิดปกติ
[ ] Scene orientation / scale พอควบคุมได้
```

ถ้า checklist นี้ไม่ผ่าน ควรแก้ COLMAP ก่อน ไม่ควรรีบส่งต่อให้ MapAnything

---

## 20. Checklist หลังรัน MapAnything

```text
[ ] Depth maps ดูต่อเนื่อง
[ ] Confidence map ไม่ต่ำทั้งภาพ
[ ] ผนัง/พื้น/เพดานไม่โก่งผิดธรรมชาติ
[ ] จุดบนกระจก/พื้นสะท้อนไม่ถูกเก็บมากเกินไป
[ ] pts3d align กับ COLMAP coordinate system
[ ] ไม่มี scale drift ชัดเจน
[ ] dense points ช่วยเติมบริเวณ sparse จริง
```

---

## 21. ข้อควรระวัง

1. **MapAnything อาจเติม geometry ที่ดูดีแต่ไม่จริง**  
   ต้องใช้ confidence, multi-view consistency และ plane fitting ตรวจซ้ำ

2. **COLMAP pose ถ้าผิด MapAnything จะรับ anchor ผิดไปด้วย**  
   จึงควร validate COLMAP ก่อนเสมอ

3. **พื้นเงาและกระจกยังเป็นปัญหาใหญ่**  
   ไม่ควรเชื่อ learned depth โดยไม่มี filtering

4. **งานใหญ่หลายร้อย/พันภาพอาจต้องแบ่ง scene**  
   MapAnything อาจมีข้อจำกัดด้าน context/window/VRAM

5. **งาน survey-grade ยังต้องระวัง**  
   ถ้าต้องการค่าพิกัดแม่นระดับวิศวกรรม ควรมี ground control / scale reference / validation เพิ่มเติม

---

## 22. แนวทางพัฒนาเป็นระบบใน Project

ถ้าจะทำเป็น pipeline จริงใน project สามารถแยก module ได้แบบนี้:

```text
recon_pipeline/
├── 01_extract_frames.py
├── 02_run_colmap.py
├── 03_validate_colmap.py
├── 04_run_mapanything.py
├── 05_filter_depth.py
├── 06_fit_planes.py
├── 07_merge_points.py
├── 08_export_for_gs.py
└── config.yaml
```

ตัวอย่าง config:

```yaml
scene_name: building_hall_001
input:
  video_path: ./input/video.mp4
  images_dir: ./images
  fps: 2

colmap:
  matcher: sequential
  camera_model: OPENCV
  min_registered_ratio: 0.75
  max_reprojection_error: 2.0

mapanything:
  use_colmap_poses: true
  confidence_threshold: 0.65
  export_depth: true
  export_pts3d: true

filtering:
  remove_low_confidence: true
  multi_view_consistency: true
  plane_cleanup: true
  floor_plane_threshold_m: 0.05
  wall_plane_threshold_m: 0.05

gaussian_splatting:
  trainer: gsplat
  export_colmap_format: true
```

---

## 23. Pseudocode สำหรับ Merge

```python
colmap_points = load_colmap_points("colmap/sparse/0/points3D.bin")
ma_points = load_mapanything_points("mapanything/pts3d")
ma_conf = load_confidence("mapanything/confidence")
ma_masks = load_masks("mapanything/masks")

trusted_ma_points = []

for point, conf, mask in zip(ma_points, ma_conf, ma_masks):
    if not mask:
        continue
    if conf < 0.65:
        continue
    if is_reflection_region(point):
        continue
    if not passes_depth_consistency(point):
        continue
    trusted_ma_points.append(point)

merged_points = merge_without_overwriting_trusted_colmap(
    colmap_points,
    trusted_ma_points
)

planes = fit_main_planes_ransac(merged_points)
cleaned_points = plane_aware_cleanup(merged_points, planes)

save_ply(cleaned_points, "merged/points_plane_cleaned.ply")
export_colmap_compatible(cleaned_points, "merged/sparse")
```

---

## 24. Practical Recommendation สำหรับงานอาคาร / 3DGS

สำหรับงานของผม/ทีมที่ต้องการ scan อาคาร โถง ห้องประชุม หรือพื้นที่ภายใน ผมจะเริ่มจากสูตรนี้:

```text
1. Extract frames จาก video หรือถ่ายภาพนิ่งให้ overlap สูง
2. Run COLMAP เพื่อให้ได้ camera poses ที่น่าเชื่อถือ
3. Validate COLMAP ด้วย reprojection error + visual inspection
4. Run MapAnything โดยใช้ COLMAP output เป็น input
5. Filter depth/points ด้วย confidence และ mask
6. Fit plane สำหรับพื้น ผนัง เพดาน
7. Merge point cloud แบบไม่ overwrite COLMAP anchor
8. Export ไป train Gaussian Splatting
9. เทียบกับ COLMAP-only baseline ทุกครั้ง
```

---

## 25. สรุปสุดท้าย

แนวทาง **COLMAP → MapAnything → Filtering → Gaussian Splatting** เป็น workflow ที่น่าสนใจมากสำหรับงาน 3D reconstruction ภายในอาคาร เพราะได้ทั้ง:

```text
ความน่าเชื่อถือของ COLMAP
+
ความสามารถเติม geometry ของ MapAnything
+
การ render/visualize ที่ดีของ Gaussian Splatting
```

เหมาะอย่างยิ่งกับปัญหา:

```text
- ผนังเรียบ
- พื้นเงา
- เพดานสีเดียว
- corridor texture ซ้ำ
- indoor lighting ยาก
- COLMAP sparse เกินไป
```

แต่ต้องใช้แบบมี guardrail:

```text
- เชื่อ COLMAP pose เป็นหลัก
- ใช้ MapAnything เติมเฉพาะจุด confidence สูง
- ตรวจ plane และ depth consistency
- ระวังกระจก/พื้นสะท้อน
- benchmark เทียบ COLMAP-only เสมอ
```

สรุปเชิงระบบ:

```text
MapAnything ไม่จำเป็นต้องแทน COLMAP
แต่สามารถเป็นชั้นเสริมที่ทำให้ COLMAP pipeline แข็งแรงขึ้นมาก
โดยเฉพาะสำหรับ Gaussian Splatting ในงานอาคารจริง
```
