'use client';

import { useState, useEffect, useCallback } from 'react';
import { Download, FileCode, Package, Loader, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';

interface Export {
  filename: string;
  format: string;
  size: number;
  size_mb: number;
  created_at: number;
  download_url: string;
}

interface ExportedMeshesListProps {
  projectId: string;
}

interface ExportsResponse {
  exports?: Export[];
}

function getErrorMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response?: unknown }).response !== null &&
    'data' in ((error as { response: { data?: unknown } }).response)
  ) {
    const responseData = ((error as { response: { data?: { error?: string } } }).response).data;
    if (responseData?.error) {
      return responseData.error;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Network error';
}

export default function ExportedMeshesList({ projectId }: ExportedMeshesListProps) {
  const [exports, setExports] = useState<Export[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchExports = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const data = (await api.getAvailableExports(projectId)) as unknown as ExportsResponse;
      setExports(data.exports || []);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchExports();
  }, [fetchExports]);

  const handleDownload = (downloadUrl: string) => {
    window.location.href = `http://localhost:5000${downloadUrl}`;
  };

  const formatDate = (timestamp: number) => new Date(timestamp * 1000).toLocaleString();

  const getFormatIcon = (format: string) => {
    if (format === 'glb' || format === 'gltf') {
      return <Package className="h-4 w-4" />;
    }
    return <FileCode className="h-4 w-4" />;
  };

  if (loading) {
    return (
      <div className="brutal-card p-5">
        <div className="flex items-center justify-center gap-2 text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
          <Loader className="h-4 w-4 animate-spin" />
          Loading Exports
        </div>
      </div>
    );
  }

  if (exports.length === 0) {
    return null;
  }

  return (
    <div className="brutal-card p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <div className="brutal-eyebrow mb-2">Mesh Files</div>
            <h3 className="brutal-h3">Exported Meshes ({exports.length})</h3>
          </div>
        </div>
        <button type="button" onClick={() => void fetchExports()} className="brutal-btn brutal-btn-xs" title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <div className="space-y-3">
        {exports.map((exportItem) => (
          <div key={exportItem.filename} className="brutal-card-muted p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <div className="brutal-card flex h-10 w-10 items-center justify-center p-2">
                  {getFormatIcon(exportItem.format)}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-bold uppercase tracking-[0.12em] text-[color:var(--text-primary)]">
                      {exportItem.filename}
                    </p>
                    <span className="brutal-badge">{exportItem.format.toUpperCase()}</span>
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--text-secondary)]">
                    {exportItem.size_mb.toFixed(1)} MB • {formatDate(exportItem.created_at)}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => handleDownload(exportItem.download_url)}
                className="brutal-btn brutal-btn-xs justify-center"
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="status-badge status-failed mt-4 p-3 normal-case tracking-normal">
          {error}
        </div>
      )}
    </div>
  );
}
