"""REST API endpoints for PobimSplats backend."""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
import uuid
from datetime import datetime

from flask import Blueprint, jsonify, request, send_file

from ..core import config as app_config
from ..core import projects as project_store
from ..core.files import (
    allowed_file,
    get_file_type,
    secure_unicode_filename,
    setup_project_directories,
)
from ..core.projects import (
    append_log_line,
    initialize_project_entry,
    save_projects_db,
    update_stage_detail,
    update_state,
)
from ..pipeline.runner import (
    finalize_project,
    get_colmap_executable,
    run_processing_pipeline,
    run_processing_pipeline_from_stage,
    select_best_sparse_model,
)
from ..utils.video_processor import VideoProcessor
from ..services.mesh_converter import MeshConverter
from ..services.mvs_mesher import MVSMesher

api_bp = Blueprint("api", __name__, url_prefix="/api")

logger = logging.getLogger(__name__)

video_processor = VideoProcessor()


@api_bp.route('/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'services': {
            'backend': 'running',
            'opensplat': 'available' if app_config.OPENSPLAT_BINARY_PATH.exists() else 'not_found',
            'colmap': 'available' if shutil.which(get_colmap_executable()) else 'not_found'
        }
    })


@api_bp.route('/upload', methods=['POST'])
def upload_files():
    """Handle file upload (images and/or videos)."""
    # Normalise incoming payload – support both `files` list and single `file`
    files = request.files.getlist('files')

    if not files:
        single_file = request.files.get('file')
        if single_file:
            files = [single_file]

    if not files:
        return jsonify({'error': 'No files uploaded'}), 400

    project_id = str(uuid.uuid4())
    paths = setup_project_directories(project_id)

    saved_files = []
    video_files = []
    image_files = []

    for file in files:
        if not file or file.filename == '':
            continue

        if allowed_file(file.filename):
            filename = secure_unicode_filename(file.filename)
            file_type = get_file_type(filename)

            if file_type == 'video':
                # Save video file
                video_path = paths['project_path'] / filename
                file.save(video_path)
                video_files.append(str(video_path))
                saved_files.append(filename)

            elif file_type == 'image':
                # Save image file directly to images folder
                image_path = paths['images_path'] / filename
                file.save(image_path)
                image_files.append(str(image_path))
                saved_files.append(filename)

    if not saved_files:
        return jsonify({'error': 'No valid files uploaded'}), 400

    # Determine input type
    if video_files and image_files:
        input_type = 'mixed'
    elif video_files:
        input_type = 'video'
    else:
        input_type = 'images'

    # Get processing configuration
    quality_mode = request.form.get('quality_mode', 'balanced')

    config = {
        'camera_model': request.form.get('camera_model', 'SIMPLE_RADIAL'),
        'matcher_type': request.form.get('matcher_type', 'sequential'),
        'quality_mode': quality_mode,

        # Frame extraction configuration for videos
        'extraction_mode': request.form.get('extraction_mode', 'frames'),  # 'frames' or 'fps'
        'max_frames': int(request.form.get('max_frames', 100)),
        'target_fps': float(request.form.get('target_fps', 1.0)),
        'quality': int(request.form.get('quality', 100)),
        'preview_count': int(request.form.get('preview_count', 10))
    }

    # Add custom parameters if in custom mode
    if quality_mode == 'custom':
        # OpenSplat Training Parameters
        if request.form.get('iterations'):
            config['iterations'] = int(request.form.get('iterations'))
        if request.form.get('densify_grad_threshold'):
            config['densify_grad_threshold'] = float(request.form.get('densify_grad_threshold'))
        if request.form.get('refine_every'):
            config['refine_every'] = int(request.form.get('refine_every'))
        if request.form.get('warmup_length'):
            config['warmup_length'] = int(request.form.get('warmup_length'))
        if request.form.get('ssim_weight'):
            config['ssim_weight'] = float(request.form.get('ssim_weight'))

        # OpenSplat Learning Rates
        if request.form.get('learning_rate'):
            config['learning_rate'] = float(request.form.get('learning_rate'))
        if request.form.get('position_lr_init'):
            config['position_lr_init'] = float(request.form.get('position_lr_init'))
        if request.form.get('position_lr_final'):
            config['position_lr_final'] = float(request.form.get('position_lr_final'))
        if request.form.get('feature_lr'):
            config['feature_lr'] = float(request.form.get('feature_lr'))
        if request.form.get('opacity_lr'):
            config['opacity_lr'] = float(request.form.get('opacity_lr'))
        if request.form.get('scaling_lr'):
            config['scaling_lr'] = float(request.form.get('scaling_lr'))
        if request.form.get('rotation_lr'):
            config['rotation_lr'] = float(request.form.get('rotation_lr'))
        if request.form.get('percent_dense'):
            config['percent_dense'] = float(request.form.get('percent_dense'))

        # COLMAP SIFT Feature Parameters
        if request.form.get('peak_threshold'):
            config['peak_threshold'] = float(request.form.get('peak_threshold'))
        if request.form.get('edge_threshold'):
            config['edge_threshold'] = float(request.form.get('edge_threshold'))
        if request.form.get('max_num_orientations'):
            config['max_num_orientations'] = int(request.form.get('max_num_orientations'))

        # COLMAP Feature Extraction & Matching
        if request.form.get('max_num_features'):
            config['max_num_features'] = int(request.form.get('max_num_features'))
        if request.form.get('max_num_matches'):
            config['max_num_matches'] = int(request.form.get('max_num_matches'))
        if request.form.get('sequential_overlap'):
            config['sequential_overlap'] = int(request.form.get('sequential_overlap'))

        # COLMAP Mapper (Reconstruction)
        if request.form.get('min_num_matches'):
            config['min_num_matches'] = int(request.form.get('min_num_matches'))
        if request.form.get('max_num_models'):
            config['max_num_models'] = int(request.form.get('max_num_models'))
        if request.form.get('init_num_trials'):
            config['init_num_trials'] = int(request.form.get('init_num_trials'))
    else:
        # For non-custom modes, use default iterations from quality mode
        if request.form.get('iterations'):
            config['iterations'] = int(request.form.get('iterations'))

    now_iso = datetime.now().isoformat()
    metadata = {
        'name': request.form.get('project_name') or f"PobimSplats {project_id[:8]}",
        'description': request.form.get('project_description', ''),
        'created_at': now_iso,
        'updated_at': now_iso,
    }

    entry = initialize_project_entry(
        project_id,
        metadata=metadata,
        config=config,
        file_count=len(saved_files),
        files=saved_files,
        log_file=paths['log_file'],
        input_type=input_type
    )

    with project_store.status_lock:
        project_store.processing_status[project_id] = entry
        save_projects_db()

    append_log_line(project_id, f"Project created: {input_type} input with {len(saved_files)} files")
    append_log_line(project_id, f"Videos: {len(video_files)}, Images: {len(image_files)}")
    if video_files:
        if config['extraction_mode'] == 'fps':
            append_log_line(project_id, f"Frame extraction: {config['target_fps']} FPS, quality={config['quality']}%")
        else:
            append_log_line(project_id, f"Frame extraction: max {config['max_frames']} frames, quality={config['quality']}%")

    # Start background processing
    thread = threading.Thread(target=run_processing_pipeline, args=(project_id, paths, config, video_files, image_files))
    thread.daemon = True
    thread.start()

    return jsonify({
        'success': True,
        'project_id': project_id,
        'filename': saved_files[0] if saved_files else '',
        'path': video_files[0] if video_files else (image_files[0] if image_files else ''),
        'input_type': input_type,
        'total_files': len(saved_files),
        'video_files': len(video_files),
        'image_files': len(image_files),
        'message': f'Successfully uploaded {len(saved_files)} files'
    })


