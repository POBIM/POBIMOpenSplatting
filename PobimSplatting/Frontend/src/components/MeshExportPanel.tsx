'use client';

import { useState, useEffect } from 'react';
import { Download, Loader, CheckCircle, XCircle, Package, FileCode, Info } from 'lucide-react';
import { api } from '@/lib/api';

interface MeshExportPanelProps {
  projectId: string;
  projectStatus: string;
}

export default function MeshExportPanel({ projectId, projectStatus }: MeshExportPanelProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [exportMessage, setExportMessage] = useState('');
  const [exportedFile, setExportedFile] = useState<any>(null);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);

  // Export settings
  const [method, setMethod] = useState<'poisson' | 'delaunay'>('poisson');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('medium');
  const [format, setFormat] = useState<'ply' | 'obj' | 'glb' | 'dae'>('glb');

  const canExport = projectStatus === 'completed' || projectStatus === 'error';

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  const checkExportStatus = async (expectedFilename: string) => {
    try {
      const data = await api.getAvailableExports(projectId);
      const found = data.exports?.find((exp: any) => exp.filename === expectedFilename);
      
      if (found) {
        // Export completed!
        if (pollingInterval) {
          clearInterval(pollingInterval);
          setPollingInterval(null);
        }
        
        setIsExporting(false);
        setExportStatus('success');
        setExportMessage('Mesh created successfully! Ready to download.');
        setExportedFile(found);
      }
    } catch (error) {
      console.error('Error checking export status:', error);
    }
  };

  const handleExport = async () => {
    console.log('[MeshExport] handleExport called');
    console.log('[MeshExport] canExport:', canExport);
    console.log('[MeshExport] projectStatus:', projectStatus);
    
    if (!canExport) {
      console.log('[MeshExport] Cannot export - project not ready');
      setExportMessage('Project must complete processing first');
      setExportStatus('error');
      return;
    }

    console.log('[MeshExport] Starting export with:', { method, quality, format });
    
    setIsExporting(true);
    setExportStatus('loading');
    setExportMessage('Starting mesh export... This will take 5-30 minutes depending on quality.');

    try {
      console.log('[MeshExport] Calling API...');
      const data = await api.createTexturedMesh(projectId, {
        method,
        quality,
        format,
      });

      console.log('[MeshExport] API response:', data);

      if (data.success && data.status === 'processing') {
        console.log('[MeshExport] Export started in background');
        // Background export started
        setExportMessage(
          `${data.message}\n\nPolling for completion every 10 seconds...`
        );
        
        const expectedFilename = data.filename;
        console.log('[MeshExport] Expected filename:', expectedFilename);
        
        // Start polling for export completion
        const interval = setInterval(() => {
          console.log('[MeshExport] Polling for completion...');
          checkExportStatus(expectedFilename);
        }, 10000); // Check every 10 seconds
        
        setPollingInterval(interval);
        
        // Check immediately once
        setTimeout(() => {
          console.log('[MeshExport] Initial status check...');
          checkExportStatus(expectedFilename);
        }, 2000);
      } else if (data.success) {
        console.log('[MeshExport] Immediate success');
        // Immediate success (shouldn't happen with background processing, but handle it)
        setExportStatus('success');
        setExportMessage(data.message || 'Mesh created successfully!');
        setExportedFile(data);
        setIsExporting(false);
      } else {
        console.log('[MeshExport] Export failed:', data);
        setExportStatus('error');
        setExportMessage(data.error || data.hint || 'Export failed');
        setIsExporting(false);
      }
    } catch (error: any) {
      console.error('[MeshExport] Exception:', error);
      console.error('[MeshExport] Error details:', error.response?.data);
      setExportStatus('error');
      const errorMsg = error.response?.data?.error || error.message || 'Network error';
      setExportMessage(errorMsg);
      setIsExporting(false);
      
      if (pollingInterval) {
        clearInterval(pollingInterval);
        setPollingInterval(null);
      }
    }
  };

  const handleDownload = () => {
    if (exportedFile && exportedFile.download_url) {
      // Use the API base URL + download URL
      const downloadUrl = `http://localhost:5000${exportedFile.download_url}`;
      window.location.href = downloadUrl;
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <div className="flex items-center gap-3 mb-4">
        <Package className="w-6 h-6 text-blue-400" />
        <h3 className="text-xl font-semibold text-white">Export Textured Mesh</h3>
      </div>

      <div className="bg-blue-900/20 border border-blue-700/50 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-2">
          <Info className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-blue-200">
            <p className="font-medium mb-1">Create a textured 3D mesh with colors from your images</p>
            <ul className="list-disc list-inside space-y-1 text-blue-300/80">
              <li>GLB format works great in Blender, Unity, and web viewers</li>
              <li>Poisson method creates smooth, watertight surfaces</li>
              <li>Processing time: 5-20 minutes depending on quality and image count</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Settings */}
      <div className="space-y-4 mb-6">
        {/* Method Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Meshing Method
          </label>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setMethod('poisson')}
              disabled={isExporting}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                method === 'poisson'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Poisson (Recommended)
            </button>
            <button
              onClick={() => setMethod('delaunay')}
              disabled={isExporting}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                method === 'delaunay'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              Delaunay
            </button>
          </div>
          <p className="mt-1 text-xs text-gray-400">
            {method === 'poisson'
              ? 'Creates smooth, watertight surfaces (best for objects)'
              : 'Preserves original geometry (best for terrain)'}
          </p>
        </div>

        {/* Quality Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Quality
          </label>
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'high'] as const).map((q) => (
              <button
                key={q}
                onClick={() => setQuality(q)}
                disabled={isExporting}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  quality === q
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {q.charAt(0).toUpperCase() + q.slice(1)}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-gray-400">
            {quality === 'low' && '~5-10 min, good for preview'}
            {quality === 'medium' && '~10-15 min, balanced quality/speed (recommended)'}
            {quality === 'high' && '~20-40 min, best quality for production'}
          </p>
        </div>

        {/* Format Selection */}
        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Output Format
          </label>
          <div className="grid grid-cols-4 gap-2">
            {(['glb', 'obj', 'ply', 'dae'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                disabled={isExporting}
                className={`px-4 py-2 rounded-lg text-sm font-medium uppercase transition-colors ${
                  format === f
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                } ${isExporting ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {f}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-gray-400">
            {format === 'glb' && 'Binary glTF - Best for Blender, Unity, web viewers'}
            {format === 'obj' && 'Wavefront OBJ - Universal, works with all 3D software'}
            {format === 'ply' && 'PLY format - Best for MeshLab, CloudCompare'}
            {format === 'dae' && 'Collada - XML-based, works with SketchUp'}
          </p>
        </div>
      </div>

      {/* Export Button */}
      <div className="space-y-3">
        <button
          onClick={handleExport}
          disabled={!canExport || isExporting}
          className={`w-full flex items-center justify-center gap-2 px-6 py-3 rounded-lg font-medium transition-colors ${
            !canExport
              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
              : isExporting
              ? 'bg-blue-600 text-white cursor-wait'
              : 'bg-gradient-to-r from-blue-600 to-blue-700 text-white hover:from-blue-700 hover:to-blue-800'
          }`}
        >
          {isExporting ? (
            <>
              <Loader className="w-5 h-5 animate-spin" />
              Creating Mesh...
            </>
          ) : !canExport ? (
            <>
              <XCircle className="w-5 h-5" />
              Project Not Ready
            </>
          ) : (
            <>
              <Package className="w-5 h-5" />
              Create Textured Mesh
            </>
          )}
        </button>

        {/* Status Message */}
        {exportStatus !== 'idle' && (
          <div
            className={`p-4 rounded-lg border ${
              exportStatus === 'loading'
                ? 'bg-blue-900/20 border-blue-700/50 text-blue-200'
                : exportStatus === 'success'
                ? 'bg-green-900/20 border-green-700/50 text-green-200'
                : 'bg-red-900/20 border-red-700/50 text-red-200'
            }`}
          >
            <div className="flex items-start gap-2">
              {exportStatus === 'loading' && <Loader className="w-5 h-5 animate-spin mt-0.5" />}
              {exportStatus === 'success' && <CheckCircle className="w-5 h-5 mt-0.5" />}
              {exportStatus === 'error' && <XCircle className="w-5 h-5 mt-0.5" />}
              <div className="flex-1">
                <p className="text-sm">{exportMessage}</p>
                {exportedFile && exportStatus === 'success' && (
                  <div className="mt-3 text-xs space-y-1">
                    <p>
                      <span className="text-gray-400">File:</span>{' '}
                      <span className="font-mono">{exportedFile.filename}</span>
                    </p>
                    <p>
                      <span className="text-gray-400">Size:</span> {exportedFile.size_mb} MB
                    </p>
                    <p>
                      <span className="text-gray-400">Method:</span>{' '}
                      {exportedFile.method.charAt(0).toUpperCase() + exportedFile.method.slice(1)}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Download Button */}
        {exportStatus === 'success' && exportedFile && (
          <button
            onClick={handleDownload}
            className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-medium transition-colors"
          >
            <Download className="w-5 h-5" />
            Download {format.toUpperCase()} File
          </button>
        )}
      </div>

      {/* Additional Info */}
      {!canExport && (
        <div className="mt-4 p-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg">
          <p className="text-sm text-yellow-200">
            ⏳ Please wait for the project to complete Gaussian Splat processing first.
            You can export the mesh once sparse reconstruction is done.
          </p>
        </div>
      )}
    </div>
  );
}
