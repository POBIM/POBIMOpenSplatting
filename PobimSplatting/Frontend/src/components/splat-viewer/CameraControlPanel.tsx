import { Camera, Compass, RefreshCcw, ZoomIn, Move, Plane, Target, Zap } from 'lucide-react';
import { OrbitState, ProjectionMode, CameraMode, BulletSettings, GameModeSettings } from './useSplatScene';

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

const sliderBaseClass =
  'flex-1 h-1.5 appearance-none rounded-full bg-gray-200 transition-[background-color]';

const cameraModeOptions: Array<{ id: CameraMode; label: string; icon: any }> = [
  { id: 'orbit', label: 'Orbit', icon: Compass },
  { id: 'walk', label: 'Walk', icon: Move },
  { id: 'fly', label: 'Fly', icon: Plane },
  { id: 'game', label: 'Game', icon: Target },
];

const projectionOptions: Array<{ id: ProjectionMode; label: string }> = [
  { id: 'perspective', label: 'Perspective' },
  { id: 'orthographic', label: 'Orthographic' },
];

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

  const renderOrbitSlider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    suffix: string,
  ) => (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
        <span className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-gray-500" />
          {label}
        </span>
        <span className="font-mono text-gray-700">
          {Number.isFinite(value) ? value.toFixed(step < 1 ? 2 : 0) : '0'}
          {suffix}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className={sliderBaseClass}
          style={{ accentColor: '#111827' }}
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
          className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
        />
      </div>
    </div>
  );

  const renderProjectionSlider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    suffix: string,
    disabled: boolean,
  ) => (
    <div className="space-y-2">
      <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
        <span className="flex items-center gap-2">
          <ZoomIn className="h-4 w-4 text-gray-500" />
          {label}
        </span>
        <span className="font-mono text-gray-700">
          {Number.isFinite(value) ? value.toFixed(step < 1 ? 2 : 0) : '0'}
          {suffix}
        </span>
      </label>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={disabled}
          className={`${sliderBaseClass} ${disabled ? 'opacity-50' : ''}`}
          style={{ accentColor: '#111827' }}
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
          className={`w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400 ${
            disabled ? 'opacity-60' : ''
          }`}
        />
      </div>
    </div>
  );

  return (
    <div
      className={`${containerClass} w-80 max-h-[80vh] overflow-y-auto rounded-2xl border border-gray-200 bg-white p-5 shadow-2xl`}
      data-orbit-block="true"
    >
      <h3 className="mb-5 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-600">
        <Camera className="h-4 w-4 text-gray-500" />
        Camera
      </h3>

      <div className="mb-6 space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
          <Camera className="h-4 w-4" />
          Control Mode
        </h4>
        <div className="flex gap-2">
          {cameraModeOptions.map((option) => {
            const active = cameraMode === option.id;
            const Icon = option.icon;
            return (
              <button
                key={option.id}
                type="button"
                className={`flex-1 flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? 'border-black bg-black text-white shadow'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-black hover:text-black'
                }`}
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
            <div className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">
              <p className="font-medium">
                {cameraMode === 'walk' ? 'Walk Mode (FPS + Gravity)' :
                 cameraMode === 'game' ? 'Game Mode (FPS + Shooting)' :
                 'Fly Mode (Free Flight)'}
              </p>
              <ul className="mt-1 space-y-0.5 text-blue-800">
                <li>• Click point to spawn</li>
                <li>• WASD / Arrows: Move</li>
                <li>• Mouse: Look around</li>
                {cameraMode === 'walk' || (cameraMode === 'game' && !gameModeSettings.flyModeEnabled) ? (
                  <>
                    <li>• Space: Jump</li>
                    {cameraMode === 'game' && <li>• Left Click: Shoot 🔫</li>}
                    <li>• Gravity + Collision: ON</li>
                  </>
                ) : (
                  <>
                    <li>• Q/E: Down/Up</li>
                    {cameraMode === 'game' && <li>• Left Click: Shoot 🔫</li>}
                    <li>• Collision: OFF</li>
                  </>
                )}
              </ul>
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                <span className="flex items-center gap-2">
                  <Move className="h-4 w-4 text-gray-500" />
                  Movement Speed
                </span>
                <span className="font-mono text-gray-700">
                  {moveSpeed.toFixed(1)} m/s
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={moveSpeed}
                  onChange={(event) => onMoveSpeedChange(Number(event.target.value))}
                  className={sliderBaseClass}
                  style={{ accentColor: '#111827' }}
                />
                <input
                  type="number"
                  min={0.1}
                  max={20}
                  step={0.1}
                  value={moveSpeed}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      onMoveSpeedChange(next);
                    }
                  }}
                  className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                <span className="flex items-center gap-2">
                  <Camera className="h-4 w-4 text-gray-500" />
                  Camera Height
                </span>
                <span className="font-mono text-gray-700">
                  {cameraHeight.toFixed(2)} m
                </span>
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.05}
                  max={3.0}
                  step={0.05}
                  value={cameraHeight}
                  onChange={(event) => onCameraHeightChange(Number(event.target.value))}
                  className={sliderBaseClass}
                  style={{ accentColor: '#111827' }}
                />
                <input
                  type="number"
                  min={0.05}
                  max={3.0}
                  step={0.05}
                  value={cameraHeight}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      onCameraHeightChange(next);
                    }
                  }}
                  className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
                />
              </div>
            </div>
            {(cameraMode === 'walk' || cameraMode === 'game') && (
              <div className="space-y-2">
                <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                  <span className="flex items-center gap-2">
                    <Move className="h-4 w-4 text-gray-500" />
                    Jump Height
                  </span>
                  <span className="font-mono text-gray-700">
                    {jumpHeight.toFixed(1)} m/s
                  </span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={1.0}
                    max={15.0}
                    step={0.5}
                    value={jumpHeight}
                    onChange={(event) => onJumpHeightChange(Number(event.target.value))}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                  <input
                    type="number"
                    min={1.0}
                    max={15.0}
                    step={0.5}
                    value={jumpHeight}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next)) {
                        onJumpHeightChange(next);
                      }
                    }}
                    className="w-20 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-gray-400"
                  />
                </div>
              </div>
            )}
            {cameraMode === 'game' && (
              <>
                <div className="mt-4 border-t border-gray-200 pt-4">
                  <h5 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600 mb-3">
                    <Target className="h-4 w-4" />
                    Game Mode Settings
                  </h5>
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span className="flex items-center gap-2">
                      <Plane className="h-4 w-4 text-gray-500" />
                      Enable Fly Mode
                    </span>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={gameModeSettings.flyModeEnabled}
                        onChange={(e) => onGameModeSettingsChange({ flyModeEnabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-black/20 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-black"></div>
                    </label>
                  </label>
                  <p className="text-[10px] text-gray-500 mt-1">
                    เปิดเพื่อบินได้อิสระ (ปิด Gravity + Collision)
                  </p>
                </div>
                <div className="mt-4 border-t border-gray-200 pt-4">
                  <h5 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600 mb-3">
                    <Zap className="h-4 w-4" />
                    Bullet Settings
                  </h5>
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span>Bullet Speed</span>
                    <span className="font-mono text-gray-700">
                      {bulletSettings.speed.toFixed(2)} m/s
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.1}
                    max={100}
                    step={0.1}
                    value={bulletSettings.speed}
                    onChange={(event) => onBulletSettingsChange({ speed: Number(event.target.value) })}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span>Bullet Size</span>
                    <span className="font-mono text-gray-700">
                      {bulletSettings.size.toFixed(3)} m
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.001}
                    max={0.5}
                    step={0.001}
                    value={bulletSettings.size}
                    onChange={(event) => onBulletSettingsChange({ size: Number(event.target.value) })}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span>Bullet Gravity</span>
                    <span className="font-mono text-gray-700">
                      {bulletSettings.gravity.toFixed(2)} m/s²
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={20}
                    step={0.1}
                    value={bulletSettings.gravity}
                    onChange={(event) => onBulletSettingsChange({ gravity: Number(event.target.value) })}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span>Bullet Lifetime</span>
                    <span className="font-mono text-gray-700">
                      {bulletSettings.lifetime.toFixed(1)} s
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0.5}
                    max={30}
                    step={0.5}
                    value={bulletSettings.lifetime}
                    onChange={(event) => onBulletSettingsChange({ lifetime: Number(event.target.value) })}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-600">
                    <span>Bounciness 🏀</span>
                    <span className="font-mono text-gray-700">
                      {(bulletSettings.bounciness * 100).toFixed(1)}%
                    </span>
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={bulletSettings.bounciness}
                    onChange={(event) => onBulletSettingsChange({ bounciness: Number(event.target.value) })}
                    className={sliderBaseClass}
                    style={{ accentColor: '#111827' }}
                  />
                  <p className="text-[10px] text-gray-500 mt-1">
                    0% = ไม่เด้ง, 100% = เด้งสมบูรณ์
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-gray-600 block mb-1">
                    Bullet Color
                  </label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <label className="text-[10px] text-gray-500 block mb-1">R</label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={bulletSettings.color.r}
                        onChange={(event) => onBulletSettingsChange({
                          color: { ...bulletSettings.color, r: Number(event.target.value) }
                        })}
                        className="w-full h-1 appearance-none rounded-full bg-red-200"
                        style={{ accentColor: '#ef4444' }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-gray-500 block mb-1">G</label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={bulletSettings.color.g}
                        onChange={(event) => onBulletSettingsChange({
                          color: { ...bulletSettings.color, g: Number(event.target.value) }
                        })}
                        className="w-full h-1 appearance-none rounded-full bg-green-200"
                        style={{ accentColor: '#22c55e' }}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="text-[10px] text-gray-500 block mb-1">B</label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={bulletSettings.color.b}
                        onChange={(event) => onBulletSettingsChange({
                          color: { ...bulletSettings.color, b: Number(event.target.value) }
                        })}
                        className="w-full h-1 appearance-none rounded-full bg-blue-200"
                        style={{ accentColor: '#3b82f6' }}
                      />
                    </div>
                  </div>
                  <div
                    className="w-full h-8 rounded-lg border border-gray-300 mt-2"
                    style={{
                      backgroundColor: `rgb(${bulletSettings.color.r * 255}, ${bulletSettings.color.g * 255}, ${bulletSettings.color.b * 255})`
                    }}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>

      {cameraMode === 'orbit' && (
        <div className="mb-6 space-y-3">
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
            <Compass className="h-4 w-4" />
            Orbit
          </h4>
          {renderOrbitSlider('Azimuth', orbitState.azimuth, -180, 180, 1, onAzimuthChange, '°')}
          {renderOrbitSlider('Elevation', orbitState.elevation, -89, 89, 1, onElevationChange, '°')}
          {renderOrbitSlider('Distance', orbitState.distance, 0.25, 100, 0.25, onDistanceChange, 'm')}
        </div>
      )}

      <div className="mb-6 space-y-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
          <ZoomIn className="h-4 w-4" />
          Projection
        </h4>
        <div className="flex gap-2">
          {projectionOptions.map((option) => {
            const active = projectionMode === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={`flex-1 rounded-xl border px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? 'border-black bg-black text-white shadow'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-black hover:text-black'
                }`}
                onClick={() => onProjectionChange(option.id)}
                aria-pressed={active}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        {renderProjectionSlider(
          'Field of View',
          fieldOfView,
          20,
          110,
          1,
          onFieldOfViewChange,
          '°',
          projectionMode !== 'perspective',
        )}
        {renderProjectionSlider(
          'Ortho Size',
          orthoHeight,
          0.5,
          50,
          0.5,
          onOrthoHeightChange,
          '',
          projectionMode !== 'orthographic',
        )}
      </div>

      <button
        type="button"
        onClick={onReset}
        className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-gray-300 bg-gray-100 px-4 py-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
      >
        <RefreshCcw className="h-4 w-4" />
        Reset Camera
      </button>
    </div>
  );
}

