'use client';

import { useState } from 'react';
import { Save, Server, Database, Cpu, Bell } from 'lucide-react';

export default function SettingsPage() {
  const [settings, setSettings] = useState({
    backend: {
      url: 'http://localhost:5000',
      timeout: 30000,
    },
    processing: {
      maxConcurrent: 2,
      gpuEnabled: true,
      quality: 'high',
    },
    notifications: {
      enabled: true,
      sound: false,
      email: '',
    },
    storage: {
      autoCleanup: true,
      maxDays: 30,
    }
  });

  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    // Save settings to localStorage or backend
    localStorage.setItem('pobim_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Settings</h1>
        <p className="text-gray-600">Configure your PobimSplatting preferences</p>
      </div>

      <div className="space-y-6">
        {/* Backend Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center mb-4">
            <Server className="h-5 w-5 text-gray-500 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900">Backend Configuration</h2>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                API Server URL
              </label>
              <input
                type="text"
                value={settings.backend.url}
                onChange={(e) => setSettings({
                  ...settings,
                  backend: { ...settings.backend, url: e.target.value }
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Request Timeout (ms)
              </label>
              <input
                type="number"
                value={settings.backend.timeout}
                onChange={(e) => setSettings({
                  ...settings,
                  backend: { ...settings.backend, timeout: parseInt(e.target.value) }
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {/* Processing Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center mb-4">
            <Cpu className="h-5 w-5 text-gray-500 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900">Processing Options</h2>
          </div>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Max Concurrent Jobs
              </label>
              <select
                value={settings.processing.maxConcurrent}
                onChange={(e) => setSettings({
                  ...settings,
                  processing: { ...settings.processing, maxConcurrent: parseInt(e.target.value) }
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
                <option value={4}>4</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Quality Preset
              </label>
              <select
                value={settings.processing.quality}
                onChange={(e) => setSettings({
                  ...settings,
                  processing: { ...settings.processing, quality: e.target.value }
                })}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="low">Low (Fast)</option>
                <option value="medium">Medium</option>
                <option value="high">High (Slow)</option>
                <option value="ultra">Ultra (Very Slow)</option>
              </select>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="gpu-enabled"
                checked={settings.processing.gpuEnabled}
                onChange={(e) => setSettings({
                  ...settings,
                  processing: { ...settings.processing, gpuEnabled: e.target.checked }
                })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="gpu-enabled" className="ml-2 text-sm text-gray-700">
                Enable GPU Acceleration
              </label>
            </div>
          </div>
        </div>

        {/* Notification Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center mb-4">
            <Bell className="h-5 w-5 text-gray-500 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900">Notifications</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="notifications-enabled"
                checked={settings.notifications.enabled}
                onChange={(e) => setSettings({
                  ...settings,
                  notifications: { ...settings.notifications, enabled: e.target.checked }
                })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="notifications-enabled" className="ml-2 text-sm text-gray-700">
                Enable Browser Notifications
              </label>
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                id="sound-enabled"
                checked={settings.notifications.sound}
                onChange={(e) => setSettings({
                  ...settings,
                  notifications: { ...settings.notifications, sound: e.target.checked }
                })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="sound-enabled" className="ml-2 text-sm text-gray-700">
                Play Sound on Completion
              </label>
            </div>
          </div>
        </div>

        {/* Storage Settings */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center mb-4">
            <Database className="h-5 w-5 text-gray-500 mr-2" />
            <h2 className="text-xl font-semibold text-gray-900">Storage Management</h2>
          </div>
          <div className="space-y-4">
            <div className="flex items-center">
              <input
                type="checkbox"
                id="auto-cleanup"
                checked={settings.storage.autoCleanup}
                onChange={(e) => setSettings({
                  ...settings,
                  storage: { ...settings.storage, autoCleanup: e.target.checked }
                })}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
              />
              <label htmlFor="auto-cleanup" className="ml-2 text-sm text-gray-700">
                Auto-delete old projects
              </label>
            </div>
            {settings.storage.autoCleanup && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Delete projects older than (days)
                </label>
                <input
                  type="number"
                  value={settings.storage.maxDays}
                  onChange={(e) => setSettings({
                    ...settings,
                    storage: { ...settings.storage, maxDays: parseInt(e.target.value) }
                  })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
          </div>
        </div>

        {/* Save Button */}
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <Save className="h-4 w-4 mr-2" />
            {saved ? 'Settings Saved!' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}