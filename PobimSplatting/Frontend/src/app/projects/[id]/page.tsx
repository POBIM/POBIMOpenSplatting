'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback, useRef } from 'react';
import { api, Project, PlyFile } from '@/lib/api';
import { websocket } from '@/lib/websocket';
import { getMatcherLabelWithMode, getSfmEngineCompactLabel, getSfmEngineLabel, isGlobalSfmEngine } from '@/lib/sfm-display';
import MeshExportPanel from '@/components/MeshExportPanel';
import ExportedMeshesList from '@/components/ExportedMeshesList';
import {
  ArrowLeft,
  Download,
  Eye,
  Trash2,
  RefreshCw,
  CheckCircle,
  XCircle,
  Loader,
  Clock,
  Settings,
  Play,
  Pause,
  Monitor,
  FileVideo,
  Image,
  Info,
  Zap,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  X,
  FileBox,
  ArrowDownToLine,
  Upload,
  Film,
  Search,
  Link2,
  Box,
  Sparkles,
  Flag,
  LucideIcon
} from 'lucide-react';
import { Breadcrumbs } from '@/components/ui';

const getStageLabelForEngine = (
  stageKey: string, 
  sfmEngine: 'glomap' | 'global' | 'global_mapper' | 'colmap' | 'fastmap' = 'glomap',
  featureMethod: 'sift' | 'aliked' | 'superpoint' = 'sift'
) => {
  const isNeuralFeatures = featureMethod === 'aliked' || featureMethod === 'superpoint';
  const featureLabel = featureMethod === 'aliked' ? 'ALIKED' : featureMethod === 'superpoint' ? 'SuperPoint' : 'SIFT';
  
  const labels: Record<string, string> = {
    'feature_extraction': isNeuralFeatures 
      ? `hloc ${featureLabel} Extraction`
      : 'COLMAP Feature Extraction',
    'feature_matching': isNeuralFeatures
      ? 'LightGlue Neural Matching'
      : 'COLMAP Feature Matching',
    'sparse_reconstruction': isGlobalSfmEngine(sfmEngine)
      ? 'COLMAP Global SfM Sparse Reconstruction'
      : sfmEngine === 'fastmap'
        ? 'FastMap Sparse Reconstruction'
        : 'COLMAP Sparse Reconstruction',
  };
  return labels[stageKey];
};

const PIPELINE_STAGES: { key: string; label: string; Icon: LucideIcon; weight: number }[] = [
  { key: 'ingest', label: 'Upload', Icon: Upload, weight: 0.05 },
  { key: 'video_extraction', label: 'Extract', Icon: Film, weight: 0.1 },
  { key: 'feature_extraction', label: 'Features', Icon: Search, weight: 0.15 },
  { key: 'feature_matching', label: 'Match', Icon: Link2, weight: 0.1 },
  { key: 'sparse_reconstruction', label: 'Reconstruct', Icon: Box, weight: 0.2 },
  { key: 'model_conversion', label: 'Convert', Icon: RefreshCw, weight: 0.05 },
  { key: 'gaussian_splatting', label: 'Train', Icon: Sparkles, weight: 0.3 },
  { key: 'finalizing', label: 'Finalize', Icon: Flag, weight: 0.05 },
];

const STAGE_WEIGHT_MAP = PIPELINE_STAGES.reduce((acc, stage) => {
  acc[stage.key] = stage.weight;
  return acc;
}, {} as Record<string, number>);

const MAX_LOG_LINES = 10000; // Keep all logs for full visibility

const isErrorStatus = (status?: string | null): boolean =>
  status === 'failed' || status === 'cancelled';

const normalizeProgressStates = (states: any[] = []) =>
  PIPELINE_STAGES.map(stage => {
    const found = states.find(s => s.key === stage.key);
    return found
      ? { ...found }
      : { key: stage.key, status: 'pending', progress: 0, started_at: null, completed_at: null };
  });

const calculateWeightedProgress = (states: any[] = []) => {
  let total = 0;
  states.forEach(state => {
    const weight = STAGE_WEIGHT_MAP[state.key] || 0;
    total += weight * ((state.progress || 0) / 100);
  });
  return Math.round(total * 100);
};

const formatLogTail = (logTail: any[] = []) =>
  logTail.slice(-MAX_LOG_LINES).map(entry => {
    if (!entry) {
      return '';
    }
    if (typeof entry === 'string') {
      return entry;
    }
    const time = entry.time || entry.timestamp || '';
    const message = entry.message || '';
    return time ? `[${time}] ${message}` : message;
  });

const formatPercent = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }
  return `${Math.round(value * 100)}%`;
};

