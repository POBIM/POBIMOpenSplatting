#!/bin/bash

# =============================================================================
# POBIMOpenSplat - Complete Installation Script
# =============================================================================
# This script will:
# 1. Check system requirements (GPU, CUDA, dependencies)
# 2. Install CUDA Toolkit automatically if needed
# 3. Install required system packages
# 4. Download and setup LibTorch
# 5. Build COLMAP with CUDA support and install prefix
# 6. Setup legacy standalone GLOMAP fallback if available
# 7. Build OpenSplat
# 8. Setup Python environments and optional experimental pycolmap backend
# 9. Setup hloc (neural feature matching with SuperPoint/SuperGlue/LightGlue)
# 10. Setup FastMap (fast first-order SfM optimization)
# 11. Setup Node.js frontend
# 12. Create quick-start script
# =============================================================================

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Project paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
BUILD_DIR="$PROJECT_ROOT/build"
COLMAP_BUILD_DIR="$PROJECT_ROOT/colmap-build"
COLMAP_INSTALL_DIR="$COLMAP_BUILD_DIR/install"
CERES_BUILD_DIR="$PROJECT_ROOT/ceres-build"
CERES_INSTALL_DIR="$CERES_BUILD_DIR/install"
POBIM_SPLATTING_DIR="$PROJECT_ROOT/PobimSplatting"
FRONTEND_DIR="$POBIM_SPLATTING_DIR/Frontend"
BACKEND_DIR="$POBIM_SPLATTING_DIR/Backend"
LOGS_DIR="$POBIM_SPLATTING_DIR/logs"

# Configuration
FRONTEND_PORT=3000
BACKEND_PORT=5000
CUDA_VERSION=""
LIBTORCH_DIR=""
NUM_CORES=$(nproc)

# Global CUDA Configuration (detected once, used everywhere)
CUDA_HOME=""
CUDA_ENABLED="OFF"
GPU_ARCHS="70;75;80;86;89"  # Default architectures
GPU_COMPUTE_CAP=""
APT_LOCK_WAIT_TIMEOUT=600
COLMAP_CERES_VERSION="master"

# Yes to all mode (skip all prompts)
YES_TO_ALL="false"

# Log file
mkdir -p "$LOGS_DIR"
LOG_FILE="$LOGS_DIR/install.log"
exec > >(tee -a "$LOG_FILE")
exec 2>&1

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   POBIMOpenSplat - Automated Installation System"
echo "============================================================================="
echo -e "${NC}"
echo -e "${CYAN}Installation log: $LOG_FILE${NC}"
echo ""

source "$PROJECT_ROOT/scripts/colmap-build-common.sh"

# =============================================================================
# Helper Functions
# =============================================================================

print_header() {
    echo ""
    echo -e "${BOLD}${BLUE}=== $1 ===${NC}"
    echo ""
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${CYAN}ℹ $1${NC}"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

is_file_lock_free() {
    local lock_path="$1"
    local python_bin=""

    if command -v fuser &> /dev/null; then
        if fuser "$lock_path" >/dev/null 2>&1; then
            return 1
        fi
        return 0
    fi

    if command -v python3 &> /dev/null; then
        python_bin="python3"
    elif command -v python &> /dev/null; then
        python_bin="python"
    else
        return 0
    fi

    "$python_bin" - "$lock_path" <<'PY'
import fcntl
import os
import sys

path = sys.argv[1]
if not os.path.exists(path):
    raise SystemExit(0)

try:
    fd = os.open(path, os.O_RDONLY)
except PermissionError:
    raise SystemExit(0)

try:
    fcntl.lockf(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
except BlockingIOError:
    os.close(fd)
    raise SystemExit(1)
except OSError:
    os.close(fd)
    raise SystemExit(0)

os.close(fd)
raise SystemExit(0)
PY
}

wait_for_apt_locks() {
    local timeout="${1:-$APT_LOCK_WAIT_TIMEOUT}"
    local interval=5
    local elapsed=0
    local warned="false"
    local lock_paths=(
        "/var/lib/dpkg/lock-frontend"
        "/var/lib/dpkg/lock"
        "/var/lib/apt/lists/lock"
        "/var/cache/apt/archives/lock"
    )

    while true; do
        local lock_path
        local locks_free="true"

        for lock_path in "${lock_paths[@]}"; do
            if ! is_file_lock_free "$lock_path"; then
                locks_free="false"
                break
            fi
        done

        if [ "$locks_free" = "true" ]; then
            return 0
        fi

        if [ "$warned" = "false" ]; then
            print_warning "APT/dpkg is busy; waiting up to ${timeout}s for the package manager lock"
            if pgrep -x unattended-upgr >/dev/null 2>&1; then
                print_info "Detected unattended-upgrades in progress"
            fi
            warned="true"
        fi

        if [ "$elapsed" -ge "$timeout" ]; then
            print_error "Timed out waiting for the package manager lock after ${timeout}s"
            return 1
        fi

        sleep "$interval"
        elapsed=$((elapsed + interval))
    done
}

run_apt_get() {
    local sudo_cmd=()
    local lock_timeout="$APT_LOCK_WAIT_TIMEOUT"

    if [[ "$1" =~ ^--lock-timeout=([0-9]+)$ ]]; then
        lock_timeout="${BASH_REMATCH[1]}"
        shift
    fi

    if ! check_command apt-get; then
        print_error "apt-get not found"
        return 1
    fi

    wait_for_apt_locks "$lock_timeout" || return 1

    if [ "$EUID" -ne 0 ]; then
        sudo_cmd=(sudo)
    fi

    "${sudo_cmd[@]}" apt-get -o DPkg::Lock::Timeout="$lock_timeout" "$@"
}

run_dpkg() {
    local sudo_cmd=()

    wait_for_apt_locks "$APT_LOCK_WAIT_TIMEOUT" || return 1

    if [ "$EUID" -ne 0 ]; then
        sudo_cmd=(sudo)
    fi

    "${sudo_cmd[@]}" dpkg "$@"
}

package_manager_update() {
    local sudo_cmd=()

    if [ "$EUID" -ne 0 ]; then
        sudo_cmd=(sudo)
    fi

    case "$PKG_MANAGER" in
        apt-get)
            run_apt_get update
            ;;
        dnf)
            "${sudo_cmd[@]}" dnf check-update
            ;;
        yum)
            "${sudo_cmd[@]}" yum check-update
            ;;
        *)
            print_error "No supported package manager found"
            return 1
            ;;
    esac
}

package_manager_install() {
    local sudo_cmd=()

    if [ "$EUID" -ne 0 ]; then
        sudo_cmd=(sudo)
    fi

    case "$PKG_MANAGER" in
        apt-get)
            run_apt_get install -y "$@"
            ;;
        dnf)
            "${sudo_cmd[@]}" dnf install -y "$@"
            ;;
        yum)
            "${sudo_cmd[@]}" yum install -y "$@"
            ;;
        *)
            print_error "No supported package manager found"
            return 1
            ;;
    esac
}

version_at_least() {
    local current_version="$1"
    local required_version="$2"

    if [ -z "$current_version" ] || [ -z "$required_version" ]; then
        return 1
    fi

    [ "$(printf '%s\n' "$required_version" "$current_version" | sort -V | head -n1)" = "$required_version" ]
}

