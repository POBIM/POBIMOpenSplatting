import {
  MutableRefObject,
  RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

export type Vec3 = { x: number; y: number; z: number };
export type CameraAxes = {
  x: Vec3;
  y: Vec3;
  z: Vec3;
};

export type ScreenProjection = {
  x: number;
  y: number;
  nx: number;
  ny: number;
  visible: boolean;
};

export type OrbitState = {
  azimuth: number;
  elevation: number;
  distance: number;
};

export type ProjectionMode = 'perspective' | 'orthographic';
export type CameraMode = 'orbit' | 'walk' | 'fly' | 'game';
export type AlignAxis = 'x' | 'y' | 'z';

export type PointPickResult = {
  index: number;
  local: Vec3;
  world: Vec3;
};

export const VIEWER_BACKGROUNDS = [
  { id: 'white', label: 'White', color: [1.0, 1.0, 1.0] as const, css: '#ffffff' },
  { id: 'midnight', label: 'Midnight', color: [0.04, 0.05, 0.08] as const, css: '#090b11' },
  { id: 'slate', label: 'Slate', color: [0.12, 0.14, 0.18] as const, css: '#1c212d' },
  { id: 'paper', label: 'Paper', color: [0.9, 0.92, 0.95] as const, css: '#e6ebf3' },
] as const;

export type BackgroundId = (typeof VIEWER_BACKGROUNDS)[number]['id'];

const BACKGROUND_LOOKUP = VIEWER_BACKGROUNDS.reduce<Record<BackgroundId, { label: string; color: readonly [number, number, number]; css: string }>>(
  (acc, option) => {
    acc[option.id] = option;
    return acc;
  },
  {} as Record<BackgroundId, { label: string; color: readonly [number, number, number]; css: string }>,
);

type AlignDirection = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

interface OrbitControlsHandle {
  getState: () => { orbitDistance: number; orbitX: number; orbitY: number };
  setOrbitDistance: (distance: number, options?: { immediate?: boolean }) => void;
  setOrbitAngles: (x: number, y: number, options?: { immediate?: boolean }) => void;
  adjustOrbitDistance: (delta: number) => void;
  alignTo: (direction: AlignDirection) => void;
  updateCameraPosition: () => void;
  onCameraChange: (callback: (axes: CameraAxes) => void) => () => void;
  onOrbitStateChange: (
    callback: (state: { orbitDistance: number; orbitX: number; orbitY: number }) => void,
  ) => () => void;
  setTarget: (target: Vec3) => void;
  getTarget: () => Vec3;
  setEnabled: (enabled: boolean) => void;
}

interface FirstPersonControlsHandle {
  getPosition: () => Vec3;
  getRotation: () => { yaw: number; pitch: number };
  setPosition: (pos: Vec3) => void;
  setRotation: (yaw: number, pitch: number) => void;
  setMoveSpeed: (speed: number) => void;
  setCameraHeight: (height: number) => number;
  setJumpHeight: (height: number) => void;
  setEnabled: (enabled: boolean) => void;
  setPointerLockEnabled: (enabled: boolean) => void;
  updateBulletSettings?: (settings: BulletSettings) => void;
  updateGameModeSettings?: (settings: GameModeSettings) => void;
  destroy: () => void;
}

interface GroundHelperHandle {
  updateSize: (size: number) => void;
  setVisible: (visible: boolean) => void;
}

interface AxesHelperHandle {
  updateSceneScale: (radius: number) => void;
  updateCameraDistance: (distance: number) => void;
  setVisible: (visible: boolean) => void;
}

export type BulletSettings = {
  speed: number;
  size: number;
  color: { r: number; g: number; b: number };
  gravity: number;
  lifetime: number;
  bounciness: number; // 0-1, where 1 = perfect bounce, 0 = no bounce
};

export type GameModeSettings = {
  flyModeEnabled: boolean;
};

interface UseSplatSceneResult {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  loading: boolean;
  error: string | null;
  splatCount: number | null;
  resetScene: () => void;
  syncModelRotation: (rotation: Vec3) => void;
  syncModelPosition: (position: Vec3) => void;
  adjustZoom: (delta: number) => void;
  cameraAxes: CameraAxes | null;
  alignCamera: (direction: AlignDirection) => void;
  backgroundOptions: typeof VIEWER_BACKGROUNDS;
  activeBackground: BackgroundId;
  setBackground: (id: BackgroundId) => void;
  showGrid: boolean;
  setGridVisible: (visible: boolean) => void;
  showAxes: boolean;
  setAxesVisible: (visible: boolean) => void;
  pickWorldPoint: (canvasX: number, canvasY: number) => Vec3 | null;
  pickPoint: (canvasX: number, canvasY: number) => PointPickResult | null;
  projectWorldToScreen: (position: Vec3) => ScreenProjection | null;
  viewportKey: number;
  orbitState: OrbitState;
  setOrbitAngles: (azimuth: number, elevation: number, options?: { immediate?: boolean }) => void;
  setOrbitDistance: (distance: number, options?: { immediate?: boolean }) => void;
  projectionMode: ProjectionMode;
  setProjectionMode: (mode: ProjectionMode) => void;
  fieldOfView: number;
  setFieldOfView: (value: number) => void;
  orthoHeight: number;
  setOrthoHeight: (value: number) => void;
  resetCamera: () => void;
  cameraMode: CameraMode;
  setCameraMode: (mode: CameraMode) => void;
  waitingForSpawnPoint: boolean;
  handleSpawnPointSelected: (worldPos: Vec3) => void;
  moveSpeed: number;
  setMoveSpeed: (speed: number) => void;
  cameraHeight: number;
  setCameraHeight: (height: number) => void;
  jumpHeight: number;
  setJumpHeight: (height: number) => void;
  bulletSettings: BulletSettings;
  setBulletSettings: (settings: Partial<BulletSettings>) => void;
  gameModeSettings: GameModeSettings;
  setGameModeSettings: (settings: Partial<GameModeSettings>) => void;
  computeAlignmentRotation: (start: Vec3, end: Vec3, axis: AlignAxis) => Vec3 | null;
  modelToWorld: (point: Vec3) => Vec3 | null;
  worldToModel: (point: Vec3) => Vec3 | null;
  getPointWorldPosition: (index: number) => Vec3 | null;
  getPointLocalPosition: (index: number) => Vec3 | null;
  mutatePointPositions: (
    indices: number[],
    mutator: (position: Vec3, index: number) => Vec3 | null,
  ) => boolean;
  setPointsHidden: (indices: number[], hidden: boolean) => void;
  clearHiddenPoints: () => void;
  setSelectedPoints: (indices: number[]) => void;
  forEachVisiblePoint: (callback: (index: number, local: Vec3, world: Vec3) => void | boolean) => void;
  hiddenPointCount: number;
  totalPointCount: number;
}

const DEFAULT_ORBIT_DISTANCE = 5;
const DEFAULT_FIELD_OF_VIEW = 60;
const DEFAULT_ORTHO_HEIGHT = 6;
const SPLAT_STATE_SELECTED = 1;
const ZOOM_FINE_FACTOR = 0.3;
const ZOOM_MIN_STEP = 0.015;
const MOUSE_ZOOM_SENSITIVITY = 0.035;

export function useSplatScene(plyUrl: string | null): UseSplatSceneResult {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const controlsRef = useRef<OrbitControlsHandle | null>(null);
  const fpControlsRef = useRef<FirstPersonControlsHandle | null>(null);
  const splatEntityRef = useRef<any>(null);
  const groundHelperRef = useRef<GroundHelperHandle | null>(null);
  const axesHelperRef = useRef<AxesHelperHandle | null>(null);
  const appRef = useRef<any>(null);
  const pcRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);
  const initialTargetRef = useRef<Vec3>({ x: 0, y: 0, z: 0 });
  const initialDistanceRef = useRef<number>(DEFAULT_ORBIT_DISTANCE);
  const pickScratchRef = useRef<{
    from: any;
    to: any;
    rayOrigin: any;
    rayDir: any;
    world: any;
    screen: any;
  } | null>(null);
  const hiddenPointsRef = useRef<Set<number>>(new Set());
  const splatResourceRef = useRef<any>(null);
  const selectedPointsRef = useRef<Set<number>>(new Set());
  const viewportSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  const defaultBackground = VIEWER_BACKGROUNDS[0].id;
  const backgroundRef = useRef<BackgroundId>(defaultBackground);
  const [activeBackground, setActiveBackground] = useState<BackgroundId>(defaultBackground);
  const gridVisibleRef = useRef(true);
  const axesVisibleRef = useRef(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [viewportKey, setViewportKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [splatCount, setSplatCount] = useState<number | null>(null);
  const [cameraAxes, setCameraAxes] = useState<CameraAxes | null>(null);
  const [orbitState, setOrbitState] = useState<OrbitState>({
    azimuth: 0,
    elevation: 0,
    distance: DEFAULT_ORBIT_DISTANCE,
  });
  const [hiddenPointCount, setHiddenPointCount] = useState(0);
  const [totalPointCount, setTotalPointCount] = useState(0);
  const [projectionMode, setProjectionModeState] = useState<ProjectionMode>('perspective');
  const [fieldOfView, setFieldOfViewState] = useState(DEFAULT_FIELD_OF_VIEW);
  const [orthoHeight, setOrthoHeightState] = useState(DEFAULT_ORTHO_HEIGHT);
  const [cameraMode, setCameraModeState] = useState<CameraMode>('orbit');
  const [waitingForSpawnPoint, setWaitingForSpawnPoint] = useState(false);
  const [moveSpeed, setMoveSpeedState] = useState(3.0);
  const [cameraHeight, setCameraHeightState] = useState(1.6);
  const [jumpHeight, setJumpHeightState] = useState(4.0);
  const [bulletSettings, setBulletSettingsState] = useState<BulletSettings>({
    speed: 30.0,
    size: 0.1,
    color: { r: 1, g: 0.8, b: 0.2 },
    gravity: 9.8,
    lifetime: 5.0,
    bounciness: 0.6,
  });
  const [gameModeSettings, setGameModeSettingsState] = useState<GameModeSettings>({
    flyModeEnabled: false,
  });
  const projectionModeRef = useRef<ProjectionMode>('perspective');
  const fieldOfViewRef = useRef(DEFAULT_FIELD_OF_VIEW);
  const orthoHeightRef = useRef(DEFAULT_ORTHO_HEIGHT);
  const cameraModeRef = useRef<CameraMode>('orbit');
  const waitingForSpawnPointRef = useRef(false);
  const moveSpeedRef = useRef(3.0);
  const cameraHeightRef = useRef(1.6);
  const jumpHeightRef = useRef(4.0);
  const bulletSettingsRef = useRef<BulletSettings>({
    speed: 30.0,
    size: 0.1,
    color: { r: 1, g: 0.8, b: 0.2 },
    gravity: 9.8,
    lifetime: 5.0,
    bounciness: 0.6,
  });
  const gameModeSettingsRef = useRef<GameModeSettings>({
    flyModeEnabled: false,
  });

  const applyBackground = useCallback((id: BackgroundId) => {
    const preset = BACKGROUND_LOOKUP[id];
    if (!preset) {
      return;
    }

    if (cameraRef.current && cameraRef.current.camera?.clearColor) {
      const clear = cameraRef.current.camera.clearColor;
      clear.r = preset.color[0];
      clear.g = preset.color[1];
      clear.b = preset.color[2];
      clear.a = 1;
    }

    if (canvasRef.current) {
      canvasRef.current.style.backgroundColor = preset.css;
    }
  }, []);

  const setBackground = useCallback((id: BackgroundId) => {
    backgroundRef.current = id;
    setActiveBackground(id);
    applyBackground(id);
  }, [applyBackground]);

  const setGridVisible = useCallback((visible: boolean) => {
    gridVisibleRef.current = visible;
    setShowGrid(visible);
    if (groundHelperRef.current) {
      groundHelperRef.current.setVisible(visible);
    }
  }, []);

  const setAxesVisible = useCallback((visible: boolean) => {
    axesVisibleRef.current = visible;
    setShowAxes(visible);
    if (axesHelperRef.current) {
      axesHelperRef.current.setVisible(visible);
    }
  }, []);

  const updateSelectionStateTexture = useCallback(() => {
    const resource = splatResourceRef.current;
    if (!resource) {
      return;
    }
    const stateArray = resource.gsplatData?.getProp?.('state') as Uint8Array | undefined;
    const stateTexture = resource.stateTexture;
    if (!stateArray || !stateTexture || typeof stateTexture.lock !== 'function') {
      return;
    }
    const hiddenSet = hiddenPointsRef.current;
    const selectionSet = selectedPointsRef.current;

    let changed = false;
    for (let i = 0; i < stateArray.length; ++i) {
      const selected = selectionSet.has(i) && !hiddenSet.has(i);
      const currentValue = stateArray[i];
      const hasSelectedFlag = (currentValue & SPLAT_STATE_SELECTED) !== 0;
      let nextValue = currentValue;
      if (selected && !hasSelectedFlag) {
        nextValue = currentValue | SPLAT_STATE_SELECTED;
      } else if (!selected && hasSelectedFlag) {
        nextValue = currentValue & ~SPLAT_STATE_SELECTED;
      }
      if (nextValue !== currentValue) {
        stateArray[i] = nextValue;
        changed = true;
      }
    }

    if (changed) {
      try {
        const lockedBuffer = stateTexture.lock();
        lockedBuffer.set(stateArray);
        stateTexture.unlock();
      } catch (error) {
        console.error('Failed to update splat selection texture', error);
      }
      if (resource.scene) {
        resource.scene.forceRender = true;
      }
      if (appRef.current) {
        appRef.current.renderNextFrame = true;
      }
    }
  }, []);

  const updateSorterMapping = useCallback(() => {
    const entity = splatEntityRef.current;
    const resource = splatResourceRef.current;
    const hiddenSet = hiddenPointsRef.current;

    if (!entity || !resource) {
      setHiddenPointCount(hiddenSet.size);
      if (resource?.gsplatData?.numSplats) {
        setSplatCount(resource.gsplatData.numSplats - hiddenSet.size);
        setTotalPointCount(resource.gsplatData.numSplats);
      } else {
        setSplatCount(null);
        setTotalPointCount(0);
      }
      return;
    }

    const sorter = entity.gsplat?.instance?.sorter;
    const data = resource.gsplatData;
    if (!sorter || !data) {
      return;
    }

    setTotalPointCount(data.numSplats);

    if (!hiddenSet || hiddenSet.size === 0) {
      sorter.setMapping(null);
      setHiddenPointCount(0);
      setSplatCount(data.numSplats);
    } else {
      const total = data.numSplats;
      const visible: number[] = [];
      for (let i = 0; i < total; ++i) {
        if (!hiddenSet.has(i)) {
          visible.push(i);
        }
      }
      const mapping = new Uint32Array(visible);
      sorter.setMapping(mapping);
      setHiddenPointCount(hiddenSet.size);
      setSplatCount(mapping.length);
    }

    if (appRef.current) {
      appRef.current.renderNextFrame = true;
    }
    updateSelectionStateTexture();
  }, [setSplatCount, updateSelectionStateTexture]);

  const setPointsHidden = useCallback(
    (indices: number[], hidden: boolean) => {
      if (!Array.isArray(indices) || indices.length === 0) {
        return;
      }
      const hiddenSet = hiddenPointsRef.current;
      const selectionSet = selectedPointsRef.current;
      let changed = false;
      let selectionChanged = false;

      indices.forEach((index) => {
        if (!Number.isInteger(index) || index < 0) {
          return;
        }
        if (hidden) {
          if (!hiddenSet.has(index)) {
            hiddenSet.add(index);
            changed = true;
          }
          if (selectionSet.has(index)) {
            selectionSet.delete(index);
            selectionChanged = true;
          }
        } else if (hiddenSet.delete(index)) {
          changed = true;
        }
      });

      if (selectionChanged) {
        updateSelectionStateTexture();
      }

      if (changed) {
        updateSorterMapping();
      }
    },
    [updateSelectionStateTexture, updateSorterMapping],
  );

  const clearHiddenPoints = useCallback(() => {
    if (hiddenPointsRef.current.size === 0) {
      return;
    }
    hiddenPointsRef.current.clear();
    updateSorterMapping();
    updateSelectionStateTexture();
  }, [updateSelectionStateTexture, updateSorterMapping]);

  const mutatePointPositions = useCallback(
    (indices: number[], mutator: (position: Vec3, index: number) => Vec3 | null) => {
      const entity = splatEntityRef.current;
      const resource = splatResourceRef.current;
      if (!entity || !resource || typeof mutator !== 'function') {
        return false;
      }

      const sorter = entity.gsplat?.instance?.sorter;
      const data = resource.gsplatData;
      if (!sorter || !data) {
        return false;
      }

      const centers: Float32Array | undefined = sorter.centers;
      const resourceCenters: Float32Array | undefined = resource.centers;
      const xProp: Float32Array | undefined = data.getProp ? (data.getProp('x') as Float32Array) : undefined;
      const yProp: Float32Array | undefined = data.getProp ? (data.getProp('y') as Float32Array) : undefined;
      const zProp: Float32Array | undefined = data.getProp ? (data.getProp('z') as Float32Array) : undefined;

      if (!centers || !resourceCenters || !xProp || !yProp || !zProp) {
        return false;
      }

      let changed = false;

      indices.forEach((index) => {
        if (!Number.isInteger(index) || index < 0) {
          return;
        }
        const base = index * 3;
        if (base + 2 >= centers.length) {
          return;
        }
        const current = { x: centers[base], y: centers[base + 1], z: centers[base + 2] };
        const next = mutator({ ...current }, index);
        if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y) || !Number.isFinite(next.z)) {
          return;
        }
        centers[base] = next.x;
        centers[base + 1] = next.y;
        centers[base + 2] = next.z;
        resourceCenters[base] = next.x;
        resourceCenters[base + 1] = next.y;
        resourceCenters[base + 2] = next.z;
        xProp[index] = next.x;
        yProp[index] = next.y;
        zProp[index] = next.z;
        changed = true;
      });

      if (changed) {
        if (typeof resource.gsplatData?.calcAabb === 'function' && resource.aabb) {
          resource.gsplatData.calcAabb(resource.aabb);
          resource.mesh?.aabb?.copy?.(resource.aabb);
        }
        updateSorterMapping();
        updateSelectionStateTexture();
        if (appRef.current) {
          appRef.current.renderNextFrame = true;
        }
      }

      return changed;
    },
    [updateSelectionStateTexture, updateSorterMapping],
  );

  const setSelectedPoints = useCallback(
    (indices: number[]) => {
      const resource = splatResourceRef.current;
      const total = resource?.gsplatData?.numSplats ?? 0;
      const hiddenSet = hiddenPointsRef.current;
      const filtered = new Set<number>();
      indices.forEach((index) => {
        if (!Number.isInteger(index) || index < 0 || index >= total) {
          return;
        }
        if (hiddenSet.has(index)) {
          return;
        }
        filtered.add(index);
      });

      const current = selectedPointsRef.current;
      let changed = current.size !== filtered.size;
      if (!changed) {
        filtered.forEach((value) => {
          if (!current.has(value)) {
            changed = true;
          }
        });
      }

      if (!changed) {
        return;
      }

      current.clear();
      filtered.forEach((value) => current.add(value));
      updateSelectionStateTexture();
    },
    [updateSelectionStateTexture],
  );

  useEffect(() => {
    if (!plyUrl || typeof plyUrl !== 'string' || plyUrl.trim() === '') {
      setLoading(false);
      setError(null);
      setSplatCount(null);
      setHiddenPointCount(0);
      setTotalPointCount(0);
      setCameraAxes(null);
      splatResourceRef.current = null;
      hiddenPointsRef.current.clear();
      selectedPointsRef.current.clear();
      updateSelectionStateTexture();
      setOrbitState({
        azimuth: 0,
        elevation: 0,
        distance: DEFAULT_ORBIT_DISTANCE,
      });
      return;
    }

    // Validate URL format
    try {
      const url = new URL(plyUrl, window.location.origin);
      const allowedProtocols = ['http:', 'https:', 'blob:'];
      if (!allowedProtocols.includes(url.protocol)) {
        setError('Invalid PLY file URL. Supported protocols are HTTP, HTTPS, or local object URLs.');
        setLoading(false);
        return;
      }
    } catch (e) {
      setError('Invalid PLY file URL format.');
      setLoading(false);
      return;
    }

    let app: any;
    let handleResize: (() => void) | null = null;
    let unsubscribeCamera: (() => void) | null = null;
    let unsubscribeOrbit: (() => void) | null = null;
    let handleContextMenu: ((event: MouseEvent) => void) | null = null;
    let canvasElement: HTMLCanvasElement | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const initScene = async () => {
      try {
        setLoading(true);
        setError(null);

        if (!(window as any).pc) {
          await loadPlayCanvasScript();
        }

        const pc = (window as any).pc;
        const canvas = canvasRef.current;
        canvasElement = canvas;

        if (!pc || !canvas) {
          setError('Failed to initialize PlayCanvas context.');
          setLoading(false);
          return;
        }

        app = new pc.Application(canvas, {
          mouse: new pc.Mouse(canvas),
          touch: new pc.TouchDevice(canvas),
          keyboard: new pc.Keyboard(window),
          graphicsDeviceOptions: {
            antialias: true,
            alpha: false,
          },
        });

        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);

        const resizeToContainer = () => {
          const currentCanvas = canvasRef.current;
          if (!currentCanvas) {
            return;
          }
          const parent = currentCanvas.parentElement;
          const width = Math.max(1, parent?.clientWidth ?? window.innerWidth);
          const height = Math.max(1, parent?.clientHeight ?? window.innerHeight);
          app.resizeCanvas(width, height);

          const prev = viewportSizeRef.current;
          if (prev.width !== width || prev.height !== height) {
            viewportSizeRef.current = { width, height };
            setViewportKey((value) => value + 1);
          }
        };

        resizeToContainer();

        handleResize = () => resizeToContainer();
        window.addEventListener('resize', handleResize);
        if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
          resizeObserver = new ResizeObserver(() => resizeToContainer());
          resizeObserver.observe(canvas.parentElement);
        }

        const cameraEntity = new pc.Entity('camera');
        cameraEntity.addComponent('camera', {
          clearColor: new pc.Color(0.1, 0.1, 0.15),
          farClip: 1000,
          nearClip: 0.1,
        });
        cameraEntity.setPosition(0, 0, DEFAULT_ORBIT_DISTANCE);
        cameraEntity.camera.fov = fieldOfViewRef.current;
        cameraEntity.camera.orthoHeight = orthoHeightRef.current;
        app.root.addChild(cameraEntity);

        appRef.current = app;
        pcRef.current = pc;
        cameraRef.current = cameraEntity;
        applyBackground(backgroundRef.current);
        setProjectionModeState('perspective');
        projectionModeRef.current = 'perspective';
        setFieldOfViewState(cameraEntity.camera.fov);
        fieldOfViewRef.current = cameraEntity.camera.fov;
        const initialOrthoHeight = cameraEntity.camera.orthoHeight ?? DEFAULT_ORTHO_HEIGHT;
        setOrthoHeightState(initialOrthoHeight);
        orthoHeightRef.current = initialOrthoHeight;

        handleContextMenu = (event: MouseEvent) => {
          event.preventDefault();
        };
        canvas.addEventListener('contextmenu', handleContextMenu);

        const controls = initOrbitControls(app, cameraEntity, pc, axesHelperRef);
        controlsRef.current = controls;
        unsubscribeCamera = controls.onCameraChange((axes) => {
          setCameraAxes(axes);
        });
        unsubscribeOrbit = controls.onOrbitStateChange(({ orbitDistance, orbitX, orbitY }) => {
          setOrbitState({
            azimuth: orbitX,
            elevation: orbitY,
            distance: orbitDistance,
          });
        });
        controls.updateCameraPosition();
        const initialControlState = controls.getState();
        setOrbitState({
          azimuth: initialControlState.orbitX,
          elevation: initialControlState.orbitY,
          distance: initialControlState.orbitDistance,
        });

        const groundHelper = createGroundPlane(app, pc);
        groundHelperRef.current = {
          updateSize: groundHelper.updateSize,
          setVisible: groundHelper.setVisible,
        };
        groundHelper.setVisible(gridVisibleRef.current);

        const axesHelper = createAxesHelper(app, pc);
        axesHelperRef.current = {
          updateSceneScale: axesHelper.updateSceneScale,
          updateCameraDistance: axesHelper.updateCameraDistance,
          setVisible: axesHelper.setVisible,
        };
        axesHelper.updateCameraDistance(controls.getState().orbitDistance);
        axesHelper.setVisible(axesVisibleRef.current);

        const light = new pc.Entity('light');
        light.addComponent('light', {
          type: pc.LIGHTTYPE_DIRECTIONAL,
          color: new pc.Color(1, 1, 1),
          intensity: 1,
        });
        light.setEulerAngles(45, 30, 0);
        app.root.addChild(light);

        app.start();

        hiddenPointsRef.current.clear();
        setHiddenPointCount(0);
        setTotalPointCount(0);
        splatResourceRef.current = null;

        await loadGaussianSplat({
          app,
          pc,
          url: plyUrl,
          controls,
          splatEntityRef,
          groundHelperRef,
          axesHelperRef,
          setSplatCount,
          initialTargetRef,
          initialDistanceRef,
          onResourceReady: ({ count, resource }) => {
            splatResourceRef.current = resource;
            hiddenPointsRef.current.clear();
            setHiddenPointCount(0);
            setTotalPointCount(count);
            selectedPointsRef.current.clear();
            updateSelectionStateTexture();
            updateSorterMapping();
          },
        });

        setLoading(false);
      } catch (err) {
        console.error('Error initializing PlayCanvas:', err);
        setError(`Failed to initialize viewer: ${err instanceof Error ? err.message : 'Unknown error'}`);
        setLoading(false);
      }
    };

    initScene();

    return () => {
      if (unsubscribeCamera) {
        unsubscribeCamera();
      }
      if (unsubscribeOrbit) {
        unsubscribeOrbit();
      }
      if (handleResize) {
        window.removeEventListener('resize', handleResize);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      if (handleContextMenu && canvasElement) {
        canvasElement.removeEventListener('contextmenu', handleContextMenu);
      }
      if (app) {
        app.destroy();
      }
      controlsRef.current = null;
      splatEntityRef.current = null;
      groundHelperRef.current = null;
      axesHelperRef.current = null;
      appRef.current = null;
      pcRef.current = null;
      cameraRef.current = null;
      splatResourceRef.current = null;
      hiddenPointsRef.current.clear();
      setHiddenPointCount(0);
      setTotalPointCount(0);
      setSplatCount(null);
    };
  }, [plyUrl, applyBackground, updateSelectionStateTexture]);

  const resetScene = useCallback(() => {
    if (controlsRef.current) {
      controlsRef.current.setTarget(initialTargetRef.current);
      controlsRef.current.setOrbitAngles(0, 0, { immediate: true });
      controlsRef.current.setOrbitDistance(initialDistanceRef.current, { immediate: true });
    }

    if (splatEntityRef.current) {
      splatEntityRef.current.setEulerAngles(0, 0, 0);
      splatEntityRef.current.setPosition(0, 0, 0);
    }
  }, []);

  const syncModelRotation = useCallback((rotation: Vec3) => {
    if (splatEntityRef.current) {
      splatEntityRef.current.setEulerAngles(rotation.x, rotation.y, rotation.z);
    }
  }, []);

  const syncModelPosition = useCallback((position: Vec3) => {
    if (splatEntityRef.current) {
      splatEntityRef.current.setPosition(position.x, position.y, position.z);
    }
  }, []);

  const getPointLocalPosition = useCallback((index: number) => {
    const splatEntity = splatEntityRef.current;
    const centers: Float32Array | undefined = splatEntity?.gsplat?.instance?.sorter?.centers;
    if (!centers) {
      return null;
    }

    if (!Number.isInteger(index) || index < 0) {
      return null;
    }

    const base = index * 3;
    if (base < 0 || base + 2 >= centers.length) {
      return null;
    }

    return {
      x: centers[base],
      y: centers[base + 1],
      z: centers[base + 2],
    };
  }, []);

  const modelToWorld = useCallback((point: Vec3) => {
    const pc = pcRef.current;
    const entity = splatEntityRef.current;
    if (!pc || !entity) {
      return null;
    }

    const worldMatrix = entity.getWorldTransform();
    if (!worldMatrix) {
      return null;
    }

    const localVec = new pc.Vec3(point.x, point.y, point.z);
    const worldVec = new pc.Vec3();
    worldMatrix.transformPoint(localVec, worldVec);
    return { x: worldVec.x, y: worldVec.y, z: worldVec.z };
  }, []);

  const worldToModel = useCallback((point: Vec3) => {
    const pc = pcRef.current;
    const entity = splatEntityRef.current;
    if (!pc || !entity) {
      return null;
    }

    const worldMatrix = entity.getWorldTransform();
    if (!worldMatrix) {
      return null;
    }

    const invMatrix = new pc.Mat4();
    invMatrix.copy(worldMatrix).invert();

    const worldVec = new pc.Vec3(point.x, point.y, point.z);
    const localVec = new pc.Vec3();
    invMatrix.transformPoint(worldVec, localVec);
    return { x: localVec.x, y: localVec.y, z: localVec.z };
  }, []);

  const getPointWorldPosition = useCallback(
    (index: number) => {
      const local = getPointLocalPosition(index);
      if (!local) {
        return null;
      }
      const world = modelToWorld(local);
      if (!world) {
        return null;
      }
      return { x: world.x, y: world.y, z: world.z };
    },
    [getPointLocalPosition, modelToWorld],
  );

  const forEachVisiblePoint = useCallback(
    (callback: (index: number, local: Vec3, world: Vec3) => void | boolean) => {
      const resource = splatResourceRef.current;
      if (!resource) {
        return;
      }
      const total = resource.gsplatData?.numSplats ?? 0;
      const hiddenSet = hiddenPointsRef.current;

      for (let i = 0; i < total; ++i) {
        if (hiddenSet.has(i)) {
          continue;
        }
        const local = getPointLocalPosition(i);
        if (!local) {
          continue;
        }
        const world = modelToWorld(local);
        if (!world) {
          continue;
        }
        const result = callback(i, local, world);
        if (result === false) {
          break;
        }
      }
    },
    [getPointLocalPosition, modelToWorld],
  );

  const setOrbitAngles = useCallback(
    (azimuth: number, elevation: number, options?: { immediate?: boolean }) => {
      controlsRef.current?.setOrbitAngles(azimuth, elevation, options);
    },
    [],
  );

  const setOrbitDistance = useCallback(
    (distance: number, options?: { immediate?: boolean }) => {
      controlsRef.current?.setOrbitDistance(distance, options);
    },
    [],
  );

  const adjustZoom = useCallback((delta: number) => {
    const controls = controlsRef.current;
    if (!controls || !Number.isFinite(delta) || delta === 0) {
      return;
    }

    const scaledMagnitude = Math.max(Math.abs(delta) * ZOOM_FINE_FACTOR, ZOOM_MIN_STEP);
    const scaledDelta = Math.sign(delta) * scaledMagnitude;
    controls.adjustOrbitDistance(scaledDelta);
  }, []);

  const alignCamera = useCallback((direction: AlignDirection) => {
    controlsRef.current?.alignTo(direction);
  }, []);

  const setProjectionMode = useCallback((mode: ProjectionMode) => {
    const cameraEntity = cameraRef.current;
    const pc = pcRef.current;
    if (!cameraEntity || !pc) {
      return;
    }

    const nextMode: ProjectionMode = mode === 'orthographic' ? 'orthographic' : 'perspective';
    if (projectionModeRef.current === nextMode) {
      return;
    }

    if (nextMode === 'orthographic') {
      cameraEntity.camera.projection = pc.PROJECTION_ORTHOGRAPHIC;
      cameraEntity.camera.orthoHeight = orthoHeightRef.current;
    } else {
      cameraEntity.camera.projection = pc.PROJECTION_PERSPECTIVE;
      cameraEntity.camera.fov = fieldOfViewRef.current;
    }

    projectionModeRef.current = nextMode;
    setProjectionModeState(nextMode);
  }, []);

  const setFieldOfView = useCallback((value: number) => {
    const cameraEntity = cameraRef.current;
    const clamped = Math.min(110, Math.max(20, value));
    if (cameraEntity?.camera) {
      cameraEntity.camera.fov = clamped;
    }
    fieldOfViewRef.current = clamped;
    setFieldOfViewState(clamped);
  }, []);

  const setOrthoHeight = useCallback((value: number) => {
    const cameraEntity = cameraRef.current;
    const clamped = Math.min(100, Math.max(0.1, value));
    if (cameraEntity?.camera) {
      cameraEntity.camera.orthoHeight = clamped;
    }
    orthoHeightRef.current = clamped;
    setOrthoHeightState(clamped);
  }, []);

  const setMoveSpeed = useCallback((value: number) => {
    const clamped = Math.min(20, Math.max(0.1, value));
    moveSpeedRef.current = clamped;
    setMoveSpeedState(clamped);

    // Update FP controls if they exist
    if (fpControlsRef.current) {
      fpControlsRef.current.setMoveSpeed(clamped);
    }
  }, []);

  const setCameraHeight = useCallback((value: number) => {
    const clamped = Math.min(3.0, Math.max(0.05, value));
    let applied = clamped;

    if (fpControlsRef.current) {
      const result = fpControlsRef.current.setCameraHeight(clamped);
      if (typeof result === 'number' && Number.isFinite(result)) {
        applied = result;
      }
    }

    cameraHeightRef.current = applied;
    setCameraHeightState(applied);
  }, []);

  const setJumpHeight = useCallback((value: number) => {
    const clamped = Math.min(15.0, Math.max(1.0, value));
    jumpHeightRef.current = clamped;
    setJumpHeightState(clamped);

    // Update FP controls if they exist
    if (fpControlsRef.current) {
      fpControlsRef.current.setJumpHeight(clamped);
    }
  }, []);

  const setBulletSettings = useCallback((settings: Partial<BulletSettings>) => {
    const updated = { ...bulletSettingsRef.current, ...settings };
    bulletSettingsRef.current = updated;
    setBulletSettingsState(updated);

    // Update FP controls if they exist and have updateBulletSettings method
    if (fpControlsRef.current && typeof fpControlsRef.current.updateBulletSettings === 'function') {
      fpControlsRef.current.updateBulletSettings(updated);
    }
  }, []);

  const setGameModeSettings = useCallback((settings: Partial<GameModeSettings>) => {
    const updated = { ...gameModeSettingsRef.current, ...settings };
    gameModeSettingsRef.current = updated;
    setGameModeSettingsState(updated);

    // Update FP controls if they exist and have updateGameModeSettings method
    if (fpControlsRef.current && typeof fpControlsRef.current.updateGameModeSettings === 'function') {
      fpControlsRef.current.updateGameModeSettings(updated);
    }
  }, []);

  const setCameraMode = useCallback((mode: CameraMode) => {
    const pc = pcRef.current;
    const app = appRef.current;
    const camera = cameraRef.current;
    if (!pc || !app || !camera) {
      return;
    }

    const currentMode = cameraModeRef.current;
    if (currentMode === mode) {
      return;
    }

    // Disable current controls
    if (currentMode === 'orbit' && controlsRef.current) {
      controlsRef.current.setEnabled(false);
    } else if ((currentMode === 'walk' || currentMode === 'fly' || currentMode === 'game') && fpControlsRef.current) {
      fpControlsRef.current.destroy();
      fpControlsRef.current = null;
    }

    // Enable new controls
    if (mode === 'orbit') {
      if (controlsRef.current) {
        controlsRef.current.setEnabled(true);
      }
      setWaitingForSpawnPoint(false);
      waitingForSpawnPointRef.current = false;
    } else if (mode === 'walk' || mode === 'fly' || mode === 'game') {
      // Enter spawn point selection mode
      setWaitingForSpawnPoint(true);
      waitingForSpawnPointRef.current = true;

      // Don't create FP controls yet - wait for spawn point selection
      // fpControlsRef.current will be created after spawn point is selected
    }

    cameraModeRef.current = mode;
    setCameraModeState(mode);
  }, []);

  const handleSpawnPointSelected = useCallback((worldPos: Vec3) => {
    const pc = pcRef.current;
    const app = appRef.current;
    const camera = cameraRef.current;
    const mode = cameraModeRef.current;

    if (!pc || !app || !camera || mode === 'orbit') {
      return;
    }

    // Create first person controls at the selected position
    const collisionEnabled = mode === 'walk' || (mode === 'game' && !gameModeSettingsRef.current.flyModeEnabled);
    const isGameMode = mode === 'game';
    const controls = initFirstPersonControls(
      app,
      camera,
      pc,
      splatEntityRef,
      hiddenPointsRef,
      collisionEnabled,
      moveSpeedRef.current,
      cameraHeightRef.current,
      jumpHeightRef.current,
      isGameMode,
      bulletSettingsRef.current,
      gameModeSettingsRef.current,
    );
    fpControlsRef.current = controls;

    // Set spawn position (slightly above the clicked point for Walk/Game mode)
    const spawnHeight = collisionEnabled ? cameraHeightRef.current : 0; // Eye level for walk/game, exact position for fly
    controls.setPosition({
      x: worldPos.x,
      y: worldPos.y + spawnHeight,
      z: worldPos.z,
    });

    // Enable pointer lock
    controls.setPointerLockEnabled(true);

    // Exit spawn point selection mode
    setWaitingForSpawnPoint(false);
    waitingForSpawnPointRef.current = false;
  }, []);

  const resetCamera = useCallback(() => {
    const controls = controlsRef.current;
    if (controls) {
      controls.setTarget(initialTargetRef.current);
      controls.setOrbitAngles(0, 0, { immediate: true });
      controls.setOrbitDistance(initialDistanceRef.current, { immediate: true });
    }
    setProjectionMode('perspective');
    setFieldOfView(DEFAULT_FIELD_OF_VIEW);
    setOrthoHeight(DEFAULT_ORTHO_HEIGHT);
  }, [setFieldOfView, setOrthoHeight, setProjectionMode]);

  const computeAlignmentRotation = useCallback(
    (start: Vec3, end: Vec3, axis: AlignAxis): Vec3 | null => {
      const pc = pcRef.current;
      if (!pc) {
        return null;
      }

      const diff = new pc.Vec3(end.x - start.x, end.y - start.y, end.z - start.z);
      const length = diff.length();
      if (!Number.isFinite(length) || length < 1e-4) {
        return null;
      }

      diff.scale(1 / length);
      const target = new pc.Vec3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);

      const dot = Math.max(-1, Math.min(1, diff.dot(target)));
      const quat = new pc.Quat();

      if (dot >= 0.999999) {
        // already aligned
        quat.set(0, 0, 0, 1);
      } else if (dot <= -0.999999) {
        // 180-degree turn around any perpendicular axis
        const helper = Math.abs(diff.x) < 0.5 ? new pc.Vec3(1, 0, 0) : new pc.Vec3(0, 1, 0);
        const axisVec = new pc.Vec3().cross(diff, helper).normalize();
        if (axisVec.length() === 0) {
          return null;
        }
        quat.setFromAxisAngle(axisVec, Math.PI);
      } else {
        const cross = new pc.Vec3().cross(diff, target);
        const axisLength = cross.length();
        if (axisLength < 1e-6) {
          return null;
        }
        cross.scale(1 / axisLength);
        const angle = Math.acos(dot);
        quat.setFromAxisAngle(cross, angle);
      }

      const euler = new pc.Vec3();
      quat.getEulerAngles(euler);
      if ([euler.x, euler.y, euler.z].some((value) => !Number.isFinite(value))) {
        return null;
      }

      return { x: euler.x, y: euler.y, z: euler.z };
    },
    [],
  );

  const ensurePickScratch = useCallback(() => {
    if (!pcRef.current) {
      return null;
    }

    if (!pickScratchRef.current) {
      pickScratchRef.current = {
        from: new pcRef.current.Vec3(),
        to: new pcRef.current.Vec3(),
        rayOrigin: new pcRef.current.Vec3(),
        rayDir: new pcRef.current.Vec3(),
        world: new pcRef.current.Vec3(),
        screen: new pcRef.current.Vec3(),
      };
    }

    return pickScratchRef.current;
  }, []);

  const pickPoint = useCallback((canvasX: number, canvasY: number) => {
    const pc = pcRef.current;
    const cameraEntity = cameraRef.current;
    const canvas = canvasRef.current;
    const splatEntity = splatEntityRef.current;
    if (!pc || !cameraEntity || !canvas || !splatEntity?.gsplat?.instance) {
      return null;
    }

    const centers: Float32Array | undefined = splatEntity.gsplat.instance.sorter?.centers;
    if (!centers || centers.length === 0) {
      return null;
    }

    const scratch = ensurePickScratch();
    if (!scratch) {
      return null;
    }

    const clientWidth = canvas.clientWidth || canvas.width;
    const clientHeight = canvas.clientHeight || canvas.height;
    if (clientWidth === 0 || clientHeight === 0) {
      return null;
    }

    const renderWidth = canvas.width || clientWidth;
    const renderHeight = canvas.height || clientHeight;

    const px = (canvasX / clientWidth) * renderWidth;
    const py = (canvasY / clientHeight) * renderHeight;

    const camera = cameraEntity.camera;

    camera.screenToWorld(px, py, camera.nearClip ?? 0.01, scratch.from);
    camera.screenToWorld(px, py, camera.farClip ?? 1000, scratch.to);

    scratch.rayOrigin.copy(scratch.from);
    scratch.rayDir.copy(scratch.to).sub(scratch.from).normalize();

    const transform = splatEntity.getWorldTransform().data;
    const rayOrigin = scratch.rayOrigin;
    const rayDir = scratch.rayDir;

    const screenScaleX = renderWidth / clientWidth;
    const screenScaleY = renderHeight / clientHeight;
    const pixelThreshold = 22;
    const avgScale = (screenScaleX + screenScaleY) * 0.5;
    const threshold = Math.max(pixelThreshold * avgScale, 1);
    const screenThresholdSq = threshold * threshold;
    const screenPenalty = 0.0005;
    const scoreEpsilon = 1e-6;

    let bestScore = Number.POSITIVE_INFINITY;
    let bestWorld: Vec3 | null = null;
    let bestLocal: Vec3 | null = null;
    let bestIndex = -1;
    let bestAlong = Number.POSITIVE_INFINITY;

    for (let i = 0; i < centers.length; i += 3) {
      const pointIndex = i / 3;
      if (hiddenPointsRef.current.has(pointIndex)) {
        continue;
      }

      const lx = centers[i];
      const ly = centers[i + 1];
      const lz = centers[i + 2];

      const wx = transform[0] * lx + transform[4] * ly + transform[8] * lz + transform[12];
      const wy = transform[1] * lx + transform[5] * ly + transform[9] * lz + transform[13];
      const wz = transform[2] * lx + transform[6] * ly + transform[10] * lz + transform[14];

      scratch.world.set(wx, wy, wz);
      camera.worldToScreen(scratch.world, scratch.screen);

      const dx = scratch.screen.x - px;
      const dy = scratch.screen.y - py;
      const screenDistSq = dx * dx + dy * dy;

      if (screenDistSq > screenThresholdSq) {
        continue;
      }

      const ox = wx - rayOrigin.x;
      const oy = wy - rayOrigin.y;
      const oz = wz - rayOrigin.z;
      const along = ox * rayDir.x + oy * rayDir.y + oz * rayDir.z;
      if (along < 0) {
        continue;
      }

      const closestX = rayOrigin.x + rayDir.x * along;
      const closestY = rayOrigin.y + rayDir.y * along;
      const closestZ = rayOrigin.z + rayDir.z * along;

      const radialDx = wx - closestX;
      const radialDy = wy - closestY;
      const radialDz = wz - closestZ;
      const radialDistSq = radialDx * radialDx + radialDy * radialDy + radialDz * radialDz;

      const score = radialDistSq + screenDistSq * screenPenalty;

      if (score + scoreEpsilon < bestScore || (Math.abs(score - bestScore) <= scoreEpsilon && along < bestAlong - scoreEpsilon)) {
        bestScore = score;
        bestAlong = along;
        bestWorld = { x: wx, y: wy, z: wz };
        bestLocal = { x: lx, y: ly, z: lz };
        bestIndex = pointIndex;

        if (score < 1e-6) {
          break;
        }
      }
    }

    if (bestIndex < 0 || !bestWorld || !bestLocal) {
      return null;
    }

    return {
      index: bestIndex,
      local: bestLocal,
      world: bestWorld,
    };
  }, [ensurePickScratch]);

  const pickWorldPoint = useCallback(
    (canvasX: number, canvasY: number) => {
      const result = pickPoint(canvasX, canvasY);
      if (!result) {
        return null;
      }
      return { x: result.world.x, y: result.world.y, z: result.world.z };
    },
    [pickPoint],
  );

  const projectWorldToScreen = useCallback((position: Vec3): ScreenProjection | null => {
    const pc = pcRef.current;
    const cameraEntity = cameraRef.current;
    const canvas = canvasRef.current;
    if (!pc || !cameraEntity || !canvas) {
      return null;
    }

    const scratch = ensurePickScratch();
    if (!scratch) {
      return null;
    }

    scratch.world.set(position.x, position.y, position.z);
    cameraEntity.camera.worldToScreen(scratch.world, scratch.screen);

    const clientWidth = canvas.clientWidth || canvas.width;
    const clientHeight = canvas.clientHeight || canvas.height;
    if (clientWidth === 0 || clientHeight === 0) {
      return null;
    }

    const renderWidth = canvas.width || clientWidth;
    const renderHeight = canvas.height || clientHeight;

    const x = (scratch.screen.x / renderWidth) * clientWidth;
    const y = (scratch.screen.y / renderHeight) * clientHeight;
    const nx = clientWidth > 0 ? x / clientWidth : 0;
    const ny = clientHeight > 0 ? y / clientHeight : 0;
    const visible = scratch.screen.z >= 0;

    return { x, y, nx, ny, visible };
  }, [ensurePickScratch]);

  return {
    canvasRef,
    loading,
    error,
    splatCount,
    hiddenPointCount,
    totalPointCount,
    resetScene,
    syncModelRotation,
    syncModelPosition,
    adjustZoom,
    cameraAxes,
    alignCamera,
    backgroundOptions: VIEWER_BACKGROUNDS,
    activeBackground,
    setBackground,
    showGrid,
    setGridVisible,
    showAxes,
    setAxesVisible,
    pickWorldPoint,
    pickPoint,
    projectWorldToScreen,
    viewportKey,
    orbitState,
    setOrbitAngles,
    setOrbitDistance,
    projectionMode,
    setProjectionMode,
    fieldOfView,
    setFieldOfView,
    orthoHeight,
    setOrthoHeight,
    resetCamera,
    cameraMode,
    setCameraMode,
    waitingForSpawnPoint,
    handleSpawnPointSelected,
    moveSpeed,
    setMoveSpeed,
    cameraHeight,
    setCameraHeight,
    jumpHeight,
    setJumpHeight,
    bulletSettings,
    setBulletSettings,
    gameModeSettings,
    setGameModeSettings,
    computeAlignmentRotation,
    modelToWorld,
    worldToModel,
    getPointWorldPosition,
    getPointLocalPosition,
    mutatePointPositions,
    setPointsHidden,
    clearHiddenPoints,
    setSelectedPoints,
    forEachVisiblePoint,
  };
}

