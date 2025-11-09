#!/bin/bash

# =============================================================================
# Rebuild COLMAP with GUI Support
# =============================================================================
# Use this script if you need COLMAP GUI (e.g., for manual point cloud editing)
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
echo "   Rebuild COLMAP with GUI Support"
echo "============================================================================="
echo -e "${NC}"
echo ""

# Check if we need sudo
if [ "$EUID" -ne 0 ]; then
    SUDO="sudo"
else
    SUDO=""
fi

# Detect package manager
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt-get"
    PKG_INSTALL="apt-get install -y"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
    PKG_INSTALL="dnf install -y"
elif command -v yum &>/dev/null; then
    PKG_MANAGER="yum"
    PKG_INSTALL="yum install -y"
else
    echo -e "${RED}No supported package manager found${NC}"
    exit 1
fi

echo -e "${CYAN}This script will:${NC}"
echo "  1. Install Qt5 dependencies (if needed)"
echo "  2. Rebuild COLMAP with GUI enabled"
echo "  3. Replace the existing COLMAP binary"
echo ""
echo -e "${YELLOW}Warning: This will take 10-20 minutes${NC}"
echo ""

read -p "Continue? [y/N]: " response
if [[ ! "$response" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 0
fi

# Install Qt5 dependencies
echo ""
echo -e "${BLUE}=== Installing Qt5 Dependencies ===${NC}"
echo ""

if [ "$PKG_MANAGER" = "apt-get" ]; then
    QT_PACKAGES=(
        qtbase5-dev
        libqt5opengl5-dev
        libglew-dev
    )
    
    for package in "${QT_PACKAGES[@]}"; do
        echo -e "${CYAN}Installing $package...${NC}"
        $SUDO $PKG_INSTALL "$package"
    done
fi

echo -e "${GREEN}✓ Qt5 dependencies installed${NC}"

# Rebuild COLMAP
echo ""
echo -e "${BLUE}=== Rebuilding COLMAP ===${NC}"
echo ""

if [ ! -d "$PROJECT_ROOT/colmap" ]; then
    echo -e "${RED}COLMAP source not found at $PROJECT_ROOT/colmap${NC}"
    echo "Please run ./install.sh first to download COLMAP source"
    exit 1
fi

# Backup existing binary
if [ -f "$COLMAP_BUILD_DIR/colmap" ]; then
    echo -e "${YELLOW}Backing up existing COLMAP binary...${NC}"
    cp "$COLMAP_BUILD_DIR/colmap" "$COLMAP_BUILD_DIR/colmap.backup.no-gui"
    echo -e "${GREEN}✓ Backup saved: $COLMAP_BUILD_DIR/colmap.backup.no-gui${NC}"
fi

# Clean build directory
echo -e "${CYAN}Cleaning build directory...${NC}"
rm -rf "$COLMAP_BUILD_DIR"
mkdir -p "$COLMAP_BUILD_DIR"
cd "$COLMAP_BUILD_DIR"

# Configure with GUI enabled
echo -e "${CYAN}Configuring COLMAP with GUI support...${NC}"

# Set CUDA architectures
CUDA_ARCHITECTURES="75;80;86;89;90"

cmake ../colmap \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_CUDA_ARCHITECTURES="$CUDA_ARCHITECTURES" \
    -DGUI_ENABLED=ON

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ CMake configuration failed${NC}"
    echo "This usually means Qt5 or other dependencies are missing"
    exit 1
fi

echo -e "${GREEN}✓ CMake configuration complete${NC}"

# Build
echo -e "${CYAN}Building COLMAP (using $NUM_CORES cores)...${NC}"
echo "This will take 10-20 minutes..."
echo ""

make -j"$NUM_CORES"

if [ $? -ne 0 ]; then
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi

# Copy binary
if [ -f "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" ]; then
    cp "$COLMAP_BUILD_DIR/src/colmap/exe/colmap" "$COLMAP_BUILD_DIR/colmap"
elif [ -f "$COLMAP_BUILD_DIR/src/exe/colmap" ]; then
    cp "$COLMAP_BUILD_DIR/src/exe/colmap" "$COLMAP_BUILD_DIR/colmap"
else
    echo -e "${RED}✗ COLMAP binary not found after build${NC}"
    exit 1
fi

echo -e "${GREEN}✓ COLMAP build complete${NC}"

# Test GUI support
echo ""
echo -e "${CYAN}Testing GUI support...${NC}"

if ./colmap gui --help &>/dev/null; then
    echo -e "${GREEN}✓ COLMAP GUI support verified!${NC}"
else
    echo -e "${YELLOW}⚠ Warning: 'colmap gui' command returned an error${NC}"
    echo "This might be normal if Qt display is not available in terminal"
fi

# Show binary info
echo ""
echo -e "${BLUE}=== Installation Complete ===${NC}"
echo ""
echo -e "${GREEN}COLMAP binary with GUI support:${NC}"
echo "  Location: $COLMAP_BUILD_DIR/colmap"
echo "  Backup (no-GUI): $COLMAP_BUILD_DIR/colmap.backup.no-gui"
echo ""
echo -e "${CYAN}Usage:${NC}"
echo ""
echo "  # GUI mode"
echo "  $COLMAP_BUILD_DIR/colmap gui"
echo ""
echo "  # Or with project"
echo "  $COLMAP_BUILD_DIR/colmap gui \\"
echo "    --database_path /path/to/database.db \\"
echo "    --image_path /path/to/images"
echo ""
echo "  # Command line (same as before)"
echo "  $COLMAP_BUILD_DIR/colmap feature_extractor ..."
echo ""
echo -e "${YELLOW}Note:${NC}"
echo "  If you get 'cannot open display' error, make sure:"
echo "  1. You're running from a desktop environment (not SSH without X11)"
echo "  2. DISPLAY environment variable is set"
echo "  3. Or use 'xvfb-run colmap gui' for virtual display"
echo ""