format_compute_capability() {
    local compute_cap="$1"

    if [ -z "$compute_cap" ]; then
        return 1
    fi

    if [ ${#compute_cap} -le 1 ]; then
        printf '%s.0' "$compute_cap"
    else
        printf '%s.%s' "${compute_cap:0:${#compute_cap}-1}" "${compute_cap: -1}"
    fi
}

get_colmap_binary_path() {
    local candidates=(
        "$COLMAP_INSTALL_DIR/bin/colmap"
        "$COLMAP_BUILD_DIR/src/colmap/exe/colmap"
        "$COLMAP_BUILD_DIR/src/exe/colmap"
        "/usr/local/bin/colmap"
    )

    local candidate
    for candidate in "${candidates[@]}"; do
        if [ -f "$candidate" ] && [ -x "$candidate" ]; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    return 1
}

check_pycolmap_ready() {
    if [ ! -d "$BACKEND_DIR/venv" ]; then
        return 1
    fi

    if ! "$BACKEND_DIR/venv/bin/python" -c "import pycolmap; assert hasattr(pycolmap, 'global_mapping'); assert hasattr(pycolmap, 'GlobalMapperOptions'); assert hasattr(pycolmap, 'GlobalPipelineOptions')" >/dev/null 2>&1; then
        return 1
    fi

    return 0
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-n}"
    
    # If YES_TO_ALL is enabled, automatically return yes for default=y prompts
    if [ "$YES_TO_ALL" = "true" ]; then
        if [ "$default" = "y" ]; then
            echo -e "$prompt ${GREEN}[Auto: Yes]${NC}"
            return 0
        else
            echo -e "$prompt ${YELLOW}[Auto: No - non-default]${NC}"
            return 1
        fi
    fi
    
    if [ "$default" = "y" ]; then
        prompt="$prompt [Y/n]: "
    else
        prompt="$prompt [y/N]: "
    fi
    
    read -p "$prompt" response
    response=${response:-$default}
    
    if [[ "$response" =~ ^[Yy]$ ]]; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# Global CUDA Detection (Run once, use everywhere)
# =============================================================================

detect_cuda_environment() {
    print_header "Detecting CUDA Environment"
    
    # Search for CUDA installation
    CUDA_PATHS=(
        "/usr/local/cuda"
        "/usr/local/cuda-12.6"
        "/usr/local/cuda-12.5"
        "/usr/local/cuda-12.4"
        "/usr/local/cuda-12.3"
        "/usr/local/cuda-12.1"
        "/usr/local/cuda-11.8"
        "/opt/cuda"
    )
    
    for cuda_path in "${CUDA_PATHS[@]}"; do
        if [ -d "$cuda_path" ] && [ -f "$cuda_path/bin/nvcc" ]; then
            CUDA_HOME="$cuda_path"
            break
        fi
    done
    
    if [ -n "$CUDA_HOME" ]; then
        print_success "CUDA found at: $CUDA_HOME"
        
        # Get CUDA version
        CUDA_VERSION=$($CUDA_HOME/bin/nvcc --version 2>/dev/null | grep "release" | awk '{print $5}' | cut -d',' -f1 || echo "unknown")
        print_info "CUDA version: $CUDA_VERSION"
        
        # Setup environment
        export PATH="$CUDA_HOME/bin:$PATH"
        export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
        export CUDA_HOME
        
        # Detect GPU compute capability
        if check_command nvidia-smi; then
            GPU_COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1 | tr -d '.')
            if [ -n "$GPU_COMPUTE_CAP" ] && [[ "$GPU_COMPUTE_CAP" =~ ^[0-9]+$ ]]; then
                print_info "GPU compute capability: $(format_compute_capability "$GPU_COMPUTE_CAP")"
                # Add detected architecture if not already in list
                if [[ ! "$GPU_ARCHS" =~ "$GPU_COMPUTE_CAP" ]]; then
                    GPU_ARCHS="$GPU_ARCHS;$GPU_COMPUTE_CAP"
                fi
            fi
        fi
        
        print_info "Target GPU architectures: $GPU_ARCHS"
        
        # Ask user if they want CUDA support
        echo ""
        if prompt_yes_no "Enable CUDA support for all builds?" "y"; then
            CUDA_ENABLED="ON"
            print_success "CUDA support enabled for all components"
        else
            CUDA_ENABLED="OFF"
            print_warning "Building CPU-only versions"
        fi
    else
        print_warning "CUDA not found - will build CPU-only versions"
        CUDA_ENABLED="OFF"
    fi
    
    echo ""
}

# =============================================================================
# System Requirements Check
# =============================================================================

check_system_requirements() {
    print_header "Checking System Requirements"

    local all_ok=true

    # Check OS
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        print_success "OS: $NAME $VERSION"
    else
        print_warning "Cannot detect OS version"
    fi

    # Check NVIDIA Driver - More comprehensive checks
    print_info "Checking NVIDIA GPU and Driver..."

    if check_command nvidia-smi; then
        # Get GPU info
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n1)
        GPU_MEMORY=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -n1)
        DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1)

        print_success "NVIDIA GPU detected: $GPU_NAME ($GPU_MEMORY)"
        print_success "NVIDIA Driver version: $DRIVER_VERSION"

        # Check if driver version is sufficient (should be 525+ for modern GPUs like L4)
        DRIVER_MAJOR=$(echo "$DRIVER_VERSION" | cut -d'.' -f1)
        if [ "$DRIVER_MAJOR" -lt 525 ]; then
            print_warning "Driver version $DRIVER_VERSION may be too old for modern GPUs"
            print_warning "Recommended: 525+ for NVIDIA L4, 470+ for older GPUs"
            print_info "Consider upgrading: sudo apt-get install -y cuda-drivers"
        fi

        # Check kernel module
        if lsmod | grep -q "^nvidia "; then
            print_success "NVIDIA kernel module loaded"
        else
            print_warning "NVIDIA kernel module not loaded"
            print_info "Try: sudo modprobe nvidia"
            all_ok=false
        fi

        # Detect CUDA version from driver
        DRIVER_CUDA=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}')
        if [ -n "$DRIVER_CUDA" ]; then
            print_info "Maximum CUDA version supported by driver: $DRIVER_CUDA"
        fi

        # Detect GPU compute capability
        COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -n1 | tr -d '.')
        if [ -n "$COMPUTE_CAP" ] && [[ "$COMPUTE_CAP" =~ ^[0-9]+$ ]]; then
            print_info "GPU compute capability: $(format_compute_capability "$COMPUTE_CAP")"
        fi

        # Check installed CUDA toolkits
        if [ -d "/usr/local/cuda" ]; then
            SYSTEM_CUDA_VERSION=$(nvcc --version 2>/dev/null | grep "release" | awk '{print $5}' | cut -d',' -f1 || echo "unknown")
            print_success "CUDA toolkit found: $SYSTEM_CUDA_VERSION"
            CUDA_VERSION="$SYSTEM_CUDA_VERSION"
        fi

        # Check for specific CUDA versions
        if [ -d "/usr/local/cuda-12.6" ]; then
            CUDA_VERSION="12.6"
            print_success "CUDA 12.6 detected"
        elif [ -d "/usr/local/cuda-12.1" ]; then
            CUDA_VERSION="12.1"
            print_success "CUDA 12.1 detected"
        elif [ -d "/usr/local/cuda-11.8" ]; then
            CUDA_VERSION="11.8"
            print_success "CUDA 11.8 detected"
        fi

    else
        print_error "NVIDIA GPU not detected or nvidia-smi not available"
        print_warning "This software requires NVIDIA GPU with CUDA support"
        print_info "Please install NVIDIA drivers first:"
        print_info "  1. Check GPU: lspci | grep -i nvidia"
        print_info "  2. Install: sudo apt-get install -y nvidia-driver"
        print_info "  3. Or CUDA drivers: sudo apt-get install -y cuda-drivers"
        print_info "  4. Reboot and verify: nvidia-smi"
        all_ok=false
    fi
    
    # Check RAM
    TOTAL_RAM=$(free -g | awk '/^Mem:/{print $2}')
    if [ "$TOTAL_RAM" -ge 16 ]; then
        print_success "RAM: ${TOTAL_RAM}GB (Sufficient)"
    else
        print_warning "RAM: ${TOTAL_RAM}GB (Recommended: 16GB+)"
    fi
    
    # Check disk space
    AVAILABLE_SPACE=$(df -BG "$PROJECT_ROOT" | awk 'NR==2 {print $4}' | sed 's/G//')
    if [ "$AVAILABLE_SPACE" -ge 50 ]; then
        print_success "Disk space: ${AVAILABLE_SPACE}GB available"
    else
        print_warning "Disk space: ${AVAILABLE_SPACE}GB (Recommended: 50GB+)"
    fi
    
    # Check CPU cores
    print_success "CPU cores: $NUM_CORES"
    
    if [ "$all_ok" = false ]; then
        print_error "System requirements not met. Installation may fail."
        if ! prompt_yes_no "Continue anyway?" "n"; then
            exit 1
        fi
    fi
    
    echo ""
}

# =============================================================================
# Install CUDA Toolkit
# =============================================================================

install_cuda_toolkit() {
    print_header "Installing CUDA Toolkit"
    
    # Check if nvcc is already available
    if check_command nvcc; then
        NVCC_VERSION=$(nvcc --version 2>/dev/null | grep "release" | awk '{print $5}' | cut -d',' -f1 || echo "unknown")
        print_success "CUDA Toolkit already installed: $NVCC_VERSION"
        return 0
    fi
    
    # Check if nvidia-smi is available (driver must be installed first)
    if ! check_command nvidia-smi; then
        print_error "NVIDIA Driver not found. Please install NVIDIA driver first."
        print_info "Install with: sudo apt-get install -y nvidia-driver-<version>"
        print_info "Or visit: https://www.nvidia.com/Download/index.aspx"
        return 1
    fi
    
    # Get driver CUDA version
    DRIVER_CUDA=$(nvidia-smi | grep "CUDA Version" | awk '{print $9}' | cut -d'.' -f1,2)
    if [ -z "$DRIVER_CUDA" ]; then
        print_warning "Cannot detect CUDA version from driver"
        DRIVER_CUDA="12.6"
    fi
    
    print_info "NVIDIA Driver supports CUDA up to: $DRIVER_CUDA"
    print_info "Will install CUDA Toolkit 12.6 (compatible with driver)"
    echo ""
    
    if ! prompt_yes_no "Install CUDA Toolkit 12.6?" "y"; then
        print_warning "Skipping CUDA Toolkit installation"
        return 0
    fi
    
    # Check if we need sudo
    if [ "$EUID" -ne 0 ]; then
        SUDO="sudo"
    else
        SUDO=""
    fi
    
    # For Ubuntu/Debian systems
    if check_command apt-get; then
        print_info "Downloading CUDA repository keyring..."
        
        # Download keyring
        wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb -O /tmp/cuda-keyring.deb
        
        if [ $? -ne 0 ]; then
            print_error "Failed to download CUDA keyring"
            return 1
        fi
        
        print_info "Installing CUDA repository keyring..."
        run_dpkg -i /tmp/cuda-keyring.deb
        rm -f /tmp/cuda-keyring.deb
        
        print_info "Updating package lists..."
        run_apt_get update -qq
        
        print_info "Installing CUDA Toolkit 12.6 (this will take several minutes)..."
        print_warning "Download size: ~3GB, Install size: ~6.7GB"
        echo ""
        
        run_apt_get install -y cuda-toolkit-12-6
        
        if [ $? -ne 0 ]; then
            print_error "Failed to install CUDA Toolkit"
            return 1
        fi
        
        print_success "CUDA Toolkit 12.6 installed successfully"
        
        # Setup environment variables
        CUDA_PATH="/usr/local/cuda-12.6"
        
        print_info "Setting up environment variables..."
        
        # Add to current session
        export PATH="$CUDA_PATH/bin:$PATH"
        export LD_LIBRARY_PATH="$CUDA_PATH/lib64:$LD_LIBRARY_PATH"
        
        # Add to .bashrc if not already there
        if ! grep -q "CUDA Toolkit" "$HOME/.bashrc" 2>/dev/null; then
            cat >> "$HOME/.bashrc" << 'EOF'

# CUDA Toolkit
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
EOF
            print_success "CUDA environment variables added to ~/.bashrc"
        fi
        
        # Verify installation
        if [ -f "$CUDA_PATH/bin/nvcc" ]; then
            NVCC_VERSION=$("$CUDA_PATH/bin/nvcc" --version | grep "release" | awk '{print $5}' | cut -d',' -f1)
            print_success "CUDA Toolkit $NVCC_VERSION is ready"
            CUDA_VERSION="$NVCC_VERSION"
        else
            print_warning "CUDA installed but nvcc not found at expected location"
        fi
        
    else
        print_error "Automatic CUDA installation only supported on Ubuntu/Debian"
        print_info "Please install CUDA manually from: https://developer.nvidia.com/cuda-downloads"
        return 1
    fi
    
    echo ""
}

