'use client';

import { useState } from 'react';
import { Box, Download, Eraser, Hammer, Logs, Search } from 'lucide-react';
import { api } from '@/lib/api';

type MeshMethod = 'poisson' | 'delaunay';
type MeshQuality = 'low' | 'medium' | 'high';
type MeshFormat = 'ply' | 'obj' | 'glb' | 'dae';

type ExportSummary = {
  filename: string;
  size_mb?: number;
};

type ExportCheckResponse = {
  exports?: ExportSummary[];
};

type MeshExportResponse = {
  success?: boolean;
  filename?: string;
  error?: string;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  return 'Unknown error';
}

function getErrorResponseData(error: unknown): unknown {
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response?: unknown }).response !== null &&
    'data' in ((error as { response: { data?: unknown } }).response)
  ) {
    return ((error as { response: { data?: unknown } }).response).data;
  }

  return undefined;
}

export default function TestMeshPage() {
  const [projectId, setProjectId] = useState('58e94cf4-569b-4857-963e-25622333b1d8');
  const [method, setMethod] = useState<MeshMethod>('poisson');
  const [quality, setQuality] = useState<MeshQuality>('low');
  const [format, setFormat] = useState<MeshFormat>('glb');
  const [log, setLog] = useState<Array<{ id: string; message: string }>>([]);

  const addLog = (message: string) => {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setLog((previous) => [...previous, { id, message: `[${timestamp}] ${message}` }]);
    console.log(`[${timestamp}] ${message}`);
  };

  const handleExport = async () => {
    addLog('='.repeat(70));
    addLog('Starting mesh export test...');
    addLog(`Project ID: ${projectId}`);
    addLog(`Settings: ${method}, ${quality}, ${format}`);

    try {
      addLog('Calling api.createTexturedMesh...');
      const data = (await api.createTexturedMesh(projectId, {
        method,
        quality,
        format,
      })) as unknown as MeshExportResponse;

      addLog(`Response: ${JSON.stringify(data, null, 2)}`);

      if (data.success) {
        addLog('✅ Export started successfully!');
        addLog(`Filename: ${data.filename ?? 'unknown'}`);
      } else {
        addLog('❌ Export failed!');
        addLog(`Error: ${data.error ?? 'Unknown export failure'}`);
      }
    } catch (error: unknown) {
      addLog('❌ Exception occurred!');
      addLog(`Error: ${getErrorMessage(error)}`);
      addLog(`Response data: ${JSON.stringify(getErrorResponseData(error))}`);
      console.error('Full error:', error);
    }

    addLog('='.repeat(70));
  };

  const handleCheckExports = async () => {
    addLog('Checking available exports...');

    try {
      const data = (await api.getAvailableExports(projectId)) as unknown as ExportCheckResponse;
      addLog(`Found ${data.exports?.length || 0} exports`);

      if (data.exports && data.exports.length > 0) {
        data.exports.forEach((exportItem) => {
          addLog(`  📦 ${exportItem.filename} (${exportItem.size_mb ?? 0} MB)`);
        });
      } else {
        addLog('  No exports found yet');
      }
    } catch (error: unknown) {
      addLog('❌ Error checking exports');
      addLog(`Error: ${getErrorMessage(error)}`);
    }
  };

  return (
    <div className="brutal-shell">
      <section className="brutal-section">
        <div className="brutal-container max-w-5xl space-y-5">
          <div className="brutal-card brutal-dot-bg relative overflow-hidden p-5 md:p-6">
            <div className="relative z-10 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <div className="brutal-eyebrow mb-3">Dev Sandbox</div>
                <h1 className="brutal-h1">Mesh Export Test</h1>
                <p className="mt-3 max-w-2xl text-sm text-[color:var(--text-secondary)]">
                  Quick admin harness for trying mesh export combinations and inspecting raw backend responses.
                </p>
              </div>
              <div className="brutal-badge brutal-badge-solid">No Production Side Effects Hidden</div>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
            <div className="brutal-card p-5">
              <div className="mb-4 flex items-center gap-3">
                <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
                  <Hammer className="h-5 w-5" />
                </div>
                <div>
                  <div className="brutal-eyebrow mb-2">Controls</div>
                  <h2 className="brutal-h3">Export Parameters</h2>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label htmlFor="mesh-project-id" className="brutal-label mb-2 block">Project ID</label>
                  <input
                    id="mesh-project-id"
                    type="text"
                    value={projectId}
                    onChange={(event) => setProjectId(event.target.value)}
                    className="brutal-input"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
                  <div>
                    <label htmlFor="mesh-method" className="brutal-label mb-2 block">Method</label>
                    <select
                      id="mesh-method"
                      value={method}
                      onChange={(event) => setMethod(event.target.value as MeshMethod)}
                      className="brutal-select"
                    >
                      <option value="poisson">Poisson</option>
                      <option value="delaunay">Delaunay</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="mesh-quality" className="brutal-label mb-2 block">Quality</label>
                    <select
                      id="mesh-quality"
                      value={quality}
                      onChange={(event) => setQuality(event.target.value as MeshQuality)}
                      className="brutal-select"
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="mesh-format" className="brutal-label mb-2 block">Format</label>
                    <select
                      id="mesh-format"
                      value={format}
                      onChange={(event) => setFormat(event.target.value as MeshFormat)}
                      className="brutal-select"
                    >
                      <option value="glb">GLB</option>
                      <option value="obj">OBJ</option>
                      <option value="ply">PLY</option>
                      <option value="dae">DAE</option>
                    </select>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1">
                  <button type="button" onClick={handleExport} className="brutal-btn brutal-btn-primary brutal-btn-lg w-full justify-center">
                    <Download className="h-4 w-4" />
                    Test Export
                  </button>
                  <button type="button" onClick={handleCheckExports} className="brutal-btn brutal-btn-lg w-full justify-center">
                    <Search className="h-4 w-4" />
                    Check Exports
                  </button>
                  <button type="button" onClick={() => setLog([])} className="brutal-btn brutal-btn-ghost brutal-btn-lg w-full justify-center border-[var(--border-w)] border-[color:var(--ink)]">
                    <Eraser className="h-4 w-4" />
                    Clear
                  </button>
                </div>
              </div>
            </div>

            <div className="brutal-card p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
                    <Logs className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="brutal-eyebrow mb-2">Output</div>
                    <h2 className="brutal-h3">Event Log</h2>
                  </div>
                </div>
                <div className="brutal-badge">
                  <Box className="h-3.5 w-3.5" />
                  {format.toUpperCase()}
                </div>
              </div>

              <div className="brutal-card-dark brutal-scroll h-96 overflow-y-auto p-4 font-mono text-xs leading-6">
                {log.length === 0 ? (
                  <div className="space-y-2 text-[color:var(--text-on-ink-muted)]">
                    <div>• Test page loaded</div>
                    <div>• Use TEST EXPORT to start a background mesh job</div>
                    <div>• Use CHECK EXPORTS to inspect completed files</div>
                  </div>
                ) : (
                  log.map((entry) => (
                    <div
                      key={entry.id}
                      className={
                        entry.message.includes('✅')
                          ? 'text-green-300'
                          : entry.message.includes('❌')
                             ? 'text-red-300'
                            : entry.message.includes('===')
                               ? 'text-blue-200'
                               : 'text-[color:var(--text-on-ink-muted)]'
                      }
                    >
                      {entry.message}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
