import { Move, RotateCcw, RotateCw } from 'lucide-react';

import type { SnapAxis } from './measurement/useMeasurementTools';
import { Vec3 } from './useSplatScene';

type Axis = 'x' | 'y' | 'z';

interface TransformPanelProps {
  position: Vec3;
  rotation: Vec3;
  onPositionChange: (axis: Axis, value: number) => void;
  onRotationChange: (axis: Axis, value: number) => void;
  onReset: () => void;
  className?: string;
  autoAlignControls?: {
    axis: SnapAxis;
    onAxisChange: (axis: SnapAxis) => void;
    onAlign: () => void;
    canAlign: boolean;
  };
}

const POSITION_RANGE = { min: -10, max: 10, step: 0.1 } as const;
const ROTATION_RANGE = { min: -180, max: 180, step: 1 } as const;

const AXIS_STYLES: Record<Axis, { accent: string; dot: string }> = {
  x: { accent: '#C84B5A', dot: 'bg-rose-500' },
  y: { accent: '#4A8E66', dot: 'bg-emerald-600' },
  z: { accent: '#4E70BA', dot: 'bg-blue-600' },
};

const sliderClass = 'h-1.5 flex-1 appearance-none border-2 border-[var(--ink)] bg-[var(--paper-muted)]';
const sectionTitleClass = 'mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]';
const axisButtonBase = 'brutal-btn brutal-btn-xs flex-1 px-2';

export function TransformPanel({
  position,
  rotation,
  onPositionChange,
  onRotationChange,
  onReset,
  className,
  autoAlignControls,
}: TransformPanelProps) {
  const containerClass = className ?? 'absolute right-5 top-24 z-40';

  const renderPositionControl = (axis: Axis) => {
    const styles = AXIS_STYLES[axis];

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
          <span className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
            {axis}
          </span>
          <span className="font-mono text-[var(--ink)]">{position[axis].toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={POSITION_RANGE.min}
            max={POSITION_RANGE.max}
            step={POSITION_RANGE.step}
            value={position[axis]}
            onChange={(event) => onPositionChange(axis, Number.parseFloat(event.target.value))}
            className={sliderClass}
            style={{ accentColor: styles.accent }}
          />
          <input
            type="number"
            value={position[axis].toFixed(2)}
            onChange={(event) => onPositionChange(axis, Number.parseFloat(event.target.value) || 0)}
            className="brutal-input w-20 px-2 py-1 text-xs"
            step={POSITION_RANGE.step}
          />
        </div>
      </div>
    );
  };

  const renderRotationControl = (axis: Axis, label: string) => {
    const styles = AXIS_STYLES[axis];

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
          <span className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`} />
            {axis}
          </span>
          <span className="text-[var(--text-muted)]">{label}</span>
          <span className="font-mono text-[var(--ink)]">{Math.round(rotation[axis])}°</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={ROTATION_RANGE.min}
            max={ROTATION_RANGE.max}
            step={ROTATION_RANGE.step}
            value={rotation[axis]}
            onChange={(event) => onRotationChange(axis, Number.parseFloat(event.target.value))}
            className={sliderClass}
            style={{ accentColor: styles.accent }}
          />
          <input
            type="number"
            value={Math.round(rotation[axis])}
            onChange={(event) => onRotationChange(axis, Number.parseFloat(event.target.value) || 0)}
            className="brutal-input w-20 px-2 py-1 text-xs"
            step={15}
          />
        </div>
      </div>
    );
  };

  return (
    <div
      className={`${containerClass} brutal-card brutal-scroll w-80 max-h-[80vh] overflow-y-auto p-4`}
      data-orbit-block="true"
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <p className="brutal-eyebrow mb-2">Model Controls</p>
          <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-[var(--ink)]">
            <RotateCw className="h-4 w-4" />
            Transform
          </h3>
        </div>
      </div>

      <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <h4 className={sectionTitleClass}>
          <Move className="h-4 w-4" />
          Position
        </h4>
        <div className="space-y-3">
          {renderPositionControl('x')}
          {renderPositionControl('y')}
          {renderPositionControl('z')}
        </div>
      </div>

      <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <h4 className={sectionTitleClass}>
          <RotateCw className="h-4 w-4" />
          Rotation
        </h4>
        <div className="space-y-3">
          {renderRotationControl('x', 'Pitch')}
          {renderRotationControl('y', 'Yaw')}
          {renderRotationControl('z', 'Roll')}
        </div>
      </div>

      {autoAlignControls && (
        <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
          <h4 className={sectionTitleClass}>
            <RotateCw className="h-4 w-4" />
            Auto Align
          </h4>
          <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
            เลือกเส้นวัด Distance แล้วเลือกแกนที่ต้องการให้โมเดลจัดแนว
          </p>
          <div className="mb-3 flex gap-2">
            {(['x', 'y', 'z'] as SnapAxis[]).map((axis) => {
              const active = autoAlignControls.axis === axis;

              return (
                <button
                  key={axis}
                  type="button"
                  onClick={() => autoAlignControls.onAxisChange(axis)}
                  className={`${axisButtonBase} ${active ? 'brutal-btn-primary' : ''}`}
                >
                  Axis {axis.toUpperCase()}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={autoAlignControls.onAlign}
            disabled={!autoAlignControls.canAlign}
            className="brutal-btn brutal-btn-primary brutal-btn-xs w-full justify-center py-2"
          >
            Align {autoAlignControls.axis.toUpperCase()}
          </button>
          {!autoAlignControls.canAlign && (
            <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-muted)]">
              Select a distance segment first
            </p>
          )}
        </div>
      )}

      <button type="button" onClick={onReset} className="brutal-btn brutal-btn-primary w-full justify-center py-2">
        <RotateCcw className="h-4 w-4" />
        Reset All
      </button>

      <div className="mt-4 border-t-[var(--border-w)] border-[var(--ink)] pt-3 text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)]">
        <p>
          <strong className="text-[var(--ink)]">Mouse</strong> Left Drag Orbit • Right Drag Pan • Wheel Zoom
        </p>
        <p className="mt-1">
          <strong className="text-[var(--ink)]">Keyboard</strong> ↑↓ Rotate X • ←→ Rotate Y • R Reset
        </p>
      </div>
    </div>
  );
}
