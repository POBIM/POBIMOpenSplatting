import axios from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 6000000,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
});

// Add response interceptor for better error handling
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK') {
      console.error('Network Error:', error.message);
      error.message = 'Cannot connect to backend server. Please check if the backend is running.';
    }
    return Promise.reject(error);
  }
);

// Type definitions
export interface Project {
  id: string;
  metadata: {
    name: string;
    description?: string;
    created_at: string;
    updated_at: string;
  };
  status: 'uploading' | 'processing' | 'completed' | 'failed' | 'pending' | 'cancelled';
  progress: number;
  input_type: 'images' | 'video' | 'mixed';
  file_count: number;
  created_at: string;
  completed_at?: string;
  error_message?: string;
  quality_mode?: string;
  iterations?: number;
  camera_model?: string;
  thumbnail_url?: string;
  auto_tuning_summary?: AutoTuningSummary;
  config?: {
    smart_frame_selection?: boolean;
    oversample_factor?: number;
    sfm_engine?: 'glomap' | 'global' | 'global_mapper' | 'colmap' | 'fastmap';
    sfm_backend?: 'cli' | 'pycolmap' | string;
    feature_method?: 'sift' | 'aliked' | 'superpoint';
    replacement_search_radius?: number;
    ffmpeg_cpu_workers?: number;
    [key: string]: any;
  };
  reconstruction_framework?: ReconstructionFramework;
  resource_coordination?: {
    profile_class?: string;
    gpu_model?: string;
    gpu_vram_mb?: number;
    summary?: string;
    resource_lane?: string;
    resource_lane_state?: string;
    admission_reason?: string;
    downgrade_reason?: string | null;
    estimated_start_delay?: number;
    current_stage?: string;
    manual_override?: boolean;
    auto_tuning_summary?: AutoTuningSummary;
    capture_budget_summary?: {
      input_type?: string;
      num_images?: number;
      num_videos?: number;
      adaptive_frame_budget?: boolean;
      adaptive_pair_scheduling?: boolean;
      effective_oversample_factor?: number;
      colmap_resolution?: string;
      training_resolution?: string;
      use_separate_training_images?: boolean;
    };
  };
  video_extraction_diagnostics?: VideoExtractionDiagnostics;
  recent_logs?: string[];
  log_count?: number;
  log_visible_count?: number;
  log_truncated?: boolean;
}

