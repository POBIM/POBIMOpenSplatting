#!/bin/bash

# CUDA 13.0 toolkit-only installer for Ubuntu on WSL2.
# Keeps existing CUDA installs, such as CUDA 12.6, available as fallbacks.

set -euo pipefail

CUDA_VERSION="13.0.2"
CUDA_DRIVER_TAG="580.95.05"
CUDA_DIR="/usr/local/cuda-13.0"
INSTALLER_NAME="cuda_${CUDA_VERSION}_${CUDA_DRIVER_TAG}_linux.run"
INSTALLER_URL="https://developer.download.nvidia.com/compute/cuda/${CUDA_VERSION}/local_installers/${INSTALLER_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CACHE_DIR="$PROJECT_ROOT/.cache/cuda"

echo "================================================"
echo "CUDA 13.0 WSL2 Toolkit Installer"
echo "================================================"
echo ""

if ! grep -qi microsoft /proc/version 2>/dev/null; then
    echo "Warning: this script is intended for WSL2, but /proc/version does not look like WSL."
fi

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "Error: nvidia-smi is not available. Install/update the NVIDIA Windows driver first."
    exit 1
fi

DRIVER_VERSION=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n1)
echo "Detected NVIDIA driver: $DRIVER_VERSION"
if ! printf '%s\n%s\n' "580.65.06" "$DRIVER_VERSION" | sort -V -C; then
    echo "Error: CUDA 13.0 requires NVIDIA driver >= 580.65.06."
    exit 1
fi

if [ -x "$CUDA_DIR/bin/nvcc" ]; then
    echo "CUDA 13.0 already installed at $CUDA_DIR"
    "$CUDA_DIR/bin/nvcc" --version | head -n 4
    exit 0
fi

mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"

if [ ! -f "$INSTALLER_NAME" ]; then
    echo "Downloading CUDA ${CUDA_VERSION} toolkit installer..."
    wget -O "$INSTALLER_NAME" "$INSTALLER_URL"
else
    echo "Using existing installer: $CACHE_DIR/$INSTALLER_NAME"
fi

echo "Installing CUDA ${CUDA_VERSION} toolkit only..."
echo "This intentionally does not install Linux NVIDIA driver packages inside WSL."
if sudo -n true 2>/dev/null; then
    sudo sh "$INSTALLER_NAME" --toolkit --silent --override --no-drm
elif [ -n "${CUDA_SUDO_PASSWORD:-}" ]; then
    printf '%s\n' "$CUDA_SUDO_PASSWORD" | sudo -S sh "$INSTALLER_NAME" --toolkit --silent --override --no-drm
elif [ -t 0 ]; then
    sudo sh "$INSTALLER_NAME" --toolkit --silent --override --no-drm
else
    echo "Error: sudo requires a password, but this session has no TTY."
    echo "Re-run with CUDA_SUDO_PASSWORD set, or run the installer manually in a terminal."
    exit 1
fi

if [ ! -x "$CUDA_DIR/bin/nvcc" ]; then
    echo "Error: expected nvcc at $CUDA_DIR/bin/nvcc after installation."
    exit 1
fi

echo ""
echo "CUDA 13.0 toolkit installed successfully:"
"$CUDA_DIR/bin/nvcc" --version | head -n 4
echo ""
echo "CUDA 12.x fallback remains untouched. Use CUDA 13.0 explicitly with:"
echo "  export CUDA_HOME=$CUDA_DIR"
echo "  export PATH=$CUDA_DIR/bin:\$PATH"
echo "  export LD_LIBRARY_PATH=$CUDA_DIR/lib64:\$LD_LIBRARY_PATH"
