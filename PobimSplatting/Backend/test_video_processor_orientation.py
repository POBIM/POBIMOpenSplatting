#!/usr/bin/env python3
"""Regression tests for video orientation handling during frame extraction."""

import unittest

import numpy as np

from PobimSplatting.Backend.utils.video_processor import (
    VideoProcessor,
    _with_display_dimensions,
    get_target_dimensions,
)


class VideoProcessorOrientationTests(unittest.TestCase):
    def test_rotated_landscape_stream_uses_portrait_display_dimensions(self):
        video_info = _with_display_dimensions({
            'width': 1920,
            'height': 1080,
            'rotation': 90,
        })

        self.assertEqual(video_info['display_width'], 1080)
        self.assertEqual(video_info['display_height'], 1920)

        target_width, target_height, _ = get_target_dimensions(
            '1080p',
            video_info['display_width'],
            video_info['display_height'],
        )
        self.assertLess(target_width, target_height)

    def test_opencv_frame_is_rotated_when_metadata_requires_portrait_display(self):
        processor = VideoProcessor()
        frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
        video_info = _with_display_dimensions({
            'width': 1920,
            'height': 1080,
            'rotation': 90,
        })

        oriented = processor._orient_opencv_frame(frame, video_info)

        self.assertEqual(oriented.shape[:2], (1920, 1080))


if __name__ == '__main__':
    unittest.main()
