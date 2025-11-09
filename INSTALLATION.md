# POBIMOpenSplat Installation Guide

## 📋 System Requirements

### Hardware Requirements
- ✅ **GPU**: NVIDIA GPU with CUDA support (RTX 3060 or better recommended)
- ✅ **RAM**: 16GB+ (32GB recommended)
- ✅ **Storage**: 50GB+ free space
- ✅ **CPU**: 4+ cores

### Software Prerequisites
- ✅ **OS**: Ubuntu 20.04/22.04 or Debian-based Linux
- ✅ **NVIDIA Driver**: Latest version
- ✅ **CUDA Toolkit**: 11.8, 12.1, or 12.6 (must be installed before running script)

---

## 🚀 Automated Installation (Recommended)

### Step 1: Install CUDA (if not already installed)

```bash
# Check if CUDA is available
nvidia-smi

# If not installed, download and install CUDA 12.6 (recommended)
wget https://developer.download.nvidia.com/compute/cuda/12.6.0/local_installers/cuda_12.6.0_560.28.03_linux.run
sudo sh cuda_12.6.0_560.28.03_linux.run
```

### Step 2: Clone Repository

```bash
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
```

### Step 3: Run Installation Script

```bash
# Make script executable
chmod +x install.sh

# Run installation (takes approximately 30-60 minutes)
./install.sh
```

The script will:
1. ✅ Check GPU, CUDA, RAM, and disk space
2. ✅ Install all dependencies (build tools, Python, Node.js, libraries)
3. ✅ Download and setup LibTorch compatible with your CUDA version
4. ✅ Compile COLMAP
5. ✅ Compile OpenSplat
6. ✅ Install Python backend dependencies
7. ✅ Install Node.js frontend dependencies
8. ✅ Create quick-start script for future use

**Note**: The script will prompt you with questions. Answer with `y` (yes) or `n` (no).

---

## 🎯 How to Use

### First Time After Installation

```bash
# Start immediately after installation
./quick-start.sh
```

### Subsequent Uses

```bash
# Method 1: Use quick-start script
./quick-start.sh

# Method 2: Use PobimSplatting start script
cd PobimSplatting
./start.sh start

# Method 3: Interactive menu
cd PobimSplatting
./start.sh
```

---

## 🌐 Access the System

After the server starts, you can access:

- **Frontend (Main Web Interface)**: http://localhost:3000
- **Backend API**: http://localhost:5000

---

## 🔧 Troubleshooting

### Issue: Port Already in Use

```bash
# Clear stuck ports
cd PobimSplatting
./start.sh

# Select option 8) Force clear default ports
```

### Issue: CUDA Not Found

```bash
# Check CUDA paths
echo $PATH
echo $LD_LIBRARY_PATH

# Add CUDA to PATH (if necessary)
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
```

### Issue: LibTorch Not Found

```bash
# Check if LibTorch was downloaded
ls -la libtorch-*

# If missing, re-run install script
./install.sh
```

### Issue: COLMAP GUI Cannot Open

```bash
# Error: "Cannot start colmap GUI; colmap was built without GUI support"

# If you need COLMAP GUI (for manual point cloud editing)
./rebuild-colmap-with-gui.sh

# Or rebuild during fresh installation
./install.sh
# When asked "Enable COLMAP GUI support?" answer: y
```

**Note:**
- COLMAP GUI requires Qt5 and desktop environment
- For SSH connections, use X11 forwarding or VNC
- For servers, headless mode (no GUI) is recommended to save resources

### Issue: Python Dependencies Failed to Install

```bash
# Navigate to Backend
cd PobimSplatting/Backend

# Remove old virtual environment
rm -rf venv

# Create new environment
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### Issue: Node.js Dependencies Failed to Install

```bash
# Navigate to Frontend
cd PobimSplatting/Frontend

# Remove old modules
rm -rf node_modules package-lock.json

