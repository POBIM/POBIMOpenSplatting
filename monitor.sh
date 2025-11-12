#!/bin/bash

# System Monitor Script for POBIMOpenSplatting
# Monitors GPU, CPU, Memory, Disk, and key processes

# Colors for better readability
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Refresh interval (seconds)
REFRESH_INTERVAL=${1:-2}

# Function to draw a line
draw_line() {
    printf '%*s\n' "${COLUMNS:-$(tput cols)}" '' | tr ' ' '─'
}

# Function to get GPU info
show_gpu_info() {
    echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║                    🎮 GPU MONITOR (RTX 4080)                 ║${NC}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
    
    if command -v nvidia-smi &> /dev/null; then
        # GPU utilization
        GPU_UTIL=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -n 1)
        GPU_MEM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -n 1)
        GPU_MEM_TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n 1)
        GPU_TEMP=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits | head -n 1)
        GPU_POWER=$(nvidia-smi --query-gpu=power.draw --format=csv,noheader | head -n 1)
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)
        
        # Color coding based on utilization
        if [ "$GPU_UTIL" -gt 80 ]; then
            UTIL_COLOR=$RED
        elif [ "$GPU_UTIL" -gt 50 ]; then
            UTIL_COLOR=$YELLOW
        else
            UTIL_COLOR=$GREEN
        fi
        
        echo -e "${WHITE}GPU Name:${NC}        $GPU_NAME"
        echo -e "${WHITE}GPU Utilization:${NC} ${UTIL_COLOR}${GPU_UTIL}%${NC}"
        echo -e "${WHITE}Memory:${NC}          ${YELLOW}${GPU_MEM} MiB${NC} / ${GPU_MEM_TOTAL} MiB ($(($GPU_MEM * 100 / $GPU_MEM_TOTAL))%)"
        echo -e "${WHITE}Temperature:${NC}     ${MAGENTA}${GPU_TEMP}°C${NC}"
        echo -e "${WHITE}Power Draw:${NC}      ${CYAN}${GPU_POWER}${NC}"
        
        # GPU Processes
        echo -e "\n${BOLD}${BLUE}Active GPU Processes:${NC}"
        nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null | while IFS=, read -r pid name mem; do
            if [ -n "$pid" ]; then
                echo -e "  ${GREEN}PID $pid:${NC} $name - ${YELLOW}${mem}${NC}"
            fi
        done
        
        # If no processes, show message
        if [ -z "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null)" ]; then
            echo -e "  ${YELLOW}No active GPU processes${NC}"
        fi
    else
        echo -e "${RED}nvidia-smi not found!${NC}"
    fi
    echo ""
}

# Function to show CPU and Memory
show_cpu_memory() {
    echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${GREEN}║                    💻 CPU & MEMORY                           ║${NC}"
    echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
    
    # CPU info
    CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1)
    CPU_CORES=$(nproc)
    LOAD_AVG=$(uptime | awk -F'load average:' '{print $2}')
    
    echo -e "${WHITE}CPU Cores:${NC}       $CPU_CORES"
    echo -e "${WHITE}CPU Usage:${NC}       ${YELLOW}${CPU_USAGE}%${NC}"
    echo -e "${WHITE}Load Average:${NC}   ${CYAN}${LOAD_AVG}${NC}"
    
    # Memory info
    MEM_TOTAL=$(free -h | awk '/^Mem:/ {print $2}')
    MEM_USED=$(free -h | awk '/^Mem:/ {print $3}')
    MEM_FREE=$(free -h | awk '/^Mem:/ {print $4}')
    MEM_PERCENT=$(free | awk '/^Mem:/ {printf("%.1f"), ($3/$2)*100}')
    
    echo -e "${WHITE}Memory Total:${NC}    $MEM_TOTAL"
    echo -e "${WHITE}Memory Used:${NC}     ${YELLOW}${MEM_USED}${NC} (${MEM_PERCENT}%)"
    echo -e "${WHITE}Memory Free:${NC}     ${GREEN}${MEM_FREE}${NC}"
    echo ""
}

