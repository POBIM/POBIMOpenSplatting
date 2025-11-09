'use client';

import { useState, useEffect } from 'react';
import { api, Project } from '@/lib/api';
import {
  FolderOpen,
  Loader
} from 'lucide-react';
import Link from 'next/link';
import ProjectCard from '@/components/ProjectCard';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProjects();
    const interval = setInterval(loadProjects, 5000); // Refresh every 5 seconds
    return () => clearInterval(interval);
  }, []);

  const loadProjects = async () => {
    try {
      const data = await api.getProjects();
      setProjects(data.projects.sort((a: any, b: any) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      ));
      setError(null);
    } catch (err) {
      setError('Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      await api.deleteProject(projectId);
      await loadProjects();
    } catch (err) {
      alert('Failed to delete project');
    }
  };

  const handleDownload = (projectId: string, projectName?: string) => {
    // Create download link with backend API endpoint
    const downloadUrl = `http://localhost:5000/api/download/${projectId}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${projectName || 'model'}_${projectId.slice(0, 8)}.ply`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="h-8 w-8 text-blue-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-8 bg-white min-h-screen">
      <div className="mb-12 flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold text-black mb-2">Projects</h1>
          <p className="text-gray-600">Manage your 3D reconstruction projects</p>
        </div>
        <Link
          href="/upload"
          className="btn-primary"
        >
          New Project
        </Link>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl">
          <p className="text-red-800 text-sm">{error}</p>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="card p-16 text-center">
          <FolderOpen className="mx-auto h-16 w-16 text-gray-300 mb-6" />
          <h3 className="text-xl font-semibold text-black mb-2">No projects yet</h3>
          <p className="text-gray-500 mb-6">Get started by uploading your first media file</p>
          <Link
            href="/upload"
            className="btn-primary"
          >
            Upload Media
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDelete={handleDelete}
              onDownload={handleDownload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
