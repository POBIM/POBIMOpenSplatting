#!/bin/bash

# =============================================================================
# Rebuild COLMAP for Cloud/Headless Environment (No GUI)
# =============================================================================
# This script rebuilds COLMAP with CUDA GPU acceleration WITHOUT GUI support
# Perfect for cloud/headless environments to avoid OpenGL linking issues
# =============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
COLMAP_BUILD_DIR="$PROJECT_ROOT/colmap-build"
NUM_CORES=$(nproc)
COLMAP_CERES_VERSION="${COLMAP_CERES_VERSION:-master}"

source "$SCRIPT_DIR/colmap-build-common.sh"

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   Rebuild COLMAP for Cloud (CUDA: ON, GUI: OFF)"
echo "============================================================================="
echo -e "${NC}"
echo ""

colmap_require_cmake "3.24.0" || exit 1

# Auto-detect CUDA installation
echo -e "${CYAN}[1/5] Detecting CUDA installation...${NC}"

# Try to find CUDA
CUDA_PATHS=(
    "/usr/local/cuda"
    "/usr/local/cuda-12.6"
    "/usr/local/cuda-12.5"
    "/usr/local/cuda-12.4"
    "/usr/local/cuda-12.3"
    "/usr/local/cuda-12.1"
    "/opt/cuda"
)

CUDA_HOME="$(colmap_detect_cuda_home || true)"

if [ -z "$CUDA_HOME" ]; then
    echo -e "${RED}✗ CUDA installation not found${NC}"
    echo "Please install CUDA toolkit first"
    exit 1
fi

# Setup CUDA environment
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
export CUDA_HOME

CUDSS_LIB_DIR="$(colmap_detect_cudss_lib_dir || true)"
if [ -n "$CUDSS_LIB_DIR" ]; then
    export LD_LIBRARY_PATH="$CUDSS_LIB_DIR:$LD_LIBRARY_PATH"
fi

CUDA_VERSION=$("$CUDA_HOME/bin/nvcc" --version | grep "release" | sed -n 's/.*release \([0-9\.]*\).*/\1/p')

echo -e "${GREEN}✓ Found CUDA $CUDA_VERSION at: $CUDA_HOME${NC}"
"$CUDA_HOME/bin/nvcc" --version | head -n 4
echo ""

echo -e "${CYAN}[2/5] Checking GPU...${NC}"
if command -v nvidia-smi &> /dev/null; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | head -n 1
    echo ""
else
    echo -e "${YELLOW}⚠ nvidia-smi not found, proceeding anyway${NC}"
fi

# Force headless mode for cloud
GUI_FLAG="OFF"
echo -e "${CYAN}ℹ Building headless version (no GUI) for cloud environment${NC}"
echo ""

echo -e "${CYAN}[3/5] Cleaning previous build...${NC}"
if [ -d "$COLMAP_BUILD_DIR" ]; then
    rm -rf "$COLMAP_BUILD_DIR"
    echo -e "${GREEN}✓ Removed old build directory${NC}"
fi
mkdir -p "$COLMAP_BUILD_DIR"
echo ""

echo -e "${CYAN}[4/5] Configuring COLMAP with CMake (CUDA: ON, GUI: OFF)...${NC}"
cd "$COLMAP_BUILD_DIR"

GPU_ARCHS="$(colmap_detect_gpu_archs "70;75;80;86;89")"

echo -e "${CYAN}ℹ Building for GPU architectures: $GPU_ARCHS${NC}"
echo ""

if ! colmap_build_ceres_with_cuda "$PROJECT_ROOT" "$CUDA_HOME" "$GPU_ARCHS" "$NUM_CORES" "$COLMAP_CERES_VERSION"; then
    echo -e "${RED}✗ Failed to build CUDA-enabled Ceres${NC}"
    exit 1
fi

CERES_CMAKE_DIR="$(colmap_ceres_cmake_dir "$PROJECT_ROOT" || true)"
CERES_LIB_DIR="$(colmap_ceres_lib_dir "$PROJECT_ROOT" || true)"
CUDSS_CMAKE_DIR="$(colmap_prepare_cudss_cmake_shim "$PROJECT_ROOT" || true)"
if [ -z "$CUDSS_CMAKE_DIR" ]; then
    CUDSS_CMAKE_DIR="$(colmap_detect_cudss_cmake_dir || true)"
fi
CUDSS_LIB_DIR="$(colmap_detect_cudss_lib_dir || true)"
COLMAP_CMAKE_PREFIX_PATH="$PROJECT_ROOT/ceres-build/install"
if [ -n "$CUDSS_CMAKE_DIR" ]; then
    COLMAP_CMAKE_PREFIX_PATH="$COLMAP_CMAKE_PREFIX_PATH;$(cd "$CUDSS_CMAKE_DIR/../.." && pwd)"
fi
if [ -z "$CERES_CMAKE_DIR" ] || [ -z "$CERES_LIB_DIR" ]; then
    echo -e "${RED}✗ Could not resolve the custom Ceres installation paths${NC}"
    exit 1