export interface ReconstructionFramework {
  phase?: string;
  sfm_engine?: 'glomap' | 'global' | 'global_mapper' | 'colmap' | 'fastmap' | string;
  sfm_backend?: 'cli' | 'pycolmap' | string;
  feature_method?: 'sift' | 'aliked' | 'superpoint' | string;
  matcher_type?: string;
  orbit_safe_mode?: boolean;
  orbit_safe_profile?: string | null;
  bridge_risk_score?: number | null;
  matcher_params?: Record<string, string>;
  mapper_params?: Record<string, string>;
  capture_pattern?: {
    ordered_frame_ratio?: number;
    frame_like_images?: number;
    looks_like_video_orbit?: boolean;
  };
  pair_geometry_stats?: {
    image_count?: number;
    adjacent_median?: number;
    adjacent_p10?: number;
    bridge_median?: number;
    bridge_p10?: number;
    bridge_min?: number;
    weak_boundary_count?: number;
    weak_boundary_ratio?: number;
    zero_boundary_count?: number;
    zero_boundary_ratio?: number;
  };
  resource_contract_version?: string;
  resource_profile?: {
    profile_class?: string;
    gpu_model?: string;
    gpu_vram_mb?: number;
    summary?: string;
  };
  resource_lane?: string;
  resource_lane_state?: string;
  admission_reason?: string;
  downgrade_reason?: string | null;
  estimated_start_delay?: number;
  auto_tuning_summary?: AutoTuningSummary;
  capture_budget_summary?: {
    input_type?: string;
    num_images?: number;
    num_videos?: number;
    adaptive_frame_budget?: boolean;
    adaptive_pair_scheduling?: boolean;
    effective_oversample_factor?: number;
    colmap_resolution?: string;
    training_resolution?: string;
    use_separate_training_images?: boolean;
  };
  training_budget_summary?: {
    resource_profile_class?: string;
    resource_lane?: string;
    training_resolution?: string;
    colmap_resolution?: string;
    use_separate_training_images?: boolean;
    adaptive_frame_budget?: boolean;
    adaptive_pair_scheduling?: boolean;
    repair_step_count?: number;
    uses_repaired_capture?: boolean;
  };
  recovery_loop_summary?: {
    schema_version?: string;
    precedence?: string[];
    final_path?: string;
    state?: string;
    local_repair_count?: number;
    broad_fallback_used?: boolean;
    final_reason_code?: string | null;
    unresolved_weak_boundary_count?: number;
    unresolved_split_model?: boolean;
  };
  sparse_model_summary?: {
    best_registered?: number;
    registered_ratio?: number;
    model_count?: number;
    alternate_registered?: number;
    has_multiple_models?: boolean;
  };
  progressive_matching_plan?: {
    enabled?: boolean;
    reason?: string;
    resource_tier?: string;
    peak_feature_count?: number | null;
    gpu_total_vram_mb?: number | null;
    final_overlap?: number;
    passes?: Array<{
      key?: string;
      label?: string;
      required?: boolean;
      kind?: string;
      max_num_matches?: number;
      continue_if?: string;
      checkpoint_note?: string;
      matcher_params?: Record<string, string>;
    }>;
  };
  progressive_matching_checkpoints?: Array<{
    key?: string;
    label?: string;
    max_num_matches?: number;
    verified_pairs?: number;
    geometry_stats?: {
      image_count?: number;
      bridge_p10?: number;
      bridge_min?: number;
      weak_boundary_count?: number;
      weak_boundary_ratio?: number;
      zero_boundary_count?: number;
      zero_boundary_ratio?: number;
    };
  }>;
  recovery_history?: Array<{
    kind?: string;
    label?: string;
    reason?: string;
    reason_code?: string;
    step_order?: number;
    status?: string;
    outcome?: string;
    tuned_decision_used?: boolean;
    failed_step_key?: string | null;
    fallback_step?: string | null;
    fallback_reason?: string | null;
    subset_image_count?: number;
    weak_boundary_count?: number;
    target_boundary_count?: number;
    surviving_target_boundary_count?: number;
    padding?: number | null;
    overlap?: string;
    quadratic_overlap?: string;
    loop_detection?: string;
    runtime_mode?: string;
    pair_targeted?: boolean;
    pair_count?: number;
    pair_budget_cap?: number;
    pair_budget_capped?: boolean;
    pair_budget_reason?: string;
    targeted_boundaries?: Array<{
      key?: string;
      left_image_name?: string;
      right_image_name?: string;
      bridge_strength?: number;
      adjacent_inliers?: number;
      severity_label?: string;
      severity_multiplier?: number;
      target_segment_frames?: number;
      inserted_frame_count?: number;
      cross_radius?: number;
      local_radius?: number;
      pair_count?: number;
      pair_budget_cap?: number;
      pair_budget_capped?: boolean;
      outcome?: string;
    }>;
    surviving_target_boundaries?: Array<{
      key?: string;
      left_image_name?: string;
      right_image_name?: string;
      bridge_strength?: number;
      adjacent_inliers?: number;
      severity_label?: string;
      severity_multiplier?: number;
      target_segment_frames?: number;
      inserted_frame_count?: number;
      cross_radius?: number;
      local_radius?: number;
      pair_count?: number;
      pair_budget_cap?: number;
      pair_budget_capped?: boolean;
      outcome?: string;
    }>;
    geometry_stats?: {
      image_count?: number;
      bridge_p10?: number;
      bridge_min?: number;
      weak_boundary_count?: number;
      weak_boundary_ratio?: number;
      zero_boundary_count?: number;
      zero_boundary_ratio?: number;
    };
  }>;
}

