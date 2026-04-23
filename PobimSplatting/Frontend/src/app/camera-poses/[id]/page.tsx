'use client';

import { useState, useEffect, lazy, Suspense, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { getSfmEngineLabel } from '@/lib/sfm-display';
import type { CameraPose, CameraPosesData } from '@/components/CameraPoseVisualization';
import { Breadcrumbs } from '@/components/ui';
import {
  ArrowLeft,
  Camera,
  Loader,
  AlertTriangle,
  Eye,
  Box,
  Sparkles,
  ImageIcon,
} from 'lucide-react';

const CameraPoseVisualization = lazy(() => import('@/components/CameraPoseVisualization'));

export default function CameraPosesPage() {
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [data, setData] = useState<CameraPosesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCamera, setSelectedCamera] = useState<CameraPose | null>(null);

  const loadCameraPoses = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await api.getCameraPoses(projectId);
      setData(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load camera poses';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (projectId) {
      void loadCameraPoses();
    }
  }, [projectId, loadCameraPoses]);

  if (loading) {
    return (
      <div className="brutal-shell flex min-h-screen items-center justify-center px-4">
        <div className="brutal-card p-6 text-center">
          <Loader className="brutal-pulse mx-auto h-10 w-10 animate-spin" />
          <p className="mt-3 text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
            Loading Camera Poses
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="brutal-shell flex min-h-screen items-center justify-center px-4">
        <div className="brutal-card max-w-lg p-6 text-center">
          <div className="brutal-card-muted mx-auto flex h-12 w-12 items-center justify-center p-2">
            <AlertTriangle className="h-6 w-6" />
          </div>
          <h2 className="brutal-h2 mt-4">Failed To Load Camera Poses</h2>
          <p className="mt-3 text-sm text-[color:var(--text-secondary)]">{error || 'Unknown error'}</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button type="button" onClick={() => router.back()} className="brutal-btn brutal-btn-lg">
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <button type="button" onClick={() => void loadCameraPoses()} className="brutal-btn brutal-btn-primary brutal-btn-lg">
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-shell flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <header className="border-b-[var(--border-w-strong)] border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--text-on-ink)]">
        <div className="brutal-container flex flex-col gap-3 px-4 py-3 md:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-3">
            <button
              type="button"
              onClick={() => router.push(`/projects/${projectId}`)}
              className="brutal-btn brutal-btn-ghost border-[var(--border-w)] border-[color:var(--text-on-ink)] text-[color:var(--text-on-ink)] hover:bg-[color:var(--ink-700)]"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div>
              <div className="mb-1.5 inline-flex items-center gap-2 border-[var(--border-w)] border-[color:var(--text-on-ink)] px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[color:var(--text-on-ink)]">
                <Camera className="h-3.5 w-3.5" />
                Camera Poses
              </div>
              <h1 className="text-xl font-black uppercase tracking-tight md:text-2xl">
                {data.project_name || projectId}
              </h1>
              <div className="mt-1 [&_*]:text-[color:var(--text-on-ink-muted)]">
                <Breadcrumbs
                  items={[
                    { label: 'Projects', href: '/projects' },
                    { label: data.project_name || projectId, href: `/projects/${projectId}` },
                    { label: 'Camera Poses' },
                  ]}
                />
              </div>
            </div>
          </div>

          <button type="button" onClick={() => router.push(`/viewer?project=${projectId}`)} className="brutal-btn brutal-btn-lg self-start border-[color:var(--text-on-ink)] bg-[color:var(--paper-card)] text-[color:var(--ink)] lg:self-auto">
            <Eye className="h-4 w-4" />
            View 3D Splat
          </button>
        </div>
      </header>

      <section className="flex min-h-0 flex-1 lg:overflow-hidden">
        <div className="brutal-container flex h-full min-h-0 w-full flex-col gap-3 px-4 py-3 md:px-6 lg:flex-row">
          <CameraSidebar cameras={data.cameras} selectedCamera={selectedCamera} onSelect={setSelectedCamera} />

          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <div className="brutal-card-dark flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-on-ink-muted)]">Cameras</span>
                <span className="text-base font-black tracking-tight">{data.camera_count}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-on-ink-muted)]">SfM</span>
                <span className="text-sm font-bold uppercase tracking-[0.12em]">{data.sfm_engine ? getSfmEngineLabel(data.sfm_engine) : 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-2">
                <Sparkles className="h-3.5 w-3.5 text-[color:var(--text-on-ink-muted)]" />
                <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-on-ink-muted)]">Points</span>
                <span className="text-sm font-bold uppercase tracking-[0.12em]">{(data.sparse_point_count || 0).toLocaleString()}</span>
              </div>
              {selectedCamera && (
                <div className="ml-auto flex flex-wrap items-center gap-3 border-l-[var(--border-w)] border-[color:var(--text-on-ink-muted)] pl-4">
                  <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-on-ink-muted)]">Selected</span>
                  <span className="max-w-[200px] truncate text-sm font-bold uppercase tracking-[0.12em]">{selectedCamera.image_name}</span>
                  <span className="font-mono text-[11px] text-[color:var(--text-on-ink-muted)]">
                    {selectedCamera.position[0].toFixed(2)}, {selectedCamera.position[1].toFixed(2)}, {selectedCamera.position[2].toFixed(2)}
                  </span>
                  {selectedCamera.width && selectedCamera.height && (
                    <span className="font-mono text-[11px] text-[color:var(--text-on-ink-muted)]">{selectedCamera.width}×{selectedCamera.height}</span>
                  )}
                </div>
              )}
            </div>

            <div className="brutal-card flex min-h-[480px] flex-1 flex-col overflow-hidden p-3 lg:min-h-0">
              <div className="flex items-center justify-between border-b-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted)] px-4 py-2">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                  <Box className="h-4 w-4" />
                  Pose Visualization
                </div>
                <div className="flex gap-1.5">
                  <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-card)]" />
                  <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted-2)]" />
                  <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--ink)]" />
                </div>
              </div>

              <div className="relative min-h-0 flex-1 overflow-hidden bg-[color:var(--paper)]">
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center">
                      <div className="text-center">
                        <Box className="brutal-pulse mx-auto mb-3 h-10 w-10" />
                        <p className="text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                          Initializing 3D Viewer
                        </p>
                      </div>
                    </div>
                  }
                >
                  <CameraPoseVisualization
                    data={data}
                    selectedCamera={selectedCamera}
                    onCameraSelect={setSelectedCamera}
                  />
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function CameraSidebar({
  cameras,
  selectedCamera,
  onSelect,
}: {
  cameras: CameraPose[];
  selectedCamera: CameraPose | null;
  onSelect: (cam: CameraPose | null) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!selectedCamera) {
      return;
    }
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedCamera]);

  return (
    <aside className="brutal-card flex w-full min-h-0 flex-shrink-0 flex-col overflow-hidden lg:h-full lg:w-72">
      <div className="border-b-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted)] px-4 py-3">
        <div className="flex items-center gap-2">
          <ImageIcon className="h-4 w-4" />
          <span className="text-xs font-bold uppercase tracking-[0.16em] text-[color:var(--text-secondary)]">
            Cameras
          </span>
          <span className="brutal-badge ml-auto">{cameras.length}</span>
        </div>
      </div>

      <div ref={listRef} className="brutal-scroll flex-1 overflow-y-auto p-3">
        <div className="space-y-2">
          {cameras.map((cam, idx) => {
            const isActive = selectedCamera?.image_name === cam.image_name;
            return (
              <button
                key={cam.image_name}
                ref={isActive ? selectedRef : undefined}
                type="button"
                onClick={() => onSelect(isActive ? null : cam)}
                className={`w-full p-3 text-left ${isActive ? 'brutal-card' : 'brutal-card-muted'}`}
              >
                <div className="flex items-center gap-3">
                  {cam.image_url ? (
                    <img
                      src={cam.image_url}
                      alt={cam.image_name}
                      className="h-10 w-14 border-[var(--border-w)] border-[color:var(--ink)] object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="brutal-card flex h-10 w-14 items-center justify-center p-2">
                      <Camera className="h-4 w-4" />
                    </div>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-bold uppercase tracking-[0.12em] text-[color:var(--text-primary)]">
                      {cam.image_name}
                    </div>
                    <div className="mt-1 text-[11px] uppercase tracking-[0.12em] text-[color:var(--text-muted)]">
                      #{idx + 1}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
