#!/usr/bin/env python3
"""
Test script for textured mesh generation
"""

import sys
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent
sys.path.insert(0, str(backend_path))

from services.mvs_mesher import MVSMesher

def test_textured_mesh():
    """Test textured mesh generation with a sample project."""

    # Find a project with sparse reconstruction
    uploads_folder = backend_path / "uploads"

    # Use the test project
    test_project_id = "29920924-f98d-48ab-8483-67d8ddfac564"
    project_path = uploads_folder / test_project_id
    sparse_path = project_path / "sparse" / "0"

    if not sparse_path.exists():
        print(f"❌ Sparse reconstruction not found at {sparse_path}")
        return False

    print(f"📦 Testing with project: {test_project_id}")
    print(f"   Project path: {project_path}")
    print(f"   Sparse path: {sparse_path}")

    # Count images
    images_path = project_path / "images"
    if images_path.exists():
        num_images = len(list(images_path.glob("*.*")))
        print(f"   Images: {num_images}")
    else:
        print("   ⚠️  No images folder found")
        return False

    # Create output directory
    test_output_dir = backend_path / "test_textured_meshes"
    test_output_dir.mkdir(exist_ok=True)

    # Get COLMAP executable
    colmap_exe = "colmap"

    # Create mesher
    mesher = MVSMesher(colmap_exe)

    print("\n" + "="*60)
    print("🧪 Test: Creating textured mesh with Poisson method")
    print("="*60)
    print("⚠️  WARNING: This will take a LONG time (10-30+ minutes)")
    print("   Dense reconstruction is computationally intensive")
    print("   Especially without GPU acceleration (CUDA)")
    print()

    response = input("Continue with test? (y/n): ")
    if response.lower() != 'y':
        print("Test cancelled")
        return False

    # Test output path
    output_path = test_output_dir / f"{test_project_id}_textured_poisson.ply"

    print(f"\n📍 Output will be saved to: {output_path}")
    print("\n🚀 Starting textured mesh generation...")
    print("   Step 1/3: Dense reconstruction (image undistortion)")
    print("   Step 2/3: Dense reconstruction (patch match stereo)")
    print("   Step 3/3: Meshing (Poisson)")
    print()

    try:
        success = mesher.create_full_textured_mesh(
            project_path=project_path,
            sparse_model_path=sparse_path,
            output_path=output_path,
            method="poisson",
            quality="low",  # Use low quality for faster testing
            export_format="ply"
        )

        if success and output_path.exists():
            file_size = output_path.stat().st_size / (1024 * 1024)
            print(f"\n✅ SUCCESS! Textured mesh created")
            print(f"   File: {output_path.name}")
            print(f"   Size: {file_size:.2f} MB")
            print(f"   Path: {output_path}")
            return True
        else:
            print("\n❌ FAILED: Mesh was not created")
            return False

    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    print("="*60)
    print("  TEXTURED MESH GENERATION TEST")
    print("="*60)
    print()
    print("This test will:")
    print("  1. Run COLMAP dense reconstruction (slow!)")
    print("  2. Generate mesh using Poisson reconstruction")
    print("  3. Export as PLY with vertex colors")
    print()

    try:
        result = test_textured_mesh()
        if result:
            print("\n✨ All tests completed successfully!")
            sys.exit(0)
        else:
            print("\n⚠️  Test completed with issues")
            sys.exit(1)
    except KeyboardInterrupt:
        print("\n\n⚠️  Test interrupted by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
