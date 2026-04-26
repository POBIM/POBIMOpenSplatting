'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Eye,
  ImageIcon,
  Loader,
  Pause,
  Play,
  RefreshCw,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import {
  api,
  CameraPose,
  CameraPosesData,
  TrainingLivePreview,
  TrainingLivePreviewFrame,
} from '@/lib/api';
import { websocket } from '@/lib/websocket';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

type FramePreview = {
  name: string;
  url?: string;
  type?: string;
};

const toAssetUrl = (url?: string | null) => {
  if (!url) {
    return '';
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${API_BASE_URL}${url.startsWith('/') ? url : `/${url}`}`;
};

const formatIteration = (value?: number) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '--';

const historyFrameKey = (frame: TrainingLivePreviewFrame) =>
  frame.filename || frame.render_url || String(frame.version || '');

const normalizeRenderHistory = (payload?: TrainingLivePreview | null) => {
  if (!payload) {
    return [];
  }

  const frames = Array.isArray(payload.history) ? [...payload.history] : [];
  if (payload.render_url) {
    frames.push({
      filename: payload.filename,
      render_url: payload.render_url,
      iteration: payload.iteration,
      total_iterations: payload.total_iterations,
      progress_percent: payload.progress_percent,
      version: payload.version,
      updated_at: payload.updated_at,
    });
  }

  const unique = new Map<string, TrainingLivePreviewFrame>();
  frames.forEach((frame) => {
    if (!frame?.render_url) {
      return;
    }
    const key = historyFrameKey(frame);
    if (!key) {
      return;
    }
    unique.set(key, frame);
  });

  return Array.from(unique.values()).sort((a, b) => {
    const aIteration = typeof a.iteration === 'number' ? a.iteration : 0;
    const bIteration = typeof b.iteration === 'number' ? b.iteration : 0;
    if (aIteration !== bIteration) {
      return aIteration - bIteration;
    }
    return String(a.filename || a.render_url).localeCompare(String(b.filename || b.render_url));
  });
};

const mergeRenderHistory = (
  current: TrainingLivePreviewFrame[],
  incoming: TrainingLivePreviewFrame[]
) => normalizeRenderHistory({
  project_id: '',
  image_name: '',
  history: [...current, ...incoming],
});

const createFrameObjectUrl = (payload: TrainingLivePreview) => {
  const bytes = payload.frame_bytes;
  if (!bytes) {
    return '';
  }

  const byteArray = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : bytes instanceof Uint8Array
      ? bytes
      : Array.isArray(bytes)
        ? new Uint8Array(bytes)
        : null;

  if (!byteArray) {
    return '';
  }

  const blobBytes = new Uint8Array(byteArray);
  return URL.createObjectURL(
    new Blob([blobBytes.buffer], { type: payload.frame_mime || 'image/jpeg' })
  );
};

export default function TrainingSplatPreview({
  projectId,
  plyUrl,
  isTrainingLive = true,
  initialLivePreview,
  referenceFrames = [],
  cameraPoses,
  onOpenFullViewer,
}: {
  projectId: string;
  plyUrl?: string;
  isTrainingLive?: boolean;
  initialLivePreview?: TrainingLivePreview | null;
  referenceFrames?: FramePreview[];
  cameraPoses?: CameraPosesData | null;
  onOpenFullViewer?: () => void;
}) {
  const cameras = useMemo(
    () => (Array.isArray(cameraPoses?.cameras) ? cameraPoses.cameras : []),
    [cameraPoses]
  );
  const frameUrlByName = useMemo(() => {
    const map = new Map<string, string>();
    referenceFrames.forEach((frame) => {
      if (frame?.name && frame?.url && !map.has(frame.name)) {
        map.set(frame.name, frame.url);
      }
    });
    return map;
  }, [referenceFrames]);

  const [selectedCamera, setSelectedCamera] = useState<CameraPose | null>(null);
  const selectedCameraRef = useRef<CameraPose | null>(null);
  const [livePreview, setLivePreview] = useState<TrainingLivePreview | null>(null);
  const renderPreviewByImageNameRef = useRef<Map<string, TrainingLivePreview>>(new Map());
  const [renderHistory, setRenderHistory] = useState<TrainingLivePreviewFrame[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const historyIndexRef = useRef<number | null>(null);
  const [isPlaybackPlaying, setIsPlaybackPlaying] = useState(false);
  const isPlaybackPlayingRef = useRef(false);
  const playbackDirectionRef = useRef(1);
  const [binaryRenderUrl, setBinaryRenderUrl] = useState('');
  const binaryRenderUrlRef = useRef('');
  const binaryRenderImageNameRef = useRef('');
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    selectedCameraRef.current = selectedCamera;
  }, [selectedCamera]);

  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  useEffect(() => {
    isPlaybackPlayingRef.current = isPlaybackPlaying;
  }, [isPlaybackPlaying]);

  const selectedHistoryFrame = useMemo(() => {
    if (historyIndex === null) {
      return null;
    }
    return renderHistory[historyIndex] || null;
  }, [historyIndex, renderHistory]);

  const displayedPreview = selectedHistoryFrame || (
    livePreview?.image_name === selectedCamera?.image_name ? livePreview : null
  );

  const referenceUrl = useMemo(() => {
    if (!selectedCamera) {
      return '';
    }
    return toAssetUrl(
      livePreview?.image_name === selectedCamera.image_name
        ? livePreview.reference_url || frameUrlByName.get(selectedCamera.image_name) || selectedCamera.image_url
        : frameUrlByName.get(selectedCamera.image_name) || selectedCamera.image_url
    );
  }, [frameUrlByName, livePreview, selectedCamera]);

  const renderUrl = useMemo(() => {
    if (!selectedCamera) {
      return '';
    }
    if (selectedHistoryFrame?.render_url) {
      return toAssetUrl(selectedHistoryFrame.render_url);
    }
    const matchingLivePreview =
      livePreview?.image_name === selectedCamera.image_name ? livePreview : null;
    const cachedPreview = renderPreviewByImageNameRef.current.get(selectedCamera.image_name);
    const matchingBinaryRender =
      binaryRenderImageNameRef.current === selectedCamera.image_name ? binaryRenderUrl : '';

    return matchingBinaryRender || toAssetUrl(matchingLivePreview?.render_url || cachedPreview?.render_url);
  }, [binaryRenderUrl, livePreview, selectedCamera, selectedHistoryFrame]);

  const clearBinaryRenderUrl = useCallback(() => {
    if (binaryRenderUrlRef.current) {
      URL.revokeObjectURL(binaryRenderUrlRef.current);
      binaryRenderUrlRef.current = '';
    }
    binaryRenderImageNameRef.current = '';
    setBinaryRenderUrl('');
  }, []);

  const applyLivePreview = useCallback((payload: TrainingLivePreview) => {
    const objectUrl = createFrameObjectUrl(payload);
    if (objectUrl) {
      if (binaryRenderUrlRef.current) {
        URL.revokeObjectURL(binaryRenderUrlRef.current);
      }
      binaryRenderUrlRef.current = objectUrl;
      binaryRenderImageNameRef.current = payload.image_name || '';
      setBinaryRenderUrl(objectUrl);
    } else {
      clearBinaryRenderUrl();
    }
    if (payload.image_name && payload.render_url) {
      const incomingHistory = normalizeRenderHistory(payload);
      renderPreviewByImageNameRef.current.set(payload.image_name, {
        ...payload,
        frame_bytes: null,
        history: incomingHistory,
      });
      if (selectedCameraRef.current?.image_name === payload.image_name) {
        setRenderHistory((current) => mergeRenderHistory(current, incomingHistory));
      }
    }
    setLivePreview(payload);
  }, [clearBinaryRenderUrl]);

  const selectCamera = useCallback(async (camera: CameraPose, cameraId: number) => {
    const isSameCamera = selectedCameraRef.current?.image_name === camera.image_name;
    const cachedPreview = renderPreviewByImageNameRef.current.get(camera.image_name);
    setSelectedCamera(camera);
    if (!isSameCamera) {
      clearBinaryRenderUrl();
      setIsPlaybackPlaying(false);
      setHistoryIndex(null);
    }
    setRenderHistory(normalizeRenderHistory(cachedPreview));
    setLivePreview(
      cachedPreview || {
        project_id: projectId,
        camera_id: cameraId,
        image_name: camera.image_name,
      }
    );
    setSelecting(true);
    setError(null);
    try {
      const response = await api.selectTrainingLivePreviewFrame(projectId, {
        camera_id: cameraId,
        image_name: camera.image_name,
      });
      applyLivePreview({
        ...response,
        image_name: response.image_name || camera.image_name,
      });
      setRenderHistory(normalizeRenderHistory({
        ...response,
        image_name: response.image_name || camera.image_name,
      }));
    } catch (err: any) {
      setError(
        err?.response?.data?.error ||
        err?.message ||
        'Failed to select training preview frame'
      );
    } finally {
      setSelecting(false);
    }
  }, [applyLivePreview, clearBinaryRenderUrl, projectId]);

  useEffect(() => {
    if (!cameras.length || selectedCamera) {
      return;
    }
    if (initialLivePreview?.image_name) {
      const initialCameraIndex = cameras.findIndex(
        (camera) => camera.image_name === initialLivePreview.image_name
      );
      if (initialCameraIndex >= 0) {
        const initialCamera = cameras[initialCameraIndex];
        if (initialLivePreview.render_url) {
          renderPreviewByImageNameRef.current.set(initialLivePreview.image_name, {
            ...initialLivePreview,
            camera_id: initialLivePreview.camera_id ?? initialCameraIndex,
            frame_bytes: null,
          });
        }
        setSelectedCamera(initialCamera);
        setRenderHistory(normalizeRenderHistory({
          ...initialLivePreview,
          camera_id: initialLivePreview.camera_id ?? initialCameraIndex,
        }));
        setHistoryIndex(null);
        setIsPlaybackPlaying(false);
        setLivePreview({
          ...initialLivePreview,
          camera_id: initialLivePreview.camera_id ?? initialCameraIndex,
        });
        return;
      }
    }
    void selectCamera(cameras[0], 0);
  }, [cameras, initialLivePreview, selectedCamera, selectCamera]);

  useEffect(() => {
    const unsubscribe = websocket.on('training_live_preview', (payload: TrainingLivePreview) => {
      const current = selectedCameraRef.current;
      if (!current || payload?.image_name !== current.image_name) {
        return;
      }
      applyLivePreview(payload);
      setSelecting(false);
      setError(null);
    });

    return unsubscribe;
  }, [applyLivePreview]);

  useEffect(() => {
    if (!isPlaybackPlaying || renderHistory.length < 2) {
      return;
    }

    const interval = window.setInterval(() => {
      setHistoryIndex((current) => {
        const currentIndex = current ?? 0;
        let nextIndex = currentIndex + playbackDirectionRef.current;
        if (nextIndex >= renderHistory.length) {
          playbackDirectionRef.current = -1;
          nextIndex = Math.max(0, renderHistory.length - 2);
        } else if (nextIndex < 0) {
          playbackDirectionRef.current = 1;
          nextIndex = Math.min(renderHistory.length - 1, 1);
        }
        return nextIndex;
      });
    }, 700);

    return () => window.clearInterval(interval);
  }, [isPlaybackPlaying, renderHistory.length]);

  useEffect(() => {
    return () => {
      if (binaryRenderUrlRef.current) {
        URL.revokeObjectURL(binaryRenderUrlRef.current);
      }
    };
  }, []);

  const timelinePosition = historyIndex ?? Math.max(0, renderHistory.length - 1);
  const canUseHistory = renderHistory.length > 0;

  const showPreviousFrame = useCallback(() => {
    if (!canUseHistory) {
      return;
    }
    setIsPlaybackPlaying(false);
    setHistoryIndex((current) => Math.max(0, (current ?? renderHistory.length - 1) - 1));
  }, [canUseHistory, renderHistory.length]);

  const showNextFrame = useCallback(() => {
    if (!canUseHistory) {
      return;
    }
    setIsPlaybackPlaying(false);
    setHistoryIndex((current) => Math.min(renderHistory.length - 1, (current ?? 0) + 1));
  }, [canUseHistory, renderHistory.length]);

  const showFirstFrame = useCallback(() => {
    if (!canUseHistory) {
      return;
    }
    setIsPlaybackPlaying(false);
    setHistoryIndex(0);
  }, [canUseHistory]);

  const showLatestFrame = useCallback(() => {
    setIsPlaybackPlaying(false);
    setHistoryIndex(null);
    playbackDirectionRef.current = 1;
  }, []);

  const togglePlayback = useCallback(() => {
    if (renderHistory.length < 2) {
      return;
    }
    if (isPlaybackPlayingRef.current) {
      setIsPlaybackPlaying(false);
      return;
    }
    setHistoryIndex((current) => current ?? 0);
    playbackDirectionRef.current = historyIndexRef.current === renderHistory.length - 1 ? -1 : 1;
    setIsPlaybackPlaying(true);
  }, [renderHistory.length]);

  if (!cameras.length) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-[var(--warning-text)]" />
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
            Waiting For Registered Cameras
          </p>
          <p className="mt-2 max-w-md text-xs text-[var(--text-secondary)]">
            Live comparison starts after sparse reconstruction exposes camera poses.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 w-full bg-[var(--paper)] lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-muted)] lg:border-b-0 lg:border-r-[var(--border-w)]">
        <div className="border-b-[var(--border-w)] border-[var(--ink)] px-3 py-2">
          <p className="brutal-label mb-1">Registered Frames</p>
          <p className="text-xs text-[var(--text-secondary)]">
            {cameras.length.toLocaleString()} camera poses
          </p>
        </div>
        <div className="flex gap-2 overflow-x-auto p-2 lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:overflow-x-hidden">
          {cameras.map((camera, index) => {
            const selected = selectedCamera?.image_name === camera.image_name;
            const thumbUrl = toAssetUrl(frameUrlByName.get(camera.image_name) || camera.image_url);
            return (
              <button
                key={`${camera.image_name}-${index}`}
                type="button"
                onClick={() => selectCamera(camera, index)}
                className={`group grid w-40 shrink-0 grid-cols-[54px_minmax(0,1fr)] gap-2 border-[var(--border-w)] px-2 py-2 text-left shadow-[var(--shadow-xs)] lg:w-full ${
                  selected
                    ? 'border-[var(--ink)] bg-[var(--accent)] text-[var(--ink)]'
                    : 'border-[var(--border)] bg-[var(--paper)] text-[var(--ink)] hover:border-[var(--ink)]'
                }`}
              >
                <span className="flex h-12 w-12 items-center justify-center overflow-hidden border border-[var(--ink)] bg-[var(--paper-card)]">
                  {thumbUrl ? (
                    <img src={thumbUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <ImageIcon className="h-5 w-5 text-[var(--text-muted)]" />
                  )}
                </span>
                <span className="min-w-0 self-center">
                  <span className="block truncate text-xs font-bold">{camera.image_name}</span>
                  <span className="mt-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--text-secondary)]">
                    #{index + 1}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="relative grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] bg-[var(--ink)]">
        <section className="relative min-h-0 border-b-[var(--border-w)] border-[var(--ink)] bg-black">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
            <span className="brutal-badge brutal-badge-success">Native Live Render</span>
            {displayedPreview?.progress_percent !== undefined && (
              <span className="brutal-badge">{displayedPreview.progress_percent}%</span>
            )}
            {displayedPreview?.iteration && (
              <span className="brutal-badge">
                {formatIteration(displayedPreview.iteration)}/{formatIteration(displayedPreview.total_iterations)} iter
              </span>
            )}
            {historyIndex !== null && (
              <span className="brutal-badge brutal-badge-info">
                History {timelinePosition + 1}/{renderHistory.length}
              </span>
            )}
            {selecting && (
              <span className="brutal-badge brutal-badge-info inline-flex items-center gap-1">
                <RefreshCw className="h-3 w-3 animate-spin" />
                Rendering
              </span>
            )}
          </div>

          {plyUrl && onOpenFullViewer && (
            <button
              type="button"
              onClick={onOpenFullViewer}
              className="brutal-btn brutal-btn-xs absolute right-3 top-3 z-10"
            >
              <Eye className="h-3.5 w-3.5" />
              Open Full Viewer
            </button>
          )}

          {canUseHistory && (
            <div className="absolute bottom-3 left-3 right-3 z-10 border-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] p-2 shadow-[var(--shadow-sm)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="brutal-badge">
                  {historyIndex === null ? 'Latest' : 'Timeline'}
                </span>
                <button
                  type="button"
                  onClick={showFirstFrame}
                  className="brutal-btn brutal-btn-xs"
                  title="First render"
                >
                  <SkipBack className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={showPreviousFrame}
                  className="brutal-btn brutal-btn-xs"
                  title="Previous render"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={togglePlayback}
                  className="brutal-btn brutal-btn-xs"
                  title={isPlaybackPlaying ? 'Pause timeline' : 'Play timeline'}
                  disabled={renderHistory.length < 2}
                >
                  {isPlaybackPlaying ? (
                    <Pause className="h-3.5 w-3.5" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={showNextFrame}
                  className="brutal-btn brutal-btn-xs"
                  title="Next render"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={showLatestFrame}
                  className="brutal-btn brutal-btn-xs"
                  title="Latest render"
                >
                  <SkipForward className="h-3.5 w-3.5" />
                </button>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0, renderHistory.length - 1)}
                  value={timelinePosition}
                  onChange={(event) => {
                    setIsPlaybackPlaying(false);
                    setHistoryIndex(Number(event.target.value));
                  }}
                  className="h-2 min-w-[160px] flex-1 accent-[var(--accent)]"
                  aria-label="Training render timeline"
                />
                <span className="min-w-[90px] text-right text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
                  {timelinePosition + 1}/{renderHistory.length}
                </span>
              </div>
            </div>
          )}

          {renderUrl ? (
            <img
              src={renderUrl}
              alt="Live native render"
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/75">
              <div>
                <Loader className="mx-auto mb-3 h-8 w-8 animate-spin" />
                <p className="font-bold uppercase tracking-[0.12em]">Waiting For Native Render</p>
                <p className="mt-2 text-xs">
                  {isTrainingLive
                    ? 'A frame will appear after selection or the next 2% training update.'
                    : 'No saved native render exists for this frame. Open the final PLY viewer for free navigation.'}
                </p>
              </div>
            </div>
          )}
        </section>

        <section className="relative min-h-0 bg-black">
          <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2">
            <span className="brutal-badge">Reference Frame</span>
            {selectedCamera?.image_name && (
              <span className="brutal-badge brutal-badge-info max-w-[55vw] truncate">
                {selectedCamera.image_name}
              </span>
            )}
          </div>
          {referenceUrl ? (
            <img
              src={referenceUrl}
              alt={selectedCamera?.image_name || 'Reference frame'}
              className="h-full w-full object-contain"
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/75">
              Reference image is unavailable for the selected registered camera.
            </div>
          )}
        </section>

        {error && (
          <div className="absolute bottom-3 right-3 max-w-md border-[var(--border-w)] border-[var(--ink)] bg-[var(--error-bg)] px-3 py-2 text-xs font-bold text-[var(--error-text)] shadow-[var(--shadow-sm)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