const loadPlayCanvasScript = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if ((window as any).pc) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://code.playcanvas.com/playcanvas-stable.min.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load PlayCanvas'));
    document.head.appendChild(script);
  });
};

const createGridTexture = (pc: any, device: any) => {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    return null;
  }

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(0, 0, size, size);

  const drawLines = (step: number, alpha: number, lineWidth: number) => {
    ctx.save();
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = lineWidth;
    for (let i = 0; i <= size + 0.5; i += step) {
      ctx.beginPath();
      ctx.moveTo(i + 0.5, 0);
      ctx.lineTo(i + 0.5, size);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, i + 0.5);
      ctx.lineTo(size, i + 0.5);
      ctx.stroke();
    }
    ctx.restore();
  };

  drawLines(size / 25, 0.04, 1);
  drawLines(size / 5, 0.12, 1.8);
  drawLines(size, 0.22, 3);

  const texture = new pc.Texture(device, {
    width: size,
    height: size,
    format: pc.PIXELFORMAT_R8_G8_B8_A8,
    mipmaps: true,
  });

  texture.setSource(canvas);
  texture.addressU = pc.ADDRESS_REPEAT;
  texture.addressV = pc.ADDRESS_REPEAT;
  texture.minFilter = pc.FILTER_LINEAR_MIPMAP_LINEAR;
  texture.magFilter = pc.FILTER_LINEAR;

  return texture;
};

