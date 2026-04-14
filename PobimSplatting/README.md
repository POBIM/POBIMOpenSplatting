# PobimSplatting - 3D Gaussian Splatting Platform

A modern web platform for 3D reconstruction using OpenSplat, featuring a Next.js frontend and Python Flask backend.

## Features

- **Modern Web Interface**: Clean, responsive UI built with Next.js and Tailwind CSS
- **Drag & Drop Upload**: Easy media upload with progress tracking
- **Real-time Processing**: WebSocket-based live status updates
- **Project Management**: Full CRUD operations with SQLite database
- **3D Viewer**: Integrated viewer for gaussian splat results
- **System Monitoring**: Dashboard with GPU, storage, and processing stats
- **GPU-Accelerated Processing**: CUDA-backed COLMAP sparse reconstruction with the global mapper as the preferred path

## 📚 Documentation

- **[Quick Performance Guide](QUICK_PERFORMANCE_GUIDE.md)** - ⚡ GPU acceleration and performance tips
- **[Mesh Export Guide](MESH_EXPORT_GUIDE.md)** - 📐 Export 3D meshes from gaussian splats

## Architecture

```
PobimSplatting/
├── Frontend/          # Next.js 16 with TypeScript
│   ├── src/
│   │   ├── app/      # App router pages
│   │   ├── components/
│   │   └── lib/      # API and WebSocket services
│   └── package.json
│
├── Backend/          # Python Flask API
│   ├── app.py       # Main API server
│   ├── requirements.txt
│   ├── uploads/     # Input media storage
│   ├── outputs/     # Processed splats
│   └── projects.db  # SQLite database
│
└── start.sh         # System control script
```

## Installation

### Prerequisites

- Node.js 20+
- Python 3.10-3.12 (3.12 recommended)
- NVIDIA GPU with CUDA (optional but recommended)
- OpenSplat built and ready
- COLMAP (recommended for SfM; COLMAP global mapper is the preferred path and standalone GLOMAP is legacy fallback only)

### Setup

1. **Install Frontend Dependencies**:
```bash
cd Frontend
npm install
npm run build
```

2. **Setup Backend Environment**:
```bash
cd Backend
./setup_env.sh
# Or manually:
python3 -m venv venv  # ensure python3 is 3.10-3.12
source venv/bin/activate
pip install -r requirements.txt
```

## Usage

### Quick Start

```bash
# Start both servers
./start.sh start

# Or use interactive menu
./start.sh
```

The system will be available at:
- Frontend: http://localhost:3000
- Backend API: http://localhost:5000

### Control Options

```bash
./start.sh          # Interactive menu
./start.sh start    # Start all servers
./start.sh stop     # Stop all servers
./start.sh status   # Check system status
```

## API Endpoints

### Core Endpoints

- `GET /api/health` - System health check
- `POST /api/upload` - Upload media file
- `POST /api/process/{id}` - Start processing
- `GET /api/status/{id}` - Get project status
- `GET /api/projects` - List all projects
- `DELETE /api/projects/{id}` - Delete project
- `GET /api/download/{id}` - Download output

### WebSocket Events

- `connect` - Connection established
- `subscribe_status` - Subscribe to project updates
- `status_update` - Receive real-time status

## Pages

- **Dashboard** (`/`) - System overview and stats
- **Upload** (`/upload`) - Drag-and-drop media upload
- **Projects** (`/projects`) - Project management
- **Viewer** (`/viewer`) - 3D splat visualization
- **Settings** (`/settings`) - Configuration options

## Development

### Frontend Development

```bash
cd Frontend
npm run build
npm run start
```

For local hot-reload development only:

```bash
npm run dev
```

### Backend Development

```bash
cd Backend
source venv/bin/activate
python app.py
```

### Backend Production-Style Start

```bash
cd Backend
source venv/bin/activate
gunicorn --config gunicorn.conf.py "PobimSplatting.Backend.app:app"
```

Or use the launcher from the `PobimSplatting/` directory:

```bash
FLASK_ENV=production ./start.sh start
```

The production config keeps `workers=1` and uses threaded Gunicorn so Flask-SocketIO room state stays in-process and compatible with the current backend threading model.

## Configuration

### Frontend (.env.local)

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=http://localhost:5000
```

### Backend (.env)

```env
FLASK_ENV=development
DATABASE_PATH=projects.db
OPENSPLAT_PATH=/path/to/opensplat
```

## Features in Detail

### Upload System
- Supports video (MP4, AVI, MOV) and images (JPG, PNG)
- File size limit: 500MB
- Automatic file validation
- Progress tracking

### Processing Pipeline
1. File upload and validation
2. COLMAP sparse reconstruction with the global mapper for unordered photo sets; experimental `vocab_tree` matching is available for large collections
3. Real-time progress updates via WebSocket
4. Output generation (PLY format)
5. Storage and database updates

### Project Management
- SQLite database for persistence
- Full CRUD operations
- Status tracking (uploaded, processing, completed, error)
- Automatic cleanup options

### Real-time Updates
- Socket.IO for bidirectional communication
- Live progress tracking
- Instant status notifications
- Multi-client support

## Troubleshooting

### Port Already in Use
The start.sh script automatically kills processes on ports 3000 and 5000.

### OpenSplat Not Found
Build OpenSplat first and update the path in Backend/.env

### GPU Not Detected
Ensure CUDA is installed and nvidia-smi is accessible.

## Tech Stack

### Frontend
- Next.js 16
- TypeScript
- Tailwind CSS
- Lucide Icons
- Socket.IO Client

### Backend
- Flask 3.1
- Flask-CORS
- Flask-SocketIO
- SQLite3
- Python 3.10-3.12 (3.12 recommended)

## License

MIT License - Feel free to use and modify

## Credits

Built with OpenSplat for 3D Gaussian Splatting processing.
