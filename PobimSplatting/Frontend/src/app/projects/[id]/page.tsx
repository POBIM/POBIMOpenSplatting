'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { api, AutoTuningSummary, CameraPose, CameraPosesData, Project, PlyFile, TrainingPreview } from '@/lib/api';
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
  HelpCircle,
  Box,
  Sparkles,
  Flag,
  LucideIcon
} from 'lucide-react';
import { Breadcrumbs } from '@/components/ui';

const CameraPoseVisualization = lazy(() => import('@/components/CameraPoseVisualization'));
const TrainingSplatPreview = lazy(() => import('@/components/TrainingSplatPreview'));

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
const CPU_CHUNK_WORKER_SUGGESTIONS = ['2', '4', '8', '12', '14'];

const HelpLabel = ({ children, tooltip }: { children: string; tooltip: string }) => (
  <span className="brutal-label mb-1 flex items-center gap-1.5">
    <span>{children}</span>
    <span
      tabIndex={0}
      title={tooltip}
      aria-label={tooltip}
      className="group relative inline-flex h-4 w-4 items-center justify-center text-[var(--text-secondary)] outline-none"
    >
      <HelpCircle className="h-3.5 w-3.5" />
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 hidden w-72 -translate-x-1/2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-3 text-left text-xs font-medium normal-case leading-relaxed tracking-normal text-[var(--text-secondary)] shadow-[var(--shadow-md)] group-hover:block group-focus:block">
        {tooltip}
      </span>
    </span>
  </span>
);

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

const formatMetric = (value?: number | null, digits = 1) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return '--';
  }
  return value.toFixed(digits);
};

