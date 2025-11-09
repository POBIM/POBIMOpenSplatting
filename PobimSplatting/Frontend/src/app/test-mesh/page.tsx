'use client';

import { useState } from 'react';
import { api } from '@/lib/api';

export default function TestMeshPage() {
  const [projectId, setProjectId] = useState('58e94cf4-569b-4857-963e-25622333b1d8');
  const [method, setMethod] = useState<'poisson' | 'delaunay'>('poisson');
  const [quality, setQuality] = useState<'low' | 'medium' | 'high'>('low');
  const [format, setFormat] = useState<'ply' | 'obj' | 'glb' | 'dae'>('glb');
  const [log, setLog] = useState<string[]>([]);

  const addLog = (message: string) => {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    setLog(prev => [...prev, `[${timestamp}] ${message}`]);
    console.log(`[${timestamp}] ${message}`);
  };

  const handleExport = async () => {
    addLog('='.repeat(70));
    addLog('Starting mesh export test...');
    addLog(`Project ID: ${projectId}`);
    addLog(`Settings: ${method}, ${quality}, ${format}`);

    try {
      addLog('Calling api.createTexturedMesh...');
      
      const data = await api.createTexturedMesh(projectId, {
        method,
        quality,
        format,
      });

      addLog(`Response: ${JSON.stringify(data, null, 2)}`);

      if (data.success) {
        addLog('✅ Export started successfully!');
        addLog(`Filename: ${data.filename}`);
      } else {
        addLog('❌ Export failed!');
        addLog(`Error: ${data.error}`);
      }
    } catch (error: any) {
      addLog('❌ Exception occurred!');
      addLog(`Error: ${error.message}`);
      addLog(`Response data: ${JSON.stringify(error.response?.data)}`);
      console.error('Full error:', error);
    }
    
    addLog('='.repeat(70));
  };

  const handleCheckExports = async () => {
    addLog('Checking available exports...');
    
    try {
      const data = await api.getAvailableExports(projectId);
      addLog(`Found ${data.exports?.length || 0} exports`);
      
      if (data.exports && data.exports.length > 0) {
        data.exports.forEach((exp: any) => {
          addLog(`  📦 ${exp.filename} (${exp.size_mb} MB)`);
        });
      } else {
        addLog('  No exports found yet');
      }
    } catch (error: any) {
      addLog('❌ Error checking exports');
      addLog(`Error: ${error.message}`);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="bg-gray-800 rounded-lg p-6 border border-gray-700">
          <h1 className="text-2xl font-bold text-white mb-6">🧪 Mesh Export Test</h1>

          <div className="space-y-4 mb-6">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Project ID
              </label>
              <input
                type="text"
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Method
                </label>
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as any)}
                  className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600"
                >
                  <option value="poisson">Poisson</option>
                  <option value="delaunay">Delaunay</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Quality
                </label>
                <select
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as any)}
                  className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Format
                </label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as any)}
                  className="w-full px-4 py-2 bg-gray-700 text-white rounded-lg border border-gray-600"
                >
                  <option value="glb">GLB</option>
                  <option value="obj">OBJ</option>
                  <option value="ply">PLY</option>
                  <option value="dae">DAE</option>
                </select>
              </div>
            </div>
          </div>

          <div className="flex gap-3 mb-6">
            <button
              onClick={handleExport}
              className="flex-1 px-6 py-3 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg font-medium hover:from-blue-700 hover:to-blue-800 transition-colors"
            >
              🚀 Test Export
            </button>
            <button
              onClick={handleCheckExports}
              className="flex-1 px-6 py-3 bg-gradient-to-r from-green-600 to-green-700 text-white rounded-lg font-medium hover:from-green-700 hover:to-green-800 transition-colors"
            >
              📋 Check Exports
            </button>
            <button
              onClick={() => setLog([])}
              className="px-6 py-3 bg-gray-700 text-white rounded-lg font-medium hover:bg-gray-600 transition-colors"
            >
              🗑️ Clear
            </button>
          </div>

          {/* Log Display */}
          <div className="bg-black rounded-lg p-4 h-96 overflow-y-auto font-mono text-xs">
            {log.length === 0 ? (
              <div className="text-green-400">
                <div>🚀 Test page loaded</div>
                <div>💡 Click "Test Export" to start mesh export</div>
                <div>💡 Click "Check Exports" to see completed exports</div>
              </div>
            ) : (
              log.map((line, i) => (
                <div
                  key={i}
                  className={
                    line.includes('✅')
                      ? 'text-green-400'
                      : line.includes('❌')
                      ? 'text-red-400'
                      : line.includes('===')
                      ? 'text-blue-400'
                      : 'text-green-300'
                  }
                >
                  {line}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
