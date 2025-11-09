#!/usr/bin/env python3
"""
MVS Textured Mesh Service
-------------------------
Creates textured mesh from COLMAP sparse reconstruction using dense reconstruction
and meshing with texture mapping - similar to OpenDroneMap.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Literal, Optional

import numpy as np

logger = logging.getLogger(__name__)

MeshingMethod = Literal["poisson", "delaunay"]


class MVSMesher:
    """Creates textured mesh from COLMAP reconstruction."""

    def __init__(self, colmap_executable: str = "colmap"):
        """
        Initialize MVS mesher.

        Args:
            colmap_executable: Path to COLMAP executable
        """
        self.colmap_exe = colmap_executable
        self.logger = logger
        
        # Setup environment for GPU-enabled COLMAP
        import os
        self.env = os.environ.copy()
        
        # Add CUDA libraries
        cuda_paths = [
            "/usr/local/cuda/lib64",
            "/usr/local/cuda-12.6/lib64",
            "/usr/local/cuda-12.1/lib64"
        ]
        
        ld_library_path = self.env.get("LD_LIBRARY_PATH", "")
        for cuda_path in cuda_paths:
            if os.path.exists(cuda_path):
                if ld_library_path:
                    ld_library_path = f"{cuda_path}:{ld_library_path}"
                else:
                    ld_library_path = cuda_path
        
        self.env["LD_LIBRARY_PATH"] = ld_library_path
        
        # Headless rendering for COLMAP GUI operations
        self.env["QT_QPA_PLATFORM"] = "offscreen"
        self.env["DISPLAY"] = ""
        
        self.logger.info(f"Initialized MVSMesher with COLMAP: {colmap_executable}")
        self.logger.info(f"LD_LIBRARY_PATH: {ld_library_path}")

    def run_dense_reconstruction(
        self,
        project_path: Path,
        sparse_model_path: Path,
        max_image_size: int = 2000,
        num_threads: int = -1,
        quality: Literal["low", "medium", "high"] = "medium"
    ) -> Path:
        """
        Run COLMAP dense reconstruction (undistortion + stereo).

        Args:
            project_path: Project directory containing images/
            sparse_model_path: Path to sparse reconstruction (e.g., sparse/0/)
            max_image_size: Maximum image size for dense reconstruction
            num_threads: Number of threads (-1 = auto)
            quality: Reconstruction quality

        Returns:
            Path to dense workspace directory
        """
        try:
            images_path = project_path / "images"
            dense_path = project_path / "dense"
            dense_path.mkdir(exist_ok=True)

            # Quality settings
            quality_settings = {
                "low": {"max_image_size": 1000, "window_radius": 3, "filter_min_ncc": 0.1},
                "medium": {"max_image_size": 2000, "window_radius": 5, "filter_min_ncc": 0.15},
                "high": {"max_image_size": 3000, "window_radius": 7, "filter_min_ncc": 0.2}
            }
            settings = quality_settings.get(quality, quality_settings["medium"])

            # Step 1: Image undistortion
            self.logger.info("Running image undistortion...")
            undistort_cmd = [
                self.colmap_exe, "image_undistorter",
                "--image_path", str(images_path),
                "--input_path", str(sparse_model_path),
                "--output_path", str(dense_path),
                "--output_type", "COLMAP",
                "--max_image_size", str(settings["max_image_size"])
            ]

            result = subprocess.run(undistort_cmd, capture_output=True, text=True, env=self.env)
            if result.returncode != 0:
                self.logger.error(f"Image undistortion failed: {result.stderr}")
                raise RuntimeError(f"Image undistortion failed: {result.stderr}")

            # Step 2: Patch match stereo (dense reconstruction)
            self.logger.info("Running patch match stereo (this may take a while)...")
            stereo_cmd = [
                self.colmap_exe, "patch_match_stereo",
                "--workspace_path", str(dense_path),
                "--workspace_format", "COLMAP",
                "--PatchMatchStereo.gpu_index", "0",  # Use GPU 0 (CUDA acceleration)
                "--PatchMatchStereo.window_radius", str(settings["window_radius"]),
                "--PatchMatchStereo.filter_min_ncc", str(settings["filter_min_ncc"]),
                "--PatchMatchStereo.geom_consistency", "true"
            ]

            # Note: num_threads is ignored when using GPU
            # GPU processing is much faster (10-50x) than CPU

            result = subprocess.run(stereo_cmd, capture_output=True, text=True, env=self.env)
            if result.returncode != 0:
                self.logger.error(f"Patch match stereo failed: {result.stderr}")
                raise RuntimeError(f"Patch match stereo failed: {result.stderr}")

            # Step 3: Stereo fusion (merge depth maps into point cloud)
            self.logger.info("Fusing stereo depth maps...")
            fusion_cmd = [
                self.colmap_exe, "stereo_fusion",
                "--workspace_path", str(dense_path),
                "--workspace_format", "COLMAP",
                "--input_type", "geometric",
                "--output_path", str(dense_path / "fused.ply")
            ]

            result = subprocess.run(fusion_cmd, capture_output=True, text=True, env=self.env)
            if result.returncode != 0:
                self.logger.error(f"Stereo fusion failed: {result.stderr}")
                raise RuntimeError(f"Stereo fusion failed: {result.stderr}")

            self.logger.info(f"Dense reconstruction completed: {dense_path}")
            return dense_path

        except Exception as e:
            self.logger.error(f"Dense reconstruction failed: {e}")
            raise

    def create_textured_mesh_poisson(
        self,
        dense_path: Path,
        output_path: Path,
        trim_value: int = 10
    ) -> bool:
        """
        Create textured mesh using Poisson reconstruction.

        Args:
            dense_path: Path to dense reconstruction workspace
            output_path: Output mesh path (PLY format)
            trim_value: Poisson meshing trim value (lower = more complete)

        Returns:
            True if successful
        """
        try:
            self.logger.info("Creating Poisson mesh...")
            poisson_cmd = [
                self.colmap_exe, "poisson_mesher",
                "--input_path", str(dense_path / "fused.ply"),
                "--output_path", str(output_path),
                "--PoissonMeshing.trim", str(trim_value)
            ]

            result = subprocess.run(poisson_cmd, capture_output=True, text=True, env=self.env)
            if result.returncode != 0:
                self.logger.error(f"Poisson meshing failed: {result.stderr}")
                return False

            self.logger.info(f"Poisson mesh created: {output_path}")
            return True

        except Exception as e:
            self.logger.error(f"Poisson meshing failed: {e}")
            return False

    def create_textured_mesh_delaunay(
        self,
        dense_path: Path,
        output_path: Path
    ) -> bool:
        """
        Create textured mesh using Delaunay triangulation.

        Args:
            dense_path: Path to dense reconstruction workspace
            output_path: Output mesh path (PLY format)

        Returns:
            True if successful
        """
        try:
            self.logger.info("Creating Delaunay mesh...")
            delaunay_cmd = [
                self.colmap_exe, "delaunay_mesher",
                "--input_path", str(dense_path),
                "--output_path", str(output_path),
                "--input_type", "dense"
            ]

            result = subprocess.run(delaunay_cmd, capture_output=True, text=True, env=self.env)
            if result.returncode != 0:
                self.logger.error(f"Delaunay meshing failed: {result.stderr}")
                return False

            self.logger.info(f"Delaunay mesh created: {output_path}")
            return True

        except Exception as e:
            self.logger.error(f"Delaunay meshing failed: {e}")
            return False

    def texture_mesh_with_pymeshlab(
        self,
        mesh_path: Path,
        images_path: Path,
        output_path: Path,
        texture_size: int = 4096
    ) -> bool:
        """
        Apply textures to mesh using PyMeshLab.

        Args:
            mesh_path: Input mesh (PLY)
            images_path: Directory containing original images
            output_path: Output textured mesh (OBJ with MTL and textures)
            texture_size: Texture atlas size

        Returns:
            True if successful
        """
        try:
            import pymeshlab

            self.logger.info("Loading mesh for texturing...")
            ms = pymeshlab.MeshSet()
            ms.load_new_mesh(str(mesh_path))

            # Compute normals if not present
            try:
                # Try to check if normals exist (API varies by version)
                has_normals = ms.current_mesh().has_vertex_normal()
            except AttributeError:
                # Fallback: just try to compute normals regardless
                has_normals = False
            
            if not has_normals:
                self.logger.info("Computing vertex normals...")
                try:
                    ms.compute_normal_for_point_clouds()
                except:
                    # If it's a mesh (not point cloud), use mesh normal computation
                    ms.compute_normal_per_vertex()

            # Parameterization (UV mapping)
            self.logger.info("Creating UV parameterization...")
            try:
                ms.compute_texcoord_parametrization_triangle_trivial_per_wedge()
            except:
                self.logger.warning("UV parameterization failed, skipping...")

            # Since we don't have camera parameters readily available for PyMeshLab,
            # we'll use vertex color from the dense point cloud
            # For proper texture mapping, we'd need to use a tool that understands COLMAP's camera params

            # For now, export with vertex colors
            self.logger.info(f"Exporting textured mesh to {output_path}...")

            # Export as OBJ
            ms.save_current_mesh(
                str(output_path),
                save_vertex_color=True,
                save_face_color=True
            )

            self.logger.info("Mesh texturing completed")
            return True

        except Exception as e:
            self.logger.error(f"Mesh texturing failed: {e}")
            return False

    def create_full_textured_mesh(
        self,
        project_path: Path,
        sparse_model_path: Path,
        output_path: Path,
        method: MeshingMethod = "poisson",
        quality: Literal["low", "medium", "high"] = "medium",
        export_format: Literal["ply", "obj", "glb", "dae"] = "obj"
    ) -> bool:
        """
        Complete pipeline: Dense reconstruction → Meshing → Texturing.

        Args:
            project_path: Project directory
            sparse_model_path: Sparse reconstruction path
            output_path: Final output path
            method: Meshing method (poisson or delaunay)
            quality: Reconstruction quality
            export_format: Output format

        Returns:
            True if successful
        """
        try:
            # Step 1: Dense reconstruction
            self.logger.info("Step 1/3: Running dense reconstruction...")
            dense_path = self.run_dense_reconstruction(
                project_path,
                sparse_model_path,
                quality=quality
            )

            # Step 2: Create mesh
            self.logger.info(f"Step 2/3: Creating mesh using {method} method...")
            temp_mesh = dense_path / f"mesh_{method}.ply"

            if method == "poisson":
                success = self.create_textured_mesh_poisson(dense_path, temp_mesh)
            else:
                success = self.create_textured_mesh_delaunay(dense_path, temp_mesh)

            if not success:
                raise RuntimeError(f"Meshing with {method} failed")

            # Step 3: Add vertex colors from dense point cloud
            self.logger.info("Step 3/3: Adding vertex colors to mesh...")
            
            # Import and use the add_colors_to_mesh script
            import sys
            from pathlib import Path as PathLib
            add_colors_script = PathLib(__file__).parent.parent / "add_colors_to_mesh.py"
            
            if not add_colors_script.exists():
                self.logger.error(f"add_colors_to_mesh.py not found at {add_colors_script}")
                return False
            
            # Run the color transfer script
            import subprocess
            dense_ply = dense_path / "fused.ply"
            
            cmd = [
                sys.executable,
                str(add_colors_script),
                str(temp_mesh),          # input mesh
                str(dense_ply),          # dense point cloud with colors
                str(output_path),        # output with desired format
                "--format", export_format
            ]
            
            self.logger.info(f"Running: {' '.join(cmd)}")
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                self.logger.error(f"Color transfer failed: {result.stderr}")
                return False
            
            self.logger.info(result.stdout)
            self.logger.info(f"✅ Textured mesh created successfully: {output_path}")
            return True

        except Exception as e:
            self.logger.error(f"Failed to create textured mesh: {e}")
            import traceback
            traceback.print_exc()
            return False


# Convenience function
def create_textured_mesh(
    project_path: Path | str,
    sparse_model_path: Path | str,
    output_path: Path | str,
    method: MeshingMethod = "poisson",
    quality: Literal["low", "medium", "high"] = "medium",
    colmap_executable: str = "colmap"
) -> bool:
    """
    Create textured mesh from COLMAP reconstruction.

    Args:
        project_path: Path to project directory (contains images/)
        sparse_model_path: Path to sparse reconstruction
        output_path: Output mesh path
        method: Meshing method
        quality: Reconstruction quality
        colmap_executable: COLMAP executable path

    Returns:
        True if successful

    Example:
        >>> create_textured_mesh(
        ...     "uploads/project-id",
        ...     "uploads/project-id/sparse/0",
        ...     "results/project-id/textured_mesh.obj",
        ...     method="poisson",
        ...     quality="medium"
        ... )
    """
    mesher = MVSMesher(colmap_executable)
    return mesher.create_full_textured_mesh(
        Path(project_path),
        Path(sparse_model_path),
        Path(output_path),
        method=method,
        quality=quality
    )
