#!/usr/bin/env python3
"""
Run textured mesh generation for project f487f0a3-7c6d-4524-9f7e-6c23e249142b
Using COLMAP with CUDA for fast dense reconstruction
"""

import sys
import time
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent
sys.path.insert(0, str(backend_path))

from services.mvs_mesher import MVSMesher
from core.commands import find_colmap_executable

def main():
    # Project details
    project_id = "f487f0a3-7c6d-4524-9f7e-6c23e249142b"
    project_path = backend_path / "uploads" / project_id
    sparse_path = project_path / "sparse" / "0"

    # Find COLMAP executable
    colmap_cuda = find_colmap_executable()

    # Output directory
    output_dir = backend_path / "results" / project_id
    output_dir.mkdir(exist_ok=True, parents=True)

    print("="*70)
    print("  TEXTURED MESH GENERATION WITH COLMAP CUDA")
    print("="*70)
    print()
    print(f"📦 Project ID: {project_id}")
    print(f"📂 Project Path: {project_path}")
    print(f"🔍 Sparse Model: {sparse_path}")
    print(f"🚀 COLMAP: {colmap_cuda}")
    print()

    # Check paths
    if not project_path.exists():
        print(f"❌ Project path not found: {project_path}")
        return False

    if not sparse_path.exists():
        print(f"❌ Sparse reconstruction not found: {sparse_path}")
        return False

    # Count images
    images_path = project_path / "images"
    num_images = len(list(images_path.glob("*.jpg")))
    print(f"📸 Images: {num_images}")
    print()

    # Estimate time
    print("⏱️  Estimated time with CUDA:")
    print("   - Low quality: 3-5 minutes")
    print("   - Medium quality: 8-15 minutes")
    print("   - High quality: 20-40 minutes")
    print()

    # Ask user
    quality = input("Select quality (low/medium/high) [medium]: ").strip().lower()
    if quality not in ['low', 'medium', 'high']:
        quality = 'medium'

    method = input("Select method (poisson/delaunay) [poisson]: ").strip().lower()
    if method not in ['poisson', 'delaunay']:
        method = 'poisson'

    print()
    print(f"🎯 Configuration:")
    print(f"   Quality: {quality}")
    print(f"   Method: {method}")
    print()

    # Create mesher
    mesher = MVSMesher(colmap_cuda)

    # Output files
    output_ply = output_dir / f"{project_id}_textured_{method}_{quality}.ply"
    output_obj = output_dir / f"{project_id}_textured_{method}_{quality}.obj"

    print("="*70)
    print("🚀 Starting dense reconstruction...")
    print("="*70)
    print()

    start_time = time.time()

    try:
        # Step 1: Dense reconstruction
        print("Step 1/3: Dense Reconstruction")
        print("-" * 70)
        dense_path = mesher.run_dense_reconstruction(
            project_path=project_path,
            sparse_model_path=sparse_path,
            quality=quality,
            num_threads=-1  # Auto
        )

        step1_time = time.time() - start_time
        print(f"✅ Dense reconstruction completed in {step1_time/60:.1f} minutes")
        print()

        # Step 2: Create mesh
        print("Step 2/3: Mesh Generation")
        print("-" * 70)

        if method == "poisson":
            success = mesher.create_textured_mesh_poisson(
                dense_path=dense_path,
                output_path=output_ply,
                trim_value=10
            )
        else:
            success = mesher.create_textured_mesh_delaunay(
                dense_path=dense_path,
                output_path=output_ply
            )

        if not success:
            print("❌ Meshing failed")
            return False

        step2_time = time.time() - start_time - step1_time
        print(f"✅ Mesh generation completed in {step2_time/60:.1f} minutes")
        print()

        # Step 3: Convert to OBJ (optional)
        print("Step 3/3: Converting to OBJ format")
        print("-" * 70)

        try:
            import pymeshlab
            ms = pymeshlab.MeshSet()
            ms.load_new_mesh(str(output_ply))

            # Export to OBJ
            ms.save_current_mesh(
                str(output_obj),
                save_vertex_color=True,
                save_face_color=True
            )

            print(f"✅ Exported to OBJ format")
        except Exception as e:
            print(f"⚠️  OBJ export failed: {e}")
            print("   PLY file is still available")

        # Summary
        total_time = time.time() - start_time
        print()
        print("="*70)
        print("✅ TEXTURED MESH GENERATION COMPLETED!")
        print("="*70)
        print()
        print(f"⏱️  Total time: {total_time/60:.1f} minutes")
        print()
        print("📁 Output files:")

        if output_ply.exists():
            size_mb = output_ply.stat().st_size / (1024 * 1024)
            print(f"   PLY: {output_ply.name} ({size_mb:.1f} MB)")
            print(f"        {output_ply}")

        if output_obj.exists():
            size_mb = output_obj.stat().st_size / (1024 * 1024)
            print(f"   OBJ: {output_obj.name} ({size_mb:.1f} MB)")
            print(f"        {output_obj}")

        print()
        print("💡 You can now:")
        print("   - Open PLY in MeshLab/CloudCompare")
        print("   - Import OBJ into Blender/Maya")
        print("   - Download via API endpoint")
        print()

        return True

    except Exception as e:
        elapsed = time.time() - start_time
        print()
        print("="*70)
        print(f"❌ Error after {elapsed/60:.1f} minutes")
        print("="*70)
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    try:
        success = main()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        sys.exit(1)
