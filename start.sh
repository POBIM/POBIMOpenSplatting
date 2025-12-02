#!/bin/bash

# =============================================================================
# POBIMOpenSplatting - Quick Start Script
# =============================================================================
# This script can be run from the project root directory
# Usage: ./start.sh [start|stop|status|menu]
# =============================================================================

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
POBIM_SPLATTING_DIR="$PROJECT_ROOT/PobimSplatting"
FRONTEND_DIR="$POBIM_SPLATTING_DIR/Frontend"
BACKEND_DIR="$POBIM_SPLATTING_DIR/Backend"

echo -e "${BOLD}${BLUE}"
echo "============================================================================="
echo "   POBIMOpenSplatting - Server Manager"
echo "============================================================================="
echo -e "${NC}"

# Check if installation exists
check_installation() {
    local missing=()
    
    if [ ! -f "$PROJECT_ROOT/build/opensplat" ]; then
        missing+=("OpenSplat binary")
    fi
    
    if [ ! -d "$POBIM_SPLATTING_DIR" ]; then
        missing+=("PobimSplatting directory")
    fi
    
    if [ ! -d "$BACKEND_DIR/venv" ]; then
        missing+=("Python virtual environment")
    fi
    
    if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
        missing+=("Node.js dependencies")
    fi
    
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}✗ Some components are missing:${NC}"
        for item in "${missing[@]}"; do
            echo -e "  ${YELLOW}• $item${NC}"
        done
        echo ""
        echo -e "${CYAN}Run ./install.sh to complete installation${NC}"
        return 1
    fi
    
    return 0
}

# Setup environment
setup_environment() {
    # LibTorch paths
    LIBTORCH_DIRS=(
        "$PROJECT_ROOT/libtorch-cuda126"
        "$PROJECT_ROOT/libtorch-cuda121"
        "$PROJECT_ROOT/libtorch-cuda118"
        "$PROJECT_ROOT/libtorch-cpu"
    )

    for dir in "${LIBTORCH_DIRS[@]}"; do
        if [ -d "$dir" ]; then
            export LD_LIBRARY_PATH="$dir/lib:$LD_LIBRARY_PATH"
            echo -e "${CYAN}ℹ Using LibTorch: $(basename $dir)${NC}"
            break
        fi
    done

    # CUDA paths
    if [ -d "/usr/local/cuda" ]; then
        export PATH="/usr/local/cuda/bin:$PATH"
        export LD_LIBRARY_PATH="/usr/local/cuda/lib64:$LD_LIBRARY_PATH"
    fi

    # Qt offscreen for headless COLMAP
    export QT_QPA_PLATFORM=offscreen
}

# Show system status
show_status() {
    echo -e "${CYAN}System Status:${NC}"
    echo ""
    
    # Check COLMAP
    if command -v colmap &> /dev/null; then
        COLMAP_INFO=$(colmap -h 2>&1 | head -n 1)
        if echo "$COLMAP_INFO" | grep -q "with CUDA"; then
            echo -e "  ${GREEN}✓ COLMAP: GPU-enabled${NC}"
        else
            echo -e "  ${YELLOW}⚠ COLMAP: CPU-only${NC}"
        fi
    else
        echo -e "  ${RED}✗ COLMAP: Not found${NC}"
    fi
    
    # Check GLOMAP
    if command -v glomap &> /dev/null; then
        echo -e "  ${GREEN}✓ GLOMAP: Available (10-100x faster SfM)${NC}"
    else
        echo -e "  ${YELLOW}⚠ GLOMAP: Not installed${NC}"
    fi
    
    # Check OpenSplat
    if [ -f "$PROJECT_ROOT/build/opensplat" ]; then
        echo -e "  ${GREEN}✓ OpenSplat: Built${NC}"
    else
        echo -e "  ${RED}✗ OpenSplat: Not built${NC}"
    fi
    
    # Check NVIDIA GPU
    if command -v nvidia-smi &> /dev/null; then
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)
        GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -n1)
        echo -e "  ${GREEN}✓ GPU: $GPU_NAME ($GPU_MEM)${NC}"
    else
        echo -e "  ${RED}✗ GPU: No NVIDIA GPU detected${NC}"
    fi
    
    echo ""
}

# Start servers
start_servers() {
    setup_environment
    
    echo -e "${BLUE}Starting PobimSplatting servers...${NC}"
    echo ""
    
    # Change to PobimSplatting directory and run start.sh
    cd "$POBIM_SPLATTING_DIR"
    
    if [ -f "start.sh" ]; then
        exec bash start.sh "$@"
    else
        echo -e "${RED}✗ start.sh not found in PobimSplatting directory${NC}"
        exit 1
    fi
}

# Stop servers
stop_servers() {
    cd "$POBIM_SPLATTING_DIR"
    
    if [ -f "start.sh" ]; then
        bash start.sh stop
    else
        echo -e "${YELLOW}Attempting to stop servers manually...${NC}"
        
        # Kill processes on default ports
        for port in 3000 5000; do
            if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
                echo -e "${YELLOW}Stopping process on port $port...${NC}"
                fuser -k $port/tcp 2>/dev/null || kill $(lsof -t -i:$port) 2>/dev/null
            fi
        done
        
        echo -e "${GREEN}✓ Servers stopped${NC}"
    fi
}

# Show help
show_help() {
    echo -e "${BOLD}Usage:${NC} ./start.sh [command]"
    echo ""
    echo -e "${BOLD}Commands:${NC}"
    echo "  start     Start frontend and backend servers"
    echo "  stop      Stop all running servers"
    echo "  status    Show system status"
    echo "  menu      Open interactive menu"
    echo "  help      Show this help message"
    echo ""
    echo -e "${BOLD}Examples:${NC}"
    echo "  ./start.sh start    # Start servers"
    echo "  ./start.sh stop     # Stop servers"
    echo "  ./start.sh          # Open interactive menu"
    echo ""
    echo -e "${BOLD}Access Points:${NC}"
    echo "  Frontend: http://localhost:3000"
    echo "  Backend:  http://localhost:5000"
    echo ""
}

# Main
main() {
    case "${1:-menu}" in
        start)
            if check_installation; then
                show_status
                start_servers start
            fi
            ;;
        stop)
            stop_servers
            ;;
        status)
            check_installation
            show_status
            ;;
        menu)
            if check_installation; then
                show_status
                start_servers
            fi
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            echo -e "${RED}Unknown command: $1${NC}"
            show_help
            exit 1
            ;;
    esac
}

main "$@"
