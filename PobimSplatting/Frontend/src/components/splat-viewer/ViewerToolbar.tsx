import {
  ArrowLeft,
  Axis3D,
  Grid3x3,
  Info,
  Maximize2,
  Minimize2,
  Move,
  Palette,
  RotateCcw,
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

interface ViewerToolbarProps {
  onBack: () => void;
  onReset: () => void;
  onToggleFullscreen: () => void;
  isFullscreen: boolean;
  onToggleTransform: () => void;
  showTransform: boolean;
  onToggleInfo: () => void;
  infoOpen: boolean;
  splatCount: number | null;
  rightExtra?: ReactNode;
  backgroundOptions: ReadonlyArray<BackgroundOption>;
  activeBackground: BackgroundId;
  onBackgroundSelect: (id: BackgroundId) => void;
  showGrid: boolean;
  onToggleGrid: (visible: boolean) => void;
  showAxes: boolean;
  onToggleAxes: (visible: boolean) => void;
}

interface IconToggleProps {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
}

const iconButtonBase =
  'h-10 w-10 inline-flex items-center justify-center rounded-full border border-white/15 bg-slate-950/60 text-white transition-colors hover:bg-white/10 hover:border-white/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60';
const iconButtonActive = 'bg-white text-slate-900 border-white shadow';

const pillButtonBase =
  'h-10 px-4 inline-flex items-center justify-center gap-2 rounded-full border border-white/15 bg-slate-950/60 text-white text-sm font-medium transition-colors hover:bg-white/10 hover:border-white/30 focus:outline-none focus-visible:ring-1 focus-visible:ring-white/60';

function IconToggle({ icon: Icon, label, active, onClick }: IconToggleProps) {
  return (
    <button
      type="button"
      className={`${iconButtonBase} ${active ? iconButtonActive : ''}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
    >
      <Icon className="h-4 w-4" />
      <span className="sr-only">{label}</span>
    </button>
  );
}

export function ViewerToolbar({
  onBack,
  onReset,
  onToggleFullscreen,
  isFullscreen,
  onToggleTransform,
  showTransform,
  onToggleInfo,
  infoOpen,
  splatCount,
  rightExtra,
  backgroundOptions,
  activeBackground,
  onBackgroundSelect,
  showGrid,
  onToggleGrid,
  showAxes,
  onToggleAxes,
}: ViewerToolbarProps) {
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
    <div className="absolute inset-x-4 top-4 z-40 flex items-start justify-between pointer-events-none">
      <div className="flex items-center gap-2 pointer-events-auto" data-orbit-block="true">
        <button
          type="button"
          className={pillButtonBase}
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back</span>
        </button>

        <IconToggle icon={RotateCcw} label="Reset view" onClick={onReset} />

        <IconToggle
          icon={Move}
          label="Transform panel"
          onClick={onToggleTransform}
          active={showTransform}
        />

        <IconToggle
          icon={isFullscreen ? Minimize2 : Maximize2}
          label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          onClick={onToggleFullscreen}
        />
      </div>

      <div className="flex items-center gap-2 pointer-events-auto" data-orbit-block="true">
        {splatCount !== null && (
          <div className="px-3 h-9 inline-flex items-center rounded-full bg-slate-950/55 border border-white/10 text-xs font-medium text-white/80">
            {splatCount.toLocaleString()} splats
          </div>
        )}

        {rightExtra}

        <IconToggle
          icon={Axis3D}
          label="Toggle axes"
          onClick={() => onToggleAxes(!showAxes)}
          active={showAxes}
        />

        <IconToggle
          icon={Grid3x3}
          label="Toggle grid"
          onClick={() => onToggleGrid(!showGrid)}
          active={showGrid}
        />

        <div className="relative" ref={paletteAnchorRef} data-orbit-block="true">
          <button
            type="button"
            className={`${iconButtonBase} ${paletteOpen ? iconButtonActive : ''}`}
            onClick={() => setPaletteOpen((prev) => !prev)}
            aria-expanded={paletteOpen}
            aria-haspopup="true"
          >
            <Palette className="h-4 w-4" />
            <span className="sr-only">Background</span>
          </button>

          {paletteOpen && (
            <div
              className="absolute right-0 mt-2 w-40 rounded-2xl border border-white/10 bg-slate-950/85 p-2 shadow-xl backdrop-blur"
              data-orbit-block="true"
            >
              <p className="px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-white/40">
                Background
              </p>
              <div className="flex flex-col gap-1">
                {simplifiedOptions.map((option) => {
                  const isActive = option.id === activeBackground;
                  return (
                    <button
                      type="button"
                      key={option.id}
                      className={`flex items-center gap-2 rounded-xl px-2 py-2 text-left text-sm text-white/80 transition-colors hover:bg-white/10 ${
                        isActive ? 'bg-white/15 text-white' : ''
                      }`}
                      onClick={() => {
                        onBackgroundSelect(option.id);
                        setPaletteOpen(false);
                      }}
                    >
                      <span
                        className="h-4 w-4 rounded-full border border-white/20"
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

        <IconToggle
          icon={Info}
          label="Toggle info"
          onClick={onToggleInfo}
          active={infoOpen}
        />
      </div>
    </div>
  );
}
