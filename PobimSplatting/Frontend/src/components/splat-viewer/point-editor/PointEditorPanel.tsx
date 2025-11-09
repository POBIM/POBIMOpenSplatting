import { useMemo } from 'react';
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
  const rotationDisabled = Number.isNaN(rotationStep) || !Number.isFinite(rotationStep) || rotationStep === 0;

  const selectionModeOptions: SelectionModeOption[] = useMemo(
    () => [
      { label: 'Picker', value: 'picker', description: 'Single point selection' },
      { label: 'Rectangle', value: 'rectangle', description: 'Drag to select a region' },
      { label: 'Polygon', value: 'polygon', description: 'Click to outline a freeform area' },
    ],
    [],
  );

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
    <div className="pointer-events-auto w-80 max-w-full rounded-2xl border border-gray-200 bg-white/95 p-4 shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Point Editor</h3>
        <span className="text-xs font-medium text-gray-400">
          {formatCount(selectionCount)} / {formatCount(totalCount)}
        </span>
      </div>

      <p className="mt-1 text-xs text-gray-500">
        Hidden: <span className="font-medium text-gray-700">{formatCount(hiddenCount)}</span>
      </p>

      <div className="mt-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">Selection Mode</p>
        <div className="grid grid-cols-3 gap-2">
          {selectionModeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onChangeSelectionMode(option.value)}
              className={`rounded-xl border px-2 py-2 text-xs font-medium transition-colors ${
                selectionMode === option.value
                  ? 'border-red-500 bg-red-500 text-white'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-red-300 hover:text-red-500'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-gray-400">
          {selectionModeOptions.find((option) => option.value === selectionMode)?.description}
        </p>
        {selectionMode === 'polygon' && (
          <div className="mt-2 space-y-2">
            <p className="text-[11px] text-gray-400">
              Click to add vertices. Double-click or press Enter to finish. Right-click or press Escape to cancel.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onCompletePolygon}
                disabled={!isPolygonDrawing || selectionCount === 0}
                className="flex-1 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-white disabled:text-gray-400"
              >
                Complete polygon
              </button>
              <button
                type="button"
                onClick={onCancelPolygon}
                disabled={!isPolygonDrawing}
                className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-white"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClearSelection}
            disabled={selectionCount === 0}
            className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-white"
          >
            Clear selection
          </button>
          <button
            type="button"
            onClick={onDeleteSelection}
            disabled={selectionCount === 0}
            className="flex-1 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-white disabled:text-gray-400"
          >
            Delete selection
          </button>
        </div>
        <button
          type="button"
          onClick={onUnhideAll}
          disabled={hiddenCount === 0}
          className="rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:bg-white disabled:text-gray-400"
        >
          Restore all
        </button>
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-gray-500">
            Nudge Step (units)
          </label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={Number.isFinite(nudgeStep) ? nudgeStep : 0}
            onChange={handleNudgeStepChange}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:border-black focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {nudgeButtons.map(({ axis, delta, label }) => (
            <button
              key={`${axis}-${label}`}
              type="button"
              disabled={selectionCount === 0 || nudgeDisabled}
              onClick={() => onNudge(axis, delta)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 space-y-4">
        <div>
          <label className="mb-2 block text-xs font-medium uppercase tracking-wide text-gray-500">
            Rotation Step (degrees)
          </label>
          <input
            type="number"
            step="1"
            value={Number.isFinite(rotationStep) ? rotationStep : 0}
            onChange={handleRotationStepChange}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:border-black focus:outline-none focus:ring-2 focus:ring-black/10"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          {rotationButtons.map(({ axis, degrees, label }) => (
            <button
              key={`rotate-${axis}-${label}`}
              type="button"
              disabled={selectionCount === 0 || rotationDisabled}
              onClick={() => onRotate(axis, degrees)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
