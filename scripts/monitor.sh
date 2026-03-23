#!/bin/bash

# System Monitor Script for POBIMOpenSplatting
# Modern Dashboard with Vertical Bar Charts (Last 10 readings)
# Monitors GPU, CPU, Memory, Disk with trend visualization

# Refresh interval (seconds)
REFRESH_INTERVAL=${1:-2}

# History arrays (10 readings each)
declare -a GPU_HIST=()
declare -a GPU_MEM_HIST=()
declare -a CPU_HIST=()
declare -a MEM_HIST=()

# Chart height (rows)
CHART_HEIGHT=8

# Column width (characters for chart area)
COL_WIDTH=37

# Get color based on value
get_color() {
    local val=$1
    if [ "$val" -gt 80 ]; then
        echo "\e[31m"  # red
    elif [ "$val" -gt 50 ]; then
        echo "\e[33m"  # yellow
    else
        echo "\e[32m"  # green
    fi
}

# Gather all system info and update history
gather_info() {
    # GPU Info
    if command -v nvidia-smi &> /dev/null; then
        GPU_UTIL=$(nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')
        GPU_MEM=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')
        GPU_MEM_TOTAL=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')
        GPU_TEMP=$(nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader,nounits 2>/dev/null | head -n 1 | tr -d ' ')
        GPU_POWER=$(nvidia-smi --query-gpu=power.draw --format=csv,noheader 2>/dev/null | head -n 1 | tr -d ' ')
        GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n 1)
        if [ -n "$GPU_MEM_TOTAL" ] && [ "$GPU_MEM_TOTAL" -gt 0 ]; then
            GPU_MEM_PERCENT=$((GPU_MEM * 100 / GPU_MEM_TOTAL))
        else
            GPU_MEM_PERCENT=0
        fi
        HAS_GPU=1
        
        # Update GPU history
        GPU_HIST+=("$GPU_UTIL")
        GPU_MEM_HIST+=("$GPU_MEM_PERCENT")
        # Keep only last 10
        if [ ${#GPU_HIST[@]} -gt 10 ]; then GPU_HIST=("${GPU_HIST[@]:1}"); fi
        if [ ${#GPU_MEM_HIST[@]} -gt 10 ]; then GPU_MEM_HIST=("${GPU_MEM_HIST[@]:1}"); fi
    else
        HAS_GPU=0
        GPU_UTIL=0
        GPU_MEM_PERCENT=0
    fi
    
    # CPU Info
    CPU_USAGE=$(top -bn1 | grep "Cpu(s)" | awk '{print int($2)}')
    CPU_CORES=$(nproc)
    LOAD_AVG=$(uptime | awk -F'load average:' '{print $2}' | cut -d',' -f1 | tr -d ' ')
    
    # Update CPU history
    CPU_HIST+=("$CPU_USAGE")
    if [ ${#CPU_HIST[@]} -gt 10 ]; then CPU_HIST=("${CPU_HIST[@]:1}"); fi
    
    # Memory Info
    MEM_TOTAL=$(free -h | awk '/^Mem:/ {print $2}')
    MEM_USED=$(free -h | awk '/^Mem:/ {print $3}')
    MEM_PERCENT=$(free | awk '/^Mem:/ {printf("%d"), ($3/$2)*100}')
    
    # Update Memory history
    MEM_HIST+=("$MEM_PERCENT")
    if [ ${#MEM_HIST[@]} -gt 10 ]; then MEM_HIST=("${MEM_HIST[@]:1}"); fi
    
    # Disk Info
    DISK_INFO=$(df -h / | tail -n 1)
    DISK_SIZE=$(echo "$DISK_INFO" | awk '{print $2}')
    DISK_USED=$(echo "$DISK_INFO" | awk '{print $3}')
    DISK_AVAIL=$(echo "$DISK_INFO" | awk '{print $4}')
    DISK_PERCENT=$(echo "$DISK_INFO" | awk '{gsub(/%/,""); print $5}')
    
    # CUDA Info
    if command -v nvcc &> /dev/null; then
        CUDA_VERSION=$(nvcc --version 2>/dev/null | grep "release" | awk '{print $5}' | cut -d',' -f1)
        HAS_CUDA=1
    else
        HAS_CUDA=0
        CUDA_VERSION="N/A"
    fi
}

# Draw the dashboard
draw_dashboard() {
    # Header
    printf "\e[1;36m┌───────────────────────────────────────────────────────────────────────────┐\e[0m\n"
    printf "\e[1;36m│\e[0m \e[1;37m🖥️  POBIM OpenSplatting System Monitor\e[0m        \e[1;33m$(date '+%Y-%m-%d %H:%M:%S')\e[0m \e[1;36m         │\e[0m\n"
    printf "\e[1;36m└───────────────────────────────────────────────────────────────────────────┘\e[0m\n"
    echo ""
    
    # Two column layout with charts (each column = 37 chars)
    printf "\e[1;36m┌─────────────────────────────────────┬─────────────────────────────────────┐\e[0m\n"
    printf "\e[1;36m│\e[0m \e[1;36m🎮 GPU UTILIZATION\e[0m                  \e[1;36m│\e[0m \e[1;32m💻 CPU USAGE\e[0m                       \e[1;36m │\e[0m\n"
    
    # Draw GPU and CPU charts side by side
    local gpu_current=${GPU_HIST[-1]:-0}
    local cpu_current=${CPU_HIST[-1]:-0}
    local gpu_color=$(get_color $gpu_current)
    local cpu_color=$(get_color $cpu_current)
    
    # Title row with values
    printf "\e[1;36m│\e[0m ${gpu_color}%3d%%\e[0m " "$gpu_current"
    if [ "$HAS_GPU" -eq 1 ]; then
        printf "\e[2m%-27.27s\e[0m" "$GPU_NAME"
    else
        printf "\e[31m%-27s\e[0m" "No GPU"
    fi
    printf "    \e[1;36m│\e[0m ${cpu_color}%3d%%\e[0m \e[2mCores:%-2d Load:%-7s\e[0m          \e[1;36m│\e[0m\n" "$cpu_current" "$CPU_CORES" "$LOAD_AVG"
    
    # Chart rows
    for ((row=CHART_HEIGHT; row>=1; row--)); do
        local threshold=$((row * 100 / CHART_HEIGHT))
        
        # GPU chart column
        printf "\e[1;36m│\e[0m"
        if [ $row -eq $CHART_HEIGHT ]; then
            printf "\e[2m100│\e[0m"
        elif [ $row -eq $((CHART_HEIGHT/2)) ]; then
            printf "\e[2m 50│\e[0m"
        elif [ $row -eq 1 ]; then
            printf "\e[2m  0│\e[0m"
        else
            printf "\e[2m   │\e[0m"
        fi
        
        for ((i=0; i<10; i++)); do
            local idx=$((${#GPU_HIST[@]} - 10 + i))
            local val=0
            if [ $idx -ge 0 ] && [ $idx -lt ${#GPU_HIST[@]} ]; then
                val=${GPU_HIST[$idx]}
            fi
            if [ "$val" -ge "$threshold" ]; then
                printf "$(get_color $val)██\e[0m "
            else
                printf "   "
            fi
        done
        
        printf "   "
        printf "\e[1;36m│\e[0m"
        
        # CPU chart column
        if [ $row -eq $CHART_HEIGHT ]; then
            printf "\e[2m100│\e[0m"
        elif [ $row -eq $((CHART_HEIGHT/2)) ]; then
            printf "\e[2m 50│\e[0m"
        elif [ $row -eq 1 ]; then
            printf "\e[2m  0│\e[0m"
        else
            printf "\e[2m   │\e[0m"
        fi
        
        for ((i=0; i<10; i++)); do
            local idx=$((${#CPU_HIST[@]} - 10 + i))
            local val=0
            if [ $idx -ge 0 ] && [ $idx -lt ${#CPU_HIST[@]} ]; then
                val=${CPU_HIST[$idx]}
            fi
            if [ "$val" -ge "$threshold" ]; then
                printf "$(get_color $val)██\e[0m "
            else
                printf "   "
            fi
        done
        printf "   "
        printf "\e[1;36m│\e[0m\n"
    done
    
    printf "\e[1;36m│\e[0m\e[2m   └──────────────────────────────   \e[0m\e[1;36m│\e[0m\e[2m   └──────────────────────────────   \e[0m\e[1;36m│\e[0m\n"
    
    # Second row: GPU Memory and System Memory
    printf "\e[1;36m├─────────────────────────────────────┼─────────────────────────────────────┤\e[0m\n"
    printf "\e[1;36m│\e[0m \e[1;35m🎮 GPU MEMORY\e[0m                       \e[1;36m│\e[0m \e[1;33m🧠 SYSTEM MEMORY\e[0m                    \e[1;36m│\e[0m\n"
    
    local gpu_mem_current=${GPU_MEM_HIST[-1]:-0}
    local mem_current=${MEM_HIST[-1]:-0}
    local gm_color=$(get_color $gpu_mem_current)
    local m_color=$(get_color $mem_current)
    
    printf "\e[1;36m│\e[0m ${gm_color}%3d%%\e[0m \e[2m%-5s / %-5s MiB\e[0m              \e[1;36m│\e[0m ${m_color}%3d%%\e[0m \e[2m%-5s / %-5s\e[0m                  \e[1;36m│\e[0m\n" "$gpu_mem_current" "$GPU_MEM" "$GPU_MEM_TOTAL" "$mem_current" "$MEM_USED" "$MEM_TOTAL"
    
    # Chart rows for memory
    for ((row=CHART_HEIGHT; row>=1; row--)); do
        local threshold=$((row * 100 / CHART_HEIGHT))
        
        # GPU Memory chart
        printf "\e[1;36m│\e[0m"
        if [ $row -eq $CHART_HEIGHT ]; then
            printf "\e[2m100│\e[0m"
        elif [ $row -eq $((CHART_HEIGHT/2)) ]; then
            printf "\e[2m 50│\e[0m"
        elif [ $row -eq 1 ]; then
            printf "\e[2m  0│\e[0m"
        else
            printf "\e[2m   │\e[0m"
        fi
        
        for ((i=0; i<10; i++)); do
            local idx=$((${#GPU_MEM_HIST[@]} - 10 + i))
            local val=0
            if [ $idx -ge 0 ] && [ $idx -lt ${#GPU_MEM_HIST[@]} ]; then
                val=${GPU_MEM_HIST[$idx]}
            fi
            if [ "$val" -ge "$threshold" ]; then
                printf "$(get_color $val)██\e[0m "
            else
                printf "   "
            fi
        done
        
        printf "   "
        printf "\e[1;36m│\e[0m"
        
        # System Memory chart
        if [ $row -eq $CHART_HEIGHT ]; then
            printf "\e[2m100│\e[0m"
        elif [ $row -eq $((CHART_HEIGHT/2)) ]; then
            printf "\e[2m 50│\e[0m"
        elif [ $row -eq 1 ]; then
            printf "\e[2m  0│\e[0m"
        else
            printf "\e[2m   │\e[0m"
        fi
        
        for ((i=0; i<10; i++)); do
            local idx=$((${#MEM_HIST[@]} - 10 + i))
            local val=0
            if [ $idx -ge 0 ] && [ $idx -lt ${#MEM_HIST[@]} ]; then
                val=${MEM_HIST[$idx]}
            fi
            if [ "$val" -ge "$threshold" ]; then
                printf "$(get_color $val)██\e[0m "
            else
                printf "   "
            fi
        done
        printf "   "
        printf "\e[1;36m│\e[0m\n"
    done
    
    printf "\e[1;36m│\e[0m\e[2m   └──────────────────────────────   \e[0m\e[1;36m│\e[0m\e[2m   └──────────────────────────────   \e[0m\e[1;36m│\e[0m\n"
    printf "\e[1;36m└─────────────────────────────────────┴─────────────────────────────────────┘\e[0m\n"
    
    # Info bar
    echo ""
    printf "\e[1;34m┌───────────────────────────────────────────────────────────────────────────┐\e[0m\n"
    printf "\e[1;34m│\e[0m \e[1;35m💾 DISK:\e[0m %-5s/%-5s (%2d%%) \e[1;33m⚡CUDA:\e[0m %-6s \e[1;36m🌡️ GPU:\e[0m %2d°C %-8s \e[1;34m│\e[0m\n" "$DISK_USED" "$DISK_SIZE" "$DISK_PERCENT" "$CUDA_VERSION" "$GPU_TEMP" "$GPU_POWER"
    printf "\e[1;34m└───────────────────────────────────────────────────────────────────────────┘\e[0m\n"
    
    # Processes
    echo ""
    printf "\e[1;34m┌───────────────────────────────────────────────────────────────────────────┐\e[0m\n"
    printf "\e[1;34m│\e[0m \e[1;37m🔄 ACTIVE PROCESSES\e[0m                                                     \e[1;34m│\e[0m\n"
    printf "\e[1;34m├───────────────────────────────────────────────────────────────────────────┤\e[0m\n"
    
    local proc_count=$(ps aux | grep -E "(flask|opensplat|colmap|app\.py)" | grep -v grep | wc -l)
    if [ "$proc_count" -gt 0 ]; then
        ps aux | grep -E "(flask|opensplat|colmap|app\.py)" | grep -v grep | head -3 | while read -r line; do
            pid=$(echo "$line" | awk '{print $2}')
            cpu=$(echo "$line" | awk '{print $3}')
            cmd=$(echo "$line" | awk '{for(i=11;i<=NF;i++) printf "%s ", $i}' | cut -c1-58)
            printf "\e[1;34m│\e[0m \e[32m%-7s\e[0m \e[33m%5s%%\e[0m \e[37m%-60s\e[0m \e[1;34m│\e[0m\n" "$pid" "$cpu" "$cmd"
        done
    else
        printf "\e[1;34m│\e[0m \e[33mNo OpenSplatting processes running\e[0m                                         \e[1;34m│\e[0m\n"
    fi
    
    # GPU processes
    if [ "$HAS_GPU" -eq 1 ]; then
        local gpu_procs=$(nvidia-smi --query-compute-apps=pid --format=csv,noheader 2>/dev/null | wc -l)
        if [ "$gpu_procs" -gt 0 ]; then
            nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader 2>/dev/null | head -2 | while IFS=, read -r pid name mem; do
                shortname=$(basename "$name" | cut -c1-35)
                printf "\e[1;34m│\e[0m \e[36mGPU\e[0m \e[32m%-7s\e[0m \e[37m%-35s\e[0m \e[35m%-14s\e[0m             \e[1;34m│\e[0m\n" "$pid" "$shortname" "$mem"
            done
        fi
    fi
    
    printf "\e[1;34m└───────────────────────────────────────────────────────────────────────────┘\e[0m\n"
    
    # Footer
    printf "\e[2m───────────────────────────────────────────────────────────────────────────\e[0m\n"
    printf " \e[36mRefresh: ${REFRESH_INTERVAL}s\e[0m │ \e[37mCtrl+C\e[0m to exit │ \e[35mPOBIM OpenSplatting Monitor v3.0\e[0m\n"
}

# Show intro
clear
printf "\e[1;35m"
cat << "EOF"

    ██████╗  ██████╗ ██████╗ ██╗███╗   ███╗
    ██╔══██╗██╔═══██╗██╔══██╗██║████╗ ████║
    ██████╔╝██║   ██║██████╔╝██║██╔████╔██║
    ██╔═══╝ ██║   ██║██╔══██╗██║██║╚██╔╝██║
    ██║     ╚██████╔╝██████╔╝██║██║ ╚═╝ ██║
    ╚═╝      ╚═════╝ ╚═════╝ ╚═╝╚═╝     ╚═╝

      System Monitor v3.0 - Trend Charts

EOF
printf "\e[0m"
printf "\e[36mStarting monitor with trend visualization...\e[0m\n"
sleep 1

# Main loop
while true; do
    clear
    gather_info
    draw_dashboard
    sleep "$REFRESH_INTERVAL"
done
