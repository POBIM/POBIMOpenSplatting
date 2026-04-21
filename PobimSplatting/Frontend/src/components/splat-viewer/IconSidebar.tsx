import {
  ArrowLeft,
  Axis3D,
  Camera,
  Grid3x3,
  Info,
  Maximize2,
  Minimize2,
  Move,
  Palette,
  RotateCcw,
  Ruler,
  SquareMousePointer,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { BackgroundId } from './useSplatScene';

interface BackgroundOption {
  id: BackgroundId;
  label: string;
  css: string;
}

interface IconSidebarProps {
  onBack: () => void;
  onReset: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  onToggleTransform: () => void;
  showTransform: boolean;
  onToggleInfo: () => void;
  infoOpen: boolean;
  splatCount: number | null;
  onToggleCameraControls: () => void;
  cameraControlsOpen: boolean;
  measurementControls?: {
    isDistanceMode: boolean;
    hasMeasurements: boolean;
    onToggleDistance: () => void;
    onClearAll: () => void;
    disabled?: boolean;
  };
  backgroundOptions: ReadonlyArray<BackgroundOption>;
  activeBackground: BackgroundId;
  onBackgroundSelect: (id: BackgroundId) => void;
  showGrid: boolean;
  onToggleGrid: (visible: boolean) => void;
  showAxes: boolean;
  onToggleAxes: (visible: boolean) => void;
  pointEditorControls?: {
    active: boolean;
    selectionCount: number;
    hiddenCount: number;
    onToggle: () => void;
  };
}

interface IconButtonProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}

const iconButtonBase =
  'flex h-9 w-9 items-center justify-center border-2 border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)] shadow-[var(--shadow-sm)] transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]/20';
const iconButtonActive =
  'bg-[var(--ink)] text-[var(--text-on-ink)] shadow-[var(--shadow-inv)]';
const iconButtonDisabled =
  'cursor-not-allowed opacity-45 hover:translate-x-0 hover:translate-y-0 hover:shadow-[var(--shadow-sm)]';

function IconButton({ icon: Icon, label, active, onClick, disabled }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`${iconButtonBase} ${active ? iconButtonActive : ''} ${disabled ? iconButtonDisabled : ''}`}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-label={label}
      title={label}
    >
      <Icon className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

const sectionLabelClass =
  'text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--text-on-ink-muted)]';

