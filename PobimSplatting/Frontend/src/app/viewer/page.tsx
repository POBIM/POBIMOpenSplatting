'use client';

import { Suspense } from 'react';
import SplatViewer from '@/components/SplatViewer';

export default function ViewerPage() {
  return (
    <div
      className="brutal-shell w-full overflow-hidden"
      style={{ height: 'calc(100vh - var(--navbar-height))' }}
    >
      <Suspense fallback={
        <div className="flex h-full items-center justify-center p-4">
          <div className="brutal-card relative w-full max-w-md p-6 text-center">
            <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
            <div className="relative">
              <div className="mx-auto mb-4 h-12 w-12 animate-spin border-[3px] border-[var(--ink)] border-t-transparent" />
              <p className="brutal-eyebrow mb-3">Viewer Boot</p>
              <h2 className="brutal-h2 mb-2">Loading 3D Viewer</h2>
              <p className="text-sm font-medium uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                Initializing Gaussian Splat Viewer
              </p>
            </div>
          </div>
        </div>
      }>
        <SplatViewer />
      </Suspense>
    </div>
  );
}
