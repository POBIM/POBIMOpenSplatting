'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Clock,
  CheckCircle,
  AlertCircle,
  Loader,
  Eye,
  Trash2,
  Download,
  Info,
  ImageIcon,
} from 'lucide-react';
import { Project } from '@/lib/api';

interface ProjectCardProps {
  project: Project;
  onDelete: (projectId: string) => void;
  onDownload: (projectId: string, projectName?: string) => void;
}

export default function ProjectCard({ project, onDelete, onDownload }: ProjectCardProps) {
  const [imageError, setImageError] = useState(false);
  const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
  const thumbnailUrl = `${API_BASE_URL}/api/project/${project.id}/thumbnail`;
  const errorMessage = (project as unknown as { error?: string }).error;

  const statusIcon = (() => {
    switch (project.status) {
      case 'uploading':
      case 'pending':
        return <Clock className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />;
      case 'processing':
        return <Loader className="h-4 w-4 animate-spin" style={{ color: 'var(--processing-icon)' }} />;
      case 'completed':
        return <CheckCircle className="h-4 w-4" style={{ color: 'var(--success-icon)' }} />;
      case 'failed':
        return <AlertCircle className="h-4 w-4" style={{ color: 'var(--error-icon)' }} />;
      case 'cancelled':
        return <AlertCircle className="h-4 w-4" style={{ color: 'var(--warning-icon)' }} />;
      default:
        return null;
    }
  })();

  const statusClass =
    project.status === 'processing' ? 'status-processing' :
    project.status === 'completed' ? 'status-completed' :
    project.status === 'failed' ? 'status-failed' :
    project.status === 'cancelled' ? 'status-cancelled' :
    'status-badge';

  return (
    <div className="brutal-card-hover overflow-hidden flex flex-col">
      <div className="relative w-full aspect-[16/10] bg-[color:var(--paper-muted)]" style={{ borderBottom: 'var(--border-w) solid var(--ink)' }}>
        {!imageError ? (
          <img
            src={thumbnailUrl}
            alt={project.metadata?.name || project.id}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center" style={{ background: 'var(--paper-muted-2)' }}>
            <ImageIcon className="h-10 w-10" style={{ color: 'var(--text-muted)' }} />
          </div>
        )}

        <div className="absolute top-2 right-2">
          <span className={statusClass}>
            {project.status.toUpperCase()}
          </span>
        </div>

        {project.status === 'processing' && (
          <div
            className="absolute bottom-0 left-0 right-0 px-2 py-1.5"
            style={{ background: 'var(--ink)', color: '#fff', borderTop: 'var(--border-w) solid var(--ink)' }}
          >
            <div className="w-full h-1" style={{ background: 'var(--ink-600)' }}>
              <div
                className="h-1 transition-all duration-300"
                style={{ width: `${project.progress}%`, background: '#fff' }}
              />
            </div>
            <p className="text-[10px] font-bold uppercase tracking-wider mt-0.5">
              {project.progress}% Processing
            </p>
          </div>
        )}
      </div>

      <div className="p-3 flex flex-col gap-2 flex-1">
        <div className="flex items-start gap-2">
          <span className="mt-0.5">{statusIcon}</span>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-black uppercase tracking-tight text-[color:var(--ink)] truncate">
              {project.metadata?.name || project.id}
            </h3>
            {project.metadata?.description && (
              <p className="text-xs text-[color:var(--text-secondary)] line-clamp-2 mt-0.5 font-medium">
                {project.metadata.description}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[color:var(--text-muted)]">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            {new Date(project.created_at).toLocaleDateString('th-TH', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </span>
          <span
            className="px-1.5 py-0.5"
            style={{ background: 'var(--paper-muted)', border: 'var(--border-w) solid var(--ink)' }}
          >
            {project.file_count} FILES
          </span>
          <span
            className="px-1.5 py-0.5"
            style={{ background: 'var(--paper-muted)', border: 'var(--border-w) solid var(--ink)' }}
          >
            {project.input_type}
          </span>
        </div>

        {errorMessage && (
          <div
            className="px-2 py-1.5"
            style={{ background: 'var(--error-bg)', border: 'var(--border-w) solid var(--ink)' }}
          >
            <p className="text-[11px] font-bold" style={{ color: 'var(--error-text)' }}>
              {errorMessage}
            </p>
          </div>
        )}

        <div
          className="mt-auto pt-2 flex flex-wrap gap-1.5"
          style={{ borderTop: 'var(--border-w) solid var(--ink)' }}
        >
          <Link
            href={`/processing/${project.id}`}
            className="brutal-btn brutal-btn-xs flex-1 min-w-[90px]"
          >
            <Info className="h-3 w-3" />
            รายละเอียด
          </Link>

          {project.status === 'completed' && (
            <>
              <Link
                href={`/viewer?project=${project.id}`}
                className="brutal-btn brutal-btn-primary brutal-btn-xs flex-1 min-w-[80px]"
              >
                <Eye className="h-3 w-3" />
                ดู 3D
              </Link>
              <button
                type="button"
                onClick={() => onDownload(project.id, project.metadata?.name)}
                className="brutal-btn brutal-btn-xs flex-1 min-w-[90px]"
              >
                <Download className="h-3 w-3" />
                ดาวน์โหลด
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => onDelete(project.id)}
            className="brutal-btn brutal-btn-xs"
            aria-label="Delete project"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}
