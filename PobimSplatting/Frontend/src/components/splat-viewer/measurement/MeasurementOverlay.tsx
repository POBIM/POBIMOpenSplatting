import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  SNAP_AXIS_CONFIG,
  type AxisComponentSummary,
  type MeasurementOverlayState,
} from './useMeasurementTools';

interface MeasurementOverlayProps {
  overlayState: MeasurementOverlayState;
  selectedDistanceLabel: string | null;
  selectedDistanceId: string | null;
  selectedAxisComponents: AxisComponentSummary | null;
  onSelectDistance: (id: string) => void;
  onDeleteMeasurement: (id: string) => void;
  onOpenRescaleDialog: () => void;
}

export function MeasurementOverlay({
  overlayState,
  selectedDistanceLabel,
  selectedDistanceId,
  selectedAxisComponents,
  onSelectDistance,
  onDeleteMeasurement,
  onOpenRescaleDialog,
}: MeasurementOverlayProps) {
  const { measurementScreenData, previewLine, pointerHandlers, handleStartDrag, isOverlayInteractive } =
    overlayState;

  return (
    <>
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
          {/* Preview line while drawing */}
          {previewLine && (
            <g>
              <line
                x1={previewLine.start.x}
                y1={previewLine.start.y}
                x2={previewLine.end.x}
                y2={previewLine.end.y}
                stroke="#ef4444"
                strokeWidth={0.5}
                strokeDasharray="1.4 0.9"
              />
              <circle cx={previewLine.start.x} cy={previewLine.start.y} r={0.6} stroke="#111827" strokeWidth={0.15} fill="none" />
              <circle cx={previewLine.end.x} cy={previewLine.end.y} r={0.7} stroke="#111827" strokeWidth={0.15} fill="none" />
            </g>
          )}

          {/* Measurement lines */}
          {measurementScreenData.map((item) => {
            const lineColor = item.isSelected ? '#111827' : '#ef4444';
            const crossSize = 0.32;
            const startRadius = item.isSelected ? 0.85 : 0.65;
            const endRadius = item.isSelected ? 0.9 : 0.7;
            return (
              <g key={item.id}>
                <line
                  x1={item.startView.x}
                  y1={item.startView.y}
                  x2={item.endView.x}
                  y2={item.endView.y}
                  stroke={lineColor}
                  strokeWidth={item.isSelected ? 0.65 : 0.45}
                  style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                  onClick={() => onSelectDistance(item.id)}
                />
                {/* Start handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(e: ReactPointerEvent<SVGGElement>) => handleStartDrag(e as any, item.id, 'start')}
                >
                  <circle cx={item.startView.x} cy={item.startView.y} r={startRadius} stroke="#111827" strokeWidth={0.15} fill="none" />
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y - crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y + crossSize}
                    stroke="#111827"
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y + crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y - crossSize}
                    stroke="#111827"
                    strokeWidth={0.12}
                  />
                </g>
                {/* End handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(e: ReactPointerEvent<SVGGElement>) => handleStartDrag(e as any, item.id, 'end')}
                >
                  <circle cx={item.endView.x} cy={item.endView.y} r={endRadius} stroke="#111827" strokeWidth={0.15} fill="none" />
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y - crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y + crossSize}
                    stroke="#111827"
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y + crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y - crossSize}
                    stroke="#111827"
                    strokeWidth={0.12}
                  />
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Labels */}
      <div className="absolute inset-0 z-31 pointer-events-none">
        {measurementScreenData.map((item) => (
          <div
            key={`label-${item.id}`}
            className={`absolute pointer-events-auto ${
              item.isSelected ? 'bg-black text-white' : 'bg-neutral-700/90 text-white'
            } flex items-center gap-1 rounded px-2 py-1 text-xs font-medium shadow-lg cursor-pointer`}
            style={{
              left: `${item.midPoint.x}px`,
              top: `${item.midPoint.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={() => onSelectDistance(item.id)}
          >
            <span>{item.label}</span>
          </div>
        ))}

        {previewLine && (
          <div
            className="absolute rounded bg-black/90 px-2 py-1 text-xs font-medium text-white shadow-lg"
            style={{
              left: `${previewLine.midPx.x}px`,
              top: `${previewLine.midPx.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
          >
            {previewLine.label}
          </div>
        )}
      </div>

      {/* Selected distance panel */}
      {selectedDistanceLabel && selectedDistanceId && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-24 z-50 rounded-xl bg-black px-4 py-3 shadow-2xl">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1 text-white">
                <div className="text-xs font-medium text-white/70">ระยะที่เลือก</div>
                <div className="text-lg font-semibold">{selectedDistanceLabel}</div>
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
                {(Object.keys(SNAP_AXIS_CONFIG) as Array<keyof typeof SNAP_AXIS_CONFIG>).map((axis) => {
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
    </>
  );
}
