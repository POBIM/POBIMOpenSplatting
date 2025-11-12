#!/bin/bash

# =============================================================================
# CUDA Installation Check Script
# =============================================================================
# ใช้สำหรับทดสอบว่า CUDA ติดตั้งครบถ้วนและใช้งานได้หรือไม่
# =============================================================================

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${BLUE}============================================${NC}"
echo -e "${BOLD}${BLUE}   CUDA Installation Check${NC}"
echo -e "${BOLD}${BLUE}============================================${NC}"
echo ""

all_ok=true

# Check 1: NVIDIA Driver
echo -e "${BOLD}[1/5] Checking NVIDIA Driver...${NC}"
if command -v nvidia-smi &> /dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
    DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1)
    echo -e "${GREEN}✓ NVIDIA Driver installed: $DRIVER_VERSION${NC}"
    echo -e "${GREEN}✓ GPU detected: $GPU_NAME${NC}"
else
    echo -e "${RED}✗ NVIDIA Driver not found${NC}"
    echo -e "${YELLOW}  Install with: sudo apt-get install -y nvidia-driver-550${NC}"
    all_ok=false
fi
echo ""

# Check 2: CUDA Toolkit
echo -e "${BOLD}[2/5] Checking CUDA Toolkit...${NC}"
if command -v nvcc &> /dev/null; then
    NVCC_VERSION=$(nvcc --version | grep "release" | awk '{print $5}' | cut -d',' -f1)
    NVCC_PATH=$(which nvcc)
    echo -e "${GREEN}✓ CUDA Toolkit installed: $NVCC_VERSION${NC}"
    echo -e "${GREEN}✓ nvcc location: $NVCC_PATH${NC}"
else
    echo -e "${RED}✗ CUDA Toolkit not found (nvcc not in PATH)${NC}"
    echo -e "${YELLOW}  Run ./install.sh to install CUDA automatically${NC}"
    all_ok=false
fi
echo ""

# Check 3: CUDA Libraries
echo -e "${BOLD}[3/5] Checking CUDA Libraries...${NC}"
CUDA_PATHS=(
    "/usr/local/cuda"
    "/usr/local/cuda-12.6"
    "/usr/local/cuda-12.1"
)

CUDA_FOUND=false
for cuda_path in "${CUDA_PATHS[@]}"; do
    if [ -d "$cuda_path/lib64" ]; then
        echo -e "${GREEN}✓ CUDA libraries found at: $cuda_path/lib64${NC}"
        
        # Check specific libraries
        if [ -f "$cuda_path/lib64/libcudart.so" ]; then
            echo -e "${GREEN}  ✓ libcudart.so (CUDA Runtime)${NC}"
        fi
        if [ -f "$cuda_path/lib64/libcublas.so" ]; then
            echo -e "${GREEN}  ✓ libcublas.so (CUDA BLAS)${NC}"
        fi
        
        CUDA_FOUND=true
        break
    fi
done

if [ "$CUDA_FOUND" = false ]; then
    echo -e "${RED}✗ CUDA libraries not found${NC}"
    all_ok=false
fi
echo ""

# Check 4: Environment Variables
echo -e "${BOLD}[4/5] Checking Environment Variables...${NC}"
if [[ ":$PATH:" == *":/usr/local/cuda"* ]]; then
    echo -e "${GREEN}✓ CUDA in PATH${NC}"
else
    echo -e "${YELLOW}⚠ CUDA not in PATH${NC}"
    echo -e "${YELLOW}  Add to ~/.bashrc: export PATH=/usr/local/cuda/bin:\$PATH${NC}"
fi

if [[ ":$LD_LIBRARY_PATH:" == *":/usr/local/cuda"* ]]; then
    echo -e "${GREEN}✓ CUDA libraries in LD_LIBRARY_PATH${NC}"
else
    echo -e "${YELLOW}⚠ CUDA libraries not in LD_LIBRARY_PATH${NC}"
    echo -e "${YELLOW}  Add to ~/.bashrc: export LD_LIBRARY_PATH=/usr/local/cuda/lib64:\$LD_LIBRARY_PATH${NC}"
fi
echo ""

# Check 5: GPU Compute Capability
echo -e "${BOLD}[5/5] Checking GPU Compute Capability...${NC}"
if command -v nvidia-smi &> /dev/null; then
    COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1)
    if [ -n "$COMPUTE_CAP" ]; then
        echo -e "${GREEN}✓ GPU Compute Capability: $COMPUTE_CAP${NC}"
        
        # Interpret compute capability
        CAP_MAJOR=$(echo $COMPUTE_CAP | cut -d'.' -f1)
        if [ "$CAP_MAJOR" -ge 8 ]; then
            echo -e "${GREEN}  → Excellent! Supports latest CUDA features (Ampere/Ada/Hopper)${NC}"
        elif [ "$CAP_MAJOR" -ge 7 ]; then
            echo -e "${GREEN}  → Good! Supports most CUDA features (Volta/Turing)${NC}"
        elif [ "$CAP_MAJOR" -ge 6 ]; then
            echo -e "${YELLOW}  → Adequate for basic CUDA operations (Pascal)${NC}"
        else
            echo -e "${YELLOW}  → Older GPU - may have limited support${NC}"
        fi
    fi
fi
echo ""

# Summary
echo -e "${BOLD}${BLUE}============================================${NC}"
if [ "$all_ok" = true ]; then
    echo -e "${GREEN}${BOLD}✓ All checks passed!${NC}"
    echo -e "${GREEN}CUDA is properly installed and ready to use.${NC}"
else
    echo -e "${YELLOW}${BOLD}⚠ Some checks failed${NC}"
    echo -e "${YELLOW}Please review the warnings above and take corrective action.${NC}"
fi
echo -e "${BOLD}${BLUE}============================================${NC}"
echo ""

# Optional: Create simple CUDA test
if [ "$all_ok" = true ] && command -v nvcc &> /dev/null; then
    echo -e "${BOLD}Quick CUDA Test Available:${NC}"
    echo -e "Run this to compile and test a simple CUDA program:"
    echo ""
    echo -e "  ${GREEN}cat > test.cu << 'EOF'
#include <stdio.h>
__global__ void hello() {
    printf(\"Hello from GPU thread %d!\\n\", threadIdx.x);
}
int main() {
    hello<<<1, 5>>>();
    cudaDeviceSynchronize();
    return 0;
}
EOF${NC}"
    echo ""
    echo -e "  ${GREEN}nvcc test.cu -o test_cuda${NC}"
    echo -e "  ${GREEN}./test_cuda${NC}"
    echo ""
fi

exit $([ "$all_ok" = true ] && echo 0 || echo 1)

