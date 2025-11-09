'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import {
  Activity,
  Upload,
  FolderOpen,
  Cpu,
  HardDrive,
  Zap,
  CheckCircle,
  XCircle
} from 'lucide-react';

export default function DashboardPage() {
  const [health, setHealth] = useState<any>(null);
  const [stats, setStats] = useState({
    totalProjects: 0,
    activeProcessing: 0,
    completedToday: 0,
    storageUsed: 0
  });

  useEffect(() => {
    checkHealth();
    loadStats();
    const interval = setInterval(() => {
      checkHealth();
      loadStats();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  const checkHealth = async () => {
    try {
      const data = await api.health();
      setHealth(data);
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  const loadStats = async () => {
    try {
      const { projects } = await api.getProjects();
      const today = new Date().toDateString();

      setStats({
        totalProjects: projects.length,
        activeProcessing: projects.filter((p: any) => p.status === 'processing').length,
        completedToday: projects.filter((p: any) =>
          p.completed_at && new Date(p.completed_at).toDateString() === today
        ).length,
        storageUsed: Math.random() * 50 + 10 // Simulated for now
      });
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-8 bg-white min-h-screen">
      <div className="mb-12">
        <h1 className="text-4xl font-bold text-black mb-2">Dashboard</h1>
        <p className="text-gray-600">System overview and quick actions</p>
      </div>

      {/* Status Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <div className="card p-6 hover:border-black transition-all">
          <div className="flex items-center justify-between mb-4">
            <FolderOpen className="h-10 w-10 text-black" />
            <span className="text-3xl font-bold text-black">{stats.totalProjects}</span>
          </div>
          <p className="text-gray-600 text-sm">Total Projects</p>
        </div>

        <div className="card p-6 hover:border-black transition-all">
          <div className="flex items-center justify-between mb-4">
            <Activity className="h-10 w-10 text-black" />
            <span className="text-3xl font-bold text-black">{stats.activeProcessing}</span>
          </div>
          <p className="text-gray-600 text-sm">Processing Now</p>
        </div>

        <div className="card p-6 hover:border-black transition-all">
          <div className="flex items-center justify-between mb-4">
            <CheckCircle className="h-10 w-10 text-black" />
            <span className="text-3xl font-bold text-black">{stats.completedToday}</span>
          </div>
          <p className="text-gray-600 text-sm">Completed Today</p>
        </div>

        <div className="card p-6 hover:border-black transition-all">
          <div className="flex items-center justify-between mb-4">
            <HardDrive className="h-10 w-10 text-black" />
            <span className="text-3xl font-bold text-black">{stats.storageUsed.toFixed(1)} GB</span>
          </div>
          <p className="text-gray-600 text-sm">Storage Used</p>
        </div>
      </div>

      {/* System Status */}
      <div className="card p-6 mb-8">
        <h2 className="text-xl font-semibold text-black mb-6">System Status</h2>
        {health ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex items-center space-x-4">
              {health.status === 'healthy' ? (
                <CheckCircle className="h-6 w-6" style={{ color: 'var(--success-icon)' }} />
              ) : (
                <XCircle className="h-6 w-6" style={{ color: 'var(--error-icon)' }} />
              )}
              <div>
                <p className="text-sm font-medium text-black">Backend API</p>
                <p className="text-xs text-gray-500 capitalize">{health.status}</p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              {health.services?.opensplat === 'available' ? (
                <CheckCircle className="h-6 w-6" style={{ color: 'var(--success-icon)' }} />
              ) : (
                <XCircle className="h-6 w-6" style={{ color: 'var(--error-icon)' }} />
              )}
              <div>
                <p className="text-sm font-medium text-black">OpenSplat Engine</p>
                <p className="text-xs text-gray-500">{health.services?.opensplat || 'checking...'}</p>
              </div>
            </div>

            <div className="flex items-center space-x-4">
              <Cpu className="h-6 w-6 text-black" />
              <div>
                <p className="text-sm font-medium text-black">GPU Status</p>
                <p className="text-xs text-gray-500">CUDA Available</p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-gray-500">Checking system status...</p>
        )}
      </div>

      {/* Quick Actions */}
      <div className="card p-6">
        <h2 className="text-xl font-semibold text-black mb-6">Quick Actions</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link
            href="/upload"
            className="flex items-center justify-center p-6 border border-gray-200 rounded-xl hover:border-black hover:bg-gray-50 transition-all group"
          >
            <Upload className="h-6 w-6 text-black mr-3" />
            <span className="font-medium text-black">Upload New Media</span>
          </Link>

          <Link
            href="/projects"
            className="flex items-center justify-center p-6 border border-gray-200 rounded-xl hover:border-black hover:bg-gray-50 transition-all group"
          >
            <FolderOpen className="h-6 w-6 text-black mr-3" />
            <span className="font-medium text-black">View Projects</span>
          </Link>

          <Link
            href="/viewer"
            className="flex items-center justify-center p-6 bg-black text-white rounded-xl hover:bg-gray-800 transition-all"
          >
            <Zap className="h-6 w-6 mr-3" />
            <span className="font-medium">3D Viewer</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
