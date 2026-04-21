import {
  Camera,
  Compass,
  Move,
  Plane,
  RefreshCcw,
  Target,
  Zap,
  ZoomIn,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import {
  BulletSettings,
  CameraMode,
  GameModeSettings,
  OrbitState,
  ProjectionMode,
} from './useSplatScene';

interface CameraControlPanelProps {
  orbitState: OrbitState;
  onAzimuthChange: (value: number) => void;
  onElevationChange: (value: number) => void;
  onDistanceChange: (value: number) => void;
  projectionMode: ProjectionMode;
  onProjectionChange: (mode: ProjectionMode) => void;
  fieldOfView: number;
  onFieldOfViewChange: (value: number) => void;
  orthoHeight: number;
  onOrthoHeightChange: (value: number) => void;
  cameraMode: CameraMode;
  onCameraModeChange: (mode: CameraMode) => void;
  moveSpeed: number;
  onMoveSpeedChange: (value: number) => void;
  cameraHeight: number;
  onCameraHeightChange: (value: number) => void;
  jumpHeight: number;
  onJumpHeightChange: (value: number) => void;
  bulletSettings: BulletSettings;
  onBulletSettingsChange: (settings: Partial<BulletSettings>) => void;
  gameModeSettings: GameModeSettings;
  onGameModeSettingsChange: (settings: Partial<GameModeSettings>) => void;
  onReset: () => void;
  className?: string;
}

const sliderClass = 'h-1.5 flex-1 appearance-none border-2 border-[var(--ink)] bg-[var(--paper-muted)]';
const labelClass = 'flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]';
const sectionTitleClass = 'mb-3 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]';

const cameraModeOptions: Array<{ id: CameraMode; label: string; icon: LucideIcon }> = [
  { id: 'orbit', label: 'Orbit', icon: Compass },
  { id: 'walk', label: 'Walk', icon: Move },
  { id: 'fly', label: 'Fly', icon: Plane },
  { id: 'game', label: 'Game', icon: Target },
];

const projectionOptions: Array<{ id: ProjectionMode; label: string }> = [
  { id: 'perspective', label: 'Perspective' },
  { id: 'orthographic', label: 'Orthographic' },
];

type SliderFieldProps = {
  icon: LucideIcon;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  suffix: string;
  disabled?: boolean;
};

function SliderField({
  icon: Icon,
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
  disabled,
}: SliderFieldProps) {
  const formatted = Number.isFinite(value) ? value.toFixed(step < 1 ? 2 : 0) : '0';

  return (
    <div className="space-y-1.5">
      <div className={labelClass}>
        <span className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-[var(--ink)]" />
          {label}
        </span>
        <span className="font-mono text-[var(--ink)]">
          {formatted}
          {suffix}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className={`${sliderClass} ${disabled ? 'opacity-50' : ''}`}
          style={{ accentColor: 'var(--ink)' }}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) {
              onChange(next);
            }
          }}
          disabled={disabled}
          className={`brutal-input w-20 px-2 py-1 text-xs ${disabled ? 'opacity-60' : ''}`}
        />
      </div>
    </div>
  );
}

type ToggleCardProps = {
  title: string;
  enabled: boolean;
  onChange: (next: boolean) => void;
  description: string;
  icon: LucideIcon;
};

function ToggleCard({ title, enabled, onChange, description, icon: Icon }: ToggleCardProps) {
  return (
    <div className="brutal-card-muted p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--text-secondary)]">
            <Icon className="h-3.5 w-3.5 text-[var(--ink)]" />
            {title}
          </p>
          <p className="mt-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {description}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange(!enabled)}
          className={`flex h-7 min-w-[3.2rem] items-center border-2 border-[var(--ink)] px-1 transition-colors ${
            enabled ? 'bg-[var(--ink)] justify-end' : 'bg-[var(--paper-card)] justify-start'
          }`}
          aria-pressed={enabled}
        >
          <span className="h-4 w-4 border-2 border-[var(--ink)] bg-[var(--paper-card)]" />
        </button>
      </div>
    </div>
  );
}