const formatTuningConfidence = (value?: number | string | null) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${value}`;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return '--';
};

const formatShortTimestamp = (value?: string | null) => {
  if (!value) {
    return '--';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const getAutoTuningBadge = (summary?: AutoTuningSummary | null) => {
  if (!summary) {
    return null;
  }

  const label = summary.active_label
    ?? summary.source_label
    ?? summary.active_snapshot
    ?? summary.mode
    ?? 'auto tuning';

  if (summary.fallback_to_stable) {
    return {
      label,
      tone: 'brutal-badge brutal-badge-warning',
    };
  }

  if ((summary.active_snapshot || summary.mode || '').toLowerCase().includes('tuned')) {
    return {
      label,
      tone: 'brutal-badge brutal-badge-success',
    };
  }

  return {
    label,
    tone: 'brutal-badge brutal-badge-info',
  };
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
  const [liveCameraPoses, setLiveCameraPoses] = useState<CameraPosesData | null>(null);
  const [liveCameraPoseLoading, setLiveCameraPoseLoading] = useState(false);
  const [liveCameraPoseError, setLiveCameraPoseError] = useState<string | null>(null);
  const liveCameraPoseVersionRef = useRef<number | string | null>(null);
  const [selectedSparseCamera, setSelectedSparseCamera] = useState<CameraPose | null>(null);
  const [trainingPreview, setTrainingPreview] = useState<TrainingPreview | null>(null);
  const [trainingPreviewLoading, setTrainingPreviewLoading] = useState(false);
  const [trainingPreviewError, setTrainingPreviewError] = useState<string | null>(null);
  const [retryParams, setRetryParams] = useState({
    // Gaussian Splatting params
    quality_mode: '',
    iterations: '',
    learning_rate: '',
    training_live_preview_interval_percent: '',
    // COLMAP Feature Extraction params
    max_num_features: '',
    max_image_size: '',
    // COLMAP Feature Matching params
    matcher_type: '',
    max_num_matches: '',
    sequential_overlap: '',
    // COLMAP Sparse Reconstruction params
    min_num_matches: '',
    max_num_models: '',
    init_num_trials: '',
    mapper_cpu_threads: '',
    cpu_sparse_registration_profile: '',
    abs_pose_max_error: '',
    abs_pose_min_num_inliers: '',
    abs_pose_min_inlier_ratio: '',
    max_reg_trials: '',
    force_cpu_sparse_reconstruction: true,
    matcher_fallback_retry_type: '',
    sparse_retry_sfm_engine: '',
    // Resolution settings
    extraction_mode: '',
    max_frames: '',
    target_fps: '',
    colmap_resolution: '',
    training_resolution: '',
    use_separate_training_images: false,
    smart_frame_selection: true,
    adaptive_frame_budget: true,
    adaptive_pair_scheduling: true,
    oversample_factor: '',
    replacement_search_radius: '',
    ffmpeg_cpu_workers: '',
  });
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [autoFollowLiveStage, setAutoFollowLiveStage] = useState(true);
  const [autoScrollStageLogs, setAutoScrollStageLogs] = useState(true);
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);
  
  // Download modal states
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [plyFiles, setPlyFiles] = useState<PlyFile[]>([]);
  const [loadingPlyFiles, setLoadingPlyFiles] = useState(false);
  const framework = project?.reconstruction_framework;
  const resourceCoordination = project?.resource_coordination;
  const videoDiagnostics = project?.video_extraction_diagnostics;
  const progressivePlan = framework?.progressive_matching_plan;
  const progressiveCheckpoints = framework?.progressive_matching_checkpoints || [];
  const recoveryHistory = framework?.recovery_history || [];
  const finalProgressiveCheckpoint = progressiveCheckpoints.length > 0
    ? progressiveCheckpoints[progressiveCheckpoints.length - 1]
    : null;
  const adaptiveFrameBudget = videoDiagnostics?.adaptive_frame_budget;
  const candidateQualitySummary = videoDiagnostics?.candidate_quality_summary;
  const smartFrameSelectionEnabled = project?.config?.smart_frame_selection !== false;
  const adaptiveFrameBudgetEnabled = smartFrameSelectionEnabled && project?.config?.adaptive_frame_budget !== false;
  const adaptivePairSchedulingEnabled = project?.config?.adaptive_pair_scheduling !== false;
  const oversampleFactor = videoDiagnostics?.oversample_factor ?? project?.config?.oversample_factor ?? null;
  const requestedOversampleFactor = videoDiagnostics?.requested_oversample_factor ?? project?.config?.oversample_factor ?? null;
  const candidateDensityRatio = videoDiagnostics?.candidate_density_ratio ?? null;
  const effectiveSearchWindow = videoDiagnostics?.search_radius ?? project?.config?.replacement_search_radius ?? null;
  const extractionSummary = project?.config?.extraction_mode === 'fps'
    ? `${project?.config?.target_fps ?? '--'} FPS`
    : project?.config?.extraction_mode === 'target_count'
      ? `${project?.config?.max_frames ?? '--'} target`
      : `${project?.config?.max_frames ?? '--'} max`;
  const videoExtractionDetail = stageDetails['video_extraction'];
  const videoExtractionFramesDone = videoExtractionDetail?.current_item ?? videoDiagnostics?.candidate_count ?? videoDiagnostics?.saved_frames ?? null;
  const videoExtractionFramesTotal = videoExtractionDetail?.total_items ?? videoDiagnostics?.candidate_count ?? videoDiagnostics?.requested_targets ?? null;
  const recoveryLoopSummary = framework?.recovery_loop_summary;
  const effectiveResourceProfile = framework?.resource_profile ?? resourceCoordination;
  const effectiveResourceLane = framework?.resource_lane ?? resourceCoordination?.resource_lane;
  const effectiveLaneState = framework?.resource_lane_state ?? resourceCoordination?.resource_lane_state;
  const effectiveAdmissionReason = framework?.admission_reason ?? resourceCoordination?.admission_reason;
  const effectiveDowngradeReason = framework?.downgrade_reason ?? resourceCoordination?.downgrade_reason;
  const effectiveStartDelay = framework?.estimated_start_delay ?? resourceCoordination?.estimated_start_delay;
  const autoTuningSummary = framework?.auto_tuning_summary ?? resourceCoordination?.auto_tuning_summary ?? project?.auto_tuning_summary;
  const autoTuningBadge = getAutoTuningBadge(autoTuningSummary);
  const tunedRecoveryStepCount = recoveryHistory.filter((step) => step.tuned_decision_used).length;
  const autoTuningSurfaces = autoTuningSummary
    ? [
        { label: 'Extraction', surface: autoTuningSummary.extraction },
        { label: 'Matching', surface: autoTuningSummary.matching },
        { label: 'Recovery', surface: autoTuningSummary.recovery },
        { label: 'Orchestration', surface: autoTuningSummary.orchestration },
        { label: 'Training', surface: autoTuningSummary.training },
        { label: 'Export', surface: autoTuningSummary.export },
      ].filter((entry): entry is { label: string; surface: NonNullable<AutoTuningSummary['extraction']> } =>
        Boolean(entry.surface?.summary || entry.surface?.label || entry.surface?.status),
      )
    : [];
  const sparseModelSummary = framework?.sparse_model_summary;
  const logGroups = useMemo(() => groupLogsByStage(logs, stages), [logs, stages]);
  const runningStageKey = stages.find(s => s.status === 'running')?.key ?? null;
  const stageLogs = useMemo(() => {
    if (!expandedStage) {
      return [] as string[];
    }
    return logGroups.find(group => group.key === expandedStage)?.logs ?? [];
  }, [logGroups, expandedStage]);
  const sparseStage = stages.find(s => s.key === 'sparse_reconstruction');
  const featureExtractionStage = stages.find(s => s.key === 'feature_extraction');
  const trainingStage = stages.find(s => s.key === 'gaussian_splatting');
  const canInspectSparseModel = featureExtractionStage?.status === 'completed' || sparseStage?.status === 'completed';
  const showSparsePoseViewer =
    expandedStage === 'sparse_reconstruction' &&
    (
      sparseStage?.status === 'running' ||
      sparseStage?.status === 'completed' ||
      sparseStage?.status === 'failed' ||
      Boolean(liveCameraPoses)
    );
  const showTrainingPreview =
    expandedStage === 'gaussian_splatting' &&
    (
      trainingStage?.status === 'running' ||
      trainingStage?.status === 'completed' ||
      trainingStage?.status === 'failed' ||
      Boolean(trainingPreview)
    );

  // Auto-expand the running stage
  useEffect(() => {
    if (autoFollowLiveStage && runningStageKey && expandedStage !== runningStageKey) {
      setExpandedStage(runningStageKey);
    }
  }, [autoFollowLiveStage, runningStageKey, expandedStage]);

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

  const loadLiveCameraPoses = useCallback(async (options: { silent?: boolean; retryOnUnchanged?: boolean } = {}) => {
    try {
      if (!options.silent) {
        setLiveCameraPoseLoading(true);
      }
      const data = await api.getCameraPoseManifest(projectId, {
        preferLive: true,
        since: options.silent ? liveCameraPoseVersionRef.current || undefined : undefined,
      });
      if (data?.unchanged) {
        setLiveCameraPoseError(null);
        if (options.retryOnUnchanged) {
          window.setTimeout(() => {
            void loadLiveCameraPoses({ silent: true });
          }, 750);
        }
        return;
      }
      liveCameraPoseVersionRef.current = data.snapshot_version || null;
      setLiveCameraPoses(data);
      setLiveCameraPoseError(null);
      setSelectedSparseCamera((prev) => {
        if (!prev) {
          return null;
        }
        return data.cameras.find((camera: CameraPose) => camera.image_name === prev.image_name) || null;
      });
    } catch (err: any) {
      if (err?.response?.status === 404) {
        setLiveCameraPoseError(null);
        if (!options.silent) {
          setLiveCameraPoses(null);
        }
        return;
      }
      const message =
        err?.response?.data?.error ||
        err?.message ||
        'Failed to load sparse camera poses';
      setLiveCameraPoseError(message);
    } finally {
      if (!options.silent) {
        setLiveCameraPoseLoading(false);
      }
    }
  }, [projectId]);

  const handleSparsePoseUpdate = useCallback((payload: any) => {
    if (!showSparsePoseViewer && !showTrainingPreview) {
      return;
    }
    if (payload?.project_id && payload.project_id !== projectId) {
      return;
    }
    if (
      payload?.snapshot_version &&
      liveCameraPoseVersionRef.current &&
      String(payload.snapshot_version) === String(liveCameraPoseVersionRef.current)
    ) {
      return;
    }
    window.setTimeout(() => {
      void loadLiveCameraPoses({ silent: true, retryOnUnchanged: true });
    }, 250);
  }, [loadLiveCameraPoses, projectId, showSparsePoseViewer, showTrainingPreview]);

  const loadTrainingPreview = useCallback(async (options: { silent?: boolean } = {}) => {
    try {
      if (!options.silent) {
        setTrainingPreviewLoading(true);
      }
      const data = await api.getTrainingPreview(projectId);
      setTrainingPreview((prev) => {
        if (
          prev?.version === data.version &&
          prev?.preview_url === data.preview_url &&
          prev?.progress_percent === data.progress_percent &&
          prev?.iteration === data.iteration &&
          prev?.is_live === data.is_live &&
          prev?.live_preview?.version === data.live_preview?.version &&
          prev?.live_preview?.image_name === data.live_preview?.image_name
        ) {
          return prev;
        }
        return data;
      });
      setTrainingPreviewError(null);
    } catch (err: any) {
      const message =
        err?.response?.data?.error ||
        err?.message ||
        'Failed to load training preview';
      setTrainingPreviewError(message);
    } finally {
      if (!options.silent) {
        setTrainingPreviewLoading(false);
      }
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
    const unsubscribeSparsePose = websocket.on('sparse_pose_update', handleSparsePoseUpdate);

    return () => {
      unsubscribeStatus();
      unsubscribeStage();
      unsubscribeLog();
      unsubscribeSparsePose();
      websocket.unsubscribeFromProject(projectId);
    };
  }, [projectId, handleProjectStatus, handleStageProgress, handleLogMessage, handleSparsePoseUpdate]);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    liveCameraPoseVersionRef.current = null;
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

  useEffect(() => {
    if (!showSparsePoseViewer) {
      return;
    }

    loadLiveCameraPoses();
  }, [showSparsePoseViewer, sparseStage?.status, loadLiveCameraPoses]);

  useEffect(() => {
    if (!showTrainingPreview) {
      return;
    }

    loadTrainingPreview();
    void loadLiveCameraPoses({ silent: true });
    if (trainingStage?.status !== 'running') {
      return;
    }

    const interval = setInterval(() => {
      void loadTrainingPreview({ silent: true });
    }, 5000);

    return () => clearInterval(interval);
  }, [showTrainingPreview, trainingStage?.status, loadTrainingPreview, loadLiveCameraPoses]);

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
    if (!expandedStage || !autoScrollStageLogs) {
      return;
    }
    const node = stageLogsRef.current;
    if (node && stageLogs.length > 0) {
      node.scrollTop = node.scrollHeight;
    }
  }, [stageLogs, expandedStage, autoScrollStageLogs]);

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
        params.adaptive_frame_budget = retryParams.adaptive_frame_budget;
        params.adaptive_pair_scheduling = retryParams.adaptive_pair_scheduling;
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
        if (retryParams.matcher_type) {
          params.matcher_type = retryParams.matcher_type;
        }
        params.adaptive_pair_scheduling = retryParams.adaptive_pair_scheduling;
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
        if (retryParams.init_num_trials) {
          params.init_num_trials = parseInt(retryParams.init_num_trials);
        }
        if (retryParams.mapper_cpu_threads) {
          params.mapper_cpu_threads = parseInt(retryParams.mapper_cpu_threads);
        }
        if (retryParams.cpu_sparse_registration_profile) {
          params.cpu_sparse_registration_profile = retryParams.cpu_sparse_registration_profile;
        }
        if (retryParams.abs_pose_max_error) {
          params.abs_pose_max_error = parseFloat(retryParams.abs_pose_max_error);
        }
        if (retryParams.abs_pose_min_num_inliers) {
          params.abs_pose_min_num_inliers = parseInt(retryParams.abs_pose_min_num_inliers);
        }
        if (retryParams.abs_pose_min_inlier_ratio) {
          params.abs_pose_min_inlier_ratio = parseFloat(retryParams.abs_pose_min_inlier_ratio);
        }
        if (retryParams.max_reg_trials) {
          params.max_reg_trials = parseInt(retryParams.max_reg_trials);
        }
        if (retryParams.force_cpu_sparse_reconstruction) {
          params.force_cpu_sparse_reconstruction = true;
        }
        if (retryParams.matcher_fallback_retry_type) {
          params.matcher_fallback_retry_type = retryParams.matcher_fallback_retry_type;
        }
        if (retryParams.sparse_retry_sfm_engine) {
          params.sparse_retry_sfm_engine = retryParams.sparse_retry_sfm_engine;
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
        if (retryParams.training_live_preview_interval_percent) {
          params.training_live_preview_interval_percent = parseInt(retryParams.training_live_preview_interval_percent);
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
        training_live_preview_interval_percent: '',
        matcher_type: '',
        max_num_features: '',
        max_image_size: '',
        max_num_matches: '',
        sequential_overlap: '',
        min_num_matches: '',
        max_num_models: '',
        init_num_trials: '',
        mapper_cpu_threads: '',
        cpu_sparse_registration_profile: '',
        abs_pose_max_error: '',
        abs_pose_min_num_inliers: '',
        abs_pose_min_inlier_ratio: '',
        max_reg_trials: '',
        force_cpu_sparse_reconstruction: true,
        matcher_fallback_retry_type: '',
        sparse_retry_sfm_engine: '',
        extraction_mode: '',
        max_frames: '',
        target_fps: '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        smart_frame_selection: true,
        adaptive_frame_budget: true,
        adaptive_pair_scheduling: true,
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
        training_live_preview_interval_percent:
          project?.config?.training_live_preview_interval_percent?.toString() || '',
        matcher_type: project?.config?.matcher_type || '',
        max_num_features: '',
        max_image_size: '',
        max_num_matches: '',
        sequential_overlap: '',
        min_num_matches: '',
        max_num_models: '',
        init_num_trials: '',
        mapper_cpu_threads: project?.config?.mapper_cpu_threads?.toString() || '',
        cpu_sparse_registration_profile: project?.config?.cpu_sparse_registration_profile || '',
        abs_pose_max_error: '',
        abs_pose_min_num_inliers: '',
        abs_pose_min_inlier_ratio: '',
        max_reg_trials: '',
        force_cpu_sparse_reconstruction:
          project?.config?.force_cpu_sparse_reconstruction !== false,
        matcher_fallback_retry_type: project?.config?.matcher_fallback_retry_type || '',
        sparse_retry_sfm_engine: '',
        extraction_mode: project?.config?.extraction_mode || '',
        max_frames: project?.config?.max_frames?.toString() || '',
        target_fps: project?.config?.target_fps?.toString() || '',
        colmap_resolution: '',
        training_resolution: '',
        use_separate_training_images: false,
        smart_frame_selection: project?.config?.smart_frame_selection !== false,
        adaptive_frame_budget: project?.config?.adaptive_frame_budget !== false,
        adaptive_pair_scheduling: project?.config?.adaptive_pair_scheduling !== false,
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
  const trainingBudgetSummary = framework?.training_budget_summary;
  const resolvedTrainingIterations = typeof project?.config?.iterations === 'number'
    ? project.config.iterations
    : undefined;
  const resolvedTrainingImageBudget = trainingBudgetSummary?.effective_image_budget
    ?? resourceCoordination?.capture_budget_summary?.num_images
    ?? videoDiagnostics?.saved_frames
    ?? (project.input_type === 'images' ? fileCount : undefined);
  const resolvedTrainingVisits = resolvedTrainingIterations && resolvedTrainingImageBudget
    ? Math.round((resolvedTrainingIterations / Math.max(resolvedTrainingImageBudget, 1)) * 10) / 10
    : null;
  const hasResolvedTrainingPlan = Boolean(
    resolvedTrainingIterations
    || resolvedTrainingImageBudget
    || trainingBudgetSummary?.training_resolution
    || trainingBudgetSummary?.colmap_resolution
  );
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
            <div className="brutal-container space-y-3">
              <Breadcrumbs items={[
                { label: 'Projects', href: '/projects' },
                { label: project?.metadata?.name || 'Project Details' }
              ]} />

              <div className="brutal-card-dark relative overflow-hidden px-4 py-3 md:px-5">
                <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
                <div className="relative flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="brutal-eyebrow">Project Detail</span>
                      <span className={getStatusBadgeClass(project.status)}>{project.status || 'unknown'}</span>
                    </div>
                    <div className="flex items-start gap-3">
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
                      <div key={tile.label} className="border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] px-3 py-2 shadow-[3px_3px_0_var(--paper-muted-2)]">
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
            <div className="brutal-container space-y-3">
              {(project.status === 'processing' || canRetryProject || project.status === 'completed') && (
                <div className="space-y-3">
                  <div className="grid gap-3 xl:grid-cols-[1.35fr_0.65fr]">
                    <div className={project.status === 'processing' ? 'brutal-card-dark p-3 md:p-4' : 'brutal-card p-3 md:p-4'}>
                      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className={`mb-2 text-[11px] font-bold uppercase tracking-[0.18em] ${project.status === 'processing' ? 'text-[var(--text-on-ink-muted)]' : 'text-[var(--text-secondary)]'}`}>
                            Status + Progress
                          </p>
                          <div className="flex flex-wrap items-end gap-3">
                            <span className={`text-3xl font-black uppercase leading-none tracking-tight ${project.status === 'processing' ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}`}>
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
                          className={`h-3 transition-all duration-500 ${project.status === 'processing' ? 'bg-[var(--ink-600)]' : 'bg-[var(--ink)]'}`}
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

                    <div className="brutal-card p-3 md:p-4">
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

                  {hasResolvedTrainingPlan && (
                    <div className="brutal-card-muted p-3 md:p-4">
                      <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="brutal-label mb-1">Resolved Training Plan</p>
                          <h2 className="brutal-h3">Upload-Time Budget</h2>
                          <p className="mt-1 text-xs text-[var(--text-secondary)]">
                            This project started with the adaptive training budget resolved at upload time and persisted into the run config.
                          </p>
                        </div>
                        {resolvedTrainingVisits !== null && (
                          <span className="brutal-badge brutal-badge-info">
                            {resolvedTrainingVisits.toLocaleString(undefined, { maximumFractionDigits: 1 })} visits/image
                          </span>
                        )}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                        <div className="brutal-card p-4">
                          <p className="brutal-label mb-2">Iterations</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {resolvedTrainingIterations ? resolvedTrainingIterations.toLocaleString() : '--'}
                          </p>
                        </div>
                        <div className="brutal-card-muted p-4">
                          <p className="brutal-label mb-2">Image Budget</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {resolvedTrainingImageBudget ? resolvedTrainingImageBudget.toLocaleString() : '--'}
                          </p>
                        </div>
                        <div className="brutal-card p-4">
                          <p className="brutal-label mb-2">Refine Every</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {project?.config?.refine_every ? `${project.config.refine_every}` : '--'}
                          </p>
                        </div>
                        <div className="brutal-card-muted p-4">
                          <p className="brutal-label mb-2">Warmup</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {project?.config?.warmup_length ? `${project.config.warmup_length}` : '--'}
                          </p>
                        </div>
                        <div className="brutal-card p-4">
                          <p className="brutal-label mb-2">SSIM Weight</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {typeof project?.config?.ssim_weight === 'number' ? formatMetric(project.config.ssim_weight, 2) : '--'}
                          </p>
                        </div>
                        <div className="brutal-card-muted p-4">
                          <p className="brutal-label mb-2">Densify Grad</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">
                            {typeof project?.config?.densify_grad_threshold === 'number' ? formatMetric(project.config.densify_grad_threshold, 5) : '--'}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4 text-sm text-[var(--text-secondary)]">
                        Quality {project?.config?.quality_mode || project?.quality_mode || '--'}
                        {' • '}
                        {trainingBudgetSummary?.colmap_resolution ?? project?.config?.colmap_resolution ?? '--'} COLMAP
                        {' -> '}
                        {trainingBudgetSummary?.training_resolution ?? project?.config?.training_resolution ?? '--'} training
                        {' • '}
                        live preview every {project?.config?.training_live_preview_interval_percent ?? '--'}%
                        {trainingBudgetSummary?.uses_repaired_capture ? ` • repaired capture (${trainingBudgetSummary.repair_step_count ?? 0} step)` : ' • clean capture'}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {(framework || progressivePlan || progressiveCheckpoints.length > 0 || effectiveResourceProfile || recoveryLoopSummary || autoTuningSummary || videoDiagnostics) && (
                <details className="brutal-card-muted p-3 md:p-4">
                  <summary className="cursor-pointer text-sm font-black uppercase tracking-[0.14em] text-[var(--ink)]">
                    Advanced Run Details
                    <span className="ml-2 text-[11px] font-bold text-[var(--text-secondary)]">
                      policy, resources, extraction diagnostics
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3">
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
                        <p className="mt-2 text-xs text-[var(--text-secondary)]">
                          overlap {framework.matcher_params?.['SequentialMatching.overlap'] || '--'} • quadratic {framework.matcher_params?.['SequentialMatching.quadratic_overlap'] || '--'} • adaptive {adaptivePairSchedulingEnabled ? 'on' : 'off'}
                        </p>
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

              <div className="brutal-card-muted p-4 md:p-5">
                <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="brutal-label mb-1">Execution Policy</p>
                    <h2 className="brutal-h3">CPU-First Ordered Video</h2>
                    <p className="mt-2 text-sm text-[var(--text-secondary)]">
                      Ordered video and orbit-style captures stay on the conservative incremental COLMAP path by default.
                      GPU remains active for extraction, training, unordered photo sets, and explicit sparse retry overrides.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="brutal-badge brutal-badge-warning">
                      default {framework?.capture_pattern?.looks_like_video_orbit || project?.input_type === 'video' ? 'CPU incremental' : 'policy-driven'}
                    </span>
                    <span className="brutal-badge brutal-badge-info">GPU retry available</span>
                  </div>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="brutal-card p-4">
                    <p className="brutal-label mb-2">Ordered Video</p>
                    <p className="text-sm font-bold uppercase text-[var(--ink)]">Incremental COLMAP</p>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">Stable default for sequential, orbit, and video-like captures.</p>
                  </div>
                  <div className="brutal-card-muted p-4">
                    <p className="brutal-label mb-2">Adaptive Control</p>
                    <p className="text-sm font-bold uppercase text-[var(--ink)]">Budget + Recovery</p>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">Auto-tuning can tighten extraction and recovery thresholds without silently switching the mapper family.</p>
                  </div>
                  <div className="brutal-card p-4">
                    <p className="brutal-label mb-2">GPU Path</p>
                    <p className="text-sm font-bold uppercase text-[var(--ink)]">Retry Or Photos</p>
                    <p className="mt-2 text-xs text-[var(--text-secondary)]">Use sparse retry overrides or unordered photo policies when you want global/GPU reconstruction.</p>
                  </div>
                </div>
              </div>

              {(progressivePlan || progressiveCheckpoints.length > 0) && (
                <div className="grid gap-4 xl:grid-cols-[0.92fr_1.08fr]">
                  <div className="brutal-card p-4 md:p-5">
                    <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="brutal-label mb-1">Adaptive Matching</p>
                        <h2 className="brutal-h3">Progressive Pair Schedule</h2>
                        <p className="mt-2 text-sm text-[var(--text-secondary)]">Sequential matching now expands in checkpoints instead of jumping straight to the heaviest ordered-video pass.</p>
                      </div>
                      {progressivePlan?.resource_tier && <span className="brutal-badge brutal-badge-info">{progressivePlan.resource_tier}</span>}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      {[
                        ['Passes', progressivePlan?.passes?.length ?? '--'],
                        ['Completed', progressiveCheckpoints.length || '--'],
                        ['Final overlap', progressivePlan?.final_overlap ?? framework?.matcher_params?.['SequentialMatching.overlap'] ?? '--'],
                        ['Verified pairs', finalProgressiveCheckpoint?.verified_pairs ?? '--'],
                      ].map(([label, value]) => (
                        <div key={label} className="brutal-card-muted p-4">
                          <p className="brutal-label mb-2">{label}</p>
                          <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">{value}</p>
                        </div>
                      ))}
                    </div>

                    {progressivePlan?.reason && (
                      <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] p-4 text-sm text-[var(--text-secondary)]">
                        {progressivePlan.reason}
                      </div>
                    )}

                    {!!progressivePlan?.passes?.length && (
                      <div className="mt-3 space-y-2">
                        {progressivePlan.passes.map((pass, index) => (
                          <div key={pass.key || `${pass.label}-${index}`} className="flex items-center justify-between gap-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm">
                            <div>
                              <p className="font-black uppercase tracking-tight text-[var(--ink)]">{index + 1}. {pass.label || pass.key || 'pass'}</p>
                              <p className="text-xs text-[var(--text-secondary)]">{pass.checkpoint_note || 'No note'}</p>
                            </div>
                            <div className="text-right text-xs text-[var(--text-secondary)]">
                              <p>overlap {pass.matcher_params?.['SequentialMatching.overlap'] || '--'}</p>
                              <p>matches {pass.max_num_matches ?? '--'}</p>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="brutal-card-muted p-4 md:p-5">
                    <p className="brutal-label mb-3">Checkpoint Outcomes</p>
                    <div className="space-y-2">
                      {progressiveCheckpoints.map((checkpoint, index) => (
                        <div key={`${checkpoint.key || checkpoint.label || 'checkpoint'}-${index}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">{checkpoint.label || checkpoint.key || `pass ${index + 1}`}</p>
                              <p className="mt-1 text-xs text-[var(--text-secondary)]">max matches {checkpoint.max_num_matches ?? '--'} • verified {checkpoint.verified_pairs ?? '--'}</p>
                            </div>
                            <span className="brutal-badge">{index + 1}/{progressiveCheckpoints.length}</span>
                          </div>
                          <div className="mt-3 grid gap-2 sm:grid-cols-4 text-sm text-[var(--text-secondary)]">
                            <div className="flex items-center justify-between gap-2"><span>Bridge p10</span><span className="font-bold text-[var(--ink)]">{checkpoint.geometry_stats?.bridge_p10 ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-2"><span>Bridge min</span><span className="font-bold text-[var(--ink)]">{checkpoint.geometry_stats?.bridge_min ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-2"><span>Weak</span><span className="font-bold text-[var(--ink)]">{checkpoint.geometry_stats?.weak_boundary_count ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-2"><span>Weak ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(checkpoint.geometry_stats?.weak_boundary_ratio)}</span></div>
                          </div>
                        </div>
                      ))}
                      {progressiveCheckpoints.length === 0 && (
                        <div className="brutal-card p-4 text-sm text-[var(--text-secondary)]">No progressive matching checkpoints were persisted for this run.</div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {(effectiveResourceProfile || recoveryLoopSummary || autoTuningSummary) && (
                <div className={`grid gap-4 ${autoTuningSummary ? 'xl:grid-cols-3' : 'xl:grid-cols-[0.95fr_1.05fr]'}`}>
                  {effectiveResourceProfile && (
                    <div className="brutal-card p-4 md:p-5">
                      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="brutal-label mb-1">Resource Lane</p>
                          <h2 className="brutal-h3">Project Resource Profile</h2>
                          <p className="mt-2 text-sm text-[var(--text-secondary)]">
                            Machine-aware lane selection for ordered-video heavy stages.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {effectiveResourceLane && <span className="brutal-badge brutal-badge-info">{effectiveResourceLane}</span>}
                          {effectiveLaneState && <span className="brutal-badge">{effectiveLaneState}</span>}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        {[
                          ['Profile', effectiveResourceProfile.profile_class ?? '--'],
                          ['GPU', effectiveResourceProfile.gpu_model ?? '--'],
                          ['VRAM', effectiveResourceProfile.gpu_vram_mb ? `${effectiveResourceProfile.gpu_vram_mb} MB` : '--'],
                          ['Delay', effectiveStartDelay ? `${effectiveStartDelay}s` : '--'],
                          ['Lane state', effectiveLaneState ?? '--'],
                        ].map(([label, value]) => (
                          <div key={label} className="brutal-card-muted p-4">
                            <p className="brutal-label mb-2">{label}</p>
                            <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">{value}</p>
                          </div>
                        ))}
                      </div>

                      {(effectiveAdmissionReason || effectiveDowngradeReason) && (
                        <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] p-4 text-sm text-[var(--text-secondary)]">
                          {effectiveAdmissionReason || 'No admission note'}
                          {effectiveDowngradeReason ? ` • downgrade=${effectiveDowngradeReason}` : ''}
                        </div>
                      )}

                      {framework?.training_budget_summary && (
                        <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4 text-sm text-[var(--text-secondary)]">
                          Training context: {framework.training_budget_summary.colmap_resolution ?? '--'} COLMAP → {framework.training_budget_summary.training_resolution ?? '--'} train
                          {framework.training_budget_summary.uses_repaired_capture ? ` • repaired capture (${framework.training_budget_summary.repair_step_count ?? 0} step)` : ' • clean capture'}
                        </div>
                      )}
                    </div>
                  )}

                  {autoTuningSummary && (
                    <div className="brutal-card p-4 md:p-5">
                      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="brutal-label mb-1">Policy Source</p>
                          <h2 className="brutal-h3">Auto-Tuning Summary</h2>
                          <p className="mt-2 text-sm text-[var(--text-secondary)]">
                            Stable-vs-tuned visibility for decisions derived from prior runtime evidence.
                          </p>
                        </div>
                        {autoTuningBadge && <span className={autoTuningBadge.tone}>{autoTuningBadge.label}</span>}
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {[
                          ['Runs', autoTuningSummary.derived_from_runs ?? '--'],
                          ['Confidence', formatTuningConfidence(autoTuningSummary.confidence)],
                          ['Tuned values', autoTuningSummary.tuned_value_count ?? '--'],
                          ['Schema', autoTuningSummary.schema_version ?? '--'],
                          ['Stable snapshot', autoTuningSummary.stable_snapshot_version ?? '--'],
                          ['Updated', formatShortTimestamp(autoTuningSummary.last_updated_at)],
                        ].map(([label, value]) => (
                          <div key={label} className="brutal-card-muted p-4">
                            <p className="brutal-label mb-2">{label}</p>
                            <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">{value}</p>
                          </div>
                        ))}
                      </div>

                      {(autoTuningSummary.summary || autoTuningSummary.source_label || autoTuningSummary.fallback_reason) && (
                        <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] p-4 text-sm text-[var(--text-secondary)]">
                          {autoTuningSummary.summary || autoTuningSummary.source_label || 'No tuning summary recorded'}
                          {autoTuningSummary.fallback_reason ? ` • fallback=${autoTuningSummary.fallback_reason}` : ''}
                        </div>
                      )}

                      {!!autoTuningSummary.guardrails_applied?.length && (
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                          {autoTuningSummary.guardrails_applied.slice(0, 6).map((guardrail, index) => (
                            <span key={`${guardrail}-${index}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-2 py-1">
                              {guardrail}
                            </span>
                          ))}
                        </div>
                      )}

                      {autoTuningSurfaces.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {autoTuningSurfaces.map(({ label, surface }) => (
                            <div key={label} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">{label}</p>
                                <div className="flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[0.16em]">
                                  {surface.label && <span className="brutal-badge brutal-badge-info">{surface.label}</span>}
                                  {surface.status && <span className="brutal-badge">{surface.status}</span>}
                                  {surface.tuned ? <span className="brutal-badge brutal-badge-success">tuned</span> : <span className="brutal-badge">stable</span>}
                                </div>
                              </div>
                              <p className="mt-2 text-sm text-[var(--text-secondary)]">{surface.summary || 'No tuning summary recorded for this surface.'}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {recoveryLoopSummary && (
                    <div className="brutal-card-muted p-4 md:p-5">
                      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div>
                          <p className="brutal-label mb-1">Recovery Outcome</p>
                          <h2 className="brutal-h3">Deterministic Loop Summary</h2>
                          <p className="mt-2 text-sm text-[var(--text-secondary)]">
                            Final repair path chosen after progressive matching and local repair passes.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {recoveryLoopSummary.final_path && <span className="brutal-badge brutal-badge-warning">{recoveryLoopSummary.final_path}</span>}
                          {tunedRecoveryStepCount > 0 && <span className="brutal-badge brutal-badge-success">tuned steps {tunedRecoveryStepCount}</span>}
                        </div>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm text-[var(--text-secondary)]">
                        <div className="flex items-center justify-between gap-2"><span>State</span><span className="font-bold text-[var(--ink)]">{recoveryLoopSummary.state ?? '--'}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Local repairs</span><span className="font-bold text-[var(--ink)]">{recoveryLoopSummary.local_repair_count ?? '--'}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Weak left</span><span className="font-bold text-[var(--ink)]">{recoveryLoopSummary.unresolved_weak_boundary_count ?? '--'}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Registered ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(sparseModelSummary?.registered_ratio)}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Best registered</span><span className="font-bold text-[var(--ink)]">{sparseModelSummary?.best_registered ?? '--'}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Models</span><span className="font-bold text-[var(--ink)]">{sparseModelSummary?.model_count ?? '--'}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Zero ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(framework?.pair_geometry_stats?.zero_boundary_ratio)}</span></div>
                        <div className="flex items-center justify-between gap-2"><span>Reason code</span><span className="font-bold text-[var(--ink)]">{recoveryLoopSummary.final_reason_code ?? '--'}</span></div>
                      </div>

                      {!!recoveryLoopSummary.precedence?.length && (
                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                          {recoveryLoopSummary.precedence.map((item, index) => (
                            <span key={`${item}-${index}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-2 py-1">
                              {index + 1}. {item}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {recoveryHistory.length > 0 && (
                <div className="brutal-card p-4 md:p-5">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-label mb-1">Recovery Loop</p>
                      <h2 className="brutal-h3">Targeted Repair History</h2>
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Narrow retries that ran after baseline matching or sparse reconstruction started to split.
                      </p>
                    </div>
                    <span className="brutal-badge brutal-badge-warning">{recoveryHistory.length} step{recoveryHistory.length > 1 ? 's' : ''}</span>
                  </div>

                  <div className="space-y-2">
                    {recoveryHistory.map((step, index) => (
                      <div key={`${step.kind || step.label || 'recovery'}-${index}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <p className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">
                              {step.label || step.kind || `recovery ${index + 1}`}
                            </p>
                            <p className="mt-1 text-xs text-[var(--text-secondary)]">
                              {step.reason || 'No recovery note'}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2 text-[11px] font-bold uppercase tracking-[0.16em]">
                            {step.status && <span className="brutal-badge">{step.status}</span>}
                            {step.outcome && <span className="brutal-badge brutal-badge-warning">{step.outcome}</span>}
                            {step.reason_code && <span className="brutal-badge brutal-badge-info">{step.reason_code}</span>}
                            {step.tuned_decision_used ? <span className="brutal-badge brutal-badge-success">tuned</span> : null}
                            {step.runtime_mode && <span className="brutal-badge">{step.runtime_mode}</span>}
                            {step.subset_image_count ? <span className="brutal-badge brutal-badge-info">subset {step.subset_image_count}</span> : null}
                            {step.pair_targeted ? <span className="brutal-badge brutal-badge-info">pairs {step.pair_count ?? '--'}</span> : null}
                            {step.pair_budget_capped ? <span className="brutal-badge brutal-badge-warning">cap {step.pair_budget_cap ?? '--'}</span> : null}
                          </div>
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-3 xl:grid-cols-6 text-sm text-[var(--text-secondary)]">
                          <div className="flex items-center justify-between gap-2"><span>Weak boundaries</span><span className="font-bold text-[var(--ink)]">{step.weak_boundary_count ?? step.geometry_stats?.weak_boundary_count ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Targets</span><span className="font-bold text-[var(--ink)]">{step.target_boundary_count ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Survivors</span><span className="font-bold text-[var(--ink)]">{step.surviving_target_boundary_count ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Padding</span><span className="font-bold text-[var(--ink)]">{step.padding ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Overlap</span><span className="font-bold text-[var(--ink)]">{step.overlap ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Bridge p10</span><span className="font-bold text-[var(--ink)]">{step.geometry_stats?.bridge_p10 ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Bridge min</span><span className="font-bold text-[var(--ink)]">{step.geometry_stats?.bridge_min ?? '--'}</span></div>
                          <div className="flex items-center justify-between gap-2"><span>Weak ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(step.geometry_stats?.weak_boundary_ratio)}</span></div>
                        </div>
                        {!!step.surviving_target_boundaries?.length && (
                          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                            {step.surviving_target_boundaries.slice(0, 6).map((boundary, boundaryIndex) => (
                              <span key={`${boundary.key || 'boundary'}-${boundaryIndex}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] px-2 py-1">
                                {boundary.left_image_name || '?'}→{boundary.right_image_name || '?'}
                                {boundary.severity_label ? ` • ${boundary.severity_label}` : ''}
                                {boundary.target_segment_frames ? ` • target ${boundary.target_segment_frames}` : ''}
                                {boundary.cross_radius ? ` • cross ${boundary.cross_radius}` : ''}
                                {boundary.local_radius ? ` • local ${boundary.local_radius}` : ''}
                                {boundary.pair_count ? ` • pairs ${boundary.pair_count}` : ''}
                                {boundary.pair_budget_capped ? ` • cap ${boundary.pair_budget_cap ?? '--'}` : ''}
                                {boundary.inserted_frame_count ? ` • +${boundary.inserted_frame_count}` : ''}
                                {boundary.outcome ? ` • ${boundary.outcome}` : ''}
                              </span>
                            ))}
                          </div>
                        )}
                        {(step.failed_step_key || step.fallback_step || step.fallback_reason) && (
                          <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                            failed step {step.failed_step_key ?? '--'} • fallback {step.fallback_step ?? '--'}
                            {step.fallback_reason ? ` • ${step.fallback_reason}` : ''}
                          </div>
                        )}
                        {!step.surviving_target_boundaries?.length && step.target_boundary_count && step.kind === 'weak_window_subset' && (
                          <div className="mt-3 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                            subset rematch cleared every targeted weak boundary, so densification did not need to use this step as a source window
                          </div>
                        )}
                      </div>
                    ))}
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
                        ['Density', candidateDensityRatio ? `${formatMetric(candidateDensityRatio, 2)}x` : '--'],
                      ].map(([label, value]) => (
                        <div key={label} className="brutal-card p-4">
                          <p className="brutal-label mb-2">{label}</p>
                          <p className="text-lg font-black uppercase tracking-tight text-[var(--ink)]">{value}</p>
                        </div>
                      ))}
                    </div>

                    {(adaptiveFrameBudget || candidateQualitySummary) && (
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <div className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                          <h3 className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">Adaptive Budget</h3>
                          <div className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
                            <div className="flex items-center justify-between gap-3"><span>Status</span><span className="font-bold text-[var(--ink)]">{adaptiveFrameBudgetEnabled ? 'on' : 'off'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Requested oversample</span><span className="font-bold text-[var(--ink)]">{requestedOversampleFactor ?? '--'}x</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Effective oversample</span><span className="font-bold text-[var(--ink)]">{oversampleFactor ?? '--'}x</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Density scale</span><span className="font-bold text-[var(--ink)]">{adaptiveFrameBudget?.density_scale ? `${formatMetric(adaptiveFrameBudget.density_scale, 2)}x` : '--'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Codec</span><span className="font-bold text-[var(--ink)]">{adaptiveFrameBudget?.video_profile?.codec_name?.toUpperCase() || '--'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Duration</span><span className="font-bold text-[var(--ink)]">{adaptiveFrameBudget?.video_profile?.duration ? `${formatMetric(adaptiveFrameBudget.video_profile.duration, 1)}s` : '--'}</span></div>
                          </div>
                          {!!adaptiveFrameBudget?.adjustments?.length && (
                            <div className="mt-3 space-y-2">
                              {adaptiveFrameBudget.adjustments.slice(0, 4).map((adjustment, index) => (
                                <div key={`${adjustment.code || 'adjustment'}-${index}`} className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] px-3 py-2 text-xs text-[var(--text-secondary)]">
                                  <p className="font-bold uppercase text-[var(--ink)]">{adjustment.code || 'adjustment'} • {adjustment.factor ?? '--'}x</p>
                                  <p className="mt-1">{adjustment.reason || 'No reason recorded'}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-4">
                          <h3 className="text-sm font-black uppercase tracking-tight text-[var(--ink)]">Preview Quality</h3>
                          <div className="mt-3 space-y-2 text-sm text-[var(--text-secondary)]">
                            <div className="flex items-center justify-between gap-3"><span>Accepted ratio</span><span className="font-bold text-[var(--ink)]">{formatPercent(candidateQualitySummary?.accepted_ratio)}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Accepted frames</span><span className="font-bold text-[var(--ink)]">{candidateQualitySummary?.accepted_total ?? '--'}/{candidateQualitySummary?.candidate_total ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Median sharpness</span><span className="font-bold text-[var(--ink)]">{candidateQualitySummary?.median_sharpness ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>P25 sharpness</span><span className="font-bold text-[var(--ink)]">{candidateQualitySummary?.p25_sharpness ?? '--'}</span></div>
                            <div className="flex items-center justify-between gap-3"><span>Median brightness</span><span className="font-bold text-[var(--ink)]">{candidateQualitySummary?.median_brightness ?? '--'}</span></div>
                          </div>
                        </div>
                      </div>
                    )}
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
                  </div>
                </details>
              )}

              {(project?.input_type === 'video' || project?.input_type === 'mixed') && (
                <div className="brutal-card p-3 md:p-4">
                  <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-label mb-1">Live Extraction</p>
                      <h2 className="brutal-h3">Frame Sampling Monitor</h2>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">ติดตามจำนวนภาพที่ถูกถอดจากวิดีโอแบบ realtime ระหว่าง stage extract</p>
                    </div>
                    <span className="brutal-badge brutal-badge-info">{smartFrameSelectionEnabled ? `window ±${effectiveSearchWindow ?? '--'}` : 'oversample off'}</span>
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                    {[
                      ['Extracted', videoExtractionFramesDone ?? '--'],
                      ['Target', videoExtractionFramesTotal ?? '--'],
                      ['Resolution', project?.config?.colmap_resolution || '--'],
                      ['Sampling', extractionSummary],
                      ['Oversample', smartFrameSelectionEnabled ? `${oversampleFactor ?? '--'}x` : 'Disabled'],
                    ].map(([label, value], index) => (
                        <div key={label} className={index % 2 === 0 ? 'brutal-card-muted p-3' : 'brutal-card p-3'}>
                        <p className="brutal-label mb-1">{label}</p>
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

              <div className="brutal-card p-3 md:p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <p className="brutal-label mb-1">Pipeline</p>
                    <h2 className="brutal-h3">Processing Stages</h2>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const nextAutoFollow = !autoFollowLiveStage;
                        setAutoFollowLiveStage(nextAutoFollow);
                        if (nextAutoFollow && runningStageKey) {
                          setExpandedStage(runningStageKey);
                        }
                      }}
                      className={`brutal-btn brutal-btn-xs ${autoFollowLiveStage ? 'brutal-btn-primary' : ''}`}
                      title={autoFollowLiveStage ? 'Auto-follow running stage is on' : 'Auto-follow running stage is off'}
                    >
                      {autoFollowLiveStage ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                      Auto Stage {autoFollowLiveStage ? 'On' : 'Off'}
                    </button>
                    <span className="brutal-badge">{stages.filter((stage) => stage.status === 'completed').length}/{PIPELINE_STAGES.length} done</span>
                  </div>
                </div>

                <div className="grid gap-2 md:grid-cols-4 xl:grid-cols-8">
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
                      onClick={() => {
                        if (autoFollowLiveStage && (isExpanded || stageConfig.key !== runningStageKey)) {
                          setAutoFollowLiveStage(false);
                        }
                        setExpandedStage(isExpanded ? null : stageConfig.key);
                      }}
                      className={`text-left ${isRunning || isExpanded ? 'brutal-card-dark' : stage.status === 'pending' ? 'brutal-card-muted' : 'brutal-card'} p-2.5 transition-transform hover:-translate-x-[2px] hover:-translate-y-[2px]`}><div className="mb-2 flex items-start justify-between gap-2">
                        <div className={`flex h-8 w-8 items-center justify-center border-[var(--border-w)] ${isRunning || isExpanded ? 'border-[var(--paper)] bg-[var(--paper)] text-[var(--ink)]' : 'border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)]'}`}>
                          {stage.status === 'pending' ? <stageConfig.Icon className="h-4 w-4" /> : getStageIcon(stage)}
                        </div>
                        <span className={stageBadgeClass}>{stage.status}</span>
                      </div>
                      <p className={`mb-1.5 text-xs font-black uppercase tracking-tight ${isRunning || isExpanded ? 'text-[var(--text-on-ink)]' : 'text-[var(--ink)]'}`}>
                        {getStageLabelForEngine(stageConfig.key, project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig.label}
                      </p>
                      <div className={`mb-1.5 border p-0.5 ${isRunning || isExpanded ? 'border-[var(--paper)] bg-[var(--paper)]' : 'border-[var(--ink)] bg-[var(--paper-muted-2)]'}`}>
                        <div className={`h-1.5 ${isRunning || isExpanded ? 'bg-[var(--ink-600)]' : 'bg-[var(--ink)]'}`} style={{ width: `${progress}%` }} />
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
                    <div className="mt-3 grid gap-3 xl:grid-cols-[0.95fr_1.05fr]">
                      <div className="brutal-card-dark p-3">
                        <div className="mb-3 flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div className="flex h-9 w-9 items-center justify-center border-[var(--border-w)] border-[var(--paper)] bg-[var(--paper)] text-[var(--ink)]">
                              {stageConfig?.Icon && <stageConfig.Icon className="h-5 w-5" />}
                            </div>
                            <div>
                              <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-on-ink-muted)]">Expanded Stage</p>
                              <h3 className="text-base font-black uppercase tracking-tight text-[var(--text-on-ink)]">{getStageLabelForEngine(stageConfig?.key || '', project?.config?.sfm_engine, project?.config?.feature_method) || stageConfig?.label}</h3>
                              <p className="mt-1 text-xs text-[var(--text-on-ink-muted)]">
                                {stage.status === 'completed' ? 'Completed' :
                                 stage.status === 'running' ? `In progress (${progress}%)` :
                                 stageCancelled ? 'Cancelled' :
                                 stageErrored ? 'Failed' :
                                 'Pending'}
                              </p>
                            </div>
                          </div>
                          <button type="button" onClick={() => {
                            if (autoFollowLiveStage) {
                              setAutoFollowLiveStage(false);
                            }
                            setExpandedStage(null);
                          }} className="brutal-btn brutal-btn-xs"><XCircle className="h-4 w-4" />
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

                      <div className="brutal-card-muted p-3">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="brutal-label">Step Breakdown</p>
                            {stage.status === 'running' && (
                              <span className="brutal-badge brutal-badge-success brutal-pulse">Live</span>
                            )}
                            <span className="brutal-badge">{stageLogs.length.toLocaleString()} lines</span>
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                const nextAutoScroll = !autoScrollStageLogs;
                                setAutoScrollStageLogs(nextAutoScroll);
                                if (nextAutoScroll) {
                                  window.requestAnimationFrame(() => {
                                    const node = stageLogsRef.current;
                                    if (node) {
                                      node.scrollTop = node.scrollHeight;
                                    }
                                  });
                                }
                              }}
                              className={`brutal-btn brutal-btn-xs ${autoScrollStageLogs ? 'brutal-btn-primary' : ''}`}
                              title={autoScrollStageLogs ? 'Auto-scroll logs is on' : 'Auto-scroll logs is off'}
                            >
                              {autoScrollStageLogs ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                              Auto Log {autoScrollStageLogs ? 'On' : 'Off'}
                            </button>
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
                        {expandedStage === 'sparse_reconstruction' && !isGlobalSfmEngine(project?.config?.sfm_engine) && project?.config?.sfm_engine !== 'fastmap' && stage.status === 'running' && (
                          <div className="mb-3 space-y-2 text-xs text-[var(--text-secondary)]">
                            {[
                              { key: 'seed', label: 'Seed model search', progress: 10 },
                              { key: 'registration', label: 'CPU image registration', progress: 55 },
                              { key: 'triangulation', label: 'Track triangulation', progress: 75 },
                              { key: 'bundle_adjustment', label: 'Bundle adjustment', progress: 90 },
                              { key: 'snapshot', label: 'Sparse snapshot export', progress: 98 },
                            ].map((subStage) => {
                              const isSubCompleted = progress >= subStage.progress;
                              const isSubActive = progress >= (subStage.progress - 18) && progress < subStage.progress + 6;
                              return (
                                <div key={subStage.key} className={`flex items-center justify-between gap-3 border-[var(--border-w)] border-[var(--ink)] px-3 py-2 ${isSubActive ? 'bg-[var(--paper-card)]' : 'bg-[var(--paper-muted)]'}`}>
                                  <span className={`font-bold uppercase tracking-[0.12em] ${isSubCompleted ? 'text-[var(--success-icon)]' : isSubActive ? 'text-[var(--ink)]' : 'text-[var(--text-muted)]'}`}>{isSubCompleted ? 'DONE' : isSubActive ? 'LIVE' : 'WAIT'}</span>
                                  <span className="flex-1">{subStage.label}</span>
                                  <span className="font-bold text-[var(--ink)]">{subStage.progress}%</span>
                                </div>
                              );
                            })}
                            <div className="border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-3">
                              <p className="font-bold uppercase text-[var(--ink)]">Registration budget</p>
                              <p className="mt-1">
                                profile {project?.config?.cpu_sparse_registration_profile || 'standard'} • mapper threads {project?.config?.mapper_cpu_threads || 'auto'} • CPU mapper {project?.config?.force_cpu_sparse_reconstruction !== false ? 'forced' : 'optional'}
                              </p>
                            </div>
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

              {showSparsePoseViewer && (
                <div className="brutal-card p-4 md:p-5">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-label mb-1">Live Sparse View</p>
                      <h2 className="brutal-h3">Camera Pose Monitor</h2>
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Inspect the current sparse model while reconstruction is running or review the final sparse layout afterward.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {liveCameraPoses?.is_live && (
                        <span className="brutal-badge brutal-badge-success">Live snapshot</span>
                      )}
                      {liveCameraPoses?.capture_progress_percent !== undefined && (
                        <span className="brutal-badge">
                          {liveCameraPoses.capture_progress_percent}% coverage
                        </span>
                      )}
                      {liveCameraPoses && (
                        <span className="brutal-badge">
                          {liveCameraPoses.camera_count.toLocaleString()} cameras
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span className="brutal-badge brutal-badge-info">
                      {liveCameraPoses?.source_label || 'Waiting for sparse snapshot...'}
                    </span>
                    {liveCameraPoses ? (
                      <span className="brutal-badge">
                        Updates per registered image
                      </span>
                    ) : null}
                    {liveCameraPoses?.sparse_point_count ? (
                      <span className="brutal-badge">
                        {liveCameraPoses.sparse_point_count.toLocaleString()} points
                      </span>
                    ) : null}
                  </div>

                  <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
                    <div className="brutal-card-dark min-h-[420px] overflow-hidden p-0">
                      {liveCameraPoses ? (
                        <Suspense
                          fallback={
                            <div className="flex h-[420px] items-center justify-center">
                              <Loader className="h-8 w-8 animate-spin text-[var(--text-on-ink)]" />
                            </div>
                          }
                        >
                          <CameraPoseVisualization
                            data={liveCameraPoses}
                            selectedCamera={selectedSparseCamera}
                            onCameraSelect={setSelectedSparseCamera}
                          />
                        </Suspense>
                      ) : (
                        <div className="flex h-[420px] items-center justify-center px-6 text-center text-sm text-[var(--text-on-ink-muted)]">
                          {liveCameraPoseLoading
                            ? 'Loading sparse camera poses...'
                            : liveCameraPoseError
                              ? liveCameraPoseError
                              : 'Waiting for the first sparse reconstruction snapshot. This panel will update once enough cameras are registered.'}
                        </div>
                      )}
                    </div>

                    <div className="space-y-3">
                      <div className="brutal-card-muted p-4">
                        <p className="brutal-label mb-2">Selected Camera</p>
                        {selectedSparseCamera ? (
                          <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                            <p className="font-bold uppercase text-[var(--ink)]">{selectedSparseCamera.image_name}</p>
                            <div className="grid grid-cols-3 gap-2 text-xs">
                              {selectedSparseCamera.position.map((value, index) => (
                                <div key={index} className="brutal-card p-2">
                                  <p className="brutal-label mb-1">{['X', 'Y', 'Z'][index]}</p>
                                  <p className="font-mono text-[var(--ink)]">{value.toFixed(3)}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-[var(--text-secondary)]">
                            Select a camera in the viewer to inspect its pose.
                          </p>
                        )}
                      </div>
                      <div className="brutal-card p-4">
                        <p className="brutal-label mb-2">Full Inspection</p>
                        <p className="mb-3 text-sm text-[var(--text-secondary)]">
                          Open the dedicated camera pose page for a larger viewer and full sidebar navigation.
                        </p>
                        <button
                          type="button"
                          onClick={() => router.push(`/camera-poses/${projectId}`)}
                          className="brutal-btn brutal-btn-primary"
                        >
                          <Eye className="h-4 w-4" />
                          Open Camera Poses
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {showTrainingPreview && (
                <div className="brutal-card-muted p-4 md:p-5">
                  <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="brutal-label mb-1">Live Training View</p>
                      <h2 className="brutal-h3">Training Splat Preview</h2>
                      <p className="mt-2 text-sm text-[var(--text-secondary)]">
                        Compare the native live render against the registered reference frame during training.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {trainingPreview?.is_live && (
                        <span className="brutal-badge brutal-badge-success">Live</span>
                      )}
                      {trainingPreview?.progress_percent !== undefined ? (
                        <span className="brutal-badge">
                          {trainingPreview.progress_percent}% trained
                        </span>
                      ) : null}
                      {trainingPreview?.iteration ? (
                        <span className="brutal-badge">
                          {trainingPreview.iteration.toLocaleString()}/{(trainingPreview.total_iterations || 0).toLocaleString()} iter
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <span className="brutal-badge brutal-badge-info">
                      {trainingPreview
                        ? (trainingPreview.is_final
                            ? 'Final training model ready'
                            : `Live native preview at ${trainingPreview.progress_percent ?? 0}% training`)
                        : 'Waiting for native live render updates...'}
                    </span>
                    {trainingPreview?.update_interval_percent ? (
                      <span className="brutal-badge">
                        Updates every {trainingPreview.update_interval_percent}%
                      </span>
                    ) : null}
                    {trainingPreview?.preview_url && (
                      <button
                        type="button"
                        onClick={() => {
                          if (trainingPreview.preview_url) {
                            router.push(`/viewer?file=${encodeURIComponent(trainingPreview.preview_url)}`);
                          }
                        }}
                        className="brutal-btn brutal-btn-xs"
                      >
                        Open In Viewer
                      </button>
                    )}
                  </div>

                  <div className="brutal-card relative h-[min(760px,calc(100vh-10rem))] min-h-[520px] overflow-hidden p-0">
                    <Suspense
                      fallback={
                        <div className="flex h-full items-center justify-center">
                          <Loader className="h-8 w-8 animate-spin text-[var(--ink)]" />
                        </div>
                      }
                    >
                      <TrainingSplatPreview
                        projectId={projectId}
                        plyUrl={trainingPreview?.preview_url}
                        isTrainingLive={Boolean(trainingPreview?.is_live)}
                        initialLivePreview={trainingPreview?.live_preview}
                        referenceFrames={hasSeparateTraining ? [...framePreview, ...trainingFramePreview] : framePreview}
                        cameraPoses={liveCameraPoses}
                        onOpenFullViewer={
                          trainingPreview?.preview_url
                            ? () => {
                                if (trainingPreview.preview_url) {
                                  router.push(`/viewer?file=${encodeURIComponent(trainingPreview.preview_url)}`);
                                }
                              }
                            : undefined
                        }
                      />
                    </Suspense>
                    {(trainingPreviewLoading || trainingPreviewError || liveCameraPoseLoading || liveCameraPoseError) && (
                      <div className="pointer-events-none absolute bottom-4 left-4 z-20 max-w-lg border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-xs font-bold text-[var(--ink)] shadow-[var(--shadow-sm)]">
                        {trainingPreviewLoading || liveCameraPoseLoading
                          ? 'Loading live training context...'
                          : trainingPreviewError || liveCameraPoseError}
                      </div>
                    )}
                  </div>
                </div>
              )}

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
                      Adaptive Frame Budget
                    </p>
                    <label className="flex items-center gap-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">
                      <input
                        type="checkbox"
                        checked={retryParams.adaptive_frame_budget}
                        onChange={(e) => setRetryParams({...retryParams, adaptive_frame_budget: e.target.checked})}
                        disabled={!retryParams.smart_frame_selection}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <span>ให้ backend ปรับ candidate density ตามคุณภาพวิดีโอและ budget จริงแบบอัตโนมัติ</span>
                    </label>
                  </div>

                  <div>
                    <p className="brutal-label mb-1 block">
                      Adaptive Pair Scheduling
                    </p>
                    <label className="flex items-center gap-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">
                      <input
                        type="checkbox"
                        checked={retryParams.adaptive_pair_scheduling}
                        onChange={(e) => setRetryParams({...retryParams, adaptive_pair_scheduling: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <span>ให้ matching ขยายเป็น checkpoint แบบ bootstrap → bridge → target/loop แทนการใช้ pass หนักทันที</span>
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
                    <input
                      type="number"
                      min={1}
                      step={1}
                      list="retry-cpu-chunk-worker-suggestions"
                      value={retryParams.ffmpeg_cpu_workers}
                      onChange={(e) => setRetryParams({...retryParams, ffmpeg_cpu_workers: e.target.value})}
                      placeholder="ใช้ค่าเดิม"
                      className="brutal-input"
                    />
                    <datalist id="retry-cpu-chunk-worker-suggestions">
                      {CPU_CHUNK_WORKER_SUGGESTIONS.map((workerCount) => (
                        <option key={workerCount} value={workerCount}>
                          {workerCount} workers
                        </option>
                      ))}
                    </datalist>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ปล่อยว่างเพื่อใช้ค่าเดิม หรือพิมพ์ค่าใหม่เองได้</p>
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
                  💡 ใช้สอง toggle นี้ทำ A/B test ได้เลยระหว่าง baseline กับ adaptive ordered-video policy
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
                    <HelpLabel tooltip="เลือก preset รวมของ COLMAP/OpenSplat สำหรับรอบ retry นี้ ถ้าทิ้งว่างจะใช้ค่าจากโปรเจกต์เดิม">
                      Quality Mode
                    </HelpLabel>
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

                  <div>
                    <p className="brutal-label mb-1 block">
                      Preview Interval
                    </p>
                    <select
                      value={retryParams.training_live_preview_interval_percent}
                      onChange={(e) => setRetryParams({...retryParams, training_live_preview_interval_percent: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="1">Every 1%</option>
                      <option value="2">Every 2%</option>
                      <option value="5">Every 5%</option>
                    </select>
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
                      Retry Matcher
                    </p>
                    <select
                      value={retryParams.matcher_type}
                      onChange={(e) => setRetryParams({...retryParams, matcher_type: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ค่าเดิม</option>
                      <option value="auto">Auto (backend decides)</option>
                      <option value="sequential">Sequential</option>
                      <option value="exhaustive">Exhaustive</option>
                      <option value="vocab_tree">Vocabulary Tree</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">เลือก matcher สำหรับ rerun รอบนี้โดยตรง ถ้าใช้ Auto backend จะเลือกตาม dataset อีกครั้ง</p>
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

                  <div>
                    <p className="brutal-label mb-1 block">
                      Adaptive Pair Scheduling
                    </p>
                    <label className="flex items-center gap-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">
                      <input
                        type="checkbox"
                        checked={retryParams.adaptive_pair_scheduling}
                        onChange={(e) => setRetryParams({...retryParams, adaptive_pair_scheduling: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <span>เปิด progressive schedule เพื่อให้ sequential matching หยุดเร็วเมื่อ geometry ดีพอ</span>
                    </label>
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
                    <HelpLabel tooltip="จำนวน feature matches ขั้นต่ำที่ต้องมี ก่อน mapper จะใช้คู่ภาพในการลงทะเบียน ลดค่านี้ช่วยให้ภาพยากเข้า model ได้ง่ายขึ้น แต่เสี่ยง pose ผิดมากขึ้น">
                      Min Num Matches (จำนวน matches ขั้นต่ำในการ register)
                    </HelpLabel>
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
                    <HelpLabel tooltip="ชุดค่าลัดสำหรับเพิ่มเวลาและผ่อนเงื่อนไขของ CPU incremental mapper: Expanded เหมาะกับ retry ทั่วไป, Deep ช้ากว่าแต่พยายามเก็บภาพยากมากขึ้น">
                      CPU Registration Profile
                    </HelpLabel>
                    <select
                      value={retryParams.cpu_sparse_registration_profile}
                      onChange={(e) => setRetryParams({...retryParams, cpu_sparse_registration_profile: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">Standard policy</option>
                      <option value="expanded">Expanded - ให้เวลาลงทะเบียนนานขึ้น</option>
                      <option value="deep">Deep - ช้ากว่า แต่ผ่อน threshold มากสุด</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      Expanded เพิ่ม init trials และ max registration trials พร้อมผ่อน pose threshold สำหรับ CPU incremental COLMAP
                    </p>
                  </div>

                  <div>
                    <HelpLabel tooltip="จำนวน sparse models สูงสุดที่อนุญาตให้ COLMAP สร้าง เพิ่มได้ถ้าข้อมูลแตกเป็นหลายกลุ่ม แต่สำหรับวิดีโอ/orbit มักควรใช้ 1 เพื่อบังคับ model เดียว">
                      Max Num Models (จำนวน models สูงสุดที่สร้าง)
                    </HelpLabel>
                    <input
                      type="number"
                      placeholder="เช่น 50"
                      value={retryParams.max_num_models}
                      onChange={(e) => setRetryParams({...retryParams, max_num_models: e.target.value})}
                      className="brutal-input"
                    />
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">ค่าเริ่มต้น: 50 (เพิ่มเพื่อลองหลาย models)</p>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <HelpLabel tooltip="จำนวนครั้งที่ mapper ลองหา seed model เริ่มต้น เพิ่มค่านี้ช่วยให้เริ่มจากคู่ภาพที่ดีขึ้นใน dataset ยาก แต่ทำให้ช่วงเริ่ม reconstruction ช้าลง">
                        Init Num Trials
                      </HelpLabel>
                      <input
                        type="number"
                        placeholder="เช่น 300"
                        value={retryParams.init_num_trials}
                        onChange={(e) => setRetryParams({...retryParams, init_num_trials: e.target.value})}
                        className="brutal-input"
                      />
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">เพิ่มเวลาหา seed model เริ่มต้น</p>
                    </div>
                    <div>
                      <HelpLabel tooltip="จำนวน CPU threads ที่ส่งให้ COLMAP mapper ผ่าน --Mapper.num_threads ว่างไว้คือ auto ใช้ logical CPU ทั้งหมดที่ระบบตรวจพบ ใส่สูงเกินไปไม่จำเป็นต้องเร็วขึ้นเสมอ">
                        Mapper CPU Threads
                      </HelpLabel>
                      <input
                        type="number"
                        placeholder="auto"
                        value={retryParams.mapper_cpu_threads}
                        onChange={(e) => setRetryParams({...retryParams, mapper_cpu_threads: e.target.value})}
                        className="brutal-input"
                      />
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">ว่างไว้เพื่อใช้ logical CPU ทั้งหมดที่ระบบตรวจพบ</p>
                    </div>
                    <div>
                      <HelpLabel tooltip="จำนวนครั้งที่ COLMAP จะลอง register ภาพที่ยังเข้า model ไม่ได้ เพิ่มแล้วมีโอกาสเก็บภาพยากมากขึ้น แต่ถ้ามีภาพเสียจำนวนมากจะใช้เวลานานขึ้นชัดเจน">
                        Max Registration Trials
                      </HelpLabel>
                      <input
                        type="number"
                        placeholder="เช่น 16"
                        value={retryParams.max_reg_trials}
                        onChange={(e) => setRetryParams({...retryParams, max_reg_trials: e.target.value})}
                        className="brutal-input"
                      />
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">เพิ่มจำนวนครั้งที่ COLMAP ลอง register ภาพที่ยาก</p>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-3">
                    <div>
                      <HelpLabel tooltip="ค่าความคลาดเคลื่อนสูงสุดของ absolute pose estimation เพิ่มค่าเพื่อผ่อนให้ภาพยากผ่านง่ายขึ้น แต่ถ้าสูงเกินไปอาจรับ pose ที่ไม่สะอาด">
                        Abs Pose Max Error
                      </HelpLabel>
                      <input
                        type="number"
                        step="0.1"
                        placeholder="เช่น 14"
                        value={retryParams.abs_pose_max_error}
                        onChange={(e) => setRetryParams({...retryParams, abs_pose_max_error: e.target.value})}
                        className="brutal-input"
                      />
                    </div>
                    <div>
                      <HelpLabel tooltip="จำนวน inlier ขั้นต่ำที่ต้องมีตอนลงทะเบียน pose ลดค่าช่วยภาพที่ match น้อย แต่เสี่ยงรับภาพที่หลักฐานเรขาคณิตอ่อน">
                        Min Inliers
                      </HelpLabel>
                      <input
                        type="number"
                        placeholder="เช่น 12"
                        value={retryParams.abs_pose_min_num_inliers}
                        onChange={(e) => setRetryParams({...retryParams, abs_pose_min_num_inliers: e.target.value})}
                        className="brutal-input"
                      />
                    </div>
                    <div>
                      <HelpLabel tooltip="สัดส่วน inlier ขั้นต่ำของ pose registration ลดค่าเช่น 0.06-0.08 ช่วย dataset ยาก แต่ถ้าต่ำเกินไปจะเพิ่มความเสี่ยง false registration">
                        Min Inlier Ratio
                      </HelpLabel>
                      <input
                        type="number"
                        step="0.01"
                        placeholder="เช่น 0.08"
                        value={retryParams.abs_pose_min_inlier_ratio}
                        onChange={(e) => setRetryParams({...retryParams, abs_pose_min_inlier_ratio: e.target.value})}
                        className="brutal-input"
                      />
                    </div>
                  </div>

                  <div>
                    <HelpLabel tooltip="ถ้า sparse reconstruction ยังล้มหลัง recovery ปกติครบแล้ว ระบบจะมี one-shot matcher fallback ให้อีกหนึ่งรอบ ค่า Auto จะให้ backend เลือก Exhaustive สำหรับชุดเล็ก หรือ Vocabulary Tree สำหรับชุดใหญ่เอง">
                      Retry Matcher Fallback
                    </HelpLabel>
                    <select
                      value={retryParams.matcher_fallback_retry_type}
                      onChange={(e) => setRetryParams({...retryParams, matcher_fallback_retry_type: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ policy เดิม</option>
                      <option value="auto">Auto (small set - Exhaustive, large set - Vocabulary Tree)</option>
                      <option value="exhaustive">Exhaustive</option>
                      <option value="vocab_tree">Vocabulary Tree</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      ใช้เมื่ออยากบังคับว่ารอบ fallback หลัง sparse fail จะลอง pair matcher แบบไหน โดยไม่เปลี่ยน baseline first pass
                    </p>
                  </div>

                  <div>
                    <HelpLabel tooltip="เลือก engine สำหรับรอบ sparse retry: policy เดิมปลอดภัยสุด, Incremental COLMAP เหมาะกับวิดีโอ/orbit, Global Mapper เหมาะกับภาพ unordered บางชุด, FastMap เร็วแต่เสี่ยงกับ dataset ยาก">
                      Sparse Retry Engine
                    </HelpLabel>
                    <select
                      value={retryParams.sparse_retry_sfm_engine}
                      onChange={(e) => setRetryParams({...retryParams, sparse_retry_sfm_engine: e.target.value})}
                      className="brutal-select"
                    >
                      <option value="">ใช้ policy เดิม</option>
                      <option value="colmap">Incremental COLMAP</option>
                      <option value="glomap">Global Mapper</option>
                      <option value="fastmap">FastMap</option>
                    </select>
                    <p className="mt-1 text-xs text-[var(--text-secondary)]">
                      ใช้ override นี้เมื่อต้องการบังคับ sparse retry ให้ลอง engine อื่นจาก policy ปัจจุบัน
                    </p>
                  </div>

                  <div>
                    <HelpLabel tooltip="บังคับให้ sparse mapper ใช้เส้นทาง CPU-first ในรอบ retry นี้ GPU ยังใช้กับขั้นอื่นได้ การเปิดไว้ช่วยความเสถียรของ incremental registration ในวิดีโอ/orbit">
                      Force CPU Sparse Reconstruction
                    </HelpLabel>
                    <label className="flex items-center gap-2 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 text-sm text-[var(--text-secondary)] shadow-[var(--shadow-sm)]">
                      <input
                        type="checkbox"
                        checked={retryParams.force_cpu_sparse_reconstruction}
                        onChange={(e) => setRetryParams({...retryParams, force_cpu_sparse_reconstruction: e.target.checked})}
                        className="h-4 w-4 border-[var(--ink)] text-[var(--ink)]"
                      />
                      <span>ปิด GPU สำหรับ mapper / bundle adjustment รอบ retry นี้ เพื่อเทียบกับเส้นทาง CPU เดิม</span>
                    </label>
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