@api_bp.route('/video_compatibility', methods=['POST'])
def check_video_compatibility():
    """Check if an uploaded video is compatible for processing"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    if not file.filename.lower().endswith(tuple(app_config.VIDEO_EXTENSIONS)):
        return jsonify({'error': 'File is not a supported video format'}), 400

    try:
        # Save temporary file
        temp_filename = secure_unicode_filename(file.filename)
        temp_path = app_config.UPLOAD_FOLDER / f"temp_{uuid.uuid4()}_{temp_filename}"
        file.save(temp_path)

        # Initialize video processor and check compatibility
        video_processor = VideoProcessor()
        validation = video_processor.validate_video_compatibility(temp_path)

        # Get basic video info for display
        video_info = video_processor.get_video_info(temp_path)

        # Clean up temp file
        temp_path.unlink()

        result = {
            'is_compatible': validation['is_compatible'],
            'codec_name': validation['codec_name'],
            'issues': validation['issues'],
            'recommendations': validation['recommendations'],
            'video_info': video_info
        }

        return jsonify(result)

    except Exception as e:
        # Clean up temp file if it exists
        if 'temp_path' in locals() and temp_path.exists():
            temp_path.unlink()

        logger.error(f"Video compatibility check failed: {e}")
        return jsonify({
            'error': f'Failed to check video compatibility: {str(e)}',
            'is_compatible': False,
            'issues': ['Unable to analyze video file'],
            'recommendations': ['Try converting to H.264 format']
        }), 500


@api_bp.route('/process/<project_id>', methods=['POST', 'OPTIONS'])
def process_project(project_id):
    """Start processing for a project."""
    # Handle CORS preflight
    if request.method == 'OPTIONS':
        response = jsonify({'status': 'ok'})
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    # Project already being processed
    return jsonify({
        'success': True,
        'project_id': project_id,
        'status': project_store.processing_status[project_id]['status']
    })


@api_bp.route('/status/<project_id>')
def get_status(project_id):
    """Get project processing status."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    with project_store.status_lock:
        data = project_store.processing_status[project_id].copy()

        # Add recent logs
        data['recent_logs'] = [
            f"[{log['time']}] {log['message']}"
            for log in data.get('log_tail', [])[-20:]  # Last 20 lines
        ]
        data['stage_details'] = data.get('stage_details', {})

    return jsonify(data)


