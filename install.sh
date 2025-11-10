#!/bin/bash

# =============================================================================
# POBIMOpenSplat - Complete Installation Script
# =============================================================================
# This script will:
# 1. Check system requirements (GPU, CUDA, dependencies)
# 2. Install required packages
# 3. Download and setup LibTorch
# 4. Build COLMAP
# 5. Build OpenSplat
# 6. Setup Python environments
# 7. Setup Node.js frontend
# 8. Create quick-start script
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
        
        # Python
        python3
        python3-pip
        python3-dev
        python3-venv
        
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
    unzip -q "$LIBTORCH_ZIP"
    mv libtorch "$LIBTORCH_DIR"
    rm "$LIBTORCH_ZIP"
    
    print_success "LibTorch setup complete"
    echo ""
}

# =============================================================================
# Build COLMAP
# =============================================================================

build_colmap() {
    print_header "Building COLMAP"

    if [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ] || [ -f "$COLMAP_BUILD_DIR/colmap" ]; then
        print_success "COLMAP binary already exists"
        if prompt_yes_no "Rebuild COLMAP (recommended for clean build)?" "y"; then
            print_info "Cleaning previous build directory..."
            rm -rf "$COLMAP_BUILD_DIR"
            print_success "Previous build cleaned"
        else
            return 0
        fi
    fi
    
    # Auto-detect CUDA for COLMAP
    CUDA_HOME=""
    CUDA_PATHS=(
        "/usr/local/cuda"
        "/usr/local/cuda-12.6"
        "/usr/local/cuda-12.5"
        "/usr/local/cuda-12.4"
        "/usr/local/cuda-12.3"
        "/usr/local/cuda-12.1"
        "/opt/cuda"
    )
    
    for cuda_path in "${CUDA_PATHS[@]}"; do
        if [ -d "$cuda_path" ] && [ -f "$cuda_path/bin/nvcc" ]; then
            CUDA_HOME="$cuda_path"
            break
        fi
    done
    
    CUDA_ENABLED="OFF"
    GPU_ARCHS="70;75;80;86;89"  # Common architectures
    
    if [ -n "$CUDA_HOME" ]; then
        print_success "CUDA found at: $CUDA_HOME"
        if prompt_yes_no "Build COLMAP with CUDA support?" "y"; then
            CUDA_ENABLED="ON"
            export PATH="$CUDA_HOME/bin:$PATH"
            export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
            
            # Try to detect GPU architecture
            if command -v nvidia-smi &> /dev/null; then
                COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d '.')
                if [ ! -z "$COMPUTE_CAP" ]; then
                    print_info "Detected GPU compute capability: ${COMPUTE_CAP:0:1}.${COMPUTE_CAP:1}"
                    if [[ ! "$GPU_ARCHS" =~ "$COMPUTE_CAP" ]]; then
                        GPU_ARCHS="$GPU_ARCHS;$COMPUTE_CAP"
                    fi
                fi
            fi
            print_info "Building for GPU architectures: $GPU_ARCHS"
        fi
    else
        print_warning "CUDA not found - building CPU-only COLMAP"
    fi
    
    # Ask if user wants GUI support
    echo ""
    echo -e "${CYAN}COLMAP GUI Support:${NC}"
    echo "  • With GUI: Can open COLMAP graphical interface (requires Qt5)"
    echo "  • Without GUI: Headless mode only, smaller binary, better for servers"
    echo ""
    
    GUI_ENABLED="OFF"
    if prompt_yes_no "Enable COLMAP GUI support?" "y"; then
        GUI_ENABLED="ON"
        print_info "GUI support enabled - checking Qt5 dependencies..."
        
        # Check if Qt5 is installed
        if ! pkg-config --exists Qt5Widgets 2>/dev/null; then
            print_warning "Qt5 not detected. Installing Qt5 dependencies..."
            if [ "$PKG_MANAGER" = "apt-get" ]; then
                $SUDO $PKG_INSTALL qtbase5-dev libqt5opengl5-dev
            fi
        fi
    else
        print_info "Building COLMAP without GUI support (headless mode)"
    fi
    
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
# Build OpenSplat
# =============================================================================

