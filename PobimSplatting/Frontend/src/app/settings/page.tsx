'use client';

import { useState } from 'react';
import { Save, Server, Database, Cpu, Bell } from 'lucide-react';

type SettingsState = {
  backend: {
    url: string;
    timeout: number;
  };
  processing: {
    maxConcurrent: number;
    gpuEnabled: boolean;
    quality: string;
  };
  notifications: {
    enabled: boolean;
    sound: boolean;
    email: string;
  };
  storage: {
    autoCleanup: boolean;
    maxDays: number;
  };
};

function SectionHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
}: {
  icon: typeof Server;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="brutal-eyebrow mb-2">{eyebrow}</div>
        <h2 className="brutal-h3">{title}</h2>
        <p className="mt-1 text-sm text-[color:var(--text-secondary)]">{description}</p>
      </div>
    </div>
  );
}

function ToggleField({
  id,
  checked,
  label,
  description,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  description?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="brutal-card-muted flex cursor-pointer items-start justify-between gap-4 p-4"
    >
      <div>
        <div className="text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">
          {label}
        </div>
        {description && (
          <p className="mt-1 text-sm text-[color:var(--text-secondary)]">{description}</p>
        )}
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--ink)]"
      />
    </label>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsState>({
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
    },
  });

  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    localStorage.setItem('pobim_settings', JSON.stringify(settings));
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container max-w-4xl">
          <div className="brutal-card brutal-dot-bg relative overflow-hidden p-5 md:p-6">
            <div className="relative z-10">
              <div className="brutal-eyebrow mb-3">System Control</div>
              <h1 className="brutal-h1">Settings</h1>
              <p className="mt-3 max-w-2xl text-sm text-[color:var(--text-secondary)] md:text-base">
                Configure backend connectivity, processing defaults, notifications, and cleanup rules.
              </p>
            </div>
          </div>

          <div className="mt-6 space-y-5">
            <section className="brutal-card p-5">
              <SectionHeader
                icon={Server}
                eyebrow="Backend"
                title="Backend Configuration"
                description="Point the admin UI at the correct API host and timeout window."
              />
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="backend-url" className="brutal-label mb-2 block">API Server URL</label>
                  <input
                    id="backend-url"
                    type="text"
                    value={settings.backend.url}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        backend: { ...settings.backend, url: event.target.value },
                      })
                    }
                    className="brutal-input"
                  />
                </div>
                <div>
                  <label htmlFor="backend-timeout" className="brutal-label mb-2 block">Request Timeout (ms)</label>
                  <input
                    id="backend-timeout"
                    type="number"
                    value={settings.backend.timeout}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        backend: {
                          ...settings.backend,
                          timeout: Number.parseInt(event.target.value, 10) || 0,
                        },
                      })
                    }
                    className="brutal-input"
                  />
                </div>
              </div>
            </section>

            <section className="brutal-card p-5">
              <SectionHeader
                icon={Cpu}
                eyebrow="Processing"
                title="Processing Defaults"
                description="Tune queue density, GPU usage, and quality targets for new runs."
              />
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label htmlFor="processing-max-concurrent" className="brutal-label mb-2 block">Max Concurrent Jobs</label>
                    <select
                      id="processing-max-concurrent"
                      value={settings.processing.maxConcurrent}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          processing: {
                            ...settings.processing,
                            maxConcurrent: Number.parseInt(event.target.value, 10) || 1,
                          },
                        })
                      }
                      className="brutal-select"
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={3}>3</option>
                      <option value={4}>4</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="processing-quality" className="brutal-label mb-2 block">Quality Preset</label>
                    <select
                      id="processing-quality"
                      value={settings.processing.quality}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          processing: { ...settings.processing, quality: event.target.value },
                        })
                      }
                      className="brutal-select"
                    >
                      <option value="low">Low (Fast)</option>
                      <option value="medium">Medium</option>
                      <option value="high">High (Slow)</option>
                      <option value="ultra">Ultra (Very Slow)</option>
                    </select>
                  </div>
                </div>

                <ToggleField
                  id="gpu-enabled"
                  checked={settings.processing.gpuEnabled}
                  label="Enable GPU Acceleration"
                  description="Prefer GPU-backed reconstruction and processing when hardware is available."
                  onChange={(gpuEnabled) =>
                    setSettings({
                      ...settings,
                      processing: { ...settings.processing, gpuEnabled },
                    })
                  }
                />
              </div>
            </section>

            <section className="brutal-card p-5">
              <SectionHeader
                icon={Bell}
                eyebrow="Notifications"
                title="Alerts"
                description="Control browser alerts and completion feedback for operators."
              />
              <div className="space-y-4">
                <ToggleField
                  id="notifications-enabled"
                  checked={settings.notifications.enabled}
                  label="Enable Browser Notifications"
                  description="Send status updates when long-running work changes state."
                  onChange={(enabled) =>
                    setSettings({
                      ...settings,
                      notifications: { ...settings.notifications, enabled },
                    })
                  }
                />

                <ToggleField
                  id="sound-enabled"
                  checked={settings.notifications.sound}
                  label="Play Sound On Completion"
                  description="Add a local audio cue when jobs finish."
                  onChange={(sound) =>
                    setSettings({
                      ...settings,
                      notifications: { ...settings.notifications, sound },
                    })
                  }
                />
              </div>
            </section>

            <section className="brutal-card p-5">
              <SectionHeader
                icon={Database}
                eyebrow="Storage"
                title="Storage Management"
                description="Keep working directories compact with automatic project cleanup."
              />
              <div className="space-y-4">
                <ToggleField
                  id="auto-cleanup"
                  checked={settings.storage.autoCleanup}
                  label="Auto-delete Old Projects"
                  description="Remove stale data after the configured retention period."
                  onChange={(autoCleanup) =>
                    setSettings({
                      ...settings,
                      storage: { ...settings.storage, autoCleanup },
                    })
                  }
                />

                {settings.storage.autoCleanup && (
                  <div>
                    <label htmlFor="storage-max-days" className="brutal-label mb-2 block">Delete Projects Older Than (days)</label>
                    <input
                      id="storage-max-days"
                      type="number"
                      value={settings.storage.maxDays}
                      onChange={(event) =>
                        setSettings({
                          ...settings,
                          storage: {
                            ...settings.storage,
                            maxDays: Number.parseInt(event.target.value, 10) || 0,
                          },
                        })
                      }
                      className="brutal-input"
                    />
                  </div>
                )}
              </div>
            </section>

            <div className="flex flex-col gap-3 border-t-[var(--border-w)] border-[color:var(--ink)] pt-5 md:flex-row md:items-center md:justify-between">
              <p className="text-sm uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                Changes save to local browser storage.
              </p>
              <button type="button" onClick={handleSave} className="brutal-btn brutal-btn-primary brutal-btn-lg self-start md:self-auto">
                <Save className="h-4 w-4" />
                {saved ? 'Settings Saved!' : 'Save Settings'}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
