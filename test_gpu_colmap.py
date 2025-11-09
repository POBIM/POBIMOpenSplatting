#!/usr/bin/env python3
"""
Simple test script to verify GPU-accelerated COLMAP functionality
"""

import sys
sys.path.insert(0, '/home/pobimgroup/POBIMOpenSplat/PobimSplats')

from app import get_colmap_executable, get_colmap_config
import subprocess
import os
from pathlib import Path

def test_colmap_gpu():
    print("=== Testing GPU-accelerated COLMAP ===")

    # Get the COLMAP executable
    colmap_exe = get_colmap_executable()
    print(f"Using COLMAP executable: {colmap_exe}")

    # Check if the GPU version exists
    if 'gpu' in colmap_exe.lower():
        print("✅ GPU-accelerated COLMAP found!")

        # Test COLMAP help
        try:
            result = subprocess.run([colmap_exe, '--help'],
                                  capture_output=True, text=True, timeout=10)
            if 'with CUDA' in result.stdout:
                print("✅ COLMAP confirms CUDA support!")
            else:
                print("⚠️ COLMAP version info unclear")

        except Exception as e:
            print(f"❌ Error testing COLMAP: {e}")

        # Test feature extractor GPU options
        try:
            result = subprocess.run([colmap_exe, 'feature_extractor', '--help'],
                                  capture_output=True, text=True, timeout=10)
            if 'use_gpu' in result.stdout:
                print("✅ Feature extraction GPU support confirmed!")
            else:
                print("⚠️ No GPU options found in feature extractor")

        except Exception as e:
            print(f"❌ Error testing feature extractor: {e}")

    else:
        print("❌ GPU-accelerated COLMAP not found, falling back to system version")

    # Test COLMAP configuration
    print("\n=== Testing COLMAP Configuration ===")
    config = get_colmap_config(50)  # Test with 50 images
    print(f"✅ COLMAP config generated successfully")
    print(f"   Max features: {config['max_num_features']}")
    print(f"   Matcher type: {config['matcher_type']}")

if __name__ == "__main__":
    test_colmap_gpu()