"""Feature extraction and matching stages for the pipeline."""

from __future__ import annotations

import re
import sqlite3
import subprocess
import traceback
from pathlib import Path

from ..core.commands import run_command_with_logs
from ..core.projects import (
    append_log_line,
    emit_stage_progress,
    update_stage_detail,
    update_state,
)
from .orbit_policy import apply_no_regression_floor, sync_reconstruction_framework
from .progressive_matching import (
    build_progressive_sequential_matching_plan,
    should_continue_progressive_matching,
    summarize_progressive_geometry,
)
from .recovery_planners import analyze_pair_geometry_stats
from .runtime_support import (
    count_verified_matching_pairs,
    estimate_gpu_safe_match_limit,
    get_colmap_feature_extraction_max_image_size_flag,
    get_cpu_retry_match_limit,
    get_gpu_retry_match_limits,
    get_gpu_total_vram_mb,
    get_peak_feature_count,
    is_gpu_matching_error_text,
    resolve_colmap_feature_pipeline_profile,
    should_emit_progress_milestone,
    should_log_subprocess_line,
)


def run_hloc_feature_extraction_stage(project_id, paths, config, colmap_config=None, *, helpers):
    """Run hloc neural feature extraction (ALIKED or SuperPoint)."""
    num_images, colmap_cfg, _colmap_exe, _has_cuda = helpers['get_colmap_config_for_pipeline'](
        paths, config, project_id
    )

    update_state(project_id, 'feature_extraction', status='running')
    update_stage_detail(project_id, 'feature_extraction', text='Initializing neural features...', subtext='hloc ALIKED')
    append_log_line(project_id, "⚡ Running hloc Neural Feature Extraction (ALIKED + LightGlue)")
    append_log_line(project_id, f"🎯 Processing {num_images} images with GPU-accelerated neural features")

    try:
        from hloc import extract_features
        from hloc.utils.io import list_h5_names
        import pycolmap  # noqa: F401
        import torch

        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        append_log_line(project_id, f"🎮 Using device: {device}")

        images_path = Path(paths['images_path'])
        output_path = Path(paths['project_path'])

        feature_method = config.get('feature_method', 'aliked')

        if feature_method == 'superpoint':
            feature_conf = extract_features.confs['superpoint_max']
            append_log_line(project_id, "📌 Using SuperPoint features (best accuracy)")
        else:
            feature_conf = extract_features.confs['aliked-n16']
            append_log_line(project_id, "📌 Using ALIKED features (fastest - 125+ FPS)")

        quality_mode = config.get('quality_mode', 'balanced')
        if quality_mode == 'fast':
            feature_conf = {**feature_conf, 'max_keypoints': 2048}
        elif quality_mode in {'hard', 'quality'}:
            feature_conf = {**feature_conf, 'max_keypoints': 8192}
        else:
            feature_conf = {**feature_conf, 'max_keypoints': 4096}

        append_log_line(project_id, f"🔧 Max keypoints: {feature_conf.get('max_keypoints', 4096)}")

        def progress_callback(current, total):
            percent = int((current / total) * 100) if total > 0 else 0
            details = {
                'text': f'Images processed: {current}/{total}',
                'current_item': current,
                'total_items': total,
                'item_name': f'Image {current}',
                'feature_method': feature_method,
            }
            emit_stage_progress(project_id, 'feature_extraction', percent, details)
            update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
            update_stage_detail(
                project_id,
                'feature_extraction',
                text=f'Images processed: {current}/{total}',
                subtext=f'hloc {feature_method.upper()}',
            )

        append_log_line(project_id, "🚀 Starting feature extraction...")
        features_path = extract_features.main(
            feature_conf,
            images_path,
            output_path,
            as_half=True,
        )
        progress_callback(num_images, num_images)

        append_log_line(project_id, f"✅ Features saved to {features_path}")
        feature_names = list_h5_names(features_path)
        append_log_line(project_id, f"📊 Extracted features from {len(feature_names)} images")

        update_state(project_id, 'feature_extraction', status='completed', progress=100)
        update_stage_detail(
            project_id,
            'feature_extraction',
            text=f'Images processed: {num_images}/{num_images}',
            subtext=f'hloc {feature_method.upper()} complete',
        )
        append_log_line(project_id, f"✅ hloc Feature Extraction completed ({feature_method.upper()})")
        return {'features_path': str(features_path), 'feature_conf': feature_conf, 'colmap_config': colmap_cfg}

    except Exception as exc:
        append_log_line(project_id, f"❌ hloc feature extraction failed: {exc}")
        append_log_line(project_id, "⚠️ Falling back to COLMAP SIFT...")
        return run_feature_extraction_stage(
            project_id,
            paths,
            config,
            colmap_config,
            helpers=helpers,
        )