fi

cmake "$PROJECT_ROOT/colmap" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_IGNORE_PREFIX_PATH=/home/linuxbrew/.linuxbrew \
    -DCMAKE_PREFIX_PATH="$COLMAP_CMAKE_PREFIX_PATH" \
    -DEigen3_DIR=/usr/share/eigen3/cmake \
    -DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCHS" \
    -DCMAKE_CUDA_COMPILER="$CUDA_HOME/bin/nvcc" \
    -DCUDA_TOOLKIT_ROOT_DIR="$CUDA_HOME" \
    -DCUDA_ENABLED=ON \
    -DGUI_ENABLED=OFF \
    -DCeres_DIR="$CERES_CMAKE_DIR" \
    -Dcudss_DIR="$CUDSS_CMAKE_DIR" \
    -DCMAKE_BUILD_RPATH="$CERES_LIB_DIR;$CUDA_HOME/lib64${CUDSS_LIB_DIR:+;$CUDSS_LIB_DIR}" \
    -DCMAKE_INSTALL_RPATH="$CERES_LIB_DIR;$CUDA_HOME/lib64${CUDSS_LIB_DIR:+;$CUDSS_LIB_DIR}" \
    -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON \
    -DCMAKE_INSTALL_PREFIX="$COLMAP_BUILD_DIR/install"

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ CMake configuration failed${NC}"
    exit 1
fi
echo ""

echo -e "${CYAN}[5/5] Building COLMAP (using $NUM_CORES cores)...${NC}"
echo "This will take 5-10 minutes..."
echo ""

make -j$NUM_CORES

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}✓ COLMAP build complete${NC}"
echo ""

# Update symlink
COLMAP_BIN="$COLMAP_BUILD_DIR/src/colmap/exe/colmap"
if [ -f "$COLMAP_BIN" ]; then
    echo -e "${CYAN}Updating symlink...${NC}"
    if sudo ln -sf "$COLMAP_BIN" /usr/local/bin/colmap; then
        echo -e "${GREEN}✓ Symlink updated${NC}"
    elif [ "$(readlink -f /usr/local/bin/colmap 2>/dev/null)" = "$(readlink -f "$COLMAP_BIN")" ]; then
        echo -e "${GREEN}✓ Symlink already points to the rebuilt COLMAP binary${NC}"
    else
        echo -e "${YELLOW}⚠ Could not update /usr/local/bin/colmap automatically${NC}"
        echo -e "${YELLOW}  Use: sudo ln -sf \"$COLMAP_BIN\" /usr/local/bin/colmap${NC}"
    fi
    echo ""
fi

# Test COLMAP
echo -e "${CYAN}Testing COLMAP binary...${NC}"
if [ -f "$COLMAP_BIN" ]; then
    # Test with help command since --version doesn't work
    if $COLMAP_BIN -h 2>&1 | head -n 2 | grep -q "COLMAP"; then
        echo -e "${GREEN}✓ COLMAP binary is working${NC}"
        $COLMAP_BIN -h 2>&1 | head -n 3
        echo ""
        
        # Check for CUDA support in binary
        if $COLMAP_BIN -h 2>&1 | grep -q "with CUDA"; then
            echo -e "${GREEN}✓ COLMAP built with CUDA support!${NC}"
        elif strings "$COLMAP_BIN" | grep -q "CUDA"; then
            echo -e "${GREEN}✓ COLMAP built with CUDA support!${NC}"
        else
            echo -e "${YELLOW}⚠ CUDA support unclear - check build output above${NC}"
        fi

        if colmap_verify_custom_ceres_integration "$COLMAP_BUILD_DIR" "$COLMAP_BIN" "$CERES_CMAKE_DIR" "$CERES_LIB_DIR"; then
            echo -e "${GREEN}✓ COLMAP is configured against the custom CUDA-enabled Ceres build${NC}"
        else
            echo -e "${RED}✗ COLMAP is not linked against the custom Ceres build; GPU BA would still fall back to CPU${NC}"
            ldd "$COLMAP_BIN" | grep libceres || true
            exit 1
        fi
    else
        echo -e "${YELLOW}⚠ COLMAP binary exists but may have issues${NC}"
    fi
else
    echo -e "${RED}✗ COLMAP binary not found${NC}"
    exit 1
fi

echo ""
echo -e "${BOLD}${GREEN}"
echo "============================================================================="
echo "   COLMAP Cloud Build Complete!"
echo "============================================================================="
echo -e "${NC}"
echo ""
echo "Binary location: $COLMAP_BIN"
echo "System command: colmap (via /usr/local/bin/colmap)"
echo "CUDA toolkit: $CUDA_HOME"
echo "GUI support: Disabled (headless mode)"
echo ""
echo "Test with:"
echo "  colmap -h"
echo "  colmap feature_extractor --help"
echo ""
echo -e "${BOLD}${GREEN}=============================================================================${NC}"
