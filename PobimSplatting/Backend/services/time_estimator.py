"""
Smart Time Estimation Service for PobimSplats
Calculates accurate processing time based on hardware and dataset
"""

import time
from dataclasses import dataclass
from typing import Dict, Any, Optional
import json
from pathlib import Path

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
            import subprocess
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