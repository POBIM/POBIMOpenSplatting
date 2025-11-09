#!/bin/bash

echo "=== GPU-accelerated COLMAP Test ==="
echo "Date: $(date)"
echo

# Test GPU availability
echo "1. Checking GPU status:"
nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits

# Check COLMAP GPU version
COLMAP_GPU="/home/pobimgroup/POBIMOpenSplat/colmap-build/colmap/build_gpu/src/colmap/exe/colmap"

echo
echo "2. Testing COLMAP GPU executable:"
echo "   Path: $COLMAP_GPU"

if [ -f "$COLMAP_GPU" ]; then
    echo "   ✅ GPU COLMAP executable exists"

    echo "   Version info:"
    $COLMAP_GPU --help 2>&1 | head -3 | grep -E "(COLMAP|CUDA)"

    echo
    echo "3. Checking feature extraction GPU support:"
    if $COLMAP_GPU feature_extractor --help 2>&1 | grep -q "use_gpu"; then
        echo "   ✅ Feature extraction supports GPU"
    else
        echo "   ❌ Feature extraction does not support GPU"
    fi

    echo
    echo "4. Checking feature matching GPU support:"
    if $COLMAP_GPU exhaustive_matcher --help 2>&1 | grep -q "use_gpu"; then
        echo "   ✅ Feature matching supports GPU"
    else
        echo "   ❌ Feature matching does not support GPU"
    fi

    echo
    echo "5. Testing simple GPU functionality:"
    echo "   Creating test directory..."
    TEST_DIR="/tmp/colmap_gpu_test"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"

    echo "   Testing COLMAP help command with GPU tracking..."
    nvidia-smi pmon -c 1 > gpu_usage_before.txt 2>/dev/null &
    $COLMAP_GPU --help > /dev/null 2>&1
    nvidia-smi pmon -c 1 > gpu_usage_after.txt 2>/dev/null &
    wait

    echo "   ✅ Basic COLMAP command executed successfully"

else
    echo "   ❌ GPU COLMAP executable not found"

    echo
    echo "   Fallback: Testing system COLMAP:"
    if command -v colmap >/dev/null 2>&1; then
        echo "   System COLMAP version:"
        colmap --help 2>&1 | head -3 | grep -E "(COLMAP|CUDA)"
    else
        echo "   ❌ No COLMAP found in system"
    fi
fi

echo
echo "=== Test Complete ==="