@api_bp.route('/ply/<project_id>')
def serve_ply(project_id):
    """Serve PLY file with CORS headers."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    # Try different PLY file naming patterns
    ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_high_7000iter.ply"
    if not ply_path.exists():
        ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_2000iter.ply"

    if not ply_path.exists():
        # Try to find any PLY file in the directory
        project_dir = app_config.RESULTS_FOLDER / project_id
        if project_dir.exists():
            ply_files = list(project_dir.glob("*.ply"))
            if ply_files:
                ply_path = ply_files[0]  # Use the first PLY file found
            else:
                return jsonify({'error': 'PLY file not found'}), 404
        else:
            return jsonify({'error': 'PLY file not found'}), 404

    response = send_file(ply_path,
                        mimetype='application/octet-stream',
                        as_attachment=False)

    # Add CORS headers for SuperSplat viewer
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET'
    response.headers['Cache-Control'] = 'public, max-age=3600'

    return response


@api_bp.route('/frame_previews/<project_id>')
def get_frame_previews(project_id):
    """Get extracted frame previews for display."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    project_path = app_config.UPLOAD_FOLDER / project_id
    images_path = project_path / 'images'

    if not images_path.exists():
        return jsonify({'frames': [], 'message': 'No frames extracted yet'})

    # Get first N frames for preview
    frame_files = sorted(images_path.glob('frame_*.jpg'))[:20]  # Get up to 20 frames

    frames = []
    for frame_file in frame_files:
        # Create a thumbnail path
        frames.append({
            'name': frame_file.name,
            'url': f'/api/frame_preview/{project_id}/{frame_file.name}'
        })

    return jsonify({'frames': frames, 'count': len(list(images_path.glob('frame_*.jpg')))})


@api_bp.route('/frame_preview/<project_id>/<filename>')
def serve_frame_preview(project_id, filename):
    """Serve individual frame preview."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    frame_path = app_config.UPLOAD_FOLDER / project_id / 'images' / filename

    if not frame_path.exists():
        return jsonify({'error': 'Frame not found'}), 404

    # Serve the frame with caching headers
    return send_file(frame_path,
                    mimetype='image/jpeg',
                    as_attachment=False,
                    max_age=3600)


@api_bp.route('/project/<project_id>/thumbnail')
def get_project_thumbnail(project_id):
    """Get thumbnail image for a project (first available image)."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    images_path = app_config.UPLOAD_FOLDER / project_id / 'images'

    if not images_path.exists():
        return jsonify({'error': 'No images found'}), 404

    # Try to find the first image file
    image_files = []
    for ext in ['.jpg', '.jpeg', '.png', '.JPG', '.JPEG', '.PNG']:
        image_files.extend(sorted(images_path.glob(f'*{ext}')))

    if not image_files:
        return jsonify({'error': 'No images found'}), 404

    # Return the first image
    thumbnail_path = image_files[0]

    return send_file(thumbnail_path,
                    mimetype='image/jpeg',
                    as_attachment=False,
                    max_age=3600)