def run_hloc_feature_matching_stage(project_id, paths, config, hloc_data=None, *, helpers):
    """Run hloc LightGlue matching."""
    num_images, colmap_cfg, _colmap_exe, _has_cuda = helpers['get_colmap_config_for_pipeline'](
        paths, config, project_id
    )

    update_state(project_id, 'feature_matching', status='running')
    update_stage_detail(project_id, 'feature_matching', text='Initializing LightGlue...', subtext='Neural matching')
    append_log_line(project_id, "⚡ Running hloc LightGlue Matching (4-10x faster)")

    try:
        from hloc import match_features
        import pycolmap
        import torch

        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        append_log_line(project_id, f"🎮 Using device: {device}")

        images_path = Path(paths['images_path'])
        output_path = Path(paths['project_path'])
        database_path = Path(paths['database_path'])

        if hloc_data and 'features_path' in hloc_data:
            features_path = Path(hloc_data['features_path'])
            feature_conf = hloc_data.get('feature_conf', {})
            if hloc_data.get('colmap_config'):
                colmap_cfg = hloc_data['colmap_config']
        else:
            features_path = output_path / 'features.h5'
            feature_conf = {}

        colmap_cfg, _ = apply_no_regression_floor(
            colmap_cfg,
            project_id=project_id,
            reason='before hloc feature matching',
        )

        if not features_path.exists():
            raise FileNotFoundError(f"Features file not found: {features_path}")

        pairs_path = output_path / 'pairs.txt'
        image_list = sorted(
            [
                f.name
                for f in images_path.iterdir()
                if f.suffix.lower() in {'.jpg', '.jpeg', '.png', '.bmp', '.tiff'}
            ]
        )

        append_log_line(project_id, f"📊 Found {len(image_list)} images to match")
        append_log_line(project_id, f"🔗 Using {colmap_cfg['matcher_type']} matcher for neural pair generation")
        append_log_line(project_id, "📝 Generating image pairs...")
        total_pairs = helpers['generate_hloc_pairs'](
            pairs_path,
            image_list,
            colmap_cfg['matcher_type'],
            colmap_cfg['matcher_params'],
        )
        append_log_line(project_id, f"🔗 Total pairs to match: {total_pairs}")

        feature_method = config.get('feature_method', 'aliked')
        matcher_conf = (
            match_features.confs['superpoint+lightglue']
            if feature_method == 'superpoint'
            else match_features.confs['aliked+lightglue']
        )
        append_log_line(project_id, f"⚡ Using LightGlue matcher for {feature_method.upper()} features")

        update_stage_detail(
            project_id,
            'feature_matching',
            text='Matching pairs...',
            subtext='LightGlue neural matching',
        )
        matches_path = match_features.main(
            matcher_conf,
            pairs_path,
            feature_conf.get('output', 'feats-aliked-n16'),
            output_path,
        )

        append_log_line(project_id, f"✅ Matches saved to {matches_path}")
        append_log_line(project_id, "📥 Importing features and matches to COLMAP database...")

        from hloc.triangulation import import_features, import_matches

        if not database_path.exists():
            db = pycolmap.Database(str(database_path))
            db.create_tables()

        import_features(images_path, database_path, features_path)
        append_log_line(project_id, "✅ Features imported to database")
        import_matches(images_path, database_path, pairs_path, matches_path)
        append_log_line(project_id, "✅ Matches imported to database")

        colmap_cfg = helpers['refine_orbit_safe_profile_from_geometry'](paths, colmap_cfg, project_id)
        sync_reconstruction_framework(project_id, config, colmap_cfg, phase='matching_complete')

        update_state(project_id, 'feature_matching', status='completed', progress=100)
        update_stage_detail(project_id, 'feature_matching', text=f'Matched {total_pairs} pairs', subtext='LightGlue complete')
        append_log_line(project_id, "✅ hloc LightGlue Matching completed")
        return colmap_cfg

    except Exception as exc:
        append_log_line(project_id, f"❌ hloc matching failed: {exc}")
        append_log_line(project_id, traceback.format_exc())
        append_log_line(project_id, "⚠️ Falling back to COLMAP matching...")
        return run_feature_matching_stage(
            project_id,
            paths,
            config,
            hloc_data.get('colmap_config') if hloc_data else None,
            helpers=helpers,
        )


