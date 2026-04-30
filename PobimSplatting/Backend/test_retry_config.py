#!/usr/bin/env python3
"""Coverage for retry-time configuration merging."""

from __future__ import annotations

import unittest

from PobimSplatting.Backend.routes import api


class RetryConfigTests(unittest.TestCase):
    def test_preset_quality_retry_clears_stale_opensplat_overrides(self):
        config = {
            "quality_mode": "hard",
            "iterations": 6000,
            "densify_grad_threshold": 0.00012,
            "refine_every": 60,
            "warmup_length": 900,
            "ssim_weight": 0.28,
            "crop_size": 512,
        }

        cleared = api._clear_stale_opensplat_retry_overrides(
            config,
            {
                "quality_mode": "fog",
                "training_live_preview_interval_percent": 1,
            },
        )

        self.assertEqual(
            cleared,
            [
                "iterations",
                "densify_grad_threshold",
                "refine_every",
                "warmup_length",
                "ssim_weight",
            ],
        )
        self.assertNotIn("iterations", config)
        self.assertNotIn("refine_every", config)
        self.assertEqual(config["crop_size"], 512)

    def test_preset_quality_retry_preserves_explicit_iteration_override(self):
        config = {
            "quality_mode": "hard",
            "iterations": 6000,
            "refine_every": 60,
        }

        cleared = api._clear_stale_opensplat_retry_overrides(
            config,
            {
                "quality_mode": "fog",
                "iterations": 12000,
            },
        )

        self.assertEqual(cleared, ["refine_every"])
        self.assertEqual(config["iterations"], 6000)
        self.assertNotIn("refine_every", config)

    def test_target_visits_retry_clears_stale_iteration_override(self):
        config = {
            "quality_mode": "production",
            "iterations": 6000,
            "refine_every": 60,
            "target_visits_per_image": 75,
        }

        cleared = api._clear_stale_opensplat_retry_overrides(
            config,
            {"target_visits_per_image": 50},
        )

        self.assertEqual(cleared, ["iterations", "refine_every"])
        self.assertNotIn("iterations", config)
        self.assertEqual(config["target_visits_per_image"], 75)

    def test_custom_quality_retry_keeps_training_overrides(self):
        config = {
            "quality_mode": "hard",
            "iterations": 6000,
            "refine_every": 60,
        }

        cleared = api._clear_stale_opensplat_retry_overrides(
            config,
            {"quality_mode": "custom"},
        )

        self.assertEqual(cleared, [])
        self.assertEqual(config["iterations"], 6000)
        self.assertEqual(config["refine_every"], 60)


if __name__ == "__main__":
    unittest.main()