# Reinstall
npm install
```

---

## 📦 Installing on Another Machine

### Method 1: Use Installation Script (Recommended)

```bash
# On the new machine
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
./install.sh
```

### Method 2: Docker (For Convenience - Under Development)

```bash
# Build Docker image
docker build -t pobim-opensplat -f Dockerfile.rocm6 .

# Run container
docker run -it --gpus all -p 3000:3000 -p 5000:5000 pobim-opensplat
```

**Important Note**: Pre-compiled binaries (`build/opensplat`, `colmap-build/colmap`) **cannot** be directly copied to another machine due to system-specific dependencies. You must run the installation script on each machine.

---

## 📝 Log Files

Installation and runtime logs:

- **Installation log**: `install.log` (in root directory)
- **Backend log**: `PobimSplatting/Backend/backend.log`
- **Frontend log**: `PobimSplatting/Frontend/frontend.log`

View logs with:

```bash
# View installation log
tail -f install.log

# View backend log
tail -f PobimSplatting/Backend/backend.log

# View frontend log
tail -f PobimSplatting/Frontend/frontend.log
```

---

## 🆘 Get Help

If you encounter installation issues:

1. Always check `install.log` first
2. Verify GPU and CUDA work with `nvidia-smi`
3. Check available disk space with `df -h`
4. Contact development team with log files

---

## ⚡ Quick Reference

```bash
# First-time installation
./install.sh

# Start server
./quick-start.sh

# Stop server
cd PobimSplatting && ./start.sh stop

# Check status
cd PobimSplatting && ./start.sh status

# Clear ports
cd PobimSplatting && ./start.sh clear-ports

# View logs
cd PobimSplatting && ./start.sh
# Select option 5) View logs
```

---

## 🏗️ Architecture

```
POBIMOpenSplat/
├── install.sh              # Main installation script
├── quick-start.sh          # Quick start script (created after install)
├── build/
│   └── opensplat          # Main OpenSplat binary
├── colmap-build/
│   └── colmap             # COLMAP binary
├── libtorch-cuda126/      # PyTorch C++ library
├── PobimSplatting/
│   ├── start.sh           # Server management script
│   ├── Backend/           # Flask API server
│   │   ├── venv/         # Python virtual environment
│   │   └── app.py        # Main Flask application
│   └── Frontend/          # Next.js web interface
│       └── node_modules/  # Node.js dependencies
└── datasets/              # Input datasets
```

---

## 🔑 Key Features

- ✨ **Automated Installation**: One-command setup with dependency detection
- 🚀 **Quick Start**: Fast server startup after initial setup
- 🔍 **System Validation**: Comprehensive hardware and software checks
- 📊 **Progress Tracking**: Real-time installation progress with colored output
- 🛠️ **Smart Compilation**: Automatic CUDA version detection and LibTorch selection
- 🔄 **Port Management**: Automatic port conflict resolution
- 📝 **Detailed Logging**: Complete installation and runtime logs
- 🎯 **User-Friendly**: Interactive prompts and clear status messages

---

## 🌟 Best Practices

1. **Always run on GPU-enabled machines** for best performance
2. **Allocate sufficient resources** (16GB+ RAM, 50GB+ storage)
3. **Keep CUDA drivers updated** to latest stable version
4. **Use quick-start.sh** for subsequent runs instead of re-running install.sh
5. **Check logs regularly** when troubleshooting issues
6. **Clear ports** if you encounter port conflicts
7. **Update dependencies periodically** with `pip install --upgrade` and `npm update`

---

**Enjoy creating 3D Gaussian Splatting models! 🎨✨**

---

## 📚 Additional Resources

- [Original OpenSplat Repository](https://github.com/pierotofy/OpenSplat)
- [COLMAP Documentation](https://colmap.github.io/)
- [PyTorch Documentation](https://pytorch.org/cppdocs/)
- [CUDA Toolkit Documentation](https://docs.nvidia.com/cuda/)
- [Next.js Documentation](https://nextjs.org/docs)
