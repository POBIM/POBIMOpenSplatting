#!/bin/bash
# Quick script to check COLMAP build progress

echo "=== COLMAP Build Status ==="
echo ""

# Check if build process is running
if ps aux | grep -E "rebuild-colmap|cmake|make" | grep -v grep | grep -v check-colmap > /dev/null; then
    echo "✓ Build process is RUNNING"
    echo ""
    ps aux | grep -E "rebuild-colmap|cmake|make" | grep -v grep | grep -v check-colmap | awk '{print $11" "$12" "$13" "$14" "$15}'
else
    echo "✗ Build process NOT running"
fi

echo ""
echo "=== Last 15 lines of build log ==="
tail -15 /home/pobimgroup/POBIMOpenSplat/colmap-rebuild.log 2>/dev/null || echo "Log file not found"

echo ""
echo "=== Build directory status ==="
if [ -d "/home/pobimgroup/POBIMOpenSplat/colmap-build" ]; then
    echo "Build directory exists"
    if [ -f "/home/pobimgroup/POBIMOpenSplat/colmap-build/src/colmap/exe/colmap" ]; then
        echo "✓ COLMAP binary FOUND!"
        ls -lh /home/pobimgroup/POBIMOpenSplat/colmap-build/src/colmap/exe/colmap
    else
        echo "Binary not yet built"
    fi
else
    echo "Build directory not yet created"
fi
