#!/bin/bash

# OpenSplat Compilation Script with CUDA 12.6 Support
# Updated: January 2025

set -e

echo "================================================"
echo "OpenSplat CUDA 12.6 Compilation Script"
echo "================================================"
echo ""

# Check if CUDA 12.6 is installed
if [ ! -d "/usr/local/cuda-12.6" ]; then
    echo "Error: CUDA 12.6 not found!"
    echo "Please run ./setup-cuda126.sh first"
    exit 1
fi

# Set environment variables
echo "[1/7] Setting up CUDA 12.6 environment..."
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
export CUDA_HOME=/usr/local/cuda-12.6

# Verify CUDA
if ! command -v nvcc &> /dev/null; then
    echo "Error: nvcc not found. Please ensure CUDA 12.6 is properly installed."
    exit 1
fi

echo "✓ Using CUDA:"
nvcc --version | head -n 4

# Check for LibTorch
echo ""
echo "[2/7] Checking LibTorch installation..."

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
LIBTORCH_DIR="$SCRIPT_DIR/libtorch-cuda126"

if [ ! -d "$LIBTORCH_DIR" ]; then
    echo "LibTorch for CUDA 12.6 not found. Downloading..."
    echo "This will take 5-10 minutes..."

    # Download LibTorch 2.7.1 for CUDA 12.6
    wget -O libtorch-cuda126.zip "https://download.pytorch.org/libtorch/cu126/libtorch-cxx11-abi-shared-with-deps-2.7.1%2Bcu126.zip"

    # Extract
    echo "Extracting LibTorch..."
    unzip -q libtorch-cuda126.zip
    mv libtorch libtorch-cuda126

    # Clean up
    rm libtorch-cuda126.zip

    echo "✓ LibTorch 2.7.1+cu126 downloaded and extracted"
else
    echo "✓ LibTorch found at $LIBTORCH_DIR"
fi

# Clean build directory
echo ""
echo "[3/7] Preparing build directory..."
if [ -d "build" ]; then
    echo "Removing existing build directory..."
    rm -rf build
fi
mkdir build
cd build

# Configure with CMake
echo ""
echo "[4/7] Configuring with CMake..."
echo "Using LibTorch at: $LIBTORCH_DIR"

# Use GCC 12 for CUDA 12.6 compatibility
export CC=gcc-13
export CXX=g++-13

cmake -DCMAKE_PREFIX_PATH="$LIBTORCH_DIR" \
      -DOPENSPLAT_USE_FAST_MATH=ON \
      -DCMAKE_BUILD_TYPE=Release \
      -DCUDA_TOOLKIT_ROOT_DIR=/usr/local/cuda-12.6 \
      ..

# Check if CMake succeeded
if [ $? -ne 0 ]; then
    echo ""
    echo "Error: CMake configuration failed!"
    echo "Please check the error messages above."
    exit 1
fi

# Get number of CPU cores for parallel compilation
NCORES=$(nproc)
echo ""
echo "[5/7] Compiling OpenSplat with $NCORES cores..."
echo "This will take 3-5 minutes..."

# Compile
make -j$NCORES

# Check if compilation succeeded
if [ $? -ne 0 ]; then
    echo ""
    echo "Error: Compilation failed!"
    echo "Please check the error messages above."
    exit 1
fi

# Verify the binary
echo ""
echo "[6/7] Verifying OpenSplat binary..."

if [ -f "opensplat" ]; then
    echo "✓ OpenSplat binary created successfully"

    # Check if it's using CUDA
    if ldd opensplat | grep -q "libcudart"; then
        echo "✓ Binary is linked with CUDA libraries"
    else
        echo "⚠ Warning: Binary might not be using CUDA"
    fi
else
    echo "Error: opensplat binary not found!"
    exit 1
fi

# Create a simple test
echo ""
echo "[7/7] Running quick test..."

# Try to run with version flag
./opensplat --version 2>/dev/null || echo "Version flag not supported"

echo ""
echo "================================================"
echo "Compilation Complete!"
echo "================================================"
echo ""
echo "OpenSplat has been successfully compiled with CUDA 12.6 support!"
echo ""
echo "Binary location: $(pwd)/opensplat"
echo ""
echo "Test the installation with:"
echo "  ./build/opensplat /path/to/dataset -n 100 -o test.ply"
echo ""
echo "Example with sample data:"
echo "  ./build/opensplat data/banana -n 100 -o banana.ply"
echo ""
echo "Monitor GPU usage during training:"
echo "  watch -n 1 nvidia-smi"
echo ""
echo "================================================"

# Return to project directory
cd ..