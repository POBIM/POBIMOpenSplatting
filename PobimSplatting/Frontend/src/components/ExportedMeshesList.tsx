'use client';

import { useState, useEffect } from 'react';
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

export default function ExportedMeshesList({ projectId }: ExportedMeshesListProps) {
  const [exports, setExports] = useState<Export[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchExports = async () => {
    setLoading(true);
    setError('');

    try {
      const data = await api.getAvailableExports(projectId);
      setExports(data.exports || []);
    } catch (err: any) {
      const errorMsg = err.response?.data?.error || err.message || 'Network error';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchExports();
  }, [projectId]);

  const handleDownload = (downloadUrl: string) => {
    // Use the API base URL + download URL  
    const fullUrl = `http://localhost:5000${downloadUrl}`;
    window.location.href = fullUrl;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getFormatIcon = (format: string) => {
    switch (format) {
      case 'glb':
      case 'gltf':
        return <Package className="w-5 h-5 text-blue-400" />;
      case 'obj':
      case 'ply':
      case 'dae':
        return <FileCode className="w-5 h-5 text-green-400" />;
      default:
        return <FileCode className="w-5 h-5 text-gray-400" />;
    }
  };

  const getFormatColor = (format: string) => {
    switch (format) {
      case 'glb':
        return 'bg-blue-900/30 text-blue-300 border-blue-700/50';
      case 'obj':
        return 'bg-green-900/30 text-green-300 border-green-700/50';
      case 'ply':
        return 'bg-purple-900/30 text-purple-300 border-purple-700/50';
      case 'dae':
        return 'bg-yellow-900/30 text-yellow-300 border-yellow-700/50';
      default:
        return 'bg-gray-900/30 text-gray-300 border-gray-700/50';
    }
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
        <div className="flex items-center justify-center gap-2 text-gray-400">
          <Loader className="w-5 h-5 animate-spin" />
          <span>Loading exports...</span>
        </div>
      </div>
    );
  }

  if (exports.length === 0) {
    return null; // Don't show if no exports
  }

  return (
    <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Package className="w-5 h-5 text-blue-400" />
          <h3 className="text-lg font-semibold text-white">
            Exported Meshes ({exports.length})
          </h3>
        </div>
        <button
          onClick={fetchExports}
          className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
          title="Refresh"
        >
          <RefreshCw className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      <div className="space-y-2">
        {exports.map((exp, index) => (
          <div
            key={index}
            className="bg-gray-900/50 rounded-lg p-4 border border-gray-700 hover:border-gray-600 transition-colors"
          >
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                {getFormatIcon(exp.format)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-medium text-white truncate">
                      {exp.filename}
                    </p>
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium border ${getFormatColor(
                        exp.format
                      )}`}
                    >
                      {exp.format.toUpperCase()}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-400">
                    <span>{exp.size_mb.toFixed(1)} MB</span>
                    <span>•</span>
                    <span>{formatDate(exp.created_at)}</span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => handleDownload(exp.download_url)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors flex-shrink-0"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-900/20 border border-red-700/50 rounded-lg">
          <p className="text-sm text-red-200">{error}</p>
        </div>
      )}
    </div>
  );
}
