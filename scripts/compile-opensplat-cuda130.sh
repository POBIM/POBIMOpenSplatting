#!/bin/bash

# OpenSplat build script for CUDA 13.0 + LibTorch cu130 on RTX 4060 / sm_89.

set -euo pipefail

CUDA_DIR="${CUDA_DIR:-/usr/local/cuda-13.0}"
CUDA_ARCH="${CUDA_ARCH:-89}"
TORCH_VERSION="${TORCH_VERSION:-2.10.0}"
LIBTORCH_VARIANT="${LIBTORCH_VARIANT:-libtorch-shared-with-deps}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LIBTORCH_DIR="$PROJECT_ROOT/libtorch-cuda130"
LIBTORCH_ZIP="libtorch-cuda130-${TORCH_VERSION}.zip"
LIBTORCH_URL="https://download.pytorch.org/libtorch/cu130/${LIBTORCH_VARIANT}-${TORCH_VERSION}%2Bcu130.zip"

echo "================================================"
echo "OpenSplat CUDA 13.0 Compilation Script"
echo "================================================"
echo ""

if [ ! -x "$CUDA_DIR/bin/nvcc" ]; then
    echo "Error: CUDA 13.0 nvcc not found at $CUDA_DIR/bin/nvcc"
    echo "Run ./scripts/setup-cuda130-wsl.sh first, or set CUDA_DIR explicitly."
    exit 1
fi

export CUDA_HOME="$CUDA_DIR"
export PATH="$CUDA_DIR/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_DIR/lib64:${LD_LIBRARY_PATH:-}"

echo "Using CUDA:"
"$CUDA_DIR/bin/nvcc" --version | head -n 4
echo "CUDA architecture: $CUDA_ARCH"
echo ""

if [ ! -d "$LIBTORCH_DIR" ]; then
    echo "LibTorch cu130 not found. Downloading $TORCH_VERSION..."
    cd "$PROJECT_ROOT"
    wget -O "$LIBTORCH_ZIP" "$LIBTORCH_URL" || {
        echo "Error: failed to download LibTorch cu130 from:"
        echo "  $LIBTORCH_URL"
        echo "No CPU fallback was used."
        exit 1
    }
    rm -rf libtorch
    unzip -q "$LIBTORCH_ZIP"
    mv libtorch "$LIBTORCH_DIR"
    rm "$LIBTORCH_ZIP"
    echo "LibTorch cu130 installed at $LIBTORCH_DIR"
else
    echo "Using existing LibTorch: $LIBTORCH_DIR"
fi

rm -rf "$PROJECT_ROOT/build"
mkdir -p "$PROJECT_ROOT/build"
cd "$PROJECT_ROOT/build"

export CC="${CC:-gcc-13}"
export CXX="${CXX:-g++-13}"

cmake -DCMAKE_PREFIX_PATH="$LIBTORCH_DIR" \
      -DOPENSPLAT_USE_FAST_MATH=ON \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCH" \
      -DCMAKE_CUDA_COMPILER="$CUDA_DIR/bin/nvcc" \
      -DCUDA_TOOLKIT_ROOT_DIR="$CUDA_DIR" \
      "$PROJECT_ROOT"

cmake --build . -j"$(nproc)"

if [ ! -f "$PROJECT_ROOT/build/opensplat" ]; then
    echo "Error: build completed without creating build/opensplat"
    exit 1
fi

echo ""
echo "OpenSplat CUDA 13.0 build complete:"
echo "  $PROJECT_ROOT/build/opensplat"
ldd "$PROJECT_ROOT/build/opensplat" | grep -E "libtorch|libcudart|libcuda" || true
