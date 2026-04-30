"""
Video processing utilities for extracting frames from video files

Supports GPU-accelerated video decoding using:
- FFmpeg with NVDEC (NVIDIA hardware decoder) - 5-10x faster
- Parallel frame saving with ThreadPoolExecutor
- Automatic fallback to CPU if GPU unavailable

Resolution presets for extraction:
- 720p, 1080p, 2K, 4K, 8K, or original
- Supports dual-resolution extraction for COLMAP (lower) vs Training (higher)
"""
import cv2
import os
from pathlib import Path
import numpy as np
from PIL import Image
import logging
import subprocess
import json
import tempfile
import shutil
import time
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional, Callable, List, Dict, Any

logger = logging.getLogger(__name__)

# =============================================================================
# Resolution Presets for Video Frame Extraction
# =============================================================================
RESOLUTION_PRESETS = {
    '720p': {'width': 1280, 'height': 720, 'jpeg_quality': 85, 'label': '720p (1280×720)'},
    '1080p': {'width': 1920, 'height': 1080, 'jpeg_quality': 90, 'label': '1080p (1920×1080)'},
    '2K': {'width': 2560, 'height': 1440, 'jpeg_quality': 92, 'label': '2K (2560×1440)'},
    '4K': {'width': 3840, 'height': 2160, 'jpeg_quality': 95, 'label': '4K (3840×2160)'},
    '8K': {'width': 7680, 'height': 4320, 'jpeg_quality': 98, 'label': '8K (7680×4320)'},
    'original': {'width': None, 'height': None, 'jpeg_quality': 95, 'label': 'Original Resolution'},
}

# Mapping from legacy quality percentage to resolution preset
QUALITY_TO_RESOLUTION = {
    50: '1080p',
    75: '2K', 
    100: '4K',
}


def get_resolution_preset(resolution: str) -> Dict[str, Any]:
    """Get resolution preset by name, with fallback to 2K."""
    return RESOLUTION_PRESETS.get(resolution, RESOLUTION_PRESETS['2K'])


def get_target_dimensions(resolution: str, source_width: int, source_height: int) -> tuple:
    """
    Calculate target dimensions for a given resolution preset while maintaining aspect ratio.
    
    Args:
        resolution: Resolution preset name ('720p', '1080p', '2K', '4K', '8K', 'original')
        source_width: Original video width
        source_height: Original video height
        
    Returns:
        Tuple of (target_width, target_height, jpeg_quality)
    """
    preset = get_resolution_preset(resolution)
    
    # Original resolution - no scaling
    if resolution == 'original' or preset['width'] is None:
        return source_width, source_height, preset['jpeg_quality']
    
    target_width = preset['width']
    target_height = preset['height']
    
    # If source is smaller than target, use original
    if source_width <= target_width and source_height <= target_height:
        return source_width, source_height, preset['jpeg_quality']
    
    # Calculate scale to fit within target dimensions while maintaining aspect ratio
    source_aspect = source_width / source_height
    target_aspect = target_width / target_height
    
    if source_aspect > target_aspect:
        # Source is wider - fit to width
        new_width = target_width
        new_height = int(target_width / source_aspect)
    else:
        # Source is taller - fit to height
        new_height = target_height
        new_width = int(target_height * source_aspect)
    
    # Ensure even dimensions (required for many video codecs)
    new_width = new_width - (new_width % 2)
    new_height = new_height - (new_height % 2)
    
    return new_width, new_height, preset['jpeg_quality']


def convert_legacy_quality_to_resolution(quality_percent: int) -> str:
    """Convert legacy quality percentage (50/75/100) to resolution preset."""
    return QUALITY_TO_RESOLUTION.get(quality_percent, '2K')


def is_wsl() -> bool:
    """Check if running in Windows Subsystem for Linux (WSL)."""
    try:
        with open('/proc/version', 'r') as f:
            return 'microsoft' in f.read().lower() or 'wsl' in f.read().lower()
    except:
        return False


def get_gpu_environment() -> Dict[str, Any]:
    """
    Get environment variables configured for GPU access.
    Handles both native Linux and WSL2 environments.
    
    Returns:
        Dict with 'env' (environment dict) and 'is_wsl' (bool)
    """
    env = os.environ.copy()
    wsl_lib_path = '/usr/lib/wsl/lib'
    
    # Check if WSL2 and library path exists
    if os.path.exists(wsl_lib_path):
        current_ld_path = env.get('LD_LIBRARY_PATH', '')
        if wsl_lib_path not in current_ld_path:
            env['LD_LIBRARY_PATH'] = f"{wsl_lib_path}:{current_ld_path}" if current_ld_path else wsl_lib_path
        return {'env': env, 'is_wsl': True}
    
    return {'env': env, 'is_wsl': False}


def check_gpu_decode_available() -> Dict[str, Any]:
    """
    Check if GPU-accelerated video decoding is available.
    Supports both native Linux servers and WSL2 environments.
    
    Returns:
        Dict with 'available' bool and 'method' string ('nvdec', 'vaapi', 'none')
    """
    result = {
        'available': False,
        'method': 'none',
        'ffmpeg_path': None,
        'gpu_name': None,
        'details': []
    }
    
    # Check for FFmpeg
    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        result['details'].append('FFmpeg not found in PATH')
        return result
    
    result['ffmpeg_path'] = ffmpeg_path
    
    # Get GPU environment (handles WSL2 vs native Linux)
    gpu_env = get_gpu_environment()
    env = gpu_env['env']
    if gpu_env['is_wsl']:
        result['details'].append('WSL2 environment detected, using WSL GPU passthrough')
    
    # Check for NVIDIA GPU and NVDEC support
    try:
        nvidia_smi = subprocess.run(
            ['nvidia-smi', '--query-gpu=name', '--format=csv,noheader'],
            capture_output=True, text=True, timeout=5, env=env
        )
        if nvidia_smi.returncode == 0:
            gpu_name = nvidia_smi.stdout.strip().split('\n')[0]
            result['gpu_name'] = gpu_name
            result['details'].append(f'NVIDIA GPU detected: {gpu_name}')
            
            # Check FFmpeg NVDEC support
            ffmpeg_hwaccels = subprocess.run(
                ['ffmpeg', '-hwaccels'],
                capture_output=True, text=True, timeout=5, env=env
            )
            if 'cuda' in ffmpeg_hwaccels.stdout.lower() or 'nvdec' in ffmpeg_hwaccels.stdout.lower():
                result['available'] = True
                result['method'] = 'nvdec'
                result['details'].append('FFmpeg NVDEC/CUDA hardware acceleration available')
            else:
                result['details'].append('FFmpeg does not have CUDA/NVDEC support compiled')
                
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        result['details'].append(f'NVIDIA check failed: {e}')
    
    # Check for VAAPI (AMD/Intel) as fallback
    if not result['available']:
        try:
            ffmpeg_hwaccels = subprocess.run(
                ['ffmpeg', '-hwaccels'],
                capture_output=True, text=True, timeout=5
            )
            if 'vaapi' in ffmpeg_hwaccels.stdout.lower():
                result['available'] = True
                result['method'] = 'vaapi'
                result['details'].append('FFmpeg VAAPI hardware acceleration available')
        except Exception as e:
            result['details'].append(f'VAAPI check failed: {e}')
    
    return result


def get_gpu_total_vram_mb() -> Optional[int]:
    """Return total VRAM for the first NVIDIA GPU in MiB."""
    try:
        gpu_env = get_gpu_environment()
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=5,
            env=gpu_env['env'],
        )
        if result.returncode != 0:
            return None
        line = (result.stdout or '').strip().splitlines()[0].strip()
        return int(line) if line else None
    except Exception:
        return None


# Cache the GPU availability check
_GPU_DECODE_INFO: Optional[Dict[str, Any]] = None
_FFMPEG_FPS_MODE_SUPPORTED: Optional[bool] = None


def get_gpu_decode_info() -> Dict[str, Any]:
    """Get cached GPU decode availability info."""
    global _GPU_DECODE_INFO
    if _GPU_DECODE_INFO is None:
        _GPU_DECODE_INFO = check_gpu_decode_available()
        logger.info(f"GPU decode check: {_GPU_DECODE_INFO}")
    return _GPU_DECODE_INFO


def ffmpeg_supports_fps_mode() -> bool:
    """Return whether the installed ffmpeg supports the -fps_mode option."""
    global _FFMPEG_FPS_MODE_SUPPORTED
    if _FFMPEG_FPS_MODE_SUPPORTED is not None:
        return _FFMPEG_FPS_MODE_SUPPORTED

    ffmpeg_path = shutil.which('ffmpeg')
    if not ffmpeg_path:
        _FFMPEG_FPS_MODE_SUPPORTED = False
        return _FFMPEG_FPS_MODE_SUPPORTED

    try:
        result = subprocess.run(
            [ffmpeg_path, '-h', 'full'],
            capture_output=True,
            text=True,
            timeout=10,
        )
        output = f"{result.stdout}\n{result.stderr}"
        _FFMPEG_FPS_MODE_SUPPORTED = '-fps_mode' in output
    except Exception:
        _FFMPEG_FPS_MODE_SUPPORTED = False

    return _FFMPEG_FPS_MODE_SUPPORTED


def get_ffmpeg_vfr_args() -> List[str]:
    """Return frame sync args supported by the installed ffmpeg."""
    if ffmpeg_supports_fps_mode():
        return ['-fps_mode', 'vfr']
    return ['-vsync', 'vfr']

