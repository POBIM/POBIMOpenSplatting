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
  RotateCcw,
} from 'lucide-react';

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

type PlacementBand = 'floor' | 'low' | 'mid' | 'high';

const PLACEMENT_LEVELS: Array<{
  key: PlacementBand;
  title: string;
  badge: string;
  hint: string;
  rows: Array<{ id: string; location: string; height: string }>;
}> = [
  {
    key: 'floor',
    title: 'ระดับพื้น (Floor)',
    badge: '3 Markers',
    hint: 'ระดับพื้นช่วย anchor ตำแหน่งตอนก้มกล้องและหมุนรอบห้อง',
    rows: [
      { id: 'ID 0', location: 'มุมห้องที่ 1', height: '0-10 cm' },
      { id: 'ID 1', location: 'มุมห้องตรงข้าม', height: '0-10 cm' },
      { id: 'ID 2', location: 'กลางห้อง (วางราบ)', height: '0 cm' },
    ],
  },
  {
    key: 'low',
    title: 'ระดับต่ำ (Low)',
    badge: '3 Markers',
    hint: 'ระดับเข่าเพิ่มจุดอ้างอิงเวลาถ่ายมุมก้มและขอบผนัง',
    rows: [{ id: 'ID 3-5', location: 'ติดผนัง 3 ด้าน', height: '30-50 cm' }],
  },
  {
    key: 'mid',
    title: 'ระดับกลาง (Mid)',
    badge: '3 Markers',
    hint: 'ระดับสายตานั่งเป็นช่วงที่กล้องเห็นบ่อยที่สุด',
    rows: [{ id: 'ID 6-8', location: 'ติดผนัง 3 ด้าน', height: '100-120 cm' }],
  },
  {
    key: 'high',
    title: 'ระดับสูง (High)',
    badge: '3 Markers',
    hint: 'ระดับสูงช่วยล็อกเพดาน แนวขอบ และจังหวะเงยกล้อง',
    rows: [{ id: 'ID 9-11', location: 'ติดผนัง/เพดาน', height: '170-200 cm' }],
  },
];

const DO_ITEMS = [
  'กระจาย markers ให้ทั่วห้อง',
  'ติดหลายระดับความสูง',
  'ยึดให้แน่น ไม่ขยับ',
  'รักษาแสงสว่างให้สม่ำเสมอ',
  'เว้นระยะอย่างน้อย 50 cm',
];

const DONT_ITEMS = [
  'ติดบนกระจกหรือโลหะมันวาว',
  'วางในเงามืดหรือย้อนแสง',
  'พับหรือบิด marker',
  'ติดซ้อนทับกัน',
  'กอง markers ไว้โซนเดียว',
];

const SIZE_GUIDE = [
  { room: 'เล็ก (<3x3m)', marker: '8 cm', range: '0.5-2 เมตร' },
  { room: 'กลาง (3x4m)', marker: '10 cm', range: '0.5-3 เมตร' },
  { room: 'ใหญ่ (>4x5m)', marker: '12-15 cm', range: '1-4 เมตร' },
];

const SCAN_STEPS = [
  'ติด markers ตามตำแหน่งด้านบน',
  'ถ่ายวิดีโอโดยเดินช้า ๆ รอบห้อง',
  'เริ่มจากมุมที่มี marker พื้น (ID 0)',
  'กวาดกล้องขึ้น-ลงให้เห็นทุกระดับ',
  'เดินซิกแซก ไม่ใช่วงกลมอย่างเดียว',
  'รักษา overlap ระหว่างเฟรม 60%+',
];

function getPresetIcon(name: string) {
  switch (name) {
    case 'room_standard':
      return <Grid3X3 className="h-5 w-5" />;
    case 'room_large':
      return <Maximize2 className="h-5 w-5" />;
    case 'corner_small':
      return <CornerUpRight className="h-5 w-5" />;
    case 'object_tiny':
      return <Box className="h-5 w-5" />;
    default:
      return <QrCode className="h-5 w-5" />;
  }
}

