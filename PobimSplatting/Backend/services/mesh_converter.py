#!/usr/bin/env python3
"""
Mesh Converter Service
----------------------
Converts Gaussian Splat PLY files to various mesh formats (GLTF/GLB/DAE).
Provides multiple conversion strategies for different use cases.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import Literal, Optional

import numpy as np
from plyfile import PlyData

logger = logging.getLogger(__name__)

ConversionMethod = Literal["point_cloud", "poisson", "alpha_shapes"]
ExportFormat = Literal["gltf", "glb", "dae"]


class MeshConverter:
    """Converts Gaussian Splat PLY files to mesh formats."""

    def __init__(self):
        """Initialize the mesh converter."""
        self.logger = logger

    def read_gaussian_splat_ply(self, ply_path: Path) -> dict:
        """
        Read a Gaussian Splat PLY file and extract point cloud data.

        Args:
            ply_path: Path to the PLY file

        Returns:
            Dictionary containing vertices, colors, and other properties
        """
        try:
            plydata = PlyData.read(str(ply_path))
            vertex = plydata['vertex']

            # Extract XYZ coordinates
            vertices = np.vstack([vertex['x'], vertex['y'], vertex['z']]).T

            # Extract colors (from spherical harmonics DC component if available)
            colors = None
            if all(prop in vertex for prop in ['f_dc_0', 'f_dc_1', 'f_dc_2']):
                # Convert spherical harmonics DC component to RGB
                # DC component is in range [-1, 1], need to convert to [0, 255]
                sh_dc = np.vstack([
                    vertex['f_dc_0'],
                    vertex['f_dc_1'],
                    vertex['f_dc_2']
                ]).T

                # Convert from SH to RGB (simplified conversion)
                C0 = 0.28209479177387814  # 1 / (2 * sqrt(pi))
                colors = (sh_dc / C0 + 0.5).clip(0, 1)
            elif all(prop in vertex for prop in ['red', 'green', 'blue']):
                # Standard RGB colors
                colors = np.vstack([
                    vertex['red'],
                    vertex['green'],
                    vertex['blue']
                ]).T / 255.0

            # Extract normals if available
            normals = None
            if all(prop in vertex for prop in ['nx', 'ny', 'nz']):
                normals = np.vstack([vertex['nx'], vertex['ny'], vertex['nz']]).T

            return {
                'vertices': vertices,
                'colors': colors,
                'normals': normals,
                'vertex_count': len(vertices)
            }

        except Exception as e:
            self.logger.error(f"Failed to read PLY file {ply_path}: {e}")
            raise

    def convert_to_point_cloud_gltf(
        self,
        ply_path: Path,
        output_path: Path,
        point_size: float = 0.01
    ) -> bool:
        """
        Convert PLY to GLTF as a point cloud.

        Args:
            ply_path: Input PLY file path
            output_path: Output GLTF/GLB file path
            point_size: Size of points in the point cloud

        Returns:
            True if successful, False otherwise
        """
        try:
            # Read PLY data
            data = self.read_gaussian_splat_ply(ply_path)
            vertices = data['vertices']
            colors = data.get('colors')

            # Import trimesh for mesh operations
            import trimesh

            # Create point cloud
            if colors is not None:
                # Create colored point cloud
                point_cloud = trimesh.points.PointCloud(
                    vertices=vertices,
                    colors=(colors * 255).astype(np.uint8)
                )
            else:
                point_cloud = trimesh.points.PointCloud(vertices=vertices)

            # Export to GLTF/GLB
            export_format = 'glb' if output_path.suffix.lower() == '.glb' else 'gltf'
            point_cloud.export(str(output_path), file_type=export_format)

            self.logger.info(f"Successfully exported point cloud to {output_path}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to convert to point cloud GLTF: {e}")
            return False

    def convert_to_poisson_mesh(
        self,
        ply_path: Path,
        output_path: Path,
        depth: int = 9,
        scale: float = 1.1
    ) -> bool:
        """
        Convert PLY to mesh using Poisson Surface Reconstruction.

        Args:
            ply_path: Input PLY file path
            output_path: Output file path (GLTF/GLB/DAE)
            depth: Octree depth for Poisson reconstruction (higher = more detail)
            scale: Scale factor for reconstruction

        Returns:
            True if successful, False otherwise
        """
        try:
            # Check if PyMeshLab is available
            try:
                import pymeshlab
            except ImportError:
                self.logger.error("PyMeshLab not installed. Run: pip install pymeshlab")
                return False

            # Read PLY data
            data = self.read_gaussian_splat_ply(ply_path)

            # Create temporary PLY with normals for Poisson
            with tempfile.NamedTemporaryFile(suffix='.ply', delete=False) as tmp:
                tmp_ply_path = Path(tmp.name)

            # If no normals, estimate them
            if data.get('normals') is None:
                import trimesh
                pcd = trimesh.points.PointCloud(vertices=data['vertices'])
                # Estimate normals using trimesh (simple approach)
                # For better results, use Open3D or similar
                normals = np.zeros_like(data['vertices'])
                normals[:, 2] = 1  # Default to pointing up
            else:
                normals = data['normals']

            # Create MeshSet
            ms = pymeshlab.MeshSet()

            # Load the original PLY
            ms.load_new_mesh(str(ply_path))

            # Compute normals if needed
            ms.compute_normal_for_point_clouds(k=10, smoothiter=5)

            # Apply Poisson Surface Reconstruction
            ms.generate_surface_reconstruction_screened_poisson(
                depth=depth,
                scale=scale,
                preclean=True
            )

            # Remove unreferenced vertices
            ms.meshing_remove_unreferenced_vertices()

            # Simplify mesh if too large
            target_face_count = 100000
            current_face_count = ms.current_mesh().face_number()
            if current_face_count > target_face_count:
                reduction_ratio = target_face_count / current_face_count
                ms.meshing_decimation_quadric_edge_collapse(
                    targetfacenum=target_face_count,
                    preserveboundary=True,
                    preservenormal=True,
                    preservetopology=True
                )

            # Export to desired format
            # PyMeshLab doesn't support GLB/GLTF directly, so export to OBJ first then convert
            export_format = output_path.suffix.lower().replace('.', '')

            if export_format in ['glb', 'gltf']:
                # Export to OBJ first
                with tempfile.NamedTemporaryFile(suffix='.obj', delete=False) as tmp_obj:
                    tmp_obj_path = Path(tmp_obj.name)

                ms.save_current_mesh(str(tmp_obj_path))

                # Convert OBJ to GLTF/GLB using trimesh
                import trimesh
                mesh = trimesh.load(str(tmp_obj_path))
                mesh.export(str(output_path), file_type=export_format)

                # Clean up temp file
                tmp_obj_path.unlink()
            else:
                # Direct export for supported formats (PLY, OBJ, DAE, etc.)
                ms.save_current_mesh(str(output_path))

            self.logger.info(f"Successfully created Poisson mesh with {ms.current_mesh().face_number()} faces")
            return True

        except Exception as e:
            self.logger.error(f"Failed to create Poisson mesh: {e}")
            import traceback
            traceback.print_exc()
            return False

    def convert_to_alpha_shapes_mesh(
        self,
        ply_path: Path,
        output_path: Path,
        alpha: float = 0.1
    ) -> bool:
        """
        Convert PLY to mesh using Alpha Shapes.

        Args:
            ply_path: Input PLY file path
            output_path: Output file path
            alpha: Alpha value for alpha shapes (smaller = more detail)

        Returns:
            True if successful, False otherwise
        """
        try:
            # Check if trimesh and scipy are available
            import trimesh
            from scipy.spatial import Delaunay

            # Read PLY data
            data = self.read_gaussian_splat_ply(ply_path)
            vertices = data['vertices']
            colors = data.get('colors')

            # Create convex hull as approximation (alpha shapes requires more complex implementation)
            # For a full alpha shapes implementation, use scipy.spatial or CGAL
            self.logger.info("Creating convex hull approximation...")

            hull = trimesh.convex.convex_hull(vertices)

            # Apply vertex colors if available
            if colors is not None:
                # Map original colors to hull vertices (nearest neighbor)
                from scipy.spatial import cKDTree
                tree = cKDTree(vertices)
                distances, indices = tree.query(hull.vertices)
                hull.visual.vertex_colors = (colors[indices] * 255).astype(np.uint8)

            # Export
            export_format = output_path.suffix.lower().replace('.', '')
            if export_format in ['gltf', 'glb']:
                hull.export(str(output_path), file_type=export_format)
            elif export_format == 'dae':
                hull.export(str(output_path), file_type='dae')
            else:
                hull.export(str(output_path))

            self.logger.info(f"Successfully created alpha shapes mesh with {len(hull.faces)} faces")
            return True

        except Exception as e:
            self.logger.error(f"Failed to create alpha shapes mesh: {e}")
            return False

    def convert(
        self,
        input_path: Path,
        output_path: Path,
        method: ConversionMethod = "point_cloud",
        **kwargs
    ) -> bool:
        """
        Convert PLY file to mesh format.

        Args:
            input_path: Input PLY file
            output_path: Output file (GLTF/GLB/DAE)
            method: Conversion method to use
            **kwargs: Additional parameters for specific methods

        Returns:
            True if successful, False otherwise
        """
        # Validate input file
        if not input_path.exists():
            self.logger.error(f"Input file not found: {input_path}")
            return False

        # Create output directory if needed
        output_path.parent.mkdir(parents=True, exist_ok=True)

        # Select conversion method
        if method == "point_cloud":
            return self.convert_to_point_cloud_gltf(
                input_path,
                output_path,
                point_size=kwargs.get('point_size', 0.01)
            )
        elif method == "poisson":
            return self.convert_to_poisson_mesh(
                input_path,
                output_path,
                depth=kwargs.get('depth', 9),
                scale=kwargs.get('scale', 1.1)
            )
        elif method == "alpha_shapes":
            return self.convert_to_alpha_shapes_mesh(
                input_path,
                output_path,
                alpha=kwargs.get('alpha', 0.1)
            )
        else:
            self.logger.error(f"Unknown conversion method: {method}")
            return False


# Convenience functions
def convert_ply_to_gltf(
    input_path: Path | str,
    output_path: Path | str,
    method: ConversionMethod = "point_cloud",
    **kwargs
) -> bool:
    """
    Convert PLY to GLTF/GLB/DAE.

    Args:
        input_path: Input PLY file path
        output_path: Output file path
        method: Conversion method ("point_cloud", "poisson", "alpha_shapes")
        **kwargs: Additional parameters for conversion

    Returns:
        True if successful, False otherwise

    Example:
        >>> convert_ply_to_gltf("model.ply", "output.glb", method="poisson", depth=10)
    """
    converter = MeshConverter()
    return converter.convert(
        Path(input_path),
        Path(output_path),
        method=method,
        **kwargs
    )
