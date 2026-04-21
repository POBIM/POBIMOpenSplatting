'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { FolderOpen, Loader, Search, SlidersHorizontal } from 'lucide-react';
import { api, Project } from '@/lib/api';
import ProjectCard from '@/components/ProjectCard';

type StatusFilter = 'all' | Project['status'];
type SortMode = 'newest' | 'oldest' | 'name';

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('newest');

  const loadProjects = useCallback(async () => {
    try {
      const data = (await api.getProjects()) as { projects: Project[] };
      setProjects(data.projects);
      setError(null);
    } catch {
      setError('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProjects();
    const interval = window.setInterval(() => {
      void loadProjects();
    }, 5000);

    return () => window.clearInterval(interval);
  }, [loadProjects]);

  const handleDelete = async (projectId: string) => {
    if (!confirm('Are you sure you want to delete this project?')) return;

    try {
      await api.deleteProject(projectId);
      await loadProjects();
    } catch {
      alert('Failed to delete project');
    }
  };

  const handleDownload = (projectId: string, projectName?: string) => {
    const downloadUrl = `http://localhost:5000/api/download/${projectId}`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `${projectName || 'model'}_${projectId.slice(0, 8)}.ply`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredProjects = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    const visible = projects.filter((project) => {
      const name = project.metadata?.name?.toLowerCase() ?? '';
      const matchesQuery = normalizedQuery.length === 0 || name.includes(normalizedQuery) || project.id.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' || project.status === statusFilter;

      return matchesQuery && matchesStatus;
    });

    return visible.sort((a, b) => {
      if (sortMode === 'name') {
        return (a.metadata?.name || a.id).localeCompare(b.metadata?.name || b.id);
      }

      const delta = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      return sortMode === 'newest' ? delta : -delta;
    });
  }, [projects, searchQuery, sortMode, statusFilter]);

  const statusCounts = useMemo(() => {
    return projects.reduce<Record<StatusFilter, number>>(
      (acc, project) => {
        acc[project.status] += 1;
        acc.all += 1;
        return acc;
      },
      {
        all: 0,
        uploading: 0,
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
    );
  }, [projects]);

  if (loading) {
    return (
      <div className="brutal-shell flex min-h-screen items-center justify-center">
        <div className="brutal-card-dark flex items-center gap-3 p-4">
          <Loader className="h-5 w-5 animate-spin" />
          <span className="text-sm font-black uppercase tracking-wide">Loading projects</span>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container space-y-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <span className="brutal-eyebrow rotate-1">Project Index</span>
              <div>
                <h1 className="brutal-h1">Projects</h1>
                <p className="mt-2 max-w-2xl text-sm font-medium text-[color:var(--text-secondary)]">
                  Monitor processing status, jump into viewers, and manage your reconstruction backlog.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <span className="brutal-badge">{statusCounts.all} total</span>
              <span className="brutal-badge brutal-badge-info">{statusCounts.processing} processing</span>
              <span className="brutal-badge brutal-badge-success">{statusCounts.completed} completed</span>
              <Link href="/upload" className="brutal-btn brutal-btn-primary">
                New Project
              </Link>
            </div>
          </div>

          <div className="brutal-card-muted p-3 md:p-4">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div className="grid flex-1 gap-3 md:grid-cols-[minmax(0,1.5fr)_minmax(180px,0.7fr)_minmax(180px,0.7fr)]">
                <div>
                  <label htmlFor="project-search" className="brutal-label mb-2 inline-block">Search</label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[color:var(--text-muted)]" />
                    <input
                      id="project-search"
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Project name or ID"
                      className="brutal-input pl-9"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="project-status-filter" className="brutal-label mb-2 inline-block">Status</label>
                  <select
                    id="project-status-filter"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                    className="brutal-select"
                  >
                    <option value="all">All statuses</option>
                    <option value="uploading">Uploading</option>
                    <option value="pending">Pending</option>
                    <option value="processing">Processing</option>
                    <option value="completed">Completed</option>
                    <option value="failed">Failed</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="project-sort-mode" className="brutal-label mb-2 inline-block">Sort</label>
                  <select
                    id="project-sort-mode"
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                    className="brutal-select"
                  >
                    <option value="newest">Newest first</option>
                    <option value="oldest">Oldest first</option>
                    <option value="name">Name A-Z</option>
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2 border border-[color:var(--ink)] bg-white px-3 py-2 text-xs font-bold uppercase tracking-[0.15em] text-[color:var(--text-secondary)]">
                <SlidersHorizontal className="h-3.5 w-3.5 text-[color:var(--ink)]" />
                {filteredProjects.length} visible
              </div>
            </div>
          </div>

          {error && (
            <div
              className="p-3 text-sm font-bold uppercase tracking-wide"
              style={{ background: 'var(--error-bg)', color: 'var(--error-text)', border: 'var(--border-w) solid var(--ink)', boxShadow: 'var(--shadow-sm)' }}
            >
              {error}
            </div>
          )}

          {filteredProjects.length === 0 ? (
            <div className="brutal-card p-8 md:p-10 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-sm)]">
                <FolderOpen className="h-7 w-7 text-[color:var(--ink)]" />
              </div>
              <h2 className="brutal-h2 mt-4">No Projects Found</h2>
              <p className="mx-auto mt-2 max-w-md text-sm font-medium text-[color:var(--text-secondary)]">
                {projects.length === 0
                  ? 'Get started by uploading your first media set.'
                  : 'Adjust the search or filters to reveal matching projects.'}
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Link href="/upload" className="brutal-btn brutal-btn-primary">
                  Upload Media
                </Link>
                {projects.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setStatusFilter('all');
                      setSortMode('newest');
                    }}
                    className="brutal-btn"
                  >
                    Reset Filters
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredProjects.map((project) => (
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
      </section>
    </div>
  );
}
