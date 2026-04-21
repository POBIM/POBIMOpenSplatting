import type { ChangeEvent } from 'react';

import type { PointSelectionMode } from './usePointEditor';

type Axis = 'x' | 'y' | 'z';

type SelectionModeOption = {
  label: string;
  value: PointSelectionMode;
  description: string;
};

interface PointEditorPanelProps {
  active: boolean;
  selectionCount: number;
  hiddenCount: number;
  totalCount: number;
  selectionMode: PointSelectionMode;
  onChangeSelectionMode: (mode: PointSelectionMode) => void;
  isPolygonDrawing: boolean;
  onCompletePolygon: () => void;
  onCancelPolygon: () => void;
  nudgeStep: number;
  onChangeNudgeStep: (value: number) => void;
  onNudge: (axis: Axis, delta: number) => void;
  rotationStep: number;
  onChangeRotationStep: (value: number) => void;
  onRotate: (axis: Axis, degrees: number) => void;
  onClearSelection: () => void;
  onDeleteSelection: () => void;
  onUnhideAll: () => void;
}

const formatCount = (count: number) => count.toLocaleString('en-US');

export function PointEditorPanel({
  active,
  selectionCount,
  hiddenCount,
  totalCount,
  selectionMode,
  onChangeSelectionMode,
  isPolygonDrawing,
  onCompletePolygon,
  onCancelPolygon,
  nudgeStep,
  onChangeNudgeStep,
  onNudge,
  rotationStep,
  onChangeRotationStep,
  onRotate,
  onClearSelection,
  onDeleteSelection,
  onUnhideAll,
}: PointEditorPanelProps) {
  if (!active) {
    return null;
  }

  const nudgeDisabled = Number.isNaN(nudgeStep) || !Number.isFinite(nudgeStep) || nudgeStep === 0;
  const rotationDisabled =
    Number.isNaN(rotationStep) || !Number.isFinite(rotationStep) || rotationStep === 0;

  const selectionModeOptions: SelectionModeOption[] = [
    { label: 'Picker', value: 'picker', description: 'Single point selection' },
    { label: 'Rectangle', value: 'rectangle', description: 'Drag to select a region' },
    { label: 'Polygon', value: 'polygon', description: 'Click to outline a freeform area' },
  ];

  const handleNudgeStepChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number.parseFloat(event.target.value);
    onChangeNudgeStep(Number.isFinite(nextValue) ? nextValue : 0);
  };

  const handleRotationStepChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number.parseFloat(event.target.value);
    onChangeRotationStep(Number.isFinite(nextValue) ? nextValue : 0);
  };

  const nudgeButtons: Array<{ axis: Axis; delta: number; label: string }> = [
    { axis: 'x', delta: -nudgeStep, label: '-X' },
    { axis: 'x', delta: nudgeStep, label: '+X' },
    { axis: 'y', delta: -nudgeStep, label: '-Y' },
    { axis: 'y', delta: nudgeStep, label: '+Y' },
    { axis: 'z', delta: -nudgeStep, label: '-Z' },
    { axis: 'z', delta: nudgeStep, label: '+Z' },
  ];

  const rotationButtons: Array<{ axis: Axis; degrees: number; label: string }> = [
    { axis: 'x', degrees: -rotationStep, label: '-X' },
    { axis: 'x', degrees: rotationStep, label: '+X' },
    { axis: 'y', degrees: -rotationStep, label: '-Y' },
    { axis: 'y', degrees: rotationStep, label: '+Y' },
    { axis: 'z', degrees: -rotationStep, label: '-Z' },
    { axis: 'z', degrees: rotationStep, label: '+Z' },
  ];

  return (
    <div className="pointer-events-auto brutal-card-muted brutal-scroll w-80 max-w-full max-h-[80vh] overflow-y-auto p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="brutal-eyebrow mb-2">Point Editor</p>
          <h3 className="text-sm font-black uppercase tracking-[0.12em] text-[var(--ink)]">
            Selection Tools
          </h3>
        </div>
        <span className="brutal-badge font-mono">
          {formatCount(selectionCount)} / {formatCount(totalCount)}
        </span>
      </div>

      <p className="mt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
        Hidden <span className="font-mono text-[var(--ink)]">{formatCount(hiddenCount)}</span>
      </p>

      <div className="mt-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <p className="brutal-label mb-2">Selection Mode</p>
        <div className="grid grid-cols-3 gap-2">
          {selectionModeOptions.map((option) => {
            const activeOption = selectionMode === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => onChangeSelectionMode(option.value)}
                className={`brutal-btn brutal-btn-xs justify-center px-2 ${activeOption ? 'brutal-btn-primary' : ''}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
          {selectionModeOptions.find((option) => option.value === selectionMode)?.description}
        </p>

        {selectionMode === 'polygon' && (
          <div className="brutal-card mt-3 p-3">
            <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              Click To Add Vertices. Double Click Or Enter To Finish. Right Click Or Escape To Cancel.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={onCompletePolygon}
                disabled={!isPolygonDrawing || selectionCount === 0}
                className="brutal-btn brutal-btn-primary brutal-btn-xs flex-1 justify-center py-2"
              >
                Complete Polygon
              </button>
              <button
                type="button"
                onClick={onCancelPolygon}
                disabled={!isPolygonDrawing}
                className="brutal-btn brutal-btn-xs flex-1 justify-center py-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selectionCount === 0}
            className="brutal-btn brutal-btn-xs justify-center py-2"
          >
            Clear Selection
          </button>
          <button
            type="button"
            onClick={onDeleteSelection}
            disabled={selectionCount === 0}
            className="brutal-btn brutal-btn-danger brutal-btn-xs justify-center py-2"
          >
            Delete Selection
          </button>
        </div>
        <button
          type="button"
          onClick={onUnhideAll}
          disabled={hiddenCount === 0}
          className="brutal-btn brutal-btn-xs justify-center py-2"
        >
          Restore All
        </button>
      </div>

      <div className="mt-4 space-y-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <div>
          <label className="brutal-label mb-2 block" htmlFor="point-editor-nudge-step">
            Nudge Step (Units)
          </label>
          <input
            id="point-editor-nudge-step"
            type="number"
            step="0.01"
            min="0"
            value={Number.isFinite(nudgeStep) ? nudgeStep : 0}
            onChange={handleNudgeStepChange}
            className="brutal-input"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {nudgeButtons.map(({ axis, delta, label }) => (
            <button
              key={`${axis}-${label}`}
              type="button"
              disabled={selectionCount === 0 || nudgeDisabled}
              onClick={() => onNudge(axis, delta)}
              className="brutal-btn brutal-btn-xs justify-center py-2"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 space-y-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <div>
          <label className="brutal-label mb-2 block" htmlFor="point-editor-rotation-step">
            Rotation Step (Degrees)
          </label>
          <input
            id="point-editor-rotation-step"
            type="number"
            step="1"
            value={Number.isFinite(rotationStep) ? rotationStep : 0}
            onChange={handleRotationStepChange}
            className="brutal-input"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {rotationButtons.map(({ axis, degrees, label }) => (
            <button
              key={`rotate-${axis}-${label}`}
              type="button"
              disabled={selectionCount === 0 || rotationDisabled}
              onClick={() => onRotate(axis, degrees)}
              className="brutal-btn brutal-btn-xs justify-center py-2"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
