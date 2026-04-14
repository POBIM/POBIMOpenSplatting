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
      loadCameraPoses();
    }
  }, [projectId, loadCameraPoses]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="text-center">
          <Loader className="h-10 w-10 mx-auto text-gray-400 animate-spin" />
          <p className="mt-4 text-gray-500 text-sm">Loading camera poses...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-white">
        <div className="text-center max-w-md">
          <AlertTriangle className="h-10 w-10 mx-auto text-red-400" />
          <h2 className="mt-4 text-lg font-semibold text-black">Failed to Load Camera Poses</h2>
          <p className="mt-2 text-sm text-gray-500">{error || 'Unknown error'}</p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex items-center px-4 py-2 border border-gray-200 text-sm font-medium rounded-xl text-black hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back
            </button>
            <button
              type="button"
              onClick={loadCameraPoses}
              className="inline-flex items-center px-4 py-2 text-sm font-medium rounded-xl text-white bg-black hover:bg-gray-800 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      <div className="border-b border-gray-200 bg-white z-10 flex-shrink-0">
        <div className="max-w-full mx-auto px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                type="button"
                onClick={() => router.push(`/projects/${projectId}`)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <Breadcrumbs items={[
                { label: 'Projects', href: '/projects' },
                { label: data.project_name || projectId, href: `/projects/${projectId}` },
                { label: 'Camera Poses' },
              ]} />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => router.push(`/viewer?project=${projectId}`)}
                className="inline-flex items-center px-3 py-1.5 border border-gray-200 text-sm font-medium rounded-lg text-black hover:bg-gray-50 transition-colors"
              >
                <Eye className="h-4 w-4 mr-1.5" />
                View 3D Splat
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <CameraSidebar
          cameras={data.cameras}
          selectedCamera={selectedCamera}
          onSelect={setSelectedCamera}
        />

        <div className="flex-1 relative overflow-hidden">
          <Suspense fallback={
            <div className="h-full flex items-center justify-center bg-gray-950 text-gray-500">
              <div className="text-center">
                <Box className="h-10 w-10 mx-auto animate-pulse mb-3" />
                <p className="text-sm">Initializing 3D viewer...</p>
              </div>
            </div>
          }>
            <CameraPoseVisualization
              data={data}
              selectedCamera={selectedCamera}
              onCameraSelect={setSelectedCamera}
            />
          </Suspense>

          <div className="absolute top-3 left-3 bg-black/80 backdrop-blur text-white rounded-xl px-4 py-3 shadow-lg z-20 pointer-events-none">
            <div className="flex items-center gap-2 mb-1">
              <Camera className="h-4 w-4 text-blue-400" />
              <span className="text-sm font-semibold">{data.camera_count} cameras</span>
            </div>
            <div className="text-xs text-gray-400 space-y-0.5">
              <div>Project: {data.project_name || projectId.slice(0, 8)}</div>
              {data.sfm_engine && (
                <div>Engine: <span className="text-gray-300">{getSfmEngineLabel(data.sfm_engine)}</span></div>
              )}
              {data.sparse_point_count != null && data.sparse_point_count > 0 && (
                <div className="flex items-center gap-1">
                  <Sparkles className="h-3 w-3 text-amber-400" />
                  <span>{data.sparse_point_count.toLocaleString()} sparse points</span>
                </div>
              )}
            </div>
          </div>

          {selectedCamera && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-white/95 backdrop-blur border border-gray-200 rounded-xl px-5 py-3 shadow-xl z-20 max-w-md">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-black truncate mr-4">{selectedCamera.image_name}</span>
                <button
                  type="button"
                  onClick={() => setSelectedCamera(null)}
                  className="text-gray-400 hover:text-black text-xs flex-shrink-0"
                >
                  dismiss
                </button>
              </div>

              {selectedCamera.image_url ? (
                <div className="mb-2 rounded-lg overflow-hidden border border-gray-100 bg-gray-50">
                  <img
                    src={selectedCamera.image_url}
                    alt={selectedCamera.image_name}
                    className="w-full h-36 object-cover"
                    draggable={false}
                  />
                </div>
              ) : (
                <div className="mb-2 rounded-lg border border-dashed border-gray-200 bg-gray-50 h-24 flex items-center justify-center">
                  <span className="text-xs text-gray-400">No preview available</span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 text-xs text-gray-500">
                <div>
                  <span className="text-gray-400">X</span>
                  <span className="ml-1 text-black font-mono">{selectedCamera.position[0].toFixed(3)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Y</span>
                  <span className="ml-1 text-black font-mono">{selectedCamera.position[1].toFixed(3)}</span>
                </div>
                <div>
                  <span className="text-gray-400">Z</span>
                  <span className="ml-1 text-black font-mono">{selectedCamera.position[2].toFixed(3)}</span>
                </div>
              </div>
              {selectedCamera.width && selectedCamera.height && (
                <div className="text-xs text-gray-400 mt-1">
                  Resolution: {selectedCamera.width}&times;{selectedCamera.height}
                  {selectedCamera.fx && <span className="ml-2">fx: {selectedCamera.fx.toFixed(1)}</span>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
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
    if (!selectedCamera) return;
    if (selectedRef.current && listRef.current) {
      selectedRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedCamera]);

  return (
    <div className="w-56 flex-shrink-0 bg-gray-950 border-r border-white/10 flex flex-col">
      <div className="px-3 py-2.5 border-b border-white/10 flex items-center gap-2">
        <ImageIcon className="h-3.5 w-3.5 text-gray-400" />
        <span className="text-[11px] font-semibold text-gray-300 uppercase tracking-wider">
          Cameras
        </span>
        <span className="ml-auto text-[10px] text-gray-500 tabular-nums">{cameras.length}</span>
      </div>

      <div
        ref={listRef}
        className="flex-1 overflow-y-auto overflow-x-hidden py-1"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}
      >
        {cameras.map((cam, idx) => {
          const isActive = selectedCamera?.image_name === cam.image_name;
          return (
            <button
              key={cam.image_name}
              ref={isActive ? selectedRef : undefined}
              type="button"
              onClick={() => onSelect(isActive ? null : cam)}
              className={`w-full text-left px-2.5 py-1.5 flex items-center gap-2.5 transition-colors group ${
                isActive
                  ? 'bg-red-950/60 border-l-2 border-red-700'
                  : 'border-l-2 border-transparent hover:bg-white/5'
              }`}
            >
              {cam.image_url ? (
                <img
                  src={cam.image_url}
                  alt={cam.image_name}
                  className={`w-10 h-7 rounded object-cover flex-shrink-0 border ${
                    isActive ? 'border-red-700' : 'border-white/10 group-hover:border-white/25'
                  }`}
                  draggable={false}
                />
              ) : (
                <div
                  className={`w-10 h-7 rounded flex-shrink-0 flex items-center justify-center border ${
                    isActive
                      ? 'border-red-700 bg-red-950/40'
                      : 'border-white/10 bg-white/5 group-hover:border-white/25'
                  }`}
                >
                  <Camera className="h-3 w-3 text-gray-600" />
                </div>
              )}

              <div className="min-w-0 flex-1">
                <div
                  className={`text-[11px] font-medium truncate ${
                    isActive ? 'text-red-300' : 'text-gray-400 group-hover:text-gray-200'
                  }`}
                >
                  {cam.image_name}
                </div>
                <div className="text-[9px] text-gray-600 tabular-nums">
                  #{idx + 1}
                </div>
              </div>
            </button>
          );
        })}
      </div>

    </div>
  );
}