export function CameraControlPanel({
  orbitState,
  onAzimuthChange,
  onElevationChange,
  onDistanceChange,
  projectionMode,
  onProjectionChange,
  fieldOfView,
  onFieldOfViewChange,
  orthoHeight,
  onOrthoHeightChange,
  cameraMode,
  onCameraModeChange,
  moveSpeed,
  onMoveSpeedChange,
  cameraHeight,
  onCameraHeightChange,
  jumpHeight,
  onJumpHeightChange,
  bulletSettings,
  onBulletSettingsChange,
  gameModeSettings,
  onGameModeSettingsChange,
  onReset,
  className,
}: CameraControlPanelProps) {
  const containerClass = className ?? 'absolute right-5 top-24 z-40';

  return (
    <div
      className={`${containerClass} brutal-card brutal-scroll w-80 max-h-[80vh] overflow-y-auto p-4`}
      data-orbit-block="true"
    >
      <div className="mb-4">
        <p className="brutal-eyebrow mb-2">Camera System</p>
        <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.12em] text-[var(--ink)]">
          <Camera className="h-4 w-4" />
          Camera
        </h3>
      </div>

      <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <h4 className={sectionTitleClass}>
          <Camera className="h-4 w-4" />
          Control Mode
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {cameraModeOptions.map((option) => {
            const active = cameraMode === option.id;
            const Icon = option.icon;

            return (
              <button
                key={option.id}
                type="button"
                className={`brutal-btn brutal-btn-xs justify-center px-2 ${active ? 'brutal-btn-primary' : ''}`}
                onClick={() => onCameraModeChange(option.id)}
                aria-pressed={active}
              >
                <Icon className="h-3.5 w-3.5" />
                {option.label}
              </button>
            );
          })}
        </div>

        {cameraMode !== 'orbit' && (
          <>
            <div className="brutal-card-muted mt-3 p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--ink)]">
                {cameraMode === 'walk'
                  ? 'Walk Mode'
                  : cameraMode === 'game'
                    ? 'Game Mode'
                    : 'Fly Mode'}
              </p>
              <ul className="mt-2 space-y-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                <li>• Click Point To Spawn</li>
                <li>• WASD / Arrows Move</li>
                <li>• Mouse Look Around</li>
                {cameraMode === 'walk' || (cameraMode === 'game' && !gameModeSettings.flyModeEnabled) ? (
                  <>
                    <li>• Space Jump</li>
                    {cameraMode === 'game' && <li>• Left Click Shoot</li>}
                    <li>• Gravity + Collision On</li>
                  </>
                ) : (
                  <>
                    <li>• Q/E Down / Up</li>
                    {cameraMode === 'game' && <li>• Left Click Shoot</li>}
                    <li>• Collision Off</li>
                  </>
                )}
              </ul>
            </div>

            <div className="mt-3 space-y-3">
              <SliderField
                icon={Move}
                label="Movement Speed"
                value={moveSpeed}
                min={0.1}
                max={20}
                step={0.1}
                onChange={onMoveSpeedChange}
                suffix=" m/s"
              />
              <SliderField
                icon={Camera}
                label="Camera Height"
                value={cameraHeight}
                min={0.05}
                max={3}
                step={0.05}
                onChange={onCameraHeightChange}
                suffix=" m"
              />
              {(cameraMode === 'walk' || cameraMode === 'game') && (
                <SliderField
                  icon={Move}
                  label="Jump Height"
                  value={jumpHeight}
                  min={1}
                  max={15}
                  step={0.5}
                  onChange={onJumpHeightChange}
                  suffix=" m/s"
                />
              )}
            </div>

            {cameraMode === 'game' && (
              <div className="mt-4 space-y-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
                <h5 className={sectionTitleClass}>
                  <Target className="h-4 w-4" />
                  Game Mode Settings
                </h5>

                <ToggleCard
                  title="Enable Fly Mode"
                  enabled={gameModeSettings.flyModeEnabled}
                  onChange={(flyModeEnabled) => onGameModeSettingsChange({ flyModeEnabled })}
                  description="Toggle Gravity And Collision"
                  icon={Plane}
                />

                <div className="border-t-[var(--border-w)] border-[var(--ink)] pt-4">
                  <h5 className={sectionTitleClass}>
                    <Zap className="h-4 w-4" />
                    Bullet Settings
                  </h5>
                  <div className="space-y-3">
                    <SliderField
                      icon={Zap}
                      label="Bullet Speed"
                      value={bulletSettings.speed}
                      min={0.1}
                      max={100}
                      step={0.1}
                      onChange={(speed) => onBulletSettingsChange({ speed })}
                      suffix=" m/s"
                    />
                    <SliderField
                      icon={Zap}
                      label="Bullet Size"
                      value={bulletSettings.size}
                      min={0.001}
                      max={0.5}
                      step={0.001}
                      onChange={(size) => onBulletSettingsChange({ size })}
                      suffix=" m"
                    />
                    <SliderField
                      icon={Zap}
                      label="Bullet Gravity"
                      value={bulletSettings.gravity}
                      min={0}
                      max={20}
                      step={0.1}
                      onChange={(gravity) => onBulletSettingsChange({ gravity })}
                      suffix=" m/s²"
                    />
                    <SliderField
                      icon={Zap}
                      label="Bullet Lifetime"
                      value={bulletSettings.lifetime}
                      min={0.5}
                      max={30}
                      step={0.5}
                      onChange={(lifetime) => onBulletSettingsChange({ lifetime })}
                      suffix=" s"
                    />
                    <div className="space-y-1.5">
                      <div className={labelClass}>
                        <span>Bounciness</span>
                        <span className="font-mono text-[var(--ink)]">
                          {(bulletSettings.bounciness * 100).toFixed(1)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.001}
                        value={bulletSettings.bounciness}
                        onChange={(event) =>
                          onBulletSettingsChange({ bounciness: Number(event.target.value) })
                        }
                        className={sliderClass}
                        style={{ accentColor: 'var(--ink)' }}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                        Bullet Color
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        {(['r', 'g', 'b'] as const).map((channel) => (
                          <div key={channel} className="space-y-1">
                            <div className="block text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                              {channel}
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={1}
                              step={0.1}
                              value={bulletSettings.color[channel]}
                              onChange={(event) =>
                                onBulletSettingsChange({
                                  color: {
                                    ...bulletSettings.color,
                                    [channel]: Number(event.target.value),
                                  },
                                })
                              }
                              className={sliderClass}
                              style={{ accentColor: 'var(--ink)' }}
                            />
                          </div>
                        ))}
                      </div>
                      <div
                        className="h-8 border-2 border-[var(--ink)]"
                        style={{
                          backgroundColor: `rgb(${bulletSettings.color.r * 255}, ${bulletSettings.color.g * 255}, ${bulletSettings.color.b * 255})`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {cameraMode === 'orbit' && (
        <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
          <h4 className={sectionTitleClass}>
            <Compass className="h-4 w-4" />
            Orbit
          </h4>
          <div className="space-y-3">
            <SliderField
              icon={Compass}
              label="Azimuth"
              value={orbitState.azimuth}
              min={-180}
              max={180}
              step={1}
              onChange={onAzimuthChange}
              suffix="°"
            />
            <SliderField
              icon={Compass}
              label="Elevation"
              value={orbitState.elevation}
              min={-89}
              max={89}
              step={1}
              onChange={onElevationChange}
              suffix="°"
            />
            <SliderField
              icon={Compass}
              label="Distance"
              value={orbitState.distance}
              min={0.25}
              max={100}
              step={0.25}
              onChange={onDistanceChange}
              suffix=" m"
            />
          </div>
        </div>
      )}

      <div className="mb-4 border-t-[var(--border-w)] border-[var(--ink)] pt-4">
        <h4 className={sectionTitleClass}>
          <ZoomIn className="h-4 w-4" />
          Projection
        </h4>
        <div className="grid grid-cols-2 gap-2">
          {projectionOptions.map((option) => {
            const active = projectionMode === option.id;

            return (
              <button
                key={option.id}
                type="button"
                className={`brutal-btn brutal-btn-xs justify-center px-2 ${active ? 'brutal-btn-primary' : ''}`}
                onClick={() => onProjectionChange(option.id)}
                aria-pressed={active}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 space-y-3">
          <SliderField
            icon={ZoomIn}
            label="Field Of View"
            value={fieldOfView}
            min={20}
            max={110}
            step={1}
            onChange={onFieldOfViewChange}
            suffix="°"
            disabled={projectionMode !== 'perspective'}
          />
          <SliderField
            icon={ZoomIn}
            label="Ortho Size"
            value={orthoHeight}
            min={0.5}
            max={50}
            step={0.5}
            onChange={onOrthoHeightChange}
            suffix=""
            disabled={projectionMode !== 'orthographic'}
          />
        </div>
      </div>

      <button type="button" onClick={onReset} className="brutal-btn brutal-btn-primary w-full justify-center py-2">
        <RefreshCcw className="h-4 w-4" />
        Reset Camera
      </button>
    </div>
  );
}
