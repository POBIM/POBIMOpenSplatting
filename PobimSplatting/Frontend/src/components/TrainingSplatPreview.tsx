'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Eye, ImageIcon, Loader, RefreshCw } from 'lucide-react';
import { api, CameraPose, CameraPosesData, TrainingLivePreview } from '@/lib/api';
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
  referenceFrames = [],
  cameraPoses,
  onOpenFullViewer,
}: {
  projectId: string;
  plyUrl?: string;
  isTrainingLive?: boolean;
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
  const [binaryRenderUrl, setBinaryRenderUrl] = useState('');
  const binaryRenderUrlRef = useRef('');
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    selectedCameraRef.current = selectedCamera;
  }, [selectedCamera]);

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
    if (!selectedCamera || livePreview?.image_name !== selectedCamera.image_name) {
      return '';
    }
    return binaryRenderUrl || toAssetUrl(livePreview.render_url);
  }, [binaryRenderUrl, livePreview, selectedCamera]);

  const clearBinaryRenderUrl = useCallback(() => {
    if (binaryRenderUrlRef.current) {
      URL.revokeObjectURL(binaryRenderUrlRef.current);
      binaryRenderUrlRef.current = '';
    }
    setBinaryRenderUrl('');
  }, []);

  const applyLivePreview = useCallback((payload: TrainingLivePreview) => {
    const objectUrl = createFrameObjectUrl(payload);
    if (objectUrl) {
      if (binaryRenderUrlRef.current) {
        URL.revokeObjectURL(binaryRenderUrlRef.current);
      }
      binaryRenderUrlRef.current = objectUrl;
      setBinaryRenderUrl(objectUrl);
    } else if (!payload.render_url) {
      clearBinaryRenderUrl();
    }
    setLivePreview(payload);
  }, [clearBinaryRenderUrl]);

  const selectCamera = useCallback(async (camera: CameraPose, cameraId: number) => {
    setSelectedCamera(camera);
    clearBinaryRenderUrl();
    setLivePreview({
      project_id: projectId,
      camera_id: cameraId,
      image_name: camera.image_name,
    });
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
    void selectCamera(cameras[0], 0);
  }, [cameras, selectedCamera, selectCamera]);

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
    return () => {
      if (binaryRenderUrlRef.current) {
        URL.revokeObjectURL(binaryRenderUrlRef.current);
      }
    };
  }, []);

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
            {livePreview?.progress_percent !== undefined && livePreview.image_name === selectedCamera?.image_name && (
              <span className="brutal-badge">{livePreview.progress_percent}%</span>
            )}
            {livePreview?.iteration && livePreview.image_name === selectedCamera?.image_name && (
              <span className="brutal-badge">
                {formatIteration(livePreview.iteration)}/{formatIteration(livePreview.total_iterations)} iter
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