export function IconSidebar({
  onBack,
  onReset,
  onToggleFullscreen,
  isFullscreen,
  onToggleTransform,
  showTransform,
  onToggleInfo,
  infoOpen,
  splatCount,
  backgroundOptions,
  activeBackground,
  onBackgroundSelect,
  showGrid,
  onToggleGrid,
  showAxes,
  onToggleAxes,
  onToggleCameraControls,
  cameraControlsOpen,
  measurementControls,
  pointEditorControls,
}: IconSidebarProps) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteAnchorRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!paletteOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const anchor = paletteAnchorRef.current;
      if (!anchor) {
        return;
      }
      if (!anchor.contains(event.target as Node)) {
        setPaletteOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [paletteOpen]);

  const simplifiedOptions = useMemo(
    () =>
      backgroundOptions.map((option) => ({
        id: option.id,
        label: option.label,
        css: option.css,
      })),
    [backgroundOptions],
  );

  return (
    <div className="pointer-events-none absolute left-4 top-4 bottom-4 z-40 flex flex-col gap-3">
      <div
        className="pointer-events-auto flex w-12 flex-col items-center gap-2 border-[3px] border-[var(--ink)] bg-[var(--ink)] px-[5px] py-3 shadow-[var(--shadow-md)]"
        data-orbit-block="true"
      >
        <button
          type="button"
          className="brutal-btn brutal-btn-primary brutal-btn-xs flex h-9 w-full gap-1 px-0"
          onClick={onBack}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span className="sr-only">Back</span>
        </button>

        <div className="h-[2px] w-full bg-[var(--paper-muted-2)]" />

        <IconButton icon={RotateCcw} label="Reset view" onClick={onReset} />
        <IconButton
          icon={Move}
          label="Transform panel"
          onClick={onToggleTransform}
          active={showTransform}
        />
        <IconButton
          icon={Camera}
          label="Camera controls"
          onClick={onToggleCameraControls}
          active={cameraControlsOpen}
        />
        <IconButton
          icon={isFullscreen ? Minimize2 : Maximize2}
          label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          onClick={onToggleFullscreen}
        />

        <div className="h-[2px] w-full bg-[var(--paper-muted-2)]" />

        <IconButton
          icon={Axis3D}
          label="Toggle axes"
          onClick={() => onToggleAxes(!showAxes)}
          active={showAxes}
        />
        <IconButton
          icon={Grid3x3}
          label="Toggle grid"
          onClick={() => onToggleGrid(!showGrid)}
          active={showGrid}
        />

        {measurementControls && (
          <div className="flex w-full flex-col gap-2 border-2 border-[var(--paper-muted-2)] bg-[var(--ink-800)] p-1.5">
            <p className={sectionLabelClass}>Measure</p>
            <IconButton
              icon={Ruler}
              label="Distance tool"
              onClick={measurementControls.onToggleDistance}
              active={measurementControls.isDistanceMode}
              disabled={measurementControls.disabled}
            />
            {(measurementControls.isDistanceMode || measurementControls.hasMeasurements) && (
              <button
                type="button"
                className="brutal-btn brutal-btn-xs w-full px-1.5 text-[10px]"
                onClick={measurementControls.disabled ? undefined : measurementControls.onClearAll}
                disabled={measurementControls.disabled}
              >
                Clear
              </button>
            )}
          </div>
        )}

        {pointEditorControls && (
          <div className="flex w-full flex-col gap-2 border-2 border-[var(--paper-muted-2)] bg-[var(--ink-800)] p-1.5">
            <p className={sectionLabelClass}>Points</p>
            <IconButton
              icon={SquareMousePointer}
              label="Point editor"
              onClick={pointEditorControls.onToggle}
              active={pointEditorControls.active}
            />
            <p className="text-center text-[9px] font-bold uppercase tracking-[0.12em] text-[var(--text-on-ink-muted)]">
              {pointEditorControls.selectionCount.toLocaleString('en-US')} Sel
              {pointEditorControls.hiddenCount > 0 ? ` • ${pointEditorControls.hiddenCount.toLocaleString('en-US')} Hid` : ''}
            </p>
          </div>
        )}

        <div className="relative" ref={paletteAnchorRef} data-orbit-block="true">
          <button
            type="button"
            className={`${iconButtonBase} ${paletteOpen ? iconButtonActive : ''}`}
            onClick={() => setPaletteOpen((prev) => !prev)}
            aria-expanded={paletteOpen}
            aria-haspopup="true"
            title="Background"
          >
            <Palette className="h-4 w-4" />
            <span className="sr-only">Background</span>
          </button>

          {paletteOpen && (
            <div
              className="brutal-card absolute left-full top-0 ml-2 w-40 p-2"
              data-orbit-block="true"
            >
              <p className="brutal-label px-1 pb-2">Background</p>
              <div className="flex flex-col gap-1">
                {simplifiedOptions.map((option) => {
                  const isActive = option.id === activeBackground;
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={`flex items-center gap-2 border-2 px-2 py-1.5 text-left text-[11px] font-bold uppercase tracking-[0.12em] transition-all ${
                        isActive
                          ? 'border-[var(--ink)] bg-[var(--ink)] text-[var(--text-on-ink)] shadow-[var(--shadow-sm)]'
                          : 'border-transparent bg-[var(--paper-card)] text-[var(--ink)] hover:border-[var(--ink)] hover:bg-[var(--paper-muted)]'
                      }`}
                      onClick={() => {
                        onBackgroundSelect(option.id);
                        setPaletteOpen(false);
                      }}
                    >
                      <span
                        className="h-4 w-4 rounded-full border-2 border-[var(--ink)]"
                        style={{ backgroundColor: option.css }}
                      />
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="h-[2px] w-full bg-[var(--paper-muted-2)]" />

        <IconButton icon={Info} label="Toggle info" onClick={onToggleInfo} active={infoOpen} />
      </div>

      {splatCount !== null && (
        <div className="pointer-events-auto brutal-card-dark px-3 py-2 text-center font-mono text-[11px] font-bold uppercase tracking-[0.14em]">
          {splatCount.toLocaleString()}
        </div>
      )}
    </div>
  );
}
