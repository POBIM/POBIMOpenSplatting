import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  AXIS_ORDER,
  SNAP_AXIS_CONFIG,
  type AxisComponentSummary,
  type MeasurementOverlayState,
} from './useMeasurementTools';

interface MeasurementOverlayProps {
  overlayState: MeasurementOverlayState;
  selectedDistanceLabel: string | null;
  selectedDistanceChainLabel: string | null;
  selectedDistanceId: string | null;
  selectedAxisComponents: AxisComponentSummary | null;
  selectedAreaLabel: string | null;
  selectedAreaPerimeterLabel: string | null;
  selectedAreaId: string | null;
  onSelectDistance: (id: string) => void;
  onSelectArea: (id: string) => void;
  onDeleteMeasurement: (id: string) => void;
  onDeleteArea: (id: string) => void;
  onOpenRescaleDialog: () => void;
}

export function MeasurementOverlay({
  overlayState,
  selectedDistanceLabel,
  selectedDistanceChainLabel,
  selectedDistanceId,
  selectedAxisComponents,
  selectedAreaLabel,
  selectedAreaPerimeterLabel,
  selectedAreaId,
  onSelectDistance,
  onSelectArea,
  onDeleteMeasurement,
  onDeleteArea,
  onOpenRescaleDialog,
}: MeasurementOverlayProps) {
  const {
    measurementScreenData,
    areaScreenData,
    areaPreview,
    axisGuides,
    baseProjection,
    previewProjection,
    previewLabel,
    previewAxisComponents,
    activeAxisLabel,
    pointerHandlers,
    handleStartDrag,
    handleStartAreaVertex,
    isOverlayInteractive,
  } = overlayState;

  return (
    <>
      {/* Pointer interaction layer */}
      <div
        className={`absolute inset-0 z-30 ${isOverlayInteractive ? 'pointer-events-auto' : 'pointer-events-none'}`}
        onPointerDown={pointerHandlers.onPointerDown}
        onPointerMove={pointerHandlers.onPointerMove}
        onPointerUp={pointerHandlers.onPointerUp}
        onPointerLeave={pointerHandlers.onPointerLeave}
        onContextMenu={(event) => event.preventDefault()}
      >
        <svg
          className="h-full w-full"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          style={{ pointerEvents: 'none' }}
        >
          {/* Area polygons */}
          {areaScreenData.map((item) => (
            <g key={`area-${item.id}`}>
              <polygon
                points={item.path.map((point) => `${point.x},${point.y}`).join(' ')}
                fill={item.isSelected ? 'rgba(14, 165, 233, 0.25)' : 'rgba(37, 99, 235, 0.12)'}
                stroke={item.isSelected ? '#0ea5e9' : '#2563eb'}
                strokeWidth={item.isSelected ? 0.6 : 0.45}
                strokeLinejoin="round"
                style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                onClick={() => onSelectArea(item.id)}
              />
              {item.isSelected &&
                item.vertices?.map((vertex) => (
                  <g
                    key={`area-vertex-${item.id}-${vertex.index}`}
                    style={{ pointerEvents: 'auto', cursor: 'grab' }}
                    onPointerDown={(e: ReactPointerEvent<SVGGElement>) =>
                      handleStartAreaVertex?.(e as any, item.id, vertex.index, vertex.nodeId)
                    }
                  >
                    <circle
                      cx={vertex.x}
                      cy={vertex.y}
                      r={0.65}
                      fill="none"
                      stroke="#1f2937"
                      strokeWidth={0.15}
                    />
                    {/* X mark */}
                    <line
                      x1={vertex.x - 0.35}
                      y1={vertex.y - 0.35}
                      x2={vertex.x + 0.35}
                      y2={vertex.y + 0.35}
                      stroke="#1f2937"
                      strokeWidth={0.12}
                    />
                    <line
                      x1={vertex.x - 0.35}
                      y1={vertex.y + 0.35}
                      x2={vertex.x + 0.35}
                      y2={vertex.y - 0.35}
                      stroke="#1f2937"
                      strokeWidth={0.12}
                    />
                  </g>
                ))}
            </g>
          ))}

          {/* Area preview (while drawing) */}
          {areaPreview && (
            <>
              <polygon
                points={areaPreview.path.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="rgba(59, 130, 246, 0.12)"
                stroke="#2563eb"
                strokeWidth={0.4}
                strokeLinejoin="round"
                strokeDasharray="1.4 0.9"
              />
              {areaPreview.path.length >= 2 && (
                <polyline
                  points={areaPreview.path.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  stroke="#2563eb"
                  strokeWidth={0.5}
                  strokeDasharray="1.4 0.9"
                />
              )}
            </>
          )}

          {/* Axis guides for snapping */}
          {axisGuides.map((guide, index) => {
            const config = SNAP_AXIS_CONFIG[guide.axis];
            return (
              <line
                key={`axis-${guide.axis}-${index}`}
                x1={guide.x1}
                y1={guide.y1}
                x2={guide.x2}
                y2={guide.y2}
                stroke={config.color}
                strokeWidth={guide.active ? 0.5 : 0.25}
                strokeDasharray="1 1"
                opacity={guide.active ? 0.95 : 0.35}
              />
            );
          })}

          {/* Measurement lines */}
          {measurementScreenData.map((item) => {
            const baseColor = item.axis ? SNAP_AXIS_CONFIG[item.axis].color : '#ef4444';
            const lineColor = baseColor;
            const pointColor = '#ffffff';
            const pointStroke = '#1f2937';
            const startRadius = item.isSelected ? 0.8 : 0.6;
            const endRadius = item.isSelected ? 0.9 : 0.7;
            const crossSize = 0.35;
            return (
              <g key={item.id}>
                <line
                  x1={item.startView.x}
                  y1={item.startView.y}
                  x2={item.endView.x}
                  y2={item.endView.y}
                  stroke={lineColor}
                  strokeWidth={item.isSelected ? 0.6 : 0.4}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onClick={() => onSelectDistance(item.id)}
                />
                {/* Start handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(e: ReactPointerEvent<SVGGElement>) => handleStartDrag(e as any, item.id, 'start')}
                >
                  <circle
                    cx={item.startView.x}
                    cy={item.startView.y}
                    r={startRadius}
                    fill="none"
                    stroke={pointStroke}
                    strokeWidth={0.15}
                  />
                  {/* X mark */}
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y - crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y + crossSize}
                    stroke={pointStroke}
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y + crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y - crossSize}
                    stroke={pointStroke}
                    strokeWidth={0.12}
                  />
                </g>
                {/* End handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(e: ReactPointerEvent<SVGGElement>) => handleStartDrag(e as any, item.id, 'end')}
                >
                  <circle
                    cx={item.endView.x}
                    cy={item.endView.y}
                    r={endRadius}
                    fill="none"
                    stroke={pointStroke}
                    strokeWidth={0.15}
                  />
                  {/* X mark */}
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y - crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y + crossSize}
                    stroke={pointStroke}
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y + crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y - crossSize}
                    stroke={pointStroke}
                    strokeWidth={0.12}
                  />
                </g>
              </g>
            );
          })}

          {/* Preview line (while measuring) */}
          {baseProjection && previewProjection && baseProjection.visible && previewProjection.visible && (
            <g>
              <line
                x1={baseProjection.nx * 100}
                y1={baseProjection.ny * 100}
                x2={previewProjection.nx * 100}
                y2={previewProjection.ny * 100}
                stroke="#ef4444"
                strokeWidth={0.45}
                strokeDasharray="1.2 0.8"
              />
              {/* Base point */}
              <g>
                <circle
                  cx={baseProjection.nx * 100}
                  cy={baseProjection.ny * 100}
                  r={0.6}
                  fill="none"
                  stroke="#1f2937"
                  strokeWidth={0.15}
                />
                {/* X mark */}
                <line
                  x1={baseProjection.nx * 100 - 0.35}
                  y1={baseProjection.ny * 100 - 0.35}
                  x2={baseProjection.nx * 100 + 0.35}
                  y2={baseProjection.ny * 100 + 0.35}
                  stroke="#1f2937"
                  strokeWidth={0.12}
                />
                <line
                  x1={baseProjection.nx * 100 - 0.35}
                  y1={baseProjection.ny * 100 + 0.35}
                  x2={baseProjection.nx * 100 + 0.35}
                  y2={baseProjection.ny * 100 - 0.35}
                  stroke="#1f2937"
                  strokeWidth={0.12}
                />
              </g>
              {/* Preview point */}
              <g>
                <circle
                  cx={previewProjection.nx * 100}
                  cy={previewProjection.ny * 100}
                  r={0.7}
                  fill="none"
                  stroke="#1f2937"
                  strokeWidth={0.15}
                />
                {/* X mark */}
                <line
                  x1={previewProjection.nx * 100 - 0.35}
                  y1={previewProjection.ny * 100 - 0.35}
                  x2={previewProjection.nx * 100 + 0.35}
                  y2={previewProjection.ny * 100 + 0.35}
                  stroke="#1f2937"
                  strokeWidth={0.12}
                />
                <line
                  x1={previewProjection.nx * 100 - 0.35}
                  y1={previewProjection.ny * 100 + 0.35}
                  x2={previewProjection.nx * 100 + 0.35}
                  y2={previewProjection.ny * 100 - 0.35}
                  stroke="#1f2937"
                  strokeWidth={0.12}
                />
              </g>
            </g>
          )}
        </svg>
      </div>

      {/* Measurement labels (HTML overlay) */}
      <div className="absolute inset-0 z-31 pointer-events-none">
        {/* Area labels */}
        {areaScreenData.map((item) => (
          <div
            key={`area-label-${item.id}`}
            className={`absolute pointer-events-auto ${
              item.isSelected ? 'bg-sky-500 text-white' : 'bg-blue-600/90 text-white'
            } px-2 py-1 rounded text-xs font-medium shadow-lg cursor-pointer flex flex-col gap-0.5`}
            style={{
              left: `${item.centroid.x}px`,
              top: `${item.centroid.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={() => onSelectArea(item.id)}
          >
            <span>{item.label}</span>
            {item.perimeterLabel && (
              <span className="text-[10px] opacity-80">{item.perimeterLabel}</span>
            )}
          </div>
        ))}

        {/* Area preview label */}
        {areaPreview && areaPreview.label && (
          <div
            className="absolute bg-blue-600/90 text-white px-2 py-1 rounded text-xs font-medium shadow-lg flex flex-col gap-0.5"
            style={{
              left: `${areaPreview.centroid.x}px`,
              top: `${areaPreview.centroid.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <span>{areaPreview.label}</span>
            {areaPreview.perimeterLabel && (
              <span className="text-[10px] opacity-80">{areaPreview.perimeterLabel}</span>
            )}
          </div>
        )}

        {/* Measurement labels */}
        {measurementScreenData.map((item) => (
          <div
            key={`measurement-label-${item.id}`}
            className={`absolute pointer-events-auto ${
              item.isSelected ? 'bg-black text-white font-semibold' : 'bg-neutral-700/90 text-white'
            } flex flex-col gap-0.5 rounded px-2 py-1 text-xs shadow-lg cursor-pointer`}
            style={{
              left: `${item.midPoint.x}px`,
              top: `${item.midPoint.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={() => onSelectDistance(item.id)}
          >
            <div className="flex items-center gap-1">
              <span>{item.label}</span>
              {item.axis && (
                <span
                  className="rounded border px-1 py-[1px] text-[10px] font-semibold uppercase tracking-wide"
                  style={{
                    borderColor: `${SNAP_AXIS_CONFIG[item.axis].color}88`,
                    color: SNAP_AXIS_CONFIG[item.axis].color,
                    backgroundColor: '#11182740',
                  }}
                >
                  {SNAP_AXIS_CONFIG[item.axis].shortLabel}
                </span>
              )}
            </div>
          </div>
        ))}

        {/* Preview label */}
        {previewLabel && baseProjection && previewProjection && (
          <div
            className="absolute rounded bg-black/90 px-2 py-1 text-xs font-medium text-white shadow-lg"
            style={{
              left: `${(baseProjection.x + previewProjection.x) / 2}px`,
              top: `${(baseProjection.y + previewProjection.y) / 2}px`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="flex items-center justify-center gap-1">
              <span>{previewLabel}</span>
              {activeAxisLabel && <span className="text-white/60">· {activeAxisLabel}</span>}
            </div>
            {previewAxisComponents && (
              <div className="mt-1 flex gap-2 text-[10px]">
                {AXIS_ORDER.map((axis) => {
                  const config = SNAP_AXIS_CONFIG[axis];
                  return (
                    <span key={`preview-axis-${axis}`} style={{ color: config.color }}>
                      {config.shortLabel}: {previewAxisComponents.formatted[axis]}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Selected distance floating panel */}
      {selectedDistanceLabel && selectedDistanceId && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-50 rounded-xl bg-black px-4 py-3 shadow-2xl">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-2 text-white">
                <div>
                  <div className="text-xs font-medium text-white/70">ระยะที่เลือก</div>
                  <div className="text-lg font-semibold">{selectedDistanceLabel}</div>
                </div>
                {selectedDistanceChainLabel && (
                  <div>
                    <div className="text-xs font-medium text-white/70">ระยะสะสม</div>
                    <div className="text-sm font-semibold text-white">{selectedDistanceChainLabel}</div>
                  </div>
                )}
              </div>
              <div className="flex gap-1.5">
                <button
                  onClick={onOpenRescaleDialog}
                  className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
                >
                  ปรับมาตราส่วน
                </button>
                <button
                  onClick={() => onDeleteMeasurement(selectedDistanceId)}
                  className="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
                >
                  ลบ
                </button>
              </div>
            </div>
            {selectedAxisComponents && (
              <div className="grid grid-cols-3 gap-2 text-xs">
                {AXIS_ORDER.map((axis) => {
                  const config = SNAP_AXIS_CONFIG[axis];
                  return (
                    <div
                      key={`selected-axis-${axis}`}
                      className="rounded-lg border px-3 py-2"
                      style={{
                        borderColor: `${config.color}33`,
                        backgroundColor: `${config.color}14`,
                      }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: config.color }}>
                        {config.shortLabel}
                      </div>
                      <div className="mt-1 text-sm font-semibold text-white">
                        {selectedAxisComponents.formatted[axis]}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Selected area floating panel */}
      {selectedAreaLabel && selectedAreaId && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-50 rounded-xl bg-black px-4 py-3 shadow-2xl">
          <div className="flex items-center gap-3">
            <div className="flex flex-col gap-2 text-white">
              <div>
                <div className="text-xs font-medium text-white/70">พื้นที่ที่เลือก</div>
                <div className="text-lg font-semibold">{selectedAreaLabel}</div>
              </div>
              {selectedAreaPerimeterLabel && (
                <div>
                  <div className="text-xs font-medium text-white/70">เส้นรอบรูป</div>
                  <div className="text-sm font-semibold text-white">{selectedAreaPerimeterLabel}</div>
                </div>
              )}
            </div>
            <button
              onClick={() => onDeleteArea(selectedAreaId)}
              className="rounded-lg bg-red-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 transition-colors"
            >
              ลบ
            </button>
          </div>
        </div>
      )}
    </>
  );
}