def run_feature_extraction_stage(project_id, paths, config, colmap_config=None, *, helpers):
    """Run COLMAP feature extraction."""
    num_images, colmap_cfg, colmap_exe, has_cuda = helpers['get_colmap_config_for_pipeline'](
        paths, config, project_id
    )
    if colmap_config:
        colmap_cfg = colmap_config
    max_image_size_flag = get_colmap_feature_extraction_max_image_size_flag(colmap_exe)
    feature_profile = resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe)

    update_state(project_id, 'feature_extraction', status='running')
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: 0/{num_images}', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Extraction...")
    append_log_line(project_id, f"📊 Using optimized settings for {num_images} images")

    append_log_line(
        project_id,
        "🚀 Using GPU-accelerated COLMAP for feature extraction"
        if has_cuda
        else "⚠️ COLMAP CUDA support not detected; falling back to CPU mode",
    )
    append_log_line(
        project_id,
        "ℹ️ Detected legacy COLMAP feature_extractor option layout"
        if max_image_size_flag == '--SiftExtraction.max_image_size'
        else "ℹ️ Detected modern COLMAP feature_extractor option layout",
    )
    if feature_profile['is_native_neural']:
        append_log_line(project_id, f"⚡ Using {feature_profile['description']} for feature extraction")

    cmd = [
        colmap_exe, 'feature_extractor',
        '--database_path', str(paths['database_path']),
        '--image_path', str(paths['images_path']),
        '--ImageReader.camera_model', config['camera_model'],
        '--ImageReader.single_camera', '1',
        '--FeatureExtraction.use_gpu', '1' if has_cuda else '0',
        max_image_size_flag, str(colmap_cfg['max_image_size']),
    ]
    if feature_profile['extractor_args']:
        cmd.extend(feature_profile['extractor_args'])
    if feature_profile['extractor_type'] == 'SIFT':
        cmd.extend([
            '--SiftExtraction.max_num_features', str(colmap_cfg['max_num_features']),
            '--SiftExtraction.first_octave', str(colmap_cfg['first_octave']),
            '--SiftExtraction.num_octaves', str(colmap_cfg['num_octaves']),
        ])
        for param, value in colmap_cfg.get('sift_params', {}).items():
            if value is not None:
                cmd.extend([f'--SiftExtraction.{param}', str(value)])

    progress_tracker = {'count': 0}
    extraction_progress_log = {'last_milestone': -1}
    extraction_health = {'gpu_instability': False, 'failed_images': 0}
    extraction_metrics = {'feature_sum': 0, 'feature_min': None, 'feature_max': 0, 'feature_samples': 0}

    def count_featured_images(database_path):
        if not Path(database_path).exists():
            return 0
        try:
            with sqlite3.connect(str(database_path)) as conn:
                row = conn.execute('SELECT COUNT(*) FROM images').fetchone()
                return int(row[0]) if row else 0
        except sqlite3.Error as exc:
            append_log_line(project_id, f"⚠️ Could not inspect COLMAP database after feature extraction: {exc}")
            return 0

    def reset_colmap_database(database_path):
        db_path = Path(database_path)
        for candidate in (db_path, Path(f"{db_path}-shm"), Path(f"{db_path}-wal")):
            try:
                if candidate.exists():
                    candidate.unlink()
            except OSError as exc:
                append_log_line(project_id, f"⚠️ Failed to remove stale database file {candidate.name}: {exc}")

    def build_feature_extractor_cmd(use_gpu):
        rebuilt = []
        skip_next = False
        for index, part in enumerate(cmd):
            if skip_next:
                skip_next = False
                continue
            if part == '--FeatureExtraction.use_gpu' and index + 1 < len(cmd):
                rebuilt.extend([part, '1' if use_gpu else '0'])
                skip_next = True
                continue
            rebuilt.append(part)
        return rebuilt

    def feature_line_handler(line):
        if num_images == 0:
            return
        line_lower = line.lower()
        if 'illegal memory access' in line_lower or 'failed to process the image' in line_lower:
            extraction_health['gpu_instability'] = True
        if 'failed to process the image' in line_lower:
            extraction_health['failed_images'] += 1

        feature_count_match = re.search(r'Features:\s+(\d+)', line, re.IGNORECASE)
        if feature_count_match:
            feature_count = int(feature_count_match.group(1))
            extraction_metrics['feature_sum'] += feature_count
            extraction_metrics['feature_samples'] += 1
            extraction_metrics['feature_max'] = max(extraction_metrics['feature_max'], feature_count)
            current_min = extraction_metrics['feature_min']
            extraction_metrics['feature_min'] = feature_count if current_min is None else min(current_min, feature_count)

        patterns = [
            r'Processing image \[(\d+)/(\d+)\]',
            r'Processed file \[(\d+)/(\d+)\]',
            r'Processing image (\d+)/(\d+)',
            r'Processed image (\d+)/(\d+)',
            r'Processing\s+(\d+)\s*\/\s*(\d+)',
            r'Extracting.*\s(\d+)\s*/\s*(\d+)',
            r'Image\s+(\d+)\s*\/\s*(\d+)',
            r'(\d+)\s*/\s*(\d+)\s*images?',
            r'Features\s+(\d+)\s*\/\s*(\d+)',
        ]
        for pattern in patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                current = int(match.group(1))
                total = int(match.group(2))
                if total != num_images:
                    total = num_images
                if current > total:
                    current = total
                percent = int((current / total) * 100)
                details = {
                    'text': f'Images processed: {current}/{total}',
                    'current_item': current,
                    'total_items': total,
                    'item_name': f'Image {current}',
                }
                emit_stage_progress(project_id, 'feature_extraction', percent, details)
                update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
                update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {current}/{total}', subtext=None)
                should_log, progress_percent = should_emit_progress_milestone(extraction_progress_log, current, total)
                if should_log:
                    avg_features = extraction_metrics['feature_sum'] // extraction_metrics['feature_samples'] if extraction_metrics['feature_samples'] else 0
                    append_log_line(project_id, f"🧩 Feature extraction progress: {current}/{total} images ({progress_percent}%) | avg_features={avg_features:,}")
                return

        if any(keyword in line_lower for keyword in ['processed', 'processing']):
            progress_tracker['count'] += 1
            processed = min(progress_tracker['count'], num_images)
            percent = int((processed / num_images) * 100)
            details = {
                'text': f'Images processed: {processed}/{num_images}',
                'current_item': processed,
                'total_items': num_images,
                'item_name': f'Image {processed}',
            }
            emit_stage_progress(project_id, 'feature_extraction', percent, details)
            update_state(project_id, 'feature_extraction', progress=min(percent, 99), details=details)
            update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {processed}/{num_images}', subtext=None)
            should_log, progress_percent = should_emit_progress_milestone(extraction_progress_log, processed, num_images)
            if should_log:
                avg_features = extraction_metrics['feature_sum'] // extraction_metrics['feature_samples'] if extraction_metrics['feature_samples'] else 0
                append_log_line(project_id, f"🧩 Feature extraction progress: {processed}/{num_images} images ({progress_percent}%) | avg_features={avg_features:,}")

    try:
        run_command_with_logs(project_id, cmd, line_handler=feature_line_handler, raw_line_filter=should_log_subprocess_line)
    except subprocess.CalledProcessError:
        if has_cuda:
            append_log_line(project_id, "⚠️ GPU feature extraction exited with an error; resetting COLMAP database and retrying on CPU")
            reset_colmap_database(paths['database_path'])
            run_command_with_logs(
                project_id,
                build_feature_extractor_cmd(False),
                line_handler=feature_line_handler,
                raw_line_filter=should_log_subprocess_line,
            )
        else:
            raise

    extracted_image_count = count_featured_images(paths['database_path'])
    if has_cuda and (extraction_health['gpu_instability'] or extraction_health['failed_images'] > 0 or extracted_image_count < num_images):
        append_log_line(
            project_id,
            "⚠️ GPU feature extraction produced incomplete results "
            f"({extracted_image_count}/{num_images} images in database, failures={extraction_health['failed_images']}); retrying on CPU",
        )
        reset_colmap_database(paths['database_path'])
        extraction_health['gpu_instability'] = False
        extraction_health['failed_images'] = 0
        progress_tracker['count'] = 0
        run_command_with_logs(
            project_id,
            build_feature_extractor_cmd(False),
            line_handler=feature_line_handler,
            raw_line_filter=should_log_subprocess_line,
        )
        extracted_image_count = count_featured_images(paths['database_path'])
        append_log_line(project_id, f"✅ CPU feature extraction retry completed with {extracted_image_count}/{num_images} images in database")

    update_state(project_id, 'feature_extraction', status='completed', progress=100)
    update_stage_detail(project_id, 'feature_extraction', text=f'Images processed: {num_images}/{num_images}', subtext='Feature extraction complete')
    if extraction_metrics['feature_samples']:
        avg_features = extraction_metrics['feature_sum'] // extraction_metrics['feature_samples']
        append_log_line(project_id, f"📈 Feature extraction summary: images={extraction_metrics['feature_samples']}/{num_images} | avg={avg_features:,} | min={int(extraction_metrics['feature_min'] or 0):,} | max={extraction_metrics['feature_max']:,}")
    append_log_line(project_id, "✅ COLMAP Feature Extraction completed")
    return colmap_cfg


