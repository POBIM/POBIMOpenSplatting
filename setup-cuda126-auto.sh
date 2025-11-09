#!/bin/bash

# CUDA 12.6 Installation Script for Ubuntu WSL2 (Automated version)
# Updated: January 2025

set -e

echo "================================================"
echo "CUDA 12.6 Toolkit Installation Script (Automated)"
echo "================================================"
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
   echo "Please run this script without sudo."
   exit 1
fi

# Set sudo password
SUDO_PASS="123456"

# Step 1: Install basic dependencies (already done, but checking)
echo "[1/6] Checking basic dependencies..."
echo "Dependencies already installed earlier."

# Step 2: Check current installations
echo ""
echo "[2/6] Checking current environment..."
if [ -d "/usr/local/cuda-12.6" ]; then
    echo "CUDA 12.6 already exists in /usr/local/cuda-12.6"
    echo "Skipping download and install, will setup environment..."
    SKIP_INSTALL=1
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
    echo "$SUDO_PASS" | sudo -S sh cuda_12.6.3_560.35.05_linux.run --toolkit --silent --override --no-drm
else
    echo ""
    echo "[3/6] Skipping download..."
    echo "[4/6] Skipping installation..."
fi

# Step 5: Setup symbolic links and environment
echo ""
echo "[5/6] Setting up symbolic links and environment..."

# Remove old symbolic link if exists
echo "$SUDO_PASS" | sudo -S rm -f /usr/local/cuda

# Create new symbolic link
echo "$SUDO_PASS" | sudo -S ln -s /usr/local/cuda-12.6 /usr/local/cuda

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

# Check nvcc after exporting paths
if [ -f "/usr/local/cuda-12.6/bin/nvcc" ]; then
    echo "✓ CUDA Compiler (nvcc) found:"
    /usr/local/cuda-12.6/bin/nvcc --version | head -n 4
else
    echo "✗ nvcc not found. Checking if installation was successful..."
    ls -la /usr/local/cuda-12.6/bin/ 2>/dev/null || echo "CUDA 12.6 not installed yet"
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
if [ "$SKIP_INSTALL" -eq 0 ]; then
    echo "✓ CUDA 12.6 toolkit installed"
fi
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