#!/usr/bin/env python3
"""
Transfer vertex colors from dense point cloud to mesh
"""

import sys
import numpy as np
from pathlib import Path
from scipy.spatial import cKDTree

backend_path = Path(__file__).parent
sys.path.insert(0, str(backend_path))

def transfer_colors_to_mesh(mesh_path, point_cloud_path, output_path):
    """
    Transfer colors from dense point cloud to mesh using nearest neighbor.

    Args:
        mesh_path: Path to mesh PLY (without colors)
        point_cloud_path: Path to dense point cloud PLY (with colors)
        output_path: Output mesh path with colors
    """
    try:
        from plyfile import PlyData
        import trimesh

        print(f"📥 Loading mesh: {mesh_path.name}")
        mesh = trimesh.load(str(mesh_path))
        print(f"   Vertices: {len(mesh.vertices):,}")
        print(f"   Faces: {len(mesh.faces):,}")

        print(f"\n📥 Loading dense point cloud: {point_cloud_path.name}")
        plydata = PlyData.read(str(point_cloud_path))
        vertex = plydata['vertex']

        # Extract point cloud positions and colors
        pc_positions = np.vstack([vertex['x'], vertex['y'], vertex['z']]).T
        pc_colors = np.vstack([vertex['red'], vertex['green'], vertex['blue']]).T

        print(f"   Points: {len(pc_positions):,}")
        print(f"   Has colors: {pc_colors.shape}")

        # Build KD-tree for nearest neighbor search
        print(f"\n🔍 Building KD-tree for color transfer...")
        tree = cKDTree(pc_positions)

        # Find nearest point cloud point for each mesh vertex
        print(f"🎨 Transferring colors to mesh vertices...")
        distances, indices = tree.query(mesh.vertices, k=1)

        # Transfer colors
        vertex_colors = pc_colors[indices]

        # Add alpha channel
        vertex_colors_rgba = np.hstack([
            vertex_colors,
            np.full((len(vertex_colors), 1), 255)  # Alpha = 255
        ]).astype(np.uint8)

        # Assign to mesh
        mesh.visual.vertex_colors = vertex_colors_rgba

        print(f"\n💾 Saving colored mesh: {output_path.name}")
        mesh.export(str(output_path))

        print(f"✅ Success! Mesh now has vertex colors")
        print(f"   Average transfer distance: {np.mean(distances):.4f}")
        print(f"   Max transfer distance: {np.max(distances):.4f}")

        return True

    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return False


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Transfer vertex colors from dense point cloud to mesh")
    parser.add_argument("mesh_path", help="Input mesh PLY file (without colors)")
    parser.add_argument("point_cloud_path", help="Dense point cloud PLY file (with colors)")
    parser.add_argument("output_path", help="Output file path")
    parser.add_argument("--format", default="glb", choices=["glb", "obj", "ply", "dae"], help="Output format")
    args = parser.parse_args()

    mesh_path = Path(args.mesh_path)
    point_cloud_path = Path(args.point_cloud_path)
    output_path = Path(args.output_path)
    
    # Create output directory
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    # If output format is PLY, use it directly; otherwise use temporary PLY
    if args.format == 'ply':
        output_ply_temp = output_path
    else:
        output_ply_temp = output_path.parent / f"{output_path.stem}_temp.ply"

    print("="*70)
    print("  VERTEX COLOR TRANSFER")
    print("="*70)
    print()

    # Transfer colors to PLY first
    success = transfer_colors_to_mesh(mesh_path, point_cloud_path, output_ply_temp)

    if success:
        if args.format == 'ply':
            # Already in PLY format, just report success
            file_size_mb = output_path.stat().st_size / (1024*1024)
            print("\n" + "="*70)
            print("✅ EXPORT COMPLETED!")
            print("="*70)
            print(f"\n� Output file:")
            print(f"   {output_path}")
            print(f"   Size: {file_size_mb:.1f} MB")
            print()
        else:
            # Convert to requested format
            print("\n" + "="*70)
            print(f"�📦 Converting to {args.format.upper()} format...")
            print("="*70)

            try:
                import trimesh
                mesh = trimesh.load(str(output_ply_temp))

                # Export to the requested format
                print(f"\n📄 Exporting to: {output_path.name}")
                mesh.export(str(output_path))
                file_size_mb = output_path.stat().st_size / (1024*1024)
                print(f"   ✅ Size: {file_size_mb:.1f} MB")

                # Clean up temporary file
                if output_ply_temp != output_path:
                    output_ply_temp.unlink()

                print("\n" + "="*70)
                print("✅ EXPORT COMPLETED!")
                print("="*70)
                print(f"\n📁 Output file:")
                print(f"   {output_path}")
                print()

            except Exception as e:
                print(f"\n⚠️  Export failed: {e}")
                import traceback
                traceback.print_exc()
                sys.exit(1)
        
        print("💡 Import into Blender:")
        if args.format == 'glb':
            print("   1. File → Import → glTF (.glb)")
        elif args.format == 'obj':
            print("   1. File → Import → Wavefront (.obj)")
        elif args.format == 'dae':
            print("   1. File → Import → Collada (.dae)")
        else:
            print("   1. File → Import → PLY (.ply)")
        print("   2. In Shading workspace, set viewport shading to 'Solid'")
        print("   3. In the shading panel, set Color to 'Vertex'")
        print("   4. You should now see colors!")
        print()