const createGroundPlane = (app: any, pc: any) => {
  const gridTexture = createGridTexture(pc, app.graphicsDevice);
  const material = new pc.StandardMaterial();
  material.useMetalness = false;
  material.metalness = 0;
  material.roughness = 1;
  material.diffuse = new pc.Color(0.75, 0.75, 0.75);
  material.emissive = new pc.Color(0.35, 0.35, 0.35);
  material.opacity = 0.85;
  material.blendType = pc.BLEND_NORMAL;
  material.depthWrite = false;
  material.cull = pc.CULLFACE_NONE;

  if (gridTexture) {
    material.diffuseMap = gridTexture;
    material.opacityMap = gridTexture;
    material.diffuseMapTiling = new pc.Vec2(10, 10);
    material.opacityMapTiling = new pc.Vec2(10, 10);
    material.opacityMapChannel = 'a';
  }

  material.update();

  const plane = new pc.Entity('ground-plane');
  plane.addComponent('render', {
    type: 'plane',
    castShadows: false,
    receiveShadows: false,
  });
  plane.render.material = material;
  plane.setLocalEulerAngles(0, 0, 0);
  plane.setLocalPosition(0, 0, 0);
  app.root.addChild(plane);

  const unitsPerTile = 5;

  const updateSize = (radius: number) => {
    const extent = Math.max(radius * 3, 20);
    plane.setLocalScale(extent, 1, extent);

    const tiling = extent / unitsPerTile;

    if (material.diffuseMapTiling) {
      material.diffuseMapTiling.set(tiling, tiling);
    }

    if (material.opacityMapTiling) {
      material.opacityMapTiling.set(tiling, tiling);
    }

    material.update();
  };

  updateSize(10);

  const setVisible = (visible: boolean) => {
    plane.enabled = visible;
  };

  return { entity: plane, updateSize, setVisible };
};

