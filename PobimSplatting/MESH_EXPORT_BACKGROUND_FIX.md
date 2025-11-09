# 🔧 Mesh Export - Background Processing Fix

## สิ่งที่แก้ไข (2025-11-02)

### ปัญหาเดิม

❌ **500 Internal Server Error** - API endpoint timeout
- Request รอนาน 5-30 นาที จนกว่า mesh export จะเสร็จ
- Browser/axios timeout ก่อน (default 60 seconds)
- Error: `Failed to load resource: the server responded with a status of 500`

### วิธีแก้ไข

✅ **Background Processing with Polling**

#### 1. Backend Changes (`routes/api.py`)

**เดิม:**
```python
# Synchronous - รอให้ mesh export เสร็จก่อน return
success = mesher.create_full_textured_mesh(...)
return jsonify({'success': True, 'filename': ...})
```

**ใหม่:**
```python
# Asynchronous - start background thread และ return ทันที
thread = threading.Thread(target=_run_mesh_export_background, ...)
thread.start()

return jsonify({
    'success': True,
    'status': 'processing',  # ← บอกว่ากำลังทำอยู่
    'message': 'Mesh export started...',
    'hint': 'Use /available_exports to check status'
})
```

**Background Worker:**
```python
def _run_mesh_export_background(project_id, method, quality, output_format):
    """รันใน background thread แยกต่างหาก"""
    mesher = MVSMesher(...)
    mesher.create_full_textured_mesh(...)
```

#### 2. Frontend Changes (`MeshExportPanel.tsx`)

**เดิม:**
```typescript
// รอให้ API return (timeout หลัง 1 ชั่วโมง)
const data = await api.createTexturedMesh(...)
if (data.success) {
  setExportedFile(data) // ไม่ทันได้รับเพราะ timeout
}
```

**ใหม่:**
```typescript
// 1. เริ่มต้น export (return ทันที)
const data = await api.createTexturedMesh(...)

if (data.status === 'processing') {
  // 2. Poll ทุก 10 วินาทีเพื่อเช็คว่าเสร็จหรือยัง
  const interval = setInterval(() => {
    checkExportStatus(data.filename)
  }, 10000)
  
  // 3. เมื่อพบไฟล์ใน available_exports = เสร็จแล้ว!
  const exports = await api.getAvailableExports(...)
  if (exports.find(f => f.filename === expectedFilename)) {
    clearInterval(interval)
    setExportStatus('success')
  }
}
```

#### 3. API Changes (`lib/api.ts`)

**เดิม:**
```typescript
timeout: 3600000, // 1 hour - รอนานเกินไป
```

**ใหม่:**
```typescript
timeout: 30000, // 30 seconds - แค่เริ่มต้น background task
```

---

## 🎯 Flow ใหม่

### ขั้นตอนที่ 1: User กดปุ่ม "Create Mesh"

```
Frontend → Backend: POST /create_textured_mesh
                    {method: "poisson", quality: "medium", format: "glb"}
```

### ขั้นตอนที่ 2: Backend เริ่มต้น Background Thread

```
Backend → Background Thread: _run_mesh_export_background()
       ↓
Backend → Frontend: Response (ทันที - ภายใน 1-2 วินาที)
{
  "success": true,
  "status": "processing",
  "filename": "58e94cf4_textured_mesh_poisson.glb",
  "message": "Export started. Takes 5-30 minutes..."
}
```

### ขั้นตอนที่ 3: Frontend Poll Status

```
ทุก 10 วินาที:
Frontend → Backend: GET /available_exports
                    ↓
Backend → Frontend: { "exports": [...] }
                    ↓
Frontend: เช็คว่ามี filename ที่ต้องการหรือยัง
          - ยังไม่มี → รอต่อ
          - มีแล้ว → แสดงปุ่ม Download!
```

### ขั้นตอนที่ 4: Background Thread ทำงาน

```
Background Thread:
  1. Dense Reconstruction (5-15 นาที)
  2. Mesh Generation (1-5 นาที)
  3. Color Transfer (10-30 วินาที)
  4. Export (10-30 วินาที)
  5. บันทึกไฟล์ใน results/<project_id>/
```

### ขั้นตอนที่ 5: User Download

```
Frontend → Backend: GET /download_mesh/<filename>
                    ↓
Backend: send_file(...)
```

---

## 📊 Timeline

| เวลา | Event |
|------|-------|
| **T+0s** | User กดปุ่ม "Create Mesh" |
| **T+1s** | Backend return `status: processing` |
| **T+1s** | Frontend เริ่ม polling ทุก 10 วินาที |
| **T+10s** | Poll #1 - ยังไม่มีไฟล์ |
| **T+20s** | Poll #2 - ยังไม่มีไฟล์ |
| **...**  | ... |
| **T+10m** | Background: Dense reconstruction เสร็จ |
| **T+12m** | Background: Mesh generation เสร็จ |
| **T+12.5m** | Background: Color transfer เสร็จ |
| **T+13m** | Background: ไฟล์ถูกบันทึกใน results/ |
| **T+13m10s** | Poll #79 - **พบไฟล์แล้ว!** ✅ |
| **T+13m10s** | Frontend แสดงปุ่ม Download |

