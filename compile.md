# OpenSplat Compilation Guide for Ubuntu

## คู่มือการ Compile OpenSplat บน Ubuntu (WSL2)

### ปัญหาที่พบและวิธีแก้ไข

การ compile OpenSplat บน Ubuntu อาจพบปัญหา linking error กับ OpenCV เนื่องจาก C++ ABI incompatibility ระหว่าง libtorch และ OpenCV

### ขั้นตอนการ Compile ที่สำเร็จ

#### 1. ติดตั้ง Dependencies

```bash
# อัพเดท package list
sudo apt-get update

# ติดตั้ง OpenCV development libraries
sudo apt-get install -y libopencv-dev

# ตรวจสอบว่า OpenCV ติดตั้งแล้ว
pkg-config --modversion opencv4
```

#### 2. เตรียม libtorch ที่ถูกต้อง

**สำคัญ:** ต้องใช้ libtorch เวอร์ชันที่มี CXX11 ABI support เพื่อให้ compatible กับ OpenCV ที่ติดตั้งผ่าน apt

```bash
# ดาวน์โหลด libtorch สำหรับ CPU with CXX11 ABI
wget https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-2.1.2%2Bcpu.zip

# แตกไฟล์
unzip libtorch-cxx11-abi-shared-with-deps-2.1.2+cpu.zip

# เปลี่ยนชื่อเพื่อความชัดเจน (optional)
mv libtorch libtorch-cxx11
```

#### 3. แก้ไข CMakeLists.txt

แก้ไขไฟล์ `CMakeLists.txt` เพื่อให้ใช้ pkg-config สำหรับ OpenCV และเพิ่ม include path:

```cmake
# บรรทัด 260-273 ประมาณ
target_include_directories(opensplat PRIVATE
    ${PROJECT_SOURCE_DIR}/rasterizer
    ${GPU_INCLUDE_DIRS}
    /usr/include/opencv4  # เพิ่มบรรทัดนี้
)

# เพิ่ม link directories สำหรับ OpenCV
target_link_directories(opensplat PUBLIC ${OpenCV_LIBRARY_DIRS})
target_link_libraries(opensplat PUBLIC ${OpenCV_LIBRARIES})
```

หากใช้ simple_trainer ให้เพิ่ม include path เช่นกัน:
```cmake
target_include_directories(simple_trainer PRIVATE
    ${PROJECT_SOURCE_DIR}/rasterizer
    ${GPU_INCLUDE_DIRS}
    /usr/include/opencv4  # เพิ่มบรรทัดนี้
)
```

#### 4. สร้าง Build Directory และ Compile

```bash
# สร้าง build directory
mkdir build && cd build

# รัน cmake โดยชี้ไปที่ libtorch ที่ถูกต้อง
cmake -DCMAKE_PREFIX_PATH=/path/to/libtorch-cxx11/ ..

# Compile (ใช้ -j8 สำหรับ parallel compilation)
make -j8
```

#### 5. ตรวจสอบผลลัพธ์

```bash
# ตรวจสอบว่า compile สำเร็จ
./opensplat --version

# ควรแสดงผล: 1.1.5 (git commit xxxxx)
```

### Troubleshooting

#### ปัญหา: undefined reference to cv::imwrite/imread

**สาเหตุ:** C++ ABI mismatch ระหว่าง libtorch และ OpenCV

**วิธีแก้:**
1. ใช้ libtorch เวอร์ชัน cxx11-abi (ไม่ใช่เวอร์ชัน pre-cxx11-abi)
2. ตรวจสอบว่า OpenCV link directories ถูกเพิ่มใน CMakeLists.txt

#### ปัญหา: CUDA toolkit not found

**หมายเหตุ:** Warning นี้ไม่เป็นปัญหาหากต้องการ build สำหรับ CPU เท่านั้น

### สรุป Libraries ที่จำเป็น

- **libtorch**: เวอร์ชัน 2.1.2 with CXX11 ABI support
- **OpenCV**: เวอร์ชัน 4.6.0 (ติดตั้งผ่าน apt)
- **CMake**: เวอร์ชัน 3.21 ขึ้นไป
- **GCC**: เวอร์ชัน 13.3.0

### การใช้งานหลัง Compile

```bash
# รันโปรแกรมกับ dataset
./opensplat /path/to/dataset -n 2000

# ดู options ทั้งหมด
./opensplat --help
```

### หมายเหตุเพิ่มเติม

- Build นี้เป็นแบบ CPU-only หากต้องการใช้ GPU ต้องติดตั้ง CUDA toolkit
- มี warning เกี่ยวกับ memory overflow แต่ไม่กระทบการทำงาน
- สามารถใช้ `make clean` เพื่อล้าง build files หากต้องการ compile ใหม่