const createAxesHelper = (app: any, pc: any) => {
  const root = new pc.Entity('axes-helper');
  root.setLocalPosition(0, 0, 0);
  app.root.addChild(root);

  const makeMaterial = (r: number, g: number, b: number, opacity = 1) => {
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(r, g, b);
    material.emissive = new pc.Color(r, g, b);
    material.useMetalness = false;
    material.metalness = 0;
    material.roughness = 1;
    material.opacity = opacity;
    material.blendType = opacity < 1 ? pc.BLEND_NORMAL : pc.BLEND_NONE;
    material.depthTest = false;
    material.depthWrite = false;
    material.cull = pc.CULLFACE_NONE;
    material.update();
    return material;
  };

  const axes = {} as Record<'x' | 'y' | 'z', {
    line: any;
    arrow: any;
  }>;

  const axisMaterials = {
    x: makeMaterial(1, 0.3, 0.3),
    y: makeMaterial(0.3, 1, 0.3),
    z: makeMaterial(0.3, 0.5, 1),
  };

  (['x', 'y', 'z'] as const).forEach((axis) => {
    const group = new pc.Entity(`axis-${axis}`);
    const line = new pc.Entity(`axis-${axis}-line`);
    line.addComponent('render', {
      type: 'box',
      castShadows: false,
      receiveShadows: false,
    });
    line.render.material = axisMaterials[axis];

    const arrow = new pc.Entity(`axis-${axis}-arrow`);
    arrow.addComponent('render', {
      type: 'cone',
      castShadows: false,
      receiveShadows: false,
    });
    arrow.render.material = axisMaterials[axis];

    group.addChild(line);
    group.addChild(arrow);
    root.addChild(group);

    axes[axis] = { line, arrow };
  });

  const origin = new pc.Entity('axis-origin');
  origin.addComponent('render', {
    type: 'sphere',
    castShadows: false,
    receiveShadows: false,
  });
  const originMaterial = makeMaterial(1, 1, 1, 0.65);
  origin.render.material = originMaterial;
  root.addChild(origin);

  let sceneRadius = 5;
  let cameraDistance = 5;

  const applyDimensions = () => {
    const minLength = Math.max(sceneRadius * 0.1, 0.5);
    const maxLength = Math.max(sceneRadius * 0.6, minLength + 0.01);
    const targetFromCamera = Math.max(cameraDistance * 0.25, minLength);
    const length = Math.min(Math.max(targetFromCamera, minLength), maxLength);
    const thickness = Math.max(length * 0.05, 0.025);

    const updateAxis = (axis: 'x' | 'y' | 'z') => {
      const data = axes[axis];

      switch (axis) {
        case 'x':
          data.line.setLocalScale(length * 2, thickness, thickness);
          data.line.setLocalPosition(0, 0, 0);
          data.arrow.setLocalScale(thickness * 3, thickness * 6, thickness * 3);
          data.arrow.setLocalPosition(length, 0, 0);
          data.arrow.setLocalEulerAngles(0, 0, -90);
          break;
        case 'y':
          data.line.setLocalScale(thickness, length * 2, thickness);
          data.line.setLocalPosition(0, 0, 0);
          data.arrow.setLocalScale(thickness * 3, thickness * 6, thickness * 3);
          data.arrow.setLocalPosition(0, length, 0);
          data.arrow.setLocalEulerAngles(0, 0, 0);
          break;
        case 'z':
          data.line.setLocalScale(thickness, thickness, length * 2);
          data.line.setLocalPosition(0, 0, 0);
          data.arrow.setLocalScale(thickness * 3, thickness * 6, thickness * 3);
          data.arrow.setLocalPosition(0, 0, length);
          data.arrow.setLocalEulerAngles(90, 0, 0);
          break;
      }
    };

    updateAxis('x');
    updateAxis('y');
    updateAxis('z');

    origin.setLocalScale(thickness * 2, thickness * 2, thickness * 2);
  };

  const updateSceneScale = (radius: number) => {
    sceneRadius = Math.max(radius, 0.5);
    applyDimensions();
  };

  const updateCameraDistance = (distance: number) => {
    cameraDistance = Math.max(distance, 0.1);
    applyDimensions();
  };

  applyDimensions();

  const setVisible = (visible: boolean) => {
    root.enabled = visible;
  };

  return { root, updateSceneScale, updateCameraDistance, setVisible };
};

