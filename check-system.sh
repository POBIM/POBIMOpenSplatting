#!/bin/bash

# =============================================================================
# POBIMOpenSplat - System Requirements Checker
# =============================================================================
# Run this script before installation to verify your system meets requirements
# =============================================================================

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   POBIMOpenSplat - System Requirements Checker"
echo "============================================================================="
echo -e "${NC}"
echo ""

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

check_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((PASS_COUNT++))
}

check_warn() {
    echo -e "${YELLOW}⚠ WARN${NC}: $1"
    ((WARN_COUNT++))
}

check_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((FAIL_COUNT++))
}

check_info() {
    echo -e "${CYAN}ℹ INFO${NC}: $1"
}

print_header() {
    echo ""
    echo -e "${BOLD}${BLUE}=== $1 ===${NC}"
    echo ""
}

# =============================================================================
# Check Operating System
# =============================================================================

print_header "Operating System"

if [ -f /etc/os-release ]; then
    . /etc/os-release
    check_info "OS: $NAME $VERSION"
    
    if [[ "$ID" =~ ^(ubuntu|debian|linuxmint)$ ]]; then
        check_pass "Debian-based Linux detected"
    elif [[ "$ID" =~ ^(fedora|centos|rhel)$ ]]; then
        check_warn "RPM-based Linux detected (may need adjustments)"
    else
        check_warn "Unknown Linux distribution"
    fi
else
    check_fail "Cannot detect OS"
fi

# Check architecture
ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    check_pass "Architecture: $ARCH (compatible)"
else
    check_fail "Architecture: $ARCH (x86_64 required)"
fi

# =============================================================================
# Check GPU
# =============================================================================

print_header "GPU & CUDA"

if command -v nvidia-smi &> /dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
    GPU_MEMORY=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -n1)
    DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1)
    
    check_pass "NVIDIA GPU detected: $GPU_NAME"
    check_info "GPU Memory: $GPU_MEMORY"
    check_info "Driver Version: $DRIVER_VERSION"
    
    # Check CUDA version from driver
    CUDA_FROM_DRIVER=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
    if [ -n "$CUDA_FROM_DRIVER" ]; then
        check_info "Max CUDA supported by driver: $CUDA_FROM_DRIVER"
    fi
    
    # Check if GPU memory is sufficient
    GPU_MEM_GB=$(echo "$GPU_MEMORY" | sed 's/[^0-9]//g' | head -c 2)
    if [ "$GPU_MEM_GB" -ge 6 ]; then
        check_pass "GPU memory sufficient (${GPU_MEMORY})"
    else
        check_warn "GPU memory may be limited (${GPU_MEMORY}, recommended: 6GB+)"
    fi
else
    check_fail "nvidia-smi not found - NVIDIA GPU not detected"
    check_info "This software requires NVIDIA GPU with CUDA support"
fi

# Check CUDA toolkit installations
if [ -d "/usr/local/cuda" ]; then
    if command -v nvcc &> /dev/null; then
        CUDA_VERSION=$(nvcc --version | grep "release" | awk '{print $5}' | cut -d',' -f1)
        check_pass "CUDA Toolkit installed: $CUDA_VERSION"
    else
        check_warn "CUDA directory exists but nvcc not in PATH"
    fi
else
    check_warn "CUDA Toolkit not found at /usr/local/cuda"
fi

# Check for specific CUDA versions
for version in 12.6 12.1 11.8; do
    if [ -d "/usr/local/cuda-${version}" ]; then
        check_info "Found CUDA ${version} at /usr/local/cuda-${version}"
    fi
done

# =============================================================================
# Check System Resources
# =============================================================================

print_header "System Resources"

# Check RAM
TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM" -ge 16 ]; then
    check_pass "RAM: ${TOTAL_RAM}GB (recommended: 16GB+)"
elif [ "$TOTAL_RAM" -ge 8 ]; then
    check_warn "RAM: ${TOTAL_RAM}GB (recommended: 16GB+)"
else
    check_fail "RAM: ${TOTAL_RAM}GB (minimum: 8GB, recommended: 16GB+)"
fi

# Check available RAM
AVAILABLE_RAM=$(free -g | awk '/^Mem:/{print $7}')
check_info "Available RAM: ${AVAILABLE_RAM}GB"

# Check swap
SWAP=$(free -g | awk '/^Swap:/{print $2}')
if [ "$SWAP" -ge 4 ]; then
    check_pass "Swap: ${SWAP}GB"
else
    check_warn "Swap: ${SWAP}GB (recommended: 4GB+)"
fi

# Check CPU cores
NUM_CORES=$(nproc)
if [ "$NUM_CORES" -ge 4 ]; then
    check_pass "CPU cores: $NUM_CORES"
else
    check_warn "CPU cores: $NUM_CORES (recommended: 4+)"
fi

# Check disk space
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AVAILABLE_SPACE=$(df -BG "$SCRIPT_DIR" | awk 'NR==2 {print $4}' | sed 's/G//')
if [ "$AVAILABLE_SPACE" -ge 50 ]; then
    check_pass "Disk space: ${AVAILABLE_SPACE}GB available (recommended: 50GB+)"
elif [ "$AVAILABLE_SPACE" -ge 30 ]; then
    check_warn "Disk space: ${AVAILABLE_SPACE}GB available (recommended: 50GB+)"
else
    check_fail "Disk space: ${AVAILABLE_SPACE}GB available (minimum: 30GB, recommended: 50GB+)"
