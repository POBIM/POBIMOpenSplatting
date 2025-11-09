#!/usr/bin/env python3
"""
Quick command to generate textured GLB mesh from existing COLMAP reconstruction
Usage: python quick_mesh_export.py <project_id>

This assumes you've already run dense reconstruction.
If you haven't, use run_textured_mesh_direct.py instead.
"""
import sys
import time
import subprocess
from pathlib import Path

# Add Backend to path
sys.path.insert(0, str(Path(__file__).parent))

from core.config import RESULTS_FOLDER, UPLOAD_FOLDER

def main():
    if len(sys.argv) < 2:
        print("❌ Usage: python quick_mesh_export.py <project_id>")
        print("\n💡 This script uses existing dense reconstruction and mesh files.")
        print("   It transfers vertex colors and exports to GLB/OBJ/PLY formats.")
        sys.exit(1)
    
    project_id = sys.argv[1]
    
    # Check if project exists
    project_path = UPLOAD_FOLDER / project_id
    if not project_path.exists():
        print(f"❌ Project not found: {project_id}")
        print(f"   Path: {project_path}")
        sys.exit(1)
    
    # Check if dense reconstruction exists
    dense_path = project_path / "dense"
    fused_ply = dense_path / "fused.ply"
    
    if not fused_ply.exists():
        print(f"❌ Dense reconstruction not found!")
        print(f"   Expected: {fused_ply}")
        print(f"\n💡 Run dense reconstruction first:")
        print(f"   python run_textured_mesh_direct.py {project_id}")
        sys.exit(1)
    
    # Find mesh file
    mesh_files = list(dense_path.glob("*_textured_*.ply"))
    if not mesh_files:
        # Try without textured prefix
        mesh_files = list(dense_path.glob("mesh_*.ply"))
    
    if not mesh_files:
        print(f"❌ Mesh file not found in {dense_path}")
        print(f"\n💡 Run meshing first:")
        print(f"   python run_textured_mesh_direct.py {project_id}")
        sys.exit(1)
    
    mesh_file = mesh_files[0]
    
    print("=" * 70)
    print("  VERTEX COLOR TRANSFER & EXPORT")
    print("=" * 70)
    print(f"Project ID:   {project_id}")
    print(f"Dense Cloud:  {fused_ply.name} ({fused_ply.stat().st_size / 1024 / 1024:.1f} MB)")
    print(f"Mesh File:    {mesh_file.name} ({mesh_file.stat().st_size / 1024 / 1024:.1f} MB)")
    print("=" * 70)
    print()
    
    # Run add_colors_to_mesh.py
    start_time = time.time()
    
    print("🔄 Transferring vertex colors...")
    result = subprocess.run(
        [sys.executable, "add_colors_to_mesh.py"],
        cwd=Path(__file__).parent,
        capture_output=False,
        text=True
    )
    
    if result.returncode != 0:
        print(f"\n❌ Color transfer failed!")
        sys.exit(1)
    
    elapsed = time.time() - start_time
    
    # Check output files
    results_path = RESULTS_FOLDER / project_id
    glb_file = results_path / f"{project_id}_colored_mesh.glb"
    obj_file = results_path / f"{project_id}_colored_mesh.obj"
    ply_file = results_path / f"{project_id}_colored_mesh.ply"
    
    print()
    print("=" * 70)
    print("  ✅ SUCCESS!")
    print("=" * 70)
    
    if glb_file.exists():
        print(f"GLB File: {glb_file}")
        print(f"          ({glb_file.stat().st_size / 1024 / 1024:.1f} MB)")
    
    if obj_file.exists():
        print(f"OBJ File: {obj_file}")
        print(f"          ({obj_file.stat().st_size / 1024 / 1024:.1f} MB)")
    
    if ply_file.exists():
        print(f"PLY File: {ply_file}")
        print(f"          ({ply_file.stat().st_size / 1024 / 1024:.1f} MB)")
    
    print(f"Duration: {elapsed:.1f} seconds")
    print("=" * 70)
    print()
    print("📍 Import in Blender:")
    print(f"   File → Import → glTF 2.0 (.glb)")
    print(f"   {glb_file}")
    print()
    print("🎨 Enable Vertex Colors:")
    print(f"   1. Press Z → Solid")
    print(f"   2. Shading dropdown (top right) → Attribute → Col")
    print()

if __name__ == "__main__":
    main()