const shouldBlockOrbit = (domEvent: Event | null | undefined) => {
  if (!domEvent) return false;
  const target = domEvent.target as HTMLElement | null;
  if (!target) return false;
  return Boolean(target.closest('[data-orbit-block="true"]'));
};

const initOrbitControls = (app: any, camera: any, pc: any, axesHelperRef: React.MutableRefObject<AxesHelperHandle | null>) => {
  type DragMode = 'orbit' | 'pan' | null;

  let enabled = true;
  let dragMode: DragMode = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let orbitDistance = DEFAULT_ORBIT_DISTANCE;
  let orbitX = 0;
  let orbitY = 0;
  let targetOrbitDistance = orbitDistance;
  let targetOrbitX = orbitX;
  let targetOrbitY = orbitY;

  const target = new pc.Vec3(0, 0, 0);
  const targetTarget = new pc.Vec3(0, 0, 0);
  const cameraPosition = new pc.Vec3();
  const orbitOffset = new pc.Vec3();
  const panRight = new pc.Vec3();
  const panUp = new pc.Vec3();
  const listeners: Array<(axes: CameraAxes) => void> = [];
  const orbitListeners: Array<(state: { orbitDistance: number; orbitX: number; orbitY: number }) => void> = [];
  const viewMatrix = new pc.Mat4();
  const vecX = new pc.Vec3();
  const vecY = new pc.Vec3();
  const vecZ = new pc.Vec3();

  const clampOrbitY = (value: number) => Math.max(-89.9, Math.min(89.9, value));

  const setImmediateOrbit = () => {
    orbitDistance = targetOrbitDistance;
    orbitX = targetOrbitX;
    orbitY = targetOrbitY;
    updateCameraPosition(true);
  };

  const notifyCameraChange = () => {
    const world = camera.getWorldTransform();
    viewMatrix.copy(world).invert();
    viewMatrix.getX(vecX);
    viewMatrix.getY(vecY);
    viewMatrix.getZ(vecZ);

    const payload: CameraAxes = {
      x: { x: vecX.x, y: vecX.y, z: vecX.z },
      y: { x: vecY.x, y: vecY.y, z: vecY.z },
      z: { x: vecZ.x, y: vecZ.y, z: vecZ.z },
    };

    listeners.forEach((fn) => fn(payload));
  };

  const notifyOrbitChange = () => {
    const payload = { orbitDistance, orbitX, orbitY };
    orbitListeners.forEach((fn) => fn(payload));
  };

  const updateCameraPosition = (force = false) => {
    if (!force && Math.abs(orbitY) > 89.9) {
      orbitY = clampOrbitY(orbitY);
    }

    const radX = (orbitX * Math.PI) / 180;
    const radY = (orbitY * Math.PI) / 180;

    orbitOffset.set(
      orbitDistance * Math.sin(radX) * Math.cos(radY),
      orbitDistance * Math.sin(radY),
      orbitDistance * Math.cos(radX) * Math.cos(radY),
    );

    cameraPosition.copy(target).add(orbitOffset);
    camera.setPosition(cameraPosition);
    camera.lookAt(target);

    axesHelperRef.current?.updateCameraDistance(orbitDistance);
    notifyCameraChange();
    notifyOrbitChange();
  };

  const setOrbitDistance = (distance: number, options?: { immediate?: boolean }) => {
    targetOrbitDistance = Math.max(0.1, Math.min(500, distance));
    if (options?.immediate) {
      setImmediateOrbit();
    }
  };

  const adjustOrbitDistance = (delta: number) => {
    setOrbitDistance(targetOrbitDistance + delta);
  };

  const setOrbitAngles = (x: number, y: number, options?: { immediate?: boolean }) => {
    targetOrbitX = x;
    targetOrbitY = clampOrbitY(y);
    if (options?.immediate) {
      setImmediateOrbit();
    }
  };

  const panCamera = (deltaX: number, deltaY: number) => {
    const speed = orbitDistance * 0.0012;
    const world = camera.getWorldTransform();

    world.getX(panRight);
    world.getY(panUp);

    panRight.normalize().scale(-deltaX * speed);
    panUp.normalize().scale(deltaY * speed);

    targetTarget.add(panRight);
    targetTarget.add(panUp);
  };

  const alignTo = (direction: AlignDirection) => {
    switch (direction) {
      case 'px':
        setOrbitAngles(90, 0, { immediate: true });
        break;
      case 'nx':
        setOrbitAngles(-90, 0, { immediate: true });
        break;
      case 'py':
        setOrbitAngles(0, 90, { immediate: true });
        break;
      case 'ny':
        setOrbitAngles(0, -90, { immediate: true });
        break;
      case 'nz':
        setOrbitAngles(180, 0, { immediate: true });
        break;
      case 'pz':
      default:
        setOrbitAngles(0, 0, { immediate: true });
        break;
    }
  };

  const setTarget = (value: Vec3) => {
    target.set(value.x, value.y, value.z);
    targetTarget.set(value.x, value.y, value.z);
    updateCameraPosition();
  };

  const getTarget = () => ({ x: target.x, y: target.y, z: target.z });

  const getState = () => ({ orbitDistance, orbitX, orbitY });

  const onCameraChange = (callback: (axes: CameraAxes) => void) => {
    listeners.push(callback);
    return () => {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    };
  };

  const onOrbitStateChange = (
    callback: (state: { orbitDistance: number; orbitX: number; orbitY: number }) => void,
  ) => {
    orbitListeners.push(callback);
    return () => {
      const index = orbitListeners.indexOf(callback);
      if (index !== -1) {
        orbitListeners.splice(index, 1);
      }
    };
  };

  app.mouse.on(pc.EVENT_MOUSEDOWN, (event: any) => {
    if (!enabled || shouldBlockOrbit(event.event)) {
      return;
    }

    if (event.button === pc.MOUSEBUTTON_LEFT) {
      dragMode = 'orbit';
      lastMouseX = event.x;
      lastMouseY = event.y;
    } else if (event.button === pc.MOUSEBUTTON_RIGHT) {
      dragMode = 'pan';
      lastMouseX = event.x;
      lastMouseY = event.y;
      event.event?.preventDefault?.();
    }
  });

  app.mouse.on(pc.EVENT_MOUSEUP, () => {
    dragMode = null;
  });

  app.mouse.on(pc.EVENT_MOUSEMOVE, (event: any) => {
    if (!enabled || !dragMode) {
      return;
    }

    if (shouldBlockOrbit(event.event)) {
      dragMode = null;
      return;
    }

    const orbitSensitivity = 0.18;

    const deltaX = event.x - lastMouseX;
    const deltaY = event.y - lastMouseY;

    if (dragMode === 'orbit') {
      targetOrbitX -= deltaX * orbitSensitivity;
      targetOrbitY += deltaY * orbitSensitivity;
      targetOrbitY = clampOrbitY(targetOrbitY);
    } else if (dragMode === 'pan') {
      panCamera(deltaX, deltaY);
    }

    lastMouseX = event.x;
    lastMouseY = event.y;
  });

  app.mouse.on(pc.EVENT_MOUSEWHEEL, (event: any) => {
    if (!enabled || shouldBlockOrbit(event.event)) {
      return;
    }
    const zoomSensitivity = MOUSE_ZOOM_SENSITIVITY;
    setOrbitDistance(targetOrbitDistance - event.wheel * zoomSensitivity);
  });

  const handleUpdate = (deltaTime: number) => {
    // Using exponential smoothing for consistent behaviour across frame rates.
    const smoothingStrength = 4.5;
    const blend = 1 - Math.exp(-Math.max(deltaTime, 0.016) * smoothingStrength);
    let changed = false;

    if (Math.abs(targetOrbitX - orbitX) > 1e-4) {
      orbitX += (targetOrbitX - orbitX) * blend;
      changed = true;
    } else if (orbitX !== targetOrbitX) {
      orbitX = targetOrbitX;
      changed = true;
    }

    if (Math.abs(targetOrbitY - orbitY) > 1e-4) {
      orbitY += (targetOrbitY - orbitY) * blend;
      orbitY = clampOrbitY(orbitY);
      changed = true;
    } else if (orbitY !== targetOrbitY) {
      orbitY = targetOrbitY;
      changed = true;
    }

    if (Math.abs(targetOrbitDistance - orbitDistance) > 1e-4) {
      orbitDistance += (targetOrbitDistance - orbitDistance) * blend;
      changed = true;
    } else if (orbitDistance !== targetOrbitDistance) {
      orbitDistance = targetOrbitDistance;
      changed = true;
    }

    // Smooth pan interpolation
    const targetDx = targetTarget.x - target.x;
    const targetDy = targetTarget.y - target.y;
    const targetDz = targetTarget.z - target.z;

    if (Math.abs(targetDx) > 1e-4 || Math.abs(targetDy) > 1e-4 || Math.abs(targetDz) > 1e-4) {
      target.x += targetDx * blend;
      target.y += targetDy * blend;
      target.z += targetDz * blend;
      changed = true;
    } else if (targetDx !== 0 || targetDy !== 0 || targetDz !== 0) {
      target.copy(targetTarget);
      changed = true;
    }

    if (changed) {
      updateCameraPosition();
    }
  };

  app.on('update', handleUpdate);
  app.on('destroy', () => {
    app.off('update', handleUpdate);
  });

  setImmediateOrbit();

  return {
    getState,
    setOrbitDistance,
    setOrbitAngles,
    adjustOrbitDistance,
    alignTo,
    updateCameraPosition,
    onCameraChange,
    onOrbitStateChange,
    setTarget,
    getTarget,
    setEnabled: (value: boolean) => {
      enabled = value;
      if (!enabled) {
        dragMode = null;
      }
    },
  };
};