@api_bp.route('/download/<project_id>')
def download_ply(project_id):
    """Download PLY file as attachment."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    project = project_store.processing_status[project_id]

    # Try different PLY file naming patterns
    ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_high_7000iter.ply"
    if not ply_path.exists():
        ply_path = app_config.RESULTS_FOLDER / project_id / f"{project_id}_2000iter.ply"

    if not ply_path.exists():
        # Try to find any PLY file in the directory
        project_dir = app_config.RESULTS_FOLDER / project_id
        if project_dir.exists():
            ply_files = list(project_dir.glob("*.ply"))
            if ply_files:
                ply_path = ply_files[0]  # Use the first PLY file found
            else:
                return jsonify({'error': 'PLY file not found'}), 404
        else:
            return jsonify({'error': 'PLY file not found'}), 404

    # Create a safe filename
    project_name = project.get('metadata', {}).get('name', f'PobimSplats_{project_id[:8]}')
    safe_filename = "".join(c for c in project_name if c.isalnum() or c in (' ', '-', '_')).rstrip()
    download_filename = f"{safe_filename}_{project_id[:8]}.ply"

    return send_file(ply_path,
                    mimetype='application/octet-stream',
                    as_attachment=True,
                    download_name=download_filename)


@api_bp.route('/project/<project_id>/retry', methods=['POST'])
def retry_project(project_id):
    """Retry processing from a specific stage."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    data = request.get_json() or {}
    from_stage = data.get('from_stage', 'ingest')  # Default to start from beginning

    project = project_store.processing_status[project_id]

    # Check if project is already processing
    if project['status'] == 'processing':
        return jsonify({'error': 'Project is already processing'}), 400

    # Validate stage
    valid_stages = [s['key'] for s in app_config.PIPELINE_STAGES]
    if from_stage not in valid_stages:
        return jsonify({'error': f'Invalid stage: {from_stage}'}), 400

    try:
        # Get project paths
        paths = setup_project_directories(project_id)
        config = project.get('config', {}).copy()

        # Merge new parameters if provided (for retry with updated settings)
        new_params = data.get('params', {})
        if new_params:
            append_log_line(project_id, "🔧 Updating configuration with new parameters")

            # Update OpenSplat training parameters if provided
            for param_key in ['iterations', 'densify_grad_threshold', 'refine_every', 'warmup_length',
                            'ssim_weight', 'learning_rate', 'position_lr_init', 'position_lr_final',
                            'feature_lr', 'opacity_lr', 'scaling_lr', 'rotation_lr', 'percent_dense']:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(project_id, f"  • {param_key}: {new_params[param_key]}")

            # Update COLMAP Feature Extraction parameters if provided
            for param_key in ['max_num_features', 'max_image_size', 'peak_threshold', 'edge_threshold']:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(project_id, f"  • {param_key}: {new_params[param_key]}")

            # Update COLMAP Feature Matching parameters if provided
            for param_key in ['max_num_matches', 'sequential_overlap']:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(project_id, f"  • {param_key}: {new_params[param_key]}")

            # Update COLMAP Sparse Reconstruction parameters if provided
            for param_key in ['min_num_matches', 'max_num_models', 'init_num_trials']:
                if param_key in new_params and new_params[param_key] is not None:
                    config[param_key] = new_params[param_key]
                    append_log_line(project_id, f"  • {param_key}: {new_params[param_key]}")

            # Update quality mode if provided
            if 'quality_mode' in new_params and new_params['quality_mode']:
                config['quality_mode'] = new_params['quality_mode']
                append_log_line(project_id, f"  • quality_mode: {new_params['quality_mode']}")

            # Save updated config to project
            with project_store.status_lock:
                project_store.processing_status[project_id]['config'] = config
                save_projects_db()

        # Determine video and image files
        video_files = []
        image_files = []

        # Check for existing video files
        project_path = app_config.UPLOAD_FOLDER / project_id
        for ext in app_config.VIDEO_EXTENSIONS:
            video_files.extend([str(p) for p in project_path.glob(f'*{ext}')])

        # Check for existing image files
        images_path = paths['images_path']
        for ext in app_config.IMAGE_EXTENSIONS:
            image_files.extend([str(p) for p in images_path.glob(f'*{ext}')])

        # Reset project status
        with project_store.status_lock:
            project_store.processing_status[project_id]['status'] = 'processing'
            project_store.processing_status[project_id]['error'] = None

            # Reset stages from the specified stage onwards
            stage_found = False
            for state in project_store.processing_status[project_id].get('progress_states', []):
                if state['key'] == from_stage:
                    stage_found = True

                if stage_found:
                    state['status'] = 'pending'
                    state['progress'] = 0
                    state['started_at'] = None
                    state['completed_at'] = None

            save_projects_db()

        append_log_line(project_id, f"🔄 Retrying processing from stage: {from_stage}")

        # Start background processing from the specified stage
        thread = threading.Thread(
            target=run_processing_pipeline_from_stage,
            args=(project_id, paths, config, video_files, image_files, from_stage)
        )
        thread.daemon = True
        thread.start()

        return jsonify({
            'success': True,
            'project_id': project_id,
            'from_stage': from_stage,
            'message': f'Processing restarted from {from_stage}'
        })

    except Exception as e:
        logger.error(f"Failed to retry project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


@api_bp.route('/projects')
def list_projects():
    """API endpoint to list all projects."""
    with project_store.status_lock:
        projects = [
            {
                'id': pid,
                'metadata': data['metadata'],
                'status': data['status'],
                'progress': data.get('progress', 0),
                'input_type': data.get('input_type', 'images'),
                'file_count': data.get('file_count', 0),
                'created_at': data.get('start_time'),
            }
            for pid, data in project_store.processing_status.items()
        ]

    projects.sort(key=lambda x: x['created_at'], reverse=True)
    return jsonify({'projects': projects})


@api_bp.route('/project/<project_id>/delete', methods=['POST'])
def delete_project(project_id):
    """Delete a project and its files."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        # Remove project files
        project_paths = [
            app_config.UPLOAD_FOLDER / project_id,
            app_config.FRAMES_FOLDER / project_id,
            app_config.RESULTS_FOLDER / project_id
        ]

        for path in project_paths:
            if path.exists():
                shutil.rmtree(path)

        # Remove from database
        with project_store.status_lock:
            del project_store.processing_status[project_id]
            save_projects_db()

        return jsonify({'success': True})

    except Exception as e:
        logger.error(f"Failed to delete project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


@api_bp.route('/project/<project_id>/transformation', methods=['GET'])
def get_transformation(project_id):
    """Get saved transformation data for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    with project_store.status_lock:
        transformation = project_store.processing_status[project_id].get('transformation', {
            'position': {'x': 0, 'y': 0, 'z': 0},
            'rotation': {'x': 0, 'y': 0, 'z': 0},
            'scale': {'x': 1, 'y': 1, 'z': 1}
        })

    return jsonify({'transformation': transformation})


@api_bp.route('/project/<project_id>/transformation', methods=['POST'])
def save_transformation(project_id):
    """Save transformation data for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        data = request.get_json()
        if not data or 'transformation' not in data:
            return jsonify({'error': 'Missing transformation data'}), 400

        transformation = data['transformation']

        # Validate transformation structure
        required_keys = ['position', 'rotation']
        for key in required_keys:
            if key not in transformation:
                return jsonify({'error': f'Missing {key} in transformation'}), 400
            if not all(axis in transformation[key] for axis in ['x', 'y', 'z']):
                return jsonify({'error': f'Invalid {key} format'}), 400

        # Save transformation to project data
        with project_store.status_lock:
            project_store.processing_status[project_id]['transformation'] = transformation
            save_projects_db()

        return jsonify({'success': True, 'transformation': transformation})

    except Exception as e:
        logger.error(f"Failed to save transformation for project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


@api_bp.route('/project/<project_id>/open_colmap_gui', methods=['POST'])
def open_colmap_gui(project_id):
    """Get COLMAP GUI command for project inspection."""
    try:
        # Get project paths (convert to absolute paths)
        project_path = (app_config.UPLOAD_FOLDER / project_id).resolve()

        # Check if project folder exists
        if not project_path.exists():
            return jsonify({'error': 'Project not found'}), 404

        database_path = (project_path / 'database.db').resolve()
        images_path = (project_path / 'images').resolve()
        sparse_path = (project_path / 'sparse').resolve()

        # Check if required files exist
        if not database_path.exists():
            return jsonify({'error': 'COLMAP database not found. Please complete COLMAP processing first.'}), 404

        if not images_path.exists():
            return jsonify({'error': 'Images folder not found'}), 404

        # Select the best sparse model (with most registered images)
        sparse_model_path = None
        if sparse_path.exists():
            sparse_model_path = select_best_sparse_model(sparse_path)
            if sparse_model_path:
                sparse_model_path = sparse_model_path.resolve()

        # Get COLMAP executable
        colmap_exe = get_colmap_executable()

        # Build command with absolute paths
        cmd_parts = [colmap_exe, 'gui']
        cmd_parts.extend(['--database_path', str(database_path)])
        cmd_parts.extend(['--image_path', str(images_path)])

        # Add import path if sparse model exists
        if sparse_model_path and sparse_model_path.exists():
            cmd_parts.extend(['--import_path', str(sparse_model_path)])

        # Format command as string
        command_str = ' '.join(cmd_parts)

        logger.info(f"Generated COLMAP GUI command for project {project_id}")
        logger.info(f"Command: {command_str}")

        return jsonify({
            'success': True,
            'command': command_str,
            'working_directory': str(app_config.BACKEND_ROOT),
            'paths': {
                'database': str(database_path),
                'images': str(images_path),
                'sparse': str(sparse_model_path) if sparse_model_path else None
            }
        })

    except Exception as e:
        logger.error(f"Failed to generate COLMAP GUI command for project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


@api_bp.route('/project/<project_id>/export_mesh', methods=['POST'])
def export_mesh(project_id):
    """
    Export PLY file to mesh format (GLTF/GLB/DAE).

    Request body:
        format: Output format ('gltf', 'glb', or 'dae')
        method: Conversion method ('point_cloud', 'poisson', or 'alpha_shapes')
        options: Optional parameters for conversion (depth, scale, etc.)
    """
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        data = request.get_json() or {}
        output_format = data.get('format', 'glb').lower()
        method = data.get('method', 'point_cloud').lower()
        options = data.get('options', {})

        # Validate format
        if output_format not in ['gltf', 'glb', 'dae']:
            return jsonify({'error': f'Unsupported format: {output_format}'}), 400

        # Validate method
        if method not in ['point_cloud', 'poisson', 'alpha_shapes']:
            return jsonify({'error': f'Unsupported method: {method}'}), 400

        # Find PLY file for this project
        project_dir = app_config.RESULTS_FOLDER / project_id
        if not project_dir.exists():
            return jsonify({'error': 'Project results not found'}), 404

        ply_files = list(project_dir.glob("*.ply"))
        if not ply_files:
            return jsonify({'error': 'No PLY file found for this project'}), 404

        # Use the first (or largest) PLY file
        ply_path = max(ply_files, key=lambda p: p.stat().st_size)

        # Create output path
        output_filename = f"{project_id}_export.{output_format}"
        output_path = project_dir / output_filename

        # Convert using MeshConverter
        converter = MeshConverter()
        logger.info(f"Converting {ply_path.name} to {output_format} using {method} method")

        success = converter.convert(
            input_path=ply_path,
            output_path=output_path,
            method=method,
            **options
        )

        if not success:
            return jsonify({'error': 'Conversion failed. Check logs for details.'}), 500

        # Check if output file was created
        if not output_path.exists():
            return jsonify({'error': 'Output file was not created'}), 500

        # Return file info
        file_size = output_path.stat().st_size

        return jsonify({
            'success': True,
            'filename': output_filename,
            'format': output_format,
            'method': method,
            'size': file_size,
            'size_mb': round(file_size / (1024 * 1024), 2),
            'download_url': f'/api/project/{project_id}/download_mesh/{output_filename}',
            'message': f'Successfully converted to {output_format.upper()} using {method} method'
        })

    except Exception as e:
        logger.error(f"Failed to export mesh for project {project_id}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@api_bp.route('/project/<project_id>/download_mesh/<filename>')
def download_mesh(project_id, filename):
    """Download exported mesh file."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        # Validate filename to prevent directory traversal
        if '..' in filename or '/' in filename:
            return jsonify({'error': 'Invalid filename'}), 400

        # Check if file exists
        file_path = app_config.RESULTS_FOLDER / project_id / filename
        if not file_path.exists():
            return jsonify({'error': 'File not found'}), 404

        # Determine MIME type
        mime_types = {
            '.gltf': 'model/gltf+json',
            '.glb': 'model/gltf-binary',
            '.dae': 'model/vnd.collada+xml'
        }
        suffix = file_path.suffix.lower()
        mime_type = mime_types.get(suffix, 'application/octet-stream')

        # Send file
        return send_file(
            file_path,
            mimetype=mime_type,
            as_attachment=True,
            download_name=filename
        )

    except Exception as e:
        logger.error(f"Failed to download mesh for project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


@api_bp.route('/project/<project_id>/available_exports')
def list_available_exports(project_id):
    """List all available exported mesh files for a project."""
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        project_dir = app_config.RESULTS_FOLDER / project_id
        if not project_dir.exists():
            return jsonify({'exports': []})

        # Find all exported mesh files
        export_files = []
        for ext in ['.gltf', '.glb', '.dae']:
            for file_path in project_dir.glob(f"*{ext}"):
                export_files.append({
                    'filename': file_path.name,
                    'format': ext.replace('.', ''),
                    'size': file_path.stat().st_size,
                    'size_mb': round(file_path.stat().st_size / (1024 * 1024), 2),
                    'created_at': file_path.stat().st_mtime,
                    'download_url': f'/api/project/{project_id}/download_mesh/{file_path.name}'
                })

        # Sort by creation time (newest first)
        export_files.sort(key=lambda x: x['created_at'], reverse=True)

        return jsonify({'exports': export_files, 'count': len(export_files)})

    except Exception as e:
        logger.error(f"Failed to list exports for project {project_id}: {e}")
        return jsonify({'error': str(e)}), 500


def _run_mesh_export_background(project_id, method, quality, output_format):
    """Background worker for mesh export."""
    try:
        logger.info(f"[Mesh Export] Starting background export for project {project_id}")
        
        # Find project paths
        project_path = app_config.UPLOAD_FOLDER / project_id
        sparse_path = project_path / 'sparse' / '0'

        if not sparse_path.exists():
            # Try to find any sparse model
            sparse_parent = project_path / 'sparse'
            if sparse_parent.exists():
                sparse_models = [p for p in sparse_parent.iterdir() if p.is_dir()]
                if sparse_models:
                    sparse_path = sparse_models[0]
                else:
                    logger.error(f"[Mesh Export] No sparse reconstruction found for {project_id}")
                    return
            else:
                logger.error(f"[Mesh Export] No sparse folder found for {project_id}")
                return

        # Create output path
        results_dir = app_config.RESULTS_FOLDER / project_id
        results_dir.mkdir(exist_ok=True, parents=True)

        output_filename = f"{project_id}_textured_mesh_{method}.{output_format}"
        output_path = results_dir / output_filename

        # Get COLMAP executable
        colmap_exe = get_colmap_executable()

        # Create MVS mesher
        mesher = MVSMesher(colmap_exe)

        # Run the full pipeline
        logger.info(f"[Mesh Export] Creating textured mesh for project {project_id}...")
        logger.info(f"[Mesh Export]   Method: {method}, Quality: {quality}, Format: {output_format}")

        success = mesher.create_full_textured_mesh(
            project_path=project_path,
            sparse_model_path=sparse_path,
            output_path=output_path,
            method=method,
            quality=quality,
            export_format=output_format
        )

        if success and output_path.exists():
            file_size = output_path.stat().st_size
            logger.info(f"[Mesh Export] ✅ Successfully created mesh: {output_filename} ({file_size / (1024*1024):.1f} MB)")
        else:
            logger.error(f"[Mesh Export] ❌ Failed to create mesh for {project_id}")

    except Exception as e:
        logger.error(f"[Mesh Export] Exception in background export for {project_id}: {e}")
        import traceback
        traceback.print_exc()


@api_bp.route('/project/<project_id>/create_textured_mesh', methods=['POST'])
def create_textured_mesh(project_id):
    """
    Create textured mesh using COLMAP dense reconstruction.
    This creates a proper textured mesh similar to OpenDroneMap.
    
    This endpoint starts the export in background and returns immediately.
    Use /available_exports to check when it's done.

    Request body:
        method: Meshing method ('poisson' or 'delaunay')
        quality: Reconstruction quality ('low', 'medium', 'high')
        format: Output format ('ply', 'obj', 'glb', 'dae')
    """
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    try:
        data = request.get_json() or {}
        method = data.get('method', 'poisson').lower()
        quality = data.get('quality', 'medium').lower()
        output_format = data.get('format', 'glb').lower()

        # Validate parameters
        if method not in ['poisson', 'delaunay']:
            return jsonify({'error': f'Invalid method: {method}. Use "poisson" or "delaunay"'}), 400

        if quality not in ['low', 'medium', 'high']:
            return jsonify({'error': f'Invalid quality: {quality}. Use "low", "medium", or "high"'}), 400

        if output_format not in ['ply', 'obj', 'glb', 'dae']:
            return jsonify({'error': f'Invalid format: {output_format}'}), 400

        # Check if project has completed sparse reconstruction
        project = project_store.processing_status[project_id]
        if project['status'] not in ['completed', 'error']:
            return jsonify({'error': 'Project must complete sparse reconstruction first'}), 400

        # Check if sparse reconstruction exists
        project_path = app_config.UPLOAD_FOLDER / project_id
        sparse_path = project_path / 'sparse' / '0'
        
        if not sparse_path.exists():
            sparse_parent = project_path / 'sparse'
            if not sparse_parent.exists() or not any(sparse_parent.iterdir()):
                return jsonify({
                    'error': 'No sparse reconstruction found',
                    'hint': 'Project must complete COLMAP sparse reconstruction first'
                }), 404

        # Start background export
        output_filename = f"{project_id}_textured_mesh_{method}.{output_format}"
        
        thread = threading.Thread(
            target=_run_mesh_export_background,
            args=(project_id, method, quality, output_format),
            daemon=True
        )
        thread.start()

        logger.info(f"Started mesh export in background for {project_id}: {output_filename}")

        return jsonify({
            'success': True,
            'status': 'processing',
            'filename': output_filename,
            'format': output_format,
            'method': method,
            'quality': quality,
            'message': f'Mesh export started. This will take 5-30 minutes depending on quality and image count.',
            'hint': 'Use /api/project/{project_id}/available_exports to check when export is complete',
            'check_url': f'/api/project/{project_id}/available_exports'
        })

    except Exception as e:
        logger.error(f"Failed to start mesh export for project {project_id}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'error': str(e),
            'hint': 'Check that COLMAP is installed with dense reconstruction support'
        }), 500


@api_bp.route('/project/<project_id>/cancel', methods=['POST'])
def cancel_project_processing(project_id):
    """
    Cancel active processing for a project.
    
    This will terminate the currently running process (COLMAP or OpenSplat training).
    The project status will be updated to 'cancelled'.
    """
    if project_id not in project_store.processing_status:
        return jsonify({'error': 'Project not found'}), 404

    project = project_store.processing_status[project_id]
    
    # Check if project is currently processing
    if project['status'] != 'processing':
        return jsonify({
            'error': f'Project is not currently processing (status: {project["status"]})',
            'status': project['status']
        }), 400

    try:
        # Import the cancel function
        from ..core.projects import cancel_processing
        
        # Attempt to cancel the processing
        success = cancel_processing(project_id)
        
        if success:
            return jsonify({
                'success': True,
                'message': 'Processing cancelled successfully',
                'project_id': project_id,
                'status': 'cancelled'
            })
        else:
            return jsonify({
                'error': 'No active process found to cancel',
                'hint': 'The process may have already completed or failed',
                'status': project['status']
            }), 404

    except Exception as e:
        logger.error(f"Failed to cancel processing for project {project_id}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({
            'error': f'Failed to cancel processing: {str(e)}'
        }), 500