# =============================================================================
# Install System Dependencies
# =============================================================================

install_system_dependencies() {
    print_header "Installing System Dependencies"
    
    # Detect package manager
    if check_command apt-get; then
        PKG_MANAGER="apt-get"
    elif check_command dnf; then
        PKG_MANAGER="dnf"
    elif check_command yum; then
        PKG_MANAGER="yum"
    else
        print_error "No supported package manager found (apt/dnf/yum)"
        exit 1
    fi
    
    print_info "Using package manager: $PKG_MANAGER"
    
    # Check if we need sudo
    if [ "$EUID" -ne 0 ]; then
        SUDO="sudo"
        print_info "Will use sudo for system package installation"
    else
        SUDO=""
    fi
    
    # Update package lists
    print_info "Updating package lists..."
    package_manager_update || true
    
    # Essential build tools
    PACKAGES=(
        build-essential
        cmake
        git
        wget
        curl
        pkg-config
        unzip

        # Python
        python3
        python3-pip
        python3-dev
        python3-venv

        # FFmpeg (for GPU-accelerated video frame extraction)
        ffmpeg

        # Libraries for COLMAP
        libboost-all-dev
        libeigen3-dev
        libflann-dev
        libfreeimage-dev
        libmetis-dev
        libgoogle-glog-dev
        libgflags-dev
        libabsl-dev
        libsqlite3-dev
        libglew-dev
        qtbase5-dev
        libqt5opengl5-dev
        libcgal-dev
        libceres-dev
        libsuitesparse-dev
        libopenblas-dev
        liblapack-dev
        libopenimageio-dev
        openimageio-tools

        # OpenCV
        libopencv-dev

        # HDF5 for hloc feature storage
        libhdf5-dev
        hdf5-tools

        # OpenGL/Mesa for pyrender (FastMap visualization)
        libosmesa6-dev
        libgl1-mesa-dev
        libglu1-mesa-dev
        freeglut3-dev

        # Additional utilities
        lsof
        psmisc
        htop
        ninja-build
    )

    if [ "$CUDA_ENABLED" = "ON" ]; then
        PACKAGES+=(
            libcudss0-cuda-12
            libcudss0-dev-cuda-12
        )
    fi
    
    print_info "Installing required packages..."
    for package in "${PACKAGES[@]}"; do
        if package_manager_install "$package" 2>/dev/null; then
            print_success "Installed: $package"
        else
            print_warning "Could not install: $package (may not be available or already installed)"
        fi
    done
    
    # Check FFmpeg NVDEC support for GPU-accelerated video processing
    check_ffmpeg_gpu_support
    
    # Install Node.js if not present
    if ! check_command node; then
        print_info "Installing Node.js..."
        curl -fsSL https://deb.nodesource.com/setup_lts.x | $SUDO bash -
        package_manager_install nodejs
        print_success "Node.js installed"
    else
        NODE_VERSION=$(node --version)
        print_success "Node.js already installed: $NODE_VERSION"
    fi
    
    # Install npm if not present
    if ! check_command npm; then
        package_manager_install npm
    fi
    
    print_success "System dependencies installation complete"
    echo ""
}

# =============================================================================
# Check FFmpeg GPU Support
# =============================================================================

check_ffmpeg_gpu_support() {
    print_info "Checking FFmpeg GPU acceleration support..."
    
    if ! check_command ffmpeg; then
        print_warning "FFmpeg not installed - GPU video acceleration will not be available"
        return 1
    fi
    
    # Check for CUDA/NVDEC support
    HWACCELS=$(ffmpeg -hwaccels 2>/dev/null | grep -E "cuda|nvdec|vaapi" || echo "")
    
    if echo "$HWACCELS" | grep -q "cuda"; then
        print_success "FFmpeg CUDA/NVDEC hardware acceleration available"
        print_info "  Video frame extraction will be 5-10x faster using GPU"
        return 0
    elif echo "$HWACCELS" | grep -q "nvdec"; then
        print_success "FFmpeg NVDEC hardware acceleration available"
        return 0
    elif echo "$HWACCELS" | grep -q "vaapi"; then
        print_success "FFmpeg VAAPI hardware acceleration available (AMD/Intel)"
        return 0
    else
        print_warning "FFmpeg installed but no GPU hardware acceleration detected"
        print_info "  Available hwaccels: $(ffmpeg -hwaccels 2>/dev/null | tail -n +2 | tr '\n' ' ')"
        print_info ""
        print_info "  To enable NVDEC for NVIDIA GPUs, you may need to:"
        print_info "    1. Install NVIDIA Video Codec SDK"
        print_info "    2. Rebuild FFmpeg with --enable-nvdec --enable-cuda"
        print_info "    Or use the NVIDIA-provided FFmpeg builds"
        print_info ""
        print_info "  Video frame extraction will use CPU (still functional, but slower)"
        return 1
    fi
}

# =============================================================================
# Ensure Unzip is Available
# =============================================================================

ensure_unzip() {
    # Check if unzip is already installed
    if check_command unzip; then
        return 0
    fi

    print_warning "unzip command not found"

    # Check if we need sudo
    if [ "$EUID" -ne 0 ]; then
        SUDO="sudo"
    else
        SUDO=""
    fi

    # Try to install unzip
    if check_command apt-get; then
        print_info "Attempting to install unzip..."
        if run_apt_get install -y unzip 2>/dev/null; then
            print_success "unzip installed successfully"
            return 0
        else
            print_warning "Could not install unzip automatically (sudo may be required)"
        fi
    elif check_command dnf; then
        print_info "Attempting to install unzip..."
        if $SUDO dnf install -y unzip 2>/dev/null; then
            print_success "unzip installed successfully"
            return 0
        fi
    elif check_command yum; then
        print_info "Attempting to install unzip..."
        if $SUDO yum install -y unzip 2>/dev/null; then
            print_success "unzip installed successfully"
            return 0
        fi
    fi

    # If unzip installation failed, we'll use Python as fallback
    print_info "Will use Python zipfile module as fallback"
    return 1
}

# =============================================================================
# Setup LibTorch
# =============================================================================

setup_libtorch() {
    print_header "Setting up LibTorch"

    # Determine LibTorch version based on CUDA
    if [ -z "$CUDA_VERSION" ]; then
        LIBTORCH_VARIANT="cpu"
        LIBTORCH_DIR="$PROJECT_ROOT/libtorch-cpu"
        LIBTORCH_URL="https://download.pytorch.org/libtorch/cpu/libtorch-cxx11-abi-shared-with-deps-2.1.0%2Bcpu.zip"
    elif [[ "$CUDA_VERSION" == "12.6"* ]] || [[ "$CUDA_VERSION" == "12."* ]]; then
        LIBTORCH_VARIANT="cuda126"
        LIBTORCH_DIR="$PROJECT_ROOT/libtorch-cuda126"
        LIBTORCH_URL="https://download.pytorch.org/libtorch/cu121/libtorch-cxx11-abi-shared-with-deps-2.1.0%2Bcu121.zip"
        print_info "Using CUDA 12.1 compatible LibTorch for CUDA $CUDA_VERSION"
    elif [[ "$CUDA_VERSION" == "11.8"* ]]; then
        LIBTORCH_VARIANT="cuda118"
        LIBTORCH_DIR="$PROJECT_ROOT/libtorch-cuda118"
        LIBTORCH_URL="https://download.pytorch.org/libtorch/cu118/libtorch-cxx11-abi-shared-with-deps-2.1.0%2Bcu118.zip"
    else
        LIBTORCH_VARIANT="cuda121"
        LIBTORCH_DIR="$PROJECT_ROOT/libtorch-cuda121"
        LIBTORCH_URL="https://download.pytorch.org/libtorch/cu121/libtorch-cxx11-abi-shared-with-deps-2.1.0%2Bcu121.zip"
    fi

    print_info "LibTorch variant: $LIBTORCH_VARIANT"
    print_info "Install directory: $LIBTORCH_DIR"

    if [ -d "$LIBTORCH_DIR" ]; then
        print_success "LibTorch already exists at $LIBTORCH_DIR"
        if ! prompt_yes_no "Re-download LibTorch?" "n"; then
            return 0
        fi
        rm -rf "$LIBTORCH_DIR"
    fi

    print_info "Downloading LibTorch (this may take a while)..."
    LIBTORCH_ZIP="libtorch-${LIBTORCH_VARIANT}.zip"

    wget --progress=bar:force:noscroll -O "$LIBTORCH_ZIP" "$LIBTORCH_URL"

    print_info "Extracting LibTorch..."

    # Ensure unzip is available (will try to install or use Python fallback)
    ensure_unzip

    if check_command unzip; then
        # Use unzip if available
        unzip -q "$LIBTORCH_ZIP"
    else
        # Fallback to Python zipfile module
        print_info "Using Python to extract archive..."
        python3 -c "import zipfile; zipfile.ZipFile('$LIBTORCH_ZIP').extractall('.')"

        if [ $? -ne 0 ]; then
            print_error "Failed to extract LibTorch archive"
            print_info "Please install unzip: sudo apt-get install unzip"
            rm -f "$LIBTORCH_ZIP"
            return 1
        fi
    fi

    mv libtorch "$LIBTORCH_DIR"
    rm "$LIBTORCH_ZIP"

    print_success "LibTorch setup complete"
    echo ""
}

