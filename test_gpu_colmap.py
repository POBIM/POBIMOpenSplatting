#!/usr/bin/env python3
"""
Simple test script to verify GPU-accelerated COLMAP functionality
"""

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT))

import subprocess
import os


def get_colmap_executable():
    candidates = [
        PROJECT_ROOT / "colmap-build" / "src" / "colmap" / "exe" / "colmap",
        Path("/usr/local/bin/colmap"),
    ]
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return "colmap"


def get_colmap_config(image_count):
    return {
        "max_num_features": 8192 if image_count < 100 else 4096,
        "matcher_type": "exhaustive" if image_count <= 80 else "sequential",
        "use_gpu": True,
    }

def test_colmap_gpu():
    print("=== Testing GPU-accelerated COLMAP ===")

    # Get the COLMAP executable
    colmap_exe = get_colmap_executable()
    print(f"Using COLMAP executable: {colmap_exe}")

    # Test COLMAP help
    try:
        result = subprocess.run([colmap_exe, '--help'],
                              capture_output=True, text=True, timeout=10)
        if 'with CUDA' in result.stdout:
            print("✅ COLMAP confirms CUDA support!")
        else:
            print("❌ COLMAP did not report CUDA support")
            sys.exit(1)

    except Exception as e:
        print(f"❌ Error testing COLMAP: {e}")
        sys.exit(1)

    # Test feature extractor GPU options
    try:
        result = subprocess.run([colmap_exe, 'feature_extractor', '--help'],
                              capture_output=True, text=True, timeout=10)
        help_text = result.stdout + result.stderr
        if 'use_gpu' in help_text:
            print("✅ Feature extraction GPU support confirmed!")
        else:
            print("❌ No GPU options found in feature extractor")
            sys.exit(1)

    except Exception as e:
        print(f"❌ Error testing feature extractor: {e}")
        sys.exit(1)

    # Test COLMAP configuration
    print("\n=== Testing COLMAP Configuration ===")
    config = get_colmap_config(50)  # Test with 50 images
    print(f"✅ COLMAP config generated successfully")
    print(f"   Max features: {config['max_num_features']}")
    print(f"   Matcher type: {config['matcher_type']}")

if __name__ == "__main__":
    test_colmap_gpu()
