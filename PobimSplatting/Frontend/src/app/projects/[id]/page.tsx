'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
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
  FileVideo,
  Image,
  Info,
  Zap,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  X,
  FileBox,
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

const isErrorStatus = (status?: string | null): boolean =>
  status === 'failed' || status === 'cancelled';

const MAX_LOG_LINES_IN_UI = 1200;

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
  logTail.map(entry => {
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

const extractLogTimestamp = (line: string): number | null => {
  const match = line.match(/^\[([^\]]+)\]/);
  if (!match) {
    return null;
  }
  const parsed = Date.parse(match[1]);
  return Number.isNaN(parsed) ? null : parsed;
};

const groupLogsByStage = (logs: string[], states: any[] = []) => {
  const groups = [
    {
      key: 'ungrouped',
      label: 'General',
      logs: [] as string[],
    },
    ...PIPELINE_STAGES.map(stage => ({
      key: stage.key,
      label: stage.label,
      logs: [] as string[],
    })),
  ];

  const activeStates = states.filter(state => state.started_at);
  for (const line of logs) {
    const timestamp = extractLogTimestamp(line);
    if (timestamp === null) {
      groups[0].logs.push(line);
      continue;
    }

    const matchedState = activeStates.find(state => {
      const started = state.started_at ? Date.parse(state.started_at) : Number.NaN;
      const completed = state.completed_at ? Date.parse(state.completed_at) : Number.POSITIVE_INFINITY;
      return !Number.isNaN(started) && timestamp >= started && timestamp <= completed;
    });

    const targetKey = matchedState?.key || 'ungrouped';
    const targetGroup = groups.find(group => group.key === targetKey);
    if (targetGroup) {
      targetGroup.logs.push(line);
    } else {
      groups[0].logs.push(line);
    }
  }

  return groups.filter(group => group.logs.length > 0);
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
  const [logMeta, setLogMeta] = useState({
    total: 0,
    visible: 0,
    truncated: false,
  });
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
  const stageLogsRef = useRef<HTMLDivElement>(null);
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
    extraction_mode: '',
    max_frames: '',
    target_fps: '',
    colmap_resolution: '',
    training_resolution: '',
    use_separate_training_images: false,
    smart_frame_selection: true,
    oversample_factor: '',
    replacement_search_radius: '',
    ffmpeg_cpu_workers: '',
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
  const smartFrameSelectionEnabled = project?.config?.smart_frame_selection !== false;
  const oversampleFactor = videoDiagnostics?.oversample_factor ?? project?.config?.oversample_factor ?? null;
  const effectiveSearchWindow = videoDiagnostics?.search_radius ?? project?.config?.replacement_search_radius ?? null;
  const extractionSummary = project?.config?.extraction_mode === 'fps'
    ? `${project?.config?.target_fps ?? '--'} FPS`
    : project?.config?.extraction_mode === 'target_count'
      ? `${project?.config?.max_frames ?? '--'} target`
      : `${project?.config?.max_frames ?? '--'} max`;
  const videoExtractionDetail = stageDetails['video_extraction'];
  const videoExtractionFramesDone = videoExtractionDetail?.current_item ?? videoDiagnostics?.candidate_count ?? videoDiagnostics?.saved_frames ?? null;
  const videoExtractionFramesTotal = videoExtractionDetail?.total_items ?? videoDiagnostics?.candidate_count ?? videoDiagnostics?.requested_targets ?? null;
  const logGroups = useMemo(() => groupLogsByStage(logs, stages), [logs, stages]);
  const stageLogs = useMemo(() => {
    if (!expandedStage) {
      return [] as string[];
    }
    return logGroups.find(group => group.key === expandedStage)?.logs ?? [];
  }, [logGroups, expandedStage]);

  // Auto-expand the running stage
  useEffect(() => {
    const runningStage = stages.find(s => s.status === 'running');
    if (runningStage && expandedStage !== runningStage.key) {
      setExpandedStage(runningStage.key);
    }
  }, [stages, expandedStage]);

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
      const logLines = data.recent_logs || [];

      if (data.start_time) {
        projectStartTimeRef.current = data.start_time;
      }

      setProject({ ...data, id: projectId, progress: progressValue });
      setStages(normalizedStages);
      setStageDetails(data.stage_details || {});
      setLogs(logLines);
      setLogMeta({
        total: data.log_count || logLines.length,
        visible: data.log_visible_count || logLines.length,
        truncated: Boolean(data.log_truncated),
      });
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
      ? payload.recent_logs
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
    setLogMeta({
      total: payload.log_count || logLines.length,
      visible: payload.log_visible_count || logLines.length,
      truncated: Boolean(payload.log_truncated),
    });

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
      if (next.length > MAX_LOG_LINES_IN_UI) {
        return next.slice(-MAX_LOG_LINES_IN_UI);
      }
      return next;
    });
    setLogMeta(prev => {
      const nextTotal = (prev.total || 0) + 1;
      const nextVisible = Math.min(nextTotal, MAX_LOG_LINES_IN_UI);
      return {
        total: nextTotal,
        visible: nextVisible,
        truncated: nextTotal > nextVisible,
      };
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

  useEffect(() => {
    if (!expandedStage) {
      return;
    }
    const node = stageLogsRef.current;
    if (node && stageLogs.length > 0) {
      node.scrollTop = node.scrollHeight;
    }
  }, [stageLogs, expandedStage]);

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
        if (retryParams.extraction_mode) {
          params.extraction_mode = retryParams.extraction_mode;
        }
        if (retryParams.max_frames) {
          params.max_frames = parseInt(retryParams.max_frames);
        }
        if (retryParams.target_fps) {
          params.target_fps = parseFloat(retryParams.target_fps);
        }
        if (retryParams.colmap_resolution) {
          params.colmap_resolution = retryParams.colmap_resolution;
        }
        params.smart_frame_selection = retryParams.smart_frame_selection;
        if (retryParams.oversample_factor) {
          params.oversample_factor = parseInt(retryParams.oversample_factor);
        }
        if (retryParams.replacement_search_radius) {
          params.replacement_search_radius = parseInt(retryParams.replacement_search_radius);
        }
        if (retryParams.ffmpeg_cpu_workers) {
          params.ffmpeg_cpu_workers = parseInt(retryParams.ffmpeg_cpu_workers);
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
        extraction_mode: '',
        max_frames: '',
        target_fps: '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        smart_frame_selection: true,
        oversample_factor: '',
        replacement_search_radius: '',
        ffmpeg_cpu_workers: '',
      });
      await loadProject();
    } catch (err) {
      alert('Failed to retry processing');
    }
  };

  const handleDownloadLogs = () => {
    window.open(api.getProjectLogsDownloadUrl(projectId), '_blank', 'noopener,noreferrer');
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
        extraction_mode: project?.config?.extraction_mode || '',
        max_frames: project?.config?.max_frames?.toString() || '',
        target_fps: project?.config?.target_fps?.toString() || '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        smart_frame_selection: project?.config?.smart_frame_selection !== false,
        oversample_factor: project?.config?.oversample_factor?.toString() || '',
        replacement_search_radius: project?.config?.replacement_search_radius?.toString() || '',
        ffmpeg_cpu_workers: project?.config?.ffmpeg_cpu_workers?.toString() || '',
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
      case 'fast': return 'brutal-badge brutal-badge-info';
      case 'balanced': return 'brutal-badge';
      case 'high': return 'brutal-badge brutal-badge-success';
      case 'ultra': return 'brutal-badge';
      case 'professional': return 'brutal-badge brutal-badge-warning';
      case 'ultra_professional': return 'brutal-badge brutal-badge-error';
      default: return 'brutal-badge';
    }
  };

  const getStatusBadgeClass = (status?: string | null) => {
    switch (status) {
      case 'processing':
      case 'queued':
        return 'status-badge status-processing';
      case 'completed':
        return 'status-badge status-completed';
      case 'failed':
        return 'status-badge status-failed';
      case 'cancelled':
        return 'status-badge status-cancelled';
      default:
        return 'status-badge';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'queued':
        return <Clock className="h-7 w-7" style={{ color: 'var(--text-secondary)' }} />;
      case 'processing':
        return <Loader className="h-7 w-7 animate-spin" style={{ color: 'var(--processing-text)' }} />;
      case 'completed':
        return <CheckCircle className="h-7 w-7" style={{ color: 'var(--success-icon)' }} />;
      case 'failed':
        return <XCircle className="h-7 w-7" style={{ color: 'var(--error-icon)' }} />;
      case 'cancelled':
        return <AlertTriangle className="h-7 w-7" style={{ color: 'var(--warning-text)' }} />;
      default:
        return <Clock className="h-7 w-7" style={{ color: 'var(--text-secondary)' }} />;
    }
  };

  const getStageIcon = (stage: any) => {
    if (stage.status === 'completed') {
      return <CheckCircle className="h-4 w-4" style={{ color: 'var(--success-icon)' }} />;
    } else if (stage.status === 'running') {
      return <Loader className="h-4 w-4 animate-spin" style={{ color: 'var(--processing-text)' }} />;
    } else if (stage.status === 'failed') {
      return <XCircle className="h-4 w-4" style={{ color: 'var(--error-icon)' }} />;
    } else if (stage.status === 'cancelled') {
      return <AlertTriangle className="h-4 w-4" style={{ color: 'var(--warning-text)' }} />;
    } else {
      return <Clock className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />;
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
      <div className="brutal-shell flex min-h-screen items-center justify-center px-4">
        <div className="brutal-card-dark flex items-center gap-3 px-5 py-4 text-sm font-bold uppercase tracking-[0.16em]">
          <Loader className="h-5 w-5 animate-spin" />
          Loading Project
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="brutal-shell">
        <div className="brutal-container brutal-section">
          <div className="brutal-card mx-auto max-w-3xl p-6 text-center">
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] shadow-[var(--shadow-sm)]">
              <FileBox className="h-6 w-6 text-[var(--ink)]" />
            </div>
            <h2 className="brutal-h2 mb-2">Project Not Found</h2>
            <p className="mb-5 text-sm text-[var(--text-secondary)]">This project may have been removed or is no longer available.</p>
            <div className="flex justify-center">
              <button type="button" onClick={() => router.push('/projects')}
              className="brutal-btn brutal-btn-primary"><ArrowLeft className="h-4 w-4" />
              Back To Projects
                            </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const currentStage = getCurrentStage();
  const fileCount = project.file_count || 0;
  const activeStageLabel = currentStage
    ? (getStageLabelForEngine(currentStage.key, project?.config?.sfm_engine, project?.config?.feature_method)
      || PIPELINE_STAGES.find(s => s.key === currentStage.key)?.label)
    : 'Initializing';
  const sparseStage = stages.find(s => s.key === 'sparse_reconstruction');
  const featureExtractionStage = stages.find(s => s.key === 'feature_extraction');
  const canInspectSparseModel = featureExtractionStage?.status === 'completed' || sparseStage?.status === 'completed';
  const projectInfoTiles = [
    { label: 'Input', value: project.input_type || 'unknown' },
    { label: 'Files', value: fileCount.toLocaleString() },
    { label: 'Framework', value: getSfmEngineCompactLabel(project?.config?.sfm_engine) || '--' },
    { label: 'Feature Method', value: project?.config?.feature_method || '--' },
  ];

  return (
    <div className="brutal-shell">
      <div className="flex min-h-screen flex-col">
        <main className="flex-1">
          <section className="brutal-section-tight brutal-divider">
            <div className="brutal-container space-y-4">
              <Breadcrumbs items={[
                { label: 'Projects', href: '/projects' },
                { label: project?.metadata?.name || 'Project Details' }
              ]} />

              <div className="brutal-card-dark relative overflow-hidden px-4 py-4 md:px-5">
                <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
                <div className="relative flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="brutal-eyebrow">Project Detail</span>
                      <span className={getStatusBadgeClass(project.status)}>{project.status || 'unknown'}</span>
                    </div>
                    <div className="flex items-start gap-3">
                      <div className="flex h-11 w-11 shrink-0 items-center justify-center border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] text-[var(--ink)] shadow-[3px_3px_0_var(--paper-muted-2)]">
                        {getStatusIcon(project.status)}
                      </div>
                      <div className="space-y-2">
                        <h1 className="brutal-h1 text-[var(--text-on-ink)]">{project.metadata?.name || 'Untitled Project'}</h1>
                        <div className="flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--text-on-ink-muted)]">
                          <span>{fileCount} files</span>
                          <span>•</span>
                          <span>{project.input_type || 'unknown'}</span>
                          <span>•</span>
                          <span>ID {projectId.slice(0, 8)}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[440px]">
                    {projectInfoTiles.map((tile) => (
                      <div key={tile.label} className="border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] px-3 py-3 shadow-[3px_3px_0_var(--paper-muted-2)]">
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">{tile.label}</p>
                        <p className="text-sm font-bold uppercase tracking-[0.04em] text-[var(--ink)]">{tile.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="brutal-section-tight">
            <div className="brutal-container space-y-4">
              {(project.status === 'processing' || canRetryProject || project.status === 'completed') && (
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <div className={project.status === 'processing' ? 'brutal-card-dark p-4 md:p-5' : 'brutal-card p-4 md:p-5'}>
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className={`mb-2 text-[11px] font-bold uppercase tracking-[0.18em] ${project.status === 'processing' ? 'text-[var(--text-on-ink-muted)]' : 'text-[var(--text-secondary)]'}`}>
                          Status + Progress
                        </p>
                        <div className="flex flex-wrap items-end gap-3">
                          <span className={`text-4xl font-black uppercase leading-none tracking-tight ${project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}`}>
                            {overallProgress}%
                          </span>
                          <span className={getStatusBadgeClass(project.status)}>{project.status}</span>
                        </div>
                      </div>

                      {project.status === 'processing' && (
                        <button type="button" onClick={handleCancelProcessing} className="brutal-btn brutal-btn-danger brutal-btn-xs"><XCircle className="h-4 w-4" />
                        ยกเลิก
                                                </button>
                      )}
                    </div>

                    <div className={`mb-3 border-[var(--border-w)] ${project.status === 'processing' ? 'border-[var(--paper)] bg-[var(--paper)]' : 'border-[var(--ink)] bg-[var(--paper-muted)]'} p-1`}>
                      <div
                        className={`h-4 transition-all duration-500 ${project.status === 'processing' ? 'bg-[var(--ink-600)]' : 'bg-[var(--ink)]'}`}
                        style={{ width: `${overallProgress}%` }}
                      />
                    </div>

                    <div className={`grid gap-2 text-xs font-medium md:grid-cols-4 ${project.status === 'processing' ? 'text-[var(--text-on-ink-muted)]' : 'text-[var(--text-secondary)]'}`}>
                      <div>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]">Active Stage</p>
                        <p className={project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}>{activeStageLabel}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]">Elapsed</p>
                        <p className={project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}>{timeStats.elapsedTime}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]">Remaining</p>
                        <p className={project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}>{timeStats.remainingTime}</p>
                      </div>
                      <div>
                        <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em]">ETA</p>
                        <p className={project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}>{timeStats.eta}</p>
                      </div>
                    </div>

                    {currentStage?.key === 'sparse_reconstruction' &&
                      (isGlobalSfmEngine(project?.config?.sfm_engine) || project?.config?.sfm_engine === 'fastmap') &&
                      stageDetails['sparse_reconstruction']?.text && (
                      <div className={`mt-3 border-t pt-3 text-xs ${project.status === 'processing' ? 'border-[var(--ink-700)] text-[var(--text-on-ink-muted)]' : 'border-[var(--paper-muted-2)] text-[var(--text-secondary)]'}`}>
                        {stageDetails['sparse_reconstruction'].text}
                      </div>
                    )}
                  </div>

                  <div className="brutal-card p-4 md:p-5">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div>
                        <p className="brutal-label mb-1">Action Dock</p>
                        <h2 className="brutal-h3">Project Controls</h2>
                      </div>
                      {project.status === 'processing' && <span className="brutal-badge brutal-badge-info">Live</span>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {project.status === 'completed' && (
                        <>
                          <button type="button" onClick={() => router.push(`/viewer?project=${projectId}`)} className="brutal-btn brutal-btn-primary"><Eye className="h-4 w-4" />
                          View 3D
                                                    </button>
                          <button type="button" onClick={() => router.push(`/camera-poses/${projectId}`)}
                          className="brutal-btn"><Eye className="h-4 w-4" />
                          {getSfmEngineCompactLabel(project?.config?.sfm_engine)}</button>
                          <button type="button" onClick={handleDownload} className="brutal-btn"><Download className="h-4 w-4" />
                          Download
                                                    </button>
                          <button type="button" onClick={openRetryModal} className="brutal-btn brutal-btn-xs"><RefreshCw className="h-4 w-4" />
                          Retry
                                                    </button>
                        </>
                      )}
                      {canRetryProject && (
                        <button type="button" onClick={openRetryModal} className="brutal-btn brutal-btn-primary"><RefreshCw className="h-4 w-4" />
                        Retry
                                                </button>
                      )}
                      {canInspectSparseModel && (
                        <button type="button" onClick={() => router.push(`/camera-poses/${projectId}`)} className="brutal-btn brutal-btn-xs"><Eye className="h-4 w-4" />
                        Inspect Sparse
                                                </button>
                      )}
                      <button type="button" onClick={handleDelete} className="brutal-btn brutal-btn-danger brutal-btn-xs"><Trash2 className="h-4 w-4" />
                      Delete
                                            </button>
                    </div>
                    {canInspectSparseModel && (
                      <p className="mt-3 text-xs text-[var(--text-secondary)]">
                        Open Camera Poses to inspect {getSfmEngineCompactLabel(project?.config?.sfm_engine)} sparse reconstruction.
                      </p>
                    )}
                  </div>
                </div>
              )}

              {framework && (
                <div className="grid gap-4 xl:grid-cols-12">
                  <div className="brutal-card xl:col-span-7 p-4 md:p-5">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="brutal-label mb-1">Framework</p>
                        <h2 className="brutal-h3">Reconstruction Policy</h2>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">Dynamic heuristic state and pair-geometry refinement from backend policy.</p>
                      </div>
                      {framework.orbit_safe_profile && <span className="brutal-badge">{framework.orbit_safe_profile}</span>}
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="brutal-card-muted p-4">
                        <p className="brutal-label mb-2">Pipeline</p>
                        <p className="text-sm font-bold uppercase text-[var(--ink)]">{getSfmEngineLabel(framework.sfm_engine || project?.config?.sfm_engine) || '--'} / {framework.feature_method || project?.config?.feature_method || '--'}</p>
                        <p className="mt-2 text-xs text-[var(--text-secondary)]">Phase {framework.phase || '--'}</p>
                      </div>
                      <div className="brutal-card p-4">
                        <p className="brutal-label mb-2">Matching Policy</p>
                        <p className="text-sm font-bold uppercase text-[var(--ink)]">{getMatcherLabelWithMode(framework.matcher_type) || '--'}</p>
                        <p className="mt-2 text-xs text-[var(--text-secondary)]">overlap {framework.matcher_params?.['SequentialMatching.overlap'] || '--'} • quadratic {framework.matcher_params?.['SequentialMatching.quadratic_overlap'] || '--'}</p>
                      </div>
                      <div className="brutal-card-muted p-4">
                        <p className="brutal-label mb-2">Bridge Risk</p>
                        <p className="text-lg font-black uppercase text-[var(--ink)]">{framework.bridge_risk_score ?? '--'}</p>
                        <p className="mt-2 text-xs text-[var(--text-secondary)]">orbit-safe {framework.orbit_safe_mode ? 'enabled' : 'disabled'}</p>
                      </div>
                    </div>
                  </div>

                  <div className="brutal-card-muted xl:col-span-5 p-4 md:p-5">
                    <p className="brutal-label mb-3">Thresholds + Geometry</p>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="space-y-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                        <h3 className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">Mapper Thresholds</h3>
                        <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                          <div className="flex items-center justify-between gap-3"><span>Abs pose max error</span><span className="font-bold text-[var(--ink)]">{framework.mapper_params?.['Mapper.abs_pose_max_error'] || '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Min inliers</span><span className="font-bold text-[var(--ink)]">{framework.mapper_params?.['Mapper.abs_pose_min_num_inliers'] || '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Min inlier ratio</span><span className="font-bold text-[var(--ink)]">{framework.mapper_params?.['Mapper.abs_pose_min_inlier_ratio'] || '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Max registration trials</span><span className="font-bold text-[var(--ink)]">{framework.mapper_params?.['Mapper.max_reg_trials'] || '--'}</span></div>
                        </div>
                      </div>
                      <div className="space-y-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                        <h3 className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">Pair Geometry</h3>
                        <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                          <div className="flex items-center justify-between gap-3"><span>Bridge p10</span><span className="font-bold text-[var(--ink)]">{framework.pair_geometry_stats?.bridge_p10 ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Bridge min</span><span className="font-bold text-[var(--ink)]">{framework.pair_geometry_stats?.bridge_min ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Weak boundaries</span><span className="font-bold text-[var(--ink)]">{framework.pair_geometry_stats?.weak_boundary_count ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-3"><span>Weak ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(framework.pair_geometry_stats?.weak_boundary_ratio)}</span></div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {videoDiagnostics && (
                <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                  <div className="brutal-card-muted p-4 md:p-5">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="brutal-label mb-1">Video Diagnostics</p>
                        <h2 className="brutal-h3">Extraction Summary</h2>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">Oversample-and-select summary stored with the project.</p>
                      </div>
                      <span className="brutal-badge brutal-badge-warning">window ±{effectiveSearchWindow ?? '--'}</span>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {[
                        ['Candidates', videoDiagnostics.candidate_count ?? '--'],
                        ['Targets', videoDiagnostics.requested_targets ?? '--'],
                        ['Saved', videoDiagnostics.saved_frames ?? '--'],
                        ['Replaced', videoDiagnostics.replaced_targets ?? '--'],
                        ['Rejected', videoDiagnostics.rejected_candidates ?? '--'],
                      ].map(([label, value]) => (
                        <div key={label} className="brutal-card p-4">
                          <p className="brutal-label mb-2">{label}</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">{value}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="brutal-card p-4 md:p-5">
                    <p className="brutal-label mb-3">Recent Replacements</p>
                    <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                      {(videoDiagnostics.videos || [])
                        .flatMap((video) => (video.selections || []).map((selection) => ({ ...selection, filename: video.filename })))
                        .filter((selection) => selection.offset !== 0)
                        .slice(0, 12)
                        .map((selection, index) => (
                          <div key={`${selection.filename || 'video'}-${selection.target_index}-${index}`} className="flex items-center justify-between gap-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] px-3 py-2">
                            <span className="truncate">{selection.filename || 'video'}: target {selection.target_index} {'->'} {selection.selected_index}</span>
                            <span className="shrink-0 font-bold text-[var(--ink)]">offset {selection.offset > 0 ? `+${selection.offset}` : selection.offset} • sharpness {selection.sharpness}</span>
                          </div>
                        ))}
                      {!(videoDiagnostics.videos || [])
                        .flatMap((video) => video.selections || [])
                        .some((selection) => selection.offset !== 0) && (
                        <div className="brutal-card-muted p-4 text-sm text-[var(--text-secondary)]">No replacements were needed in the stored extraction summary.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {(project?.input_type === 'video' || project?.input_type === 'mixed') && (
                <div className="brutal-card p-4 md:p-5">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-label mb-1">Live Extraction</p>
                      <h2 className="brutal-h3">Frame Sampling Monitor</h2>
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">ติดตามจำนวนภาพที่ถูกถอดจากวิดีโอแบบ realtime ระหว่าง stage extract</p>
                    </div>
                    <span className="brutal-badge brutal-badge-info">{smartFrameSelectionEnabled ? `window ±${effectiveSearchWindow ?? '--'}` : 'oversample off'}</span>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                    {[
                      ['Extracted', videoExtractionFramesDone ?? '--'],
                      ['Target', videoExtractionFramesTotal ?? '--'],
                      ['Resolution', project?.config?.colmap_resolution || '--'],
                      ['Sampling', extractionSummary],
                      ['Oversample', smartFrameSelectionEnabled ? `${oversampleFactor ?? '--'}x` : 'Disabled'],
                    ].map(([label, value], index) => (
                        <div key={label} className={index % 2 === 0 ? 'brutal-card-muted p-4' : 'brutal-card p-4'}>
                        <p className="brutal-label mb-2">{label}</p>
                        <p className="text-sm font-bold uppercase text-[var(--ink)]">{value}</p>
                      </div>
                    ))}
                  </div>

                  {(videoExtractionDetail?.text || videoExtractionDetail?.subtext) && (
                    <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] p-4">
                      {videoExtractionDetail?.text && <p className="text-sm text-[var(--ink)]">{videoExtractionDetail.text}</p>}
                      {videoExtractionDetail?.subtext && <p className="mt-1 text-xs text-[var(--text-secondary)]">{videoExtractionDetail.subtext}</p>}
                    </div>
                  )}
                </div>
              )}

              <div className="brutal-card p-4 md:p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <p className="brutal-label mb-1">Pipeline</p>
                    <h2 className="brutal-h3">Processing Stages</h2>
                  </div>
                  <span className="brutal-badge">{stages.filter((stage) => stage.status === 'completed').length}/{PIPELINE_STAGES.length} done</span>
                </div>

                <div className="grid gap-3 lg:grid-cols-8">
                  {PIPELINE_STAGES.map((stageConfig) => {
                    const stage = stages.find(s => s.key === stageConfig.key) || { key: stageConfig.key, status: 'pending', progress: 0 };
                    const progress = getStageProgress(stage);
                    const isRunning = stage.status === 'running';
                    const isExpanded = expandedStage === stageConfig.key;
                    const stageBadgeClass = stage.status === 'completed'
                      ? 'status-badge status-completed'
                      : stage.status === 'running'
                        ? 'status-badge status-processing'
                        : stage.status === 'failed'
                          ? 'status-badge status-failed'
                          : stage.status === 'cancelled'
                            ? 'status-badge status-cancelled'
                            : 'status-badge';

                    return (
                      <button type="button" key={stageConfig.key}
                      onClick={() => setExpandedStage(isExpanded ? null : stageConfig.key)}
                      className={`text-left ${isRunning || isExpanded ? 'brutal-card-dark' : stage.status === 'pending' ? 'brutal-card-muted' : 'brutal-card'} p-3 transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px]`}><div className="mb-3 flex items-start justify-between gap-2">
                        <div className={`flex h-9 w-9 items-center justify-center border-[var(--border-w)] ${isRunning || isExpanded ? 'border-[var(--paper)] bg-[var(--paper)] text-[var(--ink)]' : 'border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)]'}`}>
                          {stage.status === 'pending' ? <stageConfig.Icon className="h-4 w-4" /> : getStageIcon(stage)}
                        </div>
                        <span className={stageBadgeClass}>{stage.status}</span>
                      </div>
                      <p className={`mb-2 text-sm font-black uppercase tracking-tight ${isRunning || isExpanded ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}`}>
                        {getStageLabelForEngine(stageConfig.key, project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig.label}
                      </p>
                      <div className={`mb-2 border p-1 ${isRunning || isExpanded ? 'border-[var(--paper)] bg-[var(--paper)]' : 'border-[var(--ink)] bg-[var(--paper-muted-2)]'}`}>
                        <div className={`h-2 ${isRunning || isExpanded ? 'bg-[var(--ink-600)]' : 'bg-[var(--ink)]'}`} style={{ width: `${progress}%` }} />
                      </div>
                      <p className={`text-[11px] font-medium uppercase tracking-[0.12em] ${isRunning || isExpanded ? 'text-[var(--text-on-ink-muted)]' : 'text-[var(--text-secondary)]'}`}>{progress}%</p></button>
                    );
                  })}
                </div>

                {expandedStage && (() => {
                  const stageConfig = PIPELINE_STAGES.find(s => s.key === expandedStage);
                  const stage = stages.find(s => s.key === expandedStage) || { key: expandedStage, status: 'pending', progress: 0 };
                  const progress = getStageProgress(stage);
                  const stageErrored = isErrorStatus(stage.status);
                  const stageCancelled = stage.status === 'cancelled';

                  return (
                    <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
                      <div className="brutal-card-dark p-4">
                        <div className="mb-4 flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div className="flex h-10 w-10 items-center justify-center border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] text-[var(--ink)]">
                              {stageConfig?.Icon && <stageConfig.Icon className="h-5 w-5" />}
                            </div>
                            <div>
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-on-ink-muted)]">Expanded Stage</p>
                              <h3 className="text-lg font-black uppercase tracking-tight text-[var(--text-on-ink)]">{getStageLabelForEngine(stageConfig?.key || '', project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig?.label}</h3>
                              <p className="mt-1 text-xs text-[var(--text-on-ink-muted)]">
                                {stage.status === 'completed' ? 'Completed' :
                                 stage.status === 'running' ? `In progress (${progress}%)` :
                                 stageCancelled ? 'Cancelled' :
                                 stageErrored ? 'Failed' :
                                 'Pending'}
                              </p>
                            </div>
                          </div>
                          <button type="button" onClick={() => setExpandedStage(null)} className="brutal-btn brutal-btn-xs"><XCircle className="h-4 w-4" />
                          Close
                                                    </button>
                        </div>

                        {stage.status === 'running' && (
                          <div className="mb-4">
                            <div className="mb-2 flex items-center justify-between text-xs font-bold uppercase tracking-[0.15em] text-[var(--text-on-ink-muted)]">
                              <span>Progress</span>
                              <span>{progress}%</span>
                            </div>
                            <div className="border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] p-1">
                              <div className="h-3 bg-[var(--ink-600)]" style={{ width: `${progress}%` }} />
                            </div>
                          </div>
                        )}

                        <div className="grid gap-3 md:grid-cols-2">
                          {stage.started_at && (
                            <div className="border-[var(--border-w)] border-[var(--ink-700)] bg-[var(--ink-800)] px-3 py-3">
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-on-ink-muted)]">Started</p>
                              <p className="text-sm font-bold text-[var(--text-on-ink)]">{new Date(stage.started_at).toLocaleTimeString()}</p>
                            </div>
                          )}
                          {stage.completed_at && (
                            <div className="border-[var(--border-w)] border-[var(--ink-700)] bg-[var(--ink-800)] px-3 py-3">
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-on-ink-muted)]">Completed</p>
                              <p className="text-sm font-bold text-[var(--text-on-ink)]">{new Date(stage.completed_at).toLocaleTimeString()}</p>
                            </div>
                          )}
                        </div>

                        {stageDetails[expandedStage]?.text && (
                          <div className="mt-4 border-t border-[var(--ink-700)] pt-4">
                            <p className="text-sm text-[var(--text-on-ink)]">{stageDetails[expandedStage].text}</p>
                            {stageDetails[expandedStage]?.subtext && <p className="mt-1 text-xs text-[var(--text-on-ink-muted)]">{stageDetails[expandedStage].subtext}</p>}
                          </div>
                        )}

                        {stageErrored && (
                          <div className={`mt-4 border-[var(--border-w)] p-3 ${stageCancelled ? 'status-cancelled' : 'status-failed'}`}>
                            <p className="text-sm font-bold uppercase tracking-[0.12em]">{stageCancelled ? 'Processing Cancelled' : 'Error'}</p>
                            <p className="mt-1 text-sm">
                              {stageCancelled
                                ? 'งานถูกยกเลิกแล้ว สามารถกด Retry เพื่อเริ่มจากขั้นนี้ใหม่ได้'
                                : stage.error || 'ขั้นตอนนี้เกิดข้อผิดพลาด ตรวจสอบ log แล้วลอง Retry อีกครั้ง'}
                            </p>
                          </div>
                        )}
                      </div>

                      <div className="brutal-card-muted p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="brutal-label">Step Breakdown</p>
                            {stage.status === 'running' && (
                              <span className="brutal-badge brutal-badge-success brutal-pulse">Live</span>
                            )}
                            <span className="brutal-badge">{stageLogs.length.toLocaleString()} lines</span>
                          </div>
                          <button
                            type="button"
                            onClick={handleDownloadLogs}
                            disabled={(logMeta.total || logs.length) === 0}
                            className="brutal-btn brutal-btn-xs"
                            title="Download full log"
                          >
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </button>
                        </div>
                        {expandedStage === 'sparse_reconstruction' && isGlobalSfmEngine(project?.config?.sfm_engine) && stage.status === 'running' && (
                          <div className="mb-3 space-y-2 text-xs text-[var(--text-secondary)]">
                            {[
                              { key: 'preprocessing', label: 'Preprocessing', progress: 5 },
                              { key: 'view_graph_calibration', label: 'View Graph Calibration', progress: 10 },
                              { key: 'relative_pose', label: 'Relative Pose Estimation', progress: 20 },
                              { key: 'rotation_averaging', label: 'Rotation Averaging', progress: 35 },
                              { key: 'track_establishment', label: 'Track Establishment', progress: 50 },
                              { key: 'global_positioning', label: 'Global Positioning', progress: 65 },
                              { key: 'bundle_adjustment', label: 'Bundle Adjustment', progress: 85 },
                              { key: 'retriangulation', label: 'Retriangulation', progress: 92 },
                              { key: 'postprocessing', label: 'Postprocessing', progress: 98 },
                            ].map((subStage) => {
                              const isSubCompleted = progress >= subStage.progress;
                              const isSubActive = progress >= (subStage.progress - 10) && progress < subStage.progress + 5;
                              return (
                                <div key={subStage.key} className={`flex items-center justify-between gap-3 border-[var(--border-w)] border-[var(--ink)] px-3 py-2 ${isSubActive ? 'bg-[var(--paper-card)]' : 'bg-[var(--paper-muted)]'}`}>
                                  <span className={`font-bold uppercase tracking-[0.12em] ${isSubCompleted ? 'text-[var(--success-icon)]' : isSubActive ? 'text-[var(--ink)]' : 'text-[var(--text-muted)]'}`}>{isSubCompleted ? 'DONE' : isSubActive ? 'LIVE' : 'WAIT'}</span>
                                  <span className="flex-1">{subStage.label}</span>
                                  <span className="font-bold text-[var(--ink)]">{subStage.progress}%</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {expandedStage === 'sparse_reconstruction' && project?.config?.sfm_engine === 'fastmap' && stage.status === 'running' && (
                          <div className="mb-3 space-y-2 text-xs text-[var(--text-secondary)]">
                            {[
                              { key: 'focal_estimation', label: 'Focal Length Estimation', progress: 5 },
                              { key: 'fundamental', label: 'Fundamental Matrix', progress: 15 },
                              { key: 'decompose', label: 'Essential Decomposition', progress: 25 },
                              { key: 'rotation', label: 'Global Rotation', progress: 40 },
                              { key: 'translation', label: 'Global Translation', progress: 55 },
                              { key: 'tracks', label: 'Track Building', progress: 65 },
                              { key: 'epipolar', label: 'Epipolar Adjustment', progress: 80 },
                              { key: 'sparse', label: 'Sparse Reconstruction', progress: 92 },
                              { key: 'output', label: 'Writing Results', progress: 98 },
                            ].map((subStage) => {
                              const isSubCompleted = progress >= subStage.progress;
                              const isSubActive = progress >= (subStage.progress - 10) && progress < subStage.progress + 5;
                              return (
                                <div key={subStage.key} className={`flex items-center justify-between gap-3 border-[var(--border-w)] border-[var(--ink)] px-3 py-2 ${isSubActive ? 'bg-[var(--paper-card)]' : 'bg-[var(--paper-muted)]'}`}>
                                  <span className={`font-bold uppercase tracking-[0.12em] ${isSubCompleted ? 'text-[var(--success-icon)]' : isSubActive ? 'text-[var(--ink-600)]' : 'text-[var(--text-muted)]'}`}>{isSubCompleted ? 'DONE' : isSubActive ? 'LIVE' : 'WAIT'}</span>
                                  <span className="flex-1">{subStage.label}</span>
                                  <span className="font-bold text-[var(--ink)]">{subStage.progress}%</span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {stageLogs.length > 0 ? (
                          <div
                            ref={stageLogsRef}
                            className="brutal-scroll max-h-72 overflow-y-auto overflow-x-hidden border-[var(--border-w)] border-[var(--ink)] bg-[var(--ink)] p-3 font-mono text-xs leading-relaxed text-[var(--paper-muted)]"
                          >
                            {stageLogs.map((log, index) => (
                              <div key={`${expandedStage}-${index}-${log.slice(0, 24)}`} className="flex gap-3 whitespace-pre-wrap break-all hover:text-white">
                                <span className="w-10 shrink-0 select-none text-right text-[var(--text-on-ink-muted)]">{index + 1}</span>
                                <span className="min-w-0 flex-1">{log}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4 text-sm text-[var(--text-secondary)]">
                            {stage.status === 'pending' ? 'Stage has not started yet.' : 'No logs captured for this stage yet.'}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>

              {(project.status === 'completed' || project.status === 'failed') && (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="brutal-card p-4 md:p-5">
                    <p className="brutal-label mb-3">Exports</p>
                    <ExportedMeshesList projectId={projectId} />
                  </div>
                  <div className="brutal-card-muted p-4 md:p-5">
                    <p className="brutal-label mb-3">Mesh Generation</p>
                    <MeshExportPanel projectId={projectId} projectStatus={project.status} />
                  </div>
                </div>
              )}

              {framePreview.length > 0 && (
                <div className="brutal-card p-4 md:p-5">
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <h2 className="brutal-h3">{hasSeparateTraining ? 'COLMAP Frames' : 'Frame Preview'} ({framePreview.length})</h2>
                    <span className="brutal-badge">click to enlarge</span>
                    {hasSeparateTraining && <span className="brutal-badge brutal-badge-info">For Pose Estimation</span>}
                  </div>
                  <div className="brutal-scroll max-h-96 overflow-y-auto pr-1">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
                      {framePreview.map((frame, index) => (
                        <button type="button" key={frame.url || frame.name || `frame-${index}`}
                        className="group brutal-card-hover overflow-hidden text-left"
                        onClick={() => {
                          setPreviewImageIndex(index);
                          setShowImagePreview(true);
                        }}><div className="aspect-[4/3] overflow-hidden border-b-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)]">
                          <img src={frame.url} alt={frame.name} className="h-full w-full object-cover" loading="lazy" />
                        </div>
                        <div className="flex items-center justify-between gap-2 p-3">
                          <span className="truncate text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink)]">{frame.name || `Frame ${index + 1}`}</span>
                          <span className="brutal-badge">{index + 1}</span>
                        </div></button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {hasSeparateTraining && trainingFramePreview.length > 0 && (
                <div className="brutal-card-muted p-4 md:p-5">
                  <div className="mb-4 flex flex-wrap items-center gap-2">
                    <h2 className="brutal-h3">Training Frames ({trainingFramePreview.length})</h2>
                    <span className="brutal-badge brutal-badge-warning">High-Res</span>
                  </div>
                  <div className="brutal-scroll max-h-96 overflow-y-auto pr-1">
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
                      {trainingFramePreview.map((frame, index) => (
                        <button type="button" key={frame.url || frame.name || `training-frame-${index}`}
                        className="group brutal-card overflow-hidden text-left hover:-translate-x-[2px] hover:-translate-y-[2px] hover:shadow-[var(--shadow-md)]"
                        onClick={() => {
                          window.open(frame.url, '_blank');
                        }}><div className="aspect-[4/3] overflow-hidden border-b-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)]">
                          <img src={frame.url} alt={frame.name} className="h-full w-full object-cover" loading="lazy" />
                        </div>
                        <div className="flex items-center justify-between gap-2 p-3">
                          <span className="truncate text-xs font-bold uppercase tracking-[0.12em] text-[var(--ink)]">{frame.name || `Frame ${index + 1}`}</span>
                          <span className="brutal-badge brutal-badge-warning">{index + 1}</span>
                        </div></button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </main>

      {/* Retry Modal */}
      {showRetryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,26,63,0.72)] p-4">
          <div className="brutal-card flex max-h-[90vh] w-full max-w-2xl flex-col">
            <div className="brutal-divider px-5 py-4">
              <h3 className="brutal-h2 mb-2">Retry Processing</h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Select which stage to retry from. All subsequent stages will be re-run.
              </p>
            </div>

            <div className="brutal-scroll flex-1 overflow-y-auto px-5 py-4">
              <div className="space-y-2 mb-6">
              {PIPELINE_STAGES.map((stage) => {
                const stageState = stages.find(s => s.key === stage.key);
                const isCompleted = stageState?.status === 'completed';
                const isErrored = isErrorStatus(stageState?.status);
                const isCancelledStage = stageState?.status === 'cancelled';

                return (
                  <label
                    key={stage.key}
                    className={`flex cursor-pointer items-center border-[var(--border-w)] p-4 transition-all ${
                      selectedRetryStage === stage.key
                        ? 'border-[var(--ink)] bg-[var(--paper-muted)] shadow-[var(--shadow-sm)]'
                        : 'border-[var(--ink)] bg-[var(--paper-card)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="retry-stage"
                      value={stage.key}
                      checked={selectedRetryStage === stage.key}
                      onChange={(e) => setSelectedRetryStage(e.target.value)}
                      className="mr-4 h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                    />
                    <div className="flex-1">
                      <div className="flex items-center space-x-3">
                        <stage.Icon className="h-5 w-5 text-[var(--text-secondary)]" />
                        <span className="text-sm font-bold uppercase tracking-[0.06em] text-[var(--ink)]">{getStageLabelForEngine(stage.key, project?.config?.sfm_engine, project?.config?.feature_method) || stage.label}</span>
                      </div>
                      <div className="mt-1.5 ml-8 flex items-center space-x-2">
                        {isCompleted && (<span className="status-badge status-completed">
                            <CheckCircle className="h-3 w-3 mr-1" />
                            Completed
                          </span>)}
                        {isErrored && (
                          <span className={isCancelledStage ? 'status-badge status-cancelled' : 'status-badge status-failed'}>
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
              <div className="status-cancelled mb-6 border-[var(--border-w)] p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em]">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่าการแยกเฟรม (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <p className="brutal-label mb-1 block">
                      Extraction Mode
                    </p>
                    <select
                      value={retryParams.extraction_mode}
                      onChange={(e) => setRetryParams({...retryParams, extraction_mode: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="fps">Target FPS</option>
                      <option value="target_count">Target Frame Count</option>
                      <option value="frames">Legacy Max Frame Limit</option>
                    </select>
                  </div>

                  {retryParams.extraction_mode === 'fps' && (
                    <div>
                      <p className="brutal-label mb-1 block">
                        Target FPS
                      </p>
                      <input
                        type="number"
                        min="0.1"
                        step="0.1"
                        value={retryParams.target_fps}
                        onChange={(e) => setRetryParams({...retryParams, target_fps: e.target.value})}
                        className="brutal-input"
                        placeholder="เช่น 1 / 2 / 5"
                      />
                    </div>
                  )}

                  {(retryParams.extraction_mode === 'target_count' || retryParams.extraction_mode === 'frames') && (
                    <div>
                      <p className="brutal-label mb-1 block">
                        {retryParams.extraction_mode === 'target_count' ? 'Target Frame Count' : 'Maximum Frames'}
                      </p>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={retryParams.max_frames}
                        onChange={(e) => setRetryParams({...retryParams, max_frames: e.target.value})}
                        className="brutal-input"
                        placeholder={retryParams.extraction_mode === 'target_count' ? 'เช่น 150 / 200 / 300' : 'เช่น 100 / 200 / 500'}
                      />
                    </div>
                  )}

                  <div>
                    <p className="brutal-label mb-1 block">
                      COLMAP Resolution (สำหรับ Pose Estimation)
                    </p>
                    <select
                      value={retryParams.colmap_resolution}
                      onChange={(e) => setRetryParams({...retryParams, colmap_resolution: e.target.value})}
                      className="brutal-select"
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
                    <p className="brutal-label mb-1 block">
                      Oversample And Select
                    </p>
                    <label className="flex items-center gap-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">
                      <input
                        type="checkbox"
                        checked={retryParams.smart_frame_selection}
                        onChange={(e) => setRetryParams({...retryParams, smart_frame_selection: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <span>ถอด candidate ให้ถี่ขึ้นก่อน แล้วคัดกลับให้เหลือเฉพาะเฟรมที่คมที่สุดตาม FPS เป้าหมาย</span>
                    </label>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Oversample Factor
                    </p>
                    <select
                      value={retryParams.oversample_factor}
                      onChange={(e) => setRetryParams({...retryParams, oversample_factor: e.target.value})}
                      className="brutal-select"
                      disabled={!retryParams.smart_frame_selection}
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="5">5x</option>
                      <option value="10">10x - Recommended</option>
                      <option value="15">15x</option>
                      <option value="20">20x</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ยิ่งค่าสูง ระบบจะถอด candidate มากขึ้นก่อนคัดกลับ แต่จะใช้เวลาและพื้นที่ชั่วคราวมากขึ้น</p>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Minimum Search Radius
                    </p>
                    <select
                      value={retryParams.replacement_search_radius}
                      onChange={(e) => setRetryParams({...retryParams, replacement_search_radius: e.target.value})}
                      className="brutal-select"
                      disabled={!retryParams.smart_frame_selection}
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="2">±2 frames</option>
                      <option value="4">±4 frames - Recommended</option>
                      <option value="6">±6 frames</option>
                      <option value="8">±8 frames</option>
                      <option value="12">±12 frames</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ใช้เป็นค่าขั้นต่ำของช่วงค้นหา และ backend จะขยายเพิ่มตาม spacing จริงเมื่อจำเป็น</p>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      CPU Chunk Workers
                    </p>
                    <select
                      value={retryParams.ffmpeg_cpu_workers}
                      onChange={(e) => setRetryParams({...retryParams, ffmpeg_cpu_workers: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="2">2 workers</option>
                      <option value="4">4 workers</option>
                      <option value="8">8 workers</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">เพิ่มหรือลดจำนวน chunk extraction workers เวลา rerun ขั้น extract</p>
                  </div>

                  <div className="flex items-center">
                    <input
                      type="checkbox"
                        id="use_separate_training"
                        checked={retryParams.use_separate_training_images}
                        onChange={(e) => setRetryParams({...retryParams, use_separate_training_images: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <label htmlFor="use_separate_training" className="ml-2 text-xs font-medium text-[var(--ink)]">
                        ใช้ภาพความละเอียดสูงแยกสำหรับ Training
                      </label>
                    </div>

                    {retryParams.use_separate_training_images && (
                      <div>
                        <p className="brutal-label mb-1 block">
                          Training Resolution (สำหรับ 3DGS Training)
                        </p>
                        <select
                          value={retryParams.training_resolution}
                          onChange={(e) => setRetryParams({...retryParams, training_resolution: e.target.value})}
                          className="brutal-select"
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
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  💡 ภาพความละเอียดต่ำช่วยให้ COLMAP ทำงานเร็วขึ้น แล้วใช้ภาพ high-res สำหรับ training
                </p>
              </div>
            )}

            {/* Training Parameters Form - Show only for gaussian_splatting stage */}
            {selectedRetryStage === 'gaussian_splatting' && (
              <div className="status-processing mb-6 border-[var(--border-w)] p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em]">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่าการเทรน (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <p className="brutal-label mb-1 block">
                      Quality Mode
                    </p>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="brutal-select"
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
                    <p className="brutal-label mb-1 block">
                      Iterations (จำนวนรอบการเทรน)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 7000"
                      value={retryParams.iterations}
                      onChange={(e) => setRetryParams({...retryParams, iterations: e.target.value})}
                      className="brutal-input"
                    />
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Learning Rate (ค่าการเรียนรู้)
                    </p>
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="เช่น 0.0025"
                      value={retryParams.learning_rate}
                      onChange={(e) => setRetryParams({...retryParams, learning_rate: e.target.value})}
                      className="brutal-input"
                    />
                  </div>

                  {/* Training Images Option */}
                  <div className="border-t border-[var(--ink)] pt-2">
                    <div className="flex items-center mb-2">
                      <input
                        type="checkbox"
                        id="gs_use_separate_training"
                        checked={retryParams.use_separate_training_images}
                        onChange={(e) => setRetryParams({...retryParams, use_separate_training_images: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <label htmlFor="gs_use_separate_training" className="ml-2 text-xs font-medium text-[var(--ink)]">
                        ใช้ภาพความละเอียดสูงแยกสำหรับ Training
                      </label>
                    </div>

                    {retryParams.use_separate_training_images && (
                      <div>
                        <p className="brutal-label mb-1 block">
                          Training Resolution
                        </p>
                        <select
                          value={retryParams.training_resolution}
                          onChange={(e) => setRetryParams({...retryParams, training_resolution: e.target.value})}
                          className="brutal-select"
                        >
                          <option value="">ใช้ค่าเดิม</option>
                          <option value="1080p">1080p (1920×1080)</option>
                          <option value="2K">2K (2560×1440)</option>
                          <option value="4K">4K (3840×2160) - Recommended</option>
                          <option value="8K">8K (7680×4320) - Maximum</option>
                          <option value="original">Original Resolution</option>
                        </select>
                        <p className="mt-1 text-xs text-[var(--ink-600)]">
                          ⚠️ ถ้าไม่มี training_images จะถอดจาก video ให้อัตโนมัติ
                        </p>
                      </div>
                    )}
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  💡 ทิ้งค่าว่างเพื่อใช้ค่าเดิมต่อ หรือกรอกค่าใหม่เพื่อปรับเปลี่ยน
                </p>
              </div>
            )}

            {/* Feature Extraction Parameters Form */}
            {selectedRetryStage === 'feature_extraction' && (
              <div className="status-completed mb-6 border-[var(--border-w)] p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em]">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Feature Extraction (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <p className="brutal-label mb-1 block">
                      Quality Mode
                    </p>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="brutal-select"
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
                    <p className="brutal-label mb-1 block">
                      Max Num Features (จำนวน features สูงสุดต่อภาพ)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 32768"
                      value={retryParams.max_num_features}
                      onChange={(e) => setRetryParams({...retryParams, max_num_features: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 32768 (สำหรับภาพ 4K)</p>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Max Image Size (ขนาดภาพสูงสุด pixels)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 4160"
                      value={retryParams.max_image_size}
                      onChange={(e) => setRetryParams({...retryParams, max_image_size: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 4160</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  💡 การเพิ่ม features จะช่วยให้ได้ผลลัพธ์ดีขึ้น แต่ใช้เวลานานขึ้น
                </p>
              </div>
            )}

            {/* Feature Matching Parameters Form */}
            {selectedRetryStage === 'feature_matching' && (
              <div className="status-cancelled mb-6 border-[var(--border-w)] p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em]">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Feature Matching (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <p className="brutal-label mb-1 block">
                      Quality Mode
                    </p>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="brutal-select"
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
                    <p className="brutal-label mb-1 block">
                      Max Num Matches (จำนวน matches สูงสุด)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 45960"
                      value={retryParams.max_num_matches}
                      onChange={(e) => setRetryParams({...retryParams, max_num_matches: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 45960 (ปลอดภัยสำหรับ GPU)</p>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Sequential Overlap (จำนวนภาพที่ match กัน)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 20"
                      value={retryParams.sequential_overlap}
                      onChange={(e) => setRetryParams({...retryParams, sequential_overlap: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 20 (เพิ่มเพื่อ coverage ดีขึ้น)</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  💡 หาก GPU หน่วยความจำเต็ม ลอง max_num_matches ลดลง
                </p>
              </div>
            )}

            {/* Sparse Reconstruction Parameters Form */}
            {selectedRetryStage === 'sparse_reconstruction' && (
              <div className="brutal-card-muted mb-6 p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em] text-[var(--ink)]">
                  <Settings className="h-4 w-4 mr-2" />
                  ปรับค่า Sparse Reconstruction (ทิ้งว่างเพื่อใช้ค่าเดิม)
                </h4>
                <div className="space-y-3">
                  <div>
                    <p className="brutal-label mb-1 block">
                      Quality Mode
                    </p>
                    <select
                      value={retryParams.quality_mode}
                      onChange={(e) => setRetryParams({...retryParams, quality_mode: e.target.value})}
                      className="brutal-select"
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
                    <p className="brutal-label mb-1 block">
                      Min Num Matches (จำนวน matches ขั้นต่ำในการ register)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 8"
                      value={retryParams.min_num_matches}
                      onChange={(e) => setRetryParams({...retryParams, min_num_matches: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 8 (ลดลงเพื่อ register ภาพมากขึ้น)</p>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Max Num Models (จำนวน models สูงสุดที่สร้าง)
                    </p>
                    <input
                      type="number"
                      placeholder="เช่น 50"
                      value={retryParams.max_num_models}
                      onChange={(e) => setRetryParams({...retryParams, max_num_models: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 50 (เพิ่มเพื่อลองหลาย models)</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-[var(--text-secondary)]">
                  💡 ลด min_num_matches เพื่อช่วยให้ภาพที่ยากถูก register ได้
                </p>
              </div>
            )}

            {/* Model Conversion - No params needed */}
            {selectedRetryStage === 'model_conversion' && (
              <div className="brutal-card-muted mb-6 p-4">
                <h4 className="mb-3 flex items-center text-sm font-black uppercase tracking-[0.06em] text-[var(--ink)]">
                  <Info className="h-4 w-4 mr-2" />
                  Model Conversion
                </h4>
                <p className="text-sm text-[var(--text-secondary)]">
                  ขั้นตอนนี้จะเลือก sparse model ที่ดีที่สุดโดยอัตโนมัติ ไม่มีพารามิเตอร์ให้ปรับ
                </p>
              </div>
            )}
            </div>

            <div className="flex-shrink-0 border-t-[var(--border-w)] border-[var(--ink)] px-5 py-4">
              <div className="flex space-x-3">
                <button type="button" onClick={() => setShowRetryModal(false)}
                className="brutal-btn flex-1 justify-center">
                  Cancel
                </button>
                <button type="button" onClick={() => handleRetry(selectedRetryStage)}
                className="brutal-btn brutal-btn-primary flex-1 justify-center">
                  Start Retry
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Download PLY Files Modal */}
      {showDownloadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,26,63,0.72)] p-4">
          <div className="brutal-card flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="brutal-h2 flex items-center gap-2">
                <FileBox className="h-6 w-6" />
                ดาวน์โหลดโมเดล 3D Gaussian Splatting
              </h3>
              <button type="button" onClick={() => setShowDownloadModal(false)} className="brutal-btn brutal-btn-xs"><X className="h-6 w-6" /></button>
            </div>

            {loadingPlyFiles ? (
              <div className="flex items-center justify-center py-12">
                <Loader className="h-8 w-8 animate-spin text-[var(--ink)]" />
                <span className="ml-3 text-[var(--text-secondary)]">กำลังโหลดรายการไฟล์...</span>
              </div>
            ) : plyFiles.length === 0 ? (
              <div className="py-12 text-center">
                <FileBox className="mx-auto mb-3 h-12 w-12 text-[var(--text-muted)]" />
                <p className="text-[var(--text-secondary)]">ยังไม่มีไฟล์ PLY</p>
                <p className="text-sm text-[var(--text-muted)]">รอให้การประมวลผลเสร็จสิ้นก่อน</p>
              </div>
            ) : (
              <div className="brutal-scroll flex-1 space-y-3 overflow-y-auto pr-2">
                <p className="mb-4 text-sm text-[var(--text-secondary)]">
                  มี {plyFiles.length} ไฟล์ PLY พร้อมดาวน์โหลด (เรียงตามเวลาสร้างล่าสุด)
                </p>
                
                {plyFiles.map((file, index) => (
                  <div
                    key={file.filename}
                    className={`border-[var(--border-w)] p-4 transition-all ${
                      index === 0 
                        ? 'border-[var(--ink)] bg-[var(--paper-muted)] shadow-[var(--shadow-md)]' 
                        : 'border-[var(--ink)] bg-[var(--paper-card)] shadow-[var(--shadow-sm)]'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          {index === 0 && (
                            <span className="brutal-badge brutal-badge-solid">
                              ล่าสุด
                            </span>
                          )}
                          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${getQualityBadgeColor(file.quality_mode)}`}>
                            {file.quality_mode}
                          </span>
                          {file.iterations > 0 && (
                            <span className="brutal-badge">
                              {file.iterations.toLocaleString()} iterations
                            </span>
                          )}
                        </div>
                        <p className="truncate text-sm font-bold text-[var(--ink)]" title={file.filename}>
                          {file.filename}
                        </p>
                        <div className="mt-1 flex items-center gap-4 text-xs text-[var(--text-secondary)]">
                          <span>{formatFileSize(file.size)}</span>
                          <span>{formatPlyDate(file.created_at)}</span>
                        </div>
                      </div>
                      <button type="button" onClick={() => downloadPlyFile(file.filename)}
                      className={`ml-4 flex items-center text-sm font-medium ${
                        index === 0
                          ? 'brutal-btn brutal-btn-primary'
                          : 'brutal-btn'
                      }`}><Download className="h-4 w-4 mr-1" />
                      Download
                                            </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between border-t-[var(--border-w)] border-[var(--ink)] pt-4">
              <p className="text-xs text-[var(--text-secondary)]">
                💡 ไฟล์ที่ retry ใหม่จะแสดงด้านบน
              </p>
              <button type="button" onClick={() => setShowDownloadModal(false)}
              className="brutal-btn">
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Dialog */}
      {showImagePreview && framePreview.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(10,26,63,0.88)]"
        >
          <button type="button" onClick={() => setShowImagePreview(false)}
          className="absolute right-4 top-4 z-10 brutal-btn brutal-btn-xs brutal-btn-primary"><X className="h-8 w-8" /></button>

          <div className="absolute left-1/2 top-4 -translate-x-1/2 border-[var(--border-w)] border-[var(--paper)] bg-[var(--ink)] px-4 py-2 text-sm font-bold uppercase tracking-[0.12em] text-[var(--text-on-ink)]">
            {previewImageIndex + 1} / {framePreview.length}
          </div>

          <button type="button" onClick={(e) => {
            e.stopPropagation();
            setPreviewImageIndex((prev) => (prev > 0 ? prev - 1 : framePreview.length - 1));
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 brutal-btn brutal-btn-primary"><ChevronLeft className="h-8 w-8" /></button>

          <div
            className="flex max-h-[85vh] max-w-[90vw] items-center justify-center border-[var(--border-w-strong)] border-[var(--paper)] bg-[var(--paper-card)] p-3 shadow-[8px_8px_0_var(--paper-muted-2)]"
          >
            <img
              src={framePreview[previewImageIndex]?.url}
              alt={framePreview[previewImageIndex]?.name || `Frame ${previewImageIndex + 1}`}
              className="max-h-[85vh] max-w-full object-contain"
            />
          </div>

          <button type="button" onClick={(e) => {
            e.stopPropagation();
            setPreviewImageIndex((prev) => (prev < framePreview.length - 1 ? prev + 1 : 0));
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 brutal-btn brutal-btn-primary"><ChevronRight className="h-8 w-8" /></button>

          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 max-w-[90vw] overflow-x-auto">
            <div className="flex space-x-2 border-[var(--border-w)] border-[var(--paper)] bg-[var(--ink)] p-2">
              {framePreview.map((frame, index) => (
                <button type="button" key={frame.url || frame.name || `thumb-${index}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPreviewImageIndex(index);
                }}
                className={`h-12 w-16 flex-shrink-0 overflow-hidden border-[var(--border-w)] transition-all ${
                  index === previewImageIndex
                    ? 'border-[var(--paper)] scale-110'
                    : 'border-[var(--ink-600)] opacity-60 hover:opacity-100'
                }`}><img
                  src={frame.url}
                  alt={frame.name}
                  className="w-full h-full object-cover"
                  loading="lazy"
                /></button>
              ))}
            </div>
          </div>

          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 text-xs font-bold uppercase tracking-[0.12em] text-[var(--text-on-ink-muted)]">
            กดลูกศร ← → เพื่อเลื่อนดูภาพ หรือกด ESC เพื่อปิด
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
