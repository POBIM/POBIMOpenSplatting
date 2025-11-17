'use client';

import { useState } from 'react';
import Image from 'next/image';
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
  ImageIcon
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

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'uploaded':
        return <Clock className="h-5 w-5 text-gray-500" />;
      case 'processing':
        return <Loader className="h-5 w-5 animate-spin" style={{ color: 'var(--processing-text)' }} />;
      case 'completed':
        return <CheckCircle className="h-5 w-5" style={{ color: 'var(--success-icon)' }} />;
      case 'failed':
        return <AlertCircle className="h-5 w-5" style={{ color: 'var(--error-icon)' }} />;
      case 'cancelled':
        return <AlertCircle className="h-5 w-5" style={{ color: 'var(--warning-text)' }} />;
      default:
        return null;
    }
  };

  return (
    <div className="card-hover overflow-hidden">
      {/* Thumbnail Section */}
      <div className="relative w-full h-48 bg-gray-100">
        {!imageError ? (
          <img
            src={thumbnailUrl}
            alt={project.metadata?.name || project.id}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-gray-100 to-gray-200">
            <ImageIcon className="h-16 w-16 text-gray-400" />
          </div>
        )}

        {/* Status Badge Overlay */}
        <div className="absolute top-3 right-3">
          <span className={`status-badge ${
            project.status === 'processing' ? 'status-processing' :
            project.status === 'completed' ? 'status-completed' :
            project.status === 'failed' ? 'status-failed' :
            project.status === 'cancelled' ? 'status-cancelled' :
            'bg-gray-100 text-gray-600'
          }`}>
            {project.status.toUpperCase()}
          </span>
        </div>

        {/* Progress Bar for Processing */}
        {project.status === 'processing' && (
          <div className="absolute bottom-0 left-0 right-0 bg-black/50 backdrop-blur-sm p-2">
            <div className="w-full bg-gray-200/30 rounded-full h-1.5">
              <div
                className="bg-white h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${project.progress}%` }}
              />
            </div>
            <p className="text-xs text-white mt-1">Processing: {project.progress}%</p>
          </div>
        )}
      </div>

      {/* Content Section */}
      <div className="p-5">
        {/* Header */}
        <div className="flex items-start gap-3 mb-3">
          {getStatusIcon(project.status)}
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-black truncate">
              {project.metadata?.name || project.id}
            </h3>
            {project.metadata?.description && (
              <p className="text-sm text-gray-600 line-clamp-2 mt-1">
                {project.metadata.description}
              </p>
            )}
            <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(project.created_at).toLocaleDateString('th-TH', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
              <span className="px-2 py-0.5 bg-gray-100 rounded-full">
                {project.file_count} ไฟล์
              </span>
              <span className="px-2 py-0.5 bg-gray-100 rounded-full capitalize">
                {project.input_type}
              </span>
            </div>
          </div>
        </div>

        {/* Error Message */}
        {(project as any).error && (
          <div className="mb-3 p-2.5 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-xs text-red-800">{(project as any).error}</p>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-3 border-t border-gray-100">
          {/* View Details button for all projects */}
          <Link
            href={`/processing/${project.id}`}
            className="btn-secondary text-xs py-1.5 flex-1 min-w-[80px] justify-center"
          >
            <Info className="h-3 w-3 mr-1.5" />
            รายละเอียด
          </Link>

          {project.status === 'completed' && (
            <>
              <Link
                href={`/viewer?project=${project.id}`}
                className="btn-primary text-xs py-1.5 flex-1 min-w-[80px] justify-center"
              >
                <Eye className="h-3 w-3 mr-1.5" />
                ดู 3D
              </Link>
              <button
                onClick={() => onDownload(project.id, project.metadata?.name)}
                className="btn-secondary text-xs py-1.5 flex-1 min-w-[80px] justify-center"
              >
                <Download className="h-3 w-3 mr-1.5" />
                ดาวน์โหลด
              </button>
            </>
          )}

          <button
            onClick={() => onDelete(project.id)}
            className="inline-flex items-center justify-center px-3 py-1.5 border border-gray-200 text-xs font-medium rounded-xl text-gray-600 hover:text-red-600 hover:border-red-200 transition-colors"
          >
            <Trash2 className="h-3 w-3 mr-1.5" />
            ลบ
          </button>
        </div>
      </div>
    </div>
  );
}