export interface AutoTuningSurfaceSummary {
  status?: string;
  label?: string;
  summary?: string;
  tuned?: boolean;
  source?: string;
  override_applied?: boolean;
  confidence?: number | string;
}

export interface AutoTuningSummary {
  schema_version?: string;
  enabled?: boolean;
  mode?: string;
  active_snapshot?: string;
  active_label?: string;
  source_label?: string;
  summary?: string;
  derived_from_runs?: number;
  confidence?: number | string;
  last_updated_at?: string;
  guardrails_applied?: string[];
  fallback_to_stable?: boolean;
  fallback_reason?: string | null;
  stable_snapshot_version?: string;
  tuned_snapshot_version?: string;
  tuned_value_count?: number;
  extraction?: AutoTuningSurfaceSummary;
  matching?: AutoTuningSurfaceSummary;
  recovery?: AutoTuningSurfaceSummary;
  orchestration?: AutoTuningSurfaceSummary;
  training?: AutoTuningSurfaceSummary;
  export?: AutoTuningSurfaceSummary;
}

export interface ProcessingStatus {
  project_id: string;
  status: string;
  progress: number;
  stage?: string;
  message?: string;
  error?: string;
  ply_file?: string;
  frame_previews?: string[];
  reconstruction_framework?: ReconstructionFramework;
  video_extraction_diagnostics?: VideoExtractionDiagnostics;
}

export interface VideoExtractionSelection {
  target_index: number;
  selected_index: number;
  offset: number;
  sharpness: number;
  accepted: boolean;
  fallback_used: boolean;
}

export interface VideoExtractionDiagnostics {
  strategy?: string;
  mode?: string;
  candidate_count?: number;
  requested_targets?: number;
  saved_frames?: number;
  replaced_targets?: number;
  search_radius?: number;
  rejected_candidates?: number;
  oversample_factor?: number;
  requested_oversample_factor?: number;
  candidate_density_ratio?: number;
  scoring_workers?: number;
  adaptive_frame_budget?: {
    enabled?: boolean;
    requested_oversample_factor?: number;
    effective_oversample_factor?: number;
    density_scale?: number;
    target_output_count?: number;
    adjustments?: Array<{
      code?: string;
      factor?: number;
      reason?: string;
    }>;
    video_profile?: {
      total_frames?: number;
      fps?: number;
      duration?: number;
      width?: number;
      height?: number;
      codec_name?: string | null;
      bit_rate_mbps?: number | null;
    };
  };
  candidate_quality_summary?: {
    candidate_total?: number;
    accepted_total?: number;
    accepted_ratio?: number;
    median_sharpness?: number;
    p25_sharpness?: number;
    median_brightness?: number;
  };
  selections?: VideoExtractionSelection[];
  videos?: Array<{
    filename?: string;
    candidate_count?: number;
    requested_targets?: number;
    saved_frames?: number;
    replaced_targets?: number;
    search_radius?: number;
    rejected_candidates?: number;
    oversample_factor?: number;
    requested_oversample_factor?: number;
    candidate_density_ratio?: number;
    scoring_workers?: number;
    adaptive_frame_budget?: VideoExtractionDiagnostics['adaptive_frame_budget'];
    candidate_quality_summary?: VideoExtractionDiagnostics['candidate_quality_summary'];
    selections?: VideoExtractionSelection[];
  }>;
}

export interface PlyFile {
  filename: string;
  path: string;
  size: number;
  size_mb: number;
  created_at: number;
  quality_mode: string;
  iterations: number;
  download_url: string;
}

export interface PlyFilesResponse {
  project_id: string;
  project_name: string;
  ply_files: PlyFile[];
  total: number;
}

export interface CameraPose {
  image_name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fx?: number;
  fy?: number;
  width?: number;
  height?: number;
  image_url?: string;
}

export interface SparsePoint {
  position: [number, number, number];
  color?: [number, number, number];
}

