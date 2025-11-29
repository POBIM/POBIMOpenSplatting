"""
Video processing utilities for extracting frames from video files
"""
import cv2
import os
from pathlib import Path
import numpy as np
from PIL import Image
import logging
import subprocess
import json

logger = logging.getLogger(__name__)

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

    def extract_frames(self, video_path, output_dir, extraction_config=None, progress_callback=None):
        """
        Extract frames from video with quality settings

        Args:
            video_path: Path to input video
            output_dir: Directory to save extracted frames
            extraction_config: Dict with extraction configuration:
                {
                    'mode': 'frames' | 'fps' (default 'frames'),
                    'max_frames': int (for 'frames' mode, default 100),
                    'target_fps': float (for 'fps' mode, default 1.0),
                    'quality': 100 | 75 | 50 (percentage, default 100),
                    'preview_count': int (number of frames to preview, default 10)
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
                'preview_count': 10
            }

        video_path = Path(video_path)
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise ValueError(f"Could not open video file: {video_path}. Consider converting to H.264 format.")

        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        duration = total_frames / fps if fps > 0 else 0

        # Validate video compatibility first (now that we have dimensions)
        validation = self.validate_video_compatibility(video_path)
        if not validation['is_compatible']:
            # Log warning but don't fail immediately for high-res videos or certain codecs
            if validation['codec_name'] not in ['hevc', 'h265'] and width <= 4096:
                cap.release()
                error_msg = f"Video is not compatible for processing: {video_path}\n"
                error_msg += f"Issues: {'; '.join(validation['issues'])}\n"
                if validation['recommendations']:
                    error_msg += f"Recommendations: {'; '.join(validation['recommendations'])}"
                raise ValueError(error_msg)
            else:
                logger.warning(f"Video compatibility issues detected but attempting processing anyway: {'; '.join(validation['issues'])}")

        logger.info(f"Video info: {total_frames} frames, {fps:.2f} fps, {duration:.2f}s, {width}x{height}")

        # Check for extremely high resolution videos
        if width > 4096 or height > 4096:
            logger.warning(f"High resolution video detected: {width}x{height}. This may cause memory issues.")

        # Verify we can actually read a frame
        test_ret, test_frame = cap.read()
        if not test_ret:
            cap.release()
            raise ValueError(f"Cannot read frames from video: {video_path}. Video may be corrupted or use unsupported codec.")
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)  # Reset to beginning

        logger.info(f"Successfully verified frame reading capability. Test frame shape: {test_frame.shape if test_ret else 'None'}")

        # Calculate frame extraction interval based on mode
        mode = extraction_config.get('mode', 'frames')

        if mode == 'fps':
            # FPS mode: extract frames at specific FPS rate
            target_fps = extraction_config.get('target_fps', 1.0)
            frame_interval = max(1, int(fps / target_fps))
            max_frames = None  # No limit in FPS mode
            logger.info(f"FPS mode: extracting at {target_fps} FPS, interval={frame_interval}")
        else:
            # Frame count mode: extract specific number of frames
            max_frames = extraction_config.get('max_frames', 100)
            frame_interval = max(1, total_frames // max_frames) if max_frames < total_frames else 1
            logger.info(f"Frame mode: extracting up to {max_frames} frames, interval={frame_interval}")

        # Get quality setting
        quality_percent = extraction_config.get('quality', 100)
        jpeg_quality = 95 if quality_percent == 100 else (85 if quality_percent == 75 else 75)

        # Quality-based maximum dimension limits
        # 100% = Full resolution support (up to 6240px for 4K-8K videos)
        # 75% = 4K support (up to 3840px)
        # 50% = 2K support (up to 2048px)
        if quality_percent == 100:
            max_dimension = 6240  # Support up to 6K videos at full quality
        elif quality_percent == 75:
            max_dimension = 3840  # Support 4K videos
        else:
            max_dimension = 2048  # 2K for lower quality settings

        # Calculate memory-efficient resize dimensions
        if width > max_dimension or height > max_dimension:
            scale_factor = min(max_dimension / width, max_dimension / height)
            target_width = int(width * scale_factor)
            target_height = int(height * scale_factor)
            logger.info(f"Resizing frames from {width}x{height} to {target_width}x{target_height} (quality={quality_percent}%, max_dim={max_dimension}px)")
        else:
            scale_factor = 1.0
            target_width, target_height = width, height
            logger.info(f"Preserving original resolution {width}x{height} (quality={quality_percent}%, max_dim={max_dimension}px)")

        extracted_frames = []
        frame_count = 0
        saved_count = 0

        # Previous frame for quality comparison
        prev_frame = None

        while True:
            ret, frame = cap.read()
            if not ret:
                break

            # Skip frames based on interval
            if frame_count % frame_interval != 0:
                frame_count += 1
                continue

            # Basic quality filtering (simplified)
            # RELAXED: More lenient quality check to preserve more frames for 3D reconstruction
            if self._is_good_quality_frame(frame, prev_frame, quality_percent):
                try:
                    # Convert BGR to RGB
                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                    # First resize for memory management (if needed)
                    if scale_factor < 1.0:
                        frame_rgb = cv2.resize(frame_rgb, (target_width, target_height), interpolation=cv2.INTER_LANCZOS4)
                        logger.debug(f"Resized frame for memory management: {frame_rgb.shape}")

                    # Additional resize if quality is not 100%
                    if quality_percent < 100:
                        height, width = frame_rgb.shape[:2]
                        scale = quality_percent / 100.0
                        new_width = int(width * scale)
                        new_height = int(height * scale)
                        frame_rgb = cv2.resize(frame_rgb, (new_width, new_height), interpolation=cv2.INTER_LANCZOS4)
                        logger.debug(f"Applied quality resize: {frame_rgb.shape}")

                except Exception as e:
                    logger.error(f"Error processing frame {saved_count}: {e}")
                    continue  # Skip this frame and continue

                # Save frame
                frame_filename = f"frame_{saved_count:06d}.jpg"
                frame_path = output_dir / frame_filename

                try:
                    # Save with specified quality
                    pil_image = Image.fromarray(frame_rgb)
                    pil_image.save(
                        frame_path,
                        'JPEG',
                        quality=jpeg_quality,
                        optimize=True
                    )

                    extracted_frames.append(str(frame_path))
                    saved_count += 1
                    prev_frame = frame.copy()

                    # Calculate expected total frames for progress
                    if mode == 'frames':
                        expected_total = max_frames if max_frames else total_frames // frame_interval
                    else:
                        expected_total = total_frames // frame_interval
                    
                    # Call progress callback if provided
                    if progress_callback:
                        try:
                            progress_callback(saved_count, expected_total, str(frame_path))
                        except Exception as cb_err:
                            logger.warning(f"Progress callback error: {cb_err}")

                    if saved_count % 10 == 0:  # Log every 10 frames
                        logger.info(f"Extracted {saved_count} frames so far...")

                    # Stop if we've reached max frames (only in frames mode)
                    if mode == 'frames':
                        if max_frames and saved_count >= max_frames:
                            break

                except Exception as e:
                    logger.error(f"Error saving frame {saved_count} to {frame_path}: {e}")
                    continue  # Skip this frame and continue

            frame_count += 1

        cap.release()

        logger.info(f"Extracted {saved_count} frames from {total_frames} total frames")
        return extracted_frames

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