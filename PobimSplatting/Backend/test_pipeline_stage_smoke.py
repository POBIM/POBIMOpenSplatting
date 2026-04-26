#!/usr/bin/env python3
"""Smoke coverage for pipeline stage wiring after runner refactors."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest import mock

from PobimSplatting.Backend.pipeline import runner
from PobimSplatting.Backend.pipeline import config_builders
from PobimSplatting.Backend.pipeline import orbit_policy
from PobimSplatting.Backend.pipeline import recovery_planners
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

    def test_exhaustive_matching_drops_sequential_only_params(self):
        filtered, dropped = stage_features.filter_matcher_params_for_colmap(
            'exhaustive',
            {
                'SequentialMatching.overlap': '44',
                'SequentialMatching.quadratic_overlap': '1',
            },
        )

        self.assertEqual(filtered, {})
        self.assertEqual(
            dropped,
            {
                'SequentialMatching.overlap': '44',
                'SequentialMatching.quadratic_overlap': '1',
            },
        )

    def test_no_regression_floor_keeps_exhaustive_matcher_params_empty(self):
        colmap_cfg = {
            'matcher_type': 'exhaustive',
            'matcher_params': {},
            'mapper_params': {},
            'no_regression_floor': {
                'matcher_params': {
                    'SequentialMatching.overlap': '44',
                    'SequentialMatching.quadratic_overlap': '1',
                },
            },
        }

        updated, changed = orbit_policy.apply_no_regression_floor(colmap_cfg)

        self.assertFalse(changed)
        self.assertEqual(updated['matcher_params'], {})

    def test_no_regression_floor_still_applies_to_sequential_matcher(self):
        colmap_cfg = {
            'matcher_type': 'sequential',
            'matcher_params': {'SequentialMatching.overlap': '10'},
            'mapper_params': {},
            'no_regression_floor': {
                'matcher_params': {
                    'SequentialMatching.overlap': '44',
                    'SequentialMatching.quadratic_overlap': '1',
                },
            },
        }

        updated, changed = orbit_policy.apply_no_regression_floor(colmap_cfg)

        self.assertTrue(changed)
        self.assertEqual(updated['matcher_params']['SequentialMatching.overlap'], '44')
        self.assertEqual(updated['matcher_params']['SequentialMatching.quadratic_overlap'], '1')

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
        paths = {'images_path': '/tmp/images', 'project_path': Path('/tmp/project')}
        time_estimator = mock.Mock()
        time_estimator.classify_resource_profile.return_value = {'resource_profile': 'light'}
        time_estimator.choose_resource_lane.return_value = {'resource_lane': 'foreground'}

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
            runner.run_colmap_pipeline('project', paths, config, 0.0, {'estimate': 10}, time_estimator)

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

    def test_normalize_matcher_type_accepts_tree_alias(self):
        self.assertEqual(runtime_support.normalize_matcher_type('tree'), 'vocab_tree')
        self.assertEqual(
            runtime_support.normalize_matcher_type('vocabulary-tree'),
            'vocab_tree',
        )

    def test_get_colmap_config_honors_vocab_tree_override_in_orbit_safe_mode(self):
        orbit_safe_policy = {
            'profile_name': 'bridge-balanced',
            'mapper_params': {
                'Mapper.structure_less_registration_fallback': '1',
                'Mapper.abs_pose_max_error': '12',
                'Mapper.abs_pose_min_num_inliers': '14',
                'Mapper.abs_pose_min_inlier_ratio': '0.10',
                'Mapper.max_reg_trials': '12',
            },
            'min_num_matches_cap': 12,
            'init_num_trials_floor': 200,
            'capture_pattern': {'looks_like_video_orbit': True},
            'bridge_risk_score': 2,
        }

        colmap_cfg = config_builders.get_colmap_config(
            163,
            quality_mode='hard',
            preferred_matcher_type='vocab_tree',
            orbit_safe_mode=True,
            orbit_safe_policy=orbit_safe_policy,
        )

        self.assertEqual(colmap_cfg['matcher_type'], 'vocab_tree')
        self.assertEqual(colmap_cfg['orbit_safe_mode'], True)
        self.assertEqual(colmap_cfg['max_num_models'], 1)
        self.assertEqual(
            colmap_cfg['mapper_params']['Mapper.abs_pose_min_num_inliers'],
            '14',
        )

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

    def test_refine_orbit_safe_profile_preserves_current_mapper_floor(self):
        geometry_stats = {
            'image_count': 409,
            'bridge_min': 0,
            'bridge_p10': 18,
            'adjacent_p10': 20,
            'weak_boundary_ratio': 0.1,
            'weak_boundary_count': 3,
            'zero_boundary_count': 3,
            'weak_boundaries': [],
        }
        colmap_cfg = {
            'orbit_safe_mode': True,
            'orbit_safe_profile': 'bridge-recovery',
            'matcher_type': 'sequential',
            'matcher_params': {
                'SequentialMatching.overlap': '61',
                'SequentialMatching.quadratic_overlap': '1',
                'SequentialMatching.loop_detection': '0',
            },
            'mapper_params': {
                'Mapper.structure_less_registration_fallback': '1',
                'Mapper.abs_pose_max_error': '16',
                'Mapper.abs_pose_min_num_inliers': '10',
                'Mapper.abs_pose_min_inlier_ratio': '0.06',
                'Mapper.max_reg_trials': '24',
            },
            'min_num_matches': 8,
            'init_num_trials': 5000,
            'bridge_risk_score': 1,
            'capture_pattern': {},
            'no_regression_floor': None,
        }

        with mock.patch.object(
            recovery_planners,
            'analyze_pair_geometry_stats',
            return_value=geometry_stats,
        ), mock.patch.object(
            recovery_planners,
            'make_orbit_safe_policy',
            return_value={
                'profile_name': 'bridge-recovery',
                'matcher_params': {
                    'SequentialMatching.overlap': '52',
                    'SequentialMatching.quadratic_overlap': '1',
                    'SequentialMatching.loop_detection': '0',
                },
                'mapper_params': {
                    'Mapper.structure_less_registration_fallback': '1',
                    'Mapper.abs_pose_max_error': '14',
                    'Mapper.abs_pose_min_num_inliers': '12',
                    'Mapper.abs_pose_min_inlier_ratio': '0.08',
                    'Mapper.max_reg_trials': '16',
                },
                'min_num_matches_cap': 8,
                'init_num_trials_floor': 300,
            },
        ):
            refined = recovery_planners.refine_orbit_safe_profile_from_geometry(
                {'database_path': '/tmp/test.db'},
                colmap_cfg,
            )

        self.assertEqual(refined['mapper_params']['Mapper.max_reg_trials'], '24')
        self.assertEqual(refined['mapper_params']['Mapper.abs_pose_min_inlier_ratio'], '0.06')
        self.assertEqual(refined['init_num_trials'], 5000)

    def test_refine_orbit_safe_profile_skips_non_sequential_matcher_override(self):
        colmap_cfg = {
            'orbit_safe_mode': True,
            'matcher_type': 'vocab_tree',
            'matcher_params': {'VocabTreeMatching.num_images': '100'},
            'mapper_params': {'Mapper.max_reg_trials': '12'},
        }

        with mock.patch.object(
            recovery_planners,
            'analyze_pair_geometry_stats',
        ) as analyze_pair_geometry_stats:
            refined = recovery_planners.refine_orbit_safe_profile_from_geometry(
                {'database_path': '/tmp/test.db'},
                colmap_cfg,
            )

        self.assertIs(refined, colmap_cfg)
        self.assertEqual(refined['matcher_type'], 'vocab_tree')
        analyze_pair_geometry_stats.assert_not_called()

    def test_matcher_fallback_retry_chooses_matcher_by_dataset_size(self):
        sparse_summary = {'best_registered': 2}
        base_colmap_cfg = {
            'matcher_type': 'sequential',
            'recovery_history': [],
            'no_regression_floor': None,
            'pair_geometry_stats': {'weak_boundary_count': 3},
        }

        for num_images, expected_matcher in ((163, 'exhaustive'), (409, 'vocab_tree')):
            with self.subTest(num_images=num_images, expected_matcher=expected_matcher):
                rerun_feature_extraction_stage = mock.Mock(
                    side_effect=lambda project_id, paths, retry_config, rerun_colmap_cfg: rerun_colmap_cfg
                )
                rerun_feature_matching_stage = mock.Mock(
                    side_effect=lambda project_id, paths, retry_config, rerun_colmap_cfg: rerun_colmap_cfg
                )
                rerun_sparse_reconstruction_stage = mock.Mock(return_value={'matcher_type': expected_matcher})

                with mock.patch.object(
                    recovery_planners,
                    'clear_sparse_reconstruction_outputs',
                ), mock.patch.object(
                    recovery_planners,
                    'clear_colmap_database',
                ), mock.patch.object(
                    recovery_planners,
                    'get_colmap_config_for_pipeline',
                    return_value=(
                        num_images,
                        {
                            'matcher_type': expected_matcher,
                            'matcher_params': {},
                            'mapper_params': {},
                            'recovery_history': [],
                        },
                        '/usr/bin/colmap',
                        False,
                    ),
                ):
                    result = recovery_planners.run_matcher_fallback_retry(
                        'project',
                        {
                            'database_path': '/tmp/test.db',
                            'sparse_path': '/tmp/sparse',
                        },
                        {'input_type': 'video'},
                        dict(base_colmap_cfg),
                        sparse_summary,
                        num_images,
                        rerun_feature_extraction_stage=rerun_feature_extraction_stage,
                        rerun_feature_matching_stage=rerun_feature_matching_stage,
                        rerun_sparse_reconstruction_stage=rerun_sparse_reconstruction_stage,
                    )

                self.assertEqual(result, {'matcher_type': expected_matcher})
                self.assertEqual(
                    rerun_feature_extraction_stage.call_args.args[2]['matcher_type'],
                    expected_matcher,
                )
                self.assertEqual(
                    rerun_feature_matching_stage.call_args.args[2]['matcher_type'],
                    expected_matcher,
                )

    def test_matcher_fallback_retry_honors_manual_retry_choice(self):
        rerun_feature_extraction_stage = mock.Mock(
            side_effect=lambda project_id, paths, retry_config, rerun_colmap_cfg: rerun_colmap_cfg
        )
        rerun_feature_matching_stage = mock.Mock(
            side_effect=lambda project_id, paths, retry_config, rerun_colmap_cfg: rerun_colmap_cfg
        )
        rerun_sparse_reconstruction_stage = mock.Mock(return_value={'matcher_type': 'vocab_tree'})

        with mock.patch.object(
            recovery_planners,
            'clear_sparse_reconstruction_outputs',
        ), mock.patch.object(
            recovery_planners,
            'clear_colmap_database',
        ), mock.patch.object(
            recovery_planners,
            'get_colmap_config_for_pipeline',
            return_value=(
                163,
                {
                    'matcher_type': 'vocab_tree',
                    'matcher_params': {},
                    'mapper_params': {},
                    'recovery_history': [],
                },
                '/usr/bin/colmap',
                False,
            ),
        ):
            result = recovery_planners.run_matcher_fallback_retry(
                'project',
                {
                    'database_path': '/tmp/test.db',
                    'sparse_path': '/tmp/sparse',
                },
                {
                    'input_type': 'video',
                    'matcher_fallback_retry_type': 'vocab_tree',
                },
                {
                    'matcher_type': 'sequential',
                    'recovery_history': [],
                    'no_regression_floor': None,
                    'pair_geometry_stats': {'weak_boundary_count': 3},
                },
                {'best_registered': 2},
                163,
                rerun_feature_extraction_stage=rerun_feature_extraction_stage,
                rerun_feature_matching_stage=rerun_feature_matching_stage,
                rerun_sparse_reconstruction_stage=rerun_sparse_reconstruction_stage,
            )

        self.assertEqual(result, {'matcher_type': 'vocab_tree'})
        self.assertEqual(
            rerun_feature_extraction_stage.call_args.args[2]['matcher_type'],
            'vocab_tree',
        )

    def test_stage_sparse_runs_matcher_fallback_retry_after_standard_recovery(self):
        base_cfg = {
            'orbit_safe_mode': False,
            'matcher_type': 'sequential',
            'matcher_params': {'SequentialMatching.overlap': '20'},
            'mapper_params': {'Mapper.max_reg_trials': '8'},
            'min_num_matches': 6,
            'min_model_size': 8,
            'max_num_models': 1,
            'init_num_trials': 320,
            'max_extra_param': 1,
        }
        helpers = {
            'get_colmap_config_for_pipeline': mock.Mock(
                return_value=(163, dict(base_cfg), '/usr/bin/colmap', False)
            ),
            'refine_orbit_safe_profile_from_geometry': mock.Mock(return_value=dict(base_cfg)),
            'clear_sparse_reconstruction_outputs': mock.Mock(),
            'run_orbit_safe_bridge_recovery_matching_pass': mock.Mock(return_value=dict(base_cfg)),
            'should_prefer_incremental_sfm': mock.Mock(return_value=(False, None)),
            'report_sparse_model_coverage': mock.Mock(
                return_value={'best_registered': 2, 'registered_ratio': 0.012, 'has_multiple_models': False}
            ),
            'build_weak_window_subset_recovery_pass': mock.Mock(return_value=None),
            'should_run_boundary_frame_densification': mock.Mock(return_value=False),
            'run_boundary_frame_densification_recovery': mock.Mock(return_value=None),
            'build_densified_overlap_retry_pass': mock.Mock(return_value=None),
            'should_run_final_loop_detection_recovery': mock.Mock(return_value=False),
            'build_ordered_split_auto_retry': mock.Mock(return_value=None),
            'rerun_feature_extraction_stage': mock.Mock(),
            'rerun_feature_matching_stage': mock.Mock(),
            'rerun_sparse_reconstruction_stage': mock.Mock(),
            'run_matcher_fallback_retry': mock.Mock(side_effect=RuntimeError('matcher fallback invoked')),
        }

        with mock.patch.object(stage_sparse, 'append_log_line'), mock.patch.object(
            stage_sparse,
            'update_state',
        ), mock.patch.object(
            stage_sparse,
            'update_stage_detail',
        ), mock.patch.object(
            stage_sparse,
            'emit_stage_progress',
        ), mock.patch.object(
            stage_sparse,
            'run_command_with_logs',
        ), mock.patch.object(
            stage_sparse,
            'sync_reconstruction_framework',
        ):
            with self.assertRaisesRegex(RuntimeError, 'matcher fallback invoked'):
                stage_sparse.run_sparse_reconstruction_stage(
                    'project',
                    {
                        'database_path': '/tmp/test.db',
                        'images_path': '/tmp/images',
                        'sparse_path': '/tmp/sparse',
                    },
                    {'sfm_engine': 'colmap', 'force_cpu_sparse_reconstruction': True},
                    helpers=helpers,
                )

        helpers['run_matcher_fallback_retry'].assert_called_once()

    def test_stage_sparse_runs_queued_recovery_before_mapper(self):
        base_cfg = {
            'orbit_safe_mode': True,
            'matcher_type': 'sequential',
            'matcher_params': {},
            'mapper_params': {},
            'min_num_matches': 6,
            'init_num_trials': 320,
            'capture_pattern': {},
            'bridge_risk_score': 1,
        }
        queued_cfg = dict(
            base_cfg,
            recovery_matching_pass={
                'matcher_params': {'SequentialMatching.overlap': '61'},
                'reason': 'queued before mapper',
            },
        )
        helpers = {
            'get_colmap_config_for_pipeline': mock.Mock(
                return_value=(12, dict(base_cfg), '/usr/bin/colmap', False)
            ),
            'refine_orbit_safe_profile_from_geometry': mock.Mock(return_value=queued_cfg),
            'clear_sparse_reconstruction_outputs': mock.Mock(),
            'run_orbit_safe_bridge_recovery_matching_pass': mock.Mock(
                side_effect=RuntimeError('queued recovery invoked')
            ),
        }

        with mock.patch.object(stage_sparse, 'sync_reconstruction_framework'), mock.patch.object(
            stage_sparse,
            'append_log_line',
        ) as append_log_line:
            with self.assertRaisesRegex(RuntimeError, 'queued recovery invoked'):
                stage_sparse.run_sparse_reconstruction_stage(
                    'project',
                    {'sparse_path': '/tmp/sparse'},
                    {'sfm_engine': 'colmap', 'force_cpu_sparse_reconstruction': True},
                    helpers=helpers,
                )

        helpers['clear_sparse_reconstruction_outputs'].assert_called_once_with('/tmp/sparse')
        helpers['run_orbit_safe_bridge_recovery_matching_pass'].assert_called_once()
        append_log_line.assert_any_call(
            'project',
            '🧠 Running the queued recovery matching pass before mapper registration starts',
        )


if __name__ == '__main__':
    unittest.main()