export default function ProjectDetailPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [stages, setStages] = useState<any[]>(() => normalizeProgressStates());
  const [stageDetails, setStageDetails] = useState<Record<string, any>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [framePreview, setFramePreview] = useState<any[]>([]);
  const [trainingFramePreview, setTrainingFramePreview] = useState<any[]>([]);
  const [hasSeparateTraining, setHasSeparateTraining] = useState(false);
  const [timeStats, setTimeStats] = useState({
    startTime: null as string | null,
    elapsedTime: '0s',
    remainingTime: 'Calculating...',
    eta: '--:--'
  });
  const projectStartTimeRef = useRef<string | null>(null);
  const [showRetryModal, setShowRetryModal] = useState(false);
  const [selectedRetryStage, setSelectedRetryStage] = useState<string>('ingest');
  const [showLogSidebar, setShowLogSidebar] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);
  const [retryParams, setRetryParams] = useState({
    // Gaussian Splatting params
    quality_mode: '',
    iterations: '',
    learning_rate: '',
    // COLMAP Feature Extraction params
    max_num_features: '',
    max_image_size: '',
    // COLMAP Feature Matching params
    max_num_matches: '',
    sequential_overlap: '',
    // COLMAP Sparse Reconstruction params
    min_num_matches: '',
    max_num_models: '',
    // Resolution settings
    colmap_resolution: '',
    training_resolution: '',
    use_separate_training_images: false,
    replacement_search_radius: '',
  });
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  
  // Download modal states
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [plyFiles, setPlyFiles] = useState<PlyFile[]>([]);
  const [loadingPlyFiles, setLoadingPlyFiles] = useState(false);
  const framework = project?.reconstruction_framework;
  const videoDiagnostics = project?.video_extraction_diagnostics;

  // Auto-expand the running stage
  useEffect(() => {
    const runningStage = stages.find(s => s.status === 'running');
    if (runningStage && expandedStage !== runningStage.key) {
      setExpandedStage(runningStage.key);
    }
  }, [stages]);

  const formatTime = useCallback((seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }, []);

  const updateTimeStats = useCallback((data: any) => {
    if (!data) {
      return;
    }

    const now = Date.now();
    const startTime = data.start_time ? new Date(data.start_time).getTime() : now;
    const elapsed = Math.max(0, Math.floor((now - startTime) / 1000));
    const progress = data.progress || 0;

    let remaining = 'Calculating...';
    let eta = '--:--';

    if (progress > 0 && progress < 100) {
      const estimatedTotal = (elapsed * 100) / progress;
      const remainingSeconds = Math.max(0, Math.floor(estimatedTotal - elapsed));
      if (remainingSeconds > 0) {
        remaining = formatTime(remainingSeconds);
        const etaTime = new Date(now + remainingSeconds * 1000);
        eta = etaTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      }
    }

    setTimeStats({
      startTime: data.start_time || null,
      elapsedTime: formatTime(elapsed),
      remainingTime: remaining,
      eta
    });
  }, [formatTime]);

  const loadProject = useCallback(async () => {
    try {
      const data = await api.getStatus(projectId);
      const normalizedStages = normalizeProgressStates(data.progress_states);
      const progressValue = typeof data.progress === 'number'
        ? data.progress
        : calculateWeightedProgress(normalizedStages);
      const logLines = (data.recent_logs || []).slice(-MAX_LOG_LINES);

      if (data.start_time) {
        projectStartTimeRef.current = data.start_time;
      }

      setProject({ ...data, id: projectId, progress: progressValue });
      setStages(normalizedStages);
      setStageDetails(data.stage_details || {});
      setLogs(logLines);
      updateTimeStats({ ...data, progress: progressValue });
    } catch (err) {
      console.error('Failed to load project:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId, updateTimeStats]);

  const loadFramePreviews = useCallback(async () => {
    try {
      const data = await api.getFramePreviews(projectId);
      if (data.frames && data.frames.length > 0) {
        setFramePreview(data.frames); // COLMAP frames (or combined if no separate training)
      } else if (data.colmap_frames && data.colmap_frames.length > 0) {
        setFramePreview(data.colmap_frames);
      } else {
        setFramePreview([]);
      }
      
      // Handle separate training images
      if (data.has_separate_training && data.training_frames && data.training_frames.length > 0) {
        setTrainingFramePreview(data.training_frames);
        setHasSeparateTraining(true);
      } else {
        setTrainingFramePreview([]);
        setHasSeparateTraining(false);
      }
    } catch (err) {
      console.error('Failed to load frame previews:', err);
    }
  }, [projectId]);

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      await api.deleteProject(projectId);
      router.push('/projects');
    } catch (err) {
      alert('Failed to delete project');
    }
  };

  const handleCancelProcessing = async () => {
    if (!confirm('ยกเลิกการประมวลผลโปรเจคนี้ใช่หรือไม่? การเทรนที่กำลังทำงานจะถูกหยุดทันที')) return;

    try {
      await api.cancelProject(projectId);
      alert('ยกเลิกการประมวลผลเรียบร้อยแล้ว');
      await loadProject();
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || 'ไม่สามารถยกเลิกการประมวลผลได้';
      alert(errorMsg);
    }
  };

  const handleProjectStatus = useCallback((payload: any) => {
    if (!payload) {
      return;
    }

    const normalizedStages = normalizeProgressStates(payload.progress_states);
    const details = payload.stage_details || {};
    const logLines = Array.isArray(payload.recent_logs)
      ? payload.recent_logs.slice(-MAX_LOG_LINES)
      : formatLogTail(payload.log_tail || []);
    const progressValue = typeof payload.progress === 'number'
      ? payload.progress
      : calculateWeightedProgress(normalizedStages);

    if (payload.start_time) {
      projectStartTimeRef.current = payload.start_time;
    }

    const { progress_states, stage_details, log_tail, recent_logs, ...rest } = payload;

    setStages(normalizedStages);
    setStageDetails(details);
    setLogs(logLines);

    setProject(prev => ({
      ...(prev ?? { id: projectId }),
      ...rest,
      id: projectId,
      progress: progressValue,
      progress_states: normalizedStages,
      stage_details: details,
      recent_logs: logLines,
    } as Project));

    updateTimeStats({
      ...rest,
      start_time: rest.start_time || projectStartTimeRef.current,
      progress: progressValue,
    });
  }, [projectId, updateTimeStats]);

  const handleStageProgress = useCallback((payload: any) => {
    if (!payload?.stage) {
      return;
    }

    let updatedStates: any[] = [];

    setStages(prev => {
      const baseline = prev.length ? prev : normalizeProgressStates();
      const updated = baseline.map(stage => {
        if (stage.key !== payload.stage) {
          return stage;
        }

        const progressValue = typeof payload.progress === 'number'
          ? payload.progress
          : stage.progress || 0;
        const isComplete = progressValue >= 100;
        const hasStarted = progressValue > 0;

        return {
          ...stage,
          progress: progressValue,
          status: isComplete ? 'completed' : hasStarted ? 'running' : stage.status,
          started_at: stage.started_at || payload.timestamp || null,
          completed_at: isComplete ? (payload.timestamp || stage.completed_at || null) : stage.completed_at || null,
        };
      });

      updatedStates = updated;
      return updated;
    });

    if (payload.details) {
      setStageDetails(prev => ({
        ...prev,
        [payload.stage]: {
          ...(prev[payload.stage] || {}),
          ...payload.details,
        },
      }));
    }

    if (updatedStates.length) {
      const progressValue = calculateWeightedProgress(updatedStates);
      setProject(prev => (
        prev
          ? { ...prev, progress: progressValue, progress_states: updatedStates }
          : prev
      ));

      updateTimeStats({ start_time: projectStartTimeRef.current, progress: progressValue });
    }
  }, [updateTimeStats]);

  const handleLogMessage = useCallback((payload: any) => {
    if (!payload?.message) {
      return;
    }

    const line = payload.timestamp ? `[${payload.timestamp}] ${payload.message}` : payload.message;
    setLogs(prev => {
      const next = [...prev, line];
      if (next.length > MAX_LOG_LINES) {
        return next.slice(-MAX_LOG_LINES);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    websocket.subscribeToProject(projectId);

    const unsubscribeStatus = websocket.on('project_status', handleProjectStatus);
    const unsubscribeStage = websocket.on('stage_progress', handleStageProgress);
    const unsubscribeLog = websocket.on('log_message', handleLogMessage);

    return () => {
      unsubscribeStatus();
      unsubscribeStage();
      unsubscribeLog();
      websocket.unsubscribeFromProject(projectId);
    };
  }, [projectId, handleProjectStatus, handleStageProgress, handleLogMessage]);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    loadProject();
    loadFramePreviews();
  }, [projectId, loadProject, loadFramePreviews]);

  useEffect(() => {
    if (project?.status !== 'processing') {
      return;
    }

    const interval = setInterval(() => {
      loadProject();
      loadFramePreviews();
    }, 5000);

    return () => clearInterval(interval);
  }, [project?.status, loadProject, loadFramePreviews]);

  // Keyboard navigation for image preview
  useEffect(() => {
    if (!showImagePreview) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowImagePreview(false);
      } else if (e.key === 'ArrowLeft') {
        setPreviewImageIndex((prev) => (prev > 0 ? prev - 1 : framePreview.length - 1));
      } else if (e.key === 'ArrowRight') {
        setPreviewImageIndex((prev) => (prev < framePreview.length - 1 ? prev + 1 : 0));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showImagePreview, framePreview.length]);

  // Auto-scroll logs to bottom when new logs arrive
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleRetry = async (fromStage?: string) => {
    try {
      // Build params object for retry
      const params: any = {};

      // Add quality_mode for all stages (affects COLMAP and OpenSplat config)
      if (retryParams.quality_mode) {
        params.quality_mode = retryParams.quality_mode;
      }

      // Add parameters if retrying from video_extraction stage
      if (fromStage === 'video_extraction') {
        if (retryParams.colmap_resolution) {
          params.colmap_resolution = retryParams.colmap_resolution;
        }
        if (retryParams.replacement_search_radius) {
          params.replacement_search_radius = parseInt(retryParams.replacement_search_radius);
        }
        if (retryParams.use_separate_training_images) {
          params.use_separate_training_images = true;
          if (retryParams.training_resolution) {
            params.training_resolution = retryParams.training_resolution;
          }
        }
      }

      // Add parameters if retrying from COLMAP Feature Extraction stage
      if (fromStage === 'feature_extraction') {
        if (retryParams.max_num_features) {
          params.max_num_features = parseInt(retryParams.max_num_features);
        }
        if (retryParams.max_image_size) {
          params.max_image_size = parseInt(retryParams.max_image_size);
        }
      }

      // Add parameters if retrying from COLMAP Feature Matching stage
      if (fromStage === 'feature_matching') {
        if (retryParams.max_num_matches) {
          params.max_num_matches = parseInt(retryParams.max_num_matches);
        }
        if (retryParams.sequential_overlap) {
          params.sequential_overlap = parseInt(retryParams.sequential_overlap);
        }
      }

      // Add parameters if retrying from COLMAP Sparse Reconstruction stage
      if (fromStage === 'sparse_reconstruction') {
        if (retryParams.min_num_matches) {
          params.min_num_matches = parseInt(retryParams.min_num_matches);
        }
        if (retryParams.max_num_models) {
          params.max_num_models = parseInt(retryParams.max_num_models);
        }
      }

      // Add parameters if retrying from gaussian_splatting stage
      if (fromStage === 'gaussian_splatting') {
        if (retryParams.iterations) {
          params.iterations = parseInt(retryParams.iterations);
        }
        if (retryParams.learning_rate) {
          params.learning_rate = parseFloat(retryParams.learning_rate);
        }
        // Add training images option
        if (retryParams.use_separate_training_images) {
          params.use_separate_training_images = true;
          if (retryParams.training_resolution) {
            params.training_resolution = retryParams.training_resolution;
          }
        }
      }

      await api.retryProject(projectId, fromStage, params);
      setShowRetryModal(false);
      // Reset params after successful retry
      setRetryParams({
        quality_mode: '',
        iterations: '',
        learning_rate: '',
        max_num_features: '',
        max_image_size: '',
        max_num_matches: '',
        sequential_overlap: '',
        min_num_matches: '',
        max_num_models: '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        replacement_search_radius: '',
      });
      await loadProject();
    } catch (err) {
      alert('Failed to retry processing');
    }
  };

  const handleDownloadLogs = () => {
    if (logs.length === 0) return;
    const logContent = logs.join('\n');
    const blob = new Blob([logContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project?.metadata?.name || 'project'}_logs_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const openRetryModal = () => {
    // Find the first failed or incomplete stage as default
    const failedStage = stages.find(s => isErrorStatus(s.status));
    const lastCompletedStage = stages.filter(s => s.status === 'completed').pop();

    if (failedStage) {
      setSelectedRetryStage(failedStage.key);
    } else if (lastCompletedStage) {
      // Start from the stage after the last completed one
      const stageIndex = PIPELINE_STAGES.findIndex(s => s.key === lastCompletedStage.key);
      if (stageIndex >= 0 && stageIndex < PIPELINE_STAGES.length - 1) {
        setSelectedRetryStage(PIPELINE_STAGES[stageIndex + 1].key);
      } else {
        setSelectedRetryStage('ingest');
      }
    } else {
      setSelectedRetryStage('ingest');
    }

    // Load current config values as defaults
    if (project) {
      setRetryParams({
        quality_mode: (project as any).quality_mode || '',
        iterations: (project as any).iterations?.toString() || '',
        learning_rate: '',
        max_num_features: '',
        max_image_size: '',
        max_num_matches: '',
        sequential_overlap: '',
        min_num_matches: '',
        max_num_models: '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        replacement_search_radius: project?.config?.replacement_search_radius?.toString() || '',
      });
    }

    setShowRetryModal(true);
  };

  const handleDownload = async () => {
    // Load PLY files and show download modal
    setLoadingPlyFiles(true);
    setShowDownloadModal(true);
    
    try {
      const response = await api.getPlyFiles(projectId);
      setPlyFiles(response.ply_files);
    } catch (err) {
      console.error('Failed to load PLY files:', err);
      // Fallback to single download
      const downloadUrl = api.getDownloadUrl(projectId);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${project?.metadata?.name || 'model'}_${projectId.slice(0, 8)}.ply`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setShowDownloadModal(false);
    } finally {
      setLoadingPlyFiles(false);
    }
  };

  const downloadPlyFile = (filename: string) => {
    const downloadUrl = api.getDownloadUrl(projectId, filename);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatPlyDate = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleString('th-TH', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getQualityBadgeColor = (quality: string): string => {
    switch (quality) {
      case 'fast': return 'bg-gray-100 text-gray-700';
      case 'balanced': return 'bg-blue-100 text-blue-700';
      case 'high': return 'bg-green-100 text-green-700';
      case 'ultra': return 'bg-purple-100 text-purple-700';
      case 'professional': return 'bg-orange-100 text-orange-700';
      case 'ultra_professional': return 'bg-red-100 text-red-700';
      default: return 'bg-gray-100 text-gray-600';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'queued':
        return <Clock className="h-8 w-8 text-gray-500" />;
      case 'processing':
        return <Loader className="h-8 w-8 animate-spin" style={{ color: 'var(--processing-text)' }} />;
      case 'completed':
        return <CheckCircle className="h-8 w-8" style={{ color: 'var(--success-icon)' }} />;
      case 'failed':
        return <XCircle className="h-8 w-8" style={{ color: 'var(--error-icon)' }} />;
      case 'cancelled':
        return <AlertTriangle className="h-8 w-8" style={{ color: 'var(--warning-text)' }} />;
      default:
        return <Clock className="h-8 w-8 text-gray-500" />;
    }
  };

  const getStageIcon = (stage: any) => {
    if (stage.status === 'completed') {
      return <CheckCircle className="h-5 w-5 text-green-500" />;
    } else if (stage.status === 'running') {
      return <Loader className="h-5 w-5 text-blue-500 animate-spin" />;
    } else if (stage.status === 'failed') {
      return <XCircle className="h-5 w-5 text-red-500" />;
    } else if (stage.status === 'cancelled') {
      return <AlertTriangle className="h-5 w-5 text-amber-500" />;
    } else {
      return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStageProgress = (stage: any) => {
    return stage.progress || 0;
  };

  const getCurrentStage = () => {
    return stages.find(s => s.status === 'running') || stages.find(s => s.status === 'pending');
  };

  const overallProgress = calculateWeightedProgress(stages);
  const canRetryProject = isErrorStatus(project?.status);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="h-8 w-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <div className="text-center">
          <h2 className="text-2xl font-semibold text-gray-900 mb-2">Project Not Found</h2>
          <button
            onClick={() => router.push('/projects')}
            className="inline-flex items-center px-4 py-2 text-sm font-medium text-blue-600 hover:text-blue-500"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Projects
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-white">
      <div className={`flex-1 overflow-y-auto transition-all duration-300 ${showLogSidebar ? 'pb-[45vh]' : 'pb-0'}`}>
        <div className="max-w-7xl mx-auto p-8">
          <Breadcrumbs items={[
            { label: 'Projects', href: '/projects' },
            { label: project?.metadata?.name || 'Project Details' }
          ]} />

          {/* Compact Progress Header */}
          {project.status === 'processing' && (
            <div className="border border-gray-200 rounded-2xl p-6 mb-8">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-6">
                  <div className="text-4xl font-bold text-black">{overallProgress}%</div>
                  <div className="flex items-center space-x-4 text-sm text-gray-600">
                    <span>{timeStats.elapsedTime}</span>
                    <span className="text-gray-300">·</span>
                    <span>{timeStats.remainingTime} left</span>
                    <span className="text-gray-300">·</span>
                    <span>ETA {timeStats.eta}</span>
                  </div>
                </div>
                
                {/* Cancel Button */}
                <button
                  onClick={handleCancelProcessing}
                  className="inline-flex items-center px-4 py-2 border border-red-200 text-sm font-medium rounded-lg text-red-600 hover:bg-red-50 hover:border-red-300 transition-colors"
                >
                  <XCircle className="h-4 w-4 mr-2" />
                  ยกเลิก
                </button>
              </div>

              <div className="relative mb-3">
                <div className="w-full bg-gray-100 rounded-full h-1.5">
                  <div
                    className="bg-black h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${overallProgress}%` }}
                  />
                </div>
              </div>

              <div className="text-sm text-gray-500">
                {getCurrentStage() ? (getStageLabelForEngine(getCurrentStage()?.key || '', project?.config?.sfm_engine, project?.config?.feature_method) || PIPELINE_STAGES.find(s => s.key === getCurrentStage()?.key)?.label) : 'Initializing...'}
                {getCurrentStage()?.key === 'sparse_reconstruction' &&
                 (isGlobalSfmEngine(project?.config?.sfm_engine) || project?.config?.sfm_engine === 'fastmap') &&
                 stageDetails['sparse_reconstruction']?.text && (
                  <span className={`ml-2 ${project?.config?.sfm_engine === 'fastmap' ? 'text-purple-600' : 'text-blue-600'}`}>
                    • {stageDetails['sparse_reconstruction'].text}
                  </span>
                )}
              </div>

              {/* Sparse model inspection button */}
              {(() => {
                const sparseStage = stages.find(s => s.key === 'sparse_reconstruction');
                const featureExtractionStage = stages.find(s => s.key === 'feature_extraction');
                // Show button if feature extraction is completed (database exists)
                return (featureExtractionStage?.status === 'completed' || sparseStage?.status === 'completed') && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <button
                      onClick={() => router.push(`/camera-poses/${projectId}`)}
                      className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                    >
                      <Eye className="h-4 w-4 mr-2" />
                      ตรวจสอบ Sparse Model
                    </button>
                    <p className="text-xs text-gray-500 mt-2">เปิดหน้า Camera Poses เพื่อตรวจสอบผล {getSfmEngineCompactLabel(project?.config?.sfm_engine)} sparse reconstruction</p>
                  </div>
                );
              })()}
            </div>
          )}

          <div className="border border-gray-200 rounded-2xl mb-8">
            <div className="p-6 border-b border-gray-200">
              <div className="flex items-start justify-between">
                <div className="flex items-center space-x-4">
                  {getStatusIcon(project.status)}
                  <div>
                    <h1 className="text-2xl font-semibold text-black mb-2">{project.metadata?.name || 'Untitled Project'}</h1>
                    <div className="flex items-center space-x-4 text-sm text-gray-500">
                      <span>{project.file_count || 0} files</span>
                      <span className="text-gray-300">·</span>
                      <span>{project.input_type || 'unknown'}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  {project.status === 'completed' && (
                    <>
                      <button
                        onClick={() => router.push(`/viewer?project=${projectId}`)}
                        className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-black hover:bg-gray-800 transition-colors"
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        View 3D
                      </button>
                      <button
                        onClick={() => router.push(`/camera-poses/${projectId}`)}
                        className={`inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg transition-colors ${
                          project?.config?.sfm_engine === 'fastmap' ? 'text-purple-600 hover:bg-purple-50' : 'text-blue-600 hover:bg-blue-50'
                        }`}
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        {getSfmEngineCompactLabel(project?.config?.sfm_engine)}
                      </button>
                      <button
                        onClick={handleDownload}
                        className="inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg text-black hover:bg-gray-50 transition-colors"
                      >
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </button>
                      <button
                        onClick={openRetryModal}
                        className="inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg text-black hover:bg-gray-50 transition-colors"
                      >
                        <RefreshCw className="h-4 w-4 mr-2" />
                        Retry
                      </button>
                    </>
                  )}
                  {canRetryProject && (
                    <button
                      onClick={openRetryModal}
                      className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-black hover:bg-gray-800 transition-colors"
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Retry
                    </button>
                  )}
                  <button
                    onClick={handleDelete}
                    className="inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg text-gray-600 hover:text-red-600 hover:border-red-200 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-8">
              {framework && (
                <div className="border border-gray-200 rounded-2xl p-6 bg-gray-50/70">
                  <div className="flex items-start justify-between gap-4 mb-5">
                    <div>
                      <h3 className="text-sm font-medium text-black">Reconstruction Framework</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        Dynamic policy state from the backend heuristic engine and pair-geometry refinement.
                      </p>
                    </div>
                    {framework.orbit_safe_profile && (
                      <span className="inline-flex items-center rounded-full border border-gray-300 px-3 py-1 text-xs font-medium text-black bg-white">
                        {framework.orbit_safe_profile}
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Pipeline</p>
                      <p className="text-sm font-medium text-black">{getSfmEngineLabel(framework.sfm_engine || project?.config?.sfm_engine) || '--'} / {framework.feature_method || project?.config?.feature_method || '--'}</p>
                      <p className="text-xs text-gray-500 mt-1">Phase: {framework.phase || '--'}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Matching Policy</p>
                      <p className="text-sm font-medium text-black">{getMatcherLabelWithMode(framework.matcher_type) || '--'}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        overlap {framework.matcher_params?.['SequentialMatching.overlap'] || '--'}
                        {' · '}
                        quadratic {framework.matcher_params?.['SequentialMatching.quadratic_overlap'] || '--'}
                      </p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Bridge Risk</p>
                      <p className="text-sm font-medium text-black">{framework.bridge_risk_score ?? '--'}</p>
                      <p className="text-xs text-gray-500 mt-1">
                        orbit-safe {framework.orbit_safe_mode ? 'enabled' : 'disabled'}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-3">Mapper Thresholds</p>
                      <div className="space-y-2 text-sm text-gray-700">
                        <div className="flex items-center justify-between"><span>Abs pose max error</span><span className="font-medium text-black">{framework.mapper_params?.['Mapper.abs_pose_max_error'] || '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Min inliers</span><span className="font-medium text-black">{framework.mapper_params?.['Mapper.abs_pose_min_num_inliers'] || '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Min inlier ratio</span><span className="font-medium text-black">{framework.mapper_params?.['Mapper.abs_pose_min_inlier_ratio'] || '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Max registration trials</span><span className="font-medium text-black">{framework.mapper_params?.['Mapper.max_reg_trials'] || '--'}</span></div>
                      </div>
                    </div>

                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-3">Pair Geometry</p>
                      <div className="space-y-2 text-sm text-gray-700">
                        <div className="flex items-center justify-between"><span>Bridge p10</span><span className="font-medium text-black">{framework.pair_geometry_stats?.bridge_p10 ?? '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Bridge min</span><span className="font-medium text-black">{framework.pair_geometry_stats?.bridge_min ?? '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Weak boundaries</span><span className="font-medium text-black">{framework.pair_geometry_stats?.weak_boundary_count ?? '--'}</span></div>
                        <div className="flex items-center justify-between"><span>Weak ratio</span><span className="font-medium text-black">{formatPercent(framework.pair_geometry_stats?.weak_boundary_ratio)}</span></div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {videoDiagnostics && (
                <div className="border border-gray-200 rounded-2xl p-6 bg-amber-50/40">
                  <div className="flex items-start justify-between gap-4 mb-5">
                    <div>
                      <h3 className="text-sm font-medium text-black">Video Extraction Diagnostics</h3>
                      <p className="text-sm text-gray-500 mt-1">
                        Smart neighbor replacement summary stored with the project for later review.
                      </p>
                    </div>
                    <span className="inline-flex items-center rounded-full border border-amber-200 px-3 py-1 text-xs font-medium text-amber-900 bg-white">
                      radius ±{videoDiagnostics.search_radius ?? project?.config?.replacement_search_radius ?? '--'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-5">
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Targets</p>
                      <p className="text-sm font-medium text-black">{videoDiagnostics.requested_targets ?? '--'}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Saved</p>
                      <p className="text-sm font-medium text-black">{videoDiagnostics.saved_frames ?? '--'}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Replaced</p>
                      <p className="text-sm font-medium text-black">{videoDiagnostics.replaced_targets ?? '--'}</p>
                    </div>
                    <div className="rounded-xl border border-gray-200 bg-white p-4">
                      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">Rejected Candidates</p>
                      <p className="text-sm font-medium text-black">{videoDiagnostics.rejected_candidates ?? '--'}</p>
                    </div>
                  </div>

                  <div className="rounded-xl border border-gray-200 bg-white p-4">
                    <p className="text-xs uppercase tracking-wide text-gray-500 mb-3">Recent Replacements</p>
                    <div className="space-y-2 text-sm text-gray-700">
                      {(videoDiagnostics.videos || [])
                        .flatMap((video) => (video.selections || []).map((selection) => ({ ...selection, filename: video.filename })))
                        .filter((selection) => selection.offset !== 0)
                        .slice(0, 12)
                        .map((selection, index) => (
                          <div key={`${selection.filename || 'video'}-${selection.target_index}-${index}`} className="flex items-center justify-between gap-4">
                            <span className="truncate">{selection.filename || 'video'}: target {selection.target_index} {'->'} {selection.selected_index}</span>
                            <span className="shrink-0 font-medium text-black">
                              offset {selection.offset > 0 ? `+${selection.offset}` : selection.offset} · sharpness {selection.sharpness}
                            </span>
                          </div>
                        ))}
                      {!(videoDiagnostics.videos || [])
                        .flatMap((video) => video.selections || [])
                        .some((selection) => selection.offset !== 0) && (
                        <p className="text-sm text-gray-500">No replacements were needed in the stored extraction summary.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Horizontal Stage Timeline */}
              <div>
                <h3 className="text-sm font-medium text-black mb-6">Processing Pipeline</h3>
                <div className="relative py-8">
                  {/* Timeline Line */}
                  <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-200 -translate-y-1/2" />

                  {/* Stage Nodes */}
                  <div className="relative flex justify-between items-start">
                    {PIPELINE_STAGES.map((stageConfig) => {
                      const stage = stages.find(s => s.key === stageConfig.key) || { key: stageConfig.key, status: 'pending', progress: 0 };
                      const progress = getStageProgress(stage);
                      const isCompleted = stage.status === 'completed';
                      const isRunning = stage.status === 'running';
                      const isFailed = stage.status === 'failed';
                      const isCancelled = stage.status === 'cancelled';
                      const isStageError = isFailed || isCancelled;
                      const errorBorderColor = isCancelled ? 'var(--warning-border)' : 'var(--error-border)';
                      const errorBgColor = isCancelled ? 'var(--warning-bg)' : 'var(--error-bg)';
                      const errorIconColor = isCancelled ? 'var(--warning-text)' : 'var(--error-icon)';

                      return (
                        <div key={stageConfig.key} className="flex flex-col items-center group relative" style={{ width: `${100 / PIPELINE_STAGES.length}%` }}>
                          {/* Stage Node - Clickable */}
                          <button
                            onClick={() => setExpandedStage(expandedStage === stageConfig.key ? null : stageConfig.key)}
                            className={`relative z-10 w-10 h-10 rounded-full flex items-center justify-center transition-all border-2 hover:scale-110 cursor-pointer ${
                              expandedStage === stageConfig.key ? 'ring-2 ring-offset-2' : ''
                            } ${
                              isCompleted ? '' :
                              isRunning ? 'bg-white' :
                              isStageError ? 'bg-white' :
                              'bg-white border-gray-200'
                            }`}
                            style={{
                              ...(isCompleted ? {
                                backgroundColor: 'var(--success-icon)',
                                borderColor: 'var(--success-icon)'
                              } : {}),
                              ...(isRunning ? {
                                borderColor: 'var(--processing-border)',
                                backgroundColor: 'var(--processing-bg)'
                              } : {}),
                              ...(isStageError ? {
                                borderColor: errorBorderColor,
                                backgroundColor: errorBgColor
                              } : {}),
                              ...(expandedStage === stageConfig.key ? {
                                ringColor: isCompleted ? 'var(--success-border)' :
                                          isStageError ? errorBorderColor :
                                          'var(--processing-border)'
                              } : {})
                            }}
                          >
                            {isCompleted ? (
                              <CheckCircle className="h-5 w-5 text-white" />
                            ) : isRunning ? (
                              <Loader className="h-5 w-5 animate-spin" style={{ color: 'var(--processing-text)' }} />
                            ) : isStageError ? (
                              isCancelled ? (
                                <AlertTriangle className="h-5 w-5" style={{ color: errorIconColor }} />
                              ) : (
                                <XCircle className="h-5 w-5" style={{ color: errorIconColor }} />
                              )
                            ) : (
                              <div className="w-2 h-2 rounded-full bg-gray-300" />
                            )}
                          </button>

                          {/* Stage Label */}
                          <div className="mt-4 text-center px-1 max-w-[120px]">
                            <p className={`text-xs leading-tight ${
                              isRunning ? 'font-medium text-black' :
                              isCompleted ? 'text-gray-600' :
                              isCancelled ? 'text-amber-600 font-medium' :
                              isStageError ? 'text-red-500 font-medium' :
                              'text-gray-400'
                            }`}>
                              {getStageLabelForEngine(stageConfig.key, project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig.label}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Stage Detail Panel - Expandable */}
                {expandedStage && (() => {
                  const stageConfig = PIPELINE_STAGES.find(s => s.key === expandedStage);
                  const stage = stages.find(s => s.key === expandedStage) || { key: expandedStage, status: 'pending', progress: 0 };
                  const progress = getStageProgress(stage);
                  const stageErrored = isErrorStatus(stage.status);
                  const stageCancelled = stage.status === 'cancelled';

                  return (
                    <div className="mt-6 border border-gray-200 rounded-xl p-6 bg-gray-50 animate-in slide-in-from-top duration-200">
                      <div className="flex items-start justify-between mb-4">
                        <div className="flex items-center space-x-3">
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                            {stageConfig?.Icon && <stageConfig.Icon className="h-5 w-5 text-gray-700" />}
                          </div>
                          <div>
                            <h4 className="text-lg font-semibold text-black">{getStageLabelForEngine(stageConfig?.key || '', project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig?.label}</h4>
                            <p className="text-sm text-gray-500 mt-1">
                              {stage.status === 'completed' ? '✓ Completed' :
                               stage.status === 'running' ? `⏳ In progress (${progress}%)` :
                               stageCancelled ? '⚠️ Cancelled' :
                               stageErrored ? '✗ Failed' :
                               '○ Pending'}
                            </p>
                          </div>
                        </div>
                        <button
                          onClick={() => setExpandedStage(null)}
                          className="text-gray-400 hover:text-black transition-colors"
                        >
                          <XCircle className="h-5 w-5" />
                        </button>
                      </div>

                      {/* Stage Details */}
                      <div className="space-y-4">
                        {/* Progress for running stage */}
                        {stage.status === 'running' && (
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium text-black">Progress</span>
                              <span className="text-sm text-gray-600">{progress}%</span>
                            </div>
                            <div className="bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-black h-2 rounded-full transition-all duration-300"
                                style={{ width: `${progress}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {/* Timestamps */}
                        {stage.started_at && (
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <p className="text-gray-500">Started</p>
                              <p className="text-black font-medium">{new Date(stage.started_at).toLocaleTimeString()}</p>
                            </div>
                            {stage.completed_at && (
                              <div>
                                <p className="text-gray-500">Completed</p>
                                <p className="text-black font-medium">{new Date(stage.completed_at).toLocaleTimeString()}</p>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Stage-specific details */}
                        {stageDetails[expandedStage]?.text && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-sm text-gray-600">{stageDetails[expandedStage].text}</p>
                            {stageDetails[expandedStage]?.subtext && (
                              <p className="text-xs text-gray-400 mt-1">{stageDetails[expandedStage].subtext}</p>
                            )}
                          </div>
                        )}

                        {/* Global SfM Sub-stages for sparse_reconstruction */}
                        {expandedStage === 'sparse_reconstruction' && isGlobalSfmEngine(project?.config?.sfm_engine) && stage.status === 'running' && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-xs font-medium text-gray-500 mb-3">Global SfM Pipeline Steps</p>
                            <div className="space-y-2">
                              {[
                                { key: 'preprocessing', icon: '🔧', label: 'Preprocessing', progress: 5 },
                                { key: 'view_graph_calibration', icon: '📊', label: 'View Graph Calibration', progress: 10 },
                                { key: 'relative_pose', icon: '📐', label: 'Relative Pose Estimation', progress: 20 },
                                { key: 'rotation_averaging', icon: '🔄', label: 'Rotation Averaging', progress: 35 },
                                { key: 'track_establishment', icon: '🔗', label: 'Track Establishment', progress: 50 },
                                { key: 'global_positioning', icon: '🌍', label: 'Global Positioning', progress: 65 },
                                { key: 'bundle_adjustment', icon: '⚡', label: 'Bundle Adjustment', progress: 85 },
                                { key: 'retriangulation', icon: '📐', label: 'Retriangulation', progress: 92 },
                                { key: 'postprocessing', icon: '🏁', label: 'Postprocessing', progress: 98 },
                              ].map((subStage) => {
                                const currentProgress = progress;
                                const isSubCompleted = currentProgress >= subStage.progress;
                                const isSubActive = currentProgress >= (subStage.progress - 10) && currentProgress < subStage.progress + 5;
                                return (
                                  <div key={subStage.key} className={`flex items-center space-x-2 text-xs ${isSubCompleted ? 'text-green-600' : isSubActive ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>
                                    <span>{isSubCompleted ? '✓' : isSubActive ? '▶' : '○'}</span>
                                    <span>{subStage.icon}</span>
                                    <span>{subStage.label}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* FastMap Sub-stages for sparse_reconstruction */}
                        {expandedStage === 'sparse_reconstruction' && project?.config?.sfm_engine === 'fastmap' && stage.status === 'running' && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-xs font-medium text-purple-600 mb-3">⚡ FastMap Pipeline Steps</p>
                            <div className="space-y-2">
                              {[
                                { key: 'focal_estimation', icon: '🔍', label: 'Focal Length Estimation', progress: 5 },
                                { key: 'fundamental', icon: '📐', label: 'Fundamental Matrix', progress: 15 },
                                { key: 'decompose', icon: '🧩', label: 'Essential Decomposition', progress: 25 },
                                { key: 'rotation', icon: '🔄', label: 'Global Rotation', progress: 40 },
                                { key: 'translation', icon: '📍', label: 'Global Translation', progress: 55 },
                                { key: 'tracks', icon: '🔗', label: 'Track Building', progress: 65 },
                                { key: 'epipolar', icon: '⚡', label: 'Epipolar Adjustment', progress: 80 },
                                { key: 'sparse', icon: '🏗️', label: 'Sparse Reconstruction', progress: 92 },
                                { key: 'output', icon: '💾', label: 'Writing Results', progress: 98 },
                              ].map((subStage) => {
                                const currentProgress = progress;
                                const isSubCompleted = currentProgress >= subStage.progress;
                                const isSubActive = currentProgress >= (subStage.progress - 10) && currentProgress < subStage.progress + 5;
                                return (
                                  <div key={subStage.key} className={`flex items-center space-x-2 text-xs ${isSubCompleted ? 'text-green-600' : isSubActive ? 'text-purple-600 font-medium' : 'text-gray-400'}`}>
                                    <span>{isSubCompleted ? '✓' : isSubActive ? '▶' : '○'}</span>
                                    <span>{subStage.icon}</span>
                                    <span>{subStage.label}</span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Error or cancellation state */}
                        {stageErrored && (
                          <div className="border-t border-gray-200 pt-4">
                            <div
                              className={`flex items-start space-x-2 p-3 rounded-lg ${
                                stageCancelled ? 'bg-amber-50 border border-amber-200' : 'bg-red-50 border border-red-200'
                              }`}
                            >
                              <AlertTriangle
                                className={`h-5 w-5 flex-shrink-0 mt-0.5 ${
                                  stageCancelled ? 'text-amber-600' : 'text-red-600'
                                }`}
                              />
                              <div>
                                <p className={`text-sm font-medium ${stageCancelled ? 'text-amber-800' : 'text-red-800'}`}>
                                  {stageCancelled ? 'Processing cancelled' : 'Error'}
                                </p>
                                <p className={`text-sm mt-1 ${stageCancelled ? 'text-amber-700' : 'text-red-600'}`}>
                                  {stageCancelled
                                    ? 'งานถูกยกเลิกแล้ว สามารถกด Retry เพื่อเริ่มจากขั้นนี้ใหม่ได้'
                                    : stage.error || 'ขั้นตอนนี้เกิดข้อผิดพลาด ตรวจสอบ log แล้วลอง Retry อีกครั้ง'}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Mesh Export Panels - Show for completed or failed projects */}
              {(project.status === 'completed' || project.status === 'failed') && (
                <div className="border-t border-gray-200 pt-6 space-y-6">
                  {/* List of exported meshes */}
                  <ExportedMeshesList projectId={projectId} />

                  {/* Mesh export panel */}
                  <MeshExportPanel projectId={projectId} projectStatus={project.status} />
                </div>
              )}

              {/* Frame Preview Section - Show All Images */}
              {framePreview.length > 0 && (
                <div className="border-t border-gray-200 pt-6">
                  <h3 className="text-sm font-medium text-black mb-4">
                    {hasSeparateTraining ? 'COLMAP Frames' : 'Frame Preview'} ({framePreview.length} images) 
                    <span className="text-gray-400 font-normal"> - คลิกเพื่อดูภาพขนาดใหญ่</span>
                    {hasSeparateTraining && <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">For Pose Estimation</span>}
                  </h3>
                  <div className="max-h-96 overflow-y-auto">
                    <div className="grid grid-cols-5 gap-3">
                      {framePreview.map((frame, index) => (
                        <div
                          key={index}
                          className="relative group flex-shrink-0 cursor-pointer"
                          onClick={() => {
                            setPreviewImageIndex(index);
                            setShowImagePreview(true);
                          }}
                        >
                          <img
                            src={frame.url}
                            alt={frame.name}
                            className="w-full h-24 object-cover rounded-lg border border-gray-200 hover:border-black hover:shadow-md transition-all"
                            loading="lazy"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 rounded-lg transition-all flex items-center justify-center">
                            <Eye className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 drop-shadow-lg transition-opacity" />
                          </div>
                          <div className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                            {index + 1}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* High-Res Training Frames Preview - Only show if separate training images exist */}
              {hasSeparateTraining && trainingFramePreview.length > 0 && (
                <div className="border-t border-gray-200 pt-6">
                  <h3 className="text-sm font-medium text-black mb-4">
                    Training Frames ({trainingFramePreview.length} images)
                    <span className="text-gray-400 font-normal"> - High resolution for 3DGS training</span>
                    <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded">High-Res</span>
                  </h3>
                  <div className="max-h-96 overflow-y-auto">
                    <div className="grid grid-cols-5 gap-3">
                      {trainingFramePreview.map((frame, index) => (
                        <div
                          key={index}
                          className="relative group flex-shrink-0 cursor-pointer"
                          onClick={() => {
                            // Open training frame in new tab for full resolution view
                            window.open(frame.url, '_blank');
                          }}
                        >
                          <img
                            src={frame.url}
                            alt={frame.name}
                            className="w-full h-24 object-cover rounded-lg border border-purple-200 hover:border-purple-500 hover:shadow-md transition-all"
                            loading="lazy"
                          />
                          <div className="absolute inset-0 bg-black/0 group-hover:bg-purple-500/10 rounded-lg transition-all flex items-center justify-center">
                            <Eye className="h-6 w-6 text-white opacity-0 group-hover:opacity-100 drop-shadow-lg transition-opacity" />
                          </div>
                          <div className="absolute bottom-1 right-1 bg-purple-600/80 text-white text-xs px-1.5 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity">
                            {index + 1}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Log Panel - Full Width Bottom */}
      <div className={`fixed bottom-0 left-0 right-0 bg-gray-950 border-t border-gray-800 transition-transform duration-300 ${
        showLogSidebar ? 'translate-y-0' : 'translate-y-full'
      } flex flex-col z-40`}
      style={{ height: '45vh', minHeight: '300px' }}>
        {/* Panel Header */}
        <div className="px-6 py-3 border-b border-gray-800 flex items-center justify-between flex-shrink-0 bg-gray-900">
          <div className="flex items-center gap-4">
            <h3 className="text-sm font-semibold text-gray-100 flex items-center gap-2">
              <Monitor className="h-4 w-4" />
              Activity Log
            </h3>
            {project?.status === 'processing' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
                Live Streaming
              </span>
            )}
            <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded">
              {logs.length.toLocaleString()} lines
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAutoScroll(!autoScroll)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
                autoScroll 
                  ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 border border-emerald-500/30' 
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800 border border-gray-700'
              }`}
              title={autoScroll ? 'Auto-scroll enabled' : 'Auto-scroll disabled'}
            >
              <ArrowDownToLine className="h-3.5 w-3.5" />
              {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
            </button>
            <button
              onClick={handleDownloadLogs}
              disabled={logs.length === 0}
              className="px-3 py-1.5 rounded-md text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed border border-gray-700 flex items-center gap-1.5"
              title="Download logs"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </button>
            <button
              onClick={() => setShowLogSidebar(false)}
              className="p-1.5 rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors ml-2"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Log Content - Full Width Scrollable */}
        <div className="flex-1 overflow-y-auto overflow-x-auto bg-gray-950 font-mono text-sm leading-relaxed">
          {logs.length > 0 ? (
            <div className="p-4 min-w-max">
              {logs.map((log, index) => (
                <div 
                  key={index} 
                  className="whitespace-pre text-gray-300 hover:text-white hover:bg-gray-900/70 transition-colors py-1 px-3 rounded border-l-2 border-transparent hover:border-gray-600"
                >
                  <span className="text-gray-600 select-none mr-4 inline-block w-16 text-right">{index + 1}</span>
                  {log}
                </div>
              ))}
              <div ref={logEndRef} className="h-4" />
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-600">
              <div className="text-center">
                <Monitor className="h-12 w-12 mx-auto mb-3 opacity-50" />
                <p className="text-lg">Waiting for logs...</p>
                <p className="text-sm text-gray-500 mt-1">Logs will appear here when processing starts</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {logs.length >= MAX_LOG_LINES && (
          <div className="px-6 py-2 border-t border-gray-800 bg-amber-900/20 text-xs text-amber-400 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Buffer limit reached ({MAX_LOG_LINES.toLocaleString()} lines). Older logs were removed.
          </div>
        )}
      </div>

      {!showLogSidebar && (
        <button
          onClick={() => setShowLogSidebar(true)}
          className="fixed bottom-6 right-6 bg-gray-900 text-white rounded-xl px-4 py-3 shadow-xl hover:bg-gray-800 transition-all z-30 flex items-center gap-2 border border-gray-700"
        >
          <Monitor className="h-5 w-5" />
          <span className="text-sm font-medium">Show Logs</span>
          {logs.length > 0 && (
            <span className="bg-emerald-500 text-white text-xs px-2 py-0.5 rounded-full">
              {logs.length}
            </span>
          )}
        </button>
      )}

      {/* Retry Modal */}
      {showRetryModal && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 backdrop-blur-sm p-4" onClick={() => setShowRetryModal(false)}>
          <div className="bg-white rounded-2xl max-w-md w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-8 pb-4 flex-shrink-0">
              <h3 className="text-xl font-semibold text-black mb-2">Retry Processing</h3>
              <p className="text-sm text-gray-500 mb-6">
                Select which stage to retry from. All subsequent stages will be re-run.
              </p>
            </div>

            <div className="px-8 overflow-y-auto flex-1">
              <div className="space-y-2 mb-6">
              {PIPELINE_STAGES.map((stage) => {
                const stageState = stages.find(s => s.key === stage.key);
                const isCompleted = stageState?.status === 'completed';
                const isErrored = isErrorStatus(stageState?.status);
                const isCancelledStage = stageState?.status === 'cancelled';

                return (
                  <label
                    key={stage.key}
                    className={`flex items-center p-4 border rounded-xl cursor-pointer transition-all ${
                      selectedRetryStage === stage.key
                        ? 'border-black bg-gray-50'
                        : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <input
                      type="radio"
                      name="retry-stage"
                      value={stage.key}
                      checked={selectedRetryStage === stage.key}
                      onChange={(e) => setSelectedRetryStage(e.target.value)}
                      className="mr-4 w-4 h-4 text-black border-gray-300 focus:ring-black"
                    />
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <stage.Icon className="h-5 w-5 text-gray-600" />
                        <span className="text-sm font-medium text-black">{getStageLabelForEngine(stage.key, project?.config?.sfm_engine, project?.config?.feature_method) || stage.label}</span>
                      </div>
                      <div className="flex items-center space-x-2 mt-1.5 ml-8">
                        {isCompleted && (
                          <span className="text-xs text-gray-500 flex items-center">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Completed
                          </span>
                        )}
                        {isErrored && (
                          <span className={`text-xs flex items-center ${isCancelledStage ? 'text-amber-600' : 'text-red-500'}`}>
                            {isCancelledStage ? (
                              <AlertTriangle className="h-3 w-3 mr-1" />
                            ) : (
                              <XCircle className="h-3 w-3 mr-1" />
                            )}
                            {isCancelledStage ? 'Cancelled' : 'Failed'}
                          </span>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            {/* Video Extraction Parameters Form - Show only for video_extraction stage */}
            {selectedRetryStage === 'video_extraction' && (
              <div className="mb-6 p-4 bg-orange-50 border border-orange-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่าการแยกเฟรม (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      COLMAP Resolution (สำหรับ Pose Estimation)
                    </label>
                    <select
                      value={retryParams.colmap_resolution}
                      onChange={(e) => setRetryParams({...retryParams, colmap_resolution: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="720p">720p (1280×720) - Fast</option>
                      <option value="1080p">1080p (1920×1080) - Standard</option>
                      <option value="2K">2K (2560×1440) - Recommended</option>
                      <option value="4K">4K (3840×2160) - High Quality</option>
                      <option value="8K">8K (7680×4320) - Maximum</option>
                      <option value="original">Original Resolution</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Smart Replacement Radius
                    </label>
                    <select
                      value={retryParams.replacement_search_radius}
                      onChange={(e) => setRetryParams({...retryParams, replacement_search_radius: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="2">±2 frames</option>
                      <option value="4">±4 frames - Recommended</option>
                      <option value="6">±6 frames</option>
                      <option value="8">±8 frames</option>
                      <option value="12">±12 frames</option>
                    </select>
                    <p className="text-xs text-gray-400 mt-1">ขยายช่วงค้นหาเฟรมรอบ target เพื่อแทนเฟรมเบลอด้วยเฟรมที่คมกว่า</p>
                  </div>

                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      id="use_separate_training"
                      checked={retryParams.use_separate_training_images}
                      onChange={(e) => setRetryParams({...retryParams, use_separate_training_images: e.target.checked})}
                      className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                    />
                    <label htmlFor="use_separate_training" className="ml-2 text-xs font-medium text-gray-700">
                      ใช้ภาพความละเอียดสูงแยกสำหรับ Training
                    </label>
                  </div>

                  {retryParams.use_separate_training_images && (
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-1">
                        Training Resolution (สำหรับ 3DGS Training)
                      </label>
                      <select
                        value={retryParams.training_resolution}
                        onChange={(e) => setRetryParams({...retryParams, training_resolution: e.target.value})}
                        className="w-full px-3 py-2 border border-purple-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                      >
                        <option value="">ใช้ค่าเดิม</option>
                        <option value="1080p">1080p (1920×1080)</option>
                        <option value="2K">2K (2560×1440)</option>
                        <option value="4K">4K (3840×2160) - Recommended</option>
                        <option value="8K">8K (7680×4320) - Maximum</option>
                        <option value="original">Original Resolution</option>
                      </select>
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  💡 ภาพความละเอียดต่ำช่วยให้ COLMAP ทำงานเร็วขึ้น แล้วใช้ภาพ high-res สำหรับ training
                </p>
              </div>
            )}

            {/* Training Parameters Form - Show only for gaussian_splatting stage */}
            {selectedRetryStage === 'gaussian_splatting' && (
              <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่าการเทรน (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Quality Mode
                    </label>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="fast">Fast (500 iterations)</option>
                      <option value="balanced">Balanced (7000 iterations)</option>
                      <option value="hard">Hard (5000 iterations, coverage-first)</option>
                      <option value="high">High (7000 iterations)</option>
                      <option value="ultra">Ultra (15000 iterations)</option>
                      <option value="professional">Professional (30000 iterations)</option>
                      <option value="ultra_professional">Ultra Professional (60000 iterations)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Iterations (จำนวนรอบการเทรน)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 7000"
                      value={retryParams.iterations}
                      onChange={(e) => setRetryParams({...retryParams, iterations: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Learning Rate (ค่าการเรียนรู้)
                    </label>
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="เช่น 0.0025"
                      value={retryParams.learning_rate}
                      onChange={(e) => setRetryParams({...retryParams, learning_rate: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                  </div>

                  {/* Training Images Option */}
                  <div className="pt-2 border-t border-blue-200">
                    <div className="flex items-center mb-2">
                      <input
                        type="checkbox"
                        id="gs_use_separate_training"
                        checked={retryParams.use_separate_training_images}
                        onChange={(e) => setRetryParams({...retryParams, use_separate_training_images: e.target.checked})}
                        className="w-4 h-4 text-purple-600 border-gray-300 rounded focus:ring-purple-500"
                      />
                      <label htmlFor="gs_use_separate_training" className="ml-2 text-xs font-medium text-gray-700">
                        ใช้ภาพความละเอียดสูงแยกสำหรับ Training
                      </label>
                    </div>

                    {retryParams.use_separate_training_images && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Training Resolution
                        </label>
                        <select
                          value={retryParams.training_resolution}
                          onChange={(e) => setRetryParams({...retryParams, training_resolution: e.target.value})}
                          className="w-full px-3 py-2 border border-purple-300 rounded-lg text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
                        >
                          <option value="">ใช้ค่าเดิม</option>
                          <option value="1080p">1080p (1920×1080)</option>
                          <option value="2K">2K (2560×1440)</option>
                          <option value="4K">4K (3840×2160) - Recommended</option>
                          <option value="8K">8K (7680×4320) - Maximum</option>
                          <option value="original">Original Resolution</option>
                        </select>
                        <p className="text-xs text-purple-600 mt-1">
                          ⚠️ ถ้าไม่มี training_images จะถอดจาก video ให้อัตโนมัติ
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  💡 ทิ้งค่าว่างเพื่อใช้ค่าเดิมต่อ หรือกรอกค่าใหม่เพื่อปรับเปลี่ยน
                </p>
              </div>
            )}

            {/* Feature Extraction Parameters Form */}
            {selectedRetryStage === 'feature_extraction' && (
              <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Feature Extraction (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Quality Mode
                    </label>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="fast">Fast</option>
                      <option value="balanced">Balanced</option>
                      <option value="high">High</option>
                      <option value="ultra">Ultra</option>
                      <option value="professional">Professional</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Max Num Features (จำนวน features สูงสุดต่อภาพ)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 32768"
                      value={retryParams.max_num_features}
                      onChange={(e) => setRetryParams({...retryParams, max_num_features: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 32768 (สำหรับภาพ 4K)</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Max Image Size (ขนาดภาพสูงสุด pixels)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 4160"
                      value={retryParams.max_image_size}
                      onChange={(e) => setRetryParams({...retryParams, max_image_size: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 4160</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  💡 การเพิ่ม features จะช่วยให้ได้ผลลัพธ์ดีขึ้น แต่ใช้เวลานานขึ้น
                </p>
              </div>
            )}

            {/* Feature Matching Parameters Form */}
            {selectedRetryStage === 'feature_matching' && (
              <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Feature Matching (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Quality Mode
                    </label>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="fast">Fast</option>
                      <option value="balanced">Balanced</option>
                      <option value="hard">Hard (coverage-first)</option>
                      <option value="high">High</option>
                      <option value="ultra">Ultra</option>
                      <option value="robust">Robust (สำหรับ dataset ยาก)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Max Num Matches (จำนวน matches สูงสุด)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 45960"
                      value={retryParams.max_num_matches}
                      onChange={(e) => setRetryParams({...retryParams, max_num_matches: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 45960 (ปลอดภัยสำหรับ GPU)</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Sequential Overlap (จำนวนภาพที่ match กัน)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 20"
                      value={retryParams.sequential_overlap}
                      onChange={(e) => setRetryParams({...retryParams, sequential_overlap: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 20 (เพิ่มเพื่อ coverage ดีขึ้น)</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  💡 หาก GPU หน่วยความจำเต็ม ลอง max_num_matches ลดลง
                </p>
              </div>
            )}

            {/* Sparse Reconstruction Parameters Form */}
            {selectedRetryStage === 'sparse_reconstruction' && (
              <div className="mb-6 p-4 bg-purple-50 border border-purple-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Sparse Reconstruction (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Quality Mode
                    </label>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="fast">Fast</option>
                      <option value="balanced">Balanced</option>
                      <option value="hard">Hard (coverage-first)</option>
                      <option value="high">High</option>
                      <option value="ultra">Ultra</option>
                      <option value="robust">Robust (สำหรับ dataset ยาก)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Min Num Matches (จำนวน matches ขั้นต่ำในการ register)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 8"
                      value={retryParams.min_num_matches}
                      onChange={(e) => setRetryParams({...retryParams, min_num_matches: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 8 (ลดลงเพื่อ register ภาพมากขึ้น)</p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">
                      Max Num Models (จำนวน models สูงสุดที่สร้าง)
                    </label>
                    <input
                      type="number"
                      placeholder="เช่น 50"
                      value={retryParams.max_num_models}
                      onChange={(e) => setRetryParams({...retryParams, max_num_models: e.target.value})}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-black focus:border-black"
                    />
                    <p className="text-xs text-gray-400 mt-1">ค่าเริ่มต้น: 50 (เพิ่มเพื่อลองหลาย models)</p>
                  </div>
                </div>
                <p className="text-xs text-gray-500 mt-3">
                  💡 ลด min_num_matches เพื่อช่วยให้ภาพที่ยากถูก register ได้
                </p>
              </div>
            )}

            {/* Model Conversion - No params needed */}
            {selectedRetryStage === 'model_conversion' && (
              <div className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-xl">
                <h4 className="text-sm font-semibold text-black mb-3 flex items-center">
                  <Info className="h-4 w-4 mr-2" />
                  Model Conversion
                </h4>
                <p className="text-sm text-gray-600">
                  ขั้นตอนนี้จะเลือก sparse model ที่ดีที่สุดโดยอัตโนมัติ ไม่มีพารามิเตอร์ให้ปรับ
                </p>
              </div>
            )}
            </div>

            <div className="p-8 pt-4 flex-shrink-0 border-t border-gray-200">
              <div className="flex space-x-3">
                <button
                  onClick={() => setShowRetryModal(false)}
                  className="flex-1 px-4 py-3 border border-gray-200 text-sm font-medium rounded-xl text-black hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleRetry(selectedRetryStage)}
                  className="flex-1 px-4 py-3 text-sm font-medium rounded-xl text-white bg-black hover:bg-gray-800 transition-colors"
                >
                  Start Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Download PLY Files Modal */}
      {showDownloadModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-6 space-y-4 max-h-[80vh] overflow-hidden flex flex-col">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-semibold text-black flex items-center">
                <FileBox className="h-6 w-6 mr-2 text-blue-600" />
                ดาวน์โหลดโมเดล 3D Gaussian Splatting
              </h3>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X className="h-6 w-6" />
              </button>
            </div>

            {loadingPlyFiles ? (
              <div className="flex items-center justify-center py-12">
                <Loader className="h-8 w-8 animate-spin text-blue-600" />
                <span className="ml-3 text-gray-600">กำลังโหลดรายการไฟล์...</span>
              </div>
            ) : plyFiles.length === 0 ? (
              <div className="text-center py-12">
                <FileBox className="h-12 w-12 mx-auto text-gray-400 mb-3" />
                <p className="text-gray-600">ยังไม่มีไฟล์ PLY</p>
                <p className="text-sm text-gray-500">รอให้การประมวลผลเสร็จสิ้นก่อน</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto space-y-3 pr-2">
                <p className="text-sm text-gray-600 mb-4">
                  มี {plyFiles.length} ไฟล์ PLY พร้อมดาวน์โหลด (เรียงตามเวลาสร้างล่าสุด)
                </p>
                
                {plyFiles.map((file, index) => (
                  <div
                    key={file.filename}
                    className={`p-4 rounded-xl border transition-all hover:shadow-md ${
                      index === 0 
                        ? 'bg-gradient-to-r from-blue-50 to-indigo-50 border-blue-200' 
                        : 'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {index === 0 && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-blue-600 text-white rounded-full">
                              ล่าสุด
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${getQualityBadgeColor(file.quality_mode)}`}>
                            {file.quality_mode}
                          </span>
                          {file.iterations > 0 && (
                            <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">
                              {file.iterations.toLocaleString()} iterations
                            </span>
                          )}
                        </div>
                        <p className="text-sm font-medium text-gray-900 truncate" title={file.filename}>
                          {file.filename}
                        </p>
                        <div className="flex items-center gap-4 mt-1 text-xs text-gray-500">
                          <span>{formatFileSize(file.size)}</span>
                          <span>{formatPlyDate(file.created_at)}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => downloadPlyFile(file.filename)}
                        className={`ml-4 px-4 py-2 text-sm font-medium rounded-lg transition-colors flex items-center ${
                          index === 0
                            ? 'bg-blue-600 text-white hover:bg-blue-700'
                            : 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        <Download className="h-4 w-4 mr-1" />
                        Download
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-between items-center pt-4 border-t">
              <p className="text-xs text-gray-500">
                💡 ไฟล์ที่ retry ใหม่จะแสดงด้านบน
              </p>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="px-6 py-2 text-sm font-medium rounded-lg text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Dialog */}
      {showImagePreview && framePreview.length > 0 && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50"
          onClick={() => setShowImagePreview(false)}
        >
          {/* Close Button */}
          <button
            onClick={() => setShowImagePreview(false)}
            className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors z-10"
          >
            <X className="h-8 w-8" />
          </button>

          {/* Image Counter */}
          <div className="absolute top-4 left-1/2 -translate-x-1/2 text-white/80 text-sm font-medium bg-black/40 px-4 py-2 rounded-full">
            {previewImageIndex + 1} / {framePreview.length}
          </div>

          {/* Previous Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImageIndex((prev) => (prev > 0 ? prev - 1 : framePreview.length - 1));
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white p-3 rounded-full transition-colors"
          >
            <ChevronLeft className="h-8 w-8" />
          </button>

          {/* Main Image */}
          <div
            className="max-w-[90vw] max-h-[85vh] flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={framePreview[previewImageIndex]?.url}
              alt={framePreview[previewImageIndex]?.name || `Frame ${previewImageIndex + 1}`}
              className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl"
            />
          </div>

          {/* Next Button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImageIndex((prev) => (prev < framePreview.length - 1 ? prev + 1 : 0));
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/40 hover:bg-black/60 text-white p-3 rounded-full transition-colors"
          >
            <ChevronRight className="h-8 w-8" />
          </button>

          {/* Thumbnail Strip */}
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[90vw] overflow-x-auto">
            <div className="flex space-x-2 p-2 bg-black/40 rounded-xl">
              {framePreview.map((frame, index) => (
                <button
                  key={index}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewImageIndex(index);
                  }}
                  className={`flex-shrink-0 w-16 h-12 rounded-md overflow-hidden transition-all ${
                    index === previewImageIndex
                      ? 'ring-2 ring-white scale-110'
                      : 'opacity-60 hover:opacity-100'
                  }`}
                >
                  <img
                    src={frame.url}
                    alt={frame.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>
          </div>

          {/* Keyboard Navigation Hint */}
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-white/50 text-xs">
            กดลูกศร ← → เพื่อเลื่อนดูภาพ หรือกด ESC เพื่อปิด
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
