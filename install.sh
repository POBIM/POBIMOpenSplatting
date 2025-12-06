#!/bin/bash

# =============================================================================
# POBIMOpenSplat - Complete Installation Script
# =============================================================================
# This script will:
# 1. Check system requirements (GPU, CUDA, dependencies)
# 2. Install CUDA Toolkit automatically if needed
# 3. Install required system packages
# 4. Download and setup LibTorch
# 5. Build COLMAP with CUDA support
# 6. Build GLOMAP (10-100x faster sparse reconstruction)
# 7. Build OpenSplat
# 8. Setup Python environments
# 9. Setup Node.js frontend
# 10. Create quick-start script
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
POBIM_SPLATTING_DIR="$PROJECT_ROOT/PobimSplatting"
FRONTEND_DIR="$POBIM_SPLATTING_DIR/Frontend"
BACKEND_DIR="$POBIM_SPLATTING_DIR/Backend"

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

# Yes to all mode (skip all prompts)
YES_TO_ALL="false"

# Log file
LOG_FILE="$PROJECT_ROOT/install.log"
exec > >(tee -a "$LOG_FILE")
exec 2>&1

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   POBIMOpenSplat - Automated Installation System"
echo "============================================================================="
echo -e "${NC}"
echo -e "${CYAN}Installation log: $LOG_FILE${NC}"
echo ""

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
                print_info "GPU compute capability: ${GPU_COMPUTE_CAP:0:1}.${GPU_COMPUTE_CAP:1}"
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
            print_info "GPU compute capability: ${COMPUTE_CAP:0:1}.${COMPUTE_CAP:1}"
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
        $SUDO dpkg -i /tmp/cuda-keyring.deb
        rm -f /tmp/cuda-keyring.deb
        
        print_info "Updating package lists..."
        $SUDO apt-get update -qq
        
        print_info "Installing CUDA Toolkit 12.6 (this will take several minutes)..."
        print_warning "Download size: ~3GB, Install size: ~6.7GB"
        echo ""
        
        $SUDO apt-get install -y cuda-toolkit-12-6
        
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
        PKG_UPDATE="apt-get update"
        PKG_INSTALL="apt-get install -y"
    elif check_command dnf; then
        PKG_MANAGER="dnf"
        PKG_UPDATE="dnf check-update"
        PKG_INSTALL="dnf install -y"
    elif check_command yum; then
        PKG_MANAGER="yum"
        PKG_UPDATE="yum check-update"
        PKG_INSTALL="yum install -y"
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
    $SUDO $PKG_UPDATE || true
    
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
        libsqlite3-dev
        libglew-dev
        qtbase5-dev
        libqt5opengl5-dev
        libcgal-dev
        libceres-dev
        libopenimageio-dev
        openimageio-tools

        # OpenCV
        libopencv-dev

        # Additional utilities
        lsof
        psmisc
        htop
    )
    
    print_info "Installing required packages..."
    for package in "${PACKAGES[@]}"; do
        if $SUDO $PKG_INSTALL "$package" 2>/dev/null; then
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
        $SUDO $PKG_INSTALL nodejs
        print_success "Node.js installed"
    else
        NODE_VERSION=$(node --version)
        print_success "Node.js already installed: $NODE_VERSION"
    fi
    
    # Install npm if not present
    if ! check_command npm; then
        $SUDO $PKG_INSTALL npm
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
        if $SUDO apt-get install -y unzip 2>/dev/null; then
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
    print_info "Building COLMAP..."

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
    GUI_ENABLED="$COLMAP_GUI_ENABLED"
    
    # Check if COLMAP source exists
    if [ ! -d "$PROJECT_ROOT/colmap" ]; then
        print_info "Cloning COLMAP repository..."
        git clone https://github.com/colmap/colmap.git "$PROJECT_ROOT/colmap"
    fi
    
    mkdir -p "$COLMAP_BUILD_DIR"
    cd "$COLMAP_BUILD_DIR"
    
    print_info "Configuring COLMAP with CMake (CUDA: $CUDA_ENABLED, GUI: $GUI_ENABLED)..."
    
    # Build CMake command
    CMAKE_ARGS=(
        "$PROJECT_ROOT/colmap"
        "-DCMAKE_BUILD_TYPE=Release"
        "-DGUI_ENABLED=$GUI_ENABLED"
    )
    
    if [ "$CUDA_ENABLED" = "ON" ]; then
        CMAKE_ARGS+=(
            "-DCMAKE_CUDA_ARCHITECTURES=$GPU_ARCHS"
            "-DCMAKE_CUDA_COMPILER=$CUDA_HOME/bin/nvcc"
            "-DCUDA_TOOLKIT_ROOT_DIR=$CUDA_HOME"
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
    
    # Find and setup COLMAP binary
    COLMAP_BIN=""
    if [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
        COLMAP_BIN="$COLMAP_BUILD_DIR/src/colmap/exe/colmap"
    elif [ -f "$COLMAP_BUILD_DIR/src/exe/colmap" ]; then
        COLMAP_BIN="$COLMAP_BUILD_DIR/src/exe/colmap"
    fi
    
    if [ -n "$COLMAP_BIN" ]; then
        print_success "COLMAP build complete"
        
        # Create symlink for easy access
        if [ "$EUID" -eq 0 ] || sudo -n true 2>/dev/null; then
            print_info "Creating system-wide symlink..."
            sudo ln -sf "$COLMAP_BIN" /usr/local/bin/colmap 2>/dev/null && \
                print_success "Symlink created: /usr/local/bin/colmap" || \
                print_warning "Could not create symlink (not critical)"
        fi
        
        # Test COLMAP
        if $COLMAP_BIN -h 2>&1 | grep -q "COLMAP"; then
            print_success "COLMAP binary working correctly"
            
            # Check CUDA support
            if $COLMAP_BIN -h 2>&1 | grep -q "with CUDA"; then
                print_success "COLMAP built with CUDA support!"
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
        CURRENT_MAJOR=$(echo "$CURRENT_CMAKE_VERSION" | cut -d'.' -f1)
        CURRENT_MINOR=$(echo "$CURRENT_CMAKE_VERSION" | cut -d'.' -f2)
        
        REQUIRED_MAJOR=$(echo "$REQUIRED_CMAKE_VERSION" | cut -d'.' -f1)
        REQUIRED_MINOR=$(echo "$REQUIRED_CMAKE_VERSION" | cut -d'.' -f2)
        
        # Compare versions
        if [ "$CURRENT_MAJOR" -gt "$REQUIRED_MAJOR" ] || \
           ([ "$CURRENT_MAJOR" -eq "$REQUIRED_MAJOR" ] && [ "$CURRENT_MINOR" -ge "$REQUIRED_MINOR" ]); then
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
        
        # Install prerequisites
        $SUDO apt-get update -qq
        $SUDO apt-get install -y ca-certificates gpg wget
        
        # Download and add Kitware's GPG key
        wget -O - https://apt.kitware.com/keys/kitware-archive-latest.asc 2>/dev/null | gpg --dearmor - | $SUDO tee /usr/share/keyrings/kitware-archive-keyring.gpg >/dev/null
        
        # Add Kitware repository (Ubuntu 22.04)
        if [ -f /etc/os-release ]; then
            . /etc/os-release
            UBUNTU_CODENAME="${UBUNTU_CODENAME:-jammy}"
        else
            UBUNTU_CODENAME="jammy"
        fi
        
        echo "deb [signed-by=/usr/share/keyrings/kitware-archive-keyring.gpg] https://apt.kitware.com/ubuntu/ $UBUNTU_CODENAME main" | $SUDO tee /etc/apt/sources.list.d/kitware.list >/dev/null
        
        # Update and install CMake
        $SUDO apt-get update -qq
        $SUDO apt-get install -y cmake
        
        # Verify installation
        if check_command cmake; then
            NEW_CMAKE_VERSION=$(cmake --version | head -n1 | grep -oP '\d+\.\d+\.\d+' | head -1)
            print_success "CMake upgraded to $NEW_CMAKE_VERSION"
            
            # Update PATH hash
            hash -r
            return 0
        else
            print_error "CMake installation via APT failed"
        fi
    fi
    
    # Fallback: Install from pre-built binary
    print_info "Installing CMake from pre-built binary..."
    
    CMAKE_VERSION="3.30.5"
    CMAKE_ARCH="x86_64"
    CMAKE_INSTALL_DIR="/opt/cmake-${CMAKE_VERSION}"
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
    
    # Create symlinks
    $SUDO ln -sf "$CMAKE_INSTALL_DIR/bin/cmake" /usr/local/bin/cmake
    $SUDO ln -sf "$CMAKE_INSTALL_DIR/bin/ctest" /usr/local/bin/ctest
    $SUDO ln -sf "$CMAKE_INSTALL_DIR/bin/cpack" /usr/local/bin/cpack
    
    # Update PATH hash
    hash -r
    
    # Verify
    if check_command cmake; then
        NEW_CMAKE_VERSION=$(cmake --version | head -n1 | grep -oP '\d+\.\d+\.\d+' | head -1)
        print_success "CMake $NEW_CMAKE_VERSION installed successfully"
        return 0
    else
        print_error "CMake installation failed"
        return 1
    fi
}

# =============================================================================
# Setup GLOMAP (included with COLMAP 3.14+)
# =============================================================================

build_glomap_internal() {
    print_info "Setting up GLOMAP (included with COLMAP 3.14+)..."
    
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
            print_success "GLOMAP is ready to use!"
            print_info "GLOMAP provides 10-100x faster sparse reconstruction than COLMAP mapper"
            print_info "NOTE: GLOMAP is built with COLMAP to ensure database compatibility"
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
        
        if [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -ge 10 ]; then
            PYTHON_CMD="python3"
            print_warning "Python 3.12 not found, using Python $PYTHON_VERSION"
        else
            print_error "Python 3.10+ required, found Python $PYTHON_VERSION"
        fi
    fi
    
    # Install Python 3.12 if not found and user wants it
    if [ -z "$PYTHON_CMD" ] || [ "$PYTHON_CMD" != "python3.12" ]; then
        echo ""
        print_info "Python 3.12 is recommended for best compatibility"
        
        if prompt_yes_no "Install Python 3.12?" "y"; then
            print_info "Installing Python 3.12..."
            
            if check_command apt-get; then
                # Add deadsnakes PPA for Python 3.12
                $SUDO apt-get update -qq
                $SUDO apt-get install -y software-properties-common
                $SUDO add-apt-repository -y ppa:deadsnakes/ppa
                $SUDO apt-get update -qq
                $SUDO apt-get install -y python3.12 python3.12-venv python3.12-dev
                
                if command -v python3.12 &> /dev/null; then
                    PYTHON_CMD="python3.12"
                    print_success "Python 3.12 installed successfully"
                else
                    print_error "Failed to install Python 3.12"
                    if [ -n "$PYTHON_CMD" ]; then
                        print_warning "Will continue with $PYTHON_CMD"
                    else
                        return 1
                    fi
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
                print_error "Cannot continue without Python 3.10+"
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
        print_info "Installing Python dependencies..."
        pip install -r requirements.txt --quiet
        print_success "Python dependencies installed"
    else
        print_warning "requirements.txt not found"
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
        
        # Build Next.js production files (optional)
        if prompt_yes_no "Build Next.js production bundle?" "n"; then
            print_info "Building Next.js production bundle..."
            npm run build
            print_success "Production build complete"
        fi
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
    
    # COLMAP location
    if command -v colmap &> /dev/null; then
        COLMAP_PATH=$(which colmap)
        echo "  • COLMAP: $COLMAP_PATH"
        COLMAP_INFO=$(colmap -h 2>&1 | head -n 2 | grep "COLMAP" || echo "")
        if [[ "$COLMAP_INFO" =~ "with CUDA" ]]; then
            echo -e "    ${GREEN}(with CUDA support)${NC}"
        fi
    elif [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
        echo "  • COLMAP: $COLMAP_BUILD_DIR/src/colmap/exe/colmap"
    fi
    
    # GLOMAP location (now part of COLMAP build)
    if [ -f "$COLMAP_BUILD_DIR/src/glomap/glomap" ]; then
        echo -e "  • GLOMAP: $COLMAP_BUILD_DIR/src/glomap/glomap ${GREEN}(built with COLMAP)${NC}"
    elif command -v glomap &> /dev/null; then
        GLOMAP_PATH=$(which glomap)
        echo -e "  • GLOMAP: $GLOMAP_PATH ${GREEN}(10-100x faster sparse reconstruction)${NC}"
    fi
    
    echo "  • LibTorch: $LIBTORCH_DIR"
    
    # Show CUDA info if available
    if [ -n "$CUDA_VERSION" ]; then
        echo "  • CUDA: Version $CUDA_VERSION"
    fi
    
    echo "  • Frontend: $FRONTEND_DIR"
    echo "  • Backend: $BACKEND_DIR"
    echo ""
    echo -e "${CYAN}SfM Engine Options:${NC}"
    echo "  • GLOMAP: Recommended for faster processing (10-100x faster mapper)"
    echo "  • COLMAP: Classic option, more stable but slower"
    echo "  • Select engine in Frontend upload page"
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
    echo -e "    ${GREEN}./rebuild-colmap-with-cuda.sh${NC}"
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
    print_header "Building SfM Engines (COLMAP + GLOMAP)"
    
    echo -e "${CYAN}This will build both COLMAP and GLOMAP with the same CUDA configuration:${NC}"
    echo ""
    echo "  • COLMAP: Feature extraction, matching, dense reconstruction"
    echo "  • GLOMAP: Fast global mapper (10-100x faster than COLMAP mapper)"
    echo "  • Both tools share COLMAP libraries for consistency"
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
                $SUDO apt-get install -y qtbase5-dev libqt5opengl5-dev 2>/dev/null || true
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
        print_error "COLMAP build failed - cannot continue with GLOMAP"
        return 1
    fi
    
    # Build GLOMAP (depends on COLMAP)
    print_header "Step 2/2: Setting up GLOMAP"
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
        echo -e "  ${GREEN}✓${NC} COLMAP: $COLMAP_BUILD_DIR/src/colmap/exe/colmap"
    elif command -v colmap &> /dev/null; then
        echo -e "  ${GREEN}✓${NC} COLMAP: $(which colmap)"
    else
        echo -e "  ${RED}✗${NC} COLMAP: Not found"
    fi
    
    # GLOMAP is now part of COLMAP build
    if [ -f "$COLMAP_BUILD_DIR/src/glomap/glomap" ]; then
        echo -e "  ${GREEN}✓${NC} GLOMAP: $COLMAP_BUILD_DIR/src/glomap/glomap (built with COLMAP)"
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
    if prompt_yes_no "Build SfM engines (COLMAP + GLOMAP)?" "y"; then
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
    
    # Step 9: Setup Node.js frontend
    if [ -d "$FRONTEND_DIR" ]; then
        if prompt_yes_no "Setup Node.js frontend?" "y"; then
            setup_nodejs_frontend
        fi
    fi
    
    # Step 10: Create quick start script
    create_quick_start_script
    
    # Step 11: Create environment config
    create_env_config
    
    # Step 12: Summary
    print_summary
    
    # Ask to start now
    if prompt_yes_no "Start the server now?" "y"; then
        exec bash "$PROJECT_ROOT/quick-start.sh"
    fi
}

# Run main installation
main
