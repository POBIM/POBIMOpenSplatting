'use client';

import { useState, useEffect, lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import {
  ArrowLeft,
  Download,
  Printer,
  QrCode,
  Info,
  CheckCircle,
  Grid3X3,
  Maximize2,
  CornerUpRight,
  Box,
  HelpCircle,
  Eye,
  RotateCcw
} from 'lucide-react';

// Lazy load Three.js component to avoid SSR issues
const RoomMarkerVisualization = lazy(() => import('@/components/RoomMarkerVisualization'));

interface MarkerPreset {
  name: string;
  description: string;
  count: number;
  size_cm: number;
  start_id?: number;
  use_case: string;
}

interface PresetsResponse {
  dictionaries: string[];
  default_dictionary: string;
  presets: MarkerPreset[];
  tips: string[];
}

export default function MarkersPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState<string>('room_standard');
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);
  const [show3DView, setShow3DView] = useState(true);
  
  // Custom settings
  const [customStartId, setCustomStartId] = useState(0);
  const [customCount, setCustomCount] = useState(12);
  const [customSizeCm, setCustomSizeCm] = useState(10);
  const [selectedDict, setSelectedDict] = useState('6x6_250');
  const [useCustom, setUseCustom] = useState(false);
  const [outputFormat, setOutputFormat] = useState<'pdf' | 'png'>('pdf');

  useEffect(() => {
    loadPresets();
  }, []);

  const loadPresets = async () => {
    try {
      const data = await api.getMarkerPresets();
      setPresets(data);
      setSelectedDict(data.default_dictionary);
    } catch (err) {
      console.error('Failed to load presets:', err);
    } finally {
      setLoading(false);
    }
  };

  const getPresetIcon = (name: string) => {
    switch (name) {
      case 'room_standard': return <Grid3X3 className="h-6 w-6" />;
      case 'room_large': return <Maximize2 className="h-6 w-6" />;
      case 'corner_small': return <CornerUpRight className="h-6 w-6" />;
      case 'object_tiny': return <Box className="h-6 w-6" />;
      default: return <QrCode className="h-6 w-6" />;
    }
  };

  const getPresetColor = (name: string) => {
    switch (name) {
      case 'room_standard': return 'bg-blue-50 border-blue-200 hover:border-blue-400';
      case 'room_large': return 'bg-green-50 border-green-200 hover:border-green-400';
      case 'corner_small': return 'bg-purple-50 border-purple-200 hover:border-purple-400';
      case 'object_tiny': return 'bg-orange-50 border-orange-200 hover:border-orange-400';
      default: return 'bg-gray-50 border-gray-200 hover:border-gray-400';
    }
  };

  const getSelectedPreset = (): MarkerPreset | null => {
    return presets?.presets.find(p => p.name === selectedPreset) || null;
  };

  const downloadMarkers = () => {
    let url: string;
    
    if (useCustom) {
      url = api.getMarkerSheetUrl({
        startId: customStartId,
        count: customCount,
        sizeCm: customSizeCm,
        dict: selectedDict,
        format: outputFormat
      });
    } else {
      const preset = getSelectedPreset();
      if (!preset) return;
      
      url = api.getMarkerSheetUrl({
        startId: preset.start_id || 0,
        count: preset.count,
        sizeCm: preset.size_cm,
        dict: selectedDict,
        format: outputFormat
      });
    }
    
    // Open download in new tab
    window.open(url, '_blank');
  };

  const previewUrl = useCustom
    ? api.getMarkerSheetUrl({
        startId: customStartId,
        count: Math.min(customCount, 6),
        sizeCm: customSizeCm,
        dict: selectedDict,
        format: 'png'  // Preview always PNG
      })
    : api.getMarkerSheetUrl({
        startId: getSelectedPreset()?.start_id || 0,
        count: Math.min(getSelectedPreset()?.count || 6, 6),
        sizeCm: getSelectedPreset()?.size_cm || 10,
        dict: selectedDict,
        format: 'png'  // Preview always PNG
      });

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">
        <div className="text-center">
          <QrCode className="h-12 w-12 mx-auto text-gray-400 animate-pulse" />
          <p className="mt-4 text-gray-600">กำลังโหลด...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <button
                onClick={() => router.back()}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div>
                <h1 className="text-xl font-bold text-black flex items-center">
                  <QrCode className="h-6 w-6 mr-2 text-blue-600" />
                  ArUco Marker Generator
                </h1>
                <p className="text-sm text-gray-500">สร้าง Marker สำหรับสแกนห้องและพื้นที่</p>
              </div>
            </div>
            <button
              onClick={downloadMarkers}
              className="px-6 py-3 bg-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors flex items-center"
            >
              <Download className="h-5 w-5 mr-2" />
              ดาวน์โหลด Markers
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left: Settings */}
          <div className="lg:col-span-2 space-y-6">
            {/* Info Banner */}
            <div className="bg-blue-50 border border-blue-200 rounded-2xl p-6">
              <div className="flex items-start">
                <Info className="h-6 w-6 text-blue-600 mt-0.5 mr-3 flex-shrink-0" />
                <div>
                  <h3 className="font-semibold text-blue-900">ทำไมต้องใช้ ArUco Markers?</h3>
                  <p className="text-sm text-blue-800 mt-1">
                    Markers ช่วยให้ COLMAP จับตำแหน่งกล้องได้แม่นยำขึ้นในพื้นที่ที่มีผนัง/พื้นเรียบๆ 
                    โดยเฉพาะห้องสี่เหลี่ยมที่ไม่มี texture มากนัก เพียงพิมพ์และวางตามมุมห้อง พื้น และผนัง
                  </p>
                </div>
              </div>
            </div>

            {/* Preset Selection */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-black">เลือกประเภท Marker</h2>
                <label className="flex items-center text-sm">
                  <input
                    type="checkbox"
                    checked={useCustom}
                    onChange={(e) => setUseCustom(e.target.checked)}
                    className="mr-2 rounded border-gray-300"
                  />
                  กำหนดเอง
                </label>
              </div>

              {!useCustom ? (
                <div className="grid grid-cols-2 gap-4">
                  {presets?.presets.map((preset) => (
                    <button
                      key={preset.name}
                      onClick={() => setSelectedPreset(preset.name)}
                      className={`p-4 rounded-xl border-2 transition-all text-left ${
                        selectedPreset === preset.name
                          ? 'border-black ring-2 ring-black/10'
                          : getPresetColor(preset.name)
                      }`}
                    >
                      <div className="flex items-center mb-2">
                        {getPresetIcon(preset.name)}
                        <span className="ml-2 font-medium text-black">{preset.description.split(' (')[0]}</span>
                      </div>
                      <div className="text-sm text-gray-600">
                        <p>{preset.count} markers • {preset.size_cm} cm</p>
                        <p className="text-xs text-gray-500 mt-1">{preset.use_case}</p>
                      </div>
                      {selectedPreset === preset.name && (
                        <CheckCircle className="h-5 w-5 text-black mt-2" />
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      เริ่มจาก ID
                    </label>
                    <input
                      type="number"
                      value={customStartId}
                      onChange={(e) => setCustomStartId(parseInt(e.target.value) || 0)}
                      min={0}
                      max={200}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      จำนวน Markers
                    </label>
                    <input
                      type="number"
                      value={customCount}
                      onChange={(e) => setCustomCount(parseInt(e.target.value) || 1)}
                      min={1}
                      max={24}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      ขนาด (cm)
                    </label>
                    <input
                      type="number"
                      value={customSizeCm}
                      onChange={(e) => setCustomSizeCm(parseFloat(e.target.value) || 5)}
                      min={3}
                      max={30}
                      step={0.5}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Dictionary Selection */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-black mb-4">ArUco Dictionary</h2>
              <select
                value={selectedDict}
                onChange={(e) => setSelectedDict(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-black"
              >
                {presets?.dictionaries.map((dict) => (
                  <option key={dict} value={dict}>
                    {dict} {dict === presets.default_dictionary ? '(แนะนำ)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-sm text-gray-500 mt-2">
                6x6 เหมาะสำหรับการใช้งานทั่วไป มีความสมดุลระหว่างระยะตรวจจับและความแม่นยำ
              </p>
            </div>

            {/* Output Format */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-black mb-4">รูปแบบไฟล์</h2>
              <div className="flex gap-4">
                <button
                  onClick={() => setOutputFormat('pdf')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all ${
                    outputFormat === 'pdf' 
                      ? 'border-black bg-black text-white' 
                      : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <div className="font-semibold">PDF (A4)</div>
                  <div className={`text-xs mt-1 ${outputFormat === 'pdf' ? 'text-gray-300' : 'text-gray-500'}`}>
                    แนะนำ - ขนาดแม่นยำ
                  </div>
                </button>
                <button
                  onClick={() => setOutputFormat('png')}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all ${
                    outputFormat === 'png' 
                      ? 'border-black bg-black text-white' 
                      : 'border-gray-200 hover:border-gray-400'
                  }`}
                >
                  <div className="font-semibold">PNG</div>
                  <div className={`text-xs mt-1 ${outputFormat === 'png' ? 'text-gray-300' : 'text-gray-500'}`}>
                    ภาพความละเอียดสูง
                  </div>
                </button>
              </div>
              <p className="text-sm text-gray-500 mt-3">
                📄 PDF จะมีขนาด A4 พร้อมพิมพ์ ขนาด marker ตรงตามที่กำหนด
              </p>
            </div>

            {/* Tips */}
            <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-6">
              <h3 className="font-semibold text-yellow-900 flex items-center mb-3">
                <HelpCircle className="h-5 w-5 mr-2" />
                เคล็ดลับการใช้งาน
              </h3>
              <ul className="space-y-2">
                {presets?.tips.map((tip, idx) => (
                  <li key={idx} className="text-sm text-yellow-800 flex items-start">
                    <span className="text-yellow-600 mr-2">•</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>

            {/* 3D Room Visualization */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-black flex items-center">
                  <Box className="h-5 w-5 mr-2 text-blue-600" />
                  ตำแหน่งติดตั้ง 3D
                </h2>
                <button
                  onClick={() => setShow3DView(!show3DView)}
                  className={`px-3 py-1.5 rounded-lg text-sm flex items-center transition-colors ${
                    show3DView 
                      ? 'bg-blue-100 text-blue-700' 
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  <Eye className="h-4 w-4 mr-1" />
                  {show3DView ? 'ซ่อน 3D' : 'แสดง 3D'}
                </button>
              </div>
              
              {show3DView && (
                <div className="h-[400px] bg-gray-50 rounded-xl overflow-hidden border border-gray-200">
                  <Suspense fallback={
                    <div className="h-full flex items-center justify-center text-gray-500">
                      <div className="text-center">
                        <RotateCcw className="h-8 w-8 mx-auto animate-spin mb-2" />
                        <p>กำลังโหลด 3D View...</p>
                      </div>
                    </div>
                  }>
                    <RoomMarkerVisualization 
                      selectedMarkerId={selectedMarkerId}
                      onMarkerSelect={setSelectedMarkerId}
                    />
                  </Suspense>
                </div>
              )}
              
              {/* Selected marker info */}
              {selectedMarkerId !== null && (
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-semibold text-blue-900">Marker ID: {selectedMarkerId}</span>
                      <p className="text-sm text-blue-700 mt-1">
                        {selectedMarkerId < 3 && 'วางบนพื้น - มุมห้องหรือกลางห้อง'}
                        {selectedMarkerId >= 3 && selectedMarkerId < 6 && 'ติดผนังระดับต่ำ (30-50 cm)'}
                        {selectedMarkerId >= 6 && selectedMarkerId < 9 && 'ติดผนังระดับกลาง (100-120 cm)'}
                        {selectedMarkerId >= 9 && 'ติดผนังระดับสูง (170-200 cm)'}
                      </p>
                    </div>
                    <button 
                      onClick={() => setSelectedMarkerId(null)}
                      className="text-blue-600 hover:text-blue-800 text-sm"
                    >
                      ยกเลิก
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Detailed Placement Guide */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-black mb-4">📐 คำแนะนำการติดตั้ง Markers (12 ตัว)</h2>
              
              {/* Level Guide Table */}
              <div className="space-y-4">
                {/* Floor Level */}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="bg-green-50 px-4 py-2 border-b border-gray-200">
                    <span className="font-semibold text-green-800">🟢 ระดับพื้น (Floor) - 3 markers</span>
                  </div>
                  <div className="p-4">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="py-2 font-medium text-gray-700">ID 0</td>
                          <td className="py-2 text-gray-600">มุมห้องที่ 1</td>
                          <td className="py-2 text-gray-500">0-10 cm</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="py-2 font-medium text-gray-700">ID 1</td>
                          <td className="py-2 text-gray-600">มุมห้องตรงข้าม</td>
                          <td className="py-2 text-gray-500">0-10 cm</td>
                        </tr>
                        <tr>
                          <td className="py-2 font-medium text-gray-700">ID 2</td>
                          <td className="py-2 text-gray-600">กลางห้อง (วางราบ)</td>
                          <td className="py-2 text-gray-500">0 cm</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Low Level */}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="bg-blue-50 px-4 py-2 border-b border-gray-200">
                    <span className="font-semibold text-blue-800">🔵 ระดับต่ำ (Low) - 3 markers</span>
                  </div>
                  <div className="p-4">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="py-2 font-medium text-gray-700">ID 3-5</td>
                          <td className="py-2 text-gray-600">ติดผนัง 3 ด้าน</td>
                          <td className="py-2 text-gray-500">30-50 cm</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="text-xs text-gray-500 mt-2">💡 ระดับเข่า - ช่วยตอนกล้องก้มลง</p>
                  </div>
                </div>

                {/* Mid Level */}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="bg-purple-50 px-4 py-2 border-b border-gray-200">
                    <span className="font-semibold text-purple-800">🟣 ระดับกลาง (Mid) - 3 markers</span>
                  </div>
                  <div className="p-4">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="py-2 font-medium text-gray-700">ID 6-8</td>
                          <td className="py-2 text-gray-600">ติดผนัง 3 ด้าน</td>
                          <td className="py-2 text-gray-500">100-120 cm</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="text-xs text-gray-500 mt-2">💡 ระดับสายตา (นั่ง) - เห็นบ่อยที่สุด</p>
                  </div>
                </div>

                {/* High Level */}
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="bg-orange-50 px-4 py-2 border-b border-gray-200">
                    <span className="font-semibold text-orange-800">🟠 ระดับสูง (High) - 3 markers</span>
                  </div>
                  <div className="p-4">
                    <table className="w-full text-sm">
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="py-2 font-medium text-gray-700">ID 9-11</td>
                          <td className="py-2 text-gray-600">ติดผนัง/เพดาน</td>
                          <td className="py-2 text-gray-500">170-200 cm</td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="text-xs text-gray-500 mt-2">💡 ระดับสายตา (ยืน) - ช่วยตอนกล้องเงยขึ้น</p>
                  </div>
                </div>
              </div>

              {/* Do and Don't */}
              <div className="mt-6 grid grid-cols-2 gap-4">
                <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                  <h4 className="font-semibold text-green-800 mb-2">✅ ควรทำ</h4>
                  <ul className="text-xs text-green-700 space-y-1">
                    <li>• กระจาย markers ให้ทั่วห้อง</li>
                    <li>• ติดหลากหลายระดับความสูง</li>
                    <li>• ติดให้แน่น ไม่ขยับ</li>
                    <li>• แสงสว่างเพียงพอ</li>
                    <li>• ห่างกันอย่างน้อย 50cm</li>
                  </ul>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <h4 className="font-semibold text-red-800 mb-2">❌ ไม่ควรทำ</h4>
                  <ul className="text-xs text-red-700 space-y-1">
                    <li>• ติดบนกระจก/โลหะมันวาว</li>
                    <li>• ติดในที่มืดหรือเงา</li>
                    <li>• พับหรือบิด marker</li>
                    <li>• ติดซ้อนทับกัน</li>
                    <li>• ติดกระจุกที่เดียว</li>
                  </ul>
                </div>
              </div>

              {/* Size Guide */}
              <div className="mt-6 bg-gray-50 rounded-xl p-4">
                <h4 className="font-semibold text-gray-800 mb-2">📏 ขนาด Marker ตามขนาดห้อง</h4>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200">
                      <th className="py-2 text-left text-gray-600">ขนาดห้อง</th>
                      <th className="py-2 text-left text-gray-600">ขนาด Marker</th>
                      <th className="py-2 text-left text-gray-600">ระยะตรวจจับ</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b border-gray-100">
                      <td className="py-2 text-gray-700">เล็ก (&lt;3x3m)</td>
                      <td className="py-2 text-gray-600">8 cm</td>
                      <td className="py-2 text-gray-500">0.5-2 เมตร</td>
                    </tr>
                    <tr className="border-b border-gray-100">
                      <td className="py-2 text-gray-700">กลาง (3x4m)</td>
                      <td className="py-2 text-gray-600">10 cm</td>
                      <td className="py-2 text-gray-500">0.5-3 เมตร</td>
                    </tr>
                    <tr>
                      <td className="py-2 text-gray-700">ใหญ่ (&gt;4x5m)</td>
                      <td className="py-2 text-gray-600">12-15 cm</td>
                      <td className="py-2 text-gray-500">1-4 เมตร</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Scanning Steps */}
              <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4">
                <h4 className="font-semibold text-blue-800 mb-2">🎬 ขั้นตอนการสแกน</h4>
                <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
                  <li>ติด markers ตามตำแหน่งด้านบน</li>
                  <li>ถ่ายวิดีโอ เดินรอบห้องช้าๆ</li>
                  <li>เริ่มจากมุมที่มี marker พื้น (ID 0)</li>
                  <li>กวาดกล้องขึ้น-ลง เพื่อเห็น markers ทุกระดับ</li>
                  <li>เดินซิกแซก ไม่ใช่เดินวนรอบอย่างเดียว</li>
                  <li>Overlap 60%+ ระหว่างเฟรม</li>
                </ol>
              </div>
            </div>
          </div>

          {/* Right: Preview */}
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-200 p-6 sticky top-24">
              <h2 className="text-lg font-semibold text-black mb-4 flex items-center">
                <Printer className="h-5 w-5 mr-2 text-gray-600" />
                ตัวอย่าง
              </h2>
              
              <div className="aspect-[3/4] bg-gray-100 rounded-xl overflow-hidden border border-gray-200">
                <img
                  src={previewUrl}
                  alt="Marker Preview"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="mt-4 space-y-3">
                <button
                  onClick={downloadMarkers}
                  className="w-full px-4 py-3 bg-black text-white rounded-xl font-medium hover:bg-gray-800 transition-colors flex items-center justify-center"
                >
                  <Download className="h-5 w-5 mr-2" />
                  ดาวน์โหลด {outputFormat.toUpperCase()}
                </button>
                
                <p className="text-xs text-gray-500 text-center">
                  {outputFormat === 'pdf' 
                    ? '📄 ไฟล์ PDF ขนาด A4 พร้อมพิมพ์ - ขนาดแม่นยำ'
                    : '🖼️ พิมพ์ที่ 100% scale (ไม่ย่อ/ขยาย) เพื่อความแม่นยำ'
                  }
                </p>
              </div>
            </div>

            {/* Placement Guide */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h3 className="font-semibold text-black mb-3">ตำแหน่งที่แนะนำ</h3>
              
              <div className="space-y-2 text-sm">
                <div className="flex items-center text-gray-700">
                  <div className="w-3 h-3 rounded-full bg-blue-500 mr-2"></div>
                  ผนังทุกด้าน (ระดับสายตา)
                </div>
                <div className="flex items-center text-gray-700">
                  <div className="w-3 h-3 rounded-full bg-green-500 mr-2"></div>
                  พื้นห้อง (กระจายทั่ว)
                </div>
                <div className="flex items-center text-gray-700">
                  <div className="w-3 h-3 rounded-full bg-purple-500 mr-2"></div>
                  มุมห้อง (ทุกมุม)
                </div>
                <div className="flex items-center text-gray-700">
                  <div className="w-3 h-3 rounded-full bg-orange-500 mr-2"></div>
                  ขอบประตู/หน้าต่าง
                </div>
              </div>

              {/* Simple room diagram */}
              <div className="mt-4 aspect-square bg-gray-50 rounded-lg p-4 relative">
                <div className="absolute inset-4 border-2 border-gray-300 rounded-lg">
                  {/* Markers visualization */}
                  <div className="absolute top-2 left-2 w-3 h-3 bg-purple-500 rounded-sm"></div>
                  <div className="absolute top-2 right-2 w-3 h-3 bg-purple-500 rounded-sm"></div>
                  <div className="absolute bottom-2 left-2 w-3 h-3 bg-purple-500 rounded-sm"></div>
                  <div className="absolute bottom-2 right-2 w-3 h-3 bg-purple-500 rounded-sm"></div>
                  
                  <div className="absolute top-1/2 left-1 w-3 h-3 bg-blue-500 rounded-sm transform -translate-y-1/2"></div>
                  <div className="absolute top-1/2 right-1 w-3 h-3 bg-blue-500 rounded-sm transform -translate-y-1/2"></div>
                  <div className="absolute top-1 left-1/2 w-3 h-3 bg-blue-500 rounded-sm transform -translate-x-1/2"></div>
                  <div className="absolute bottom-1 left-1/2 w-3 h-3 bg-blue-500 rounded-sm transform -translate-x-1/2"></div>
                  
                  <div className="absolute top-1/3 left-1/3 w-3 h-3 bg-green-500 rounded-sm"></div>
                  <div className="absolute top-1/3 right-1/3 w-3 h-3 bg-green-500 rounded-sm"></div>
                  <div className="absolute bottom-1/3 left-1/3 w-3 h-3 bg-green-500 rounded-sm"></div>
                  <div className="absolute bottom-1/3 right-1/3 w-3 h-3 bg-green-500 rounded-sm"></div>
                  
                  <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-xs text-gray-400">
                    Floor Plan
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
