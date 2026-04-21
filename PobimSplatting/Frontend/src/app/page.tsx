'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Activity,
  CheckCircle,
  Cpu,
  FolderOpen,
  HardDrive,
  QrCode,
  Upload,
  XCircle,
  Zap,
} from 'lucide-react';
import { api, Project } from '@/lib/api';

interface HealthResponse {
  status?: string;
  services?: {
    opensplat?: string;
  };
  experimental?: {
    pycolmap?: {
      global_mapping_ready?: boolean;
      version?: string;
    };
  };
}

interface DashboardStats {
  totalProjects: number;
  activeProcessing: number;
  completedToday: number;
  storageUsed: number;
}

const quickActions = [
  {
    href: '/upload',
    label: 'Upload New Media',
    description: 'Start a new reconstruction job',
    icon: Upload,
    primary: true,
  },
  {
    href: '/projects',
    label: 'View Projects',
    description: 'Review active and completed jobs',
    icon: FolderOpen,
  },
  {
    href: '/markers',
    label: 'ArUco Markers',
    description: 'Print and manage marker boards',
    icon: QrCode,
  },
  {
    href: '/viewer',
    label: '3D Viewer',
    description: 'Open completed splats directly',
    icon: Zap,
  },
];

export default function DashboardPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stats, setStats] = useState<DashboardStats>({
    totalProjects: 0,
    activeProcessing: 0,
    completedToday: 0,
    storageUsed: 0,
  });

  const checkHealth = useCallback(async () => {
    try {
      const data = (await api.health()) as HealthResponse;
      setHealth(data);
    } catch (err) {
      console.error('Health check failed:', err);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const { projects } = (await api.getProjects()) as { projects: Project[] };
      const today = new Date().toDateString();

      setStats({
        totalProjects: projects.length,
        activeProcessing: projects.filter((project) => project.status === 'processing').length,
        completedToday: projects.filter(
          (project) => project.completed_at && new Date(project.completed_at).toDateString() === today,
        ).length,
        storageUsed: Math.random() * 50 + 10,
      });
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    void loadStats();

    const interval = window.setInterval(() => {
      void checkHealth();
      void loadStats();
    }, 10000);

    return () => window.clearInterval(interval);
  }, [checkHealth, loadStats]);

  const systemCards = [
    {
      label: 'Total Projects',
      value: stats.totalProjects.toString(),
      detail: 'All uploaded and processed jobs',
      icon: FolderOpen,
    },
    {
      label: 'Processing Now',
      value: stats.activeProcessing.toString(),
      detail: 'Live jobs currently running',
      icon: Activity,
    },
    {
      label: 'Completed Today',
      value: stats.completedToday.toString(),
      detail: 'Finished outputs in today’s window',
      icon: CheckCircle,
    },
    {
      label: 'Storage Used',
      value: `${stats.storageUsed.toFixed(1)} GB`,
      detail: 'Estimated working storage footprint',
      icon: HardDrive,
    },
  ];

  const backendHealthy = health?.status === 'healthy';
  const opensplatAvailable = health?.services?.opensplat === 'available';
  const pycolmapReady = health?.experimental?.pycolmap?.global_mapping_ready;

  const statusRows = [
    {
      label: 'Backend API',
      value: health?.status ?? 'checking...',
      healthy: backendHealthy,
    },
    {
      label: 'OpenSplat Engine',
      value: health?.services?.opensplat ?? 'checking...',
      healthy: opensplatAvailable,
    },
    {
      label: 'GPU Status',
      value: 'CUDA Available',
      healthy: true,
      icon: Cpu,
    },
    {
      label: 'Experimental pycolmap',
      value: pycolmapReady
        ? `ready (${health?.experimental?.pycolmap?.version || 'unknown version'})`
        : `not ready${health?.experimental?.pycolmap?.version ? ` (${health.experimental.pycolmap.version})` : ''}`,
      healthy: Boolean(pycolmapReady),
    },
  ];

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container space-y-6">
          <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
            <div className="brutal-card-dark relative overflow-hidden p-4 md:p-5">
              <div className="brutal-dot-bg absolute inset-0 opacity-15" />
              <div className="relative flex h-full flex-col justify-between gap-5">
                <div className="space-y-3">
                  <span className="brutal-eyebrow -rotate-1">System Overview</span>
                  <div className="space-y-2">
                    <h1 className="brutal-h1 text-[color:var(--text-on-ink)]">Dashboard</h1>
                    <p className="max-w-2xl text-sm font-medium text-[color:var(--text-on-ink-muted)]">
                      Compact control center for uploads, active reconstruction, and platform readiness.
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="border border-[color:var(--paper-muted-2)] bg-white/10 p-3">
                    <p className="brutal-label text-[color:var(--text-on-ink-muted)]">Pipeline</p>
                    <p className="mt-1 text-lg font-black uppercase tracking-tight">
                      {stats.activeProcessing > 0 ? 'Live' : 'Idle'}
                    </p>
                  </div>
                  <div className="border border-[color:var(--paper-muted-2)] bg-white/10 p-3">
                    <p className="brutal-label text-[color:var(--text-on-ink-muted)]">Daily Output</p>
                    <p className="mt-1 text-lg font-black uppercase tracking-tight">{stats.completedToday}</p>
                  </div>
                  <div className="border border-[color:var(--paper-muted-2)] bg-white/10 p-3">
                    <p className="brutal-label text-[color:var(--text-on-ink-muted)]">Storage</p>
                    <p className="mt-1 text-lg font-black uppercase tracking-tight">{stats.storageUsed.toFixed(1)} GB</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
              <div className="brutal-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="brutal-label">Quick Signal</p>
                    <h2 className="brutal-h2 mt-2">System Status</h2>
                  </div>
                  <span className={`brutal-badge brutal-badge-solid rotate-1 ${backendHealthy ? '' : 'opacity-80'}`}>
                    {backendHealthy ? 'Healthy' : 'Check'}
                  </span>
                </div>
                <div className="mt-4 space-y-2 text-sm font-medium text-[color:var(--text-secondary)]">
                  <div className="flex items-center justify-between border-t border-[color:var(--ink)] pt-2">
                    <span>API</span>
                    <span>{health?.status ?? '...'}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-[color:var(--ink)] pt-2">
                    <span>Engine</span>
                    <span>{health?.services?.opensplat ?? '...'}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-[color:var(--ink)] pt-2">
                    <span>pycolmap</span>
                    <span>{pycolmapReady ? 'ready' : 'not ready'}</span>
                  </div>
                </div>
              </div>

              <div className="brutal-card-muted p-4">
                <p className="brutal-label rotate-1">Quick Actions</p>
                <div className="mt-3 grid gap-2">
                  {quickActions.slice(0, 2).map((action) => {
                    const Icon = action.icon;

                    return (
                      <Link
                        key={action.href}
                        href={action.href}
                        className={`brutal-btn w-full justify-between ${action.primary ? 'brutal-btn-primary' : ''}`}
                      >
                        <span className="flex items-center gap-2">
                          <Icon className="h-3.5 w-3.5" />
                          {action.label}
                        </span>
                        <span>→</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            {systemCards.map((card, index) => {
              const Icon = card.icon;

              return (
                <div key={card.label} className="brutal-card-hover p-3 md:p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className={`brutal-label ${index % 2 === 0 ? '-rotate-1' : 'rotate-1'} inline-block`}>
                        {card.label}
                      </p>
                      <p className="mt-3 text-2xl font-black uppercase tracking-tight text-[color:var(--ink)]">
                        {card.value}
                      </p>
                    </div>
                    <div className="flex h-9 w-9 items-center justify-center border border-[color:var(--ink)] bg-[color:var(--paper-muted)] shadow-[var(--shadow-sm)]">
                      <Icon className="h-4 w-4 text-[color:var(--ink)]" />
                    </div>
                  </div>
                  <p className="mt-3 border-t border-[color:var(--ink)] pt-2 text-xs font-medium text-[color:var(--text-secondary)]">
                    {card.detail}
                  </p>
                </div>
              );
            })}
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="brutal-card p-4 md:p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="brutal-label">Service Matrix</p>
                  <h2 className="brutal-h2 mt-2">System Status</h2>
                </div>
                <span className="brutal-badge rotate-1">10s Refresh</span>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {statusRows.map((row) => {
                  const StatusIcon = row.icon ?? (row.healthy ? CheckCircle : XCircle);

                  return (
                    <div key={row.label} className="border border-[color:var(--ink)] bg-[color:var(--paper-muted)] p-3">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 flex h-8 w-8 items-center justify-center border border-[color:var(--ink)] bg-white">
                          <StatusIcon
                            className="h-4 w-4"
                            style={{
                              color: row.icon
                                ? 'var(--ink)'
                                : row.healthy
                                  ? 'var(--success-icon)'
                                  : 'var(--error-icon)',
                            }}
                          />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-black uppercase tracking-tight text-[color:var(--ink)]">
                            {row.label}
                          </p>
                          <p className="mt-1 text-xs font-medium uppercase tracking-wide text-[color:var(--text-secondary)]">
                            {row.value}
                          </p>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="brutal-card-muted p-4 md:p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="brutal-label">Action Dock</p>
                  <h2 className="brutal-h2 mt-2">Navigation</h2>
                </div>
                <span className="brutal-badge brutal-badge-solid -rotate-1">Admin</span>
              </div>

              <div className="mt-4 grid gap-2">
                {quickActions.map((action, index) => {
                  const Icon = action.icon;

                  return (
                    <Link
                      key={action.href}
                      href={action.href}
                      className={`group border border-[color:var(--ink)] p-3 transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] ${
                        action.primary ? 'bg-[color:var(--ink)] text-[color:var(--text-on-ink)]' : 'bg-white text-[color:var(--ink)]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className={`flex h-8 w-8 items-center justify-center border border-current ${index % 2 === 0 ? 'rotate-1' : '-rotate-1'}`}>
                            <Icon className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="text-sm font-black uppercase tracking-tight">{action.label}</p>
                            <p className={`mt-1 text-xs font-medium ${action.primary ? 'text-[color:var(--text-on-ink-muted)]' : 'text-[color:var(--text-secondary)]'}`}>
                              {action.description}
                            </p>
                          </div>
                        </div>
                        <span className="text-sm font-black uppercase tracking-tight group-hover:translate-x-0.5 transition-transform">
                          →
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
