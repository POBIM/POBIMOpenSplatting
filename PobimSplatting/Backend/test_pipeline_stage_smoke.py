#!/usr/bin/env python3
"""Smoke coverage for pipeline stage wiring after runner refactors."""

from __future__ import annotations

import unittest
from unittest import mock

from PobimSplatting.Backend.pipeline import runner
from PobimSplatting.Backend.pipeline import runtime_support
from PobimSplatting.Backend.pipeline import stage_features, stage_sparse, stage_training


class PipelineStageSmokeTests(unittest.TestCase):
    def test_stage_modules_expose_expected_entrypoints(self):
        self.assertTrue(callable(stage_features.run_feature_extraction_stage))
        self.assertTrue(callable(stage_features.run_feature_matching_stage))
        self.assertTrue(callable(stage_sparse.run_sparse_reconstruction_stage))
        self.assertTrue(callable(stage_sparse.run_model_conversion_stage))
        self.assertTrue(callable(stage_training.run_opensplat_training))
        self.assertTrue(callable(stage_training.finalize_project))

    def test_feature_wrapper_dispatches_helpers(self):
        helper_bundle = {'marker': 'feature'}
        with mock.patch.object(runner, '_feature_stage_helpers', return_value=helper_bundle), mock.patch.object(
            runner,
            '_run_feature_extraction_stage_impl',
            return_value='feature-ok',
        ) as feature_impl:
            result = runner.run_feature_extraction_stage('project', {'images_path': 'images'}, {'quality_mode': 'balanced'})

        self.assertEqual(result, 'feature-ok')
        feature_impl.assert_called_once_with(
            'project',
            {'images_path': 'images'},
            {'quality_mode': 'balanced'},
            None,
            helpers=helper_bundle,
        )

    def test_sparse_wrapper_dispatches_helpers(self):
        helper_bundle = {'marker': 'sparse'}
        with mock.patch.object(runner, '_sparse_stage_helpers', return_value=helper_bundle), mock.patch.object(
            runner,
            '_run_sparse_reconstruction_stage_impl',
            return_value='sparse-ok',
        ) as sparse_impl:
            result = runner.run_sparse_reconstruction_stage('project', {'sparse_path': 'sparse'}, {'sfm_engine': 'colmap'})

        self.assertEqual(result, 'sparse-ok')
        sparse_impl.assert_called_once_with(
            'project',
            {'sparse_path': 'sparse'},
            {'sfm_engine': 'colmap'},
            None,
            helpers=helper_bundle,
        )

    def test_training_wrapper_dispatches_helpers(self):
        helper_bundle = {'marker': 'training'}
        estimator = object()
        with mock.patch.object(runner, '_training_stage_helpers', return_value=helper_bundle), mock.patch.object(
            runner,
            '_run_opensplat_training_impl',
            return_value='training-ok',
        ) as training_impl:
            result = runner.run_opensplat_training(
                'project',
                {'project_path': 'project'},
                {'quality_mode': 'balanced'},
                1.0,
                {'estimate': 10},
                estimator,
            )

        self.assertEqual(result, 'training-ok')
        training_impl.assert_called_once_with(
            'project',
            {'project_path': 'project'},
            {'quality_mode': 'balanced'},
            1.0,
            {'estimate': 10},
            estimator,
            helpers=helper_bundle,
        )

    def test_boundary_densification_wrapper_injects_rerun_callbacks(self):
        with mock.patch.object(
            runner,
            '_run_boundary_frame_densification_recovery_impl',
            return_value='densify-ok',
        ) as densify_impl:
            result = runner.run_boundary_frame_densification_recovery(
                'project',
                {'project_path': 'project'},
                {'quality_mode': 'balanced'},
                {'matcher_type': 'sequential'},
            )

        self.assertEqual(result, 'densify-ok')
        self.assertEqual(densify_impl.call_args.args[:4], (
            'project',
            {'project_path': 'project'},
            {'quality_mode': 'balanced'},
            {'matcher_type': 'sequential'},
        ))
        self.assertIs(densify_impl.call_args.kwargs['rerun_feature_extraction_stage'], runner.run_feature_extraction_stage)
        self.assertIs(densify_impl.call_args.kwargs['rerun_feature_matching_stage'], runner.run_feature_matching_stage)
        self.assertIs(densify_impl.call_args.kwargs['rerun_sparse_reconstruction_stage'], runner.run_sparse_reconstruction_stage)

    def test_run_colmap_pipeline_sequences_stage_wrappers(self):
        call_order = []
        config = {'quality_mode': 'balanced', 'feature_method': 'sift', 'sfm_engine': 'colmap'}
        paths = {'images_path': '/tmp/images'}

        def record(name):
            def _inner(*args, **kwargs):
                call_order.append(name)
                if name == 'feature_extraction':
                    return {'matcher_type': 'sequential'}
                if name == 'feature_matching':
                    return {'matcher_type': 'sequential'}
                if name == 'sparse_reconstruction':
                    return {'matcher_type': 'sequential'}
                return None
            return _inner

        with mock.patch.object(runner.os, 'listdir', return_value=['a.jpg', 'b.jpg']), mock.patch.object(
            runner,
            'get_colmap_config',
            return_value={'matcher_type': 'sequential'},
        ), mock.patch.object(
            runner,
            'resolve_orbit_safe_policy',
            return_value=None,
        ), mock.patch.object(
            runner,
            'resolve_colmap_feature_pipeline_profile',
            return_value={'is_native_neural': False, 'description': 'classic', 'matcher_args': []},
        ), mock.patch.object(
            runner,
            'run_feature_extraction_stage',
            side_effect=record('feature_extraction'),
        ), mock.patch.object(
            runner,
            'run_feature_matching_stage',
            side_effect=record('feature_matching'),
        ), mock.patch.object(
            runner,
            'run_sparse_reconstruction_stage',
            side_effect=record('sparse_reconstruction'),
        ), mock.patch.object(
            runner,
            'run_model_conversion_stage',
            side_effect=record('model_conversion'),
        ), mock.patch.object(
            runner,
            'run_opensplat_training',
            side_effect=record('training'),
        ):
            runner.run_colmap_pipeline('project', paths, config, 0.0, {'estimate': 10}, object())

        self.assertEqual(
            call_order,
            ['feature_extraction', 'feature_matching', 'sparse_reconstruction', 'model_conversion', 'training'],
        )

    def test_describe_colmap_bundle_adjustment_mode_reports_dense_and_sparse_gpu_modes(self):
        with mock.patch.object(
            runtime_support,
            'get_colmap_ceres_capabilities',
            return_value={'ceres_cuda_enabled': True, 'ceres_cudss_enabled': False},
        ):
            dense_plan = runtime_support.describe_colmap_bundle_adjustment_mode('/tmp/colmap', 200, True)

        self.assertEqual(dense_plan['mode'], 'gpu_dense')
        self.assertEqual(dense_plan['runtime_summary'], 'GPU dense BA (DENSE_SCHUR)')

        with mock.patch.object(
            runtime_support,
            'get_colmap_ceres_capabilities',
            return_value={'ceres_cuda_enabled': True, 'ceres_cudss_enabled': True},
        ):
            sparse_plan = runtime_support.describe_colmap_bundle_adjustment_mode('/tmp/colmap', 500, True)

        self.assertEqual(sparse_plan['mode'], 'gpu_sparse')
        self.assertEqual(sparse_plan['runtime_summary'], 'GPU sparse BA via cuDSS (SPARSE_SCHUR)')

    def test_describe_colmap_bundle_adjustment_mode_reports_cpu_fallback(self):
        with mock.patch.object(
            runtime_support,
            'get_colmap_ceres_capabilities',
            return_value={'ceres_cuda_enabled': True, 'ceres_cudss_enabled': False},
        ):
            plan = runtime_support.describe_colmap_bundle_adjustment_mode('/tmp/colmap', 500, True)

        self.assertEqual(plan['mode'], 'cpu')
        self.assertEqual(plan['runtime_summary'], 'CPU bundle adjustment fallback')

    def test_stage_sparse_logs_runtime_bundle_adjustment_mode(self):
        ba_plan = {
            'summary': 'GPU bundle adjustment via DENSE_SCHUR',
            'runtime_summary': 'GPU dense BA (DENSE_SCHUR)',
            'detail': 'Dense GPU BA is active for this mapper run.',
        }
        sparse_tracker = {}

        with mock.patch.object(stage_sparse, 'append_log_line') as append_log_line:
            handled = stage_sparse._maybe_log_colmap_ba_runtime_event(
                'project',
                'Running bundle adjustment',
                sparse_tracker,
                ba_plan,
            )
            handled_again = stage_sparse._maybe_log_colmap_ba_runtime_event(
                'project',
                'Running bundle adjustment',
                sparse_tracker,
                ba_plan,
            )

        self.assertTrue(handled)
        self.assertTrue(handled_again)
        self.assertEqual(
            append_log_line.call_args_list,
            [
                mock.call('project', '[COLMAP] Bundle adjustment phase started: GPU dense BA (DENSE_SCHUR)'),
            ],
        )


if __name__ == '__main__':
    unittest.main()