function getSelectedMarkerDescription(selectedMarkerId: number) {
  if (selectedMarkerId < 3) {
    return 'วางบนพื้น - มุมห้องหรือกลางห้อง';
  }
  if (selectedMarkerId < 6) {
    return 'ติดผนังระดับต่ำ (30-50 cm)';
  }
  if (selectedMarkerId < 9) {
    return 'ติดผนังระดับกลาง (100-120 cm)';
  }
  return 'ติดผนังระดับสูง (170-200 cm)';
}

export default function MarkersPage() {
  const router = useRouter();
  const [presets, setPresets] = useState<PresetsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState<string>('room_standard');
  const [selectedMarkerId, setSelectedMarkerId] = useState<number | null>(null);
  const [show3DView, setShow3DView] = useState(true);
  const [customStartId, setCustomStartId] = useState(0);
  const [customCount, setCustomCount] = useState(12);
  const [customSizeCm, setCustomSizeCm] = useState(10);
  const [selectedDict, setSelectedDict] = useState('6x6_250');
  const [useCustom, setUseCustom] = useState(false);
  const [outputFormat, setOutputFormat] = useState<'pdf' | 'png'>('pdf');

  useEffect(() => {
    const loadPresets = async () => {
      try {
        const data = await api.getMarkerPresets();
        setPresets(data);
        setSelectedDict(data.default_dictionary);
      } catch (error) {
        console.error('Failed to load presets:', error);
      } finally {
        setLoading(false);
      }
    };

    void loadPresets();
  }, []);

  const getSelectedPreset = (): MarkerPreset | null => {
    return presets?.presets.find((preset) => preset.name === selectedPreset) || null;
  };

  const downloadMarkers = () => {
    let url: string;

    if (useCustom) {
      url = api.getMarkerSheetUrl({
        startId: customStartId,
        count: customCount,
        sizeCm: customSizeCm,
        dict: selectedDict,
        format: outputFormat,
      });
    } else {
      const preset = getSelectedPreset();
      if (!preset) {
        return;
      }

      url = api.getMarkerSheetUrl({
        startId: preset.start_id || 0,
        count: preset.count,
        sizeCm: preset.size_cm,
        dict: selectedDict,
        format: outputFormat,
      });
    }

    window.open(url, '_blank');
  };

  const selectedPresetData = getSelectedPreset();
  const previewUrl = useCustom
    ? api.getMarkerSheetUrl({
        startId: customStartId,
        count: Math.min(customCount, 6),
        sizeCm: customSizeCm,
        dict: selectedDict,
        format: 'png',
      })
    : api.getMarkerSheetUrl({
        startId: selectedPresetData?.start_id || 0,
        count: Math.min(selectedPresetData?.count || 6, 6),
        sizeCm: selectedPresetData?.size_cm || 10,
        dict: selectedDict,
        format: 'png',
      });

  if (loading) {
    return (
      <div className="brutal-shell flex min-h-screen items-center justify-center px-4">
        <div className="brutal-card p-6 text-center">
          <QrCode className="brutal-pulse mx-auto h-10 w-10" />
          <p className="mt-3 text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
            Loading Marker Presets
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-shell">
      <section className="brutal-section-tight brutal-divider sticky top-0 z-20 bg-[color:var(--paper)]">
        <div className="brutal-container flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex items-start gap-3">
            <button type="button" onClick={() => router.back()} className="brutal-btn brutal-btn-ghost border-[var(--border-w)] border-[color:var(--ink)]">
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div>
              <div className="brutal-eyebrow mb-2">Capture Prep</div>
              <h1 className="brutal-h2 flex items-center gap-2">
                <QrCode className="h-5 w-5" />
                ArUco Marker Generator
              </h1>
              <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
                Generate printable room markers with compact install guidance and live placement preview.
              </p>
            </div>
          </div>

          <button type="button" onClick={downloadMarkers} className="brutal-btn brutal-btn-primary brutal-btn-lg self-start lg:self-auto">
            <Download className="h-4 w-4" />
            Download Markers
          </button>
        </div>
      </section>

      <section className="brutal-section">
        <div className="brutal-container grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_320px]">
          <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
            <div className="brutal-card p-4">
              <div className="brutal-eyebrow mb-3">Preset List</div>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="brutal-h3">Marker Sets</h2>
                <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                  <input
                    type="checkbox"
                    checked={useCustom}
                    onChange={(event) => setUseCustom(event.target.checked)}
                    className="h-4 w-4 accent-[var(--ink)]"
                  />
                  Custom
                </label>
              </div>

              {!useCustom ? (
                <div className="space-y-3">
                  {presets?.presets.map((preset) => {
                    const isSelected = selectedPreset === preset.name;
                    return (
                      <button
                        key={preset.name}
                        type="button"
                        onClick={() => setSelectedPreset(preset.name)}
                        className={`w-full p-4 text-left ${isSelected ? 'brutal-card' : 'brutal-card-muted'}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <div className="brutal-card flex h-10 w-10 items-center justify-center p-2">
                              {getPresetIcon(preset.name)}
                            </div>
                            <div className="min-w-0">
                              <div className="text-sm font-bold uppercase tracking-[0.12em] text-[color:var(--text-primary)]">
                                {preset.description.split(' (')[0]}
                              </div>
                              <p className="mt-1 text-xs text-[color:var(--text-secondary)]">
                                {preset.count} markers • {preset.size_cm} cm
                              </p>
                              <p className="mt-1 text-xs text-[color:var(--text-muted)]">{preset.use_case}</p>
                            </div>
                          </div>
                          {isSelected && <CheckCircle className="h-4 w-4 flex-shrink-0" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label htmlFor="custom-start-id" className="brutal-label mb-2 block">
                      Start ID
                    </label>
                    <input
                      id="custom-start-id"
                      type="number"
                      value={customStartId}
                      onChange={(event) => setCustomStartId(Number.parseInt(event.target.value, 10) || 0)}
                      min={0}
                      max={200}
                      className="brutal-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="custom-count" className="brutal-label mb-2 block">
                      Marker Count
                    </label>
                    <input
                      id="custom-count"
                      type="number"
                      value={customCount}
                      onChange={(event) => setCustomCount(Number.parseInt(event.target.value, 10) || 1)}
                      min={1}
                      max={24}
                      className="brutal-input"
                    />
                  </div>
                  <div>
                    <label htmlFor="custom-size" className="brutal-label mb-2 block">
                      Size (cm)
                    </label>
                    <input
                      id="custom-size"
                      type="number"
                      value={customSizeCm}
                      onChange={(event) => setCustomSizeCm(Number.parseFloat(event.target.value) || 5)}
                      min={3}
                      max={30}
                      step={0.5}
                      className="brutal-input"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="brutal-card p-4">
              <div className="brutal-eyebrow mb-3">Dictionary</div>
              <label htmlFor="marker-dictionary" className="brutal-label mb-2 block">
                ArUco Dictionary
              </label>
              <select
                id="marker-dictionary"
                value={selectedDict}
                onChange={(event) => setSelectedDict(event.target.value)}
                className="brutal-select"
              >
                {presets?.dictionaries.map((dict) => (
                  <option key={dict} value={dict}>
                    {dict} {dict === presets.default_dictionary ? '(แนะนำ)' : ''}
                  </option>
                ))}
              </select>
              <p className="mt-3 text-xs text-[color:var(--text-secondary)]">
                6x6 เหมาะกับงานทั่วไปและบาลานซ์เรื่องระยะตรวจจับกับความแม่นยำได้ดี
              </p>
            </div>

            <div className="brutal-card p-4">
              <div className="brutal-eyebrow mb-3">Output</div>
              <h2 className="brutal-h3 mb-3">File Format</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
                {(['pdf', 'png'] as const).map((format) => {
                  const active = outputFormat === format;
                  return (
                    <button
                      key={format}
                      type="button"
                      onClick={() => setOutputFormat(format)}
                      className={active ? 'brutal-card-dark p-4 text-left' : 'brutal-card-muted p-4 text-left'}
                    >
                      <div className="text-sm font-bold uppercase tracking-[0.14em]">{format}</div>
                      <div className={`mt-1 text-xs ${active ? 'text-[color:var(--text-on-ink-muted)]' : 'text-[color:var(--text-secondary)]'}`}>
                        {format === 'pdf' ? 'Recommended for exact print scale' : 'High-resolution image output'}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="space-y-5">
            <div className="brutal-card p-5">
              <div className="mb-4 flex items-start gap-3">
                <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
                  <Info className="h-5 w-5" />
                </div>
                <div>
                  <div className="brutal-eyebrow mb-2">Why Markers</div>
                  <h2 className="brutal-h3">Improve Sparse Reconstruction In Flat Rooms</h2>
                  <p className="mt-2 text-sm text-[color:var(--text-secondary)]">
                    Markers give COLMAP better anchor points in spaces with smooth walls, plain floors, and low texture.
                    Print, place, then capture varied heights to stabilize the solve.
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.95fr)]">
              <div className="space-y-5">
                <div className="brutal-card p-5">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <div>
                      <div className="brutal-eyebrow mb-2">Live Editor</div>
                      <h2 className="brutal-h3">Placement Preview</h2>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShow3DView(!show3DView)}
                      className={`brutal-btn brutal-btn-xs ${show3DView ? 'brutal-btn-primary' : ''}`}
                    >
                      <Eye className="h-3.5 w-3.5" />
                      {show3DView ? 'Hide 3D' : 'Show 3D'}
                    </button>
                  </div>

                  {show3DView ? (
                    <div className="brutal-card overflow-hidden">
                      <div className="flex items-center justify-between border-b-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted)] px-4 py-2">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                          <Box className="h-4 w-4" />
                          3D Room Install View
                        </div>
                        <div className="flex gap-1.5">
                          <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-card)]" />
                          <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted-2)]" />
                          <span className="h-2.5 w-2.5 border-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--ink)]" />
                        </div>
                      </div>

                      <div className="h-[400px] bg-[color:var(--paper)]">
                        <Suspense
                          fallback={
                            <div className="flex h-full items-center justify-center">
                              <div className="text-center">
                                <RotateCcw className="brutal-pulse mx-auto mb-2 h-8 w-8" />
                                <p className="text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                                  Loading 3D View
                                </p>
                              </div>
                            </div>
                          }
                        >
                          <RoomMarkerVisualization
                            selectedMarkerId={selectedMarkerId}
                            onMarkerSelect={setSelectedMarkerId}
                          />
                        </Suspense>
                      </div>
                    </div>
                  ) : (
                    <div className="brutal-card-muted flex h-40 items-center justify-center p-4 text-center text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
                      3D preview hidden
                    </div>
                  )}

                  {selectedMarkerId !== null && (
                    <div className="brutal-card-muted mt-4 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="brutal-badge brutal-badge-info mb-2">Marker ID {selectedMarkerId}</div>
                          <p className="text-sm text-[color:var(--text-secondary)]">
                            {getSelectedMarkerDescription(selectedMarkerId)}
                          </p>
                        </div>
                        <button type="button" onClick={() => setSelectedMarkerId(null)} className="brutal-btn brutal-btn-xs">
                          Clear
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <div className="brutal-card p-5">
                  <div className="mb-4">
                    <div className="brutal-eyebrow mb-2">Install Guide</div>
                    <h2 className="brutal-h3">Recommended 12-Marker Placement</h2>
                  </div>

                  <div className="space-y-4">
                    {PLACEMENT_LEVELS.map((level) => (
                      <div key={level.key} className="brutal-card-muted overflow-hidden">
                        <div className="flex items-center justify-between border-b-[var(--border-w)] border-[color:var(--ink)] px-4 py-3">
                          <div className="text-sm font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">
                            {level.title}
                          </div>
                          <div className="brutal-badge">{level.badge}</div>
                        </div>
                        <div className="p-4">
                          <table className="w-full text-sm">
                            <tbody>
                              {level.rows.map((row) => (
                                <tr key={`${level.key}-${row.id}`} className="border-b-[var(--border-w)] border-dashed border-[color:var(--paper-muted-2)] last:border-b-0">
                                  <td className="py-2 pr-3 font-bold uppercase tracking-[0.1em] text-[color:var(--text-primary)]">{row.id}</td>
                                  <td className="py-2 pr-3 text-[color:var(--text-secondary)]">{row.location}</td>
                                  <td className="py-2 text-right text-[color:var(--text-muted)]">{row.height}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="mt-3 text-xs uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">
                            {level.hint}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid gap-5 md:grid-cols-2">
                  <div className="brutal-card p-5">
                    <div className="brutal-eyebrow mb-2">Do</div>
                    <h3 className="brutal-h3 mb-3">Recommended</h3>
                    <ul className="space-y-2 text-sm text-[color:var(--text-secondary)]">
                      {DO_ITEMS.map((item) => (
                        <li key={item} className="flex items-start gap-2">
                          <span className="brutal-badge brutal-badge-success mt-0.5">✓</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="brutal-card p-5">
                    <div className="brutal-eyebrow mb-2">Avoid</div>
                    <h3 className="brutal-h3 mb-3">Do Not</h3>
                    <ul className="space-y-2 text-sm text-[color:var(--text-secondary)]">
                      {DONT_ITEMS.map((item) => (
                        <li key={item} className="flex items-start gap-2">
                          <span className="brutal-badge brutal-badge-error mt-0.5">×</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="brutal-card p-5">
                  <div className="brutal-eyebrow mb-2">Sizing</div>
                  <h3 className="brutal-h3 mb-4">Marker Size Guide</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b-[var(--border-w)] border-[color:var(--ink)] text-left">
                        <th className="pb-2 pr-3 font-bold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">Room</th>
                        <th className="pb-2 pr-3 font-bold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">Marker</th>
                        <th className="pb-2 font-bold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">Range</th>
                      </tr>
                    </thead>
                    <tbody>
                      {SIZE_GUIDE.map((row) => (
                        <tr key={row.room} className="border-b-[var(--border-w)] border-dashed border-[color:var(--paper-muted-2)] last:border-b-0">
                          <td className="py-3 pr-3 text-[color:var(--text-primary)]">{row.room}</td>
                          <td className="py-3 pr-3 text-[color:var(--text-secondary)]">{row.marker}</td>
                          <td className="py-3 text-[color:var(--text-muted)]">{row.range}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="brutal-card p-5">
                  <div className="brutal-eyebrow mb-2">Capture Steps</div>
                  <h3 className="brutal-h3 mb-4">Scanning Sequence</h3>
                  <ol className="space-y-3 text-sm text-[color:var(--text-secondary)]">
                    {SCAN_STEPS.map((step, index) => (
                      <li key={step} className="flex items-start gap-3">
                        <span className="brutal-badge min-w-8 justify-center">{index + 1}</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>

              <div className="space-y-5">
                <div className="brutal-card p-5 xl:sticky xl:top-24">
                  <div className="mb-4 flex items-center gap-3">
                    <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
                      <Printer className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="brutal-eyebrow mb-2">Preview</div>
                      <h2 className="brutal-h3">Printable Sheet</h2>
                    </div>
                  </div>

                  <div className="brutal-card overflow-hidden p-3">
                    <div className="aspect-[3/4] bg-[color:var(--paper)]">
                      <img src={previewUrl} alt="Marker Preview" className="h-full w-full object-contain" />
                    </div>
                  </div>

                  <button type="button" onClick={downloadMarkers} className="brutal-btn brutal-btn-primary brutal-btn-lg mt-4 w-full justify-center">
                    <Download className="h-4 w-4" />
                    Download {outputFormat.toUpperCase()}
                  </button>

                  <p className="mt-3 text-center text-xs text-[color:var(--text-secondary)]">
                    {outputFormat === 'pdf'
                      ? 'PDF ขนาด A4 พร้อมพิมพ์ ขนาด marker ตรงตามที่กำหนด'
                      : 'พิมพ์ที่ 100% scale (ไม่ย่อ/ขยาย) เพื่อความแม่นยำ'}
                  </p>
                </div>

                <div className="brutal-card p-5">
                  <div className="brutal-eyebrow mb-2">Placement Map</div>
                  <h3 className="brutal-h3 mb-4">Quick Reference</h3>

                  <div className="space-y-3 text-sm text-[color:var(--text-secondary)]">
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#3b82f6]" />
                      ผนังทุกด้าน (ระดับสายตา)
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#22c55e]" />
                      พื้นห้อง (กระจายทั่ว)
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#a855f7]" />
                      มุมห้อง (ทุกมุม)
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#f97316]" />
                      ขอบประตูหรือหน้าต่าง
                    </div>
                  </div>

                  <div className="brutal-card-muted relative mt-4 aspect-square p-4">
                    <div className="absolute inset-4 border-[var(--border-w-strong)] border-[color:var(--ink)]">
                      <div className="absolute left-2 top-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#a855f7]" />
                      <div className="absolute right-2 top-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#a855f7]" />
                      <div className="absolute bottom-2 left-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#a855f7]" />
                      <div className="absolute bottom-2 right-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#a855f7]" />

                      <div className="absolute left-1 top-1/2 h-3 w-3 -translate-y-1/2 border-[var(--border-w)] border-[color:var(--ink)] bg-[#3b82f6]" />
                      <div className="absolute right-1 top-1/2 h-3 w-3 -translate-y-1/2 border-[var(--border-w)] border-[color:var(--ink)] bg-[#3b82f6]" />
                      <div className="absolute left-1/2 top-1 h-3 w-3 -translate-x-1/2 border-[var(--border-w)] border-[color:var(--ink)] bg-[#3b82f6]" />
                      <div className="absolute bottom-1 left-1/2 h-3 w-3 -translate-x-1/2 border-[var(--border-w)] border-[color:var(--ink)] bg-[#3b82f6]" />

                      <div className="absolute left-1/3 top-1/3 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#22c55e]" />
                      <div className="absolute right-1/3 top-1/3 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#22c55e]" />
                      <div className="absolute bottom-1/3 left-1/3 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#22c55e]" />
                      <div className="absolute bottom-1/3 right-1/3 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)] bg-[#22c55e]" />

                      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-muted)]">
                        Floor Plan
                      </div>
                    </div>
                  </div>
                </div>

                <div className="brutal-card p-5">
                  <div className="mb-4 flex items-center gap-3">
                    <div className="brutal-card-muted flex h-10 w-10 items-center justify-center p-2">
                      <HelpCircle className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="brutal-eyebrow mb-2">Field Notes</div>
                      <h3 className="brutal-h3">Tips</h3>
                    </div>
                  </div>
                  <ul className="space-y-3 text-sm text-[color:var(--text-secondary)]">
                    {presets?.tips.map((tip) => (
                      <li key={tip} className="flex items-start gap-2">
                        <span className="brutal-badge">Tip</span>
                        <span>{tip}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </main>
        </div>
      </section>
    </div>
  );
}
