#!/usr/bin/env python3
"""
Run textured mesh generation DIRECTLY (no interactive prompts)
For project f487f0a3-7c6d-4524-9f7e-6c23e249142b
"""

import sys
import time
from pathlib import Path

# Add backend to path
backend_path = Path(__file__).parent
sys.path.insert(0, str(backend_path))

from services.mvs_mesher import MVSMesher
from core.commands import find_colmap_executable

# Configuration (HARDCODED - NO PROMPTS)
PROJECT_ID = "f487f0a3-7c6d-4524-9f7e-6c23e249142b"
QUALITY = "low"  # low for fast testing
METHOD = "poisson"

def main():
    # Find COLMAP executable dynamically
    COLMAP_CUDA = find_colmap_executable()
    
    project_path = backend_path / "uploads" / PROJECT_ID
    sparse_path = project_path / "sparse" / "0"
    output_dir = backend_path / "results" / PROJECT_ID
    output_dir.mkdir(exist_ok=True, parents=True)

    print("="*70)
    print("  TEXTURED MESH GENERATION WITH COLMAP CUDA")
    print("="*70)
    print(f"\n📦 Project: {PROJECT_ID}")
    print(f"🎯 Quality: {QUALITY}")
    print(f"🔨 Method: {METHOD}")
    print(f"🚀 COLMAP: CUDA Enabled\n")

    # Check paths
    if not project_path.exists():
        print(f"❌ Project not found: {project_path}")
        return False

    if not sparse_path.exists():
        print(f"❌ Sparse reconstruction not found: {sparse_path}")
        return False

    # Count images
    images_path = project_path / "images"
    num_images = len(list(images_path.glob("*.jpg")))
    print(f"📸 Images: {num_images}\n")

    # Create mesher
    mesher = MVSMesher(COLMAP_CUDA)

    # Output files
    output_ply = output_dir / f"{PROJECT_ID}_textured_{METHOD}_{QUALITY}.ply"
    output_obj = output_dir / f"{PROJECT_ID}_textured_{METHOD}_{QUALITY}.obj"

    print("="*70)
    print("🚀 STARTING DENSE RECONSTRUCTION...")
    print("="*70)
    print()

    start_time = time.time()

    try:
        # Step 1: Dense reconstruction
        print("📍 Step 1/3: Dense Reconstruction (Image Undistortion + Stereo)")
        print("-" * 70)
        dense_path = mesher.run_dense_reconstruction(
            project_path=project_path,
            sparse_model_path=sparse_path,
            quality=QUALITY,
            num_threads=-1
        )

        step1_time = time.time() - start_time
        print(f"\n✅ Dense reconstruction completed in {step1_time/60:.1f} minutes\n")

        # Step 2: Create mesh
        print("📍 Step 2/3: Mesh Generation ({})".format(METHOD.upper()))
        print("-" * 70)

        if METHOD == "poisson":
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
        print(f"\n✅ Mesh generation completed in {step2_time/60:.1f} minutes\n")

        # Step 3: Convert to OBJ
        print("📍 Step 3/3: Converting to OBJ")
        print("-" * 70)

        try:
            import pymeshlab
            ms = pymeshlab.MeshSet()
            ms.load_new_mesh(str(output_ply))
            ms.save_current_mesh(
                str(output_obj),
                save_vertex_color=True,
                save_face_color=True
            )
            print("✅ Exported to OBJ format\n")
        except Exception as e:
            print(f"⚠️  OBJ export failed: {e}")
            print("   (PLY file is still available)\n")

        # Summary
        total_time = time.time() - start_time
        print("="*70)
        print("✅ SUCCESS! TEXTURED MESH COMPLETED!")
        print("="*70)
        print(f"\n⏱️  Total time: {total_time/60:.2f} minutes")
        print(f"   Step 1 (Dense): {step1_time/60:.2f} min")
        print(f"   Step 2 (Mesh): {step2_time/60:.2f} min")
        print(f"\n📁 Output files:\n")

        if output_ply.exists():
            size_mb = output_ply.stat().st_size / (1024 * 1024)
            print(f"   ✅ PLY: {output_ply.name}")
            print(f"      Size: {size_mb:.1f} MB")
            print(f"      Path: {output_ply}\n")

        if output_obj.exists():
            size_mb = output_obj.stat().st_size / (1024 * 1024)
            print(f"   ✅ OBJ: {output_obj.name}")
            print(f"      Size: {size_mb:.1f} MB")
            print(f"      Path: {output_obj}\n")

        print("💡 Next steps:")
        print("   - Open PLY/OBJ in MeshLab or CloudCompare")
        print("   - Import into Blender/Maya for editing")
        print("   - Download via API endpoint\n")

        return True

    except Exception as e:
        elapsed = time.time() - start_time
        print(f"\n❌ Error after {elapsed/60:.1f} minutes:")
        print(f"   {e}\n")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    print("\n" + "="*70)
    print("  Starting automated textured mesh generation...")
    print("="*70 + "\n")

    try:
        success = main()
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\n⚠️  Interrupted by user")
        sys.exit(1)
