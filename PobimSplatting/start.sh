#!/bin/bash

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Project paths
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"
REPO_ROOT="$(cd "$PROJECT_ROOT/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/Frontend"
BACKEND_DIR="$PROJECT_ROOT/Backend"
OPENSPLAT_BINARY="$REPO_ROOT/build/opensplat"
COLMAP_BINARY="$REPO_ROOT/colmap-build/colmap"

# PID tracking
FRONTEND_PID_FILE="$PROJECT_ROOT/frontend.pid"
BACKEND_PID_FILE="$PROJECT_ROOT/backend.pid"

# Privilege escalation cache
SUDO_PASSWORD=""
SUDO_AUTHENTICATED=false

DEFAULT_PORTS=(3000 3001 3002 3003 5000)

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   PobimSplatting Server Manager${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Prompt for sudo password once and cache it in memory
prompt_sudo_password() {
    local reason="$1"

    if [ "$SUDO_AUTHENTICATED" = true ]; then
        return 0
    fi

    if ! command -v sudo >/dev/null 2>&1; then
        echo -e "${RED}sudo is required to ${reason}, but it is not installed.${NC}"
        return 1
    fi

    echo -e "${YELLOW}Elevated privileges are required to ${reason}.${NC}"
    local password=""
    while true; do
        read -s -p "Enter sudo password (leave blank to cancel): " password
        echo ""

        if [ -z "$password" ]; then
            echo -e "${YELLOW}Skipping privileged action. The operation may fail.${NC}"
            return 1
        fi

        if printf '%s\n' "$password" | sudo -S -v >/dev/null 2>&1; then
            SUDO_PASSWORD="$password"
            SUDO_AUTHENTICATED=true
            return 0
        else
            echo -e "${RED}Incorrect password. Please try again.${NC}"
        fi
    done
}

# Run a command with sudo, prompting for password if needed
run_with_sudo() {
    local reason="$1"
    shift

    if [ "$EUID" -eq 0 ]; then
        "$@"
        return $?
    fi

    if ! prompt_sudo_password "$reason"; then
        return 1
    fi

    printf '%s\n' "$SUDO_PASSWORD" | sudo -S -- "$@"
}

# Attempt to run a command normally, then retry with sudo if it fails
run_or_try_sudo() {
    local reason="$1"
    shift

    "$@" >/dev/null 2>&1
    local status=$?
    if [ $status -eq 0 ]; then
        return 0
    fi

    if [ "$EUID" -eq 0 ]; then
        return $status
    fi

    run_with_sudo "$reason" "$@" >/dev/null 2>&1
    local sudo_status=$?
    return $sudo_status
}

clear_sudo_credentials() {
    if command -v sudo >/dev/null 2>&1; then
        sudo -k >/dev/null 2>&1
    fi
    SUDO_PASSWORD=""
    SUDO_AUTHENTICATED=false
}

# Function to check if a port is in use
check_port() {
    local port=$1

    if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0
    fi

    if [ "$EUID" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        if prompt_sudo_password "inspect port $port"; then
            if printf '%s\n' "$SUDO_PASSWORD" | sudo -S lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
                return 0
            fi
        fi
    fi

    return 1
}

# Function to kill process on port
kill_port() {
    local port=$1

    if ! check_port "$port"; then
        return
    fi

    echo -e "${YELLOW}Port $port is in use. Attempting to stop the process...${NC}"

    local pids=()
    mapfile -t pids < <(lsof -t -i:"$port" 2>/dev/null)

    if [ ${#pids[@]} -eq 0 ] && [ "$EUID" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
        if prompt_sudo_password "inspect processes using port $port"; then
            mapfile -t pids < <(printf '%s\n' "$SUDO_PASSWORD" | sudo -S lsof -t -i:"$port" 2>/dev/null)
        fi
    fi

    if [ ${#pids[@]} -gt 0 ]; then
        if ! run_or_try_sudo "terminate processes on port $port" kill -9 "${pids[@]}"; then
            echo -e "${YELLOW}Standard kill failed. Trying fuser...${NC}"
        fi
    fi

    if check_port "$port" && command -v fuser >/dev/null 2>&1; then
        if ! run_or_try_sudo "force stop port $port" fuser -k "${port}/tcp"; then
            echo -e "${RED}Failed to stop processes on port $port. Manual intervention may be required.${NC}"
        fi
    fi

    sleep 2

    if check_port "$port"; then
        force_clear_ports --quiet "$port"
        sleep 1
    fi

    if check_port "$port"; then
        echo -e "${YELLOW}Port $port is still in use. Please close the process manually if needed.${NC}"
    else
        echo -e "${GREEN}✓ Port $port cleared${NC}"
    fi
}

force_clear_ports() {
    local quiet=false
    if [ "$1" = "--quiet" ]; then
        quiet=true
        shift
    fi

    local ports=("$@")
    if [ ${#ports[@]} -eq 0 ]; then
        ports=("${DEFAULT_PORTS[@]}")
    fi

    for port in "${ports[@]}"; do
        if ! [[ $port =~ ^[0-9]+$ ]]; then
            if [ "$quiet" != true ]; then
                echo -e "${YELLOW}Skipping invalid port: $port${NC}"
            fi
            continue
        fi

        if [ "$quiet" != true ]; then
            echo -e "${BLUE}Force clearing port $port using fuser...${NC}"
        fi

        run_or_try_sudo "force clear port $port" fuser -k "${port}/tcp"
        local status=$?

        sleep 1

        if check_port "$port"; then
            if [ "$quiet" != true ]; then
                echo -e "${YELLOW}Port $port still in use after force clear.${NC}"
                if [ $status -ne 0 ]; then
                    echo -e "${YELLOW}fuser exit code: $status${NC}"
                fi
            fi
        else
            if [ "$quiet" != true ]; then
                if [ $status -eq 0 ]; then
                    echo -e "${GREEN}✓ Port $port cleared${NC}"
                else
                    echo -e "${GREEN}Port $port already free${NC}"
                fi
            fi
        fi
    done
}

kill_process_tree() {
    local pid=$1
    local name=$2
    local quiet=${3:-false}

    if [ -z "$pid" ]; then
        return
    fi

    if ! ps -p "$pid" >/dev/null 2>&1; then
        return
    fi

    if [ "$quiet" != true ]; then
        echo -e "${YELLOW}Stopping $name process tree (PID: $pid)...${NC}"
    fi

    if command -v pkill >/dev/null 2>&1; then
        run_or_try_sudo "terminate child processes for $name (PID: $pid)" pkill -P "$pid"
    fi

    run_or_try_sudo "gracefully stop $name (PID: $pid)" kill "$pid"

    for _ in {1..5}; do
        if ! ps -p "$pid" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    if ps -p "$pid" >/dev/null 2>&1; then
        if [ "$quiet" != true ]; then
            echo -e "${YELLOW}$name still running; forcing kill...${NC}"
        fi
        if ! run_or_try_sudo "force stop $name (PID: $pid)" kill -9 "$pid"; then
            echo -e "${RED}Failed to terminate $name (PID: $pid). Please stop it manually.${NC}"
        fi
    fi
}

stop_backend_process() {
    local quiet=${1:-false}
    local pid=""

    if [ -f "$BACKEND_PID_FILE" ]; then
        pid=$(cat "$BACKEND_PID_FILE")
    elif [ -n "$BACKEND_PID" ]; then
        pid="$BACKEND_PID"
    fi

    if [ -n "$pid" ]; then
        kill_process_tree "$pid" "backend" "$quiet"
    fi

    rm -f "$BACKEND_PID_FILE"
    BACKEND_PID=""

    kill_port 5000
}

stop_frontend_process() {
    local quiet=${1:-false}
    local pid=""

    if [ -f "$FRONTEND_PID_FILE" ]; then
        pid=$(cat "$FRONTEND_PID_FILE")
    elif [ -n "$FRONTEND_PID" ]; then
        pid="$FRONTEND_PID"
    fi

    if [ -n "$pid" ]; then
        kill_process_tree "$pid" "frontend" "$quiet"
    fi

    rm -f "$FRONTEND_PID_FILE"
    FRONTEND_PID=""

    kill_port 3000
}

# Function to check system status
check_system_status() {
    echo -e "${BLUE}=== System Status ===${NC}"
    echo ""

    # Check GPU
    if command -v nvidia-smi &> /dev/null; then
        echo -e "${GREEN}✓ NVIDIA GPU detected${NC}"
        nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
    else
        echo -e "${YELLOW}⚠ No NVIDIA GPU detected${NC}"
    fi
    echo ""

    # Check OpenSplat
    if [ -f "$OPENSPLAT_BINARY" ]; then
        echo -e "${GREEN}✓ OpenSplat found${NC}"
    else
        echo -e "${RED}✗ OpenSplat not found${NC}"
        echo -e "${YELLOW}  Please build OpenSplat first${NC}"
    fi
    echo ""

    # Check COLMAP
    if command -v colmap &> /dev/null; then
        echo -e "${GREEN}✓ COLMAP installed (system)${NC}"
        colmap --version 2>/dev/null | head -n1
    elif [ -f "$COLMAP_BINARY" ]; then
        echo -e "${GREEN}✓ COLMAP found (custom build)${NC}"
    else
        echo -e "${YELLOW}⚠ COLMAP not installed${NC}"
    fi
    echo ""

    # Check Python
    if command -v python3 &> /dev/null; then
        echo -e "${GREEN}✓ Python3 installed${NC}"
        python3 --version
    else
        echo -e "${RED}✗ Python3 not installed${NC}"
    fi
    echo ""

    # Check Node.js
    if command -v node &> /dev/null; then
        echo -e "${GREEN}✓ Node.js installed${NC}"
        node --version
    else
        echo -e "${RED}✗ Node.js not installed${NC}"
    fi
    echo ""
}

# Function to start backend
start_backend() {
    echo -e "${BLUE}Starting Backend Server...${NC}"

    stop_backend_process true
    cd "$BACKEND_DIR"

    # Check if virtual environment exists
    if [ ! -d "venv" ]; then
        echo -e "${YELLOW}Virtual environment not found. Creating...${NC}"
        python3 -m venv venv
        source venv/bin/activate
        pip install --upgrade pip
        pip install -r requirements.txt
    else
        source venv/bin/activate
    fi

    # Kill existing process on port 5000
    kill_port 5000

    # Start Flask server in background
    python app.py > backend.log 2>&1 &
    BACKEND_PID=$!
    echo "$BACKEND_PID" > "$BACKEND_PID_FILE"

    if command -v deactivate >/dev/null 2>&1; then
        deactivate
    fi
    echo -e "${GREEN}✓ Backend started (PID: $BACKEND_PID)${NC}"
    echo -e "  URL: http://localhost:5000"
    echo ""
}

# Function to start frontend
start_frontend() {
    echo -e "${BLUE}Starting Frontend Server...${NC}"

    stop_frontend_process true
    cd "$FRONTEND_DIR"

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}Installing frontend dependencies...${NC}"
        npm install
    fi

    # Kill existing process on port 3000
    kill_port 3000

    # Start Next.js server in background
    npm run dev > frontend.log 2>&1 &
    FRONTEND_PID=$!
    echo "$FRONTEND_PID" > "$FRONTEND_PID_FILE"
    echo -e "${GREEN}✓ Frontend started (PID: $FRONTEND_PID)${NC}"
    echo -e "  URL: http://localhost:3000"
    echo ""
}

# Function to stop all servers
stop_servers() {
    echo -e "${YELLOW}Stopping all servers...${NC}"

    stop_frontend_process
    stop_backend_process

    force_clear_ports --quiet

    echo -e "${GREEN}✓ All servers stopped${NC}"
}

# Function to show logs
show_logs() {
    echo -e "${BLUE}=== Logs ===${NC}"
    echo -e "${YELLOW}Frontend logs (last 20 lines):${NC}"
    if [ -f "$FRONTEND_DIR/frontend.log" ]; then
        tail -n 20 "$FRONTEND_DIR/frontend.log"
    else
        echo "No frontend logs found"
    fi
    echo ""
    echo -e "${YELLOW}Backend logs (last 20 lines):${NC}"
    if [ -f "$BACKEND_DIR/backend.log" ]; then
        tail -n 20 "$BACKEND_DIR/backend.log"
    else
        echo "No backend logs found"
    fi
}

# Main menu
main_menu() {
    while true; do
        echo -e "${BLUE}========================================${NC}"
        echo -e "${BLUE}   PobimSplatting Control Panel${NC}"
        echo -e "${BLUE}========================================${NC}"
        echo ""
        echo "1) Start all servers"
        echo "2) Stop all servers"
        echo "3) Restart all servers"
        echo "4) Check system status"
        echo "5) View logs"
        echo "6) Start frontend only"
        echo "7) Start backend only"
    echo "8) Force clear default ports"
    echo "9) Exit"
        echo ""
        read -p "Select option: " choice

        case $choice in
            1)
                check_system_status
                start_backend
                start_frontend
                echo -e "${GREEN}✓ All servers are running!${NC}"
                echo -e "${BLUE}Frontend: http://localhost:3000${NC}"
                echo -e "${BLUE}Backend API: http://localhost:5000${NC}"
                ;;
            2)
                stop_servers
                ;;
            3)
                stop_servers
                sleep 2
                start_backend
                start_frontend
                echo -e "${GREEN}✓ All servers restarted!${NC}"
                ;;
            4)
                check_system_status
                ;;
            5)
                show_logs
                ;;
            6)
                start_frontend
                ;;
            7)
                start_backend
                ;;
            8)
                force_clear_ports
                ;;
            9)
                echo -e "${YELLOW}Exiting...${NC}"
                exit 0
                ;;
            *)
                echo -e "${RED}Invalid option${NC}"
                ;;
        esac
        echo ""
        read -p "Press Enter to continue..."
        clear
    done
}

# Handle Ctrl+C
trap 'echo -e "\n${YELLOW}Interrupted. Stopping servers...${NC}"; stop_servers; exit 0' INT
trap clear_sudo_credentials EXIT

# Check if running with arguments
if [ "$1" == "start" ]; then
    check_system_status
    start_backend
    start_frontend
    echo -e "${GREEN}✓ All servers are running!${NC}"
    echo -e "${BLUE}Frontend: http://localhost:3000${NC}"
    echo -e "${BLUE}Backend API: http://localhost:5000${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop${NC}"

    # Keep script running
    while true; do
        sleep 1
    done
elif [ "$1" == "stop" ]; then
    stop_servers
elif [ "$1" == "status" ]; then
    check_system_status
elif [ "$1" == "clear-ports" ]; then
    shift
    if [ $# -gt 0 ]; then
        force_clear_ports "$@"
    else
        force_clear_ports
    fi
else
    # Run interactive menu
    clear
    main_menu
fi