# =============================================================================
# Build COLMAP (uses global CUDA settings)
# =============================================================================

build_colmap_internal() {
    local gui_enabled
    local ceres_cmake_dir=""
    local ceres_lib_dir=""
    local cudss_cmake_dir=""
    local cudss_lib_dir=""
    local colmap_ceres_link=""
    local colmap_cmake_prefix_path=""

    print_info "Building COLMAP..."

    if ! upgrade_cmake; then
        print_error "A newer CMake installation is required before building COLMAP"
        cd "$PROJECT_ROOT"
        return 1
    fi

    if [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ] || [ -f "$COLMAP_BUILD_DIR/colmap" ]; then
        print_success "COLMAP binary already exists"
        if prompt_yes_no "Rebuild COLMAP?" "n"; then
            print_info "Cleaning previous build directory..."
            rm -rf "$COLMAP_BUILD_DIR"
            print_success "Previous build cleaned"
        else
            return 0
        fi
    fi
    
    # Uses global CUDA_HOME, CUDA_ENABLED, GPU_ARCHS
    if [ "$CUDA_ENABLED" = "ON" ]; then
        print_info "Building COLMAP with CUDA support"
        print_info "CUDA: $CUDA_HOME"
        print_info "GPU architectures: $GPU_ARCHS"
    else
        print_warning "Building CPU-only COLMAP"
    fi
    
    # GUI support - default OFF for servers
    gui_enabled="$COLMAP_GUI_ENABLED"
    
    # Check if COLMAP source exists
    if [ ! -d "$PROJECT_ROOT/colmap" ]; then
        print_info "Cloning COLMAP repository..."
        git clone https://github.com/colmap/colmap.git "$PROJECT_ROOT/colmap"
    fi
    
    mkdir -p "$COLMAP_BUILD_DIR"
    cd "$COLMAP_BUILD_DIR"
    
    if [ "$CUDA_ENABLED" = "ON" ]; then
        if ! colmap_build_ceres_with_cuda "$PROJECT_ROOT" "$CUDA_HOME" "$GPU_ARCHS" "$NUM_CORES" "$COLMAP_CERES_VERSION"; then
            print_error "CUDA-enabled Ceres build failed; refusing to build a CPU-only BA COLMAP by mistake"
            cd "$PROJECT_ROOT"
            return 1
        fi

        ceres_cmake_dir="$(colmap_ceres_cmake_dir "$PROJECT_ROOT" || true)"
        ceres_lib_dir="$(colmap_ceres_lib_dir "$PROJECT_ROOT" || true)"
        cudss_cmake_dir="$(colmap_prepare_cudss_cmake_shim "$PROJECT_ROOT" || true)"
        if [ -z "$cudss_cmake_dir" ]; then
            cudss_cmake_dir="$(colmap_detect_cudss_cmake_dir || true)"
        fi
        cudss_lib_dir="$(colmap_detect_cudss_lib_dir || true)"
        colmap_cmake_prefix_path="$CERES_INSTALL_DIR"
        if [ -n "$cudss_cmake_dir" ]; then
            colmap_cmake_prefix_path="$colmap_cmake_prefix_path;$(cd "$cudss_cmake_dir/../.." && pwd)"
        fi
        if [ -z "$ceres_cmake_dir" ] || [ -z "$ceres_lib_dir" ]; then
            print_error "CUDA-enabled Ceres was built, but its install directories could not be resolved"
            cd "$PROJECT_ROOT"
            return 1
        fi

        print_info "Using CUDA-enabled Ceres from $ceres_cmake_dir"
    fi

    print_info "Configuring COLMAP with CMake (CUDA: $CUDA_ENABLED, GUI: $gui_enabled)..."
    
    # Build CMake command
    CMAKE_ARGS=(
        "$PROJECT_ROOT/colmap"
        "-DCMAKE_BUILD_TYPE=Release"
        "-DCUDA_ENABLED=$CUDA_ENABLED"
        "-DGLOMAP_CUDA_ENABLED=$CUDA_ENABLED"
        "-DGUI_ENABLED=$gui_enabled"
        "-DCMAKE_INSTALL_PREFIX=$COLMAP_INSTALL_DIR"
        "-DCMAKE_INSTALL_RPATH_USE_LINK_PATH=ON"
    )

    if [ "$CUDA_ENABLED" = "ON" ]; then
        CMAKE_ARGS+=(
            "-DCMAKE_IGNORE_PREFIX_PATH=/home/linuxbrew/.linuxbrew"
            "-DCMAKE_PREFIX_PATH=$colmap_cmake_prefix_path"
            "-DEigen3_DIR=/usr/share/eigen3/cmake"
            "-DCMAKE_CUDA_ARCHITECTURES=$GPU_ARCHS"
            "-DCMAKE_CUDA_COMPILER=$CUDA_HOME/bin/nvcc"
            "-DCUDA_TOOLKIT_ROOT_DIR=$CUDA_HOME"
            "-DCeres_DIR=$ceres_cmake_dir"
            "-Dcudss_DIR=$cudss_cmake_dir"
            "-DCMAKE_BUILD_RPATH=$ceres_lib_dir;$CUDA_HOME/lib64${cudss_lib_dir:+;$cudss_lib_dir}"
            "-DCMAKE_INSTALL_RPATH=$ceres_lib_dir;$CUDA_HOME/lib64${cudss_lib_dir:+;$cudss_lib_dir}"
        )
    fi
    
    cmake "${CMAKE_ARGS[@]}"
    
    if [ $? -ne 0 ]; then
        print_error "CMake configuration failed"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    print_info "Building COLMAP (using $NUM_CORES cores)..."
    make -j"$NUM_CORES"
    
    if [ $? -ne 0 ]; then
        print_error "COLMAP build failed"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    print_info "Installing COLMAP into $COLMAP_INSTALL_DIR..."
    cmake --install .

    # Find and setup COLMAP binary
    COLMAP_BIN="$(get_colmap_binary_path || true)"
    
    if [ -n "$COLMAP_BIN" ]; then
        print_success "COLMAP build complete"
        
        # Create symlink for easy access
        if [ "$EUID" -eq 0 ] || sudo -n true 2>/dev/null; then
            print_info "Creating system-wide symlink..."
            sudo ln -sf "$COLMAP_BIN" /usr/local/bin/colmap 2>/dev/null && \
                print_success "Symlink created: /usr/local/bin/colmap" || \
                print_warning "Could not create symlink (not critical)"
        elif [ "$(readlink -f /usr/local/bin/colmap 2>/dev/null)" = "$(readlink -f "$COLMAP_BIN")" ]; then
            print_success "Symlink already points to the rebuilt COLMAP binary"
        else
            print_warning "Skipping symlink update: sudo is required to change /usr/local/bin/colmap"
        fi
        
        # Test COLMAP
        if $COLMAP_BIN -h 2>&1 | grep -q "COLMAP"; then
            print_success "COLMAP binary working correctly"
            
            # Check CUDA support
            if $COLMAP_BIN -h 2>&1 | grep -q "with CUDA"; then
                print_success "COLMAP built with CUDA support!"
            fi

            colmap_ceres_link=$(ldd "$COLMAP_BIN" 2>/dev/null | awk '/libceres/ {print $3; exit}')
            if [ -n "$colmap_ceres_link" ]; then
                print_info "COLMAP links libceres from: $colmap_ceres_link"
            fi

            if [ "$CUDA_ENABLED" = "ON" ] && [ -n "$ceres_lib_dir" ]; then
                if colmap_verify_custom_ceres_integration "$COLMAP_BUILD_DIR" "$COLMAP_BIN" "$ceres_cmake_dir" "$ceres_lib_dir"; then
                    print_success "COLMAP is configured against the custom CUDA-enabled Ceres build"
                else
                    print_error "COLMAP is still linked against a non-custom Ceres; GPU bundle adjustment would fall back to CPU"
                    cd "$PROJECT_ROOT"
                    return 1
                fi
            fi
        fi
    else
        print_error "COLMAP binary not found after build"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Upgrade CMake (Required for GLOMAP)
# =============================================================================

upgrade_cmake() {
    print_header "Checking/Upgrading CMake"
    
    # Required minimum version for GLOMAP
    REQUIRED_CMAKE_VERSION="3.28"
    
    # Check current CMake version
    if check_command cmake; then
        CURRENT_CMAKE_VERSION=$(cmake --version | head -n1 | grep -oP '\d+\.\d+\.\d+' | head -1)
        if version_at_least "$CURRENT_CMAKE_VERSION" "$REQUIRED_CMAKE_VERSION"; then
            print_success "CMake $CURRENT_CMAKE_VERSION is sufficient (>= $REQUIRED_CMAKE_VERSION)"
            return 0
        else
            print_warning "CMake $CURRENT_CMAKE_VERSION is too old (need >= $REQUIRED_CMAKE_VERSION)"
        fi
    else
        print_warning "CMake not found"
    fi
    
    print_info "Installing CMake $REQUIRED_CMAKE_VERSION or newer..."
    
    # Check if we need sudo
    if [ "$EUID" -ne 0 ]; then
        SUDO="sudo"
    else
        SUDO=""
    fi
    
    # For Ubuntu/Debian - use Kitware's official APT repository
    if check_command apt-get; then
        print_info "Adding Kitware APT repository for latest CMake..."
        local apt_install_ok=true

        # Install prerequisites
        if ! run_apt_get update -qq; then
            print_warning "APT update failed while preparing Kitware repository"
            apt_install_ok=false
        fi
        if $apt_install_ok && ! run_apt_get install -y ca-certificates gpg wget; then
            print_warning "Failed to install Kitware repository prerequisites"
            apt_install_ok=false
        fi

        # Download and add Kitware's GPG key
        if $apt_install_ok && ! wget -O - https://apt.kitware.com/keys/kitware-archive-latest.asc 2>/dev/null | gpg --dearmor - | $SUDO tee /usr/share/keyrings/kitware-archive-keyring.gpg >/dev/null; then
            print_warning "Failed to add Kitware APT signing key"
            apt_install_ok=false
        fi

        # Add Kitware repository (Ubuntu 22.04)
        if $apt_install_ok; then
            if [ -f /etc/os-release ]; then
                . /etc/os-release
                UBUNTU_CODENAME="${UBUNTU_CODENAME:-jammy}"
            else
                UBUNTU_CODENAME="jammy"
            fi

            if ! echo "deb [signed-by=/usr/share/keyrings/kitware-archive-keyring.gpg] https://apt.kitware.com/ubuntu/ $UBUNTU_CODENAME main" | $SUDO tee /etc/apt/sources.list.d/kitware.list >/dev/null; then
                print_warning "Failed to configure Kitware APT repository"
                apt_install_ok=false
            fi
        fi

        # Update and install CMake
        if $apt_install_ok && ! run_apt_get update -qq; then
            print_warning "APT update failed after adding Kitware repository"
            apt_install_ok=false
        fi
        if $apt_install_ok && ! run_apt_get install -y cmake; then
            print_warning "APT install of CMake failed; attempting fallback installer"
            apt_install_ok=false
        fi

        hash -r
        if $apt_install_ok && check_command cmake; then
            NEW_CMAKE_VERSION=$(cmake --version | head -n1 | grep -oP '\d+\.\d+\.\d+' | head -1)
            if version_at_least "$NEW_CMAKE_VERSION" "$REQUIRED_CMAKE_VERSION"; then
                print_success "CMake upgraded to $NEW_CMAKE_VERSION"
                return 0
            fi
            print_warning "APT left CMake at $NEW_CMAKE_VERSION; falling back to direct install"
        fi
    fi
    
    # Fallback: Install from pre-built binary
    print_info "Installing CMake from pre-built binary..."
    
    CMAKE_VERSION="3.30.5"
    CMAKE_ARCH="x86_64"
    CMAKE_INSTALL_DIR="/opt/cmake-${CMAKE_VERSION}"
    CMAKE_EXTRACTED_DIR="/opt/cmake-${CMAKE_VERSION}-linux-${CMAKE_ARCH}"
    CMAKE_URL="https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-${CMAKE_ARCH}.tar.gz"
    
    # Download and extract
    print_info "Downloading CMake ${CMAKE_VERSION}..."
    wget -q --show-progress -O /tmp/cmake.tar.gz "$CMAKE_URL"
    
    if [ $? -ne 0 ]; then
        print_error "Failed to download CMake"
        return 1
    fi
    
    print_info "Extracting CMake..."
    $SUDO mkdir -p "$CMAKE_INSTALL_DIR"
    $SUDO tar -xzf /tmp/cmake.tar.gz -C /opt/
    rm -f /tmp/cmake.tar.gz

    if [ ! -x "$CMAKE_EXTRACTED_DIR/bin/cmake" ]; then
        print_error "Extracted CMake binary not found at $CMAKE_EXTRACTED_DIR/bin/cmake"
        return 1
    fi

    # Keep a stable symlinked install path for future upgrades.
    $SUDO rm -rf "$CMAKE_INSTALL_DIR"
    $SUDO ln -sfn "$CMAKE_EXTRACTED_DIR" "$CMAKE_INSTALL_DIR"
    
    # Create symlinks
    $SUDO ln -sf "$CMAKE_EXTRACTED_DIR/bin/cmake" /usr/local/bin/cmake
    $SUDO ln -sf "$CMAKE_EXTRACTED_DIR/bin/ctest" /usr/local/bin/ctest
    $SUDO ln -sf "$CMAKE_EXTRACTED_DIR/bin/cpack" /usr/local/bin/cpack

    export PATH="$CMAKE_EXTRACTED_DIR/bin:$PATH"
    
    # Update PATH hash
    hash -r
    
    # Verify
    if check_command cmake; then
        NEW_CMAKE_VERSION=$(cmake --version | head -n1 | grep -oP '\d+\.\d+\.\d+' | head -1)
        if version_at_least "$NEW_CMAKE_VERSION" "$REQUIRED_CMAKE_VERSION"; then
            print_success "CMake $NEW_CMAKE_VERSION installed successfully"
            return 0
        fi
        print_error "CMake installation failed to provide the required version (got $NEW_CMAKE_VERSION, need >= $REQUIRED_CMAKE_VERSION)"
        return 1
    fi

    print_error "CMake installation failed"
    return 1
}

# =============================================================================
# Setup GLOMAP (legacy fallback only)
# =============================================================================

build_glomap_internal() {
    print_info "Setting up legacy GLOMAP fallback..."
    
    # GLOMAP is now built as part of COLMAP 3.14+
    # No separate build needed - just create symlink to the COLMAP-integrated version
    
    GLOMAP_FROM_COLMAP="$COLMAP_BUILD_DIR/src/glomap/glomap"
    
    # Check if GLOMAP was built with COLMAP
    if [ -f "$GLOMAP_FROM_COLMAP" ] && [ -x "$GLOMAP_FROM_COLMAP" ]; then
        print_success "GLOMAP found in COLMAP build: $GLOMAP_FROM_COLMAP"
        
        # Check GLOMAP version info
        GLOMAP_INFO=$("$GLOMAP_FROM_COLMAP" --help 2>&1 | head -n 3 || echo "")
        if [[ "$GLOMAP_INFO" =~ "CUDA" ]]; then
            if [[ "$GLOMAP_INFO" =~ "NOT" ]]; then
                print_info "GLOMAP built without CUDA (CPU-only)"
            else
                print_success "GLOMAP built with CUDA support"
            fi
        fi
        
        # Create/update symlink in /usr/local/bin
        print_info "Creating symlink to /usr/local/bin/glomap..."
        if [ "$EUID" -eq 0 ]; then
            rm -f /usr/local/bin/glomap
            ln -sf "$GLOMAP_FROM_COLMAP" /usr/local/bin/glomap
            print_success "GLOMAP symlink created: /usr/local/bin/glomap -> $GLOMAP_FROM_COLMAP"
        elif sudo -n true 2>/dev/null; then
            sudo rm -f /usr/local/bin/glomap
            sudo ln -sf "$GLOMAP_FROM_COLMAP" /usr/local/bin/glomap
            print_success "GLOMAP symlink created: /usr/local/bin/glomap -> $GLOMAP_FROM_COLMAP"
        else
            print_info "Creating GLOMAP symlink requires sudo password..."
            sudo rm -f /usr/local/bin/glomap
            sudo ln -sf "$GLOMAP_FROM_COLMAP" /usr/local/bin/glomap
            print_success "GLOMAP symlink created: /usr/local/bin/glomap -> $GLOMAP_FROM_COLMAP"
        fi
        
        # Test GLOMAP
        if command -v glomap &> /dev/null; then
            print_success "GLOMAP legacy fallback is ready to use"
            print_info "The project now prefers COLMAP global_mapper first and uses standalone glomap only as a compatibility fallback"
        fi
        
        # Clean up old standalone glomap-build if exists
        OLD_GLOMAP_BUILD="$PROJECT_ROOT/glomap-build"
        if [ -d "$OLD_GLOMAP_BUILD" ]; then
            print_info "Found old standalone glomap-build directory"
            if prompt_yes_no "Remove old glomap-build to save space (~364MB)?" "y"; then
                rm -rf "$OLD_GLOMAP_BUILD"
                print_success "Old glomap-build removed"
            fi
        fi
        
        return 0
    else
        print_warning "GLOMAP not found in COLMAP build"
        print_info "COLMAP 3.14+ includes GLOMAP by default"
        print_info "If you built an older COLMAP version, GLOMAP may not be available"
        print_info "Sparse reconstruction will use COLMAP mapper instead (slower but works)"
        return 1
    fi
}

# =============================================================================
# Build pycolmap from local COLMAP source
# =============================================================================

build_pycolmap_from_source() {
    print_header "Building pycolmap (Experimental Global SfM Backend)"

    if [ ! -d "$BACKEND_DIR/venv" ]; then
        print_warning "Backend venv not found - setup Python backend first"
        return 1
    fi

    if [ ! -d "$PROJECT_ROOT/colmap" ]; then
        print_warning "COLMAP source directory not found at $PROJECT_ROOT/colmap"
        return 1
    fi

    if [ ! -d "$COLMAP_INSTALL_DIR" ]; then
        print_warning "COLMAP install prefix not found at $COLMAP_INSTALL_DIR"
        print_info "Build COLMAP first so pycolmap can link against the matching install"
        return 1
    fi

    source "$BACKEND_DIR/venv/bin/activate"

    print_info "Installing pycolmap build requirements..."
    pip install --quiet scikit-build-core pybind11 || {
        print_error "Failed to install pycolmap build requirements"
        deactivate
        return 1
    }

    print_info "Building pycolmap from local COLMAP source..."
    pip uninstall -y pycolmap >/dev/null 2>&1 || true
    CMAKE_PREFIX_PATH="$COLMAP_INSTALL_DIR" \
        pip install --no-build-isolation -Ccmake.define.GENERATE_STUBS=OFF "$PROJECT_ROOT/colmap"

    if [ $? -ne 0 ]; then
        print_error "pycolmap build failed"
        deactivate
        return 1
    fi

    if python -c "import pycolmap; assert hasattr(pycolmap, 'global_mapping'); assert hasattr(pycolmap, 'GlobalMapperOptions'); assert hasattr(pycolmap, 'GlobalPipelineOptions'); print(pycolmap.__version__)" >/tmp/pobim_pycolmap_version.txt 2>/dev/null; then
        PYCOLMAP_VERSION=$(cat /tmp/pobim_pycolmap_version.txt 2>/dev/null || echo "unknown")
        rm -f /tmp/pobim_pycolmap_version.txt
        print_success "pycolmap built and installed successfully"
        print_info "pycolmap version: $PYCOLMAP_VERSION"
        print_info "Experimental backend status: ready for global_mapping"
        deactivate
        return 0
    fi

    rm -f /tmp/pobim_pycolmap_version.txt
    print_error "pycolmap installed but readiness checks failed"
    deactivate
    return 1
}

# =============================================================================
# Setup hloc (Hierarchical Localization - Neural Feature Matching)
# =============================================================================

setup_hloc() {
    print_header "Setting up hloc (Neural Feature Matching)"
    
    HLOC_DIR="$PROJECT_ROOT/hloc"
    
    if [ ! -d "$HLOC_DIR" ]; then
        print_warning "hloc directory not found at $HLOC_DIR"
        print_info "hloc should be included as a git submodule"
        return 1
    fi
    
    print_info "hloc provides neural feature extraction and matching:"
    echo "  - SuperPoint: State-of-the-art feature detection"
    echo "  - SuperGlue/LightGlue: Neural feature matching"
    echo "  - NetVLAD: Image retrieval for localization"
    echo ""
    
    cd "$HLOC_DIR"
    
    if [ -d "$BACKEND_DIR/venv" ]; then
        print_info "Installing hloc into backend virtual environment..."
        source "$BACKEND_DIR/venv/bin/activate"
        
        print_info "Installing hloc dependencies..."
        pip install --quiet torch torchvision 2>/dev/null || print_warning "PyTorch may need manual installation"
        pip install --quiet tqdm matplotlib plotly scipy h5py kornia gdown 2>/dev/null || true
        if python -c "import pycolmap" >/dev/null 2>&1; then
            print_success "pycolmap already available in backend venv"
        else
            print_warning "pycolmap not found in backend venv; hloc can still run, but the experimental global mapping backend will remain unavailable"
        fi
        
        print_info "Installing LightGlue (fast feature matcher)..."
        pip install --quiet "git+https://github.com/cvg/LightGlue" 2>/dev/null || print_warning "LightGlue installation may have failed"
        
        print_info "Installing hloc package..."
        pip install -e . --quiet 2>/dev/null
        
        if [ $? -eq 0 ]; then
            print_success "hloc installed successfully"
        else
            print_warning "hloc installation had some issues - check manually"
        fi
        
        deactivate
    else
        print_warning "Backend venv not found - install Python backend first"
        print_info "You can install hloc manually later with: pip install -e $HLOC_DIR"
    fi
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Setup FastMap (Fast First-Order SfM Optimization)
# =============================================================================

setup_fastmap() {
    print_header "Setting up FastMap (Fast SfM Optimization)"
    
    FASTMAP_DIR="$PROJECT_ROOT/fastmap"
    
    if [ ! -d "$FASTMAP_DIR" ]; then
        print_warning "FastMap directory not found at $FASTMAP_DIR"
        print_info "FastMap should be included as a git submodule"
        return 1
    fi
    
    print_info "FastMap provides fast structure-from-motion optimization:"
    echo "  - First-order optimization for camera poses"
    echo "  - Optional CUDA acceleration"
    echo "  - Faster than traditional bundle adjustment"
    echo ""
    
    cd "$FASTMAP_DIR"
    
    if [ -d "$BACKEND_DIR/venv" ]; then
        print_info "Installing FastMap into backend virtual environment..."
        source "$BACKEND_DIR/venv/bin/activate"
        
        print_info "Installing FastMap Python dependencies..."
        pip install --quiet trimesh pyyaml dacite loguru prettytable psutil 2>/dev/null || true
        pip install --quiet "pyglet<2" 2>/dev/null || true
        
        print_info "Installing pyrender for visualization..."
        pip install --quiet "git+https://github.com/jiahaoli95/pyrender.git" 2>/dev/null || print_warning "pyrender installation may have failed"
        
        if [ "$CUDA_ENABLED" = "ON" ] && [ -n "$CUDA_HOME" ]; then
            print_info "Building FastMap CUDA kernels..."
            export PATH="$CUDA_HOME/bin:$PATH"
            export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
            
            python setup.py build_ext --inplace 2>/dev/null
            
            if [ $? -eq 0 ]; then
                print_success "FastMap CUDA kernels built successfully"
            else
                print_warning "FastMap CUDA build failed - will use CPU fallback"
            fi
        else
            print_info "Skipping CUDA kernel build (CPU mode)"
        fi
        
        print_info "Installing FastMap package..."
        pip install -e . --quiet 2>/dev/null || true
        
        print_success "FastMap setup complete"
        
        deactivate
    else
        print_warning "Backend venv not found - install Python backend first"
        print_info "You can install FastMap manually later"
    fi
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Build OpenSplat (uses global CUDA settings)
# =============================================================================

build_opensplat() {
    print_header "Building OpenSplat"

    if [ -f "$BUILD_DIR/opensplat" ]; then
        print_success "OpenSplat binary already exists"
        if prompt_yes_no "Rebuild OpenSplat?" "n"; then
            print_info "Cleaning previous build directory..."
            rm -rf "$BUILD_DIR"
            print_success "Previous build cleaned"
        else
            return 0
        fi
    fi
    
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    # Clean CMake cache if it exists to avoid stale configuration
    if [ -f "CMakeCache.txt" ]; then
        print_info "Cleaning stale CMake cache..."
        rm -f CMakeCache.txt
    fi
    
    print_info "Configuring OpenSplat with CMake..."
    
    # Uses global CUDA_HOME, CUDA_ENABLED, GPU_ARCHS
    if [ "$CUDA_ENABLED" = "ON" ] && [ -n "$CUDA_HOME" ]; then
        print_info "Building OpenSplat with CUDA support"
        print_info "CUDA: $CUDA_HOME"
        print_info "GPU architectures: $GPU_ARCHS"
        
        # Configure with CUDA
        cmake .. \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_PREFIX_PATH="$LIBTORCH_DIR" \
            -DCMAKE_CUDA_COMPILER="$CUDA_HOME/bin/nvcc" \
            -DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCHS" \
            -DOPENSPLAT_BUILD_SIMPLE_TRAINER=ON
    else
        print_warning "Building CPU-only OpenSplat"
        
        # Configure without CUDA
        cmake .. \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_PREFIX_PATH="$LIBTORCH_DIR" \
            -DOPENSPLAT_BUILD_SIMPLE_TRAINER=ON \
            -DOPENSPLAT_BUILD_CUDA=OFF
    fi
    
    if [ $? -ne 0 ]; then
        print_error "CMake configuration failed"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    # Ensure CUDA is in PATH for make
    if [ -n "$CUDA_HOME" ]; then
        print_info "Ensuring CUDA is in PATH for build process..."
        export PATH="$CUDA_HOME/bin:$PATH"
        export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
        
        # Verify nvcc is accessible
        if command -v nvcc &> /dev/null; then
            NVCC_LOCATION=$(which nvcc)
            print_success "nvcc found at: $NVCC_LOCATION"
        else
            print_warning "nvcc not found in PATH - build may fail"
        fi
    fi
    
    print_info "Building OpenSplat (using $NUM_CORES cores)..."
    make -j"$NUM_CORES"
    
    if [ $? -ne 0 ]; then
        print_error "OpenSplat build failed"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    if [ -f "$BUILD_DIR/opensplat" ]; then
        print_success "OpenSplat build complete"
        
        # Test the binary
        print_info "Testing OpenSplat binary..."
        if ./opensplat --help &>/dev/null || ./opensplat 2>&1 | grep -q "OpenSplat"; then
            VERSION=$(./opensplat --version 2>&1 || echo "version check failed")
            print_success "OpenSplat binary working: $VERSION"
            
            # Check if CUDA libraries are linked
            if ldd ./opensplat | grep -q "cuda"; then
                print_success "OpenSplat built with CUDA support!"
            elif [ -n "$CUDA_HOME" ]; then
                print_warning "OpenSplat may not have CUDA support (check build output)"
            fi
        else
            print_warning "OpenSplat binary test inconclusive"
        fi
    else
        print_error "OpenSplat binary not found after build"
        cd "$PROJECT_ROOT"
        return 1
    fi
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Setup Python Backend
# =============================================================================

setup_python_backend() {
    print_header "Setting up Python Backend"
    
    # Check if we need sudo
    if [ "$EUID" -ne 0 ]; then
        SUDO="sudo"
    else
        SUDO=""
    fi
    
    # Check for Python 3.12
    PYTHON_CMD=""
    if command -v python3.12 &> /dev/null; then
        PYTHON_CMD="python3.12"
        PYTHON_VERSION=$(python3.12 --version)
        print_success "Python 3.12 found: $PYTHON_VERSION"
    elif command -v python3.11 &> /dev/null; then
        PYTHON_CMD="python3.11"
        PYTHON_VERSION=$(python3.11 --version)
        print_warning "Python 3.12 not found, using Python 3.11 instead"
        print_success "Python 3.11 found: $PYTHON_VERSION"
    elif command -v python3 &> /dev/null; then
        PYTHON_VERSION=$(python3 --version | awk '{print $2}')
        PYTHON_MAJOR=$(echo $PYTHON_VERSION | cut -d'.' -f1)
        PYTHON_MINOR=$(echo $PYTHON_VERSION | cut -d'.' -f2)
        
        if [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -ge 10 ] && [ "$PYTHON_MINOR" -le 12 ]; then
            PYTHON_CMD="python3"
            print_warning "Python 3.12 not found, using Python $PYTHON_VERSION"
        else
            print_error "Python 3.10-3.12 supported, found Python $PYTHON_VERSION"
        fi
    fi
    
    # Install Python 3.12 if not found and user wants it
    if [ -z "$PYTHON_CMD" ] || [ "$PYTHON_CMD" != "python3.12" ]; then
        echo ""
        print_info "Python 3.12 is recommended for best compatibility"
        
        if prompt_yes_no "Install Python 3.12?" "y"; then
            print_info "Installing Python 3.12..."
            
            if check_command apt-get; then
                local python_install_timeout=30

                # Add deadsnakes PPA for Python 3.12
                if ! run_apt_get --lock-timeout=$python_install_timeout update -qq || \
                   ! run_apt_get --lock-timeout=$python_install_timeout install -y software-properties-common || \
                   ! $SUDO add-apt-repository -y ppa:deadsnakes/ppa || \
                   ! run_apt_get --lock-timeout=$python_install_timeout update -qq || \
                   ! run_apt_get --lock-timeout=$python_install_timeout install -y python3.12 python3.12-venv python3.12-dev; then
                    print_warning "Python 3.12 installation did not complete; package manager is likely busy"
                    if [ -n "$PYTHON_CMD" ]; then
                        print_warning "Continuing with $PYTHON_CMD and leaving Python 3.12 for a later retry"
                    else
                        return 1
                    fi
                fi
                
                if command -v python3.12 &> /dev/null; then
                    PYTHON_CMD="python3.12"
                    print_success "Python 3.12 installed successfully"
                elif [ -n "$PYTHON_CMD" ]; then
                    print_info "Using existing $PYTHON_CMD for backend setup"
                else
                    print_error "Failed to install Python 3.12"
                    return 1
                fi
            else
                print_error "Automatic Python 3.12 installation only supported on Ubuntu/Debian"
                print_info "Please install Python 3.12 manually:"
                print_info "  https://www.python.org/downloads/"
                
                if [ -n "$PYTHON_CMD" ]; then
                    print_warning "Will continue with $PYTHON_CMD"
                else
                    return 1
                fi
            fi
        else
            if [ -z "$PYTHON_CMD" ]; then
                print_error "Cannot continue without Python 3.10-3.12"
                return 1
            fi
            print_info "Continuing with $PYTHON_CMD"
        fi
    fi
    
    cd "$BACKEND_DIR"
    
    # Create virtual environment
    if [ ! -d "venv" ]; then
        print_info "Creating Python virtual environment with $PYTHON_CMD..."
        $PYTHON_CMD -m venv venv
        
        if [ $? -ne 0 ]; then
            print_error "Failed to create virtual environment"
            print_info "Try installing: $SUDO apt-get install -y ${PYTHON_CMD}-venv"
            return 1
        fi
        print_success "Virtual environment created"
    else
        print_success "Virtual environment already exists"
    fi
    
    # Activate and install dependencies
    source venv/bin/activate
    
    print_info "Upgrading pip..."
    pip install --upgrade pip --quiet
    
    if [ -f "requirements.txt" ]; then
        print_info "Installing Python dependencies from requirements.txt..."
        pip install -r requirements.txt --quiet
        print_success "Base Python dependencies installed"
    else
        print_warning "requirements.txt not found"
    fi
    
    print_info "Installing additional dependencies for new features..."
    
    pip install --quiet reportlab 2>/dev/null && print_success "reportlab installed (ArUco marker PDF generation)" || true
    
    pip install --quiet h5py 2>/dev/null && print_success "h5py installed (hloc support)" || true
    
    pip install --quiet kornia gdown 2>/dev/null && print_success "kornia, gdown installed (neural feature support)" || true

    if [ -d "$PROJECT_ROOT/colmap" ] && [ -d "$COLMAP_INSTALL_DIR" ]; then
        if prompt_yes_no "Build experimental pycolmap backend from local COLMAP source?" "y"; then
            deactivate
            cd "$PROJECT_ROOT"
            build_pycolmap_from_source || print_warning "Experimental pycolmap backend is not ready; CLI global mapper will still work"
            cd "$BACKEND_DIR"
            source venv/bin/activate
        else
            print_info "Skipping experimental pycolmap build"
            print_info "The project will use CLI COLMAP global_mapper and fall back automatically where needed"
        fi
    else
        print_info "Skipping pycolmap source build because matching COLMAP source/install was not found yet"
    fi
    
    deactivate
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Setup Node.js Frontend
# =============================================================================

setup_nodejs_frontend() {
    print_header "Setting up Node.js Frontend"
    
    cd "$FRONTEND_DIR"
    
    if [ -f "package.json" ]; then
        print_info "Installing Node.js dependencies (this may take a while)..."
        npm install
        print_success "Node.js dependencies installed"

        print_info "Building Next.js production bundle..."
        npm run build
        print_success "Production build complete"
    else
        print_warning "package.json not found in Frontend directory"
    fi
    
    cd "$PROJECT_ROOT"
    echo ""
}

# =============================================================================
# Create Quick Start Script
# =============================================================================

create_quick_start_script() {
    print_header "Creating Quick Start Script"
    
    QUICK_START_SCRIPT="$PROJECT_ROOT/quick-start.sh"
    
    cat > "$QUICK_START_SCRIPT" << 'EOFSCRIPT'
#!/bin/bash

# =============================================================================
# POBIMOpenSplat - Quick Start Script
# =============================================================================

set -e

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
POBIM_SPLATTING_DIR="$PROJECT_ROOT/PobimSplatting"

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   POBIMOpenSplat - Quick Start"
echo "============================================================================="
echo -e "${NC}"

# Check if already installed
if [ ! -f "$PROJECT_ROOT/build/opensplat" ]; then
    echo -e "${RED}✗ OpenSplat not found. Please run ./install.sh first${NC}"
    exit 1
fi

echo -e "${GREEN}✓ OpenSplat installation detected${NC}"
echo ""

# Setup environment
LIBTORCH_DIRS=(
    "$PROJECT_ROOT/libtorch-cuda126"
    "$PROJECT_ROOT/libtorch-cuda121"
    "$PROJECT_ROOT/libtorch-cuda118"
    "$PROJECT_ROOT/libtorch-cpu"
)

for dir in "${LIBTORCH_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        export LD_LIBRARY_PATH="$dir/lib:$LD_LIBRARY_PATH"
        echo -e "${CYAN}ℹ Using LibTorch: $dir${NC}"
        break
    fi
done

# Set CUDA paths if available
if [ -d "/usr/local/cuda" ]; then
    export PATH="/usr/local/cuda/bin:$PATH"
    export LD_LIBRARY_PATH="/usr/local/cuda/lib64:$LD_LIBRARY_PATH"
fi

# Set Qt to offscreen for COLMAP
export QT_QPA_PLATFORM=offscreen

echo ""
echo -e "${BLUE}Starting PobimSplatting server...${NC}"
echo ""

cd "$POBIM_SPLATTING_DIR"

if [ -f "start.sh" ]; then
    exec bash start.sh start
else
    echo -e "${RED}✗ start.sh not found in PobimSplatting directory${NC}"
    exit 1
fi
EOFSCRIPT
    
    chmod +x "$QUICK_START_SCRIPT"
    
    print_success "Quick start script created: $QUICK_START_SCRIPT"
    echo ""
}

# =============================================================================
# Create Environment Configuration
# =============================================================================

create_env_config() {
    print_header "Creating Environment Configuration"
    
    ENV_FILE="$PROJECT_ROOT/.env.local"
    
    cat > "$ENV_FILE" << EOF
# POBIMOpenSplat Environment Configuration
# Generated on $(date)

# Paths
PROJECT_ROOT=$PROJECT_ROOT
LIBTORCH_DIR=$LIBTORCH_DIR
BUILD_DIR=$BUILD_DIR
COLMAP_BUILD_DIR=$COLMAP_BUILD_DIR

# CUDA Configuration
CUDA_VERSION=$CUDA_VERSION

# Server Configuration
FRONTEND_PORT=$FRONTEND_PORT
BACKEND_PORT=$BACKEND_PORT

# Performance
NUM_CORES=$NUM_CORES
EOF
    
    print_success "Environment configuration saved: $ENV_FILE"
    echo ""
}

# =============================================================================
# Final Summary
# =============================================================================

print_summary() {
    print_header "Installation Complete!"
    
    echo -e "${GREEN}${BOLD}✓ Installation successful!${NC}"
    echo ""
    echo -e "${CYAN}Installation Summary:${NC}"
    echo "  • OpenSplat: $BUILD_DIR/opensplat"
    
    if command -v colmap &> /dev/null; then
        COLMAP_PATH=$(which colmap)
        echo "  • COLMAP: $COLMAP_PATH"
        COLMAP_INFO=$(colmap -h 2>&1 | head -n 2 | grep "COLMAP" || echo "")
        if [[ "$COLMAP_INFO" =~ "with CUDA" ]]; then
            echo -e "    ${GREEN}(with CUDA support)${NC}"
        fi
    elif [ -f "$COLMAP_INSTALL_DIR/bin/colmap" ]; then
        echo "  • COLMAP: $COLMAP_INSTALL_DIR/bin/colmap"
    elif [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
        echo "  • COLMAP: $COLMAP_BUILD_DIR/src/colmap/exe/colmap"
    fi
    
    if [ -f "$COLMAP_BUILD_DIR/src/glomap/glomap" ]; then
        echo -e "  • GLOMAP: $COLMAP_BUILD_DIR/src/glomap/glomap ${GREEN}(legacy fallback built with COLMAP)${NC}"
    elif command -v glomap &> /dev/null; then
        GLOMAP_PATH=$(which glomap)
        echo -e "  • GLOMAP: $GLOMAP_PATH ${GREEN}(legacy fallback path)${NC}"
    fi
    
    if [ -d "$PROJECT_ROOT/hloc" ]; then
        echo -e "  • hloc: $PROJECT_ROOT/hloc ${GREEN}(SuperPoint/LightGlue neural matching)${NC}"
    fi
    
    if [ -d "$PROJECT_ROOT/fastmap" ]; then
        echo -e "  • FastMap: $PROJECT_ROOT/fastmap ${GREEN}(fast first-order SfM)${NC}"
    fi
    
    echo "  • LibTorch: $LIBTORCH_DIR"
    
    if [ -n "$CUDA_VERSION" ]; then
        echo "  • CUDA: Version $CUDA_VERSION"
    fi
    
    echo "  • Frontend: $FRONTEND_DIR"
    echo "  • Backend: $BACKEND_DIR"
    if check_pycolmap_ready; then
        PYCOLMAP_VERSION=$("$BACKEND_DIR/venv/bin/python" -c "import pycolmap; print(pycolmap.__version__)" 2>/dev/null || echo "unknown")
        echo -e "  • pycolmap: $PYCOLMAP_VERSION ${GREEN}(experimental global_mapping ready)${NC}"
    else
        echo -e "  • pycolmap: ${YELLOW}not ready${NC} (CLI global mapper remains the default path)"
    fi
    echo ""
    echo -e "${CYAN}SfM Engine Options:${NC}"
    echo "  • COLMAP Global Mapper: Preferred global SfM path"
    echo "  • pycolmap: Experimental Python-native global mapping backend"
    echo "  • Standalone GLOMAP: Legacy fallback only"
    echo "  • Select engine/backend in the Frontend upload page"
    echo ""
    echo -e "${CYAN}Feature Matching Options:${NC}"
    echo "  • SIFT: Classic feature matching (default, fast)"
    echo "  • SuperPoint + LightGlue: Neural matching via hloc (higher quality)"
    echo "  • Select in Frontend upload page under 'Feature Method'"
    echo ""
    echo -e "${CYAN}Quick Start Commands:${NC}"
    echo ""
    echo -e "  ${BOLD}To start the server:${NC}"
    echo -e "    ${GREEN}./quick-start.sh${NC}"
    echo ""
    echo -e "  ${BOLD}Or manually:${NC}"
    echo -e "    ${GREEN}cd PobimSplatting && ./start.sh start${NC}"
    echo ""
    echo -e "  ${BOLD}To rebuild COLMAP with CUDA:${NC}"
    echo -e "    ${GREEN}./scripts/rebuild-colmap-with-cuda.sh${NC}"
    echo ""
    echo -e "${CYAN}Access Points:${NC}"
    echo "  • Frontend: ${BOLD}http://localhost:${FRONTEND_PORT}${NC}"
    echo "  • Backend API: ${BOLD}http://localhost:${BACKEND_PORT}${NC}"
    echo ""
    echo -e "${YELLOW}Installation log saved to: $LOG_FILE${NC}"
    echo ""
}

# =============================================================================
# Unified SfM Engines Build (COLMAP + GLOMAP in one step)
# =============================================================================

build_sfm_engines() {
    print_header "Building SfM Engines (COLMAP Global Mapper + Legacy GLOMAP)"
    
    echo -e "${CYAN}This will build COLMAP and prepare the legacy standalone glomap fallback with the same CUDA configuration:${NC}"
    echo ""
    echo "  • COLMAP: Feature extraction, matching, dense reconstruction, and preferred global_mapper path"
    echo "  • GLOMAP: Legacy standalone fallback only"
    echo "  • Both tools should share compatible COLMAP libraries"
    echo ""
    echo -e "${CYAN}Additional tools available after build:${NC}"
    echo "  • hloc: Neural feature matching (SuperPoint/LightGlue)"
    echo "  • FastMap: Fast first-order SfM optimization"
    echo ""
    
    if [ "$CUDA_ENABLED" = "ON" ]; then
        echo -e "${GREEN}CUDA Support: ENABLED${NC}"
        echo -e "  CUDA Path: $CUDA_HOME"
        echo -e "  GPU Architectures: $GPU_ARCHS"
    else
        echo -e "${YELLOW}CUDA Support: DISABLED (CPU-only builds)${NC}"
    fi
    echo ""
    
    # Ask for GUI support once
    echo -e "${CYAN}COLMAP GUI Support:${NC}"
    echo "  • With GUI: Can open COLMAP graphical interface (requires Qt5)"
    echo "  • Without GUI: Headless mode only, smaller binary, better for servers"
    echo ""
    
    COLMAP_GUI_ENABLED="OFF"
    if prompt_yes_no "Enable COLMAP GUI support?" "n"; then
        COLMAP_GUI_ENABLED="ON"
        print_info "GUI support enabled"
        
        # Check if Qt5 is installed
        if ! pkg-config --exists Qt5Widgets 2>/dev/null; then
            print_warning "Qt5 not detected. Installing Qt5 dependencies..."
            if [ "$EUID" -ne 0 ]; then
                SUDO="sudo"
            else
                SUDO=""
            fi
            if check_command apt-get; then
                run_apt_get install -y qtbase5-dev libqt5opengl5-dev 2>/dev/null || true
            fi
        fi
    else
        print_info "Building without GUI support (headless mode)"
    fi
    echo ""
    
    # Build COLMAP first
    print_header "Step 1/2: Building COLMAP"
    build_colmap_internal
    if [ $? -ne 0 ]; then
        print_error "COLMAP build failed - cannot continue with global SfM setup"
        return 1
    fi
    
    # Build GLOMAP (depends on COLMAP)
    print_header "Step 2/2: Setting up legacy GLOMAP fallback"
    build_glomap_internal
    if [ $? -ne 0 ]; then
        print_warning "GLOMAP setup failed - COLMAP is still available"
        print_info "You can use COLMAP for all SfM operations"
    fi
    
    # Summary
    echo ""
    print_success "SfM engines build complete!"
    echo ""
    echo -e "${CYAN}Build Summary:${NC}"
    
    if [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
        echo -e "  ${GREEN}✓${NC} COLMAP: $COLMAP_INSTALL_DIR/bin/colmap"
    elif command -v colmap &> /dev/null; then
        echo -e "  ${GREEN}✓${NC} COLMAP: $(which colmap)"
    else
        echo -e "  ${RED}✗${NC} COLMAP: Not found"
    fi
    
    # GLOMAP is now part of COLMAP build
    if [ -f "$COLMAP_BUILD_DIR/src/glomap/glomap" ]; then
        echo -e "  ${GREEN}✓${NC} GLOMAP: $COLMAP_BUILD_DIR/src/glomap/glomap (legacy fallback)"
    elif command -v glomap &> /dev/null; then
        echo -e "  ${GREEN}✓${NC} GLOMAP: $(which glomap)"
    else
        echo -e "  ${YELLOW}⚠${NC} GLOMAP: Not available (using COLMAP mapper)"
    fi
    
    echo ""
}

# =============================================================================
# Main Installation Flow
# =============================================================================

main() {
    echo -e "${CYAN}Starting installation...${NC}"
    echo ""
    
    # Ask for Yes to all mode
    echo -e "${BOLD}${YELLOW}Quick Install Mode:${NC}"
    echo -e "  Choose 'Yes to all' to automatically accept all default options."
    echo -e "  This will install everything with recommended settings.\n"
    read -p "Enable 'Yes to all' mode? [y/N]: " yes_all_response
    if [[ "$yes_all_response" =~ ^[Yy]$ ]]; then
        YES_TO_ALL="true"
        print_success "Yes to all mode enabled - using default options"
        echo ""
    fi
    
    # Step 1: Check system
    check_system_requirements
    
    # Step 2: Install CUDA Toolkit if needed
    if check_command nvidia-smi && ! check_command nvcc; then
        print_info "NVIDIA GPU detected but CUDA Toolkit not installed"
        install_cuda_toolkit
    elif check_command nvcc; then
        print_success "CUDA Toolkit already available"
    fi
    
    # Step 3: Detect CUDA environment (once for all builds)
    detect_cuda_environment
    
    # Step 4: Install system dependencies
    if prompt_yes_no "Install system dependencies?" "y"; then
        install_system_dependencies
    fi
    
    # Step 5: Setup LibTorch
    setup_libtorch
    
    # Step 6: Build SfM Engines (COLMAP + GLOMAP together)
    if prompt_yes_no "Build SfM engines (COLMAP global mapper + legacy glomap fallback)?" "y"; then
        build_sfm_engines
    fi
    
    # Step 7: Build OpenSplat
    if prompt_yes_no "Build OpenSplat?" "y"; then
        build_opensplat
    fi
    
    # Step 8: Setup Python backend
    if [ -d "$BACKEND_DIR" ]; then
        if prompt_yes_no "Setup Python backend?" "y"; then
            setup_python_backend
        fi
    fi
    
    # Step 9: Setup hloc (neural feature matching)
    if [ -d "$PROJECT_ROOT/hloc" ]; then
        if prompt_yes_no "Setup hloc (neural feature matching with SuperPoint/LightGlue)?" "y"; then
            setup_hloc
        fi
    fi
    
    # Step 10: Setup FastMap (fast SfM)
    if [ -d "$PROJECT_ROOT/fastmap" ]; then
        if prompt_yes_no "Setup FastMap (fast first-order SfM optimization)?" "y"; then
            setup_fastmap
        fi
    fi
    
    # Step 11: Setup Node.js frontend
    if [ -d "$FRONTEND_DIR" ]; then
        if prompt_yes_no "Setup Node.js frontend?" "y"; then
            setup_nodejs_frontend
        fi
    fi
    
    # Step 12: Create quick start script
    create_quick_start_script
    
    # Step 13: Create environment config
    create_env_config
    
    # Step 14: Summary
    print_summary
    
    # Ask to start now
    if prompt_yes_no "Start the server now?" "y"; then
        exec bash "$PROJECT_ROOT/quick-start.sh"
    fi
}

# Run main installation
main
