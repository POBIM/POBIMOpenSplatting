#!/usr/bin/env python3
"""
Test script for mesh converter
"""

import sys
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent
sys.path.insert(0, str(backend_path))

from services.mesh_converter import MeshConverter

def test_conversion():
    """Test mesh conversion with a sample PLY file."""

    # Find a sample PLY file
    results_folder = backend_path / "results"
    ply_files = list(results_folder.rglob("*.ply"))

    if not ply_files:
        print("❌ No PLY files found in results folder")
        return False

    # Use the first PLY file
    test_ply = ply_files[0]
    print(f"📦 Testing with: {test_ply.name}")
    print(f"   Size: {test_ply.stat().st_size / (1024*1024):.2f} MB")

    # Create test output directory
    test_output_dir = backend_path / "test_exports"
    test_output_dir.mkdir(exist_ok=True)

    converter = MeshConverter()

    # Test 1: Point Cloud to GLB
    print("\n🧪 Test 1: Point Cloud → GLB")
    output_glb = test_output_dir / "test_pointcloud.glb"
    success = converter.convert(
        test_ply,
        output_glb,
        method="point_cloud"
    )
    if success and output_glb.exists():
        print(f"   ✅ Success! Output: {output_glb.stat().st_size / (1024*1024):.2f} MB")
    else:
        print("   ❌ Failed")

    # Test 2: Point Cloud to GLTF
    print("\n🧪 Test 2: Point Cloud → GLTF")
    output_gltf = test_output_dir / "test_pointcloud.gltf"
    success = converter.convert(
        test_ply,
        output_gltf,
        method="point_cloud"
    )
    if success and output_gltf.exists():
        print(f"   ✅ Success! Output: {output_gltf.stat().st_size / (1024):.2f} KB")
    else:
        print("   ❌ Failed")

    # Test 3: Alpha Shapes to GLB
    print("\n🧪 Test 3: Alpha Shapes (Convex Hull) → GLB")
    output_alpha = test_output_dir / "test_alpha.glb"
    success = converter.convert(
        test_ply,
        output_alpha,
        method="alpha_shapes"
    )
    if success and output_alpha.exists():
        print(f"   ✅ Success! Output: {output_alpha.stat().st_size / (1024*1024):.2f} MB")
    else:
        print("   ❌ Failed")

    # Test 4: Poisson to GLB (may take longer)
    print("\n🧪 Test 4: Poisson Surface Reconstruction → GLB")
    print("   (This may take a while...)")
    output_poisson = test_output_dir / "test_poisson.glb"
    success = converter.convert(
        test_ply,
        output_poisson,
        method="poisson",
        depth=8  # Lower depth for faster testing
    )
    if success and output_poisson.exists():
        print(f"   ✅ Success! Output: {output_poisson.stat().st_size / (1024*1024):.2f} MB")
    else:
        print("   ❌ Failed (this is expected if PyMeshLab has issues)")

    print(f"\n📁 Test outputs saved to: {test_output_dir}")
    print("\n✨ Testing complete!")

    return True

if __name__ == "__main__":
    try:
        test_conversion()
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
