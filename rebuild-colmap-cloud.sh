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
PROJECT_ROOT="$SCRIPT_DIR"
COLMAP_BUILD_DIR="$PROJECT_ROOT/colmap-build"
NUM_CORES=$(nproc)

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   Rebuild COLMAP for Cloud (CUDA: ON, GUI: OFF)"
echo "============================================================================="
echo -e "${NC}"
echo ""

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

CUDA_HOME=""
for cuda_path in "${CUDA_PATHS[@]}"; do
    if [ -d "$cuda_path" ] && [ -f "$cuda_path/bin/nvcc" ]; then
        CUDA_HOME="$cuda_path"
        break
    fi
done

if [ -z "$CUDA_HOME" ]; then
    echo -e "${RED}✗ CUDA installation not found${NC}"
    echo "Please install CUDA toolkit first"
    exit 1
fi

# Setup CUDA environment
export PATH="$CUDA_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
export CUDA_HOME

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

# Auto-detect GPU architecture
GPU_ARCHS="70;75;80;86;89"  # Common architectures (V100, Turing, Ampere, Ada)

if command -v nvidia-smi &> /dev/null; then
    # Try to get compute capability from nvidia-smi
    COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d '.')
    if [ ! -z "$COMPUTE_CAP" ]; then
        echo -e "${CYAN}ℹ Detected GPU compute capability: ${COMPUTE_CAP:0:1}.${COMPUTE_CAP:1}${NC}"
        # Add detected architecture if not already in list
        if [[ ! "$GPU_ARCHS" =~ "$COMPUTE_CAP" ]]; then
            GPU_ARCHS="$GPU_ARCHS;$COMPUTE_CAP"
        fi
    fi
fi

echo -e "${CYAN}ℹ Building for GPU architectures: $GPU_ARCHS${NC}"
echo ""

cmake "$PROJECT_ROOT/colmap" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCHS" \
    -DCMAKE_CUDA_COMPILER="$CUDA_HOME/bin/nvcc" \
    -DCUDA_TOOLKIT_ROOT_DIR="$CUDA_HOME" \
    -DCUDA_ENABLED=ON \
    -DGUI_ENABLED=OFF \
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
    sudo ln -sf "$COLMAP_BIN" /usr/local/bin/colmap
    echo -e "${GREEN}✓ Symlink updated${NC}"
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
