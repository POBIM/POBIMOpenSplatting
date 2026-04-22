"""
Smart Time Estimation Service for PobimSplats
Calculates accurate processing time based on hardware and dataset
"""

import time
from dataclasses import dataclass
from typing import Dict, Any, Optional, List
import subprocess

try:
    from pipeline.resource_contract import HEAVY_STAGE_KEYS
except ImportError:  # pragma: no cover - package import fallback
    from ..pipeline.resource_contract import HEAVY_STAGE_KEYS

@dataclass
class TimeEstimate:
    """Time estimation data structure"""
    total_seconds: float
    stage_estimates: Dict[str, float]
    start_time: Optional[float] = None
    current_stage: Optional[str] = None
    stage_start_time: Optional[float] = None

    def get_total_minutes(self) -> float:
        return self.total_seconds / 60

    def get_remaining_seconds(self) -> float:
        if not self.start_time:
            return self.total_seconds
        elapsed = time.time() - self.start_time
        return max(0, self.total_seconds - elapsed)

    def get_stage_remaining_seconds(self) -> float:
        if not self.current_stage or not self.stage_start_time:
            return 0
        stage_duration = self.stage_estimates.get(self.current_stage, 0)
        elapsed = time.time() - self.stage_start_time
        return max(0, stage_duration - elapsed)

    def get_progress_percentage(self) -> float:
        if not self.start_time:
            return 0
        elapsed = time.time() - self.start_time
        return min(100, (elapsed / self.total_seconds) * 100)