export interface CameraPosesData {
  project_id: string;
  project_name?: string;
  sfm_engine?: string;
  camera_count: number;
  cameras: CameraPose[];
  sparse_point_count?: number;
  sparse_points?: SparsePoint[];
  is_live?: boolean;
  source_type?: 'snapshot' | 'final' | string;
  source_label?: string;
  sparse_model_path?: string;
}

export interface TrainingPreview {
  project_id: string;
  available: boolean;
  is_live: boolean;
  filename: string;
  iteration: number;
  total_iterations: number;
  is_final: boolean;
  updated_at: string;
  size_bytes: number;
  version: number;
  preview_url: string;
}

export interface UploadConfig {
  project_name?: string;
  project_description?: string;
  quality_mode?: string;
  iterations?: number;
  camera_model?: string;
  sfm_backend?: 'cli' | 'pycolmap' | string;
  matcher_type?: 'auto' | 'sequential' | 'exhaustive' | 'vocab_tree' | string;
  extraction_mode?: string;
  max_frames?: number;
  target_fps?: number;
  quality?: number;
  preview_count?: number;
  smart_frame_selection?: boolean;
  adaptive_frame_budget?: boolean;
  oversample_factor?: number;
  replacement_search_radius?: number;
  ffmpeg_cpu_workers?: number;
  adaptive_pair_scheduling?: boolean;
  custom_params?: any;
}

export interface UploadPolicyPreviewSignal {
  key: string;
  label: string;
  delta: number;
  detail: string;
}

export interface UploadPolicyPreviewRule {
  level: 'info' | 'warning' | string;
  text: string;
}

export interface UploadPolicyAdaptiveState {
  enabled: boolean;
  available: boolean;
  label: string;
  effect: string;
  current_summary: string;
  disabled_summary?: string;
  gate?: string | null;
}

export interface UploadPolicyAdaptiveComparison {
  key: 'frame_budget' | 'pair_scheduling' | string;
  label: string;
  effect: string;
  available: boolean;
  current_enabled: boolean;
  recommended_enabled: boolean;
  score_delta_enabled_vs_disabled: number;
  current_score: number;
  alternative_score: number;
  current_summary: string;
  alternative_summary: string;
  gate?: string | null;
}

export interface UploadPolicyPreview {
  resource_contract?: {
    schema_version?: string;
    benchmark_profiles?: Array<{
      id?: string;
      label?: string;
      description?: string;
    }>;
    metric_keys?: string[];
  };
  heuristic_source: 'backend' | string;
  input_profile: 'images' | 'video' | 'mixed' | 'unknown' | string;
  estimated_num_images: number;
  capture_pattern?: {
    ordered_frame_ratio?: number;
    frame_like_images?: number;
    looks_like_video_orbit?: boolean;
  };
  expected_policy: {
    title: string;
    tone: string;
    badgeTone: string;
    profileBadge: string;
    matcherBadge: string;
    engineBadge: string;
    summary: string;
    toneKey: 'images' | 'video' | 'mixed' | 'unknown' | string;
  };
  confidence: {
    label: 'High' | 'Medium' | 'Cautious' | string;
    tone: string;
    meterClass: string;
    score: number;
    signals: UploadPolicyPreviewSignal[];
  };
  preview_rules: UploadPolicyPreviewRule[];
  resolved_matcher_type?: string;
  orbit_safe_mode?: boolean;
  orbit_safe_profile?: string | null;
  bridge_risk_score?: number | null;
  adaptive_policy?: {
    frame_budget?: UploadPolicyAdaptiveState;
    pair_scheduling?: UploadPolicyAdaptiveState;
  };
  adaptive_comparisons?: UploadPolicyAdaptiveComparison[];
  auto_tuning_summary?: AutoTuningSummary;
}

