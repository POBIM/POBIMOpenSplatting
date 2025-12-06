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


# Cache the GPU availability check
_GPU_DECODE_INFO: Optional[Dict[str, Any]] = None


def get_gpu_decode_info() -> Dict[str, Any]:
    """Get cached GPU decode availability info."""
    global _GPU_DECODE_INFO
    if _GPU_DECODE_INFO is None:
        _GPU_DECODE_INFO = check_gpu_decode_available()
        logger.info(f"GPU decode check: {_GPU_DECODE_INFO}")
    return _GPU_DECODE_INFO

class VideoProcessor:
    def __init__(self):
        self.supported_formats = {'.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v'}
        self.problematic_codecs = {'hevc', 'h265', 'av1'}  # Codecs that often cause issues
        self.recommended_codecs = {'h264', 'avc', 'mpeg4'}

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
            logger.warning("GPU decode not available, falling back to CPU extraction")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)
        
        logger.info(f"🚀 Using GPU-accelerated extraction ({gpu_info['method'].upper()})")
        
        # Get video info using ffprobe
        video_info = self._get_video_info_ffprobe(video_path)
        if not video_info:
            logger.warning("Could not get video info via ffprobe, falling back to CPU")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)
        
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
        
        if mode == 'fps':
            target_fps = extraction_config.get('target_fps', 1.0)
            expected_frames = int(duration * target_fps)
            fps_filter = f"fps={target_fps}"
        else:
            max_frames = extraction_config.get('max_frames', 100)
            expected_frames = min(max_frames, total_frames)
            # Select frames evenly distributed
            if total_frames > max_frames:
                select_interval = total_frames / max_frames
                fps_filter = f"select='not(mod(n\\,{int(select_interval)}))'"
            else:
                fps_filter = None
        
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
            cmd.extend(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'])
        elif gpu_info['method'] == 'vaapi':
            cmd.extend(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128'])
        
        cmd.extend(['-i', str(video_path)])
        
        if filter_chain:
            # For CUDA hwaccel, we need to transfer from GPU to CPU for filtering
            if gpu_info['method'] == 'nvdec':
                cmd.extend(['-vf', f'hwdownload,format=nv12,{filter_chain}'])
            else:
                cmd.extend(['-vf', filter_chain])
        elif gpu_info['method'] == 'nvdec':
            cmd.extend(['-vf', 'hwdownload,format=nv12'])
        
        cmd.extend([
            '-vsync', 'vfn',
            '-qscale:v', str(ffmpeg_quality),
            '-start_number', '0',
            output_pattern
        ])
        
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
            for line in process.stderr:
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
                logger.error(f"FFmpeg failed with return code {process.returncode}")
                logger.warning("Falling back to CPU extraction")
                return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)
            
        except Exception as e:
            logger.error(f"FFmpeg execution failed: {e}")
            logger.warning("Falling back to CPU extraction")
            return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)
        
        # Collect extracted frame paths
        extracted_frames = sorted([
            str(f) for f in output_dir.glob("frame_*.jpg")
        ])
        
        # Limit to max_frames if in frames mode
        if mode == 'frames':
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
        
        # Final progress callback
        if progress_callback and extracted_frames:
            progress_callback(len(extracted_frames), expected_frames, extracted_frames[-1])
        
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
                'codec_name': stream.get('codec_name', 'unknown')
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

        extracted_frames = []
        frame_count = 0
        saved_count = 0
        prev_frame = None
        
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
            while True:
                ret, frame = cap.read()
                if not ret:
                    break

                if frame_count % frame_interval != 0:
                    frame_count += 1
                    continue

                # Use resolution for quality check (map to approximate percentage)
                approx_quality = {'720p': 50, '1080p': 75, '2K': 75, '4K': 100, '8K': 100, 'original': 100}.get(resolution, 100)
                if self._is_good_quality_frame(frame, prev_frame, approx_quality):
                    try:
                        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                        # Apply scaling if needed
                        if need_scale:
                            frame_rgb = cv2.resize(frame_rgb, (target_width, target_height), 
                                                 interpolation=cv2.INTER_LANCZOS4)

                    except Exception as e:
                        logger.error(f"Error processing frame {saved_count}: {e}")
                        frame_count += 1
                        continue

                    frame_filename = f"frame_{saved_count:06d}.jpg"
                    frame_path = output_dir / frame_filename

                    # Submit save task to thread pool
                    future = executor.submit(save_frame_task, frame_rgb.copy(), frame_path, jpeg_quality)
                    pending_saves.append((future, frame_path, saved_count))
                    
                    saved_count += 1
                    prev_frame = frame.copy()

                    if mode == 'frames':
                        expected_total = max_frames if max_frames else total_frames // frame_interval
                    else:
                        expected_total = total_frames // frame_interval

                    if progress_callback and saved_count % 5 == 0:
                        try:
                            progress_callback(saved_count, expected_total, str(frame_path))
                        except Exception as cb_err:
                            logger.warning(f"Progress callback error: {cb_err}")

                    if saved_count % 10 == 0:
                        logger.info(f"Extracted {saved_count} frames so far...")

                    if mode == 'frames' and max_frames and saved_count >= max_frames:
                        break

                frame_count += 1

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

        logger.info(f"CPU extraction complete: {len(extracted_frames)} frames from {total_frames} total")
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
                'use_gpu': True
            }
        
        # Check if GPU should be used
        use_gpu = extraction_config.get('use_gpu', True)
        
        if use_gpu:
            gpu_info = get_gpu_decode_info()
            if gpu_info['available']:
                logger.info(f"🎮 GPU acceleration enabled: {gpu_info['method'].upper()}")
                if gpu_info['gpu_name']:
                    logger.info(f"   GPU: {gpu_info['gpu_name']}")
                return self._extract_frames_gpu(video_path, output_dir, extraction_config, progress_callback)
            else:
                logger.info("⚠️ GPU acceleration not available, using CPU extraction")
                for detail in gpu_info['details']:
                    logger.debug(f"   {detail}")
        else:
            logger.info("🖥️ GPU acceleration disabled by config, using CPU extraction")
        
        return self._extract_frames_cpu(video_path, output_dir, extraction_config, progress_callback)

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