fi

# =============================================================================
# Check Required Software
# =============================================================================

print_header "Required Software"

# Check Python
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version | awk '{print $2}')
    PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
    PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)
    
    if [ "$PYTHON_MAJOR" -ge 3 ] && [ "$PYTHON_MINOR" -ge 8 ]; then
        check_pass "Python $PYTHON_VERSION (required: 3.8+)"
    else
        check_warn "Python $PYTHON_VERSION (recommended: 3.8+)"
    fi
else
    check_fail "Python3 not installed"
fi

# Check pip
if command -v pip3 &> /dev/null; then
    check_pass "pip3 installed"
else
    check_warn "pip3 not installed (will be installed by script)"
fi

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    check_pass "Node.js installed: $NODE_VERSION"
else
    check_warn "Node.js not installed (will be installed by script)"
fi

# Check npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    check_pass "npm installed: $NPM_VERSION"
else
    check_warn "npm not installed (will be installed by script)"
fi

# Check git
if command -v git &> /dev/null; then
    GIT_VERSION=$(git --version | awk '{print $3}')
    check_pass "git installed: $GIT_VERSION"
else
    check_fail "git not installed"
fi

# Check wget
if command -v wget &> /dev/null; then
    check_pass "wget installed"
else
    check_warn "wget not installed (will be installed by script)"
fi

# Check curl
if command -v curl &> /dev/null; then
    check_pass "curl installed"
else
    check_warn "curl not installed (will be installed by script)"
fi

# =============================================================================
# Check Build Tools
# =============================================================================

print_header "Build Tools"

# Check CMake
if command -v cmake &> /dev/null; then
    CMAKE_VERSION=$(cmake --version | head -n1 | awk '{print $3}')
    check_pass "CMake installed: $CMAKE_VERSION"
else
    check_warn "CMake not installed (will be installed by script)"
fi

# Check gcc/g++
if command -v gcc &> /dev/null; then
    GCC_VERSION=$(gcc --version | head -n1 | awk '{print $4}')
    check_pass "GCC installed: $GCC_VERSION"
else
    check_warn "GCC not installed (will be installed by script)"
fi

if command -v g++ &> /dev/null; then
    GPP_VERSION=$(g++ --version | head -n1 | awk '{print $4}')
    check_pass "G++ installed: $GPP_VERSION"
else
    check_warn "G++ not installed (will be installed by script)"
fi

# Check make
if command -v make &> /dev/null; then
    MAKE_VERSION=$(make --version | head -n1 | awk '{print $3}')
    check_pass "make installed: $MAKE_VERSION"
else
    check_warn "make not installed (will be installed by script)"
fi

# =============================================================================
# Check Optional Dependencies
# =============================================================================

print_header "Optional Dependencies"

# Check OpenCV
if pkg-config --exists opencv4 2>/dev/null || pkg-config --exists opencv 2>/dev/null; then
    if pkg-config --exists opencv4; then
        OPENCV_VERSION=$(pkg-config --modversion opencv4)
    else
        OPENCV_VERSION=$(pkg-config --modversion opencv)
    fi
    check_pass "OpenCV installed: $OPENCV_VERSION"
else
    check_warn "OpenCV not detected (will be installed by script)"
fi

# Check COLMAP
if command -v colmap &> /dev/null; then
    COLMAP_VERSION=$(colmap --version 2>&1 | head -n1 || echo "unknown")
    check_pass "COLMAP installed (system): $COLMAP_VERSION"
else
    check_info "COLMAP not installed (will be built by script)"
fi

# =============================================================================
# Summary
# =============================================================================

print_header "Summary"

TOTAL_CHECKS=$((PASS_COUNT + WARN_COUNT + FAIL_COUNT))

echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "${YELLOW}Warnings: $WARN_COUNT${NC}"
echo -e "${RED}Failed: $FAIL_COUNT${NC}"
echo -e "Total checks: $TOTAL_CHECKS"
echo ""

if [ "$FAIL_COUNT" -eq 0 ]; then
    if [ "$WARN_COUNT" -eq 0 ]; then
        echo -e "${GREEN}${BOLD}✓ Your system meets all requirements!${NC}"
        echo -e "${CYAN}You can proceed with installation:${NC}"
        echo -e "  ${BOLD}./install.sh${NC}"
    else
        echo -e "${YELLOW}${BOLD}⚠ Your system meets minimum requirements${NC}"
        echo -e "${CYAN}Some components will be installed during setup${NC}"
        echo -e "  ${BOLD}./install.sh${NC}"
    fi
else
    echo -e "${RED}${BOLD}✗ Your system does not meet minimum requirements${NC}"
    echo -e "${YELLOW}Please address the failed checks before installation${NC}"
    echo ""
    echo -e "${CYAN}Most common issues:${NC}"
    echo "  1. Install NVIDIA GPU drivers: https://www.nvidia.com/Download/index.aspx"
    echo "  2. Install CUDA Toolkit: https://developer.nvidia.com/cuda-downloads"
    echo "  3. Install git: sudo apt install git"
    echo "  4. Increase RAM or add swap space"
    echo "  5. Free up disk space"
fi

echo ""
echo -e "${CYAN}For detailed installation instructions, see:${NC}"
echo "  INSTALLATION.md (English)"
echo "  INSTALLATION_TH.md (ภาษาไทย)"
echo ""

exit $FAIL_COUNT
