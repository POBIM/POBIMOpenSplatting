# POBIMOpenSplat Installation Workflow

```
╔═══════════════════════════════════════════════════════════════════════════╗
║                   POBIMOpenSplat Installation System                      ║
║                        Complete Workflow Diagram                          ║
╚═══════════════════════════════════════════════════════════════════════════╝

┌─────────────────────────────────────────────────────────────────────────┐
│  STEP 0: Pre-Installation Check (Optional)                             │
│  ./check-system.sh                                                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌───────────────────────────┐
                    │   System Requirements     │
                    │   ✓ GPU: NVIDIA           │
                    │   ✓ CUDA: 11.8/12.1/12.6  │
                    │   ✓ RAM: 16GB+            │
                    │   ✓ Disk: 50GB+           │
                    └───────────────────────────┘
                                    │
                            ┌───────┴───────┐
                            │               │
                         PASS            FAIL
                            │               │
                            ▼               ▼
                         Continue     Fix Issues First
                            │
                            │
┌───────────────────────────┴──────────────────────────────────────────────┐
│  STEP 1: Run Installation Script                                        │
│  ./install.sh                                                            │
└──────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 1: System Detection                                              │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ ✓ Detect OS & Architecture                                        │  │
│  │ ✓ Detect GPU & CUDA Version                                       │  │
│  │ ✓ Check RAM, Disk, CPU                                            │  │
│  │ ✓ Determine LibTorch variant needed                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 2: Install System Dependencies                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ sudo apt update                                                    │  │
│  │ sudo apt install:                                                  │  │
│  │   • build-essential, cmake, git                                    │  │
│  │   • python3, python3-pip, python3-venv                             │  │
│  │   • Node.js (from NodeSource)                                      │  │
│  │   • libopencv-dev                                                  │  │
│  │   • COLMAP dependencies (Boost, Eigen, CGAL, Ceres, etc.)         │  │
│  │   • Qt5, GLEW, SQLite                                              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 3: Setup LibTorch                                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ CUDA 12.x → Download libtorch-cuda121                             │  │
│  │ CUDA 11.8 → Download libtorch-cuda118                             │  │
│  │ No CUDA   → Download libtorch-cpu                                 │  │
│  │                                                                    │  │
│  │ wget pytorch.org/libtorch/...                                      │  │
│  │ unzip → libtorch-cuda126/                                          │  │
│  │ export LD_LIBRARY_PATH                                             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 4: Build COLMAP                                                   │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ git clone colmap                                                   │  │
│  │ mkdir colmap-build && cd colmap-build                              │  │
│  │ cmake ../colmap                                                    │  │
│  │   -DCMAKE_BUILD_TYPE=Release                                       │  │
│  │   -DCMAKE_CUDA_ARCHITECTURES="75;80;86;89;90"                      │  │
│  │   -DGUI_ENABLED=OFF                                                │  │
│  │ make -j$(nproc)                                                    │  │
│  │ cp src/exe/colmap → colmap-build/colmap                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 5: Build OpenSplat                                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ mkdir build && cd build                                            │  │
│  │ cmake ..                                                           │  │
│  │   -DCMAKE_BUILD_TYPE=Release                                       │  │
│  │   -DCMAKE_PREFIX_PATH=/path/to/libtorch-cuda126                    │  │
│  │   -DOPENSPLAT_BUILD_SIMPLE_TRAINER=ON                              │  │
│  │ make -j$(nproc)                                                    │  │
│  │ ./opensplat --version  # Test                                      │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 6: Setup Python Backend                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ cd PobimSplatting/Backend                                          │  │
│  │ python3 -m venv venv                                               │  │
│  │ source venv/bin/activate                                           │  │
│  │ pip install --upgrade pip                                          │  │
│  │ pip install -r requirements.txt                                    │  │
│  │   • Flask, Flask-CORS                                              │  │
│  │   • OpenCV, Pillow                                                 │  │
│  │   • NumPy, etc.                                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 7: Setup Node.js Frontend                                        │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ cd PobimSplatting/Frontend                                         │  │
│  │ npm install                                                        │  │
│  │   • Next.js, React                                                 │  │
│  │   • Tailwind CSS                                                   │  │
│  │   • UI components                                                  │  │
│  │ (Optional) npm run build                                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 8: Create Quick Start Script                                     │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Generate: quick-start.sh                                           │  │
│  │ #!/bin/bash                                                        │  │
│  │ # Auto-detect LibTorch path                                        │  │
│  │ # Export LD_LIBRARY_PATH                                           │  │
│  │ # Set CUDA environment                                             │  │
│  │ # Set Qt offscreen mode                                            │  │
│  │ # Execute PobimSplatting/start.sh                                  │  │
│  │ chmod +x quick-start.sh                                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Phase 9: Final Configuration                                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ Create .env.local with configuration                               │  │
│  │ Save installation log → install.log                                │  │
│  │ Display summary and access URLs                                    │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                ┌───────────────────────────┐
                │  Installation Complete!   │
                └───────────────────────────┘
                            │
                            ▼

╔═══════════════════════════════════════════════════════════════════════════╗
║  STEP 2: Start the Server                                                ║
║  ./quick-start.sh                                                         ║
╚═══════════════════════════════════════════════════════════════════════════╝
                            │
                            ▼
                ┌───────────────────────────┐
                │  Check Installation       │
                │  ✓ opensplat exists       │
                │  ✓ libtorch exists        │
                │  ✓ Environment set        │
                └───────────────────────────┘
                            │
                            ▼
                ┌───────────────────────────┐
                │  Execute                  │
                │  PobimSplatting/start.sh  │
                └───────────────────────────┘
                            │
                            ▼
        ┌───────────────────┴───────────────────┐
        │                                       │
        ▼                                       ▼
┌───────────────┐                     ┌───────────────┐
│ Start Backend │                     │Start Frontend │
│ (Flask)       │                     │ (Next.js)     │
│ Port 5000     │                     │ Port 3000     │
└───────────────┘                     └───────────────┘
        │                                       │
        │                                       │
        └───────────────────┬───────────────────┘
                            ▼
                ┌───────────────────────────┐
                │  Server Running           │
                │  Frontend: :3000          │
                │  Backend : :5000          │
                └───────────────────────────┘


╔═══════════════════════════════════════════════════════════════════════════╗
║  STEP 3: Access & Use                                                     ║
╚═══════════════════════════════════════════════════════════════════════════╝

    Browser: http://localhost:3000
                    │
                    ▼
        ┌───────────────────────┐
        │  POBIMOpenSplat       │
        │  Web Interface        │
        │                       │
        │  • Upload Images      │
        │  • Run COLMAP         │
        │  • Train Model        │
        │  • View Results       │
        │  • Export Splat       │
        └───────────────────────┘
                    │
                    │ API Calls
                    ▼
        ┌───────────────────────┐
        │  Flask Backend        │
        │  :5000                │
        └───────────────────────┘
                    │
        ┌───────────┴────────────┐
        │                        │
        ▼                        ▼
┌──────────────┐        ┌─────────────────┐
│  COLMAP      │        │  OpenSplat      │
│  colmap-     │        │  build/         │
│  build/      │        │  opensplat      │
│  colmap      │        │                 │
└──────────────┘        └─────────────────┘
        │                        │
        └───────────┬────────────┘
                    ▼
            ┌───────────────┐
            │  Results      │
            │  .ply / .splat│
            └───────────────┘


═══════════════════════════════════════════════════════════════════════════
  File Structure After Installation
═══════════════════════════════════════════════════════════════════════════

POBIMOpenSplat/
├── install.sh ..................... Main installation script
├── quick-start.sh ................. Quick start (auto-generated)
├── check-system.sh ................ System checker
├── install.log .................... Installation log
├── .env.local ..................... Environment config
│
├── build/
│   └── opensplat .................. ✓ Main binary
│
├── colmap-build/
│   └── colmap ..................... ✓ COLMAP binary
│
├── libtorch-cuda126/ .............. ✓ PyTorch C++ library
│   ├── lib/
│   ├── include/
│   └── ...
│
├── PobimSplatting/
│   ├── start.sh ................... Server manager
│   │
│   ├── Backend/
│   │   ├── venv/ .................. ✓ Python environment
│   │   ├── requirements.txt ....... Python deps
│   │   ├── app.py ................. Flask app
│   │   ├── backend.log ............ Runtime log
│   │   └── ...
│   │
│   └── Frontend/
│       ├── node_modules/ .......... ✓ Node.js deps
│       ├── package.json ........... Node.js deps
│       ├── frontend.log ........... Runtime log
│       └── ...
│
├── datasets/ ...................... Input datasets
├── uploads/ ....................... Uploaded files
├── results/ ....................... Generated models
│
└── Documentation/
    ├── README.md .................. Updated with install guide
    ├── INSTALLATION.md ............ English guide
    ├── INSTALLATION_TH.md ......... Thai guide
    ├── QUICK_REFERENCE.md ......... Quick commands
    ├── INSTALLATION_SYSTEM.md ..... System overview
    └── WORKFLOW.md ................ This file


═══════════════════════════════════════════════════════════════════════════
  Command Reference
═══════════════════════════════════════════════════════════════════════════

┌─────────────────────────────────────────────────────────────────────────┐
│  First Time Installation                                                │
├─────────────────────────────────────────────────────────────────────────┤
│  ./check-system.sh          # Optional: Check requirements             │
│  ./install.sh               # Main installation (30-60 min)            │
│  ./quick-start.sh           # Start server                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Daily Usage                                                            │
├─────────────────────────────────────────────────────────────────────────┤
│  ./quick-start.sh           # Start server                             │
│  cd PobimSplatting          # Or navigate to folder                    │
│  ./start.sh start           # Start server                             │
│  ./start.sh stop            # Stop server                              │
│  ./start.sh status          # Check status                             │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Troubleshooting                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│  ./check-system.sh          # Re-check system                          │
│  tail -f install.log        # View installation log                    │
│  cd PobimSplatting          #                                           │
│  ./start.sh                 # Interactive menu                          │
│    → 5) View logs           # Check runtime logs                       │
│    → 8) Force clear ports   # Clear stuck ports                        │
└─────────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════
  Advantages of This System
═══════════════════════════════════════════════════════════════════════════

✓ One-Command Installation      → ./install.sh
✓ Smart CUDA Detection          → Auto-selects correct LibTorch
✓ Comprehensive Error Checking  → Validates at each step
✓ Detailed Logging              → Full install.log for debugging
✓ Interactive Prompts           → User-friendly installation
✓ Quick Start Script            → ./quick-start.sh for future use
✓ System Validation             → check-system.sh before install
✓ Complete Documentation        → Multiple guides in EN/TH
✓ Portable Setup                → Works on any compatible Linux
✓ Resume Capability             → Can continue if interrupted


═══════════════════════════════════════════════════════════════════════════
  Created: November 7, 2025
  Author: POBIM Development Team
═══════════════════════════════════════════════════════════════════════════
```