class SmartTimeEstimator:
    """Intelligent time estimation based on hardware and dataset characteristics"""

    def __init__(self):
        self.gpu_benchmarks = {
            'RTX 4060': {'colmap_factor': 1.0, 'opensplat_factor': 1.0},
            'RTX 4070': {'colmap_factor': 0.8, 'opensplat_factor': 0.8},
            'RTX 4080': {'colmap_factor': 0.6, 'opensplat_factor': 0.6},
            'RTX 4090': {'colmap_factor': 0.5, 'opensplat_factor': 0.5},
            'RTX 3060': {'colmap_factor': 1.3, 'opensplat_factor': 1.2},
            'RTX 3070': {'colmap_factor': 1.1, 'opensplat_factor': 1.0},
            'RTX 3080': {'colmap_factor': 0.9, 'opensplat_factor': 0.8},
            'RTX 3090': {'colmap_factor': 0.7, 'opensplat_factor': 0.7},
        }

        # Base time estimates (seconds) for RTX 4060 with 50 images, balanced quality
        self.base_estimates = {
            'video_extraction': 30,
            'feature_extraction': 45,
            'feature_matching': 60,
            'sparse_reconstruction': 30,
            'model_conversion': 5,
            'gaussian_splatting': 120
        }

        # Quality multipliers
        self.quality_factors = {
            'fast': 0.3,
            'balanced': 1.0,
            'high': 2.5,
            'ultra': 4.5
        }

    def detect_gpu(self) -> str:
        """Detect GPU model from nvidia-smi"""
        try:
            result = subprocess.run(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader,nounits'],
                                 capture_output=True, text=True)
            gpu_name = result.stdout.strip()

            # Match to known benchmarks
            for known_gpu in self.gpu_benchmarks:
                if known_gpu in gpu_name:
                    return known_gpu

            # Default to RTX 4060 if unknown
            return 'RTX 4060'
        except:
            return 'RTX 4060'

    def detect_gpu_vram_mb(self) -> int:
        """Detect total GPU memory in MB from nvidia-smi."""
        try:
            result = subprocess.run(
                ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
                capture_output=True,
                text=True,
            )
            for line in result.stdout.splitlines():
                stripped = line.strip()
                if stripped:
                    return max(0, int(float(stripped)))
        except Exception:
            pass
        return 8192

    def estimate_processing_time(self, num_images: int, quality_mode: str,
                               has_videos: bool = False, num_videos: int = 0) -> TimeEstimate:
        """Calculate smart time estimates based on all parameters"""

        gpu_model = self.detect_gpu()
        gpu_factors = self.gpu_benchmarks.get(gpu_model, self.gpu_benchmarks['RTX 4060'])
        quality_factor = self.quality_factors.get(quality_mode, 1.0)

        # Image count scaling (logarithmic for large datasets)
        if num_images <= 50:
            image_factor = num_images / 50
        elif num_images <= 200:
            image_factor = 1 + (num_images - 50) / 150 * 1.5  # 1.0 to 2.5
        elif num_images <= 500:
            image_factor = 2.5 + (num_images - 200) / 300 * 1.0  # 2.5 to 3.5
        else:
            # Logarithmic scaling for very large datasets
            import math
            image_factor = 3.5 + math.log10(num_images / 500) * 2

        stage_estimates = {}

        # Video extraction (if needed)
        if has_videos:
            stage_estimates['video_extraction'] = self.base_estimates['video_extraction'] * num_videos

        # COLMAP stages
        stage_estimates['feature_extraction'] = (
            self.base_estimates['feature_extraction'] *
            image_factor * gpu_factors['colmap_factor'] * quality_factor
        )

        stage_estimates['feature_matching'] = (
            self.base_estimates['feature_matching'] *
            image_factor * gpu_factors['colmap_factor'] * quality_factor
        )

        stage_estimates['sparse_reconstruction'] = (
            self.base_estimates['sparse_reconstruction'] *
            image_factor * 0.8  # Less affected by quality
        )

        stage_estimates['model_conversion'] = self.base_estimates['model_conversion']

        # OpenSplat training (most affected by quality)
        opensplat_base = self.base_estimates['gaussian_splatting']
        if quality_mode == 'ultra':
            opensplat_base *= 6  # 15000 vs 2000 iterations
        elif quality_mode == 'high':
            opensplat_base *= 3.5  # 7000 vs 2000 iterations
        elif quality_mode == 'fast':
            opensplat_base *= 0.25  # 500 vs 2000 iterations

        stage_estimates['gaussian_splatting'] = (
            opensplat_base * gpu_factors['opensplat_factor']
        )

        total_seconds = sum(stage_estimates.values())

        return TimeEstimate(
            total_seconds=total_seconds,
            stage_estimates=stage_estimates
        )

    def classify_resource_profile(
        self,
        *,
        num_images: int,
        quality_mode: str,
        config: Optional[Dict[str, Any]] = None,
        has_videos: bool = False,
        num_videos: int = 0,
        video_diagnostics: Optional[Dict[str, Any]] = None,
        reconstruction_framework: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        config = dict(config or {})
        video_diagnostics = dict(video_diagnostics or {})
        reconstruction_framework = dict(reconstruction_framework or {})
        gpu_model = self.detect_gpu()
        gpu_vram_mb = self.detect_gpu_vram_mb()
        input_type = config.get('input_type') or ('video' if has_videos else 'images')
        colmap_resolution = str(config.get('colmap_resolution', '2K'))
        training_resolution = str(config.get('training_resolution', '4K'))
        use_separate_training_images = bool(config.get('use_separate_training_images', False))
        adaptive_frame_budget = bool(config.get('adaptive_frame_budget', True))
        adaptive_pair_scheduling = bool(config.get('adaptive_pair_scheduling', True))
        effective_oversample = (
            ((video_diagnostics.get('adaptive_frame_budget') or {}).get('effective_oversample_factor'))
            or video_diagnostics.get('oversample_factor')
            or config.get('oversample_factor')
            or 0
        )
        weak_boundary_ratio = float(
            ((reconstruction_framework.get('pair_geometry_stats') or {}).get('weak_boundary_ratio') or 0.0)
        )
        recovery_steps = len(reconstruction_framework.get('recovery_history') or [])

        score = 0
        if has_videos:
            score += 2
        if num_images >= 280:
            score += 2
        elif num_images >= 140:
            score += 1
        if quality_mode in {'high', 'ultra', 'professional', 'ultra_professional'}:
            score += 2
        elif quality_mode in {'balanced', 'hard'}:
            score += 1
        if colmap_resolution in {'4K', '8K', 'original'}:
            score += 1
        if training_resolution in {'4K', '8K', 'original'} and use_separate_training_images:
            score += 1
        if effective_oversample and float(effective_oversample) >= 12:
            score += 1
        if weak_boundary_ratio >= 0.05 or recovery_steps >= 2:
            score += 1

        if gpu_vram_mb <= 8192 and score >= 4:
            profile_class = 'gpu_constrained'
        elif score >= 5:
            profile_class = 'heavy'
        elif score >= 2:
            profile_class = 'balanced'
        else:
            profile_class = 'light'

        capture_budget_summary = {
            'input_type': input_type,
            'num_images': int(num_images),
            'num_videos': int(num_videos),
            'adaptive_frame_budget': adaptive_frame_budget,
            'adaptive_pair_scheduling': adaptive_pair_scheduling,
            'effective_oversample_factor': effective_oversample,
            'colmap_resolution': colmap_resolution,
            'training_resolution': training_resolution,
            'use_separate_training_images': use_separate_training_images,
        }

        return {
            'profile_class': profile_class,
            'gpu_model': gpu_model,
            'gpu_vram_mb': gpu_vram_mb,
            'heavy_stage_keys': list(HEAVY_STAGE_KEYS),
            'capture_budget_summary': capture_budget_summary,
            'score': score,
            'summary': (
                f"{profile_class} profile • {num_images} images • "
                f"{colmap_resolution} COLMAP / {training_resolution} training"
            ),
        }

    def choose_resource_lane(
        self,
        *,
        project_id: str,
        stage_key: str,
        resource_profile: Dict[str, Any],
        active_projects: Optional[List[Dict[str, Any]]] = None,
        manual_override: bool = False,
    ) -> Dict[str, Any]:
        active_projects = list(active_projects or [])
        profile_class = str(resource_profile.get('profile_class') or 'balanced')
        heavy_stage_keys = set(resource_profile.get('heavy_stage_keys') or HEAVY_STAGE_KEYS)
        stage_is_heavy = stage_key in heavy_stage_keys
        blocking_projects = [
            item for item in active_projects
            if item.get('project_id') != project_id
            and item.get('status') == 'processing'
            and item.get('current_stage') in heavy_stage_keys
        ]

        lane = 'running'
        admission_reason = 'no heavy-stage contention detected'
        downgrade_reason = None
        estimated_start_delay = 0

        if profile_class == 'gpu_constrained':
            downgrade_reason = 'gpu_vram_constrained'
            if stage_is_heavy:
                lane = 'downgraded'
                admission_reason = 'heavy stage will run in a GPU-constrained lane'
        elif stage_is_heavy and blocking_projects:
            lane = 'waiting_for_heavy_slot'
            estimated_start_delay = max(45, 45 * len(blocking_projects))
            admission_reason = (
                f"waiting for {len(blocking_projects)} active heavy-stage project(s) to clear"
            )

        if manual_override and lane == 'downgraded':
            admission_reason = 'manual retry kept the project in a downgraded resource lane'

        return {
            'resource_lane': lane,
            'admission_reason': admission_reason,
            'downgrade_reason': downgrade_reason,
            'estimated_start_delay': estimated_start_delay,
            'heavy_stage_blockers': [
                {
                    'project_id': item.get('project_id'),
                    'stage': item.get('current_stage'),
                    'profile_class': item.get('profile_class'),
                }
                for item in blocking_projects
            ],
        }

    def format_time_display(self, seconds: float) -> str:
        """Format time in human-readable format"""
        if seconds < 60:
            return f"{int(seconds)}s"
        elif seconds < 3600:
            minutes = int(seconds // 60)
            secs = int(seconds % 60)
            return f"{minutes}m {secs}s"
        else:
            hours = int(seconds // 3600)
            minutes = int((seconds % 3600) // 60)
            return f"{hours}h {minutes}m"

    def get_quality_description(self, quality_mode: str, estimate: TimeEstimate) -> Dict[str, str]:
        """Get quality descriptions with accurate time estimates"""
        descriptions = {
            'fast': {
                'title': '⚡ Fast Preview',
                'description': f'Quick preview quality - {self.format_time_display(estimate.total_seconds)}',
                'details': 'Lower COLMAP features, 500 iterations, basic settings'
            },
            'balanced': {
                'title': '⚖️ Balanced Quality',
                'description': f'Good quality balance - {self.format_time_display(estimate.total_seconds)}',
                'details': 'Standard COLMAP features, 2000 iterations, optimized settings'
            },
            'high': {
                'title': '🎯 High Quality',
                'description': f'Excellent detail - {self.format_time_display(estimate.total_seconds)}',
                'details': 'Enhanced COLMAP features, 7000 iterations, advanced settings'
            },
            'ultra': {
                'title': '✨ Ultra Quality',
                'description': f'Maximum detail - {self.format_time_display(estimate.total_seconds)}',
                'details': 'Maximum COLMAP features, 15000 iterations, professional settings'
            }
        }
        return descriptions.get(quality_mode, descriptions['balanced'])

# Global instance
time_estimator = SmartTimeEstimator()