# Function to show disk usage
show_disk() {
    echo -e "${BOLD}${MAGENTA}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${MAGENTA}║                    💾 DISK USAGE                             ║${NC}"
    echo -e "${BOLD}${MAGENTA}╚══════════════════════════════════════════════════════════════╝${NC}"
    
    df -h / | tail -n 1 | awk '{printf "'"${WHITE}Filesystem:${NC}"'     %s\n'"${WHITE}Size:${NC}"'           %s\n'"${WHITE}Used:${NC}"'           '"${YELLOW}%s${NC}"' (%s)\n'"${WHITE}Available:${NC}"'      '"${GREEN}%s${NC}"'\n", $1, $2, $3, $5, $4}'
    echo ""
}

# Function to show project processes
show_processes() {
    echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${BLUE}║              🔄 OPENSPLATTING PROCESSES                      ║${NC}"
    echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
    
    # Check for Python processes related to the project
    PYTHON_PROCS=$(ps aux | grep -E "(flask|opensplat|colmap|app\.py)" | grep -v grep | wc -l)
    
    if [ "$PYTHON_PROCS" -gt 0 ]; then
        ps aux | grep -E "(flask|opensplat|colmap|app\.py)" | grep -v grep | awk '{printf "'"${GREEN}%-8s${NC}"' '"${WHITE}%-10s${NC}"' '"${YELLOW}%s${NC}"'\n", $2, $3"%", substr($0, index($0,$11))}'
    else
        echo -e "${YELLOW}No OpenSplatting processes running${NC}"
    fi
    echo ""
}

# Function to show CUDA info
show_cuda_info() {
    echo -e "${BOLD}${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${YELLOW}║                    ⚡ CUDA TOOLKIT                           ║${NC}"
    echo -e "${BOLD}${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
    
    if command -v nvcc &> /dev/null; then
        CUDA_VERSION=$(nvcc --version | grep "release" | awk '{print $5}' | cut -d',' -f1)
        CUDA_PATH=$(which nvcc | sed 's/\/bin\/nvcc//')
        echo -e "${WHITE}CUDA Version:${NC}    ${GREEN}${CUDA_VERSION}${NC}"
        echo -e "${WHITE}CUDA Path:${NC}       ${CYAN}${CUDA_PATH}${NC}"
    else
        echo -e "${RED}CUDA Toolkit not found in PATH${NC}"
    fi
    echo ""
}

# Main monitoring loop
clear
echo -e "${BOLD}${WHITE}"
cat << "EOF"
╔═══════════════════════════════════════════════════════════════════════╗
║                                                                       ║
║    ██████╗  ██████╗ ██████╗ ██╗███╗   ███╗                          ║
║    ██╔══██╗██╔═══██╗██╔══██╗██║████╗ ████║                          ║
║    ██████╔╝██║   ██║██████╔╝██║██╔████╔██║                          ║
║    ██╔═══╝ ██║   ██║██╔══██╗██║██║╚██╔╝██║                          ║
║    ██║     ╚██████╔╝██████╔╝██║██║ ╚═╝ ██║                          ║
║    ╚═╝      ╚═════╝ ╚═════╝ ╚═╝╚═╝     ╚═╝                          ║
║                                                                       ║
║           OpenSplatting System Monitor v1.0                          ║
║                                                                       ║
╚═══════════════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"

echo -e "${CYAN}Press Ctrl+C to exit. Refreshing every ${REFRESH_INTERVAL} seconds...${NC}\n"
sleep 2

while true; do
    clear
    echo -e "${BOLD}${WHITE}═══════════════════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}${WHITE}     POBIM OpenSplatting System Monitor - $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo -e "${BOLD}${WHITE}═══════════════════════════════════════════════════════════════════════${NC}\n"
    
    show_gpu_info
    show_cpu_memory
    show_disk
    show_cuda_info
    show_processes
    
    echo -e "${CYAN}Refreshing in ${REFRESH_INTERVAL}s... (Press Ctrl+C to exit)${NC}"
    sleep "$REFRESH_INTERVAL"
done