// API helper functions
export const api = {
  // Health check
  health: async () => {
    const response = await apiClient.get('/api/health');
    return response.data;
  },

  // Projects
  getProjects: async () => {
    const response = await apiClient.get('/api/projects');
    return response.data;
  },

  getProject: async (id: string) => {
    const response = await apiClient.get(`/api/project/${id}`);
    return response.data;
  },

  deleteProject: async (id: string) => {
    const response = await apiClient.post(`/api/project/${id}/delete`);
    return response.data;
  },

  retryProject: async (id: string, fromStage?: string, params?: any) => {
    const response = await apiClient.post(`/api/project/${id}/retry`, {
      from_stage: fromStage || 'ingest',
      params: params || {}
    });
    return response.data;
  },

  cancelProject: async (id: string) => {
    const response = await apiClient.post(`/api/project/${id}/cancel`);
    return response.data;
  },

  openColmapGUI: async (id: string) => {
    const response = await apiClient.post(`/api/project/${id}/open_colmap_gui`);
    return response.data;
  },

  // PLY Files
  getPlyFiles: async (id: string): Promise<PlyFilesResponse> => {
    const response = await apiClient.get(`/api/project/${id}/ply_files`);
    return response.data;
  },

  getDownloadUrl: (id: string, filename?: string) => {
    if (filename) {
      return `${API_BASE_URL}/api/download/${id}/${filename}`;
    }
    return `${API_BASE_URL}/api/download/${id}`;
  },

  previewUploadPolicy: async (files: File[], config: any): Promise<UploadPolicyPreview> => {
    const response = await apiClient.post('/api/upload/policy_preview', {
      files: files.map((file) => ({ name: file.name, type: file.type, size: file.size })),
      input_type: files.some((file) => file.type.startsWith('video/'))
        ? files.some((file) => file.type.startsWith('image/'))
          ? 'mixed'
          : 'video'
        : files.some((file) => file.type.startsWith('image/'))
          ? 'images'
          : 'unknown',
      ...config,
    });
    return response.data;
  },

  // Upload
  upload: async (files: File[], config: any, onProgress?: (loaded: number, total: number) => void) => {
    const formData = new FormData();

    // Add files
    files.forEach((file) => {
      formData.append('files', file, file.name);
    });

    // Add basic configuration
    if (config.project_name) formData.append('project_name', config.project_name);
    if (config.project_description) formData.append('project_description', config.project_description);
    if (config.quality_mode) formData.append('quality_mode', config.quality_mode);
    if (config.camera_model) formData.append('camera_model', config.camera_model);
    if (config.matcher_type && config.matcher_type !== 'auto') {
      formData.append('matcher_type', config.matcher_type);
    }
    if (config.sfm_engine) formData.append('sfm_engine', config.sfm_engine);
    if (config.sfm_backend) formData.append('sfm_backend', config.sfm_backend);
    if (config.fast_sfm !== undefined) formData.append('fast_sfm', config.fast_sfm.toString());
    if (config.feature_method) formData.append('feature_method', config.feature_method);

    // Frame extraction config for videos
    if (config.extraction_mode) formData.append('extraction_mode', config.extraction_mode);
    if (config.max_frames) formData.append('max_frames', config.max_frames.toString());
    if (config.target_fps) formData.append('target_fps', config.target_fps.toString());
    if (config.quality !== undefined) formData.append('quality', config.quality.toString());
    if (config.preview_count) formData.append('preview_count', config.preview_count.toString());
    if (config.smart_frame_selection !== undefined) formData.append('smart_frame_selection', config.smart_frame_selection.toString());
    if (config.adaptive_frame_budget !== undefined) formData.append('adaptive_frame_budget', config.adaptive_frame_budget.toString());
    if (config.oversample_factor !== undefined) formData.append('oversample_factor', config.oversample_factor.toString());
    if (config.replacement_search_radius !== undefined) formData.append('replacement_search_radius', config.replacement_search_radius.toString());
    if (config.ffmpeg_cpu_workers !== undefined) formData.append('ffmpeg_cpu_workers', config.ffmpeg_cpu_workers.toString());
    if (config.vram_size !== undefined) formData.append('vram_size', config.vram_size.toString());
    // GPU acceleration for video frame extraction (5-10x faster with NVDEC)
    if (config.use_gpu_extraction !== undefined) formData.append('use_gpu_extraction', config.use_gpu_extraction.toString());
    
    // Resolution-based extraction settings (new)
    if (config.colmap_resolution) formData.append('colmap_resolution', config.colmap_resolution);
    if (config.training_resolution) formData.append('training_resolution', config.training_resolution);
    if (config.use_separate_training_images !== undefined) formData.append('use_separate_training_images', config.use_separate_training_images.toString());
    if (config.adaptive_pair_scheduling !== undefined) formData.append('adaptive_pair_scheduling', config.adaptive_pair_scheduling.toString());

    // Custom parameters - send each parameter individually
    if (config.quality_mode === 'custom') {
      // OpenSplat Training Parameters
      if (config.iterations !== undefined) formData.append('iterations', config.iterations.toString());
      if (config.densify_grad_threshold !== undefined) formData.append('densify_grad_threshold', config.densify_grad_threshold.toString());
      if (config.refine_every !== undefined) formData.append('refine_every', config.refine_every.toString());
      if (config.warmup_length !== undefined) formData.append('warmup_length', config.warmup_length.toString());
      if (config.ssim_weight !== undefined) formData.append('ssim_weight', config.ssim_weight.toString());

      // OpenSplat Learning Rates
      if (config.learning_rate !== undefined) formData.append('learning_rate', config.learning_rate.toString());
      if (config.position_lr_init !== undefined) formData.append('position_lr_init', config.position_lr_init.toString());
      if (config.position_lr_final !== undefined) formData.append('position_lr_final', config.position_lr_final.toString());
      if (config.feature_lr !== undefined) formData.append('feature_lr', config.feature_lr.toString());
      if (config.opacity_lr !== undefined) formData.append('opacity_lr', config.opacity_lr.toString());
      if (config.scaling_lr !== undefined) formData.append('scaling_lr', config.scaling_lr.toString());
      if (config.rotation_lr !== undefined) formData.append('rotation_lr', config.rotation_lr.toString());
      if (config.percent_dense !== undefined) formData.append('percent_dense', config.percent_dense.toString());

      // COLMAP SIFT Feature Parameters
      if (config.peak_threshold !== undefined) formData.append('peak_threshold', config.peak_threshold.toString());
      if (config.edge_threshold !== undefined) formData.append('edge_threshold', config.edge_threshold.toString());
      if (config.max_num_orientations !== undefined) formData.append('max_num_orientations', config.max_num_orientations.toString());

      // COLMAP Feature Extraction & Matching
      if (config.max_num_features !== undefined) formData.append('max_num_features', config.max_num_features.toString());
      if (config.max_num_matches !== undefined) formData.append('max_num_matches', config.max_num_matches.toString());
      if (config.sequential_overlap !== undefined) formData.append('sequential_overlap', config.sequential_overlap.toString());

      // COLMAP Mapper (Reconstruction)
      if (config.min_num_matches !== undefined) formData.append('min_num_matches', config.min_num_matches.toString());
      if (config.max_num_models !== undefined) formData.append('max_num_models', config.max_num_models.toString());
      if (config.init_num_trials !== undefined) formData.append('init_num_trials', config.init_num_trials.toString());
    } else {
      // For non-custom modes, still send iterations if provided
      if (config.iterations !== undefined) formData.append('iterations', config.iterations.toString());
    }

    const response = await apiClient.post('/api/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          onProgress(progressEvent.loaded, progressEvent.total);
        }
      },
    });
    return response.data;
  },

  uploadFiles: async (formData: FormData, onProgress?: (progress: number) => void) => {
    const response = await apiClient.post('/api/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(progress);
        }
      },
    });
    return response.data;
  },

  checkVideoCompatibility: async (formData: FormData) => {
    const response = await apiClient.post('/api/video_compatibility', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  // Processing
  startProcessing: async (projectId: string, options: any) => {
    const response = await apiClient.post(`/api/process/${projectId}`, options);
    return response.data;
  },

  getProcessingStatus: async (id: string) => {
    const response = await apiClient.get(`/api/status/${id}`);
    return response.data;
  },

  getStatus: async (id: string) => {
    const response = await apiClient.get(`/api/status/${id}`);
    return response.data;
  },

  getProjectLogsDownloadUrl: (id: string) => {
    return `${API_BASE_URL}/api/project/${id}/logs`;
  },

  // Results
  getPlyFile: async (id: string) => {
    const response = await apiClient.get(`/api/ply/${id}`);
    return response.data;
  },

  getFramePreviews: async (id: string) => {
    const response = await apiClient.get(`/api/frame_previews/${id}`);
    return response.data;
  },

  getFramePreview: async (id: string, filename: string) => {
    const response = await apiClient.get(`/api/frame_preview/${id}/${filename}`);
    return response.data;
  },

  downloadResult: async (id: string) => {
    const response = await apiClient.get(`/api/download/${id}`, {
      responseType: 'blob',
    });
    return response.data;
  },

  // Transformation
  getTransformation: async (id: string) => {
    const response = await apiClient.get(`/api/project/${id}/transformation`);
    return response.data;
  },

  saveTransformation: async (id: string, transformation: {
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    scale?: { x: number; y: number; z: number };
  }) => {
    const response = await apiClient.post(`/api/project/${id}/transformation`, {
      transformation,
    });
    return response.data;
  },

  // Mesh Export
  createTexturedMesh: async (
    projectId: string,
    options: {
      method?: 'poisson' | 'delaunay';
      quality?: 'low' | 'medium' | 'high';
      format?: 'ply' | 'obj' | 'glb' | 'dae';
    }
  ) => {
    const response = await apiClient.post(
      `/api/project/${projectId}/create_textured_mesh`,
      options,
      {
        timeout: 30000, // 30 seconds - just to start the background task
      }
    );
    return response.data;
  },

  getAvailableExports: async (projectId: string) => {
    const response = await apiClient.get(`/api/project/${projectId}/available_exports`);
    return response.data;
  },

  downloadMesh: async (projectId: string, filename: string) => {
    const response = await apiClient.get(
      `/api/project/${projectId}/download_mesh/${filename}`,
      {
        responseType: 'blob',
      }
    );
    return response.data;
  },

  // ArUco Markers
  getMarkerPresets: async () => {
    const response = await apiClient.get('/api/markers/presets');
    return response.data;
  },

  getMarkerSheetUrl: (options: {
    startId?: number;
    count?: number;
    sizeCm?: number;
    dict?: string;
    format?: 'pdf' | 'png' | 'jpg';
  } = {}) => {
    const params = new URLSearchParams();
    if (options.startId !== undefined) params.set('start_id', options.startId.toString());
    if (options.count !== undefined) params.set('count', options.count.toString());
    if (options.sizeCm !== undefined) params.set('size_cm', options.sizeCm.toString());
    if (options.dict) params.set('dict', options.dict);
    if (options.format) params.set('format', options.format);
    return `${API_BASE_URL}/api/markers/sheet?${params.toString()}`;
  },

  getSingleMarkerUrl: (markerId: number, options: {
    sizePx?: number;
    dict?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (options.sizePx !== undefined) params.set('size_px', options.sizePx.toString());
    if (options.dict) params.set('dict', options.dict);
    return `${API_BASE_URL}/api/markers/single/${markerId}?${params.toString()}`;
  },

  // Camera Poses
  getCameraPoses: async (
    id: string,
    options: { preferLive?: boolean } = {}
  ) => {
    const response = await apiClient.get(`/api/project/${id}/camera_poses`, {
      params:
        options.preferLive === undefined
          ? undefined
          : { prefer_live: options.preferLive ? '1' : '0' },
    });
    return response.data;
  },

  getTrainingPreview: async (id: string) => {
    const response = await apiClient.get(`/api/project/${id}/training_preview`);
    return response.data;
  },

  analyzeMarkers: async (imageFile: File, dict: string = '6x6_250') => {
    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('dict', dict);
    const response = await apiClient.post('/api/markers/analyze', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    return response.data;
  },
};

// Export axios instance for custom requests
export const axiosInstance = apiClient;

export default api;