class VideoProcessor:
    def __init__(self):
        self.supported_formats = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v'}
        self.problematic_codecs = {'hevc', 'h265', 'av1'}  # Codecs that often cause issues
        self.recommended_codecs = {'h264', 'avc', 'mpeg4'}
        self.last_extraction_stats: Dict[str, Any] = {}

    @staticmethod
    def _extract_ffmpeg_error_tail(stderr_text: str, max_lines: int = 12) -> str:
        lines = [line.strip() for line in (stderr_text or '').splitlines() if line.strip()]
        return '\n'.join(lines[-max_lines:])

    def _is_retryable_gpu_ffmpeg_error(self, stderr_text: str) -> bool:
        normalized = (stderr_text or '').lower()
        retryable_markers = (
            'cannot allocate memory',
            'no device available for decoder',
            'device creation failed',
            'hardware device setup failed',
            'resource temporarily unavailable',
            'cannot init cuda',
            'cuda error',
            'error while opening decoder',
        )
        return any(marker in normalized for marker in retryable_markers)

    def _estimate_safe_gpu_parallel_chunks(
        self,
        video_info: Dict[str, Any],
        requested_chunk_count: int,
    ) -> int:
        chunk_cap = max(1, int(requested_chunk_count))
        width = int(video_info.get('width') or 0)
        height = int(video_info.get('height') or 0)
        codec_name = str(video_info.get('codec_name') or '').lower()
        profile = str(video_info.get('profile') or '').lower()
        pix_fmt = str(video_info.get('pix_fmt') or '').lower()
        bitrate = int(video_info.get('bit_rate') or 0)
        gpu_vram_mb = get_gpu_total_vram_mb() or 0
        gpu_env = get_gpu_environment()

        is_4k_or_higher = max(width, height) >= 3840
        is_10bit = '10' in profile or '10' in pix_fmt or pix_fmt.endswith('p10le')
        is_heavy_hevc = codec_name in {'hevc', 'h265'}
        is_high_bitrate = bitrate >= 80_000_000

        if is_4k_or_higher:
            chunk_cap = min(chunk_cap, 4)
        if is_heavy_hevc:
            chunk_cap = min(chunk_cap, 3)
        if is_10bit:
            chunk_cap = min(chunk_cap, 2)
        if is_high_bitrate:
            chunk_cap = min(chunk_cap, 2)
        if gpu_env['is_wsl'] and is_4k_or_higher and is_heavy_hevc:
            chunk_cap = min(chunk_cap, 2)
        if gpu_vram_mb and gpu_vram_mb <= 8192 and is_4k_or_higher and is_10bit:
            chunk_cap = min(chunk_cap, 1)

        return max(1, chunk_cap)

    def is_video_file(self, filename):
        """Check if file is a supported video format"""
        return Path(filename).suffix.lower() in self.supported_formats

    def get_video_codec_info(self, video_path):
        """Get detailed video codec information using ffprobe"""
        try:
            cmd = [
                'ffprobe', '-v', 'quiet', '-print_format', 'json', '-show_streams',
                str(video_path)
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True)
            data = json.loads(result.stdout)

            video_streams = [s for s in data.get('streams', []) if s.get('codec_type') == 'video']
            if not video_streams:
                return None

            stream = video_streams[0]  # Use first video stream

            return {
                'codec_name': stream.get('codec_name', 'unknown').lower(),
                'codec_long_name': stream.get('codec_long_name', ''),
                'profile': stream.get('profile', ''),
                'width': int(stream.get('width', 0)),
                'height': int(stream.get('height', 0)),
                'duration': float(stream.get('duration', 0)),
                'bit_rate': stream.get('bit_rate', 'unknown')
            }
        except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
            logger.warning(f"Failed to get codec info for {video_path}, ffprobe may not be available")
            return None

    def validate_video_compatibility(self, video_path):
        """Check if video is compatible with OpenCV and processing pipeline"""
        validation_result = {
            'is_compatible': False,
            'can_open_opencv': False,
            'codec_supported': True,
            'codec_name': 'unknown',
            'issues': [],
            'recommendations': []
        }

        # Check if OpenCV can open the video
        cap = cv2.VideoCapture(str(video_path))
        validation_result['can_open_opencv'] = cap.isOpened()

        if cap.isOpened():
            # Try to read a frame to ensure it actually works
            ret, frame = cap.read()
            if not ret:
                validation_result['can_open_opencv'] = False
                validation_result['issues'].append("OpenCV can open file but cannot read frames")

        cap.release()

        # Get codec information
        codec_info = self.get_video_codec_info(video_path)
        if codec_info:
            codec_name = codec_info['codec_name']
            validation_result['codec_name'] = codec_name

            # Check for problematic codecs
            if codec_name in self.problematic_codecs:
                validation_result['codec_supported'] = False
                validation_result['issues'].append(f"Codec '{codec_name}' may not be fully supported by OpenCV")

                if codec_name in ['hevc', 'h265']:
                    validation_result['issues'].append("H.265/HEVC videos often require re-encoding for better compatibility")
                    validation_result['recommendations'].append("Convert to H.264 for better compatibility")
                elif codec_name == 'av1':
                    validation_result['issues'].append("AV1 codec has limited support in OpenCV")
                    validation_result['recommendations'].append("Convert to H.264 for better compatibility")

        # Overall compatibility assessment
        validation_result['is_compatible'] = (
            validation_result['can_open_opencv'] and
            validation_result['codec_supported']
        )

        if not validation_result['can_open_opencv']:
            validation_result['recommendations'].append("Try converting video with ffmpeg: ffmpeg -i input.mp4 -c:v libx264 -c:a aac output.mp4")

        return validation_result

    def extract_matching_frames(self, video_path, source_frames_dir, output_dir, resolution='4K', progress_callback=None):
        """
        Extract frames from video that match existing frames in source_frames_dir.
        
        This ensures training images have EXACTLY the same frames as COLMAP images,
        just at a different resolution. Uses frame filenames to determine which
        video frames to extract.
        
        Args:
            video_path: Path to input video
            source_frames_dir: Directory containing source frames (e.g., COLMAP frames)
            output_dir: Directory to save extracted frames
            resolution: Target resolution preset ('720p', '1080p', '2K', '4K', '8K', 'original')
            progress_callback: Optional callback function(current, total, frame_path)
            
        Returns:
            List of extracted frame paths
        """
        video_path = Path(video_path)
        source_frames_dir = Path(source_frames_dir)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Get list of source frame filenames
        source_frames = sorted(source_frames_dir.glob("frame_*.jpg"))
        if not source_frames:
            logger.warning(f"No source frames found in {source_frames_dir}")
            return []
        
        logger.info(f"Extracting {len(source_frames)} matching frames at {resolution} resolution")
        
        # Get video info
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {video_path}")
        
        total_video_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        
        # Get target dimensions
        target_width, target_height, jpeg_quality = get_target_dimensions(resolution, width, height)
        need_scale = (target_width != width or target_height != height)
        
        logger.info(f"Video: {width}x{height}, Target: {target_width}x{target_height}")
        
        extracted_frames = []
        
        # Process each source frame
        for i, source_frame_path in enumerate(source_frames):
            frame_filename = source_frame_path.name
            output_path = output_dir / frame_filename
            
            # Parse frame number from filename (frame_000123.jpg -> 123)
            try:
                frame_num_str = frame_filename.replace('frame_', '').replace('.jpg', '')
                # This is the sequential number, not the video frame index
                # We need to re-extract from video at the same position
            except ValueError:
                logger.warning(f"Could not parse frame number from {frame_filename}")
                continue
            
            # Read the source frame to get its content (we'll match by position in sequence)
            # Since we're extracting the same frames, use the same sequential index
            # but extract from video at higher resolution
            
            # Calculate approximate video frame position
            # This assumes COLMAP frames were extracted uniformly from video
            if len(source_frames) > 1:
                frame_position = int((i / (len(source_frames) - 1)) * (total_video_frames - 1))
            else:
                frame_position = 0
            
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_position)
            ret, frame = cap.read()
            
            if not ret:
                logger.warning(f"Could not read frame at position {frame_position}")
                continue
            
            try:
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                
                if need_scale:
                    frame_rgb = cv2.resize(frame_rgb, (target_width, target_height), 
                                          interpolation=cv2.INTER_LANCZOS4)
                
                pil_image = Image.fromarray(frame_rgb)
                pil_image.save(str(output_path), 'JPEG', quality=jpeg_quality, optimize=True)
                extracted_frames.append(str(output_path))
                
                if progress_callback and (i + 1) % 5 == 0:
                    progress_callback(i + 1, len(source_frames), str(output_path))
                    
            except Exception as e:
                logger.error(f"Error processing frame {frame_filename}: {e}")
                continue
        
        cap.release()
        
        logger.info(f"✅ Extracted {len(extracted_frames)} matching frames at {resolution}")
        return extracted_frames

    def _extract_frames_ffmpeg_cpu(self, video_path, output_dir, extraction_config, progress_callback=None):
        """
        CPU extraction with ffmpeg.

        This is substantially faster than OpenCV for the common uniform sampling path
        because ffmpeg can decode and JPEG-encode with its own threaded pipeline.
        """
        video_path = Path(video_path)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        video_info = self._get_video_info_ffprobe(video_path)
        if not video_info:
            logger.warning("Could not get video info via ffprobe, falling back to OpenCV CPU extraction")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)

        total_frames = video_info['total_frames']
        fps = video_info['fps']
        width = video_info['width']
        height = video_info['height']
        duration = video_info['duration']

        logger.info(f"FFmpeg CPU extraction: {total_frames} frames, {fps:.2f} fps, {duration:.2f}s, {width}x{height}")

        mode = extraction_config.get('mode', 'frames')
        quality_telemetry = self._collect_adaptive_budget_quality_telemetry(
            video_path,
            total_frames,
            extraction_config,
        )
        sampling_plan = self._build_sampling_plan(
            total_frames,
            fps,
            extraction_config,
            video_info=video_info,
            quality_telemetry=quality_telemetry,
        )
        if sampling_plan.get('adaptive_frame_budget') is not None:
            budget = sampling_plan['adaptive_frame_budget']
            logger.info(
                "Adaptive frame budget: requested %sx -> effective %sx (density %.2fx, %s candidates for %s outputs)",
                budget['requested_oversample_factor'],
                budget['effective_oversample_factor'],
                budget['density_scale'],
                sampling_plan['candidate_count'],
                sampling_plan['target_output_count'],
            )

        resolution = extraction_config.get('resolution')
        if not resolution:
            quality_percent = extraction_config.get('quality', 100)
            resolution = convert_legacy_quality_to_resolution(quality_percent)
            logger.info(f"Using legacy quality {quality_percent}% → resolution preset: {resolution}")

        target_width, target_height, jpeg_quality = get_target_dimensions(resolution, width, height)
        logger.info(f"Target resolution: {target_width}x{target_height} ({resolution})")

        if mode in {'fps', 'target_count'}:
            expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
            parallel_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
            if parallel_workers <= 0:
                cpu_count = os.cpu_count() or 4
                auto_workers = max(1, cpu_count // 6)
                parallel_workers = min(8, auto_workers)

            # Parallel chunk extraction helps long HEVC videos use more CPU cores.
            if parallel_workers > 1 and duration >= 45 and expected_frames >= 60:
                logger.info(f"FFmpeg CPU parallel extraction enabled: {parallel_workers} workers")
                try:
                    return self._extract_frames_ffmpeg_cpu_parallel(
                        video_path=video_path,
                        output_dir=output_dir,
                        extraction_config=extraction_config,
                        progress_callback=progress_callback,
                        duration=duration,
                        width=width,
                        height=height,
                        target_width=target_width,
                        target_height=target_height,
                        jpeg_quality=jpeg_quality,
                        sampling_plan=sampling_plan,
                    )
                except Exception as e:
                    logger.warning(f"Parallel ffmpeg CPU extraction failed, falling back to single-process ffmpeg: {e}")
            sampling_filter = sampling_plan['sampling_filter']
        else:
            expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
            sampling_filter = sampling_plan['sampling_filter']

        filters = []
        if sampling_filter:
            filters.append(sampling_filter)
        if target_width != width or target_height != height:
            filters.append(f"scale={target_width}:{target_height}")

        filter_chain = ','.join(filters) if filters else None
        ffmpeg_quality = max(2, min(5, int(6 - (jpeg_quality / 100) * 4)))
        output_pattern = str(output_dir / "frame_%06d.jpg")

        cmd = [
            'ffmpeg', '-y',
            '-hide_banner',
            '-loglevel', 'error',
            '-threads', '0',
            '-i', str(video_path),
        ]

        if filter_chain:
            cmd.extend(['-vf', filter_chain])

        cmd.extend([
            '-an',
            '-sn',
            '-dn',
            '-qscale:v', str(ffmpeg_quality),
            '-start_number', '0',
            output_pattern,
        ])
        cmd.extend(get_ffmpeg_vfr_args())

        logger.info(f"FFmpeg CPU command: {' '.join(cmd)}")

        try:
            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception as e:
            logger.error(f"FFmpeg CPU extraction failed: {e}")
            logger.warning("Falling back to OpenCV CPU extraction")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)

        extracted_frames = sorted(str(f) for f in output_dir.glob("frame_*.jpg"))

        if extraction_config.get('smart_frame_selection', False):
            extracted_frames = self._score_and_select_extracted_frames(
                extracted_frames,
                extraction_config,
                total_frames=total_frames,
                fps=fps,
                sampling_plan=sampling_plan,
                progress_callback=progress_callback,
            )
            self.last_extraction_stats['strategy'] = 'ffmpeg_cpu_oversample_select'
        elif mode == 'frames':
            max_frames = extraction_config.get('max_frames', 100)
            if len(extracted_frames) > max_frames:
                step = len(extracted_frames) / max_frames
                indices = [int(i * step) for i in range(max_frames)]
                frames_to_keep = [extracted_frames[i] for i in indices]

                for frame_path in extracted_frames:
                    if frame_path not in frames_to_keep:
                        try:
                            os.remove(frame_path)
                        except Exception:
                            pass

                extracted_frames = frames_to_keep

                for i, old_path in enumerate(extracted_frames):
                    new_path = output_dir / f"frame_{i:06d}.jpg"
                    if old_path != str(new_path):
                        try:
                            os.rename(old_path, new_path)
                            extracted_frames[i] = str(new_path)
                        except Exception:
                            pass

        if extraction_config.get('smart_frame_selection', False):
            self.last_extraction_stats = self._append_sampling_plan_stats({
                **self.last_extraction_stats,
                'mode': mode,
                'candidate_count': expected_frames,
            }, sampling_plan)
        else:
            self.last_extraction_stats = self._append_sampling_plan_stats({
                'strategy': 'ffmpeg_cpu',
                'mode': mode,
                'requested_targets': expected_frames,
                'candidate_count': expected_frames,
                'saved_frames': len(extracted_frames),
                'replaced_targets': 0,
                'search_radius': 0,
                'rejected_candidates': 0,
                'selections': [],
            }, sampling_plan)

        if progress_callback and extracted_frames:
            progress_callback(len(extracted_frames), self._get_target_output_count(total_frames, fps, extraction_config), extracted_frames[-1])

        logger.info(f"✅ FFmpeg CPU extraction complete: {len(extracted_frames)} frames")
        return extracted_frames

    def _extract_frames_ffmpeg_cpu_parallel(
        self,
        video_path,
        output_dir,
        extraction_config,
        progress_callback,
        duration,
        width,
        height,
        target_width,
        target_height,
        jpeg_quality,
        sampling_plan,
    ):
        video_info = self._get_video_info_ffprobe(video_path)
        fps = video_info['fps'] if video_info else 0.0
        total_frames = video_info['total_frames'] if video_info else max(1, int(duration * fps)) if fps > 0 else 0
        target_fps = float(sampling_plan['extraction_fps'] or extraction_config.get('target_fps', 1.0) or 1.0)
        expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
        requested_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
        cpu_count = os.cpu_count() or 4
        if requested_workers <= 0:
            requested_workers = min(8, max(1, cpu_count // 6))

        chunk_count = min(requested_workers, max(1, int(duration // 20)))
        if chunk_count <= 1:
            raise ValueError("parallel extraction requested without enough chunks")

        ffmpeg_quality = max(2, min(5, int(6 - (jpeg_quality / 100) * 4)))
        scale_filter = None
        if target_width != width or target_height != height:
            scale_filter = f"scale={target_width}:{target_height}"

        logger.info(f"Launching {chunk_count} parallel ffmpeg worker(s) for CPU extraction")

        def run_chunk(chunk_index: int):
            start_time = (duration * chunk_index) / chunk_count
            end_time = (duration * (chunk_index + 1)) / chunk_count
            chunk_duration = max(0.001, end_time - start_time)
            chunk_dir = output_dir / f".chunk_{chunk_index:02d}"
            chunk_dir.mkdir(parents=True, exist_ok=True)

            filters = [f"fps={target_fps}"]
            if scale_filter:
                filters.append(scale_filter)

            cmd = [
                'ffmpeg', '-y',
                '-hide_banner',
                '-loglevel', 'error',
                '-threads', '0',
                '-ss', f"{start_time:.6f}",
                '-t', f"{chunk_duration:.6f}",
                '-i', str(video_path),
                '-vf', ','.join(filters),
                '-an',
                '-sn',
                '-dn',
                '-qscale:v', str(ffmpeg_quality),
                '-start_number', '0',
                str(chunk_dir / "frame_%06d.jpg"),
            ]
            cmd.extend(get_ffmpeg_vfr_args())

            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

            frames = sorted(chunk_dir.glob("frame_*.jpg"))
            return chunk_index, frames, chunk_dir

        extracted_frames = []
        chunk_dirs = []
        merged_count = 0

        with ThreadPoolExecutor(max_workers=chunk_count) as executor:
            futures = [executor.submit(run_chunk, chunk_index) for chunk_index in range(chunk_count)]
            results = []
            for future in as_completed(futures):
                results.append(future.result())

        for chunk_index, frames, chunk_dir in sorted(results, key=lambda item: item[0]):
            chunk_dirs.append(chunk_dir)
            for frame_path in frames:
                final_path = output_dir / f"frame_{merged_count:06d}.jpg"
                os.replace(frame_path, final_path)
                extracted_frames.append(str(final_path))
                merged_count += 1
                if progress_callback and (merged_count % 5 == 0 or merged_count == expected_frames):
                    progress_callback(merged_count, expected_frames, str(final_path))

        for chunk_dir in chunk_dirs:
            try:
                chunk_dir.rmdir()
            except OSError:
                pass

        self.last_extraction_stats = self._append_sampling_plan_stats({
            'strategy': f'ffmpeg_cpu_parallel_{chunk_count}x',
            'mode': 'fps',
            'requested_targets': expected_frames,
            'candidate_count': expected_frames,
            'saved_frames': len(extracted_frames),
            'replaced_targets': 0,
            'search_radius': 0,
            'rejected_candidates': 0,
            'selections': [],
        }, sampling_plan)

        if extraction_config.get('smart_frame_selection', False):
            extracted_frames = self._score_and_select_extracted_frames(
                extracted_frames,
                extraction_config,
                total_frames=total_frames,
                fps=fps,
                sampling_plan=sampling_plan,
                progress_callback=progress_callback,
            )
            self.last_extraction_stats['strategy'] = f'ffmpeg_cpu_parallel_{chunk_count}x_oversample_select'

        logger.info(f"✅ Parallel ffmpeg CPU extraction complete: {len(extracted_frames)} frames")
        return extracted_frames

    def _score_and_select_extracted_frames(
        self,
        extracted_frames,
        extraction_config,
        *,
        total_frames: int,
        fps: float,
        sampling_plan: Optional[Dict[str, Any]] = None,
        progress_callback=None,
    ):
        if not extracted_frames:
            return extracted_frames

        plan = sampling_plan or self._build_sampling_plan(total_frames, fps, extraction_config)
        quality_percent = int(extraction_config.get('quality', 100) or 100)
        target_output_count = int(plan['target_output_count'])
        candidate_count = len(extracted_frames)
        search_radius = self._get_effective_search_radius(total_frames, fps, extraction_config)
        source_video_path = str(extraction_config.get('source_video_path') or '')
        status_callback = extraction_config.get('status_callback')
        requested_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
        if requested_workers <= 0:
            requested_workers = min(8, max(1, (os.cpu_count() or 4) // 2))
        scoring_workers = min(max(1, requested_workers), max(1, candidate_count))
        candidate_source_indices = self._estimate_candidate_source_indices(total_frames, candidate_count)

        if callable(status_callback):
            status_callback('candidate_scoring_start', {
                'current': 0,
                'total': candidate_count,
                'target_count': target_output_count,
                'search_radius': search_radius,
                'workers': scoring_workers,
            })

        def score_candidate(candidate_index: int, frame_path: str):
            frame = cv2.imread(str(frame_path))
            if frame is None:
                return None
            score_info = self._score_frame_candidate(frame, None, quality_percent)
            source_frame_index = None
            source_time_seconds = None
            if 0 <= candidate_index < len(candidate_source_indices):
                source_frame_index = int(candidate_source_indices[candidate_index])
                if fps > 0:
                    source_time_seconds = round(source_frame_index / fps, 6)
            return {
                'path': str(frame_path),
                'candidate_index': candidate_index,
                'score': float(score_info['score']),
                'accepted': bool(score_info['accepted']),
                'metrics': score_info['metrics'],
                'source_frame_index': source_frame_index,
                'source_time_seconds': source_time_seconds,
            }

        scored_candidates = []
        rejected_candidates = 0
        processed_count = 0
        if scoring_workers == 1 or candidate_count < 16:
            for idx, frame_path in enumerate(extracted_frames, start=1):
                scored = score_candidate(idx - 1, frame_path)
                if scored is not None:
                    if not scored['accepted']:
                        rejected_candidates += 1
                    scored_candidates.append(scored)
                processed_count = idx
                if callable(status_callback) and (processed_count % 20 == 0 or processed_count == candidate_count):
                    status_callback('candidate_scoring_progress', {
                        'current': processed_count,
                        'total': candidate_count,
                        'target_count': target_output_count,
                        'search_radius': search_radius,
                        'workers': scoring_workers,
                    })
        else:
            with ThreadPoolExecutor(max_workers=scoring_workers) as executor:
                futures = [
                    executor.submit(score_candidate, idx, frame_path)
                    for idx, frame_path in enumerate(extracted_frames)
                ]
                for future in as_completed(futures):
                    scored = future.result()
                    processed_count += 1
                    if scored is not None:
                        if not scored['accepted']:
                            rejected_candidates += 1
                        scored_candidates.append(scored)
                    if callable(status_callback) and (processed_count % 20 == 0 or processed_count == candidate_count):
                        status_callback('candidate_scoring_progress', {
                            'current': processed_count,
                            'total': candidate_count,
                            'target_count': target_output_count,
                            'search_radius': search_radius,
                            'workers': scoring_workers,
                        })

        scored_candidates.sort(key=lambda item: item['candidate_index'])
        if not scored_candidates:
            return extracted_frames

        accepted_candidates = sum(1 for item in scored_candidates if item['accepted'])
        candidate_sharpness = [float(item['metrics']['sharpness']) for item in scored_candidates]
        candidate_brightness = [float(item['metrics']['brightness']) for item in scored_candidates]
        candidate_quality_summary = {
            'candidate_total': len(scored_candidates),
            'accepted_total': accepted_candidates,
            'accepted_ratio': round(accepted_candidates / max(len(scored_candidates), 1), 4),
            'median_sharpness': round(float(np.median(candidate_sharpness)), 4),
            'p25_sharpness': round(float(np.percentile(candidate_sharpness, 25)), 4),
            'median_brightness': round(float(np.median(candidate_brightness)), 4),
        }

        if callable(status_callback):
            status_callback('candidate_selection_start', {
                'current': 0,
                'total': target_output_count,
                'candidate_total': len(scored_candidates),
                'search_radius': search_radius,
            })

        selected_candidates = []
        selection_records = []
        bucket_edges = np.linspace(0, len(scored_candidates), num=target_output_count + 1)
        source_frames_per_candidate = total_frames / max(len(scored_candidates), 1)
        source_frames_per_target = total_frames / max(target_output_count, 1)
        candidate_step_per_target = len(scored_candidates) / max(target_output_count, 1)
        continuity_window = max(1.0, candidate_step_per_target * 0.75)
        replaced_targets = 0

        for target_idx in range(target_output_count):
            start = int(np.floor(bucket_edges[target_idx]))
            end = int(np.floor(bucket_edges[target_idx + 1]))
            if end <= start:
                end = min(len(scored_candidates), start + 1)
            bucket = scored_candidates[start:end]
            if not bucket:
                continue
            bucket_center = (start + max(start, end - 1)) / 2.0
            if selected_candidates:
                expected_candidate_index = selected_candidates[-1]['candidate_index'] + candidate_step_per_target
            else:
                expected_candidate_index = bucket_center

            def continuity_rank(item):
                center_distance = abs(item['candidate_index'] - bucket_center)
                continuity_distance = abs(item['candidate_index'] - expected_candidate_index)
                center_penalty = center_distance * 4.0
                continuity_penalty = max(0.0, continuity_distance - continuity_window) * 12.0
                effective_score = float(item['score']) - center_penalty - continuity_penalty
                return (
                    1 if item['accepted'] else 0,
                    effective_score,
                    -continuity_distance,
                    -center_distance,
                    item['metrics']['sharpness'],
                )

            best = max(bucket, key=continuity_rank)
            selected_candidates.append(best)
            if best['candidate_index'] != bucket[0]['candidate_index']:
                replaced_targets += 1

            approx_target_source_index = int(round((target_idx + 0.5) * source_frames_per_target))
            approx_selected_source_index = int(round(best['candidate_index'] * source_frames_per_candidate))
            selected_source_index = (
                int(best['source_frame_index'])
                if best.get('source_frame_index') is not None
                else approx_selected_source_index
            )
            selection_records.append({
                'target_index': approx_target_source_index,
                'selected_index': selected_source_index,
                'offset': int(selected_source_index - approx_target_source_index),
                'sharpness': round(best['metrics']['sharpness'], 2),
                'accepted': bool(best['accepted']),
                'fallback_used': not bool(best['accepted']),
                'source_frame_index': selected_source_index,
                'source_time_seconds': best.get('source_time_seconds'),
            })
            if callable(status_callback) and ((target_idx + 1) % 10 == 0 or target_idx + 1 == target_output_count):
                status_callback('candidate_selection_progress', {
                    'current': target_idx + 1,
                    'total': target_output_count,
                    'replaced': replaced_targets,
                    'search_radius': search_radius,
                })

        selected_paths = {item['path'] for item in selected_candidates}
        final_paths = []
        frame_manifest = []
        for old_path in extracted_frames:
            if old_path not in selected_paths:
                try:
                    os.remove(old_path)
                except Exception:
                    pass

        for idx, candidate in enumerate(selected_candidates):
            current_path = Path(candidate['path'])
            new_path = current_path.parent / f"frame_{idx:06d}.jpg"
            if current_path != new_path:
                try:
                    os.replace(current_path, new_path)
                except Exception:
                    new_path = current_path
            final_paths.append(str(new_path))
            frame_manifest.append({
                'image_name': new_path.name,
                'source_video_path': source_video_path or None,
                'source_frame_index': (
                    int(candidate['source_frame_index'])
                    if candidate.get('source_frame_index') is not None
                    else None
                ),
                'source_time_seconds': candidate.get('source_time_seconds'),
                'candidate_index': int(candidate['candidate_index']),
                'score': round(float(candidate['score']), 4),
                'accepted': bool(candidate['accepted']),
                'sharpness': round(float(candidate['metrics']['sharpness']), 4),
            })

        self.last_extraction_stats = self._append_sampling_plan_stats({
            **self.last_extraction_stats,
            'requested_targets': target_output_count,
            'candidate_count': candidate_count,
            'saved_frames': len(final_paths),
            'replaced_targets': replaced_targets,
            'search_radius': search_radius,
            'rejected_candidates': rejected_candidates,
            'scoring_workers': scoring_workers,
            'selections': selection_records,
            'frame_manifest': frame_manifest,
            'source_video_path': source_video_path or None,
            'source_total_frames': int(total_frames),
            'source_fps': float(fps or 0.0),
            'candidate_quality_summary': candidate_quality_summary,
        }, plan)
        if callable(status_callback):
            status_callback('candidate_selection_complete', {
                'total': len(final_paths),
                'replaced': replaced_targets,
                'search_radius': search_radius,
                'rejected_candidates': rejected_candidates,
            })
        if progress_callback and final_paths:
            progress_callback(len(final_paths), target_output_count, final_paths[-1])
        return final_paths

    def _extract_frames_ffmpeg_gpu_parallel(
        self,
        video_path,
        output_dir,
        extraction_config,
        progress_callback,
        duration,
        width,
        height,
        target_width,
        target_height,
        jpeg_quality,
        gpu_info,
        chunk_count_override=None,
        sampling_plan=None,
    ):
        video_info = self._get_video_info_ffprobe(video_path)
        fps = video_info['fps'] if video_info else 0.0
        total_frames = video_info['total_frames'] if video_info else max(1, int(duration * fps)) if fps > 0 else 0
        sampling_plan = sampling_plan or self._build_sampling_plan(total_frames, fps, extraction_config)
        target_fps = float(sampling_plan['extraction_fps'] or extraction_config.get('target_fps', 1.0) or 1.0)
        expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
        requested_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
        cpu_count = os.cpu_count() or 4
        if requested_workers <= 0:
            requested_workers = min(8, max(1, cpu_count // 6))

        chunk_count = int(chunk_count_override or min(requested_workers, max(1, int(duration // 20))))
        if chunk_count <= 1:
            raise ValueError("parallel extraction requested without enough chunks")

        ffmpeg_quality = max(2, min(5, int(6 - (jpeg_quality / 100) * 4)))
        filters = [f"fps={target_fps}"]
        if target_width != width or target_height != height:
            filters.append(f"scale={target_width}:{target_height}")

        gpu_env = get_gpu_environment()
        env = gpu_env['env']

        logger.info(
            f"Launching {chunk_count} parallel ffmpeg worker(s) for GPU extraction ({gpu_info['method'].upper()})"
        )

        def run_chunk(chunk_index: int):
            start_time = (duration * chunk_index) / chunk_count
            end_time = (duration * (chunk_index + 1)) / chunk_count
            chunk_duration = max(0.001, end_time - start_time)
            chunk_dir = output_dir / f".chunk_{chunk_index:02d}"
            chunk_dir.mkdir(parents=True, exist_ok=True)

            cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error']

            if gpu_info['method'] == 'nvdec':
                cmd.extend(['-hwaccel', 'cuda'])
            elif gpu_info['method'] == 'vaapi':
                cmd.extend(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'])

            cmd.extend([
                '-ss', f"{start_time:.6f}",
                '-t', f"{chunk_duration:.6f}",
                '-i', str(video_path),
            ])

            filter_chain = ','.join(filters)
            if filter_chain:
                cmd.extend(['-vf', filter_chain])

            cmd.extend([
                '-an',
                '-sn',
                '-dn',
                '-qscale:v', str(ffmpeg_quality),
                '-start_number', '0',
                str(chunk_dir / 'frame_%06d.jpg'),
            ])
            cmd.extend(get_ffmpeg_vfr_args())

            result = subprocess.run(
                cmd,
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )
            if result.returncode != 0:
                stderr_tail = self._extract_ffmpeg_error_tail(result.stderr)
                raise RuntimeError(
                    f"GPU ffmpeg chunk {chunk_index} failed with exit code {result.returncode}"
                    + (f": {stderr_tail}" if stderr_tail else "")
                )

            frames = sorted(chunk_dir.glob('frame_*.jpg'))
            return chunk_index, frames, chunk_dir

        extracted_frames = []
        chunk_dirs = []
        merged_count = 0

        with ThreadPoolExecutor(max_workers=chunk_count) as executor:
            futures = [executor.submit(run_chunk, chunk_index) for chunk_index in range(chunk_count)]
            results = []
            for future in as_completed(futures):
                results.append(future.result())

        for chunk_index, frames, chunk_dir in sorted(results, key=lambda item: item[0]):
            chunk_dirs.append(chunk_dir)
            for frame_path in frames:
                final_path = output_dir / f"frame_{merged_count:06d}.jpg"
                os.replace(frame_path, final_path)
                extracted_frames.append(str(final_path))
                merged_count += 1
                if progress_callback and (merged_count % 5 == 0 or merged_count == expected_frames):
                    progress_callback(merged_count, expected_frames, str(final_path))

        for chunk_dir in chunk_dirs:
            try:
                chunk_dir.rmdir()
            except OSError:
                pass

        self.last_extraction_stats = self._append_sampling_plan_stats({
            'strategy': f"ffmpeg_{gpu_info['method']}_parallel_{chunk_count}x",
            'mode': 'fps',
            'requested_targets': expected_frames,
            'candidate_count': expected_frames,
            'saved_frames': len(extracted_frames),
            'replaced_targets': 0,
            'search_radius': 0,
            'rejected_candidates': 0,
            'selections': [],
        }, sampling_plan)

        if extraction_config.get('smart_frame_selection', False):
            extracted_frames = self._score_and_select_extracted_frames(
                extracted_frames,
                extraction_config,
                total_frames=total_frames,
                fps=fps,
                sampling_plan=sampling_plan,
                progress_callback=progress_callback,
            )
            self.last_extraction_stats['strategy'] = f"ffmpeg_{gpu_info['method']}_parallel_{chunk_count}x_oversample_select"

        logger.info(f"✅ Parallel GPU extraction complete: {len(extracted_frames)} frames")
        return extracted_frames

    def _extract_frames_gpu(self, video_path, output_dir, extraction_config, progress_callback=None):
        """
        GPU-accelerated frame extraction using FFmpeg with NVDEC.
        
        This method uses NVIDIA hardware video decoder (NVDEC) for 5-10x faster
        video decoding, combined with parallel JPEG encoding for optimal performance.
        
        Args:
            video_path: Path to input video
            output_dir: Directory to save extracted frames
            extraction_config: Dict with extraction configuration
            progress_callback: Optional callback function(current_frame, total_expected, frame_path)
            
        Returns:
            List of extracted frame paths
        """
        video_path = Path(video_path)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        gpu_info = get_gpu_decode_info()
        if not gpu_info['available']:
            logger.warning("GPU decode not available, falling back to ffmpeg CPU extraction")
            return self._extract_frames_ffmpeg_cpu(video_path, output_dir, extraction_config, progress_callback)
        
        logger.info(f"🚀 Using GPU-accelerated extraction ({gpu_info['method'].upper()})")
        
        # Get video info using ffprobe
        video_info = self._get_video_info_ffprobe(video_path)
        if not video_info:
            logger.warning("Could not get video info via ffprobe, falling back to ffmpeg CPU extraction")
            return self._extract_frames_ffmpeg_cpu(video_path, output_dir, extraction_config, progress_callback)
        
        total_frames = video_info['total_frames']
        fps = video_info['fps']
        width = video_info['width']
        height = video_info['height']
        duration = video_info['duration']
        
        logger.info(f"Video info: {total_frames} frames, {fps:.2f} fps, {duration:.2f}s, {width}x{height}")
        
        # Calculate extraction parameters
        mode = extraction_config.get('mode', 'frames')
        
        # Get resolution setting (supports both new 'resolution' and legacy 'quality')
        resolution = extraction_config.get('resolution')
        if not resolution:
            # Fallback to legacy quality percentage
            quality_percent = extraction_config.get('quality', 100)
            resolution = convert_legacy_quality_to_resolution(quality_percent)
            logger.info(f"Using legacy quality {quality_percent}% → resolution preset: {resolution}")
        
        # Get target dimensions based on resolution preset
        target_width, target_height, jpeg_quality = get_target_dimensions(resolution, width, height)
        logger.info(f"Target resolution: {target_width}x{target_height} ({resolution})")
        
        quality_telemetry = self._collect_adaptive_budget_quality_telemetry(
            video_path,
            total_frames,
            extraction_config,
        )
        sampling_plan = self._build_sampling_plan(
            total_frames,
            fps,
            extraction_config,
            video_info=video_info,
            quality_telemetry=quality_telemetry,
        )
        if sampling_plan.get('adaptive_frame_budget') is not None:
            budget = sampling_plan['adaptive_frame_budget']
            logger.info(
                "Adaptive frame budget: requested %sx -> effective %sx (density %.2fx, %s candidates for %s outputs)",
                budget['requested_oversample_factor'],
                budget['effective_oversample_factor'],
                budget['density_scale'],
                sampling_plan['candidate_count'],
                sampling_plan['target_output_count'],
            )
        gpu_parallel_retryable_failure = False

        if mode in {'fps', 'target_count'}:
            expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
            parallel_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
            if parallel_workers <= 0:
                cpu_count = os.cpu_count() or 4
                auto_workers = max(1, cpu_count // 6)
                parallel_workers = min(8, auto_workers)

            if parallel_workers > 1 and duration >= 45 and expected_frames >= 60:
                requested_chunk_count = min(parallel_workers, max(1, int(duration // 20)))
                safe_chunk_cap = self._estimate_safe_gpu_parallel_chunks(video_info, requested_chunk_count)
                if safe_chunk_cap < requested_chunk_count:
                    logger.info(
                        "Reducing GPU parallel extraction from "
                        f"{requested_chunk_count} to {safe_chunk_cap} worker(s) "
                        f"for {video_info.get('codec_name', 'unknown').upper()} "
                        f"{video_info.get('profile', '') or video_info.get('pix_fmt', '')} "
                        f"{width}x{height}"
                    )

                retry_chunk_counts = []
                current_chunk_count = safe_chunk_cap
                while current_chunk_count > 1:
                    retry_chunk_counts.append(current_chunk_count)
                    if current_chunk_count == 2:
                        break
                    current_chunk_count = max(2, current_chunk_count // 2)

                if retry_chunk_counts:
                    logger.info(f"GPU parallel extraction enabled: {parallel_workers} workers")

                for chunk_count in retry_chunk_counts:
                    try:
                        return self._extract_frames_ffmpeg_gpu_parallel(
                            video_path=video_path,
                            output_dir=output_dir,
                            extraction_config=extraction_config,
                            progress_callback=progress_callback,
                            duration=duration,
                            width=width,
                            height=height,
                            target_width=target_width,
                            target_height=target_height,
                            jpeg_quality=jpeg_quality,
                            gpu_info=gpu_info,
                            chunk_count_override=chunk_count,
                            sampling_plan=sampling_plan,
                        )
                    except Exception as e:
                        error_text = str(e)
                        retryable = self._is_retryable_gpu_ffmpeg_error(error_text)
                        gpu_parallel_retryable_failure = gpu_parallel_retryable_failure or retryable
                        logger.warning(
                            f"Parallel GPU extraction failed at {chunk_count} worker(s): {error_text}"
                        )
                        if not retryable:
                            break

                if gpu_parallel_retryable_failure:
                    logger.info("Retryable GPU decoder error detected during parallel extraction; retrying with single-process GPU ffmpeg")
                    time.sleep(1.0)
            fps_filter = sampling_plan['sampling_filter']
        else:
            expected_frames = sampling_plan['candidate_count'] if sampling_plan['smart_selection'] else sampling_plan['target_output_count']
            fps_filter = sampling_plan['sampling_filter']
        
        # Build scale filter if needed (only if target differs from source)
        scale_filter = None
        if target_width != width or target_height != height:
            scale_filter = f"scale={target_width}:{target_height}"
            logger.info(f"Scaling: {width}x{height} → {target_width}x{target_height}")
        
        # Build filter chain
        filters = []
        if fps_filter:
            filters.append(fps_filter)
        if scale_filter:
            filters.append(scale_filter)
        
        filter_chain = ','.join(filters) if filters else None
        
        # FFmpeg uses qscale:v where lower = better quality (2-5 is good)
        ffmpeg_quality = max(2, min(5, int(6 - (jpeg_quality / 100) * 4)))
        
        # Build FFmpeg command with GPU acceleration
        output_pattern = str(output_dir / "frame_%06d.jpg")
        
        cmd = ['ffmpeg', '-y']
        
        # Add hardware acceleration based on method
        if gpu_info['method'] == 'nvdec':
            cmd.extend(['-hwaccel', 'cuda'])
        elif gpu_info['method'] == 'vaapi':
            cmd.extend(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'])
        
        cmd.extend(['-i', str(video_path)])
        
        if filter_chain:
            cmd.extend(['-vf', filter_chain])
        
        cmd.extend([
            '-qscale:v', str(ffmpeg_quality),
            '-start_number', '0',
            output_pattern
        ])
        cmd.extend(get_ffmpeg_vfr_args())
        
        logger.info(f"FFmpeg command: {' '.join(cmd)}")
        
        # Get GPU environment (handles both WSL2 and native Linux)
        gpu_env = get_gpu_environment()
        env = gpu_env['env']
        
        # Run FFmpeg with progress tracking
        try:
            process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                universal_newlines=True,
                env=env
            )
            
            # Monitor stderr for progress
            frame_count = 0
            stderr_tail = []
            for line in process.stderr:
                stderr_tail.append(line.rstrip())
                if len(stderr_tail) > 25:
                    stderr_tail.pop(0)
                # FFmpeg outputs frame progress like "frame=  123"
                if 'frame=' in line:
                    try:
                        frame_match = line.split('frame=')[1].split()[0].strip()
                        frame_count = int(frame_match)
                        
                        if progress_callback and frame_count % 5 == 0:
                            frame_path = output_dir / f"frame_{frame_count:06d}.jpg"
                            progress_callback(frame_count, expected_frames, str(frame_path))
                    except (ValueError, IndexError):
                        pass
            
            process.wait()
            
            if process.returncode != 0:
                error_tail = '\n'.join(stderr_tail[-12:])
                logger.error(f"FFmpeg failed with return code {process.returncode}")
                if error_tail:
                    logger.warning(f"GPU ffmpeg stderr tail:\n{error_tail}")
                logger.warning("Falling back to ffmpeg CPU extraction")
                return self._extract_frames_ffmpeg_cpu(video_path, output_dir, extraction_config, progress_callback)
            
        except Exception as e:
            logger.error(f"FFmpeg execution failed: {e}")
            logger.warning("Falling back to ffmpeg CPU extraction")
            return self._extract_frames_ffmpeg_cpu(video_path, output_dir, extraction_config, progress_callback)
        
        # Collect extracted frame paths
        extracted_frames = sorted([
            str(f) for f in output_dir.glob("frame_*.jpg")
        ])
        
        # Limit to max_frames if in frames mode
        if extraction_config.get('smart_frame_selection', False):
            extracted_frames = self._score_and_select_extracted_frames(
                extracted_frames,
                extraction_config,
                total_frames=total_frames,
                fps=fps,
                sampling_plan=sampling_plan,
                progress_callback=progress_callback,
            )
            self.last_extraction_stats['strategy'] = f'ffmpeg_{gpu_info["method"]}_oversample_select'
        elif mode == 'frames':
            max_frames = extraction_config.get('max_frames', 100)
            if len(extracted_frames) > max_frames:
                # Keep evenly distributed frames
                step = len(extracted_frames) / max_frames
                indices = [int(i * step) for i in range(max_frames)]
                frames_to_keep = [extracted_frames[i] for i in indices]
                
                # Remove extra frames
                for f in extracted_frames:
                    if f not in frames_to_keep:
                        try:
                            os.remove(f)
                        except Exception:
                            pass
                
                extracted_frames = frames_to_keep
                
                # Rename to sequential numbering
                for i, old_path in enumerate(extracted_frames):
                    new_path = output_dir / f"frame_{i:06d}.jpg"
                    if old_path != str(new_path):
                        try:
                            os.rename(old_path, new_path)
                            extracted_frames[i] = str(new_path)
                        except Exception:
                            pass
        
        logger.info(f"✅ GPU extraction complete: {len(extracted_frames)} frames")
        
        if extraction_config.get('smart_frame_selection', False):
            self.last_extraction_stats = self._append_sampling_plan_stats({
                **self.last_extraction_stats,
                'mode': mode,
                'candidate_count': expected_frames,
            }, sampling_plan)
        else:
            self.last_extraction_stats = self._append_sampling_plan_stats({
                'strategy': f'ffmpeg_{gpu_info["method"]}',
                'mode': mode,
                'requested_targets': expected_frames,
                'candidate_count': expected_frames,
                'saved_frames': len(extracted_frames),
                'replaced_targets': 0,
                'search_radius': 0,
                'rejected_candidates': 0,
                'selections': [],
            }, sampling_plan)

        # Final progress callback
        if progress_callback and extracted_frames:
            progress_callback(len(extracted_frames), self._get_target_output_count(total_frames, fps, extraction_config), extracted_frames[-1])
        
        return extracted_frames
    
    def _get_video_info_ffprobe(self, video_path) -> Optional[Dict[str, Any]]:
        """Get video info using ffprobe."""
        try:
            cmd = [
                'ffprobe', '-v', 'quiet', '-print_format', 'json',
                '-show_format', '-show_streams', str(video_path)
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, check=True, timeout=30)
            data = json.loads(result.stdout)
            
            video_streams = [s for s in data.get('streams', []) if s.get('codec_type') == 'video']
            if not video_streams:
                return None
            
            stream = video_streams[0]
            format_info = data.get('format', {})
            
            # Parse frame rate (can be "30/1" or "29.97")
            fps_str = stream.get('r_frame_rate', '30/1')
            if '/' in fps_str:
                num, den = fps_str.split('/')
                fps = float(num) / float(den) if float(den) != 0 else 30.0
            else:
                fps = float(fps_str)
            
            duration = float(format_info.get('duration', 0))
            if duration == 0:
                duration = float(stream.get('duration', 0))
            
            total_frames = int(stream.get('nb_frames', 0))
            if total_frames == 0:
                total_frames = int(duration * fps)
            
            return {
                'total_frames': total_frames,
                'fps': fps,
                'width': int(stream.get('width', 0)),
                'height': int(stream.get('height', 0)),
                'duration': duration,
                'codec_name': stream.get('codec_name', 'unknown'),
                'pix_fmt': stream.get('pix_fmt', ''),
                'profile': stream.get('profile', ''),
                'bit_rate': int(stream.get('bit_rate') or format_info.get('bit_rate') or 0),
            }
        except Exception as e:
            logger.warning(f"ffprobe failed: {e}")
            return None
    
    def _extract_frames_cpu(self, video_path, output_dir, extraction_config, progress_callback=None):
        """
        CPU-based frame extraction using OpenCV (original implementation).
        
        This is the fallback method when GPU acceleration is not available.
        """
        # This is essentially the original extract_frames implementation
        video_path = Path(video_path)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {video_path}")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        duration = total_frames / fps if fps > 0 else 0

        logger.info(f"CPU extraction: {total_frames} frames, {fps:.2f} fps, {duration:.2f}s, {width}x{height}")

        # Calculate frame extraction interval based on mode
        mode = extraction_config.get('mode', 'frames')

        if mode == 'fps':
            target_fps = extraction_config.get('target_fps', 1.0)
            frame_interval = max(1, int(fps / target_fps))
            max_frames = None
            logger.info(f"FPS mode: extracting at {target_fps} FPS, interval={frame_interval}")
        else:
            max_frames = extraction_config.get('max_frames', 100)
            frame_interval = max(1, total_frames // max_frames) if max_frames < total_frames else 1
            logger.info(f"Frame mode: extracting up to {max_frames} frames, interval={frame_interval}")

        # Get resolution setting (supports both new 'resolution' and legacy 'quality')
        resolution = extraction_config.get('resolution')
        if not resolution:
            # Fallback to legacy quality percentage
            quality_percent = extraction_config.get('quality', 100)
            resolution = convert_legacy_quality_to_resolution(quality_percent)
            logger.info(f"Using legacy quality {quality_percent}% → resolution preset: {resolution}")
        
        # Get target dimensions based on resolution preset
        target_width, target_height, jpeg_quality = get_target_dimensions(resolution, width, height)
        logger.info(f"Target resolution: {target_width}x{target_height} ({resolution}), JPEG quality: {jpeg_quality}")
        
        # Calculate if scaling is needed
        need_scale = (target_width != width or target_height != height)
        if need_scale:
            logger.info(f"Scaling: {width}x{height} → {target_width}x{target_height}")

        sampling_plan = self._build_sampling_plan(total_frames, fps, extraction_config)
        timeline_entries = self._build_timeline_target_entries(total_frames, fps, extraction_config)
        if timeline_entries and extraction_config.get('video_capture_mode') == 'simulated_360_positions':
            cap.release()
            return self._extract_timeline_groups_cpu(
                video_path,
                output_dir,
                extraction_config,
                progress_callback,
                total_frames=total_frames,
                fps=fps,
                target_width=target_width,
                target_height=target_height,
                need_scale=need_scale,
                jpeg_quality=jpeg_quality,
                quality_percent=extraction_config.get('quality', 100),
                search_radius=max(1, int(extraction_config.get('replacement_search_radius', 4))),
                sampling_plan=sampling_plan,
                timeline_entries=timeline_entries,
            )
        extracted_frames = []
        saved_count = 0
        prev_frame = None
        target_indices = [int(entry['target_index']) for entry in timeline_entries] if timeline_entries else self._build_target_frame_indices(total_frames, fps, extraction_config)
        search_radius = max(1, int(extraction_config.get('replacement_search_radius', 4)))
        quality_percent = extraction_config.get('quality', 100)
        selection_records = []
        replaced_targets = 0
        rejected_candidates = 0
        frame_manifest = []
        
        # Use ThreadPoolExecutor for parallel frame saving
        max_workers = min(os.cpu_count() or 4, 8)
        pending_saves = []

        def save_frame_task(frame_rgb, frame_path, jpeg_quality):
            """Save a single frame to disk."""
            try:
                pil_image = Image.fromarray(frame_rgb)
                pil_image.save(frame_path, 'JPEG', quality=jpeg_quality, optimize=True)
                return str(frame_path)
            except Exception as e:
                logger.error(f"Error saving frame to {frame_path}: {e}")
                return None

        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            expected_total = len(target_indices)
            for item_index, target_index in enumerate(target_indices):
                target_entry = timeline_entries[item_index] if item_index < len(timeline_entries) else None
                selection = self._select_best_frame_near_target(
                    cap,
                    target_index,
                    total_frames,
                    prev_frame,
                    quality_percent,
                    search_radius,
                )
                selection_records.append(selection)
                rejected_candidates += selection['rejected_candidates']

                if selection['selected_index'] != target_index:
                    replaced_targets += 1

                frame = selection['frame']
                if frame is None:
                    logger.warning(f"Could not recover a usable frame near target index {target_index}")
                    continue

                try:
                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                    if need_scale:
                        frame_rgb = cv2.resize(
                            frame_rgb,
                            (target_width, target_height),
                            interpolation=cv2.INTER_LANCZOS4,
                        )

                except Exception as e:
                    logger.error(f"Error processing frame {saved_count}: {e}")
                    continue

                frame_filename = target_entry['image_name'] if target_entry else f"frame_{saved_count:06d}.jpg"
                frame_path = output_dir / frame_filename

                future = executor.submit(save_frame_task, frame_rgb.copy(), frame_path, jpeg_quality)
                pending_saves.append((future, frame_path, saved_count))

                source_time_seconds = (selection['selected_index'] / fps) if fps > 0 else None
                frame_manifest.append({
                    'image_name': frame_filename,
                    'source_video_path': str(video_path),
                    'source_frame_index': int(selection['selected_index']),
                    'source_time_seconds': round(float(source_time_seconds), 6) if source_time_seconds is not None else None,
                    'accepted': bool(selection['accepted']),
                    'sharpness': round(float(selection['metrics']['sharpness']), 4),
                    'target_time_seconds': target_entry.get('target_time_seconds') if target_entry else None,
                    'segment_id': target_entry.get('segment_id') if target_entry else None,
                    'segment_label': target_entry.get('segment_label') if target_entry else None,
                    'segment_start_time': target_entry.get('segment_start_time') if target_entry else None,
                    'segment_end_time': target_entry.get('segment_end_time') if target_entry else None,
                    'position_index': target_entry.get('position_index') if target_entry else None,
                    'sample_index': target_entry.get('sample_index') if target_entry else None,
                })

                saved_count += 1
                prev_frame = frame.copy()

                if progress_callback and (saved_count % 5 == 0 or saved_count == expected_total):
                    try:
                        progress_callback(saved_count, expected_total, str(frame_path))
                    except Exception as cb_err:
                        logger.warning(f"Progress callback error: {cb_err}")

                if saved_count % 10 == 0:
                    logger.info(f"Extracted {saved_count} frames so far...")

            # Wait for all saves to complete
            for future, frame_path, idx in pending_saves:
                try:
                    result = future.result(timeout=30)
                    if result:
                        extracted_frames.append(result)
                except Exception as e:
                    logger.error(f"Failed to save frame {idx}: {e}")

        cap.release()
        
        # Sort frames by filename
        extracted_frames.sort()

        timeline_plan = self._get_timeline_plan(extraction_config)
        timeline_summary = None
        if timeline_plan is not None:
            timeline_summary = {
                'segment_count': len(list(timeline_plan.get('segments') or [])),
                'total_sample_count': len(timeline_entries),
                'duration_seconds': timeline_plan.get('duration') or (float(total_frames / fps) if fps > 0 else None),
                'filename_pattern': 'pos001_0001.jpg',
            }

        self.last_extraction_stats = self._append_sampling_plan_stats({
            'strategy': 'smart_neighbor_replacement',
            'mode': 'timeline_plan' if timeline_entries else mode,
            'video_capture_mode': extraction_config.get('video_capture_mode'),
            'video_timeline_summary': timeline_summary,
            'requested_targets': len(target_indices),
            'saved_frames': len(extracted_frames),
            'replaced_targets': replaced_targets,
            'search_radius': search_radius,
            'rejected_candidates': rejected_candidates,
            'selections': [
                {
                    'target_index': item['target_index'],
                    'selected_index': item['selected_index'],
                    'offset': item['selected_index'] - item['target_index'],
                    'sharpness': round(item['metrics']['sharpness'], 2),
                    'accepted': item['accepted'],
                    'fallback_used': item['fallback_used'],
                    'source_time_seconds': round(float(item['selected_index'] / fps), 6) if fps > 0 else None,
                }
                for item in selection_records
                if item.get('selected_index') is not None
            ],
            'frame_manifest': frame_manifest,
            'source_video_path': str(video_path),
            'source_total_frames': int(total_frames),
            'source_fps': float(fps or 0.0),
        }, sampling_plan)

        logger.info(f"CPU extraction complete: {len(extracted_frames)} frames from {total_frames} total")
        return extracted_frames

    def _extract_timeline_groups_cpu(
        self,
        video_path,
        output_dir,
        extraction_config,
        progress_callback,
        *,
        total_frames: int,
        fps: float,
        target_width: int,
        target_height: int,
        need_scale: bool,
        jpeg_quality: int,
        quality_percent: int,
        search_radius: int,
        sampling_plan: Dict[str, Any],
        timeline_entries: List[Dict[str, Any]],
    ):
        grouped_entries: Dict[int, List[Dict[str, Any]]] = {}
        for entry in timeline_entries:
            grouped_entries.setdefault(int(entry.get('position_index') or 0), []).append(entry)

        requested_workers = int(extraction_config.get('ffmpeg_cpu_workers') or 0)
        max_group_workers = requested_workers if requested_workers > 0 else (os.cpu_count() or 4)
        group_workers = max(1, min(max_group_workers, len(grouped_entries)))

        logger.info(
            f"📍 Simulated 360 CPU extraction: processing {len(grouped_entries)} position groups with {group_workers} workers while preserving sharp-frame scoring"
        )

        def save_frame(frame_rgb, frame_path):
            pil_image = Image.fromarray(frame_rgb)
            pil_image.save(frame_path, 'JPEG', quality=jpeg_quality, optimize=True)
            return str(frame_path)

        def process_group(position_index: int, entries: List[Dict[str, Any]]):
            cap = cv2.VideoCapture(str(video_path))
            if not cap.isOpened():
                raise RuntimeError(f"Could not open video for group {position_index}: {video_path}")

            prev_frame = None
            group_results = []
            try:
                for entry in entries:
                    target_index = int(entry['target_index'])
                    selection = self._select_best_frame_near_target(
                        cap,
                        target_index,
                        total_frames,
                        prev_frame,
                        quality_percent,
                        search_radius,
                    )

                    frame = selection['frame']
                    if frame is None:
                        logger.warning(f"Could not recover a usable frame near target index {target_index}")
                        continue

                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    if need_scale:
                        frame_rgb = cv2.resize(
                            frame_rgb,
                            (target_width, target_height),
                            interpolation=cv2.INTER_LANCZOS4,
                        )

                    frame_path = output_dir / entry['image_name']
                    saved_path = save_frame(frame_rgb, frame_path)
                    selected_index = int(selection['selected_index'])
                    source_time_seconds = (selected_index / fps) if fps > 0 else None
                    group_results.append({
                        'saved_path': saved_path,
                        'selection': selection,
                        'frame_manifest': {
                            'image_name': entry['image_name'],
                            'source_video_path': str(video_path),
                            'source_frame_index': selected_index,
                            'source_time_seconds': round(float(source_time_seconds), 6) if source_time_seconds is not None else None,
                            'accepted': bool(selection['accepted']),
                            'sharpness': round(float(selection['metrics']['sharpness']), 4),
                            'target_time_seconds': entry.get('target_time_seconds'),
                            'segment_id': entry.get('segment_id'),
                            'segment_label': entry.get('segment_label'),
                            'segment_start_time': entry.get('segment_start_time'),
                            'segment_end_time': entry.get('segment_end_time'),
                            'sampling_mode': entry.get('sampling_mode'),
                            'target_fps': entry.get('target_fps'),
                            'position_index': entry.get('position_index'),
                            'sample_index': entry.get('sample_index'),
                        },
                    })
                    prev_frame = frame.copy()
            finally:
                cap.release()

            return {
                'position_index': position_index,
                'results': group_results,
            }

        extracted_frames: List[str] = []
        selection_records = []
        frame_manifest = []
        rejected_candidates = 0
        replaced_targets = 0
        completed_saves = 0
        expected_total = len(timeline_entries)

        with ThreadPoolExecutor(max_workers=group_workers) as executor:
            futures = [
                executor.submit(process_group, position_index, entries)
                for position_index, entries in sorted(grouped_entries.items())
            ]
            for future in as_completed(futures):
                group_payload = future.result()
                for item in group_payload['results']:
                    extracted_frames.append(item['saved_path'])
                    selection = item['selection']
                    selection_records.append(selection)
                    rejected_candidates += selection['rejected_candidates']
                    if selection['selected_index'] != selection['target_index']:
                        replaced_targets += 1
                    frame_manifest.append(item['frame_manifest'])
                    completed_saves += 1
                    if progress_callback and (completed_saves % 5 == 0 or completed_saves == expected_total):
                        try:
                            progress_callback(completed_saves, expected_total, item['saved_path'])
                        except Exception as cb_err:
                            logger.warning(f"Progress callback error: {cb_err}")

        extracted_frames.sort()
        frame_manifest.sort(key=lambda item: item['image_name'])
        selection_records.sort(key=lambda item: item.get('target_index') or -1)

        timeline_plan = self._get_timeline_plan(extraction_config) or {}
        timeline_summary = {
            'segment_count': len(list(timeline_plan.get('segments') or [])),
            'total_sample_count': len(timeline_entries),
            'duration_seconds': timeline_plan.get('duration') or (float(total_frames / fps) if fps > 0 else None),
            'filename_pattern': 'pos001_0001.jpg',
        }

        self.last_extraction_stats = self._append_sampling_plan_stats({
            'strategy': f'smart_neighbor_replacement_parallel_groups_{group_workers}x',
            'mode': 'timeline_plan',
            'video_capture_mode': extraction_config.get('video_capture_mode'),
            'video_timeline_summary': timeline_summary,
            'requested_targets': len(timeline_entries),
            'saved_frames': len(extracted_frames),
            'replaced_targets': replaced_targets,
            'search_radius': search_radius,
            'rejected_candidates': rejected_candidates,
            'scoring_workers': group_workers,
            'parallel_group_workers': group_workers,
            'parallel_group_count': len(grouped_entries),
            'selections': [
                {
                    'target_index': item['target_index'],
                    'selected_index': item['selected_index'],
                    'offset': item['selected_index'] - item['target_index'],
                    'sharpness': round(item['metrics']['sharpness'], 2),
                    'accepted': item['accepted'],
                    'fallback_used': item['fallback_used'],
                    'source_time_seconds': round(float(item['selected_index'] / fps), 6) if fps > 0 else None,
                }
                for item in selection_records
                if item.get('selected_index') is not None
            ],
            'frame_manifest': frame_manifest,
            'source_video_path': str(video_path),
            'source_total_frames': int(total_frames),
            'source_fps': float(fps or 0.0),
        }, sampling_plan)

        logger.info(f"CPU timeline extraction complete: {len(extracted_frames)} frames across {len(grouped_entries)} groups")
        return extracted_frames

    def extract_frames(self, video_path, output_dir, extraction_config=None, progress_callback=None):
        """
        Extract frames from video with quality settings.
        
        Automatically uses GPU acceleration if available (5-10x faster),
        with automatic fallback to CPU extraction.

        Args:
            video_path: Path to input video
            output_dir: Directory to save extracted frames
            extraction_config: Dict with extraction configuration:
                {
                    'mode': 'frames' | 'fps' (default 'frames'),
                    'max_frames': int (for 'frames' mode, default 100),
                    'target_fps': float (for 'fps' mode, default 1.0),
                    'quality': 100 | 75 | 50 (percentage, default 100),
                    'preview_count': int (number of frames to preview, default 10),
                    'use_gpu': bool (default True, auto-detect and use GPU if available)
                }
            progress_callback: Optional callback function(current_frame, total_expected, frame_path)
                Called after each frame is extracted for progress tracking

        Returns:
            List of extracted frame paths
        """
        # Default configuration
        if extraction_config is None:
            extraction_config = {
                'mode': 'frames',
                'max_frames': 100,
                'quality': 100,
                'preview_count': 10,
                'use_gpu': True,
                'smart_frame_selection': False,
                'oversample_factor': 10,
                'adaptive_frame_budget': False,
            }

        # Check if GPU should be used
        use_gpu = extraction_config.get('use_gpu', True)
        smart_selection = extraction_config.get('smart_frame_selection', False)
        self.last_extraction_stats = {}
        timeline_plan = self._get_timeline_plan(extraction_config)

        if smart_selection:
            logger.info("🧠 Smart frame selection enabled; frames will be oversampled, scored, and pruned back to the requested output count")

        if timeline_plan is not None:
            logger.info("📍 Timeline-guided extraction enabled; using explicit station segments with CPU frame selection")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)

        if use_gpu:
            gpu_info = get_gpu_decode_info()
            if gpu_info['available']:
                logger.info(f"🎮 GPU acceleration enabled: {gpu_info['method'].upper()}")
                if gpu_info['gpu_name']:
                    logger.info(f"   GPU: {gpu_info['gpu_name']}")
                return self._extract_frames_gpu(video_path, output_dir, extraction_config, progress_callback)
            else:
                logger.info("⚠️ GPU acceleration not available, using ffmpeg CPU extraction")
                for detail in gpu_info['details']:
                    logger.debug(f"   {detail}")
        else:
            logger.info("🖥️ GPU acceleration disabled by config, using ffmpeg CPU extraction")

        if shutil.which('ffmpeg'):
            return self._extract_frames_ffmpeg_cpu(video_path, output_dir, extraction_config, progress_callback)

        logger.warning("FFmpeg not found, falling back to OpenCV CPU extraction")
        return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)

    def get_last_extraction_stats(self) -> Dict[str, Any]:
        return dict(self.last_extraction_stats)

    def get_preview_frames(self, video_path, preview_count=10, quality_percent=50):
        """Extract preview frames for display"""
        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            return []

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        interval = max(1, total_frames // preview_count)

        preview_frames = []
        frame_idx = 0

        while len(preview_frames) < preview_count and frame_idx < total_frames:
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
            ret, frame = cap.read()

            if ret:
                # Convert to RGB and resize for preview
                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                height, width = frame_rgb.shape[:2]
                scale = quality_percent / 100.0
                new_width = int(width * scale)
                new_height = int(height * scale)
                frame_rgb = cv2.resize(frame_rgb, (new_width, new_height), interpolation=cv2.INTER_LANCZOS4)

                # Convert to base64 for display
                img = Image.fromarray(frame_rgb)
                preview_frames.append(img)

            frame_idx += interval

        cap.release()
        return preview_frames

    def _get_timeline_plan(self, extraction_config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if extraction_config.get('video_capture_mode') != 'simulated_360_positions':
            return None

        plan = extraction_config.get('video_timeline_plan')
        if not isinstance(plan, dict):
            return None

        if not list(plan.get('segments') or []):
            return None

        return plan

    def _build_timeline_target_entries(
        self,
        total_frames: int,
        fps: float,
        extraction_config: Dict[str, Any],
    ) -> List[Dict[str, Any]]:
        plan = self._get_timeline_plan(extraction_config)
        if total_frames <= 0 or plan is None:
            return []

        duration = (total_frames / fps) if fps > 0 else float(plan.get('duration') or 0.0)
        replacement_search_radius = max(1, int(extraction_config.get('replacement_search_radius', 4) or 4))
        segment_tail_margin_seconds = 0.0
        clip_tail_margin_seconds = 0.0
        if fps > 0:
            segment_tail_margin_seconds = max(
                1.0 / fps,
                float(extraction_config.get('timeline_segment_tail_margin_seconds') or 0.0),
            )
            default_clip_tail_margin_seconds = max(
                segment_tail_margin_seconds,
                float(replacement_search_radius + 1) / fps,
            )
            if duration > 0:
                default_clip_tail_margin_seconds = max(
                    default_clip_tail_margin_seconds,
                    min(4.0, duration * 0.04),
                )
            clip_tail_margin_seconds = max(
                default_clip_tail_margin_seconds,
                float(extraction_config.get('timeline_clip_tail_margin_seconds') or 0.0),
            )
            clip_tail_margin_seconds += segment_tail_margin_seconds
        entries: List[Dict[str, Any]] = []

        for segment_index, segment in enumerate(list(plan.get('segments') or []), start=1):
            start_time = float(segment.get('start_time') or 0.0)
            end_time = float(segment.get('end_time') or start_time)
            sampling_mode = str(segment.get('sampling_mode') or 'count').strip().lower()
            target_fps = float(segment.get('target_fps') or extraction_config.get('target_fps') or 1.0)
            sample_count = max(1, int(segment.get('sample_count') or 1))
            position_index = int(segment.get('position_index') or segment_index)

            if duration > 0:
                start_time = min(max(start_time, 0.0), duration)
                end_time = min(max(end_time, start_time), duration)

            effective_end_time = end_time
            if fps > 0:
                effective_end_time = max(start_time, end_time - segment_tail_margin_seconds)
                if duration > 0:
                    safe_clip_end = max(start_time, duration - clip_tail_margin_seconds)
                    effective_end_time = min(effective_end_time, safe_clip_end)

            if sampling_mode == 'fps':
                sample_count = max(1, int(math.floor(max(0.0, effective_end_time - start_time) * max(0.1, target_fps))) + 1)

            sample_times = [start_time + ((effective_end_time - start_time) / 2.0)]
            if sample_count > 1:
                sample_times = np.linspace(start_time, effective_end_time, num=sample_count).tolist()

            for sample_index, sample_time in enumerate(sample_times, start=1):
                normalized_time = float(sample_time)
                target_index = int(round(normalized_time * fps)) if fps > 0 else sample_index - 1
                target_index = max(0, min(total_frames - 1, target_index))
                entries.append(
                    {
                        'target_index': target_index,
                        'target_time_seconds': round(normalized_time, 6),
                        'segment_id': str(segment.get('id') or f'segment-{segment_index}'),
                        'segment_label': str(segment.get('label') or f'Position {segment_index}'),
                        'segment_start_time': round(start_time, 6),
                        'segment_end_time': round(end_time, 6),
                        'sampling_mode': sampling_mode,
                        'target_fps': round(float(target_fps), 6) if sampling_mode == 'fps' else None,
                        'position_index': position_index,
                        'sample_index': sample_index,
                        'image_name': f"pos{position_index:03d}_{sample_index:04d}.jpg",
                    }
                )

        return entries

    def _is_good_quality_frame(self, frame, prev_frame, quality_percent=100):
        """
        Simple quality assessment for 3D reconstruction frames
        RELAXED thresholds to preserve more frames for better reconstruction coverage
        
        Args:
            quality_percent: User-selected quality (100, 75, 50) - affects filtering strictness
        """
        try:
            # Resize frame for quality analysis to speed up processing on high-res videos
            height, width = frame.shape[:2]
            if width > 1920 or height > 1080:
                # Downscale for quality analysis only
                scale = min(1920 / width, 1080 / height)
                new_width = int(width * scale)
                new_height = int(height * scale)
                analysis_frame = cv2.resize(frame, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
            else:
                analysis_frame = frame

            gray = cv2.cvtColor(analysis_frame, cv2.COLOR_BGR2GRAY)

            # RELAXED: Blur detection - much more lenient thresholds
            # Lower quality settings are more tolerant of blur
            laplacian_var = cv2.Laplacian(gray, cv2.CV_64F).var()
            
            if quality_percent == 100:
                blur_threshold = 30 if width > 1920 else 50  # Relaxed from 50/100
            elif quality_percent == 75:
                blur_threshold = 20 if width > 1920 else 35  # Very relaxed
            else:  # 50%
                blur_threshold = 15 if width > 1920 else 25  # Extremely relaxed
                
            if laplacian_var < blur_threshold:
                return False

            # RELAXED: Brightness check - wider acceptable range
            mean_brightness = gray.mean()
            if mean_brightness < 10 or mean_brightness > 245:  # Relaxed from 20-235
                return False

            # RELAXED: Similarity check - much more lenient
            # Only reject frames that are EXTREMELY similar (e.g., static camera on tripod)
            if prev_frame is not None:
                if width > 1920 or height > 1080:
                    prev_analysis = cv2.resize(prev_frame, (new_width, new_height), interpolation=cv2.INTER_LINEAR)
                else:
                    prev_analysis = prev_frame

                prev_gray = cv2.cvtColor(prev_analysis, cv2.COLOR_BGR2GRAY)
                diff = cv2.absdiff(gray, prev_gray)
                
                # RELAXED: Only reject if nearly identical (< 1 instead of < 3)
                if diff.mean() < 1:  # Extremely similar frames only
                    return False

            return True

        except Exception as e:
            logger.warning(f"Error in quality assessment, accepting frame: {e}")
            return True  # Accept frame if quality check fails

    def _build_target_frame_indices(self, total_frames: int, fps: float, extraction_config: Dict[str, Any]) -> List[int]:
        mode = extraction_config.get('mode', 'frames')
        if total_frames <= 0:
            return []

        timeline_entries = self._build_timeline_target_entries(total_frames, fps, extraction_config)
        if timeline_entries:
            return [int(entry['target_index']) for entry in timeline_entries]

        if mode == 'fps':
            target_fps = float(extraction_config.get('target_fps', 1.0) or 1.0)
            frame_interval = max(1, int(fps / target_fps)) if fps > 0 else 1
            return list(range(0, total_frames, frame_interval))

        max_frames = int(extraction_config.get('max_frames', 100) or 100)
        if max_frames >= total_frames:
            return list(range(total_frames))

        if max_frames <= 1:
            return [0]

        positions = np.linspace(0, total_frames - 1, num=max_frames)
        indices = [int(round(position)) for position in positions]
        deduped = []
        seen = set()
        for index in indices:
            index = max(0, min(total_frames - 1, index))
            if index not in seen:
                deduped.append(index)
                seen.add(index)
        return deduped

    def _get_target_output_count(self, total_frames: int, fps: float, extraction_config: Dict[str, Any]) -> int:
        timeline_entries = self._build_timeline_target_entries(total_frames, fps, extraction_config)
        if timeline_entries:
            return len(timeline_entries)

        mode = extraction_config.get('mode', 'frames')
        if mode == 'fps':
            target_fps = float(extraction_config.get('target_fps', 1.0) or 1.0)
            duration = total_frames / fps if fps > 0 else 0
            return max(1, min(total_frames, int(duration * target_fps)))
        max_frames = int(extraction_config.get('max_frames', 100) or 100)
        return max(1, min(total_frames, max_frames))

    def _get_oversample_factor(self, extraction_config: Dict[str, Any]) -> int:
        requested = int(extraction_config.get('oversample_factor', 10) or 10)
        return max(2, min(requested, 20))

    def _should_use_adaptive_frame_budget(self, extraction_config: Dict[str, Any]) -> bool:
        return bool(
            extraction_config.get('smart_frame_selection', False)
            and extraction_config.get('adaptive_frame_budget', False)
        )

    def _get_auto_tuning_snapshot(self, extraction_config: Dict[str, Any]) -> Dict[str, Any]:
        policy = dict(
            extraction_config.get('auto_tuning_policy')
            or extraction_config.get('_auto_tuning_policy')
            or {}
        )
        return dict(policy.get('active_snapshot') or {})

    def _collect_adaptive_budget_quality_telemetry(
        self,
        video_path,
        total_frames: int,
        extraction_config: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        if not self._should_use_adaptive_frame_budget(extraction_config):
            return None

        sample_count = int(extraction_config.get('adaptive_budget_sample_count', 12) or 12)
        sample_count = max(4, min(sample_count, 24))
        if total_frames <= 0:
            return None

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            logger.warning("Adaptive frame budget telemetry skipped: could not open video for preview sampling")
            return None

        quality_percent = int(extraction_config.get('quality', 100) or 100)
        sample_positions = np.linspace(0, total_frames - 1, num=min(sample_count, total_frames))
        sample_indices = []
        seen_indices = set()
        for position in sample_positions:
            frame_index = max(0, min(total_frames - 1, int(round(float(position)))))
            if frame_index not in seen_indices:
                sample_indices.append(frame_index)
                seen_indices.add(frame_index)

        samples = []
        prev_frame = None

        try:
            for frame_index in sample_indices:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                ret, frame = cap.read()
                if not ret or frame is None:
                    continue

                score_info = self._score_frame_candidate(frame, prev_frame, quality_percent)
                metrics = score_info['metrics']
                samples.append({
                    'frame_index': int(frame_index),
                    'accepted': bool(score_info['accepted']),
                    'sharpness': round(float(metrics['sharpness']), 4),
                    'brightness': round(float(metrics['brightness']), 4),
                    'diff_mean': (
                        round(float(metrics['diff_mean']), 4)
                        if metrics.get('diff_mean') is not None
                        else None
                    ),
                    'blur_threshold': round(float(metrics['blur_threshold']), 4),
                })
                prev_frame = frame
        finally:
            cap.release()

        if not samples:
            return None

        sharpness_values = [sample['sharpness'] for sample in samples]
        brightness_values = [sample['brightness'] for sample in samples]
        diff_values = [sample['diff_mean'] for sample in samples if sample['diff_mean'] is not None]
        blur_thresholds = [sample['blur_threshold'] for sample in samples]
        accepted_count = sum(1 for sample in samples if sample['accepted'])
        brightness_failures = sum(
            1 for sample in samples if sample['brightness'] < 10.0 or sample['brightness'] > 245.0
        )
        blur_failures = sum(
            1 for sample in samples if sample['sharpness'] < sample['blur_threshold']
        )
        duplicate_failures = sum(
            1 for sample in samples
            if sample['diff_mean'] is not None and sample['diff_mean'] < 1.0
        )
        sample_total = len(samples)

        return {
            'telemetry_source': 'adaptive_preview_samples',
            'requested_sample_count': sample_count,
            'sample_count': sample_total,
            'accepted_ratio': round(accepted_count / max(sample_total, 1), 4),
            'median_sharpness': round(float(np.median(sharpness_values)), 4),
            'p25_sharpness': round(float(np.percentile(sharpness_values, 25)), 4),
            'median_brightness': round(float(np.median(brightness_values)), 4),
            'median_blur_threshold': round(float(np.median(blur_thresholds)), 4),
            'median_diff_mean': round(float(np.median(diff_values)), 4) if diff_values else None,
            'brightness_failure_ratio': round(brightness_failures / max(sample_total, 1), 4),
            'blur_failure_ratio': round(blur_failures / max(sample_total, 1), 4),
            'duplicate_failure_ratio': round(duplicate_failures / max(sample_total, 1), 4),
            'samples': samples,
        }

    def _build_adaptive_frame_budget(
        self,
        total_frames: int,
        fps: float,
        extraction_config: Dict[str, Any],
        *,
        video_info: Optional[Dict[str, Any]] = None,
        quality_telemetry: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        if not self._should_use_adaptive_frame_budget(extraction_config):
            return None

        requested_oversample_factor = self._get_oversample_factor(extraction_config)
        target_output_count = self._get_target_output_count(total_frames, fps, extraction_config)
        video_info = dict(video_info or {})
        width = int(video_info.get('width') or 0)
        height = int(video_info.get('height') or 0)
        duration = float(video_info.get('duration') or ((total_frames / fps) if fps > 0 else 0.0))
        bitrate = int(video_info.get('bit_rate') or 0)
        codec_name = str(video_info.get('codec_name') or '').lower()
        auto_tuning_snapshot = self._get_auto_tuning_snapshot(extraction_config)
        frame_budget_tuning = dict(auto_tuning_snapshot.get('frame_budget') or {})
        scale = 1.0
        adjustments = []

        def apply_adjustment(code: str, factor: float, reason: str) -> None:
            nonlocal scale
            scale *= factor
            adjustments.append({
                'code': code,
                'factor': round(float(factor), 4),
                'reason': reason,
            })

        if duration >= 180 and target_output_count >= 120:
            apply_adjustment(
                'long_video_budget_pressure',
                0.9,
                f"duration {duration:.1f}s with {target_output_count} requested outputs increases decode cost",
            )
        if duration >= 600:
            apply_adjustment(
                'very_long_video_cap',
                0.85,
                f"duration {duration:.1f}s is long enough to justify a tighter candidate budget",
            )
        if fps >= 50:
            apply_adjustment(
                'high_source_fps',
                0.9,
                f"source fps {fps:.2f} already provides dense temporal coverage",
            )
        if width * height >= 3840 * 2160:
            apply_adjustment(
                'uhd_decode_cost',
                0.85,
                f"source resolution {width}x{height} increases decode and JPEG cost per candidate",
            )
        if bitrate >= 80_000_000:
            apply_adjustment(
                'high_bitrate_decode_cost',
                0.9,
                f"bitrate {bitrate / 1_000_000:.1f} Mbps suggests heavier decode cost",
            )
        if fps > 0 and fps <= 24 and total_frames > (target_output_count * max(2, requested_oversample_factor // 2)):
            apply_adjustment(
                'low_native_temporal_density',
                1.15,
                f"source fps {fps:.2f} leaves less temporal headroom per requested output",
            )
        if 0 < target_output_count <= 80 and duration >= 30:
            apply_adjustment(
                'small_target_headroom',
                1.1,
                f"only {target_output_count} outputs requested, so extra candidate density is affordable",
            )

        if quality_telemetry:
            accepted_ratio = float(quality_telemetry.get('accepted_ratio') or 0.0)
            blur_failure_ratio = float(quality_telemetry.get('blur_failure_ratio') or 0.0)
            duplicate_failure_ratio = float(quality_telemetry.get('duplicate_failure_ratio') or 0.0)
            median_sharpness = float(quality_telemetry.get('median_sharpness') or 0.0)
            median_blur_threshold = float(quality_telemetry.get('median_blur_threshold') or 0.0)

            if accepted_ratio < 0.55 or blur_failure_ratio >= 0.35:
                apply_adjustment(
                    'low_preview_acceptance',
                    1.25,
                    f"preview accepted ratio {accepted_ratio:.2f} with blur failure ratio {blur_failure_ratio:.2f} suggests harder footage",
                )
            elif accepted_ratio < 0.75:
                apply_adjustment(
                    'mixed_preview_acceptance',
                    1.1,
                    f"preview accepted ratio {accepted_ratio:.2f} suggests moderate quality churn",
                )
            elif accepted_ratio > 0.92 and median_blur_threshold > 0 and median_sharpness >= (median_blur_threshold * 2.0):
                apply_adjustment(
                    'clean_preview_signal',
                    0.9,
                    f"preview accepted ratio {accepted_ratio:.2f} and median sharpness {median_sharpness:.1f} indicate clean candidates",
                )

            if duplicate_failure_ratio >= 0.45 and accepted_ratio >= 0.8:
                apply_adjustment(
                    'duplicate_heavy_preview',
                    0.85,
                    f"preview duplicate failure ratio {duplicate_failure_ratio:.2f} suggests oversampling would add near-duplicates",
                )

        tuned_scale = float(frame_budget_tuning.get('scale') or 1.0)
        if abs(tuned_scale - 1.0) >= 0.01:
            apply_adjustment(
                'auto_tuned_budget_scale',
                tuned_scale,
                f"runtime evidence tuned frame budget scale to {tuned_scale:.2f}",
            )

        effective_oversample_factor = max(1, min(20, int(round(requested_oversample_factor * scale))))
        density_scale = effective_oversample_factor / max(requested_oversample_factor, 1)

        return {
            'enabled': True,
            'requested_oversample_factor': requested_oversample_factor,
            'effective_oversample_factor': effective_oversample_factor,
            'density_scale': round(float(density_scale), 4),
            'tuned_scale': round(float(tuned_scale), 4),
            'adjustments': adjustments,
            'target_output_count': int(target_output_count),
            'video_profile': {
                'total_frames': int(total_frames),
                'fps': round(float(fps or 0.0), 4),
                'duration': round(float(duration or 0.0), 4),
                'width': width,
                'height': height,
                'codec_name': codec_name or None,
                'bit_rate_mbps': round(float(bitrate) / 1_000_000, 4) if bitrate > 0 else None,
            },
            'quality_preview': quality_telemetry,
        }

    def _append_sampling_plan_stats(
        self,
        stats: Dict[str, Any],
        sampling_plan: Optional[Dict[str, Any]],
    ) -> Dict[str, Any]:
        if not sampling_plan:
            return stats

        stats['oversample_factor'] = sampling_plan['oversample_factor']
        stats['requested_oversample_factor'] = sampling_plan['requested_oversample_factor']
        stats['candidate_density_ratio'] = sampling_plan['candidate_density_ratio']
        if sampling_plan.get('adaptive_frame_budget') is not None:
            stats['adaptive_frame_budget'] = sampling_plan['adaptive_frame_budget']
        return stats

    def _build_sampling_plan(
        self,
        total_frames: int,
        fps: float,
        extraction_config: Dict[str, Any],
        *,
        video_info: Optional[Dict[str, Any]] = None,
        quality_telemetry: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        mode = extraction_config.get('mode', 'frames')
        smart_selection = extraction_config.get('smart_frame_selection', False)
        timeline_entries = self._build_timeline_target_entries(total_frames, fps, extraction_config)

        if timeline_entries:
            return {
                'mode': 'timeline_plan',
                'smart_selection': smart_selection,
                'target_output_count': len(timeline_entries),
                'candidate_count': len(timeline_entries),
                'target_fps': None,
                'extraction_fps': None,
                'sampling_filter': None,
                'oversample_factor': 1,
                'requested_oversample_factor': self._get_oversample_factor(extraction_config) if smart_selection else 1,
                'candidate_density_ratio': 1.0,
                'adaptive_frame_budget': None,
                'timeline_segment_count': len(list((self._get_timeline_plan(extraction_config) or {}).get('segments') or [])),
            }

        target_output_count = self._get_target_output_count(total_frames, fps, extraction_config)
        requested_oversample_factor = self._get_oversample_factor(extraction_config) if smart_selection else 1
        adaptive_budget = self._build_adaptive_frame_budget(
            total_frames,
            fps,
            extraction_config,
            video_info=video_info,
            quality_telemetry=quality_telemetry,
        )
        oversample_factor = (
            int(adaptive_budget['effective_oversample_factor'])
            if adaptive_budget is not None
            else requested_oversample_factor
        )

        if mode in {'fps', 'target_count'}:
            if mode == 'target_count':
                duration = total_frames / fps if fps > 0 else 0
                target_fps = (target_output_count / duration) if duration > 0 else float(extraction_config.get('target_fps', 1.0) or 1.0)
            else:
                target_fps = float(extraction_config.get('target_fps', 1.0) or 1.0)
            extraction_fps = target_fps
            if smart_selection:
                extraction_fps = min(fps, target_fps * oversample_factor) if fps > 0 else target_fps
            candidate_count = max(1, min(total_frames, int((total_frames / fps) * extraction_fps))) if fps > 0 else target_output_count
            sampling_filter = f"fps={extraction_fps}" if extraction_fps > 0 else None
            return {
                'mode': mode,
                'smart_selection': smart_selection,
                'target_output_count': target_output_count,
                'candidate_count': candidate_count,
                'target_fps': target_fps,
                'extraction_fps': extraction_fps,
                'sampling_filter': sampling_filter,
                'oversample_factor': oversample_factor,
                'requested_oversample_factor': requested_oversample_factor,
                'candidate_density_ratio': round(candidate_count / max(target_output_count, 1), 4),
                'adaptive_frame_budget': adaptive_budget,
            }

        max_frames = int(extraction_config.get('max_frames', 100) or 100)
        candidate_count = target_output_count
        if smart_selection:
            candidate_count = min(total_frames, max_frames * oversample_factor)
        if total_frames > candidate_count:
            select_interval = max(1, int(total_frames / candidate_count))
            sampling_filter = f"select='not(mod(n\\,{select_interval}))'"
        else:
            sampling_filter = None
        return {
            'mode': mode,
            'smart_selection': smart_selection,
            'target_output_count': target_output_count,
            'candidate_count': candidate_count,
            'target_fps': None,
            'extraction_fps': None,
            'sampling_filter': sampling_filter,
            'oversample_factor': oversample_factor,
            'requested_oversample_factor': requested_oversample_factor,
            'candidate_density_ratio': round(candidate_count / max(target_output_count, 1), 4),
            'adaptive_frame_budget': adaptive_budget,
        }

    def _estimate_candidate_source_indices(
        self,
        total_frames: int,
        candidate_count: int,
    ) -> List[int]:
        if total_frames <= 0 or candidate_count <= 0:
            return []

        if candidate_count == 1:
            return [0]

        positions = np.linspace(0, total_frames - 1, num=candidate_count)
        return [
            max(0, min(total_frames - 1, int(round(float(position)))))
            for position in positions
        ]

    def _get_effective_search_radius(self, total_frames: int, fps: float, extraction_config: Dict[str, Any]) -> int:
        requested_radius = max(1, int(extraction_config.get('replacement_search_radius', 4) or 4))
        if not extraction_config.get('smart_frame_selection', False):
            return requested_radius

        mode = extraction_config.get('mode', 'frames')
        if mode in {'fps', 'target_count'}:
            if mode == 'target_count':
                duration = total_frames / fps if fps > 0 else 0
                target_output_count = self._get_target_output_count(total_frames, fps, extraction_config)
                target_fps = (target_output_count / duration) if duration > 0 else 0
            else:
                target_fps = float(extraction_config.get('target_fps', 1.0) or 1.0)
            frame_interval = max(1, int(round(fps / target_fps))) if fps > 0 and target_fps > 0 else requested_radius
        else:
            target_indices = self._build_target_frame_indices(total_frames, fps, extraction_config)
            if len(target_indices) >= 2:
                spacings = [
                    target_indices[i + 1] - target_indices[i]
                    for i in range(len(target_indices) - 1)
                    if target_indices[i + 1] > target_indices[i]
                ]
                frame_interval = max(1, int(round(sum(spacings) / len(spacings)))) if spacings else requested_radius
            else:
                frame_interval = requested_radius

        dynamic_radius = max(requested_radius, frame_interval // 2)
        return min(dynamic_radius, max(requested_radius, frame_interval))

    def _score_frame_candidate(self, frame, prev_frame, quality_percent=100):
        height, width = frame.shape[:2]
        if width > 1920 or height > 1080:
            scale = min(1920 / width, 1080 / height)
            analysis_width = int(width * scale)
            analysis_height = int(height * scale)
            analysis_frame = cv2.resize(frame, (analysis_width, analysis_height), interpolation=cv2.INTER_LINEAR)
        else:
            analysis_frame = frame

        gray = cv2.cvtColor(analysis_frame, cv2.COLOR_BGR2GRAY)
        sharpness = cv2.Laplacian(gray, cv2.CV_64F).var()
        brightness = float(gray.mean())

        if quality_percent == 100:
            blur_threshold = 30 if width > 1920 else 50
        elif quality_percent == 75:
            blur_threshold = 20 if width > 1920 else 35
        else:
            blur_threshold = 15 if width > 1920 else 25

        brightness_ok = 10 <= brightness <= 245

        duplicate_penalty = 0.0
        diff_mean = None
        duplicate_ok = True
        if prev_frame is not None:
            if width > 1920 or height > 1080:
                prev_analysis = cv2.resize(prev_frame, (gray.shape[1], gray.shape[0]), interpolation=cv2.INTER_LINEAR)
            else:
                prev_analysis = prev_frame
            prev_gray = cv2.cvtColor(prev_analysis, cv2.COLOR_BGR2GRAY)
            diff_mean = float(cv2.absdiff(gray, prev_gray).mean())
            duplicate_ok = diff_mean >= 1.0
            duplicate_penalty = max(0.0, 1.5 - diff_mean) * 40.0

        brightness_penalty = abs(brightness - 128.0) * 0.3
        score = sharpness - brightness_penalty - duplicate_penalty
        accepted = bool(sharpness >= blur_threshold and brightness_ok and duplicate_ok)

        return {
            'accepted': accepted,
            'score': score,
            'metrics': {
                'sharpness': float(sharpness),
                'brightness': brightness,
                'diff_mean': diff_mean,
                'blur_threshold': float(blur_threshold),
            },
        }

    def _select_best_frame_near_target(
        self,
        cap,
        target_index: int,
        total_frames: int,
        prev_frame,
        quality_percent: int,
        search_radius: int,
    ) -> Dict[str, Any]:
        start = max(0, target_index - search_radius)
        end = min(total_frames - 1, target_index + search_radius)
        best_accepted = None
        best_fallback = None
        rejected_candidates = 0

        for candidate_index in range(start, end + 1):
            cap.set(cv2.CAP_PROP_POS_FRAMES, candidate_index)
            ret, frame = cap.read()
            if not ret:
                continue

            candidate = self._score_frame_candidate(frame, prev_frame, quality_percent)
            candidate.update({
                'target_index': target_index,
                'selected_index': candidate_index,
                'frame': frame,
            })

            if candidate['accepted']:
                if best_accepted is None or candidate['score'] > best_accepted['score']:
                    best_accepted = candidate
            else:
                rejected_candidates += 1

            if best_fallback is None or candidate['score'] > best_fallback['score']:
                best_fallback = candidate

        winner = best_accepted or best_fallback or {
            'target_index': target_index,
            'selected_index': None,
            'frame': None,
            'accepted': False,
            'score': float('-inf'),
            'metrics': {'sharpness': 0.0, 'brightness': 0.0, 'diff_mean': None, 'blur_threshold': 0.0},
        }
        winner['accepted'] = bool(winner.get('accepted', False))
        winner['fallback_used'] = bool(best_accepted is None)
        winner['rejected_candidates'] = rejected_candidates
        return winner

    def get_video_info(self, video_path):
        """Get basic video information"""
        cap = cv2.VideoCapture(str(video_path))

        if not cap.isOpened():
            return None

        info = {
            'total_frames': int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
            'fps': cap.get(cv2.CAP_PROP_FPS),
            'width': int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
            'height': int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            'duration': 0
        }

        if info['fps'] > 0:
            info['duration'] = info['total_frames'] / info['fps']

        cap.release()
        return info

    def extract_exact_frames(
        self,
        video_path,
        frame_requests,
        output_dir,
        *,
        resolution='2K',
        progress_callback=None,
    ):
        """Extract exact frame indices into predetermined output filenames."""
        video_path = Path(video_path)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        requests = sorted(
            [
                request for request in (frame_requests or [])
                if request.get('output_name') and request.get('frame_index') is not None
            ],
            key=lambda item: int(item['frame_index']),
        )
        if not requests:
            return []

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {video_path}")

        source_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        source_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        target_width, target_height, jpeg_quality = get_target_dimensions(
            resolution,
            source_width,
            source_height,
        )
        need_scale = target_width != source_width or target_height != source_height

        extracted_paths = []
        try:
            total_requests = len(requests)
            for index, request in enumerate(requests, start=1):
                frame_index = max(0, int(request['frame_index']))
                output_name = str(request['output_name'])
                output_path = output_dir / output_name

                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                ret, frame = cap.read()
                if not ret:
                    logger.warning(
                        "Could not read exact frame %s from %s",
                        frame_index,
                        video_path,
                    )
                    continue

                frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                if need_scale:
                    frame_rgb = cv2.resize(
                        frame_rgb,
                        (target_width, target_height),
                        interpolation=cv2.INTER_LANCZOS4,
                    )

                pil_image = Image.fromarray(frame_rgb)
                pil_image.save(str(output_path), 'JPEG', quality=jpeg_quality, optimize=True)
                extracted_paths.append(str(output_path))

                if progress_callback and (index % 5 == 0 or index == total_requests):
                    progress_callback(index, total_requests, str(output_path))
        finally:
            cap.release()

        return extracted_paths

    def estimate_frame_count(self, video_path, extraction_config=None):
        """Estimate how many frames will be extracted"""
        info = self.get_video_info(video_path)
        if not info:
            return 0

        if extraction_config is None:
            extraction_config = {'mode': 'frames', 'max_frames': 100}

        mode = extraction_config.get('mode', 'frames')

        if mode == 'fps':
            target_fps = extraction_config.get('target_fps', 1.0)
            estimated = int(info['duration'] * target_fps)
            return min(estimated, info['total_frames'])
        if mode == 'target_count':
            exact_count = extraction_config.get('max_frames', 100)
            return min(exact_count, info['total_frames'])
        else:
            max_frames = extraction_config.get('max_frames', 100)
            return min(max_frames, info['total_frames'])

    def get_extraction_preview(self, video_path, extraction_config=None):
        """Get preview of extraction results for UI"""
        info = self.get_video_info(video_path)
        if not info:
            return None

        if extraction_config is None:
            extraction_config = {'mode': 'frames', 'max_frames': 100, 'quality': 100}

        estimated_frames = self.estimate_frame_count(video_path, extraction_config)
        duration = info['duration']
        quality = extraction_config.get('quality', 100)
        mode = extraction_config.get('mode', 'frames')

        if mode == 'fps':
            target_fps = extraction_config.get('target_fps', 1.0)
            description = f"Extract at {target_fps} FPS (~{estimated_frames} frames) at {quality}% quality"
        elif mode == 'target_count':
            description = f"Extract exactly {estimated_frames} frames with FPS-style spacing at {quality}% quality"
        else:
            description = f"Extract up to {estimated_frames} frames at {quality}% quality"

        return {
            'estimated_frames': estimated_frames,
            'video_duration': duration,
            'video_fps': info['fps'],
            'quality_setting': f"{quality}%",
            'extraction_mode': mode,
            'description': description
        }

# Example usage
if __name__ == "__main__":
    processor = VideoProcessor()

    # Test video processing
    video_file = "test_video.mp4"  # Replace with actual video
    output_folder = "extracted_frames"

    try:
        frames = processor.extract_frames(video_file, output_folder, max_frames=50)
        print(f"Successfully extracted {len(frames)} frames")

        for i, frame_path in enumerate(frames[:5]):  # Show first 5
            print(f"Frame {i+1}: {frame_path}")

    except Exception as e:
        print(f"Error: {e}")