---

## 🔍 การทดสอบ

### Test 1: เริ่มต้น Export

```bash
curl -X POST http://localhost:5000/api/project/<ID>/create_textured_mesh \
  -H "Content-Type: application/json" \
  -d '{"method":"poisson","quality":"low","format":"glb"}'
```

**Expected Response (ทันที - ภายใน 1-2 วินาที):**
```json
{
  "success": true,
  "status": "processing",
  "filename": "..._textured_mesh_poisson.glb",
  "message": "Mesh export started. This will take 5-30 minutes...",
  "check_url": "/api/project/<ID>/available_exports"
}
```

### Test 2: เช็คสถานะ (ขณะกำลังทำงาน)

```bash
curl http://localhost:5000/api/project/<ID>/available_exports
```

**Response (ยังไม่เสร็จ):**
```json
{
  "exports": []  // ← ยังไม่มีไฟล์
}
```

### Test 3: เช็คสถานะ (เสร็จแล้ว)

```bash
curl http://localhost:5000/api/project/<ID>/available_exports
```

**Response (เสร็จแล้ว):**
```json
{
  "exports": [
    {
      "filename": "58e94cf4_textured_mesh_poisson.glb",
      "format": "glb",
      "size": 141234567,
      "size_mb": 134.7,
      "created_at": 1730571234,
      "download_url": "/api/project/<ID>/download_mesh/..."
    }
  ]
}
```

---

## 💡 ข้อดีของ Background Processing

### ✅ Advantages

1. **No Timeout Issues**
   - API response ทันที (1-2 วินาที)
   - ไม่ timeout แม้ export ใช้เวลา 30 นาที

2. **Better UX**
   - User เห็น progress message
   - สามารถทำงานอื่นต่อได้
   - Refresh page ได้โดยไม่หยุดการทำงาน

3. **Scalability**
   - รองรับ multiple exports พร้อมกัน
   - Server ไม่ block request อื่น

4. **Error Handling**
   - ถ้า export ล้มเหลว ไม่กระทบกับ UI
   - User สามารถลองใหม่ได้ทันที

### ⚠️ Trade-offs

1. **Polling Overhead**
   - ต้อง poll ทุก 10 วินาที
   - แต่ไม่หนักเพราะ GET /available_exports เร็วมาก

2. **No Real-time Progress**
   - ไม่รู้ว่าทำไปกี่ % แล้ว
   - แต่รู้ว่ากำลังทำอยู่ และจะเสร็จเมื่อไหร่ (โดยประมาณ)

3. **State Management**
   - ต้องจัดการ polling interval
   - ต้อง cleanup เมื่อ component unmount

---

## 🚀 การใช้งาน

### ผ่าน UI

1. เข้า Project Detail page
2. Scroll ไปที่ "Export Textured Mesh"
3. เลือกตัวเลือก → กด "Create Textured Mesh"
4. **ใหม่:** เห็น message "Polling for completion every 10 seconds..."
5. **ใหม่:** รอประมาณ 10-15 นาที (สำหรับ medium quality)
6. **ใหม่:** เมื่อเสร็จ จะเห็น "Mesh created successfully!"
7. กดปุ่ม "Download GLB File"

### ผ่าน Command Line (ยังเหมือนเดิม)

```bash
# Quick export (ใช้ไฟล์ที่มีแล้ว - 24 วินาที)
python quick_mesh_export.py <PROJECT_ID>

# Full pipeline (20-40 นาที)
python run_textured_mesh_direct.py
```

---

## 📝 Notes

- Polling interval: **10 วินาที** (ปรับได้ถ้าต้องการ)
- Background thread: **daemon=True** (จะหยุดเมื่อ main process หยุด)
- Cleanup: **useEffect cleanup** ใน React component
- Thread-safe: ใช้ **threading.Thread** (Python GIL safe)

---

## 🐛 Known Issues & Future Improvements

### Known Issues
- ❌ ไม่มี real-time progress bar (แค่รู้ว่ากำลังทำอยู่)
- ❌ ถ้าปิด browser แล้วเปิดใหม่ ต้อง refresh page จึงจะเห็นผลลัพธ์

### Future Improvements
- ✅ เพิ่ม WebSocket progress updates (real-time %)
- ✅ เพิ่ม progress bar แสดง stage (undistortion → stereo → fusion → mesh)
- ✅ เพิ่ม cancel button (สามารถยกเลิกระหว่างทำได้)
- ✅ เพิ่ม retry mechanism (ถ้า background thread ล้มเหลว)
- ✅ เพิ่ม notification เมื่อเสร็จ (browser notification API)

---

**Updated:** 2025-11-02
**Status:** ✅ Fixed and Deployed