const initFirstPersonControls = (
  app: any,
  camera: any,
  pc: any,
  splatEntityRef: React.MutableRefObject<any>,
  hiddenPointsRef: React.MutableRefObject<Set<number>>,
  collisionEnabled: boolean,
  initialSpeed: number = 3.0,
  initialCameraHeight: number = 1.6,
  initialJumpHeight: number = 4.0,
  isGameMode: boolean = false,
  initialBulletSettings: BulletSettings = {
    speed: 30.0,
    size: 0.1,
    color: { r: 1, g: 0.8, b: 0.2 },
    gravity: 9.8,
    lifetime: 5.0,
    bounciness: 0.6,
  },
  initialGameModeSettings: GameModeSettings = {
    flyModeEnabled: false,
  },
) => {
  let enabled = true;
  let yaw = 0; // horizontal rotation (actual)
  let pitch = 0; // vertical rotation (actual)
  let targetYaw = 0; // target horizontal rotation (for smoothing)
  let targetPitch = 0; // target vertical rotation (for smoothing)
  let position = new pc.Vec3(0, initialCameraHeight, 5); // Start at camera height (eye level)

  let moveSpeed = initialSpeed; // units per second (can be changed dynamically)
  let cameraHeight = initialCameraHeight; // camera/eye height
  let jumpHeight = initialJumpHeight; // jump velocity
  let bulletSettings = { ...initialBulletSettings }; // bullet configuration
  let gameModeSettings = { ...initialGameModeSettings }; // game mode configuration
  let currentCollisionEnabled = collisionEnabled; // track current collision state
  const lookSensitivity = 0.15;
  const collisionRadius = 0.15; // collision sphere radius around player (reduced for closer detection)
  const gravity = -9.8; // gravity acceleration (m/s^2)
  const groundCheckDistance = 0.1; // distance to check for ground
  const groundSnapBuffer = 0.3; // additional allowance when detecting ground contact
  const groundPenetrationAllowance = 0.08; // tolerate slight overlap with ground splats
  const groundSearchDistance = 6; // maximum downward search distance when looking for ground
  const groundSearchExtraRadius = 1.0; // how far out to probe when rebasing to nearby ground
  const groundLowSnapThreshold = 0.4; // minimum drop before rebasing to lower ground
  const MIN_CAMERA_HEIGHT = 0.05;
  let velocityY = 0; // vertical velocity for gravity
  let isGrounded = false; // whether player is on ground
  let wasSpacePressed = false; // Track if Space key was pressed (to prevent continuous jumping)

  // Bullet system
  const bullets: Array<{
    entity: any;
    velocity: any;
    createdAt: number;
    bounceCount: number;
  }> = [];

  const keys: Record<string, boolean> = {};
  const moveDirection = new pc.Vec3();
  const forward = new pc.Vec3();
  const right = new pc.Vec3();
  const tempVec = new pc.Vec3();

  let pointerLocked = false;
  let pointerLockEnabled = true; // Can be disabled when waiting for spawn point selection

  // Create bullet entity
  const createBullet = (startPos: any, direction: any) => {
    const bulletEntity = new pc.Entity('bullet');
    bulletEntity.addComponent('render', {
      type: 'sphere',
      castShadows: true,
      receiveShadows: false,
    });

    // Create material for bullet
    const material = new pc.StandardMaterial();
    material.diffuse = new pc.Color(
      bulletSettings.color.r,
      bulletSettings.color.g,
      bulletSettings.color.b,
    );
    material.emissive = new pc.Color(
      bulletSettings.color.r * 0.5,
      bulletSettings.color.g * 0.5,
      bulletSettings.color.b * 0.5,
    );
    material.useMetalness = true;
    material.metalness = 0.3;
    material.glossiness = 0.8;
    material.update();

    bulletEntity.render.material = material;
    bulletEntity.setLocalScale(bulletSettings.size, bulletSettings.size, bulletSettings.size);
    bulletEntity.setPosition(startPos);

    app.root.addChild(bulletEntity);

    // Initial velocity
    const velocity = new pc.Vec3();
    velocity.copy(direction).normalize().scale(bulletSettings.speed);

    bullets.push({
      entity: bulletEntity,
      velocity: velocity,
      createdAt: Date.now(),
      bounceCount: 0,
    });

    return bulletEntity;
  };

  // Check bullet collision with splat points
  const checkBulletCollision = (bulletPos: any, bulletRadius: number) => {
    const splatEntity = splatEntityRef.current;
    if (!splatEntity?.gsplat?.instance) {
      return null;
    }

    const centers: Float32Array | undefined = splatEntity.gsplat.instance.sorter?.centers;
    if (!centers || centers.length === 0) {
      return null;
    }

    const transform = splatEntity.getWorldTransform().data;
    const hiddenSet = hiddenPointsRef.current;
    const radiusSq = bulletRadius * bulletRadius;

    let closestPoint = null;
    let closestDistSq = Infinity;

    // Check against visible points - find closest collision
    for (let i = 0; i < centers.length; i += 3) {
      const pointIndex = i / 3;
      if (hiddenSet.has(pointIndex)) {
        continue;
      }

      const lx = centers[i];
      const ly = centers[i + 1];
      const lz = centers[i + 2];

      // Transform to world space
      const wx = transform[0] * lx + transform[4] * ly + transform[8] * lz + transform[12];
      const wy = transform[1] * lx + transform[5] * ly + transform[9] * lz + transform[13];
      const wz = transform[2] * lx + transform[6] * ly + transform[10] * lz + transform[14];

      const dx = bulletPos.x - wx;
      const dy = bulletPos.y - wy;
      const dz = bulletPos.z - wz;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < radiusSq && distSq < closestDistSq) {
        closestDistSq = distSq;
        closestPoint = {
          position: new pc.Vec3(wx, wy, wz),
          normal: new pc.Vec3(dx, dy, dz).normalize(), // Normal pointing away from collision point
        };
      }
    }

    return closestPoint;
  };

  // Shoot bullet
  const shootBullet = () => {
    if (!isGameMode) return;

    // Calculate bullet spawn position (slightly in front of camera)
    const yawRad = (yaw * Math.PI) / 180;
    const pitchRad = (pitch * Math.PI) / 180;

    const direction = new pc.Vec3(
      Math.sin(yawRad) * Math.cos(pitchRad),
      Math.sin(pitchRad),
      Math.cos(yawRad) * Math.cos(pitchRad),
    );

    // Spawn bullet slightly in front of camera
    const spawnOffset = 0.5;
    const startPos = new pc.Vec3();
    startPos.copy(position).add(direction.clone().scale(spawnOffset));

    createBullet(startPos, direction);
  };

  // Mouse click handler for shooting
  const handleMouseClick = (event: MouseEvent) => {
    if (!enabled || !pointerLocked || !isGameMode) return;
    // Left click only
    if (event.button === 0) {
      shootBullet();
    }
  };

  // Keyboard event listeners
  const handleKeyDown = (event: KeyboardEvent) => {
    if (!enabled) return;
    keys[event.code] = true;
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    keys[event.code] = false;
    // Reset Space press flag when Space is released
    if (event.code === 'Space') {
      wasSpacePressed = false;
    }
  };

  // Update collision state based on game mode settings
  const updateCollisionState = () => {
    if (isGameMode) {
      currentCollisionEnabled = !gameModeSettings.flyModeEnabled;
    } else {
      currentCollisionEnabled = collisionEnabled;
    }
  };

  // Mouse movement for looking around
  const handleMouseMove = (event: MouseEvent) => {
    if (!enabled || !pointerLocked) return;

    targetYaw -= event.movementX * lookSensitivity;
    targetPitch -= event.movementY * lookSensitivity;

    // Clamp pitch to prevent camera flipping
    targetPitch = Math.max(-89, Math.min(89, targetPitch));
  };

  // Pointer lock handlers
  const handlePointerLockChange = () => {
    pointerLocked = document.pointerLockElement === app.graphicsDevice.canvas;
  };

  const requestPointerLock = () => {
    if (enabled && pointerLockEnabled) {
      app.graphicsDevice.canvas.requestPointerLock();
    }
  };

  // Check for ground beneath player (for gravity)
  const checkGround = (
    checkPosition: any,
  ): {
    isGrounded: boolean;
    groundHeight: number;
    nearestGroundHeight: number | null;
    lowestGroundHeight: number | null;
  } => {
    if (!currentCollisionEnabled) {
      return { isGrounded: false, groundHeight: 0, nearestGroundHeight: null, lowestGroundHeight: null };
    }

    const splatEntity = splatEntityRef.current;
    if (!splatEntity?.gsplat?.instance) {
      return { isGrounded: false, groundHeight: 0, nearestGroundHeight: null, lowestGroundHeight: null };
    }

    const centers: Float32Array | undefined = splatEntity.gsplat.instance.sorter?.centers;
    if (!centers || centers.length === 0) {
      return { isGrounded: false, groundHeight: 0, nearestGroundHeight: null, lowestGroundHeight: null };
    }

    const transform = splatEntity.getWorldTransform().data;
    const hiddenSet = hiddenPointsRef.current;
    const baseRadiusSq = collisionRadius * collisionRadius;
    const extendedRadius = collisionRadius + groundSearchExtraRadius;
    const extendedRadiusSq = extendedRadius * extendedRadius;
    const verticalCheckDistance = groundCheckDistance + groundSnapBuffer;
    const footHeight = checkPosition.y - cameraHeight;

    let maxGroundHeight = Number.NEGATIVE_INFINITY;
    let foundGround = false;
    let nearestGroundHeight: number | null = null;
    let nearestFootDelta = Number.POSITIVE_INFINITY;
    let lowestGroundHeight: number | null = null;

    // Check for points below the player within horizontal radius
    for (let i = 0; i < centers.length; i += 3) {
      const pointIndex = i / 3;
      if (hiddenSet.has(pointIndex)) {
        continue;
      }

      const lx = centers[i];
      const ly = centers[i + 1];
      const lz = centers[i + 2];

      // Transform to world space
      const wx = transform[0] * lx + transform[4] * ly + transform[8] * lz + transform[12];
      const wy = transform[1] * lx + transform[5] * ly + transform[9] * lz + transform[13];
      const wz = transform[2] * lx + transform[6] * ly + transform[10] * lz + transform[14];

      // Check if point is within horizontal radius
      const dx = checkPosition.x - wx;
      const dz = checkPosition.z - wz;
      const horizontalDistSq = dx * dx + dz * dz;
      const footDelta = footHeight - wy;

      if (horizontalDistSq <= baseRadiusSq) {
        if (footDelta >= -groundPenetrationAllowance && footDelta <= verticalCheckDistance) {
          foundGround = true;
          maxGroundHeight = Math.max(maxGroundHeight, wy);
        }
      }

      if (horizontalDistSq > extendedRadiusSq) {
        continue;
      }

      if (footDelta < -groundPenetrationAllowance || footDelta > groundSearchDistance) {
        continue;
      }

      if (footDelta < nearestFootDelta) {
        nearestFootDelta = footDelta;
        nearestGroundHeight = wy;
      }

      if (lowestGroundHeight == null || wy < lowestGroundHeight) {
        lowestGroundHeight = wy;
      }
    }

    if (!foundGround) {
      return {
        isGrounded: false,
        groundHeight: nearestGroundHeight ?? 0,
        nearestGroundHeight,
        lowestGroundHeight,
      };
    }

    return {
      isGrounded: true,
      groundHeight: maxGroundHeight,
      nearestGroundHeight,
      lowestGroundHeight,
    };
  };

  // Collision detection (horizontal and full 3D)
  const checkCollision = (newPosition: any) => {
    if (!collisionEnabled) {
      return false;
    }

    const splatEntity = splatEntityRef.current;
    if (!splatEntity?.gsplat?.instance) {
      return false;
    }

    const centers: Float32Array | undefined = splatEntity.gsplat.instance.sorter?.centers;
    if (!centers || centers.length === 0) {
      return false;
    }

    const transform = splatEntity.getWorldTransform().data;
    const hiddenSet = hiddenPointsRef.current;
    const radiusSq = collisionRadius * collisionRadius;

    // Check against visible points
    for (let i = 0; i < centers.length; i += 3) {
      const pointIndex = i / 3;
      if (hiddenSet.has(pointIndex)) {
        continue;
      }

      const lx = centers[i];
      const ly = centers[i + 1];
      const lz = centers[i + 2];

      // Transform to world space
      const wx = transform[0] * lx + transform[4] * ly + transform[8] * lz + transform[12];
      const wy = transform[1] * lx + transform[5] * ly + transform[9] * lz + transform[13];
      const wz = transform[2] * lx + transform[6] * ly + transform[10] * lz + transform[14];

      const dx = newPosition.x - wx;
      const dy = newPosition.y - wy;
      const dz = newPosition.z - wz;
      const distSq = dx * dx + dy * dy + dz * dz;

      if (distSq < radiusSq) {
        return true; // Collision detected
      }
    }

    return false;
  };

  const updateCameraTransform = () => {
    const yawRad = (yaw * Math.PI) / 180;
    const pitchRad = (pitch * Math.PI) / 180;

    // Calculate forward direction
    forward.set(
      Math.sin(yawRad) * Math.cos(pitchRad),
      Math.sin(pitchRad),
      Math.cos(yawRad) * Math.cos(pitchRad),
    );

    // Calculate right direction
    right.set(Math.cos(yawRad), 0, -Math.sin(yawRad));

    // Update camera position and look target
    camera.setPosition(position);
    tempVec.copy(position).add(forward);
    camera.lookAt(tempVec);
  };

  const handleUpdate = (deltaTime: number) => {
    if (!enabled) return;

    // Update collision state based on current game mode settings
    updateCollisionState();

    // Smooth camera rotation using exponential smoothing
    const smoothingStrength = 12.0; // Higher value = smoother rotation
    const dt = Math.min(deltaTime, 0.1); // Cap delta time
    const blend = 1 - Math.exp(-dt * smoothingStrength);

    // Update bullets
    const now = Date.now();
    for (let i = bullets.length - 1; i >= 0; i--) {
      const bullet = bullets[i];
      const age = (now - bullet.createdAt) / 1000; // age in seconds

      // Remove bullet if it's too old
      if (age > bulletSettings.lifetime) {
        bullet.entity.destroy();
        bullets.splice(i, 1);
        continue;
      }

      // Apply gravity
      bullet.velocity.y -= bulletSettings.gravity * dt;

      // Calculate next position
      const movement = new pc.Vec3();
      movement.copy(bullet.velocity).scale(dt);
      const currentPos = bullet.entity.getPosition();
      const newPos = currentPos.clone().add(movement);

      // Check collision with splat points
      const bulletRadius = bulletSettings.size + 0.05; // Add small margin
      const collision = checkBulletCollision(newPos, bulletRadius);

      if (collision && bulletSettings.bounciness > 0) {
        // Collision with splat - bounce
        const normal = collision.normal;

        // Reflect velocity around normal
        const dotProduct = bullet.velocity.dot(normal);
        const reflection = new pc.Vec3();
        reflection.copy(normal).scale(2 * dotProduct);
        bullet.velocity.sub(reflection);

        // Apply bounciness (energy loss)
        bullet.velocity.scale(bulletSettings.bounciness);

        // Position bullet at collision point + small offset
        const offset = normal.clone().scale(bulletRadius);
        bullet.entity.setPosition(collision.position.clone().add(offset));

        bullet.bounceCount++;
        continue;
      } else if (collision) {
        // No bounce - stop at collision
        bullet.entity.setPosition(collision.position);
        bullet.velocity.set(0, 0, 0);
        continue;
      }

      // Check collision with ground (y <= 0)
      if (newPos.y <= 0 && bulletSettings.bounciness > 0) {
        // Bounce off ground
        newPos.y = 0;
        bullet.entity.setPosition(newPos);

        // Reverse Y velocity with bounciness
        bullet.velocity.y = -bullet.velocity.y * bulletSettings.bounciness;

        // Apply some friction on horizontal velocity
        bullet.velocity.x *= 0.95;
        bullet.velocity.z *= 0.95;

        bullet.bounceCount++;

        // Stop if velocity is too low after bounce
        if (Math.abs(bullet.velocity.y) < 0.1 && bullet.velocity.length() < 0.2) {
          bullet.velocity.set(0, 0, 0);
        }
        continue;
      } else if (newPos.y <= 0) {
        // No bounce - stop at ground
        newPos.y = 0;
        bullet.entity.setPosition(newPos);
        bullet.velocity.set(0, 0, 0);
        continue;
      }

      // No collision - update position normally
      bullet.entity.setPosition(newPos);
    }

    let rotationChanged = false;

    // Smooth yaw interpolation
    if (Math.abs(targetYaw - yaw) > 0.01) {
      yaw += (targetYaw - yaw) * blend;
      rotationChanged = true;
    } else if (yaw !== targetYaw) {
      yaw = targetYaw;
      rotationChanged = true;
    }

    // Smooth pitch interpolation
    if (Math.abs(targetPitch - pitch) > 0.01) {
      pitch += (targetPitch - pitch) * blend;
      pitch = Math.max(-89, Math.min(89, pitch));
      rotationChanged = true;
    } else if (pitch !== targetPitch) {
      pitch = targetPitch;
      rotationChanged = true;
    }

    // Update camera if rotation changed
    if (rotationChanged) {
      updateCameraTransform();
    }

    // Reset move direction
    moveDirection.set(0, 0, 0);

    // WASD or Arrow keys for horizontal movement
    if (keys['KeyW'] || keys['ArrowUp']) {
      moveDirection.x += forward.x;
      moveDirection.z += forward.z;
    }
    if (keys['KeyS'] || keys['ArrowDown']) {
      moveDirection.x -= forward.x;
      moveDirection.z -= forward.z;
    }
    if (keys['KeyA'] || keys['ArrowLeft']) {
      // A = left
      moveDirection.x += right.x;
      moveDirection.z += right.z;
    }
    if (keys['KeyD'] || keys['ArrowRight']) {
      // D = right
      moveDirection.x -= right.x;
      moveDirection.z -= right.z;
    }

    // Check ground FIRST (before jump logic) for Walk mode
    if (collisionEnabled) {
      const groundCheck = checkGround(position);
      isGrounded = groundCheck.isGrounded;

      if (isGrounded) {
        // Only snap to ground if NOT jumping upward (prevents jitter during jump start)
        if (velocityY <= 0) {
          // On ground and falling/stationary - snap to ground
          position.y = groundCheck.groundHeight + cameraHeight;
          velocityY = 0;
        }
        // If velocityY > 0, player is jumping up - don't snap to ground
      }
    }

    // Vertical movement - AFTER ground check
    if (collisionEnabled) {
      // Walk/Game mode: Jump with Space (only if grounded AND Space wasn't already pressed)
      if (keys['Space'] && isGrounded && !wasSpacePressed) {
        // Use jump height directly
        velocityY = jumpHeight;
        wasSpacePressed = true; // Mark Space as pressed - prevents continuous jumping
      }
    } else {
      // Fly mode: E/Q for up/down
      if (keys['KeyE']) {
        moveDirection.y += 1;
      }
      if (keys['KeyQ']) {
        moveDirection.y -= 1;
      }
    }

    // Normalize horizontal movement to prevent faster diagonal movement
    const horizontalLength = Math.sqrt(moveDirection.x * moveDirection.x + moveDirection.z * moveDirection.z);
    if (horizontalLength > 0) {
      moveDirection.x /= horizontalLength;
      moveDirection.z /= horizontalLength;
    }

    // Apply movement speed to horizontal movement
    moveDirection.scale(moveSpeed * dt);

    // Apply gravity for Walk mode
    if (collisionEnabled) {
      if (!isGrounded) {
        // In air - apply gravity
        velocityY += gravity * dt;
      }

      // Apply vertical velocity
      moveDirection.y = velocityY * dt;
    }

    // Try to move
    const totalMovement = moveDirection.length();
    if (totalMovement > 0 || (collisionEnabled && !isGrounded)) {
      const newPosition = new pc.Vec3().copy(position).add(moveDirection);

      // Check collision
      const hasCollision = checkCollision(newPosition);

      if (!hasCollision) {
        position.copy(newPosition);
        updateCameraTransform();
      } else if (collisionEnabled) {
        // Try to move horizontally only (slide along walls)
        const horizontalMove = new pc.Vec3(moveDirection.x, 0, moveDirection.z);
        if (horizontalMove.length() > 0) {
          const horizontalNewPos = new pc.Vec3().copy(position).add(horizontalMove);
          if (!checkCollision(horizontalNewPos)) {
            position.copy(horizontalNewPos);
            updateCameraTransform();
          }
        }
        // Still apply gravity/vertical movement
        if (moveDirection.y !== 0) {
          const verticalMove = new pc.Vec3(0, moveDirection.y, 0);
          const verticalNewPos = new pc.Vec3().copy(position).add(verticalMove);
          if (!checkCollision(verticalNewPos)) {
            position.copy(verticalNewPos);
            updateCameraTransform();
          } else {
            // Hit ceiling or floor
            velocityY = 0;
          }
        }
      }
    }
  };

  // Register event listeners
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('mousemove', handleMouseMove);
  window.addEventListener('mousedown', handleMouseClick);
  document.addEventListener('pointerlockchange', handlePointerLockChange);
  app.graphicsDevice.canvas.addEventListener('click', requestPointerLock);

  app.on('update', handleUpdate);

  // Initialize camera transform
  updateCameraTransform();

  return {
    getPosition: () => ({ x: position.x, y: position.y, z: position.z }),
    getRotation: () => ({ yaw, pitch }),
    setPosition: (pos: Vec3) => {
      position.set(pos.x, pos.y, pos.z);
      updateCameraTransform();
    },
    setRotation: (newYaw: number, newPitch: number) => {
      yaw = newYaw;
      targetYaw = newYaw;
      pitch = Math.max(-89, Math.min(89, newPitch));
      targetPitch = pitch;
      updateCameraTransform();
    },
    setMoveSpeed: (speed: number) => {
      moveSpeed = Math.max(0.1, Math.min(20, speed));
    },
    setCameraHeight: (height: number) => {
      const clamped = Math.max(MIN_CAMERA_HEIGHT, Math.min(3.0, height));
      if (Math.abs(clamped - cameraHeight) < 1e-4) {
        return cameraHeight;
      }

      const previousHeight = cameraHeight;
      const previousPositionY = position.y;
      const footBaseline = position.y - cameraHeight;
      const decreasedHeight = clamped < previousHeight - 1e-4;

      cameraHeight = clamped;
      position.y = footBaseline + cameraHeight;

      if (collisionEnabled) {
        if (checkCollision(position)) {
          cameraHeight = previousHeight;
          position.y = previousPositionY;
          return cameraHeight;
        }

        if (velocityY <= 0) {
          const groundInfo = checkGround(position);
          if (groundInfo.isGrounded) {
            position.y = groundInfo.groundHeight + cameraHeight;
            velocityY = 0;
          } else if (decreasedHeight && groundInfo.nearestGroundHeight != null) {
            const originalY = position.y;
            position.y = groundInfo.nearestGroundHeight + cameraHeight;
            if (checkCollision(position)) {
              position.y = originalY;
            } else {
              velocityY = 0;
            }
          }

          if (
            decreasedHeight &&
            clamped <= MIN_CAMERA_HEIGHT + 1e-3 &&
            groundInfo.lowestGroundHeight != null
          ) {
            const currentFoot = position.y - cameraHeight;
            const dropAmount = currentFoot - groundInfo.lowestGroundHeight;
            if (dropAmount > groundLowSnapThreshold) {
              const originalY = position.y;
              position.y = groundInfo.lowestGroundHeight + cameraHeight;
              if (checkCollision(position)) {
                position.y = originalY;
              } else {
                velocityY = 0;
              }
            }
          }
        }
      }

      updateCameraTransform();
      return cameraHeight;
    },
    setJumpHeight: (height: number) => {
      jumpHeight = Math.max(1.0, Math.min(15.0, height));
    },
    updateBulletSettings: (settings: BulletSettings) => {
      bulletSettings = { ...settings };
    },
    updateGameModeSettings: (settings: GameModeSettings) => {
      gameModeSettings = { ...settings };
      updateCollisionState();
    },
    setEnabled: (value: boolean) => {
      enabled = value;
      if (!enabled && pointerLocked) {
        document.exitPointerLock();
      }
    },
    setPointerLockEnabled: (value: boolean) => {
      pointerLockEnabled = value;
      if (!value && pointerLocked) {
        document.exitPointerLock();
      }
    },
    destroy: () => {
      // Cleanup all bullets
      bullets.forEach((bullet) => {
        if (bullet.entity) {
          bullet.entity.destroy();
        }
      });
      bullets.length = 0;

      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseClick);
      document.removeEventListener('pointerlockchange', handlePointerLockChange);
      app.graphicsDevice.canvas.removeEventListener('click', requestPointerLock);
      app.off('update', handleUpdate);
      if (pointerLocked) {
        document.exitPointerLock();
      }
    },
  };
};

