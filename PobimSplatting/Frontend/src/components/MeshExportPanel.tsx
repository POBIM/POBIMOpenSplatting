'use client';

import { useState, useEffect } from 'react';
import { Download, Loader, CheckCircle, XCircle, Package, Info } from 'lucide-react';
import { api } from '@/lib/api';

interface MeshExportPanelProps {
  projectId: string;
  projectStatus: string;
}

type ExportStatus = 'idle' | 'loading' | 'success' | 'error';
type MeshMethod = 'poisson' | 'delaunay';
type MeshQuality = 'low' | 'medium' | 'high';
type MeshFormat = 'ply' | 'obj' | 'glb' | 'dae';

interface ExportedFile {
  filename: string;
  size_mb: number;
  method: MeshMethod;
  download_url: string;
}

interface AvailableExportsResponse {
  exports?: ExportedFile[];
}

interface CreateMeshResponse {
  success: boolean;
  status?: string;
  message?: string;
  filename: string;
  error?: string;
  hint?: string;
}

function getStatusClasses(status: ExportStatus) {
  if (status === 'loading') {
    return 'status-processing';
  }
  if (status === 'success') {
    return 'status-completed';
  }
  return 'status-failed';
}

export default function MeshExportPanel({ projectId, projectStatus }: MeshExportPanelProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');
  const [exportMessage, setExportMessage] = useState('');
  const [exportedFile, setExportedFile] = useState<ExportedFile | null>(null);
  const [pollingInterval, setPollingInterval] = useState<NodeJS.Timeout | null>(null);
  const [method, setMethod] = useState<MeshMethod>('poisson');
  const [quality, setQuality] = useState<MeshQuality>('medium');
  const [format, setFormat] = useState<MeshFormat>('glb');

  const canExport = projectStatus === 'completed' || projectStatus === 'error';

  useEffect(() => {
    return () => {
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
    };
  }, [pollingInterval]);

  const checkExportStatus = async (expectedFilename: string) => {
    try {
      const data = (await api.getAvailableExports(projectId)) as unknown as AvailableExportsResponse;
      const found = data.exports?.find((exp) => exp.filename === expectedFilename);

      if (found) {
        if (pollingInterval) {
          clearInterval(pollingInterval);
          setPollingInterval(null);
        }

        setIsExporting(false);
        setExportStatus('success');
        setExportMessage('Mesh created successfully. Ready to download.');
        setExportedFile(found);
      }
    } catch (error) {
      console.error('Error checking export status:', error);
    }
  };

  const handleExport = async () => {
    if (!canExport) {
      setExportMessage('Project must complete processing first');
      setExportStatus('error');
      return;
    }

    setIsExporting(true);
    setExportStatus('loading');
    setExportMessage('Starting mesh export. This may take 5-30 minutes depending on quality.');

    try {
      const data = (await api.createTexturedMesh(projectId, {
        method,
        quality,
        format,
      })) as unknown as CreateMeshResponse;

      if (data.success && data.status === 'processing') {
        setExportMessage(`${data.message ?? 'Export queued.'} Polling every 10 seconds.`);
        const expectedFilename = data.filename;

        const interval = setInterval(() => {
          void checkExportStatus(expectedFilename);
        }, 10000);

        setPollingInterval(interval);

        setTimeout(() => {
          void checkExportStatus(expectedFilename);
        }, 2000);
      } else if (data.success) {
        setExportStatus('success');
        setExportMessage(data.message || 'Mesh created successfully.');
        setIsExporting(false);
      } else {
        setExportStatus('error');
        setExportMessage(data.error || data.hint || 'Export failed');
        setIsExporting(false);
      }
    } catch (error: unknown) {
      console.error('[MeshExport] Exception:', error);
      setExportStatus('error');

      let errorMessage = 'Network error';
      if (error instanceof Error) {
        errorMessage = error.message;
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'response' in error &&
        typeof (error as { response?: unknown }).response === 'object' &&
        (error as { response?: unknown }).response !== null &&
        'data' in ((error as { response: { data?: unknown } }).response)
      ) {
        const responseData = ((error as { response: { data?: { error?: string } } }).response).data;
        errorMessage = responseData?.error || errorMessage;
      }

      setExportMessage(errorMessage);
      setIsExporting(false);

      if (pollingInterval) {
        clearInterval(pollingInterval);
        setPollingInterval(null);
      }
    }
  };

  const handleDownload = () => {
    if (exportedFile?.download_url) {
      window.location.href = `http://localhost:5000${exportedFile.download_url}`;
    }
  };

  return (
    <div className="brutal-card p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
          <Package className="h-5 w-5" />
        </div>
        <div>
          <div className="brutal-eyebrow mb-2">Mesh Export</div>
          <h3 className="brutal-h3">Export Textured Mesh</h3>
        </div>
      </div>

      <div className="brutal-card-muted mb-5 p-4">
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div className="text-sm text-[color:var(--text-secondary)]">
            <p className="font-bold uppercase tracking-[0.12em] text-[color:var(--text-primary)]">
              Build a textured mesh from the current reconstruction.
            </p>
            <ul className="mt-2 space-y-1 text-xs uppercase tracking-[0.08em]">
              <li>• GLB works well in Blender, Unity, and web viewers</li>
              <li>• Poisson creates smoother watertight surfaces</li>
              <li>• Processing time scales with quality and image count</li>
            </ul>
          </div>
        </div>
      </div>

      <div className="space-y-5">
        <div>
          <div className="brutal-label mb-2 block">Meshing Method</div>
          <div className="grid grid-cols-2 gap-2">
            {(['poisson', 'delaunay'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMethod(option)}
                disabled={isExporting}
                className={`w-full p-3 text-left ${method === option ? 'brutal-card-dark' : 'brutal-card-muted'} ${isExporting ? 'opacity-50' : ''}`}
              >
                <div className="text-xs font-bold uppercase tracking-[0.14em]">{option}</div>
                <div className={`mt-1 text-[11px] ${method === option ? 'text-[color:var(--text-on-ink-muted)]' : 'text-[color:var(--text-secondary)]'}`}>
                  {option === 'poisson' ? 'Smooth surfaces' : 'Preserve original geometry'}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="brutal-label mb-2 block">Quality</div>
          <div className="grid grid-cols-3 gap-2">
            {(['low', 'medium', 'high'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setQuality(option)}
                disabled={isExporting}
                className={`w-full p-3 text-center ${quality === option ? 'brutal-card-dark' : 'brutal-card-muted'} ${isExporting ? 'opacity-50' : ''}`}
              >
                <div className="text-xs font-bold uppercase tracking-[0.14em]">{option}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
            {quality === 'low' && '~5-10 min, good for preview'}
            {quality === 'medium' && '~10-15 min, balanced quality and speed'}
            {quality === 'high' && '~20-40 min, best for production output'}
          </p>
        </div>

        <div>
          <div className="brutal-label mb-2 block">Output Format</div>
          <div className="grid grid-cols-4 gap-2">
            {(['glb', 'obj', 'ply', 'dae'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setFormat(option)}
                disabled={isExporting}
                className={`w-full p-3 text-center ${format === option ? 'brutal-card-dark' : 'brutal-card-muted'} ${isExporting ? 'opacity-50' : ''}`}
              >
                <div className="text-xs font-bold uppercase tracking-[0.14em]">{option}</div>
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-[color:var(--text-secondary)]">
            {format === 'glb' && 'Binary glTF for Blender, Unity, and web viewers'}
            {format === 'obj' && 'Universal OBJ export for broad software support'}
            {format === 'ply' && 'PLY format for MeshLab and CloudCompare'}
            {format === 'dae' && 'Collada for DCC pipelines that require XML'}
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <button
          type="button"
          onClick={handleExport}
          disabled={!canExport || isExporting}
          className={`brutal-btn brutal-btn-lg w-full justify-center ${canExport ? 'brutal-btn-primary' : ''}`}
        >
          {isExporting ? (
            <>
              <Loader className="h-4 w-4 animate-spin" />
              Creating Mesh
            </>
          ) : !canExport ? (
            <>
              <XCircle className="h-4 w-4" />
              Project Not Ready
            </>
          ) : (
            <>
              <Package className="h-4 w-4" />
              Create Textured Mesh
            </>
          )}
        </button>

        {exportStatus !== 'idle' && (
          <div className={`status-badge flex w-full items-start gap-2 p-4 text-left ${getStatusClasses(exportStatus)}`}>
            {exportStatus === 'loading' && <Loader className="mt-0.5 h-4 w-4 animate-spin" />}
            {exportStatus === 'success' && <CheckCircle className="mt-0.5 h-4 w-4" />}
            {exportStatus === 'error' && <XCircle className="mt-0.5 h-4 w-4" />}
            <div className="flex-1">
              <p className="text-sm font-medium normal-case tracking-normal">{exportMessage}</p>
              {exportedFile && exportStatus === 'success' && (
                <div className="mt-3 space-y-1 text-xs normal-case tracking-normal">
                  <p>
                    <span className="font-bold uppercase tracking-[0.12em]">File:</span> {exportedFile.filename}
                  </p>
                  <p>
                    <span className="font-bold uppercase tracking-[0.12em]">Size:</span> {exportedFile.size_mb} MB
                  </p>
                  <p>
                    <span className="font-bold uppercase tracking-[0.12em]">Method:</span> {exportedFile.method}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {exportStatus === 'success' && exportedFile && (
          <button type="button" onClick={handleDownload} className="brutal-btn brutal-btn-lg w-full justify-center">
            <Download className="h-4 w-4" />
            Download {format.toUpperCase()} File
          </button>
        )}

        {!canExport && (
          <div className="brutal-card-muted p-3 text-sm text-[color:var(--text-secondary)]">
            Wait for Gaussian Splat processing to finish before exporting a mesh.
          </div>
        )}
      </div>
    </div>
  );
}
