# POBIMOpenSplat - Quick Reference Card

> This page is the day-to-day command sheet. For the canonical documentation map, start from [DOCS_INDEX.md](DOCS_INDEX.md).

## 🚀 Installation (First Time Only)

```bash
# Clone and install
git clone https://github.com/POBIM/POBIMOpenSplat.git
cd POBIMOpenSplat
chmod +x install.sh
./install.sh
```

---

## ⚡ Daily Commands

```bash
# Start server (recommended)
./quick-start.sh

# Alternative start methods
cd PobimSplatting && ./start.sh start
cd PobimSplatting && ./start.sh        # Interactive menu

# Stop server
cd PobimSplatting && ./start.sh stop

# Restart server
cd PobimSplatting && ./start.sh
# Select option 3) Restart all servers

# Check status
cd PobimSplatting && ./start.sh status
```

---

## 🌐 Access URLs

| Service | URL |
|---------|-----|
| Frontend (Main UI) | http://localhost:3000 |
| Backend API | http://localhost:5000 |

---

## 🔧 Common Issues & Fixes

### Port Already in Use
```bash
cd PobimSplatting && ./start.sh
# Select: 8) Force clear default ports
```

### CUDA Not Found
```bash
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH
```

### Rebuild Everything
```bash
rm -rf build colmap-build
./install.sh
```

### Rebuild COLMAP with GUI
```bash
./rebuild-colmap-with-gui.sh
```

### Reset Python Environment
```bash
cd PobimSplatting/Backend
rm -rf venv
python3 -m venv venv   # ensure python3 is 3.10-3.12
source venv/bin/activate
pip install -r requirements.txt
```

### Reset Node.js Environment
```bash
cd PobimSplatting/Frontend
rm -rf node_modules package-lock.json
npm install
```

---

## 📝 View Logs

```bash
# Installation log
tail -f PobimSplatting/logs/install.log

# Backend log
tail -f PobimSplatting/logs/backend.log

# Frontend log
tail -f PobimSplatting/logs/frontend.log

# Or use the menu
cd PobimSplatting && ./start.sh
# Select: 5) View logs
```

---

## 🛠️ Manual Operations

### Test OpenSplat
```bash
./build/opensplat --version
./build/opensplat --help
```

### Test COLMAP
```bash
./colmap-build/colmap --version
```

### Test GPU
```bash
nvidia-smi
```

### Check System Resources
```bash
# Check RAM
free -h

# Check disk space
df -h

# Check CPU
lscpu | grep "CPU(s)"

# Check CUDA
nvcc --version
```

---

## 📂 Directory Structure

```
POBIMOpenSplat/
├── install.sh           # Installation script
├── quick-start.sh       # Quick start (auto-generated)
├── build/opensplat      # Main binary
├── colmap-build/colmap  # COLMAP binary
├── libtorch-*/          # PyTorch libraries
├── PobimSplatting/      # Web platform
│   ├── start.sh        # Server manager
│   ├── Backend/        # Flask API
│   └── Frontend/       # Next.js UI
├── datasets/           # Input data
├── uploads/            # Uploaded files
└── results/            # Generated models
```

---

## 🎯 Workflow

1. **Upload images** → Frontend (localhost:3000)
2. **Process dataset** → COLMAP reconstruction
3. **Train model** → OpenSplat training
4. **View results** → 3D viewer
5. **Export model** → Download PLY/mesh

---

## 🔑 Environment Variables

```bash
# CUDA paths
export PATH=/usr/local/cuda/bin:$PATH
export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH

# LibTorch path (auto-set by quick-start.sh)
export LD_LIBRARY_PATH=/path/to/libtorch/lib:$LD_LIBRARY_PATH

# Qt for headless COLMAP
export QT_QPA_PLATFORM=offscreen
```

---

## 📊 Performance Tips

- Use **GPU** for training (10-100x faster than CPU)
- Allocate **16GB+ RAM** for large datasets
- Use **SSD storage** for better I/O performance
- Close **unnecessary applications** during training
- Monitor with `nvidia-smi` and `htop`

---

## 🆘 Emergency Commands

```bash
# Kill all processes on ports 3000 and 5000
sudo lsof -ti:3000 | xargs kill -9
sudo lsof -ti:5000 | xargs kill -9

# Or use fuser
sudo fuser -k 3000/tcp
sudo fuser -k 5000/tcp

# Force restart
pkill -f "next start"
pkill -f "python app.py"
./quick-start.sh
```

---

## 📱 Quick Shortcuts

| Action | Command |
|--------|---------|
| Install | `./install.sh` |
| Start | `./quick-start.sh` |
| Stop | `cd PobimSplatting && ./start.sh stop` |
| Restart | `cd PobimSplatting && ./start.sh` → option 3 |
| Status | `cd PobimSplatting && ./start.sh status` |
| Logs | `cd PobimSplatting && ./start.sh` → option 5 |
| Clear Ports | `cd PobimSplatting && ./start.sh` → option 8 |

---

## 🌟 Pro Tips

- **Bookmark this page** for quick reference
- **Keep PobimSplatting/logs/install.log** for troubleshooting
- **Run status check** before reporting issues
- **Clear ports** if server won't start
- **Use quick-start.sh** instead of manual commands
- **Check logs** when something goes wrong

---

**Print or save this reference card for easy access! 📋✨**

---

*Last updated: November 7, 2025*