const loadGaussianSplat = async ({
  app,
  pc,
  url,
  controls,
  splatEntityRef,
  groundHelperRef,
  axesHelperRef,
  setSplatCount,
  initialTargetRef,
  initialDistanceRef,
  onResourceReady,
}: {
  app: any;
  pc: any;
  url: string;
  controls: OrbitControlsHandle;
  splatEntityRef: MutableRefObject<any>;
  groundHelperRef: MutableRefObject<GroundHelperHandle | null>;
  axesHelperRef: MutableRefObject<AxesHelperHandle | null>;
  setSplatCount: (count: number | null) => void;
  initialTargetRef: MutableRefObject<Vec3>;
  initialDistanceRef: MutableRefObject<number>;
  onResourceReady?: (payload: { count: number; resource: any }) => void;
}) => {
  const splatAsset = new pc.Asset('gaussian-splats', 'gsplat', { url });
  app.assets.add(splatAsset);

  await new Promise<void>((resolve, reject) => {
    splatAsset.on('load', (asset: any) => {
      const entity = new pc.Entity('gaussian-splats');
      entity.addComponent('gsplat', {
        asset: asset,
      });
      entity.setLocalScale(-1, 1, -1);
      app.root.addChild(entity);

      splatEntityRef.current = entity;

      const resource = asset.resource;
      if (resource) {
        const count = resource.numSplats || 0;
        setSplatCount(count);
        if (typeof onResourceReady === 'function') {
          try {
            onResourceReady({ count, resource });
          } catch (callbackError) {
            console.error('Error executing onResourceReady callback', callbackError);
          }
        }

        if (resource.aabb) {
          const aabb = resource.aabb;
          const size = aabb.halfExtents.length();
          const center = aabb.center;
          const distance = Math.max(size * 2, DEFAULT_ORBIT_DISTANCE);

          const target = { x: center.x, y: center.y, z: center.z };
          initialTargetRef.current = target;
          initialDistanceRef.current = distance;

          controls.setTarget(target);
          controls.setOrbitDistance(distance, { immediate: true });

          const helperSize = Math.max(size, 1);
          groundHelperRef.current?.updateSize(helperSize);
          axesHelperRef.current?.updateSceneScale(helperSize);
        } else {
          initialTargetRef.current = { x: 0, y: 0, z: 0 };
          initialDistanceRef.current = DEFAULT_ORBIT_DISTANCE;
          controls.setTarget(initialTargetRef.current);
          controls.setOrbitDistance(DEFAULT_ORBIT_DISTANCE, { immediate: true });
          groundHelperRef.current?.updateSize(5);
          axesHelperRef.current?.updateSceneScale(5);
        }
      }

      controls.updateCameraPosition();

      resolve();
    });

    splatAsset.on('error', (err: any) => {
      reject(new Error(`Failed to load Gaussian Splats: ${err}`));
    });

    app.assets.load(splatAsset);
  });
};
