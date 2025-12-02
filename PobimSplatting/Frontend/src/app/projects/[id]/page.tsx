'use client';

import { useParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback, useRef } from 'react';
import { api, Project } from '@/lib/api';
import { websocket } from '@/lib/websocket';
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
  X
} from 'lucide-react';

// Function to get stage labels based on SfM engine
const getStageLabelForEngine = (stageKey: string, sfmEngine: 'glomap' | 'colmap' = 'glomap') => {
  const isGlomap = sfmEngine === 'glomap';
  const labels: Record<string, string> = {
    'sparse_reconstruction': isGlomap ? 'GLOMAP Sparse Reconstruction' : 'COLMAP Sparse Reconstruction',
  };
  return labels[stageKey];
};

const PIPELINE_STAGES = [
  { key: 'ingest', label: 'Processing Upload', icon: '📥', weight: 0.05 },
  { key: 'video_extraction', label: 'Video Frame Extraction', icon: '🎬', weight: 0.1 },
  { key: 'feature_extraction', label: 'Feature Extraction', icon: '🔍', weight: 0.15 },
  { key: 'feature_matching', label: 'Feature Matching', icon: '🔗', weight: 0.1 },
  { key: 'sparse_reconstruction', label: 'Sparse Reconstruction', icon: '🏗️', weight: 0.2 },
  { key: 'model_conversion', label: 'Model Conversion', icon: '🔄', weight: 0.05 },
  { key: 'gaussian_splatting', label: 'Gaussian Splatting Training', icon: '✨', weight: 0.3 },
  { key: 'finalizing', label: 'Finalizing Model', icon: '🏁', weight: 0.05 },
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
  });
  const [expandedStage, setExpandedStage] = useState<string | null>(null);
  const [showColmapModal, setShowColmapModal] = useState(false);
  const [colmapCommand, setColmapCommand] = useState<string>('');
  const [colmapWorkingDir, setColmapWorkingDir] = useState<string>('');
  const [showImagePreview, setShowImagePreview] = useState(false);
  const [previewImageIndex, setPreviewImageIndex] = useState(0);

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
        setFramePreview(data.frames); // Show all preview images
      } else {
        setFramePreview([]);
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

  const handleRetry = async (fromStage?: string) => {
    try {
      // Build params object for retry
      const params: any = {};

      // Add quality_mode for all stages (affects COLMAP and OpenSplat config)
      if (retryParams.quality_mode) {
        params.quality_mode = retryParams.quality_mode;
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
      });
      await loadProject();
    } catch (err) {
      alert('Failed to retry processing');
    }
  };

  const handleOpenColmapGUI = async () => {
    try {
      const response = await api.openColmapGUI(projectId);
      if (response.success && response.command) {
        setColmapCommand(response.command);
        setColmapWorkingDir(response.working_directory || '');
        setShowColmapModal(true);
      }
    } catch (err: any) {
      const errorMsg = err?.response?.data?.error || 'Failed to get COLMAP command';
      alert(errorMsg);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    alert('คัดลอกคำสั่งแล้ว!');
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
      });
    }

    setShowRetryModal(true);
  };

  const handleDownload = () => {
    // Create download link with backend API endpoint
    const downloadUrl = `http://localhost:5000/api/download/${projectId}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${project?.metadata?.name || 'model'}_${projectId.slice(0, 8)}.ply`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
    <div className="flex h-screen bg-white">
      {/* Main Content */}
      <div className={`flex-1 overflow-y-auto transition-all duration-300 ${showLogSidebar ? 'mr-96' : 'mr-0'}`}>
        <div className="max-w-7xl mx-auto p-8">
          <div className="mb-8">
            <button
              onClick={() => router.push('/projects')}
              className="inline-flex items-center text-sm text-gray-900 hover:text-black transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Projects
            </button>
          </div>

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
                {getCurrentStage() ? (getStageLabelForEngine(getCurrentStage()?.key || '', project?.config?.sfm_engine) || PIPELINE_STAGES.find(s => s.key === getCurrentStage()?.key)?.label) : 'Initializing...'}
                {/* Show GLOMAP sub-stage detail if available */}
                {getCurrentStage()?.key === 'sparse_reconstruction' && 
                 project?.config?.sfm_engine === 'glomap' && 
                 stageDetails['sparse_reconstruction']?.text && (
                  <span className="ml-2 text-blue-600">
                    • {stageDetails['sparse_reconstruction'].text}
                  </span>
                )}
              </div>

              {/* COLMAP Inspection Button */}
              {(() => {
                const sparseStage = stages.find(s => s.key === 'sparse_reconstruction');
                const featureExtractionStage = stages.find(s => s.key === 'feature_extraction');
                // Show button if feature extraction is completed (database exists)
                return (featureExtractionStage?.status === 'completed' || sparseStage?.status === 'completed') && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <button
                      onClick={handleOpenColmapGUI}
                      className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                    >
                      <Eye className="h-4 w-4 mr-2" />
                      ตรวจสอบ Sparse Model
                    </button>
                    <p className="text-xs text-gray-500 mt-2">เปิด COLMAP GUI เพื่อตรวจสอบผล {project?.config?.sfm_engine === 'glomap' ? 'GLOMAP' : 'COLMAP'} sparse reconstruction</p>
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
                        onClick={handleOpenColmapGUI}
                        className="inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-lg text-blue-600 hover:bg-blue-50 transition-colors"
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        {project?.config?.sfm_engine === 'glomap' ? 'GLOMAP' : 'COLMAP'}
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
                              {getStageLabelForEngine(stageConfig.key, project?.config?.sfm_engine) || stageConfig.label}
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
                          <div className="text-2xl">{stageConfig?.icon}</div>
                          <div>
                            <h4 className="text-lg font-semibold text-black">{getStageLabelForEngine(stageConfig?.key || '', project?.config?.sfm_engine) || stageConfig?.label}</h4>
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

                        {/* GLOMAP Sub-stages for sparse_reconstruction */}
                        {expandedStage === 'sparse_reconstruction' && project?.config?.sfm_engine === 'glomap' && stage.status === 'running' && (
                          <div className="border-t border-gray-200 pt-4">
                            <p className="text-xs font-medium text-gray-500 mb-3">GLOMAP Pipeline Steps</p>
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
                  <h3 className="text-sm font-medium text-black mb-4">Frame Preview ({framePreview.length} images) <span className="text-gray-400 font-normal">- คลิกเพื่อดูภาพขนาดใหญ่</span></h3>
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
            </div>
          </div>
        </div>

        {/* Log Sidebar */}
      <div className={`fixed top-16 right-0 bg-white border-l border-gray-200 transition-transform duration-300 ${
        showLogSidebar ? 'translate-x-0' : 'translate-x-full'
      } w-96 flex flex-col z-40`}
      style={{ height: 'calc(100vh - 4rem)' }}>
        {/* Sidebar Header */}
        <div className="p-6 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <h3 className="text-sm font-semibold text-black">Activity Log</h3>
          <button
            onClick={() => setShowLogSidebar(false)}
            className="text-gray-400 hover:text-black transition-colors"
          >
            <XCircle className="h-5 w-5" />
          </button>
        </div>

        {/* Log Content */}
        <div className="flex-1 overflow-y-auto p-6 bg-black font-mono text-xs text-gray-300 leading-relaxed overflow-x-auto">
          {logs.length > 0 ? (
            <div className="min-w-max">
              {logs.map((log, index) => (
                <div key={index} className="whitespace-pre mb-1 opacity-80 hover:opacity-100 transition-opacity break-all">{log}</div>
              ))}
            </div>
          ) : (
            <div className="text-gray-600">No activity logs available</div>
          )}
        </div>
      </div>

      {/* Toggle Sidebar Button */}
      {!showLogSidebar && (
        <button
          onClick={() => setShowLogSidebar(true)}
          className="fixed top-24 right-6 bg-black text-white rounded-full p-3 shadow-xl hover:bg-gray-800 transition-all z-30"
        >
          <Monitor className="h-5 w-5" />
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
                        <span className="text-xl">{stage.icon}</span>
                        <span className="text-sm font-medium text-black">{getStageLabelForEngine(stage.key, project?.config?.sfm_engine) || stage.label}</span>
                      </div>
                      <div className="flex items-center space-x-2 mt-1.5 ml-9">
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

      {/* COLMAP Command Modal */}
      {showColmapModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-3xl w-full p-6 space-y-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-xl font-semibold text-black">คำสั่งเปิด {project?.config?.sfm_engine === 'glomap' ? 'GLOMAP' : 'COLMAP'} GUI</h3>
              <button
                onClick={() => setShowColmapModal(false)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Working Directory:
                </label>
                <div className="flex items-center space-x-2">
                  <code className="flex-1 px-3 py-2 bg-gray-50 rounded-lg text-sm font-mono text-gray-800 border border-gray-200">
                    {colmapWorkingDir}
                  </code>
                  <button
                    onClick={() => copyToClipboard(colmapWorkingDir)}
                    className="px-3 py-2 text-sm font-medium rounded-lg text-blue-600 hover:bg-blue-50 transition-colors border border-blue-200"
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Command:
                </label>
                <div className="flex items-start space-x-2">
                  <code className="flex-1 px-3 py-2 bg-gray-50 rounded-lg text-sm font-mono text-gray-800 border border-gray-200 whitespace-pre-wrap break-all">
                    {colmapCommand}
                  </code>
                  <button
                    onClick={() => copyToClipboard(colmapCommand)}
                    className="px-3 py-2 text-sm font-medium rounded-lg text-blue-600 hover:bg-blue-50 transition-colors border border-blue-200"
                  >
                    Copy
                  </button>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-blue-900 mb-2">วิธีการใช้งาน:</h4>
                <ol className="text-sm text-blue-800 space-y-1 list-decimal list-inside">
                  <li>เปิด Terminal หรือ Command Prompt</li>
                  <li>ใช้คำสั่ง <code className="bg-blue-100 px-1 rounded">cd</code> ไปยัง Working Directory ด้านบน</li>
                  <li>วางคำสั่ง Command ด้านบนและกด Enter</li>
                  <li>COLMAP GUI จะเปิดขึ้นมา</li>
                </ol>
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setShowColmapModal(false)}
                className="px-6 py-3 text-sm font-medium rounded-lg text-white bg-black hover:bg-gray-800 transition-colors"
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