def run_feature_matching_stage(project_id, paths, config, colmap_config=None, *, helpers):
    """Run COLMAP feature matching."""
    num_images, colmap_cfg, colmap_exe, has_cuda = helpers['get_colmap_config_for_pipeline'](
        paths, config, project_id
    )
    if colmap_config:
        colmap_cfg = colmap_config
    colmap_cfg, _ = apply_no_regression_floor(colmap_cfg, project_id=project_id, reason='before COLMAP feature matching')
    feature_profile = resolve_colmap_feature_pipeline_profile(config, colmap_cfg, colmap_exe)

    loop_detection_enabled = colmap_cfg['matcher_params'].get('SequentialMatching.loop_detection') == '1'
    use_gpu_matching = has_cuda
    peak_feature_count = get_peak_feature_count(paths['database_path'])
    gpu_total_vram_mb = get_gpu_total_vram_mb() if use_gpu_matching else None
    if use_gpu_matching:
        gpu_safe_match_limit = estimate_gpu_safe_match_limit(total_vram_mb=gpu_total_vram_mb, peak_feature_count=peak_feature_count)
        if gpu_safe_match_limit and gpu_safe_match_limit < int(colmap_cfg['max_num_matches']):
            append_log_line(project_id, f"🧠 VRAM-aware COLMAP tuning: capping max_num_matches from {colmap_cfg['max_num_matches']} to {gpu_safe_match_limit} (VRAM={gpu_total_vram_mb or 'unknown'} MiB, peak_features={peak_feature_count or 'unknown'})")
            colmap_cfg['max_num_matches'] = gpu_safe_match_limit
    progressive_plan = None
    if config.get('adaptive_pair_scheduling', True):
        progressive_plan = build_progressive_sequential_matching_plan(
            num_images,
            colmap_cfg,
            capture_pattern=colmap_cfg.get('capture_pattern'),
            gpu_total_vram_mb=gpu_total_vram_mb,
            peak_feature_count=peak_feature_count,
        )
    if progressive_plan:
        colmap_cfg['progressive_matching_plan'] = progressive_plan

    update_state(project_id, 'feature_matching', status='running')
    update_stage_detail(project_id, 'feature_matching', text='Matching pairs: 0/0', subtext=None)
    append_log_line(project_id, "🔄 Running COLMAP Feature Matching...")
    if use_gpu_matching:
        append_log_line(
            project_id,
            "🧠 Loop-closure matching enabled; attempting GPU matcher first with automatic CPU fallback"
            if loop_detection_enabled
            else "🚀 Using GPU-accelerated COLMAP for feature matching",
        )
    else:
        append_log_line(project_id, "⚠️ COLMAP CUDA support not detected; falling back to CPU mode for matching")
    append_log_line(project_id, f"🔗 Using {colmap_cfg['matcher_type']} matcher")
    if feature_profile['is_native_neural']:
        append_log_line(project_id, f"⚡ Native matcher profile: {feature_profile['description']}")
    if progressive_plan:
        append_log_line(
            project_id,
            "🧠 Progressive sequential matching enabled: "
            f"{len(progressive_plan['passes'])} staged pass(es) | "
            f"resource_tier={progressive_plan['resource_tier']} | "
            f"final_overlap={progressive_plan['final_overlap']}",
        )
        append_log_line(project_id, f"🧠 Progressive matching reason: {progressive_plan['reason']}")

    matching_progress = {'current': 0, 'total': 0}
    matching_progress_log = {'last_milestone': -1}
    matching_health = {'gpu_issue_detected': False, 'last_gpu_issue': None}
    matching_runtime = {
        'last_use_gpu': use_gpu_matching,
        'cpu_fallback_used': False,
        'current_pass_label': None,
        'current_pass_index': None,
        'current_pass_count': None,
    }
    matching_checkpoints = []

    matcher_cmd = f'{colmap_cfg["matcher_type"]}_matcher'
    append_log_line(project_id, f"🔧 Running {colmap_cfg['matcher_type']} matcher...")
    cmd = [
        colmap_exe, matcher_cmd,
        '--database_path', str(paths['database_path']),
        '--FeatureMatching.max_num_matches', str(colmap_cfg['max_num_matches']),
        '--FeatureMatching.use_gpu', '1' if use_gpu_matching else '0',
    ]
    if feature_profile['matcher_args']:
        cmd.extend(feature_profile['matcher_args'])
    for param, value in colmap_cfg['matcher_params'].items():
        cmd.extend([f'--{param}', value])

    def matching_line_handler(line):
        if matching_runtime['last_use_gpu'] and is_gpu_matching_error_text(line):
            matching_health['gpu_issue_detected'] = True
            matching_health['last_gpu_issue'] = line.strip()
            append_log_line(project_id, f"⚠️ GPU feature matching issue detected: {line.strip()}")
            return
        patterns = [
            r'Matching block \[(\d+)/(\d+)\]',
            r'Matching image \[(\d+)/(\d+)\]',
            r'Matching pair \[(\d+)/(\d+)\]',
            r'Processing pair (\d+)/(\d+)',
            r'Matching\s+(\d+)\s*\/\s*(\d+)',
            r'(\d+)/(\d+)\s+matches',
            r'Pair\s+(\d+)\s*\/\s*(\d+)',
            r'\[(\d+)/(\d+)\]',
        ]
        for pattern in patterns:
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                current = int(match.group(1))
                total = int(match.group(2))
                matching_progress['current'] = current
                matching_progress['total'] = total
                if total > 0:
                    percent = int((min(current, total) / total) * 100)
                    details = {
                        'text': f'Matching pairs: {current}/{total}',
                        'current_item': current,
                        'total_items': total,
                        'item_name': f'Pair {current}',
                    }
                    emit_stage_progress(project_id, 'feature_matching', percent, details)
                    update_state(project_id, 'feature_matching', progress=min(percent, 99), details=details)
                    if matching_runtime['current_pass_label']:
                        update_stage_detail(
                            project_id,
                            'feature_matching',
                            text=f'Matching pairs: {current}/{total}',
                            subtext=(
                                f"{matching_runtime['current_pass_label']} "
                                f"({matching_runtime['current_pass_index']}/{matching_runtime['current_pass_count']})"
                            ),
                        )
                    else:
                        update_stage_detail(project_id, 'feature_matching', text=f'Matching pairs: {current}/{total}', subtext=None)
                    should_log, progress_percent = should_emit_progress_milestone(matching_progress_log, current, total)
                    if should_log:
                        runtime_mode = 'GPU' if matching_runtime['last_use_gpu'] else 'CPU'
                        pass_label = matching_runtime['current_pass_label']
                        if pass_label:
                            append_log_line(
                                project_id,
                                f"🔗 Feature matching progress: {current}/{total} units ({progress_percent}%) | mode={runtime_mode} | pass={pass_label}",
                            )
                        else:
                            append_log_line(project_id, f"🔗 Feature matching progress: {current}/{total} units ({progress_percent}%) | mode={runtime_mode}")
                return

    def run_matching_command(command):
        run_command_with_logs(project_id, command, line_handler=matching_line_handler, raw_line_filter=should_log_subprocess_line)

    def reset_matching_health():
        matching_health['gpu_issue_detected'] = False
        matching_health['last_gpu_issue'] = None

    def build_matching_cmd(max_num_matches, use_gpu, matcher_params):
        rebuilt = [
            colmap_exe, matcher_cmd,
            '--database_path', str(paths['database_path']),
            '--FeatureMatching.max_num_matches', str(max_num_matches),
            '--FeatureMatching.use_gpu', '1' if use_gpu else '0',
        ]
        if feature_profile['matcher_args']:
            rebuilt.extend(feature_profile['matcher_args'])
        for param, value in matcher_params.items():
            rebuilt.extend([f'--{param}', value])
        return rebuilt

    def retry_matching_on_gpu_with_backoff(reason, matcher_params, initial_limit, *, loop_enabled):
        if not use_gpu_matching:
            return None
        retry_limits = get_gpu_retry_match_limits(initial_limit, peak_feature_count=peak_feature_count)
        if not retry_limits:
            return None
        append_log_line(project_id, f"⚠️ {reason}")
        for retry_matches in retry_limits:
            append_log_line(project_id, f"🔄 Retrying with GPU-based matching at reduced max_matches={retry_matches}...")
            gpu_cmd = build_matching_cmd(retry_matches, True, matcher_params)
            matching_runtime['last_use_gpu'] = True
            reset_matching_health()
            try:
                run_matching_command(gpu_cmd)
            except subprocess.CalledProcessError as retry_error:
                if matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(retry_error)):
                    append_log_line(project_id, f"⚠️ Reduced GPU matching attempt failed at max_matches={retry_matches}")
                    continue
                raise
            verified_pairs = count_verified_matching_pairs(paths['database_path'])
            if verified_pairs > 0:
                if loop_enabled:
                    append_log_line(project_id, f"✅ Reduced GPU loop-closure matching completed successfully ({verified_pairs} verified pairs)")
                else:
                    append_log_line(project_id, f"✅ Reduced GPU-based matching completed successfully ({verified_pairs} verified pairs)")
                return retry_matches
            if matching_health['gpu_issue_detected']:
                append_log_line(project_id, f"⚠️ Reduced GPU matching produced 0 verified pairs at max_matches={retry_matches}")
                continue
            append_log_line(project_id, "✅ Reduced GPU-based matching completed successfully")
            return retry_matches
        return None

    def retry_matching_on_cpu(reason, matcher_params, max_num_matches):
        retry_matches = get_cpu_retry_match_limit(max_num_matches)
        append_log_line(project_id, f"⚠️ {reason}")
        append_log_line(project_id, f"🔄 Retrying with CPU-based matching (max_matches={retry_matches})...")
        cpu_cmd = build_matching_cmd(retry_matches, False, matcher_params)
        matching_runtime['last_use_gpu'] = False
        matching_runtime['cpu_fallback_used'] = True
        run_matching_command(cpu_cmd)
        append_log_line(project_id, "✅ CPU-based matching completed successfully")
        return retry_matches

    def record_matching_checkpoint(pass_spec, verified_pairs, geometry_stats):
        checkpoint = {
            'key': pass_spec['key'],
            'label': pass_spec['label'],
            'max_num_matches': pass_spec['max_num_matches'],
            'verified_pairs': verified_pairs,
            'geometry_stats': geometry_stats,
        }
        matching_checkpoints.append(checkpoint)
        colmap_cfg['progressive_matching_checkpoints'] = matching_checkpoints
        append_log_line(
            project_id,
            "🧠 Matching checkpoint: "
            f"{pass_spec['label']} | verified_pairs={verified_pairs} | "
            f"{summarize_progressive_geometry(geometry_stats)}",
        )

    def run_matching_pass(pass_spec, *, required):
        matching_runtime['cpu_fallback_used'] = False
        matching_runtime['current_pass_label'] = pass_spec['label']
        matching_runtime['current_pass_index'] = pass_spec.get('pass_index')
        matching_runtime['current_pass_count'] = pass_spec.get('pass_count')

        pass_matcher_params = dict(pass_spec['matcher_params'])
        pass_max_num_matches = int(pass_spec['max_num_matches'])
        pass_loop_detection_enabled = pass_matcher_params.get('SequentialMatching.loop_detection') == '1'

        append_log_line(
            project_id,
            "🧠 Progressive matching pass "
            f"{pass_spec['pass_index']}/{pass_spec['pass_count']}: {pass_spec['label']} | "
            f"overlap={pass_matcher_params.get('SequentialMatching.overlap')} | "
            f"quadratic={pass_matcher_params.get('SequentialMatching.quadratic_overlap', '0')} | "
            f"loop={pass_matcher_params.get('SequentialMatching.loop_detection', '0')} | "
            f"max_matches={pass_max_num_matches}",
        )
        append_log_line(project_id, f"🧠 Pass intent: {pass_spec['checkpoint_note']}")
        update_stage_detail(
            project_id,
            'feature_matching',
            text='Matching pairs: 0/0',
            subtext=f"{pass_spec['label']} ({pass_spec['pass_index']}/{pass_spec['pass_count']})",
        )

        pass_cmd = build_matching_cmd(pass_max_num_matches, use_gpu_matching, pass_matcher_params)
        matching_runtime['last_use_gpu'] = use_gpu_matching
        try:
            run_matching_command(pass_cmd)
        except subprocess.CalledProcessError as exc:
            if use_gpu_matching and (matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(exc))):
                if pass_loop_detection_enabled:
                    pass_max_num_matches = retry_matching_on_cpu(
                        "GPU loop-closure matching failed",
                        pass_matcher_params,
                        pass_max_num_matches,
                    )
                else:
                    reduced_matches = retry_matching_on_gpu_with_backoff(
                        "GPU feature matching failed",
                        pass_matcher_params,
                        pass_max_num_matches,
                        loop_enabled=pass_loop_detection_enabled,
                    )
                    if reduced_matches is None:
                        pass_max_num_matches = retry_matching_on_cpu(
                            "GPU feature matching failed after reduced-match retries",
                            pass_matcher_params,
                            pass_max_num_matches,
                        )
                    else:
                        pass_max_num_matches = reduced_matches
            else:
                if required:
                    raise
                append_log_line(
                    project_id,
                    "⚠️ Optional progressive matching pass failed; keeping matches from the last successful checkpoint "
                    f"({pass_spec['label']})",
                )
                return False

        verified_pairs = count_verified_matching_pairs(paths['database_path'])
        if use_gpu_matching and verified_pairs == 0 and matching_health['gpu_issue_detected']:
            if pass_loop_detection_enabled:
                pass_max_num_matches = retry_matching_on_cpu(
                    "GPU loop-closure matching produced 0 verified pairs after a matcher initialization failure",
                    pass_matcher_params,
                    pass_max_num_matches,
                )
            else:
                reduced_matches = retry_matching_on_gpu_with_backoff(
                    "GPU feature matching produced 0 verified pairs after a matcher initialization failure",
                    pass_matcher_params,
                    pass_max_num_matches,
                    loop_enabled=pass_loop_detection_enabled,
                )
                if reduced_matches is None:
                    pass_max_num_matches = retry_matching_on_cpu(
                        "GPU feature matching produced 0 verified pairs after reduced-match retries",
                        pass_matcher_params,
                        pass_max_num_matches,
                    )
                else:
                    pass_max_num_matches = reduced_matches
            verified_pairs = count_verified_matching_pairs(paths['database_path'])

        if verified_pairs == 0:
            if required:
                append_log_line(project_id, "❌ COLMAP Feature Matching produced 0 verified pairs")
                raise RuntimeError("COLMAP feature matching produced 0 verified pairs")
            append_log_line(
                project_id,
                f"⚠️ Optional progressive matching pass produced 0 verified pairs; using the previous checkpoint instead ({pass_spec['label']})",
            )
            return False

        geometry_stats = analyze_pair_geometry_stats(paths['database_path'])
        pass_spec['max_num_matches'] = pass_max_num_matches
        colmap_cfg['matcher_params'] = pass_matcher_params
        colmap_cfg['max_num_matches'] = pass_max_num_matches
        record_matching_checkpoint(pass_spec, verified_pairs, geometry_stats)
        return {
            'verified_pairs': verified_pairs,
            'geometry_stats': geometry_stats,
            'pass_spec': pass_spec,
        }

    verified_pairs = 0
    if progressive_plan and matcher_cmd == 'sequential_matcher':
        total_passes = len(progressive_plan['passes'])
        for index, original_pass_spec in enumerate(progressive_plan['passes'], start=1):
            pass_spec = dict(original_pass_spec)
            pass_spec['pass_index'] = index
            pass_spec['pass_count'] = total_passes
            pass_result = run_matching_pass(pass_spec, required=bool(pass_spec['required']))
            if not pass_result:
                break
            verified_pairs = int(pass_result['verified_pairs'])
            if index >= total_passes:
                break
            next_pass = progressive_plan['passes'][index]
            should_continue, continue_reason = should_continue_progressive_matching(
                next_pass,
                pass_result['geometry_stats'],
                verified_pairs=verified_pairs,
            )
            if should_continue:
                append_log_line(
                    project_id,
                    "🧠 Progressive matcher continuing to the next pass: "
                    f"{next_pass['label']} | reason={continue_reason}",
                )
                continue
            append_log_line(
                project_id,
                "🧠 Progressive matcher stopping early after "
                f"{pass_spec['label']} | reason={continue_reason}",
            )
            break
    else:
        matching_runtime['last_use_gpu'] = use_gpu_matching
        try:
            run_matching_command(cmd)
        except subprocess.CalledProcessError as exc:
            if use_gpu_matching and (matching_health['gpu_issue_detected'] or is_gpu_matching_error_text(str(exc))):
                if loop_detection_enabled:
                    colmap_cfg['max_num_matches'] = retry_matching_on_cpu(
                        "GPU loop-closure matching failed",
                        colmap_cfg['matcher_params'],
                        int(colmap_cfg['max_num_matches']),
                    )
                else:
                    reduced_matches = retry_matching_on_gpu_with_backoff(
                        "GPU feature matching failed",
                        colmap_cfg['matcher_params'],
                        int(colmap_cfg['max_num_matches']),
                        loop_enabled=loop_detection_enabled,
                    )
                    if reduced_matches is None:
                        colmap_cfg['max_num_matches'] = retry_matching_on_cpu(
                            "GPU feature matching failed after reduced-match retries",
                            colmap_cfg['matcher_params'],
                            int(colmap_cfg['max_num_matches']),
                        )
                    else:
                        colmap_cfg['max_num_matches'] = reduced_matches
            else:
                raise

        verified_pairs = count_verified_matching_pairs(paths['database_path'])
        if use_gpu_matching and verified_pairs == 0 and matching_health['gpu_issue_detected']:
            if loop_detection_enabled:
                colmap_cfg['max_num_matches'] = retry_matching_on_cpu(
                    "GPU loop-closure matching produced 0 verified pairs after a matcher initialization failure",
                    colmap_cfg['matcher_params'],
                    int(colmap_cfg['max_num_matches']),
                )
            else:
                reduced_matches = retry_matching_on_gpu_with_backoff(
                    "GPU feature matching produced 0 verified pairs after a matcher initialization failure",
                    colmap_cfg['matcher_params'],
                    int(colmap_cfg['max_num_matches']),
                    loop_enabled=loop_detection_enabled,
                )
                if reduced_matches is None:
                    colmap_cfg['max_num_matches'] = retry_matching_on_cpu(
                        "GPU feature matching produced 0 verified pairs after reduced-match retries",
                        colmap_cfg['matcher_params'],
                        int(colmap_cfg['max_num_matches']),
                    )
                else:
                    colmap_cfg['max_num_matches'] = reduced_matches
            verified_pairs = count_verified_matching_pairs(paths['database_path'])

        if verified_pairs == 0:
            append_log_line(project_id, "❌ COLMAP Feature Matching produced 0 verified pairs")
            raise RuntimeError("COLMAP feature matching produced 0 verified pairs")

    final_loop_detection_enabled = colmap_cfg['matcher_params'].get('SequentialMatching.loop_detection') == '1'
    if final_loop_detection_enabled and use_gpu_matching:
        append_log_line(
            project_id,
            "🧠 Loop-closure matching final mode: CPU fallback"
            if matching_runtime['cpu_fallback_used']
            else "🧠 Loop-closure matching final mode: GPU",
        )

    update_state(project_id, 'feature_matching', status='completed', progress=100)
    current = matching_progress['current'] or matching_progress['total']
    total_pairs = matching_progress['total'] or matching_progress['current']
    colmap_cfg = helpers['refine_orbit_safe_profile_from_geometry'](paths, colmap_cfg, project_id)
    colmap_cfg = helpers['run_orbit_safe_bridge_recovery_matching_pass'](
        project_id, paths, config, colmap_exe, colmap_cfg, has_cuda, line_handler=matching_line_handler
    )
    sync_reconstruction_framework(project_id, config, colmap_cfg, phase='matching_complete')
    if total_pairs:
        update_stage_detail(project_id, 'feature_matching', text=f'Matching pairs: {min(current, total_pairs)}/{total_pairs}', subtext=f'Feature matching complete ({verified_pairs} verified pairs)')
    else:
        update_stage_detail(project_id, 'feature_matching', text='Feature matching complete', subtext=f'{verified_pairs} verified pairs')
    append_log_line(project_id, f"✅ COLMAP Feature Matching completed ({verified_pairs} verified pairs)")
    return colmap_cfg
