import axios from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 600000,
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
}

export interface UploadConfig {
  project_name?: string;
  project_description?: string;
  quality_mode?: string;
  iterations?: number;
  camera_model?: string;
  matcher_type?: string;
  extraction_mode?: string;
  max_frames?: number;
  target_fps?: number;
  quality?: number;
  preview_count?: number;
  custom_params?: any;
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

  // Upload
  upload: async (files: File[], config: any) => {
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
    if (config.matcher_type) formData.append('matcher_type', config.matcher_type);

    // Frame extraction config for videos
    if (config.extraction_mode) formData.append('extraction_mode', config.extraction_mode);
    if (config.max_frames) formData.append('max_frames', config.max_frames.toString());
    if (config.target_fps) formData.append('target_fps', config.target_fps.toString());
    if (config.quality !== undefined) formData.append('quality', config.quality.toString());
    if (config.preview_count) formData.append('preview_count', config.preview_count.toString());
    if (config.vram_size !== undefined) formData.append('vram_size', config.vram_size.toString());

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
};

// Export axios instance for custom requests
export const axiosInstance = apiClient;

export default api;
