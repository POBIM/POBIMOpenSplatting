#!/bin/bash

# CUDA 12.6 Installation Script for Ubuntu WSL2
# Updated: January 2025

set -e

echo "================================================"
echo "CUDA 12.6 Toolkit Installation Script"
echo "================================================"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
   echo "Please run this script without sudo. It will ask for sudo when needed."
   exit 1
fi

# Step 1: Install basic dependencies
echo "[1/6] Installing basic dependencies..."
sudo apt-get update
sudo apt-get install -y \
    build-essential \
    dkms \
    wget \
    gcc-12 \
    g++-12 \
    libopencv-dev

# Step 2: Check current installations
echo ""
echo "[2/6] Checking current environment..."
if [ -d "/usr/local/cuda-12.6" ]; then
    echo "CUDA 12.6 already exists in /usr/local/cuda-12.6"
    read -p "Do you want to reinstall? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping CUDA installation, setting up environment only..."
        SKIP_INSTALL=1
    else
        sudo rm -rf /usr/local/cuda-12.6
        SKIP_INSTALL=0
    fi
else
    SKIP_INSTALL=0
fi

# Step 3: Download CUDA 12.6 if needed
if [ "$SKIP_INSTALL" -eq 0 ]; then
    echo ""
    echo "[3/6] Downloading CUDA 12.6 toolkit..."
    echo "This will take 5-10 minutes depending on your internet connection..."

    if [ ! -f "cuda_12.6.3_560.35.05_linux.run" ]; then
        wget https://developer.download.nvidia.com/compute/cuda/12.6.3/local_installers/cuda_12.6.3_560.35.05_linux.run
    else
        echo "CUDA installer already downloaded, using existing file..."
    fi

    # Step 4: Install CUDA Toolkit (without driver)
    echo ""
    echo "[4/6] Installing CUDA 12.6 toolkit (without driver)..."
    echo "This will take 5-10 minutes..."
    sudo sh cuda_12.6.3_560.35.05_linux.run --toolkit --silent --override --no-drm
else
    echo ""
    echo "[3/6] Skipping download..."
    echo "[4/6] Skipping installation..."
fi

# Step 5: Setup symbolic links and environment
echo ""
echo "[5/6] Setting up symbolic links and environment..."

# Remove old symbolic link if exists
sudo rm -f /usr/local/cuda

# Create new symbolic link
sudo ln -s /usr/local/cuda-12.6 /usr/local/cuda

# Setup environment variables
echo ""
echo "[6/6] Configuring environment variables..."

# Check if already in bashrc
if ! grep -q "CUDA-12.6" ~/.bashrc; then
    echo "" >> ~/.bashrc
    echo "# CUDA-12.6 Configuration" >> ~/.bashrc
    echo 'export PATH=/usr/local/cuda-12.6/bin:$PATH' >> ~/.bashrc
    echo 'export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH' >> ~/.bashrc
    echo 'export CUDA_HOME=/usr/local/cuda-12.6' >> ~/.bashrc
    echo "Environment variables added to ~/.bashrc"
else
    echo "Environment variables already configured in ~/.bashrc"
fi

# Export for current session
export PATH=/usr/local/cuda-12.6/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda-12.6/lib64:$LD_LIBRARY_PATH
export CUDA_HOME=/usr/local/cuda-12.6

# Verification
echo ""
echo "================================================"
echo "Installation Complete! Verifying..."
echo "================================================"
echo ""

# Check nvcc
if command -v nvcc &> /dev/null; then
    echo "✓ CUDA Compiler (nvcc) found:"
    nvcc --version | head -n 4
else
    echo "✗ nvcc not found. Please run: source ~/.bashrc"
fi

echo ""
echo "✓ GCC version:"
gcc --version | head -n 1

echo ""
echo "✓ OpenCV version:"
pkg-config --modversion opencv4 || echo "OpenCV not found"

echo ""
echo "================================================"
echo "Installation Summary:"
echo "================================================"
echo "✓ CUDA 12.6 toolkit installed"
echo "✓ Symbolic links created"
echo "✓ Environment variables configured"
echo ""
echo "IMPORTANT: Run the following command to activate the environment:"
echo "  source ~/.bashrc"
echo ""
echo "Next steps:"
echo "  1. source ~/.bashrc"
echo "  2. ./compile-opensplat-cuda126.sh"
echo ""
echo "To verify installation after sourcing:"
echo "  nvcc --version"
echo "================================================"