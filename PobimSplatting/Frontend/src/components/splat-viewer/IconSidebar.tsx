import {
  ArrowLeft,
  Axis3D,
  Camera,
  Grid3x3,
  Info,
  SquareMousePointer,
  Maximize2,
  Minimize2,
  Move,
  Palette,
  RotateCcw,
  Ruler,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

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
  'h-10 w-10 inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-600 transition-all hover:bg-black hover:text-white hover:border-black focus:outline-none focus-visible:ring-2 focus-visible:ring-black';
const iconButtonActive = '!bg-black !text-white !border-black shadow-md';
const iconButtonDisabled =
  'cursor-not-allowed opacity-50 hover:bg-white hover:text-gray-400 hover:border-gray-200';

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
    <div className="absolute left-4 top-4 bottom-4 z-40 flex flex-col gap-3 pointer-events-none">
      <div className="flex flex-col gap-2 pointer-events-auto bg-white border border-gray-200 rounded-2xl p-2 shadow-lg" data-orbit-block="true">
        <button
          type="button"
          className="h-10 px-3 inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white text-gray-900 text-sm font-medium transition-all hover:bg-black hover:text-white hover:border-black focus:outline-none"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>

        <div className="w-full h-px bg-gray-200" />

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

        <div className="w-full h-px bg-gray-200" />

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
          <div className="rounded-xl border border-gray-200 bg-white p-2">
            <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Measurements</p>
            <div className="flex flex-col gap-2">
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
                  className="inline-flex h-10 w-full items-center justify-center rounded-xl border border-gray-200 bg-white px-3 text-xs font-medium text-gray-600 transition-all hover:border-black hover:bg-black hover:text-white disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400 disabled:hover:bg-white disabled:hover:text-gray-400"
                  onClick={measurementControls.disabled ? undefined : measurementControls.onClearAll}
                  disabled={measurementControls.disabled}
                >
                  ล้างทั้งหมด
                </button>
              )}
            </div>
          </div>
        )}

        {pointEditorControls && (
          <div className="rounded-xl border border-gray-200 bg-white p-2">
            <p className="px-1 pb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">Points</p>
            <div className="flex flex-col gap-2">
              <IconButton
                icon={SquareMousePointer}
                label="Point editor"
                onClick={pointEditorControls.onToggle}
                active={pointEditorControls.active}
              />
              <p className="px-1 text-[11px] text-gray-400">
                {pointEditorControls.selectionCount.toLocaleString('en-US')} selected
                {pointEditorControls.hiddenCount > 0 ? (
                  <span>
                    {' '}
                    • {pointEditorControls.hiddenCount.toLocaleString('en-US')} hidden
                  </span>
                ) : null}
              </p>
            </div>
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
              className="absolute left-full ml-2 top-0 w-40 rounded-2xl border border-gray-200 bg-white p-2 shadow-xl"
              data-orbit-block="true"
            >
              <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Background
              </p>
              <div className="flex flex-col gap-1">
                {simplifiedOptions.map((option) => {
                  const isActive = option.id === activeBackground;
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={`flex items-center gap-2 rounded-xl px-2 py-2 text-left text-sm transition-colors hover:bg-gray-100 ${
                        isActive ? 'bg-gray-100 text-black font-medium' : 'text-gray-600'
                      }`}
                      onClick={() => {
                        onBackgroundSelect(option.id);
                        setPaletteOpen(false);
                      }}
                    >
                      <span
                        className="h-4 w-4 rounded-full border-2 border-gray-300"
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

        <div className="w-full h-px bg-gray-200" />

        <IconButton
          icon={Info}
          label="Toggle info"
          onClick={onToggleInfo}
          active={infoOpen}
        />
      </div>

      {splatCount !== null && (
        <div className="pointer-events-auto px-3 py-2 inline-flex items-center justify-center rounded-xl bg-white border border-gray-200 text-xs font-medium text-gray-900 shadow-sm">
          {splatCount.toLocaleString()}
        </div>
      )}
    </div>
  );
}
