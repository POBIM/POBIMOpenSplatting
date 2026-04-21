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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

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
  'flex h-9 w-9 items-center justify-center border-2 border-[var(--ink)] bg-[var(--paper-card)] text-[var(--ink)] transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[var(--shadow-md)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ink)]/20';
const iconButtonActive = 'bg-[var(--ink)] text-[var(--text-on-ink)] shadow-[var(--shadow-inv)]';
const pillButtonBase = 'brutal-btn brutal-btn-xs h-9 gap-1.5 px-3';

function IconToggle({ icon: Icon, label, active, onClick }: IconToggleProps) {
  return (
    <button
      type="button"
      className={`${iconButtonBase} ${active ? iconButtonActive : 'shadow-[var(--shadow-sm)]'}`}
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
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
    <div className="pointer-events-none absolute inset-x-4 top-4 z-40 flex items-start justify-between gap-4">
      <div
        className="pointer-events-auto flex min-h-11 items-center gap-2 border-b-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 shadow-[var(--shadow-sm)]"
        data-orbit-block="true"
      >
        <button type="button" className={`${pillButtonBase} brutal-btn-primary`} onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Back</span>
        </button>

        <div className="h-6 w-[2px] bg-[var(--ink)]" />

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

      <div
        className="pointer-events-auto flex min-h-11 items-center gap-2 border-b-[var(--border-w)] border-[var(--ink)] bg-[var(--paper-card)] px-3 py-2 shadow-[var(--shadow-sm)]"
        data-orbit-block="true"
      >
        {splatCount !== null && (
          <div className="brutal-badge font-mono">{splatCount.toLocaleString()} Splats</div>
        )}

        {rightExtra}

        <div className="h-6 w-[2px] bg-[var(--ink)]" />

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
            className={`${iconButtonBase} ${paletteOpen ? iconButtonActive : 'shadow-[var(--shadow-sm)]'}`}
            onClick={() => setPaletteOpen((prev) => !prev)}
            aria-expanded={paletteOpen}
            aria-haspopup="true"
            title="Background"
          >
            <Palette className="h-4 w-4" />
            <span className="sr-only">Background</span>
          </button>

          {paletteOpen && (
            <div className="brutal-card absolute right-0 mt-2 w-40 p-2" data-orbit-block="true">
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

        <IconToggle icon={Info} label="Toggle info" onClick={onToggleInfo} active={infoOpen} />
      </div>
    </div>
  );
}
