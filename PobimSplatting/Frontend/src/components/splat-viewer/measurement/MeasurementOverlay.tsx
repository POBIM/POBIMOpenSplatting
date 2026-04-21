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

  const handleSvgPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerHandlers.onPointerDown(event as unknown as ReactPointerEvent<HTMLDivElement>);
  };

  const handleSvgPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerHandlers.onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>);
  };

  const handleSvgPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    pointerHandlers.onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>);
  };

  const handleSvgPointerLeave = () => {
    pointerHandlers.onPointerLeave();
  };

  return (
    <>
      <div className="absolute inset-0 z-30 pointer-events-none" role="presentation">
        <svg
          className={`h-full w-full ${isOverlayInteractive ? 'pointer-events-auto' : 'pointer-events-none'}`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          onPointerDown={handleSvgPointerDown}
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerLeave={handleSvgPointerLeave}
          onContextMenu={(event) => event.preventDefault()}
        >
          <title>Measurement overlay</title>
          {/* Preview line while drawing */}
          {previewLine && (
            <g>
              <line
                x1={previewLine.start.x}
                y1={previewLine.start.y}
                x2={previewLine.end.x}
                y2={previewLine.end.y}
                stroke="var(--ink)"
                strokeWidth={0.5}
                strokeDasharray="1.4 0.9"
              />
              <circle cx={previewLine.start.x} cy={previewLine.start.y} r={0.6} stroke="var(--ink)" strokeWidth={0.15} fill="none" />
              <circle cx={previewLine.end.x} cy={previewLine.end.y} r={0.7} stroke="var(--ink)" strokeWidth={0.15} fill="none" />
            </g>
          )}

          {/* Measurement lines */}
          {measurementScreenData.map((item) => {
            const lineColor = 'var(--ink)';
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
                  style={{ pointerEvents: 'none' }}
                />
                {/* Start handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(event: ReactPointerEvent<SVGGElement>) => handleStartDrag(event, item.id, 'start')}
                >
                  <circle cx={item.startView.x} cy={item.startView.y} r={startRadius} stroke="var(--ink)" strokeWidth={0.15} fill="none" />
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y - crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y + crossSize}
                    stroke="var(--ink)"
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.startView.x - crossSize}
                    y1={item.startView.y + crossSize}
                    x2={item.startView.x + crossSize}
                    y2={item.startView.y - crossSize}
                    stroke="var(--ink)"
                    strokeWidth={0.12}
                  />
                </g>
                {/* End handle */}
                <g
                  style={{ pointerEvents: 'auto', cursor: 'grab' }}
                  onPointerDown={(event: ReactPointerEvent<SVGGElement>) => handleStartDrag(event, item.id, 'end')}
                >
                  <circle cx={item.endView.x} cy={item.endView.y} r={endRadius} stroke="var(--ink)" strokeWidth={0.15} fill="none" />
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y - crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y + crossSize}
                    stroke="var(--ink)"
                    strokeWidth={0.12}
                  />
                  <line
                    x1={item.endView.x - crossSize}
                    y1={item.endView.y + crossSize}
                    x2={item.endView.x + crossSize}
                    y2={item.endView.y - crossSize}
                    stroke="var(--ink)"
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
          <button
            type="button"
            key={`label-${item.id}`}
            className={`absolute pointer-events-auto flex cursor-pointer items-center gap-1 border-2 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.12em] shadow-[var(--shadow-sm)] ${
              item.isSelected
                ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--text-on-ink)] shadow-[var(--shadow-inv)]'
                : 'border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)]'
            }`}
            style={{
              left: `${item.midPoint.x}px`,
              top: `${item.midPoint.y}px`,
              transform: 'translate(-50%, -50%)',
            }}
            onClick={() => onSelectDistance(item.id)}
          >
            <span>{item.label}</span>
          </button>
        ))}

        {previewLine && (
          <div
            className="absolute border-2 border-[var(--ink)] bg-[var(--paper-card)] px-2 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--ink)] shadow-[var(--shadow-sm)]"
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
        <div className="brutal-card-dark absolute bottom-24 left-1/2 z-50 -translate-x-1/2 px-4 py-3">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1 text-[var(--text-on-ink)]">
                <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--text-on-ink-muted)]">ระยะที่เลือก</div>
                <div className="font-mono text-lg font-semibold uppercase tracking-[0.08em]">{selectedDistanceLabel}</div>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={onOpenRescaleDialog}
                  className="brutal-btn brutal-btn-xs"
                >
                  ปรับมาตราส่วน
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteMeasurement(selectedDistanceId)}
                  className="brutal-btn brutal-btn-danger brutal-btn-xs"
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
                      className="border-2 px-3 py-2"
                      style={{
                        borderColor: 'var(--paper-muted-2)',
                        backgroundColor: 'rgba(255,255,255,0.08)',
                      }}
                    >
                      <div className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: config.color }}>
                        {config.shortLabel}
                      </div>
                      <div className="mt-1 font-mono text-sm font-semibold text-[var(--text-on-ink)]">
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
