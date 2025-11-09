import { Move, RotateCcw, RotateCw } from 'lucide-react';
import { Vec3 } from './useSplatScene';
import type { SnapAxis } from './measurement/useMeasurementTools';

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
  x: {
    accent: '#f87171',
    dot: 'bg-rose-400',
  },
  y: {
    accent: '#4ade80',
    dot: 'bg-emerald-400',
  },
  z: {
    accent: '#60a5fa',
    dot: 'bg-sky-400',
  },
};

const ALIGN_AXIS_BUTTON_BASE =
  'flex-1 rounded-lg border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition-colors';
const ALIGN_AXIS_BUTTON_ACTIVE = '!bg-black !text-white !border-black shadow';

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
    <div className="space-y-2">
      <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`}></span>
          {axis.toUpperCase()}
        </span>
        <span className="font-mono text-gray-700">{position[axis].toFixed(2)}</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={POSITION_RANGE.min}
          max={POSITION_RANGE.max}
          step={POSITION_RANGE.step}
          value={position[axis]}
          onChange={(e) => onPositionChange(axis, parseFloat(e.target.value))}
          className="flex-1 h-1.5 appearance-none rounded-full bg-gray-200 transition-[background-color]"
          style={{ accentColor: styles.accent }}
        />
        <input
          type="number"
          value={position[axis].toFixed(2)}
          onChange={(e) => onPositionChange(axis, parseFloat(e.target.value) || 0)}
          className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
          step={POSITION_RANGE.step}
        />
      </div>
    </div>
    );
  };

  const renderRotationControl = (axis: Axis, label: string) => {
    const styles = AXIS_STYLES[axis];
    return (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
        <span className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${styles.dot}`}></span>
          {axis.toUpperCase()}
        </span>
        <span className="text-gray-500">{label}</span>
        <span className="font-mono text-gray-700">{Math.round(rotation[axis])}°</span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={ROTATION_RANGE.min}
          max={ROTATION_RANGE.max}
          step={ROTATION_RANGE.step}
          value={rotation[axis]}
          onChange={(e) => onRotationChange(axis, parseFloat(e.target.value))}
          className="flex-1 h-1.5 appearance-none rounded-full bg-gray-200"
          style={{ accentColor: styles.accent }}
        />
        <input
          type="number"
          value={Math.round(rotation[axis])}
          onChange={(e) => onRotationChange(axis, parseFloat(e.target.value) || 0)}
          className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
          step={15}
        />
      </div>
    </div>
    );
  };

  return (
    <div
      className={`${containerClass} w-80 max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl`}
      data-orbit-block="true"
    >
      <h3 className="mb-5 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
        <RotateCw className="h-4 w-4 text-gray-500" />
        Transform
      </h3>

      <div className="mb-6 space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
          <Move className="h-4 w-4" />
          Position
        </h4>
        {renderPositionControl('x')}
        {renderPositionControl('y')}
        {renderPositionControl('z')}
      </div>

      <div className="mb-6 space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
          <RotateCw className="h-4 w-4" />
          Rotation
        </h4>
        {renderRotationControl('x', 'Pitch')}
        {renderRotationControl('y', 'Yaw')}
        {renderRotationControl('z', 'Roll')}
      </div>

      {autoAlignControls && (
        <div className="mb-6 space-y-3">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
            <RotateCw className="h-4 w-4" />
            Auto Align
          </h4>
          <p className="text-[11px] leading-relaxed text-gray-500">
            เลือกเส้นวัดที่สร้างไว้ (Distance) แล้วเลือกแกนที่ต้องการให้โมเดลจัดแนว จากนั้นกด Align
            เพื่อหมุนโมเดลให้สอดคล้องกับเส้นนั้น
          </p>
          <div className="flex gap-2">
            {(['x', 'y', 'z'] as SnapAxis[]).map((axis) => {
              const active = autoAlignControls.axis === axis;
              return (
                <button
                  key={axis}
                  type="button"
                  onClick={() => autoAlignControls.onAxisChange(axis)}
                  className={`${ALIGN_AXIS_BUTTON_BASE} ${active ? ALIGN_AXIS_BUTTON_ACTIVE : 'border-gray-200 bg-white text-gray-600 hover:border-black hover:text-black'}`}
                >
                  แกน {axis.toUpperCase()}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={autoAlignControls.onAlign}
            disabled={!autoAlignControls.canAlign}
            className={`inline-flex h-10 w-full items-center justify-center rounded-xl border px-3 text-sm font-medium transition-colors ${
              autoAlignControls.canAlign
                ? 'border-black bg-black text-white hover:bg-gray-900'
                : 'border-gray-200 bg-gray-100 text-gray-400 cursor-not-allowed'
            }`}
          >
            Align ตามแกน {autoAlignControls.axis.toUpperCase()}
          </button>
          {!autoAlignControls.canAlign && (
            <p className="text-[11px] text-gray-500">กรุณาเลือกเส้นวัด (Distance) ก่อนใช้งาน</p>
          )}
        </div>
      )}

      <button
        onClick={onReset}
        className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-gray-100 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
      >
        <RotateCcw className="h-4 w-4" />
        Reset All
      </button>

      <div className="mt-5 space-y-1 border-t border-gray-200 pt-4 text-[11px] text-gray-600">
        <p><strong className="font-semibold text-gray-800">Mouse</strong> Left drag = orbit • Right drag = pan • Wheel = zoom</p>
        <p><strong className="font-semibold text-gray-800">Keyboard</strong> ↑↓ rotate X ±1° • ←→ rotate Y ±1° • R reset</p>
      </div>
    </div>
  );
}