build_opensplat() {
    print_header "Building OpenSplat"

    if [ -f "$BUILD_DIR/opensplat" ]; then
        print_success "OpenSplat binary already exists"
        if prompt_yes_no "Rebuild OpenSplat (recommended for clean build)?" "y"; then
            print_info "Cleaning previous build directory..."
            rm -rf "$BUILD_DIR"
            print_success "Previous build cleaned"
        else
            return 0
        fi
    fi
    
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"
    
    print_info "Configuring OpenSplat with CMake..."
    
    # Auto-detect CUDA
    CUDA_HOME=""
    CUDA_PATHS=(
        "/usr/local/cuda"
        "/usr/local/cuda-12.6"
        "/usr/local/cuda-12.5"
        "/usr/local/cuda-12.4"
        "/usr/local/cuda-12.3"
        "/usr/local/cuda-12.1"
        "/opt/cuda"
    )
    
    for cuda_path in "${CUDA_PATHS[@]}"; do
        if [ -d "$cuda_path" ] && [ -f "$cuda_path/bin/nvcc" ]; then
            CUDA_HOME="$cuda_path"
            break
        fi
    done
    
    # Setup CUDA environment if found
    if [ -n "$CUDA_HOME" ]; then
        export PATH="$CUDA_HOME/bin:$PATH"
        export LD_LIBRARY_PATH="$CUDA_HOME/lib64:$LD_LIBRARY_PATH"
        export CUDA_HOME
        print_info "Using CUDA: $CUDA_HOME"
        
        # Auto-detect GPU architecture
        GPU_ARCHS="70;75;80;86;89"
        if command -v nvidia-smi &> /dev/null; then
            COMPUTE_CAP=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d '.')
            if [ ! -z "$COMPUTE_CAP" ]; then
                print_info "Detected GPU compute capability: ${COMPUTE_CAP:0:1}.${COMPUTE_CAP:1}"
                if [[ ! "$GPU_ARCHS" =~ "$COMPUTE_CAP" ]]; then
                    GPU_ARCHS="$GPU_ARCHS;$COMPUTE_CAP"
                fi
            fi
        fi
        
        # Configure with CUDA
        cmake .. \
            -DCMAKE_BUILD_TYPE=Release \
            -DCMAKE_PREFIX_PATH="$LIBTORCH_DIR" \
            -DCMAKE_CUDA_COMPILER="$CUDA_HOME/bin/nvcc" \
            -DCMAKE_CUDA_ARCHITECTURES="$GPU_ARCHS" \
            -DOPENSPLAT_BUILD_SIMPLE_TRAINER=ON
    else
        print_warning "CUDA not found - building CPU-only version"
        
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
    
    cd "$BACKEND_DIR"
    
    # Create virtual environment
    if [ ! -d "venv" ]; then
        print_info "Creating Python virtual environment with Python 3.12..."
        python3.12 -m venv venv
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
            echo "    ${GREEN}(with CUDA support)${NC}"
        fi
    elif [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
        echo "  • COLMAP: $COLMAP_BUILD_DIR/src/colmap/exe/colmap"
    fi
    
    echo "  • LibTorch: $LIBTORCH_DIR"
    
    # Show CUDA info if available
    if [ -n "$CUDA_VERSION" ]; then
        echo "  • CUDA: Version $CUDA_VERSION"
    fi
    
    echo "  • Frontend: $FRONTEND_DIR"
    echo "  • Backend: $BACKEND_DIR"
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
# Main Installation Flow
# =============================================================================

main() {
    echo -e "${CYAN}Starting installation...${NC}"
    echo ""
    
    # Step 1: Check system
    check_system_requirements
    
    # Step 2: Install system dependencies
    if prompt_yes_no "Install system dependencies?" "y"; then
        install_system_dependencies
    fi
    
    # Step 3: Setup LibTorch
    setup_libtorch
    
    # Step 4: Build COLMAP
    if prompt_yes_no "Build COLMAP?" "y"; then
        build_colmap
    fi
    
    # Step 5: Build OpenSplat
    if prompt_yes_no "Build OpenSplat?" "y"; then
        build_opensplat
    fi
    
    # Step 6: Setup Python backend
    if [ -d "$BACKEND_DIR" ]; then
        if prompt_yes_no "Setup Python backend?" "y"; then
            setup_python_backend
        fi
    fi
    
    # Step 7: Setup Node.js frontend
    if [ -d "$FRONTEND_DIR" ]; then
        if prompt_yes_no "Setup Node.js frontend?" "y"; then
            setup_nodejs_frontend
        fi
    fi
    
    # Step 8: Create quick start script
    create_quick_start_script
    
    # Step 9: Create environment config
    create_env_config
    
    # Step 10: Summary
    print_summary
    
    # Ask to start now
    if prompt_yes_no "Start the server now?" "y"; then
        exec bash "$PROJECT_ROOT/quick-start.sh"
    fi
}

# Run main installation
main
