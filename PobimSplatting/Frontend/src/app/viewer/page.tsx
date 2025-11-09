'use client';

import { Suspense } from 'react';
import SplatViewer from '@/components/SplatViewer';

export default function ViewerPage() {
  return (
    <div
      className="w-full overflow-hidden"
      style={{ height: 'calc(100vh - var(--navbar-height))' }}
    >
      <Suspense fallback={
        <div className="flex items-center justify-center h-full bg-gradient-to-br from-purple-600 to-blue-600">
          <div className="text-center text-white">
            <div className="w-16 h-16 border-4 border-white border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <h2 className="text-2xl font-bold mb-2">Loading 3D Viewer</h2>
            <p className="text-blue-100">Initializing Gaussian Splat viewer...</p>
          </div>
        </div>
      }>
        <SplatViewer />
      </Suspense>
    </div>
  );
}
