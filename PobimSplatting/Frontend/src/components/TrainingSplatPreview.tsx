'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useSplatScene } from './splat-viewer/useSplatScene';

export default function TrainingSplatPreview({
  plyUrl,
  onOpenFullViewer,
}: {
  plyUrl: string;
  onOpenFullViewer?: () => void;
}) {
  const { canvasRef, loading, error, splatCount, resetScene } = useSplatScene(plyUrl);

  useEffect(() => {
    resetScene();
  }, [plyUrl, resetScene]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <AlertTriangle className="mx-auto mb-3 h-8 w-8 text-[var(--error-icon)]" />
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
            Preview Unavailable
          </p>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--paper)]">
      {loading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[color:rgba(244,245,248,0.88)]">
          <div className="text-center">
            <RefreshCw className="mx-auto mb-3 h-8 w-8 animate-spin text-[var(--ink)]" />
            <p className="text-sm font-bold uppercase tracking-[0.12em] text-[var(--ink)]">
              Loading Training Preview
            </p>
          </div>
        </div>
      )}

      <div className="absolute left-3 top-3 z-[5] flex flex-wrap items-center gap-2">
        {splatCount !== null && (
          <span className="brutal-badge brutal-badge-info">
            {splatCount.toLocaleString()} splats
          </span>
        )}
        {onOpenFullViewer && (
          <button
            type="button"
            onClick={onOpenFullViewer}
            className="brutal-btn brutal-btn-xs"
          >
            Open Full Viewer
          </button>
        )}
      </div>

      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
