import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { Vec3, ScreenProjection, CameraAxes, PointPickResult } from '../useSplatScene';

export type SnapAxis = 'x' | 'y' | 'z';

export const SNAP_AXIS_CONFIG: Record<SnapAxis, { color: string; label: string; shortLabel: string }> = {
  x: { color: '#ef4444', label: 'แกน X', shortLabel: 'X' },
  y: { color: '#22c55e', label: 'แกน Y', shortLabel: 'Y' },
  z: { color: '#3b82f6', label: 'แกน Z', shortLabel: 'Z' },
};

export const AXIS_ORDER: SnapAxis[] = ['x', 'y', 'z'];

const AXIS_VECTORS: Record<SnapAxis, Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
};

const MIN_SNAP_DELTA = 1e-3;
const AXIS_SNAP_MAX_PERP_RATIO = 0.12;
const CAMERA_DRAG_THRESHOLD_PX = 2;

const pointerButtonsFromButton = (button: number): number => {
  switch (button) {
    case 0:
      return 1;
    case 1:
      return 4;
    case 2:
      return 2;
    default:
      return button >= 0 ? 1 << button : 0;
  }
};

type IndexedLocalPoint = {
  local: Vec3;
  nodeIndex: number | null;
};

type MeasurementSharedNode = {
  id: string;
  local: Vec3;
  nodeIndex: number | null;
};

export type MeasureMode = 'distance' | 'area';

export type MeasurementSegment = {
  id: string;
  startLocal: Vec3;
  endLocal: Vec3;
  axis: SnapAxis | null;
  startNodeIndex: number | null;
  endNodeIndex: number | null;
  startSharedNodeId: string | null;
  endSharedNodeId: string | null;
};

export type AreaPolygon = {
  id: string;
  pointsLocal: Vec3[];
  pointNodeIndices: Array<number | null>;
};

type PersistedMeasurementSegment = {
  id: string;
  startLocal: Vec3;
  endLocal: Vec3;
  axis: SnapAxis | null;
  startNodeIndex: number | null;
  endNodeIndex: number | null;
  startSharedNodeId: string | null;
  endSharedNodeId: string | null;
};

type PersistedMeasurementState = {
  version: 1;
  scale: number;
  nodes: Record<string, { local: Vec3; nodeIndex: number | null }>;
  measurements: PersistedMeasurementSegment[];
  areas?: AreaPolygon[];
  measurementCounter?: number;
  nodeCounter?: number;
  areaCounter?: number;
};

const parseIdSuffix = (value: unknown, prefix: string): number | null => {
  if (typeof value !== 'string' || !value.startsWith(prefix)) {
    return null;
  }
  const parsed = Number.parseInt(value.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const sanitizeVec3 = (value: unknown): Vec3 => {
  if (!value || typeof value !== 'object') {
    return { x: 0, y: 0, z: 0 };
  }
  const candidate = value as Partial<Vec3>;
  const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? candidate.x : 0;
  const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? candidate.y : 0;
  const z = typeof candidate.z === 'number' && Number.isFinite(candidate.z) ? candidate.z : 0;
  return { x, y, z };
};

const sanitizeNodeIndex = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export type MeasurementScreenDatum = {
  id: string;
  startView: { x: number; y: number };
  endView: { x: number; y: number };
  label: string;
  midPoint: { x: number; y: number };
  isSelected: boolean;
  axis: SnapAxis | null;
  axisComponents: AxisComponentSummary;
};

export type AreaScreenDatum = {
  id: string;
  path: Array<{ x: number; y: number }>;
  centroid: { x: number; y: number };
  label: string;
  isSelected: boolean;
  vertices?: Array<{
    index: number;
    x: number;
    y: number;
    nodeId: string | null;
  }>;
  perimeterLabel?: string | null;
};

export type AreaPreviewScreen = {
  path: Array<{ x: number; y: number }>;
  centroid: { x: number; y: number };
  label: string | null;
  perimeterLabel?: string | null;
};

const VIEWBOX_SIZE = 100;

const toViewBox = (projection: ScreenProjection): { x: number; y: number } => ({
  x: projection.nx * VIEWBOX_SIZE,
  y: projection.ny * VIEWBOX_SIZE,
});

const distanceBetween = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

const computePolygonArea = (points: Vec3[]) => {
  if (points.length < 3) {
    return 0;
  }

  let crossX = 0;
  let crossY = 0;
  let crossZ = 0;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    crossX += current.y * next.z - current.z * next.y;
    crossY += current.z * next.x - current.x * next.z;
    crossZ += current.x * next.y - current.y * next.x;
  }

  const areaVectorLength = Math.sqrt(crossX * crossX + crossY * crossY + crossZ * crossZ);
  return 0.5 * areaVectorLength;
};

const computePolygonPerimeter = (points: Vec3[]) => {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    total += distanceBetween(current, next);
  }

  return total;
};

const formatDistance = (distance: number) => {
  if (distance >= 100) {
    return `${distance.toFixed(1)} m`;
  }
  if (distance >= 10) {
    return `${distance.toFixed(2)} m`;
  }
  return `${distance.toFixed(3)} m`;
};

const formatArea = (area: number) => {
  if (area >= 1000) {
    return `${area.toFixed(0)} m²`;
  }
  if (area >= 100) {
    return `${area.toFixed(1)} m²`;
  }
  return `${area.toFixed(2)} m²`;
};

const formatMetersCentimeters = (distance: number) => {
  const meters = Math.floor(distance);
  let centimeters = Math.round((distance - meters) * 100);
  let adjustedMeters = meters;
  if (centimeters === 100) {
    adjustedMeters += 1;
    centimeters = 0;
  }
  const cmText = centimeters.toString().padStart(2, '0');
  return `${adjustedMeters} m ${cmText} cm`;
};

const formatAxisComponent = (value: number) => {
  const absValue = Math.abs(value);
  let precision = 3;
  if (absValue >= 100) {
    precision = 1;
  } else if (absValue >= 10) {
    precision = 2;
  }
  if (!Number.isFinite(absValue) || absValue < 1e-6) {
    return '0.000 m';
  }
  const sign = value > 0 ? '+' : '-';
  return `${sign}${absValue.toFixed(precision)} m`;
};

export type AxisComponentSummary = {
  values: Vec3;
  formatted: Record<SnapAxis, string>;
};

const computeAxisComponents = (start: Vec3, end: Vec3, scale: number): AxisComponentSummary => {
  const dx = (end.x - start.x) * scale;
  const dy = (end.y - start.y) * scale;
  const dz = (end.z - start.z) * scale;
  return {
    values: { x: dx, y: dy, z: dz },
    formatted: {
      x: formatAxisComponent(dx),
      y: formatAxisComponent(dy),
      z: formatAxisComponent(dz),
    },
  };
};

const detectSnapAxis = (origin: Vec3, target: Vec3): SnapAxis | null => {
  const delta: Vec3 = {
    x: target.x - origin.x,
    y: target.y - origin.y,
    z: target.z - origin.z,
  };

  const lengthSq = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
  if (lengthSq <= MIN_SNAP_DELTA * MIN_SNAP_DELTA) {
    return null;
  }

  const length = Math.sqrt(lengthSq);

  let bestAxis: SnapAxis | null = null;
  let bestRatio = Number.POSITIVE_INFINITY;

  for (const axis of AXIS_ORDER) {
    const component = delta[axis];
    const perpSq = lengthSq - component * component;
    const perp = Math.sqrt(Math.max(perpSq, 0));
    const ratio = perp / length;

    if (ratio < bestRatio) {
      bestRatio = ratio;
      bestAxis = axis;
    }
  }

  if (!bestAxis || bestRatio > AXIS_SNAP_MAX_PERP_RATIO) {
    return null;
  }

  return bestAxis;
};

const trySnapToAxis = (origin: Vec3, target: Vec3): { point: Vec3; axis: SnapAxis } | null => {
  const axis = detectSnapAxis(origin, target);
  if (!axis) {
    return null;
  }

  const snapped: Vec3 = { x: origin.x, y: origin.y, z: origin.z };
  snapped[axis] = target[axis];

  return { point: snapped, axis };
};

type PointerHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
};

export interface MeasurementOverlayState {
  measurementScreenData: MeasurementScreenDatum[];
  areaScreenData: AreaScreenDatum[];
  areaPreview?: AreaPreviewScreen | null;
  axisGuides: Array<{
    axis: SnapAxis;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    active: boolean;
  }>;
  baseProjection: ScreenProjection | null;
  previewProjection: ScreenProjection | null;
  previewLabel: string | null;
  previewAxisComponents: AxisComponentSummary | null;
  activeAxisLabel: string | null;
  pointerHandlers: PointerHandlers;
  handleStartDrag: (event: ReactPointerEvent, measurementId: string, handle: 'start' | 'end') => void;
  handleStartAreaVertex?: (
    event: ReactPointerEvent<SVGCircleElement>,
    areaId: string,
    vertexIndex: number,
    nodeId: string | null,
  ) => void;
  isOverlayInteractive: boolean;
}

export interface RescaleDialogState {
  open: boolean;
  metersInput: string;
  centimetersInput: string;
  setMetersInput: (value: string) => void;
  setCentimetersInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}

export interface MeasurementTools {
  mode: MeasureMode | null;
  isDistanceMode: boolean;
  isAreaMode: boolean;
  toggleDistanceMode: () => void;
  toggleAreaMode: () => void;
  clearAll: () => void;
  overlayState: MeasurementOverlayState;
  message: string | null;
  messageOffsetWithPanel: boolean;
  setMessage: (message: string | null, options?: { persistent?: boolean }) => void;
  selectedDistanceLabel: string | null;
  selectedDistanceChainLabel: string | null;
  selectedDistanceId: string | null;
  selectedAxisComponents: AxisComponentSummary | null;
  selectedMeasurementSegment: MeasurementSegment | null;
  selectedAreaLabel: string | null;
  selectedAreaPerimeterLabel: string | null;
  selectedAreaId: string | null;
  selectDistance: (id: string) => void;
  selectArea: (id: string) => void;
  handleDeleteMeasurement: (id: string) => void;
  handleDeleteArea: (id: string) => void;
  openRescaleDialog: () => void;
  rescaleDialog: RescaleDialogState;
}

interface UseMeasurementToolsOptions {
  pickWorldPoint: (canvasX: number, canvasY: number) => Vec3 | null;
  pickPoint?: (canvasX: number, canvasY: number) => PointPickResult | null;
  projectWorldToScreen: (position: Vec3) => ScreenProjection | null;
  cameraAxes: CameraAxes | null;
  worldToModel: (world: Vec3) => Vec3 | null;
  modelToWorld: (local: Vec3) => Vec3 | null;
  getPointWorldPosition?: (index: number) => Vec3 | null;
  getPointLocalPosition?: (index: number) => Vec3 | null;
  storageKey?: string | null;
}

export function useMeasurementTools({
  pickWorldPoint,
  pickPoint,
  projectWorldToScreen,
  cameraAxes,
  worldToModel,
  modelToWorld,
  getPointWorldPosition,
  getPointLocalPosition: _getPointLocalPosition,
  storageKey,
}: UseMeasurementToolsOptions): MeasurementTools {
  const [mode, setMode] = useState<MeasureMode | null>(null);
  const [measurementPoints, setMeasurementPoints] = useState<IndexedLocalPoint[]>([]);
  const measurementIdRef = useRef(0);
  const nodeIdRef = useRef(0);
  const [measurementNodes, setMeasurementNodes] = useState<Record<string, MeasurementSharedNode>>({});
  const [activeSharedNodeId, setActiveSharedNodeId] = useState<string | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementSegment[]>([]);
  const areaIdRef = useRef(0);
  const [areaPoints, setAreaPoints] = useState<IndexedLocalPoint[]>([]);
  const [areaPolygons, setAreaPolygons] = useState<AreaPolygon[]>([]);
  const [previewPoint, setPreviewPoint] = useState<IndexedLocalPoint | null>(null);
  const [measurementScale, setMeasurementScale] = useState(1);
  const [selectedElement, setSelectedElement] = useState<{ type: 'distance'; id: string } | { type: 'area'; id: string } | null>(null);
  const [message, setMessageState] = useState<string | null>(null);
  const [messagePersistent, setMessagePersistent] = useState(false);
  const [rescaleDialogOpen, setRescaleDialogOpen] = useState(false);
  const [rescaleMetersInput, setRescaleMetersInput] = useState('');
  const [rescaleCentimetersInput, setRescaleCentimetersInput] = useState('');
  const previewSnapAxisRef = useRef<SnapAxis | null>(null);
  const draggingHandleRef = useRef<{
    measurementId: string;
    target: 'start' | 'end';
    nodeId: string | null;
    pointerId: number;
  } | null>(null);
  const areaVertexDragRef = useRef<{ areaId: string; vertexIndex: number; pointerId: number } | null>(null);
  const pendingPointerRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    overlay: HTMLDivElement | null;
    pointerInit: PointerEventInit;
  } | null>(null);
  const cameraForwardRef = useRef<{
    pointerId: number | null;
   target: HTMLElement | null;
   pointerType: string | null;
  }>({
    pointerId: null,
    target: null,
    pointerType: null,
  });
  const hasRestoredRef = useRef(false);
  const persistErrorRef = useRef(false);
  const resetCameraForwarding = useCallback(() => {
    cameraForwardRef.current = {
      pointerId: null,
      target: null,
      pointerType: null,
    };
  }, []);
  const makePointerEventInit = useCallback((native: PointerEvent, overrides?: Partial<PointerEventInit>): PointerEventInit => {
    const base: PointerEventInit = {
      pointerId: native.pointerId,
      pointerType: native.pointerType,
      button: native.button,
      buttons: native.buttons,
      clientX: native.clientX,
      clientY: native.clientY,
      ctrlKey: native.ctrlKey,
      shiftKey: native.shiftKey,
      altKey: native.altKey,
      metaKey: native.metaKey,
      pressure: native.pressure,
      width: native.width,
      height: native.height,
      tiltX: native.tiltX,
      tiltY: native.tiltY,
      isPrimary: native.isPrimary,
    };
    return overrides ? { ...base, ...overrides } : base;
  }, []);

  const dispatchPointerAndMouse = useCallback(
    (target: HTMLElement, type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', init: PointerEventInit, pointerTypeHint: string | null) => {
      const pointerEvent = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      const resolvedPointerType = pointerEvent.pointerType || pointerTypeHint || init.pointerType || 'mouse';
      cameraForwardRef.current.pointerType = resolvedPointerType;
      target.dispatchEvent(pointerEvent);

      if (resolvedPointerType === 'mouse') {
        let mouseType: 'mousedown' | 'mousemove' | 'mouseup' | null = null;
        switch (type) {
          case 'pointerdown':
            mouseType = 'mousedown';
            break;
          case 'pointermove':
            mouseType = 'mousemove';
            break;
          case 'pointerup':
            mouseType = 'mouseup';
            break;
          default:
            mouseType = null;
        }
        if (mouseType) {
          const mouseEvent = new MouseEvent(mouseType, {
            bubbles: true,
            cancelable: true,
            button: init.button ?? 0,
            buttons: init.buttons ?? 0,
            clientX: init.clientX ?? 0,
            clientY: init.clientY ?? 0,
            ctrlKey: init.ctrlKey ?? false,
            shiftKey: init.shiftKey ?? false,
            altKey: init.altKey ?? false,
            metaKey: init.metaKey ?? false,
          });
          target.dispatchEvent(mouseEvent);
        }
      }
    },
    [],
  );

  const startCameraForwarding = useCallback(
    (overlay: HTMLDivElement | null, pointerInit: PointerEventInit) => {
      if (!overlay) {
        return;
      }

      const pointerId = typeof pointerInit.pointerId === 'number' ? pointerInit.pointerId : null;
      const pointerType = typeof pointerInit.pointerType === 'string' ? pointerInit.pointerType : null;
      const clientX = pointerInit.clientX ?? 0;
      const clientY = pointerInit.clientY ?? 0;
      let underlying = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (!underlying || underlying === overlay) {
        const previousSibling = overlay.previousElementSibling;
        if (previousSibling instanceof HTMLCanvasElement) {
          underlying = previousSibling;
        } else {
          const fallbackCanvas = overlay.parentElement?.querySelector('canvas');
          underlying = (fallbackCanvas as HTMLElement | null) ?? underlying;
        }
      }

      if (underlying && underlying !== overlay) {
        cameraForwardRef.current = {
          target: underlying,
          pointerId,
          pointerType,
        };
        dispatchPointerAndMouse(underlying, 'pointerdown', pointerInit, pointerType ?? null);
      } else {
        cameraForwardRef.current = {
          target: underlying,
          pointerId,
          pointerType,
        };
      }
      pendingPointerRef.current = null;
    },
    [dispatchPointerAndMouse],
  );

  const continueCameraForwarding = useCallback(
    (nativeEvent: PointerEvent) => {
      const { target, pointerId, pointerType } = cameraForwardRef.current;
      if (!target) {
        return false;
      }
      if (pointerId !== null && pointerId !== nativeEvent.pointerId) {
        return false;
      }
      const init = makePointerEventInit(nativeEvent);
      dispatchPointerAndMouse(target, 'pointermove', init, pointerType);
      return true;
    },
    [dispatchPointerAndMouse, makePointerEventInit],
  );
  const toLocal = useCallback(
    (world: Vec3 | null): Vec3 | null => {
      if (!world) {
        return null;
      }
      const converted = worldToModel(world);
      if (!converted) {
        return null;
      }
      return { x: converted.x, y: converted.y, z: converted.z };
    },
    [worldToModel],
  );

  const toWorld = useCallback(
    (local: Vec3 | null): Vec3 | null => {
      if (!local) {
        return null;
      }
      const converted = modelToWorld(local);
      if (!converted) {
        return null;
      }
      return { x: converted.x, y: converted.y, z: converted.z };
    },
    [modelToWorld],
  );

  const registerSharedNode = useCallback(
    (anchor: IndexedLocalPoint, existingId?: string | null): MeasurementSharedNode => {
      const nodeId = existingId ?? `n-${nodeIdRef.current++}`;
      const stored: MeasurementSharedNode = {
        id: nodeId,
        local: { x: anchor.local.x, y: anchor.local.y, z: anchor.local.z },
        nodeIndex: anchor.nodeIndex,
      };
      setMeasurementNodes((prev) => {
        const current = prev[nodeId];
        if (
          current &&
          current.local.x === stored.local.x &&
          current.local.y === stored.local.y &&
          current.local.z === stored.local.z &&
          current.nodeIndex === stored.nodeIndex
        ) {
          return prev;
        }
        return { ...prev, [nodeId]: stored };
      });
      return stored;
    },
    [setMeasurementNodes],
  );

  const getSharedNode = useCallback(
    (nodeId: string | null | undefined): MeasurementSharedNode | null => {
      if (!nodeId) {
        return null;
      }
      return measurementNodes[nodeId] ?? null;
    },
    [measurementNodes],
  );
  const pickAnchorAtEvent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): { world: Vec3; anchor: IndexedLocalPoint } | null => {
      const canvas = event.currentTarget as HTMLDivElement;
      const rect = canvas.getBoundingClientRect();
      const canvasX = event.clientX - rect.left;
      const canvasY = event.clientY - rect.top;
      const pickResult: PointPickResult | null = pickPoint ? pickPoint(canvasX, canvasY) : null;
      const worldPoint = pickResult?.world ?? pickWorldPoint(canvasX, canvasY);
      if (!worldPoint) {
        return null;
      }

      const localPoint = pickResult?.local ?? toLocal(worldPoint);
      if (!localPoint) {
        return null;
      }

      const anchor: IndexedLocalPoint = {
        local: { x: localPoint.x, y: localPoint.y, z: localPoint.z },
        nodeIndex: pickResult ? pickResult.index : null,
      };

      return { world: worldPoint, anchor };
    },
    [pickPoint, pickWorldPoint, toLocal],
  );

  const resolveWorldPoint = useCallback(
    (point: IndexedLocalPoint | null): Vec3 | null => {
      if (!point) {
        return null;
      }
      if (point.nodeIndex !== null && getPointWorldPosition) {
        const nodeWorld = getPointWorldPosition(point.nodeIndex);
        if (nodeWorld) {
          return { x: nodeWorld.x, y: nodeWorld.y, z: nodeWorld.z };
        }
      }
      return toWorld(point.local);
    },
    [getPointWorldPosition, toWorld],
  );

  const resolveWorldFromData = useCallback(
    (local: Vec3, nodeIndex: number | null): Vec3 | null => resolveWorldPoint({ local, nodeIndex }),
    [resolveWorldPoint],
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      hasRestoredRef.current = true;
      return;
    }

    const resetInteractiveState = () => {
      setMeasurementPoints([]);
      setAreaPoints([]);
      setPreviewPoint(null);
      setActiveSharedNodeId(null);
      previewSnapAxisRef.current = null;
      setSelectedElement(null);
      setMessageState(null);
      setMessagePersistent(false);
      setRescaleDialogOpen(false);
      draggingHandleRef.current = null;
      pendingPointerRef.current = null;
    };

    const applyDefaultState = () => {
      setMeasurementScale(1);
      setMeasurementNodes({});
      setMeasurements([]);
      setAreaPolygons([]);
      measurementIdRef.current = 0;
      nodeIdRef.current = 0;
      areaIdRef.current = 0;
    };

    resetInteractiveState();

    if (!storageKey) {
      applyDefaultState();
      hasRestoredRef.current = true;
      return;
    }

    hasRestoredRef.current = false;
    persistErrorRef.current = false;

    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        applyDefaultState();
        return;
      }

      const parsed = JSON.parse(raw) as PersistedMeasurementState;
      if (!parsed || parsed.version !== 1) {
        applyDefaultState();
        return;
      }

      const nodes: Record<string, MeasurementSharedNode> = {};
      let maxNodeSuffix = -1;

      if (parsed.nodes && typeof parsed.nodes === 'object') {
        Object.entries(parsed.nodes).forEach(([id, nodeValue]) => {
          if (!nodeValue || typeof nodeValue !== 'object') {
            return;
          }
          const local = sanitizeVec3((nodeValue as any).local);
          const nodeIndex = sanitizeNodeIndex((nodeValue as any).nodeIndex);
          nodes[id] = {
            id,
            local,
            nodeIndex,
          };
          const suffix = parseIdSuffix(id, 'n-');
          if (suffix !== null) {
            maxNodeSuffix = Math.max(maxNodeSuffix, suffix);
          }
        });
      }

      let nextNodeCounter = parsed.nodeCounter ?? 0;
      if (nextNodeCounter <= maxNodeSuffix) {
        nextNodeCounter = maxNodeSuffix + 1;
      }

      const ensureNode = (
        requestedId: string | null | undefined,
        local: Vec3,
        nodeIndex: number | null,
      ): string => {
        let nodeId = typeof requestedId === 'string' && requestedId.length > 0 ? requestedId : null;
        if (nodeId && !nodes[nodeId]) {
          nodes[nodeId] = {
            id: nodeId,
            local: { x: local.x, y: local.y, z: local.z },
            nodeIndex,
          };
        }
        if (!nodeId) {
          nodeId = `n-${nextNodeCounter++}`;
          nodes[nodeId] = {
            id: nodeId,
            local: { x: local.x, y: local.y, z: local.z },
            nodeIndex,
          };
        }
        const suffix = parseIdSuffix(nodeId, 'n-');
        if (suffix !== null) {
          maxNodeSuffix = Math.max(maxNodeSuffix, suffix);
        }
        return nodeId;
      };

      const sanitizedMeasurements: MeasurementSegment[] = [];
      let maxMeasurementSuffix = -1;

      if (Array.isArray(parsed.measurements)) {
        parsed.measurements.forEach((item) => {
          if (!item || typeof item !== 'object') {
            return;
          }
          const startLocal = sanitizeVec3((item as any).startLocal);
          const endLocal = sanitizeVec3((item as any).endLocal);
          const startNodeIndex = sanitizeNodeIndex((item as any).startNodeIndex);
          const endNodeIndex = sanitizeNodeIndex((item as any).endNodeIndex);
          const axisValue = (item as any).axis;
          const axis: SnapAxis | null =
            axisValue === 'x' || axisValue === 'y' || axisValue === 'z' ? axisValue : null;
          const startNodeId = ensureNode((item as any).startSharedNodeId, startLocal, startNodeIndex);
          const endNodeId = ensureNode((item as any).endSharedNodeId, endLocal, endNodeIndex);
          let id =
            typeof (item as any).id === 'string' && (item as any).id.length > 0
              ? (item as any).id
              : `m-${sanitizedMeasurements.length}`;
          const suffix = parseIdSuffix(id, 'm-');
          if (suffix !== null) {
            maxMeasurementSuffix = Math.max(maxMeasurementSuffix, suffix);
          }
          sanitizedMeasurements.push({
            id,
            startLocal,
            endLocal,
            startNodeIndex,
            endNodeIndex,
            axis,
            startSharedNodeId: startNodeId,
            endSharedNodeId: endNodeId,
          });
        });
      }

      const sanitizedAreas: AreaPolygon[] = [];
      let maxAreaSuffix = -1;

      if (Array.isArray(parsed.areas)) {
        parsed.areas.forEach((area) => {
          if (!area || typeof area !== 'object' || typeof area.id !== 'string') {
            return;
          }
          const points = Array.isArray(area.pointsLocal)
            ? area.pointsLocal.map((point) => sanitizeVec3(point))
            : [];
          if (points.length === 0) {
            return;
          }
          const nodeIndicesRaw = Array.isArray(area.pointNodeIndices)
            ? area.pointNodeIndices.map((value) => sanitizeNodeIndex(value))
            : [];
          while (nodeIndicesRaw.length < points.length) {
            nodeIndicesRaw.push(null);
          }
          sanitizedAreas.push({
            id: area.id,
            pointsLocal: points,
            pointNodeIndices: nodeIndicesRaw.slice(0, points.length),
          });
          const suffix = parseIdSuffix(area.id, 'a-');
          if (suffix !== null) {
            maxAreaSuffix = Math.max(maxAreaSuffix, suffix);
          }
        });
      }

      setMeasurementScale(
        typeof parsed.scale === 'number' && Number.isFinite(parsed.scale) ? parsed.scale : 1,
      );
      setMeasurementNodes(nodes);
      setMeasurements(sanitizedMeasurements);
      setAreaPolygons(sanitizedAreas);
      measurementIdRef.current = Math.max(parsed.measurementCounter ?? 0, maxMeasurementSuffix + 1, 0);
      nodeIdRef.current = Math.max(parsed.nodeCounter ?? 0, maxNodeSuffix + 1, nextNodeCounter);
      areaIdRef.current = Math.max(parsed.areaCounter ?? 0, maxAreaSuffix + 1, 0);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Failed to restore measurement state', error);
      applyDefaultState();
    } finally {
      hasRestoredRef.current = true;
    }
  }, [storageKey]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    if (!storageKey) {
      return;
    }
    if (!hasRestoredRef.current) {
      return;
    }

    const serializedNodes: PersistedMeasurementState['nodes'] = {};
    Object.entries(measurementNodes).forEach(([id, node]) => {
      serializedNodes[id] = {
        local: { x: node.local.x, y: node.local.y, z: node.local.z },
        nodeIndex: node.nodeIndex,
      };
    });

    const payload: PersistedMeasurementState = {
      version: 1,
      scale: measurementScale,
      nodes: serializedNodes,
      measurements: measurements.map((segment) => ({
        id: segment.id,
        startLocal: { x: segment.startLocal.x, y: segment.startLocal.y, z: segment.startLocal.z },
        endLocal: { x: segment.endLocal.x, y: segment.endLocal.y, z: segment.endLocal.z },
        axis: segment.axis,
        startNodeIndex: segment.startNodeIndex,
        endNodeIndex: segment.endNodeIndex,
        startSharedNodeId: segment.startSharedNodeId ?? null,
        endSharedNodeId: segment.endSharedNodeId ?? null,
      })),
      areas: areaPolygons,
      measurementCounter: measurementIdRef.current,
      nodeCounter: nodeIdRef.current,
      areaCounter: areaIdRef.current,
    };

    try {
      window.localStorage.setItem(storageKey, JSON.stringify(payload));
      persistErrorRef.current = false;
    } catch (error) {
      if (!persistErrorRef.current) {
        // eslint-disable-next-line no-console
        console.warn('Failed to persist measurement state', error);
        persistErrorRef.current = true;
      }
    }
  }, [storageKey, measurementNodes, measurements, measurementScale, areaPolygons]);

  const cameraUpdateKey = useMemo(() => {
    if (!cameraAxes) {
      return 'none';
    }
    const { x, y, z } = cameraAxes;
    return [
      x.x.toFixed(4),
      x.y.toFixed(4),
      x.z.toFixed(4),
      y.x.toFixed(4),
      y.y.toFixed(4),
      y.z.toFixed(4),
      z.x.toFixed(4),
      z.y.toFixed(4),
      z.z.toFixed(4),
    ].join('|');
  }, [cameraAxes]);

  const showMessage = useCallback((text: string | null, options?: { persistent?: boolean }) => {
    setMessageState(text);
    setMessagePersistent(Boolean(options?.persistent) && text !== null);
  }, []);

  useEffect(() => {
    if (!message || messagePersistent) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setMessageState(null);
      setMessagePersistent(false);
    }, 2500);

    return () => window.clearTimeout(timeout);
  }, [message, messagePersistent]);

  useEffect(() => {
    const dispatchMouseUp = (event: PointerEvent, target: HTMLElement) => {
      const pointerType = cameraForwardRef.current.pointerType ?? event.pointerType ?? 'mouse';
      if (pointerType !== 'mouse') {
        return;
      }
      const mouseUpEvent = new MouseEvent('mouseup', {
        bubbles: true,
        cancelable: true,
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      target.dispatchEvent(mouseUpEvent);
    };

    const forwardReleaseEvent = (event: PointerEvent, type: 'pointerup' | 'pointercancel') => {
      const forwarded = cameraForwardRef.current;
      if (!forwarded.target) {
        return;
      }
      if (forwarded.pointerId !== null && event.pointerId !== forwarded.pointerId) {
        return;
      }
      const pointerType = forwarded.pointerType ?? event.pointerType ?? 'mouse';
      const releaseTarget = forwarded.target;
      const eventTarget = event.target as Node | null;
      cameraForwardRef.current.pointerType = pointerType;
      if (eventTarget && releaseTarget.contains(eventTarget)) {
        dispatchMouseUp(event, releaseTarget);
        return;
      }
      const releaseEvent = new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: forwarded.pointerId ?? event.pointerId,
        pointerType,
        button: event.button,
        buttons: event.buttons,
        clientX: event.clientX,
        clientY: event.clientY,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
      });
      releaseTarget.dispatchEvent(releaseEvent);
      dispatchMouseUp(event, releaseTarget);
    };

    const releaseCapture = (evt: PointerEvent) => {
      const targetElement = evt.target as Element | null;
      if (targetElement && typeof targetElement.releasePointerCapture === 'function') {
        try {
          targetElement.releasePointerCapture(evt.pointerId);
        } catch {
          // ignore release errors (pointer might not be captured)
        }
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      forwardReleaseEvent(event, 'pointerup');
      releaseCapture(event);
      draggingHandleRef.current = null;
      areaVertexDragRef.current = null;
      pendingPointerRef.current = null;
      resetCameraForwarding();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      forwardReleaseEvent(event, 'pointercancel');
      releaseCapture(event);
      draggingHandleRef.current = null;
      areaVertexDragRef.current = null;
      pendingPointerRef.current = null;
      resetCameraForwarding();
    };

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    return () => {
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [resetCameraForwarding]);

  const isDistanceMode = mode === 'distance';
  const isAreaMode = mode === 'area';

  const clearAll = useCallback(() => {
    setMeasurements([]);
    setMeasurementPoints([]);
    setMeasurementNodes({});
    setActiveSharedNodeId(null);
    setAreaPoints([]);
    setAreaPolygons([]);
    setPreviewPoint(null);
    previewSnapAxisRef.current = null;
    setSelectedElement(null);
    setMeasurementScale(1);
    setMessageState(null);
    setMessagePersistent(false);
    setRescaleDialogOpen(false);
    setRescaleMetersInput('');
    setRescaleCentimetersInput('');
    measurementIdRef.current = 0;
    nodeIdRef.current = 0;
    areaIdRef.current = 0;
    draggingHandleRef.current = null;
    areaVertexDragRef.current = null;
    pendingPointerRef.current = null;
    if (storageKey && typeof window !== 'undefined') {
      window.localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  const exitMode = useCallback(() => {
    setMode(null);
    setMeasurementPoints([]);
    setActiveSharedNodeId(null);
    setAreaPoints([]);
    setPreviewPoint(null);
    previewSnapAxisRef.current = null;
    setSelectedElement(null);
    setMessageState(null);
    setMessagePersistent(false);
    setRescaleDialogOpen(false);
    draggingHandleRef.current = null;
    areaVertexDragRef.current = null;
    pendingPointerRef.current = null;
  }, []);

  const toggleDistanceMode = useCallback(() => {
    if (isDistanceMode) {
      exitMode();
    } else {
      setMode('distance');
      setMeasurementPoints([]);
      setActiveSharedNodeId(null);
      setAreaPoints([]);
      setPreviewPoint(null);
      previewSnapAxisRef.current = null;
      setSelectedElement(null);
      showMessage('คลิกเลือกจุดแรก (จับตำแหน่งจากเมฆจุดจริง)', { persistent: true });
    }
  }, [isDistanceMode, exitMode, showMessage]);

  const toggleAreaMode = useCallback(() => {
    if (isAreaMode) {
      exitMode();
    } else {
      setMode('area');
      setActiveSharedNodeId(null);
      setMeasurementPoints([]);
      setAreaPoints([]);
      setPreviewPoint(null);
      previewSnapAxisRef.current = null;
      setSelectedElement(null);
      showMessage('คลิกเพิ่มจุดเพื่อกำหนดพื้นที่ (ต้องมีอย่างน้อย 3 จุด)', { persistent: true });
    }
  }, [isAreaMode, exitMode, showMessage]);

  const appendMeasurement = useCallback(
    (
      start: IndexedLocalPoint,
      end: IndexedLocalPoint,
      axis: SnapAxis | null,
      options?: { startNodeId?: string | null; endNodeId?: string | null },
    ): { measurementId: string; startNode: MeasurementSharedNode; endNode: MeasurementSharedNode } => {
      const startNode = registerSharedNode(start, options?.startNodeId);
      const endNode = registerSharedNode(end, options?.endNodeId);

      const duplicate = measurements.find(
        (measurement) =>
          measurement.startSharedNodeId &&
          measurement.endSharedNodeId &&
          ((measurement.startSharedNodeId === startNode.id && measurement.endSharedNodeId === endNode.id) ||
            (measurement.startSharedNodeId === endNode.id && measurement.endSharedNodeId === startNode.id)),
      );
      const startWorld = resolveWorldFromData(
        { x: startNode.local.x, y: startNode.local.y, z: startNode.local.z },
        startNode.nodeIndex,
      );
      const endWorld = resolveWorldFromData(
        { x: endNode.local.x, y: endNode.local.y, z: endNode.local.z },
        endNode.nodeIndex,
      );
      const resolvedAxis = startWorld && endWorld ? axis ?? detectSnapAxis(startWorld, endWorld) : axis ?? null;

      if (duplicate) {
        if (duplicate.axis !== resolvedAxis) {
          setMeasurements((prev) =>
            prev.map((measurement) =>
              measurement.id === duplicate.id ? { ...measurement, axis: resolvedAxis } : measurement,
            ),
          );
        }
        setSelectedElement({ type: 'distance', id: duplicate.id });
        return { measurementId: duplicate.id, startNode, endNode };
      }

      const nextId = `m-${measurementIdRef.current++}`;
      const localStart = { x: startNode.local.x, y: startNode.local.y, z: startNode.local.z };
      const localEnd = { x: endNode.local.x, y: endNode.local.y, z: endNode.local.z };

      const nextSegment: MeasurementSegment = {
        id: nextId,
        startLocal: localStart,
        endLocal: localEnd,
        startNodeIndex: startNode.nodeIndex,
        endNodeIndex: endNode.nodeIndex,
        axis: resolvedAxis,
        startSharedNodeId: startNode.id,
        endSharedNodeId: endNode.id,
      };

      setMeasurements((prev) => [...prev, nextSegment]);
      setSelectedElement({ type: 'distance', id: nextId });
      return { measurementId: nextId, startNode, endNode };
    },
    [measurements, registerSharedNode, resolveWorldFromData],
  );

  const startDragHandle = useCallback(
    (event: ReactPointerEvent, measurementId: string, target: 'start' | 'end') => {
      event.stopPropagation();
      event.preventDefault();

      const measurement = measurements.find((item) => item.id === measurementId);
      if (!measurement) {
        return;
      }

      const anchor: IndexedLocalPoint =
        target === 'start'
          ? {
              local: { x: measurement.startLocal.x, y: measurement.startLocal.y, z: measurement.startLocal.z },
              nodeIndex: measurement.startNodeIndex,
            }
          : {
              local: { x: measurement.endLocal.x, y: measurement.endLocal.y, z: measurement.endLocal.z },
              nodeIndex: measurement.endNodeIndex,
            };

      const existingNodeId = target === 'start' ? measurement.startSharedNodeId : measurement.endSharedNodeId;
      const sharedNode = registerSharedNode(anchor, existingNodeId);

      if (target === 'start' && measurement.startSharedNodeId !== sharedNode.id) {
        setMeasurements((prev) =>
          prev.map((item) =>
            item.id === measurementId ? { ...item, startSharedNodeId: sharedNode.id } : item,
          ),
        );
      } else if (target === 'end' && measurement.endSharedNodeId !== sharedNode.id) {
        setMeasurements((prev) =>
          prev.map((item) =>
            item.id === measurementId ? { ...item, endSharedNodeId: sharedNode.id } : item,
          ),
        );
      }

      if (event.shiftKey) {
        setMeasurementPoints([
          { local: { x: sharedNode.local.x, y: sharedNode.local.y, z: sharedNode.local.z }, nodeIndex: sharedNode.nodeIndex },
        ]);
        setActiveSharedNodeId(sharedNode.id);
        setPreviewPoint(null);
        previewSnapAxisRef.current = null;

        if (activeSharedNodeId && activeSharedNodeId !== sharedNode.id) {
          const baseNode = getSharedNode(activeSharedNodeId);
          if (baseNode) {
            const baseAnchor: IndexedLocalPoint = {
              local: { x: baseNode.local.x, y: baseNode.local.y, z: baseNode.local.z },
              nodeIndex: baseNode.nodeIndex,
            };
            appendMeasurement(
              baseAnchor,
              {
                local: { x: sharedNode.local.x, y: sharedNode.local.y, z: sharedNode.local.z },
                nodeIndex: sharedNode.nodeIndex,
              },
              null,
              {
                startNodeId: baseNode.id,
                endNodeId: sharedNode.id,
              },
            );
            showMessage('เชื่อมต่อจุดแล้ว คลิกต่อเพื่อเพิ่มหรือกด Esc เพื่อออก', { persistent: true });
          }
        } else {
          showMessage('เลือกจุดแล้ว คลิกตำแหน่งถัดไปเพื่อเชื่อมต่อ', { persistent: true });
        }
        return;
      }

      draggingHandleRef.current = {
        measurementId,
        target,
        nodeId: sharedNode.id,
        pointerId: event.pointerId,
      };
      const element = event.currentTarget as HTMLElement | null;
      if (element?.setPointerCapture) {
        element.setPointerCapture(event.pointerId);
      }
      setSelectedElement({ type: 'distance', id: measurementId });
    },
    [
      measurements,
      registerSharedNode,
      appendMeasurement,
      showMessage,
      getSharedNode,
      activeSharedNodeId,
    ],
  );

  const startAreaVertexDrag = useCallback(
    (
      event: ReactPointerEvent<SVGCircleElement>,
      areaId: string,
      vertexIndex: number,
      _nodeId: string | null,
    ) => {
      event.stopPropagation();
      event.preventDefault();
      pendingPointerRef.current = null;
      areaVertexDragRef.current = {
        areaId,
        vertexIndex,
        pointerId: event.pointerId,
      };
      setSelectedElement({ type: 'area', id: areaId });
      if (event.currentTarget.setPointerCapture) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [setSelectedElement],
  );

  const pruneUnreferencedNodes = useCallback(
    (segments: MeasurementSegment[], retainNodeId: string | null) => {
      const used = new Set<string>();
      segments.forEach((segment) => {
        if (segment.startSharedNodeId) {
          used.add(segment.startSharedNodeId);
        }
        if (segment.endSharedNodeId) {
          used.add(segment.endSharedNodeId);
        }
      });
      if (retainNodeId) {
        used.add(retainNodeId);
      }
      setMeasurementNodes((prev) => {
        let changed = false;
        const next: Record<string, MeasurementSharedNode> = {};
        Object.entries(prev).forEach(([id, node]) => {
          if (used.has(id)) {
            next[id] = node;
          } else {
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    },
    [setMeasurementNodes],
  );

  const finalizeAreaPolygon = useCallback(() => {
    setAreaPoints((current) => {
      if (current.length < 3) {
        showMessage('จำเป็นต้องมีอย่างน้อย 3 จุดเพื่อสร้างพื้นที่', { persistent: false });
        return [];
      }

      const pointsLocal = current.map((point) => ({
        x: point.local.x,
        y: point.local.y,
        z: point.local.z,
      }));
      const pointNodeIndices = current.map((point) => point.nodeIndex);
      const id = `a-${areaIdRef.current++}`;
      setAreaPolygons((prev) => [...prev, { id, pointsLocal, pointNodeIndices }]);
      setSelectedElement({ type: 'area', id });
      showMessage('บันทึกพื้นที่แล้ว คลิกต่อเพื่อวาดใหม่ หรือคลิกขวาเพื่อหยุด', { persistent: true });
      return [];
    });
    setPreviewPoint(null);
    previewSnapAxisRef.current = null;
  }, [showMessage]);

  const handleDeleteMeasurement = useCallback(
    (id: string) => {
      const next = measurements.filter((measurement) => measurement.id !== id);
      setMeasurements(next);
      pruneUnreferencedNodes(next, activeSharedNodeId);
      const activeStillUsed = activeSharedNodeId
        ? next.some(
            (measurement) =>
              measurement.startSharedNodeId === activeSharedNodeId ||
              measurement.endSharedNodeId === activeSharedNodeId,
          )
        : false;
      if (!activeStillUsed) {
        setActiveSharedNodeId(null);
        setMeasurementPoints([]);
      }
      setSelectedElement((prev) => (prev?.type === 'distance' && prev.id === id ? null : prev));
      setRescaleDialogOpen((open) => (open && selectedElement?.type === 'distance' && selectedElement.id === id ? false : open));
    },
    [measurements, pruneUnreferencedNodes, activeSharedNodeId, selectedElement],
  );

  const handleDeleteArea = useCallback((id: string) => {
    setAreaPolygons((prev) => prev.filter((polygon) => polygon.id !== id));
    setSelectedElement((prev) => (prev?.type === 'area' && prev.id === id ? null : prev));
  }, []);

  const selectDistance = useCallback((id: string) => {
    setSelectedElement({ type: 'distance', id });
    showMessage(null);
  }, [showMessage]);

  const selectArea = useCallback((id: string) => {
    setSelectedElement({ type: 'area', id });
    showMessage(null);
  }, [showMessage]);

  const openRescaleDialog = useCallback(() => {
    const selectedMeasurement = measurements.find((measurement) => selectedElement?.type === 'distance' && measurement.id === selectedElement.id);
    if (!selectedMeasurement) {
      return;
    }
    const startWorld = resolveWorldFromData(
      selectedMeasurement.startLocal,
      selectedMeasurement.startNodeIndex ?? null,
    );
    const endWorld = resolveWorldFromData(
      selectedMeasurement.endLocal,
      selectedMeasurement.endNodeIndex ?? null,
    );
    if (!startWorld || !endWorld) {
      return;
    }

    const rawLength = distanceBetween(startWorld, endWorld);
    const scaledLength = rawLength * measurementScale;
    const meters = Math.floor(scaledLength);
    const centimeters = Math.round((scaledLength - meters) * 100);
    setRescaleMetersInput(meters.toString());
    setRescaleCentimetersInput(centimeters.toString().padStart(2, '0'));
    setRescaleDialogOpen(true);
  }, [measurements, selectedElement, measurementScale, resolveWorldFromData]);

  const closeRescaleDialog = useCallback(() => {
    setRescaleDialogOpen(false);
  }, []);

  const handleRescaleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const selectedMeasurement = measurements.find((measurement) => selectedElement?.type === 'distance' && measurement.id === selectedElement.id);
      if (!selectedMeasurement) {
        return;
      }

      const startWorld = resolveWorldFromData(
        selectedMeasurement.startLocal,
        selectedMeasurement.startNodeIndex ?? null,
      );
      const endWorld = resolveWorldFromData(
        selectedMeasurement.endLocal,
        selectedMeasurement.endNodeIndex ?? null,
      );
      if (!startWorld || !endWorld) {
        showMessage('ไม่สามารถจับตำแหน่งได้', { persistent: false });
        return;
      }

      const rawLength = distanceBetween(startWorld, endWorld);
      const meters = parseFloat(rescaleMetersInput || '0');
      const centimeters = parseFloat(rescaleCentimetersInput || '0');

      if (!Number.isFinite(meters) || !Number.isFinite(centimeters)) {
        showMessage('กรุณากรอกค่าที่ถูกต้อง', { persistent: false });
        return;
      }

      const expected = meters + centimeters / 100;
      if (!Number.isFinite(expected) || expected <= 0) {
        showMessage('ค่าที่ต้องการต้องมากกว่า 0', { persistent: false });
        return;
      }

      const newScale = expected / rawLength;
      if (!Number.isFinite(newScale) || newScale <= 0) {
        showMessage('ไม่สามารถปรับสเกลได้', { persistent: false });
        return;
      }

      setMeasurementScale(newScale);
      setRescaleDialogOpen(false);
      showMessage('อัปเดตสเกลเรียบร้อย', { persistent: false });
    },
    [measurements, selectedElement, rescaleMetersInput, rescaleCentimetersInput, showMessage, resolveWorldFromData],
  );

  const measurementScreenData = useMemo<MeasurementScreenDatum[]>(() => {
    return measurements
      .map((measurement) => {
        const startWorld = resolveWorldFromData(
          measurement.startLocal,
          measurement.startNodeIndex ?? null,
        );
        const endWorld = resolveWorldFromData(
          measurement.endLocal,
          measurement.endNodeIndex ?? null,
        );
        if (!startWorld || !endWorld) {
          return null;
        }

        const startProjection = projectWorldToScreen(startWorld);
        const endProjection = projectWorldToScreen(endWorld);
        if (!startProjection || !endProjection || !startProjection.visible || !endProjection.visible) {
          return null;
        }

        const startView = toViewBox(startProjection);
        const endView = toViewBox(endProjection);
        const midPoint = {
          x: (startProjection.x + endProjection.x) / 2,
          y: (startProjection.y + endProjection.y) / 2,
        };
        const distance = distanceBetween(startWorld, endWorld) * measurementScale;
        const label = formatDistance(distance);
        const isSelected = selectedElement?.type === 'distance' && selectedElement.id === measurement.id;
        const axisComponents = computeAxisComponents(startWorld, endWorld, measurementScale);
        const axis = detectSnapAxis(startWorld, endWorld);

        const screenDatum: MeasurementScreenDatum = {
          id: measurement.id,
          startView,
          endView,
          label,
          midPoint,
          isSelected,
          axis,
          axisComponents,
        };
        return screenDatum;
      })
      .filter((entry): entry is MeasurementScreenDatum => Boolean(entry));
  }, [measurements, measurementScale, projectWorldToScreen, selectedElement, cameraUpdateKey, resolveWorldFromData]);

  const areaScreenData = useMemo<AreaScreenDatum[]>(() => {
    return areaPolygons
      .map((polygon): AreaScreenDatum | null => {
        const worldPoints = polygon.pointsLocal
          .map((point, index) => {
            const nodeIndex = polygon.pointNodeIndices?.[index] ?? null;
            return resolveWorldFromData(point, nodeIndex);
          })
          .filter((point): point is Vec3 => Boolean(point));

        if (worldPoints.length !== polygon.pointsLocal.length || worldPoints.length < 3) {
          return null;
        }

        const projections = worldPoints
          .map((point) => projectWorldToScreen(point))
          .filter((projection): projection is ScreenProjection => Boolean(projection && projection.visible));

        if (projections.length !== worldPoints.length) {
          return null;
        }

        const path = projections.map((projection) => toViewBox(projection));
        const centroid = {
          x: projections.reduce((sum, projection) => sum + projection.x, 0) / projections.length,
          y: projections.reduce((sum, projection) => sum + projection.y, 0) / projections.length,
        };

        const rawArea = computePolygonArea(worldPoints);
        const scaledArea = rawArea * measurementScale * measurementScale;
        const label = formatArea(scaledArea);
        const isSelected = selectedElement?.type === 'area' && selectedElement.id === polygon.id;

        const vertices = isSelected
          ? path.map((point, index) => ({
              index,
              x: point.x,
              y: point.y,
              nodeId: null,
            }))
          : undefined;

        return {
          id: polygon.id,
          path,
          centroid,
          label,
          isSelected,
          vertices,
        };
      })
      .filter((entry): entry is AreaScreenDatum => Boolean(entry));
  }, [areaPolygons, measurementScale, projectWorldToScreen, selectedElement, cameraUpdateKey, resolveWorldFromData]);

  const measurementChainTotals = useMemo(() => {
    const nodeToMeasurements = new Map<string, Set<string>>();
    const measurementLengths = new Map<string, number>();
    const measurementNodeKeys = new Map<string, [string, string]>();

    const registerNode = (nodeKey: string, measurementId: string) => {
      if (!nodeToMeasurements.has(nodeKey)) {
        nodeToMeasurements.set(nodeKey, new Set());
      }
      nodeToMeasurements.get(nodeKey)!.add(measurementId);
    };

    measurements.forEach((segment) => {
      const startWorld = resolveWorldFromData(
        segment.startLocal,
        segment.startNodeIndex ?? null,
      );
      const endWorld = resolveWorldFromData(segment.endLocal, segment.endNodeIndex ?? null);
      if (!startWorld || !endWorld) {
        return;
      }

      const length = distanceBetween(startWorld, endWorld) * measurementScale;
      measurementLengths.set(segment.id, length);

      const startKey = segment.startSharedNodeId ?? `segment:${segment.id}:start`;
      const endKey = segment.endSharedNodeId ?? `segment:${segment.id}:end`;
      measurementNodeKeys.set(segment.id, [startKey, endKey]);
      registerNode(startKey, segment.id);
      registerNode(endKey, segment.id);
    });

    const totalByMeasurement = new Map<string, number>();
    const formattedByMeasurement = new Map<string, string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    measurementLengths.forEach((_, measurementId) => {
      if (visited.has(measurementId)) {
        return;
      }

      stack.push(measurementId);
      const component: string[] = [];

      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || visited.has(current)) {
          continue;
        }
        visited.add(current);
        component.push(current);

        const nodeKeys = measurementNodeKeys.get(current);
        if (!nodeKeys) {
          continue;
        }

        nodeKeys.forEach((nodeKey) => {
          const neighbors = nodeToMeasurements.get(nodeKey);
          if (!neighbors) {
            return;
          }
          neighbors.forEach((neighborId) => {
            if (!visited.has(neighborId)) {
              stack.push(neighborId);
            }
          });
        });
      }

      const totalLength = component.reduce(
        (sum, measurementIdInComponent) => sum + (measurementLengths.get(measurementIdInComponent) ?? 0),
        0,
      );
      const formatted = formatDistance(totalLength);
      component.forEach((measurementIdInComponent) => {
        totalByMeasurement.set(measurementIdInComponent, totalLength);
        formattedByMeasurement.set(measurementIdInComponent, formatted);
      });
    });

    return {
      totalByMeasurement,
      formattedByMeasurement,
    };
  }, [measurements, measurementScale, resolveWorldFromData]);

  const baseAnchor = measurementPoints[0] ?? null;
  const basePoint = resolveWorldPoint(baseAnchor);
  const previewWorld = resolveWorldPoint(previewPoint);
  const previewProjection = previewWorld ? projectWorldToScreen(previewWorld) : null;
  const baseProjection = basePoint ? projectWorldToScreen(basePoint) : null;

  const previewLabel = useMemo(() => {
    if (!basePoint || !previewWorld) {
      return null;
    }
    const distance = distanceBetween(basePoint, previewWorld) * measurementScale;
    return formatDistance(distance);
  }, [basePoint, previewWorld, measurementScale]);

  const previewAxisComponents = useMemo(() => {
    if (!basePoint || !previewWorld) {
      return null;
    }
    return computeAxisComponents(basePoint, previewWorld, measurementScale);
  }, [basePoint, previewWorld, measurementScale]);

  const axisGuides = useMemo(() => {
    if (!isDistanceMode || !basePoint) {
      return [] as MeasurementOverlayState['axisGuides'];
    }

    const axisGuideLength = previewWorld ? Math.max(distanceBetween(basePoint, previewWorld), 1.5) : 2;

    return AXIS_ORDER.map((axis) => {
      const dir = AXIS_VECTORS[axis];
      const start = {
        x: basePoint.x - dir.x * axisGuideLength,
        y: basePoint.y - dir.y * axisGuideLength,
        z: basePoint.z - dir.z * axisGuideLength,
      };
      const end = {
        x: basePoint.x + dir.x * axisGuideLength,
        y: basePoint.y + dir.y * axisGuideLength,
        z: basePoint.z + dir.z * axisGuideLength,
      };

      const startProjection = projectWorldToScreen(start);
      const endProjection = projectWorldToScreen(end);
      if (!startProjection || !endProjection || !startProjection.visible || !endProjection.visible) {
        return null;
      }

      const startView = toViewBox(startProjection);
      const endView = toViewBox(endProjection);
      const active = previewSnapAxisRef.current === axis;

      return {
        axis,
        x1: startView.x,
        y1: startView.y,
        x2: endView.x,
        y2: endView.y,
        active,
      };
    }).filter((entry): entry is MeasurementOverlayState['axisGuides'][number] => Boolean(entry));
  }, [isDistanceMode, basePoint, previewPoint, projectWorldToScreen, cameraUpdateKey]);

  const areaPreviewScreen = useMemo<AreaPreviewScreen | null>(() => {
    if (!isAreaMode) {
      return null;
    }

    const verticesAnchors = [...areaPoints];
    if (previewPoint) {
      verticesAnchors.push(previewPoint);
    }

    if (verticesAnchors.length === 0) {
      return null;
    }

    const verticesWorld = verticesAnchors
      .map((point) => resolveWorldPoint(point))
      .filter((point): point is Vec3 => Boolean(point));

    if (verticesWorld.length !== verticesAnchors.length) {
      return null;
    }

    const projections = verticesWorld
      .map((point) => projectWorldToScreen(point))
      .filter((projection): projection is ScreenProjection => Boolean(projection && projection.visible));

    if (projections.length !== verticesWorld.length) {
      return null;
    }

    const path = projections.map((projection) => toViewBox(projection));
    const centroid = {
      x: projections.reduce((sum, projection) => sum + projection.x, 0) / projections.length,
      y: projections.reduce((sum, projection) => sum + projection.y, 0) / projections.length,
    };

    const rawArea = verticesWorld.length >= 3 ? computePolygonArea(verticesWorld) : null;
    const scaledArea = rawArea !== null ? rawArea * measurementScale * measurementScale : null;
    const label = scaledArea !== null ? formatArea(scaledArea) : null;

    return { path, centroid, label };
  }, [isAreaMode, areaPoints, previewPoint, projectWorldToScreen, measurementScale, cameraUpdateKey, resolveWorldPoint]);

  const selectedMeasurement = useMemo(() => {
    if (selectedElement?.type !== 'distance') {
      return null;
    }
    return measurements.find((measurement) => measurement.id === selectedElement.id) ?? null;
  }, [measurements, selectedElement]);

  const selectedDistanceLabel = useMemo(() => {
    if (!selectedMeasurement) {
      return null;
    }
    const startWorld = resolveWorldFromData(
      selectedMeasurement.startLocal,
      selectedMeasurement.startNodeIndex ?? null,
    );
    const endWorld = resolveWorldFromData(
      selectedMeasurement.endLocal,
      selectedMeasurement.endNodeIndex ?? null,
    );
    if (!startWorld || !endWorld) {
      return null;
    }
    const distance = distanceBetween(startWorld, endWorld) * measurementScale;
    return formatMetersCentimeters(distance);
  }, [selectedMeasurement, measurementScale, resolveWorldFromData]);

  const selectedDistanceChainLabel = useMemo(() => {
    if (!selectedMeasurement) {
      return null;
    }
    const formatted = measurementChainTotals.formattedByMeasurement.get(selectedMeasurement.id);
    return formatted ?? null;
  }, [selectedMeasurement, measurementChainTotals]);

  const selectedAxisComponents = useMemo(() => {
    if (!selectedMeasurement) {
      return null;
    }
    const startWorld = resolveWorldFromData(
      selectedMeasurement.startLocal,
      selectedMeasurement.startNodeIndex ?? null,
    );
    const endWorld = resolveWorldFromData(
      selectedMeasurement.endLocal,
      selectedMeasurement.endNodeIndex ?? null,
    );
    if (!startWorld || !endWorld) {
      return null;
    }
    return computeAxisComponents(startWorld, endWorld, measurementScale);
  }, [selectedMeasurement, measurementScale, resolveWorldFromData]);

  const selectedAreaLabel = useMemo(() => {
    if (selectedElement?.type !== 'area') {
      return null;
    }
    const polygon = areaPolygons.find((area) => area.id === selectedElement.id);
    if (!polygon) {
      return null;
    }
    const worldPoints = polygon.pointsLocal
      .map((point, index) => {
        const nodeIndex = polygon.pointNodeIndices?.[index] ?? null;
        return resolveWorldFromData(point, nodeIndex);
      })
      .filter((point): point is Vec3 => Boolean(point));
    if (worldPoints.length !== polygon.pointsLocal.length) {
      return null;
    }
    const area = computePolygonArea(worldPoints) * measurementScale * measurementScale;
    return formatArea(area);
  }, [areaPolygons, selectedElement, measurementScale, resolveWorldFromData]);

  const selectedAreaPerimeterLabel = useMemo(() => {
    if (selectedElement?.type !== 'area') {
      return null;
    }
    const polygon = areaPolygons.find((area) => area.id === selectedElement.id);
    if (!polygon) {
      return null;
    }
    const worldPoints = polygon.pointsLocal
      .map((point, index) => {
        const nodeIndex = polygon.pointNodeIndices?.[index] ?? null;
        return resolveWorldFromData(point, nodeIndex);
      })
      .filter((point): point is Vec3 => Boolean(point));
    if (worldPoints.length < 2 || worldPoints.length !== polygon.pointsLocal.length) {
      return null;
    }
    const perimeter = computePolygonPerimeter(worldPoints) * measurementScale;
    return formatDistance(perimeter);
  }, [areaPolygons, selectedElement, measurementScale, resolveWorldFromData]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!isDistanceMode && !isAreaMode) {
        return;
      }

      const normalizedButton = event.button === 0 && (event.ctrlKey || event.metaKey) ? 2 : event.button;
      const pointerInitOverrides: Partial<PointerEventInit> = {
        button: normalizedButton,
        buttons: pointerButtonsFromButton(normalizedButton),
      };
      const isSecondaryActivation = normalizedButton === 2;

      if (isAreaMode && isSecondaryActivation) {
        event.preventDefault();
        if (areaPoints.length >= 3) {
          finalizeAreaPolygon();
        } else if (areaPoints.length === 0) {
          exitMode();
        } else {
          showMessage('จำเป็นต้องมีอย่างน้อย 3 จุดเพื่อสร้างพื้นที่', { persistent: false });
        }
        pendingPointerRef.current = null;
        return;
      }

      if (normalizedButton === 1 || normalizedButton === 2 || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
        startCameraForwarding(
          event.currentTarget as HTMLDivElement,
          makePointerEventInit(event.nativeEvent, pointerInitOverrides),
        );
        return;
      }

      if (normalizedButton !== 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      pendingPointerRef.current = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        overlay: event.currentTarget as HTMLDivElement,
        pointerInit: makePointerEventInit(event.nativeEvent, pointerInitOverrides),
      };
    },
    [
      isDistanceMode,
      isAreaMode,
      areaPoints,
      finalizeAreaPolygon,
      exitMode,
      showMessage,
      startCameraForwarding,
      makePointerEventInit,
    ],
  );

  const processPointerMove = useCallback(
    (overlayEl: HTMLDivElement | null, clientX: number, clientY: number, pointerId: number) => {
      if (!overlayEl) {
        return;
      }

      const rect = overlayEl.getBoundingClientRect();
      const canvasX = clientX - rect.left;
      const canvasY = clientY - rect.top;
      const pickResult: PointPickResult | null = pickPoint ? pickPoint(canvasX, canvasY) : null;
      const worldPoint = pickResult?.world ?? pickWorldPoint(canvasX, canvasY);

      if (draggingHandleRef.current) {
        if (draggingHandleRef.current.pointerId !== pointerId) {
          return;
        }
        if (!worldPoint) {
          previewSnapAxisRef.current = null;
          return;
        }
        const { measurementId, target, nodeId, pointerId: activePointerId } = draggingHandleRef.current;
        const measurement = measurements.find((item) => item.id === measurementId);
        if (!measurement) {
          return;
        }
        const isStartHandle = target === 'start';
        const anchor: IndexedLocalPoint = isStartHandle
          ? {
              local: { x: measurement.startLocal.x, y: measurement.startLocal.y, z: measurement.startLocal.z },
              nodeIndex: measurement.startNodeIndex,
            }
          : {
              local: { x: measurement.endLocal.x, y: measurement.endLocal.y, z: measurement.endLocal.z },
              nodeIndex: measurement.endNodeIndex,
            };

        const ensuredNode = registerSharedNode(
          anchor,
          nodeId ?? (isStartHandle ? measurement.startSharedNodeId : measurement.endSharedNodeId),
        );
        if (!draggingHandleRef.current.nodeId || draggingHandleRef.current.nodeId !== ensuredNode.id) {
          draggingHandleRef.current = {
            measurementId,
            target,
            nodeId: ensuredNode.id,
            pointerId: activePointerId,
          };
        }
        if (isStartHandle && measurement.startSharedNodeId !== ensuredNode.id) {
          setMeasurements((prev) =>
            prev.map((item) =>
              item.id === measurementId ? { ...item, startSharedNodeId: ensuredNode.id } : item,
            ),
          );
        } else if (!isStartHandle && measurement.endSharedNodeId !== ensuredNode.id) {
          setMeasurements((prev) =>
            prev.map((item) =>
              item.id === measurementId ? { ...item, endSharedNodeId: ensuredNode.id } : item,
            ),
          );
        }

        const otherSharedNode = isStartHandle
          ? getSharedNode(measurement.endSharedNodeId)
          : getSharedNode(measurement.startSharedNodeId);
        const otherAnchor: IndexedLocalPoint = otherSharedNode
          ? {
              local: { x: otherSharedNode.local.x, y: otherSharedNode.local.y, z: otherSharedNode.local.z },
              nodeIndex: otherSharedNode.nodeIndex,
            }
          : isStartHandle
            ? { local: { x: measurement.endLocal.x, y: measurement.endLocal.y, z: measurement.endLocal.z }, nodeIndex: measurement.endNodeIndex }
            : { local: { x: measurement.startLocal.x, y: measurement.startLocal.y, z: measurement.startLocal.z }, nodeIndex: measurement.startNodeIndex };
        const otherWorld = resolveWorldPoint(otherAnchor);

        let nextWorld = worldPoint;
        let nextLocal = pickResult?.local ?? toLocal(worldPoint);
        let nextNodeIndex = pickResult ? pickResult.index : null;

        const snapResult = otherWorld ? trySnapToAxis(otherWorld, worldPoint) : null;
        if (snapResult) {
          nextWorld = snapResult.point;
          nextLocal = toLocal(nextWorld);
          nextNodeIndex = null;
          previewSnapAxisRef.current = snapResult.axis;
        } else {
          previewSnapAxisRef.current = null;
          if (!nextLocal) {
            nextLocal = toLocal(nextWorld);
          }
        }

        if (!nextLocal) {
          return;
        }

        const updatedLocal = { x: nextLocal.x, y: nextLocal.y, z: nextLocal.z };

        setMeasurementNodes((prev) => {
          const current = prev[ensuredNode.id];
          if (
            current &&
            current.local.x === updatedLocal.x &&
            current.local.y === updatedLocal.y &&
            current.local.z === updatedLocal.z &&
            current.nodeIndex === nextNodeIndex
          ) {
            return prev;
          }
          return {
            ...prev,
            [ensuredNode.id]: {
              id: ensuredNode.id,
              local: updatedLocal,
              nodeIndex: nextNodeIndex,
            },
          };
        });

        if (activeSharedNodeId === ensuredNode.id) {
          setMeasurementPoints([
            {
              local: { x: updatedLocal.x, y: updatedLocal.y, z: updatedLocal.z },
              nodeIndex: nextNodeIndex,
            },
          ]);
        }

        setMeasurements((prev) =>
          prev.map((segment) => {
            const affectsStart =
              segment.startSharedNodeId === ensuredNode.id ||
              (segment.id === measurementId && isStartHandle && !segment.startSharedNodeId);
            const affectsEnd =
              segment.endSharedNodeId === ensuredNode.id ||
              (segment.id === measurementId && !isStartHandle && !segment.endSharedNodeId);

            if (!affectsStart && !affectsEnd) {
              return segment;
            }

            const nextStartLocal = affectsStart ? updatedLocal : segment.startLocal;
            const nextStartNodeIndex = affectsStart ? nextNodeIndex : segment.startNodeIndex;
            const nextEndLocal = affectsEnd ? updatedLocal : segment.endLocal;
            const nextEndNodeIndex = affectsEnd ? nextNodeIndex : segment.endNodeIndex;

            const startWorld = resolveWorldFromData(
              { x: nextStartLocal.x, y: nextStartLocal.y, z: nextStartLocal.z },
              nextStartNodeIndex,
            );
            const endWorld = resolveWorldFromData(
              { x: nextEndLocal.x, y: nextEndLocal.y, z: nextEndLocal.z },
              nextEndNodeIndex,
            );
            const nextAxis = startWorld && endWorld ? detectSnapAxis(startWorld, endWorld) : segment.axis;

            return {
              ...segment,
              startLocal: { x: nextStartLocal.x, y: nextStartLocal.y, z: nextStartLocal.z },
              endLocal: { x: nextEndLocal.x, y: nextEndLocal.y, z: nextEndLocal.z },
              startNodeIndex: nextStartNodeIndex,
              endNodeIndex: nextEndNodeIndex,
              axis: nextAxis,
              startSharedNodeId: affectsStart ? ensuredNode.id : segment.startSharedNodeId ?? null,
              endSharedNodeId: affectsEnd ? ensuredNode.id : segment.endSharedNodeId ?? null,
            };
          }),
        );
        return;
      }

      if (areaVertexDragRef.current) {
        if (areaVertexDragRef.current.pointerId !== pointerId) {
          return;
        }
        if (!worldPoint) {
          return;
        }

        const candidateLocal = pickResult?.local ?? toLocal(worldPoint);
        if (!candidateLocal) {
          return;
        }
        const nextLocal = { x: candidateLocal.x, y: candidateLocal.y, z: candidateLocal.z };
        const nextNodeIndex = pickResult ? pickResult.index : null;

        const { areaId, vertexIndex } = areaVertexDragRef.current;
        setAreaPolygons((prev) =>
          prev.map((polygon) => {
            if (polygon.id !== areaId) {
              return polygon;
            }
            const nextPoints = [...polygon.pointsLocal];
            const nextNodeIndices = [...polygon.pointNodeIndices];
            nextPoints[vertexIndex] = nextLocal;
            if (vertexIndex < nextNodeIndices.length) {
              nextNodeIndices[vertexIndex] = nextNodeIndex;
            } else {
              nextNodeIndices.push(nextNodeIndex);
            }
            return {
              ...polygon,
              pointsLocal: nextPoints,
              pointNodeIndices: nextNodeIndices,
            };
          }),
        );
        return;
      }

      if (isDistanceMode) {
        if (!worldPoint) {
          setPreviewPoint(null);
          previewSnapAxisRef.current = null;
          return;
        }

        let baseAnchor = measurementPoints[0] ?? null;
        if (!baseAnchor && activeSharedNodeId) {
          const baseNode = getSharedNode(activeSharedNodeId);
          if (baseNode) {
            baseAnchor = {
              local: { x: baseNode.local.x, y: baseNode.local.y, z: baseNode.local.z },
              nodeIndex: baseNode.nodeIndex,
            };
          }
        }
        if (!baseAnchor) {
          setPreviewPoint(null);
          previewSnapAxisRef.current = null;
          return;
        }

        const baseWorld = resolveWorldPoint(baseAnchor);
        if (!baseWorld) {
          setPreviewPoint(null);
          previewSnapAxisRef.current = null;
          return;
        }

        const snapResult = trySnapToAxis(baseWorld, worldPoint);
        const targetWorld = snapResult ? snapResult.point : worldPoint;
        let targetLocal = snapResult ? toLocal(targetWorld) : pickResult?.local ?? toLocal(targetWorld);
        const targetNodeIndex = snapResult ? null : pickResult ? pickResult.index : null;
        if (snapResult) {
          previewSnapAxisRef.current = snapResult.axis;
        } else {
          previewSnapAxisRef.current = null;
        }
        if (!targetLocal) {
          setPreviewPoint(null);
          return;
        }
        setPreviewPoint({
          local: { x: targetLocal.x, y: targetLocal.y, z: targetLocal.z },
          nodeIndex: targetNodeIndex,
        });
      } else if (isAreaMode) {
        if (!worldPoint) {
          setPreviewPoint(null);
          return;
        }

        if (areaPoints.length === 0) {
          const local = pickResult?.local ?? toLocal(worldPoint);
          if (!local) {
            setPreviewPoint(null);
            return;
          }
          setPreviewPoint({
            local: { x: local.x, y: local.y, z: local.z },
            nodeIndex: pickResult ? pickResult.index : null,
          });
          return;
        }

        const lastAnchor = areaPoints[areaPoints.length - 1];
        const lastWorld = resolveWorldPoint(lastAnchor);
        const snapResult = lastWorld ? trySnapToAxis(lastWorld, worldPoint) : null;
        const targetWorld = snapResult ? snapResult.point : worldPoint;
        let targetLocal = snapResult ? toLocal(targetWorld) : pickResult?.local ?? toLocal(targetWorld);
        const targetNodeIndex = snapResult ? null : pickResult ? pickResult.index : null;
        if (!targetLocal) {
          setPreviewPoint(null);
          return;
        }
        setPreviewPoint({
          local: { x: targetLocal.x, y: targetLocal.y, z: targetLocal.z },
          nodeIndex: targetNodeIndex,
        });
      }
    },
    [
      isDistanceMode,
      isAreaMode,
      measurementPoints,
      areaPoints,
      pickPoint,
      pickWorldPoint,
      resolveWorldPoint,
      resolveWorldFromData,
      toLocal,
      measurements,
      registerSharedNode,
      getSharedNode,
      activeSharedNodeId,
      setMeasurementPoints,
      setAreaPolygons,
    ],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (continueCameraForwarding(event.nativeEvent)) {
        event.preventDefault();
        return;
      }
      const pending = pendingPointerRef.current;
      if (pending && pending.pointerId === event.pointerId) {
        const deltaX = event.clientX - pending.startClientX;
        const deltaY = event.clientY - pending.startClientY;
        if (Math.hypot(deltaX, deltaY) > CAMERA_DRAG_THRESHOLD_PX) {
          startCameraForwarding(pending.overlay, pending.pointerInit);
          continueCameraForwarding(event.nativeEvent);
          return;
        }
      }

      processPointerMove(event.currentTarget as HTMLDivElement, event.clientX, event.clientY, event.pointerId);
    },
    [continueCameraForwarding, processPointerMove, startCameraForwarding],
  );


  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) {
        return;
      }

      const pending = pendingPointerRef.current;
      pendingPointerRef.current = null;

      if (!pending || pending.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const pickInfo = pickAnchorAtEvent(event);
      if (!pickInfo) {
        showMessage('ไม่พบข้อมูลจุดในบริเวณนั้น', { persistent: false });
        return;
      }

      const { world: worldPoint, anchor } = pickInfo;

      if (isDistanceMode) {
        const baseNode = activeSharedNodeId ? getSharedNode(activeSharedNodeId) : null;
        if (!baseNode) {
          const registered = registerSharedNode(anchor, activeSharedNodeId);
          setMeasurementPoints([
            { local: { x: registered.local.x, y: registered.local.y, z: registered.local.z }, nodeIndex: registered.nodeIndex },
          ]);
          setActiveSharedNodeId(registered.id);
          setPreviewPoint(null);
          previewSnapAxisRef.current = null;
          setSelectedElement(null);
          showMessage('เลือกจุดแรกแล้ว คลิกจุดถัดไปเพื่อวัดต่อ', { persistent: true });
          return;
        }

        const baseAnchor: IndexedLocalPoint = {
          local: { x: baseNode.local.x, y: baseNode.local.y, z: baseNode.local.z },
          nodeIndex: baseNode.nodeIndex,
        };
        const baseWorld = resolveWorldPoint(baseAnchor);
        if (!baseWorld) {
          showMessage('ไม่สามารถจับตำแหน่งได้', { persistent: false });
          return;
        }

        let finalAnchor = anchor;
        let axis: SnapAxis | null = null;
        const snapResult = trySnapToAxis(baseWorld, worldPoint);
        if (snapResult) {
          const snappedLocal = toLocal(snapResult.point);
          if (!snappedLocal) {
            showMessage('ไม่สามารถจับตำแหน่งได้', { persistent: false });
            return;
          }
          finalAnchor = {
            local: { x: snappedLocal.x, y: snappedLocal.y, z: snappedLocal.z },
            nodeIndex: null,
          };
          axis = snapResult.axis;
        }

        const result = appendMeasurement(baseAnchor, finalAnchor, axis, { startNodeId: baseNode.id });
        setMeasurementPoints([
          {
            local: { x: result.endNode.local.x, y: result.endNode.local.y, z: result.endNode.local.z },
            nodeIndex: result.endNode.nodeIndex,
          },
        ]);
        setActiveSharedNodeId(result.endNode.id);
        setPreviewPoint(null);
        previewSnapAxisRef.current = null;
        showMessage('บันทึกระยะแล้ว คลิกต่อเพื่อเพิ่มจุด หรือกด Esc เพื่อหยุด', { persistent: true });
        return;
      }

      if (isAreaMode) {
        let finalAnchor = anchor;
        if (areaPoints.length > 0) {
          const lastAnchor = areaPoints[areaPoints.length - 1];
          const lastWorld = resolveWorldPoint(lastAnchor);
          if (!lastWorld) {
            showMessage('ไม่สามารถจับตำแหน่งได้', { persistent: false });
            return;
          }
          const snapResult = trySnapToAxis(lastWorld, worldPoint);
          if (snapResult) {
            const snappedLocal = toLocal(snapResult.point);
            if (!snappedLocal) {
              showMessage('ไม่สามารถจับตำแหน่งได้', { persistent: false });
              return;
            }
            finalAnchor = {
              local: { x: snappedLocal.x, y: snappedLocal.y, z: snappedLocal.z },
              nodeIndex: null,
            };
          }
        }

        setAreaPoints((prev) => {
          const next = [...prev, finalAnchor];
          if (next.length === 1) {
            showMessage('เพิ่มจุดอื่นเพื่อกำหนดพื้นที่', { persistent: true });
          } else if (next.length === 2) {
            showMessage('เพิ่มจุดต่อไป (ต้องมีอย่างน้อย 3 จุด)', { persistent: true });
          } else {
            showMessage('คลิกเพิ่มจุดต่อไป หรือคลิกขวาเพื่อปิดพื้นที่', { persistent: true });
          }
          return next;
        });
        setPreviewPoint(null);
        setSelectedElement(null);
      }
    },
    [
      isDistanceMode,
      isAreaMode,
      activeSharedNodeId,
      areaPoints,
      pickAnchorAtEvent,
      resolveWorldPoint,
      appendMeasurement,
      registerSharedNode,
      getSharedNode,
      showMessage,
      toLocal,
    ],
  );

  const handlePointerLeave = useCallback(() => {
    if (draggingHandleRef.current || areaVertexDragRef.current) {
      return;
    }
    setPreviewPoint(null);
  }, []);


  const overlayState: MeasurementOverlayState = useMemo(
    () => ({
      measurementScreenData,
      areaScreenData,
      areaPreview: areaPreviewScreen,
      axisGuides,
      baseProjection,
      previewProjection,
      previewLabel,
      previewAxisComponents,
      activeAxisLabel:
        isDistanceMode && previewSnapAxisRef.current
          ? `Snap: ${SNAP_AXIS_CONFIG[previewSnapAxisRef.current].label}`
          : null,
      pointerHandlers: {
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerUp,
        onPointerLeave: handlePointerLeave,
      },
      handleStartDrag: (event, measurementId, handle) => {
        startDragHandle(event, measurementId, handle);
      },
      handleStartAreaVertex: (event, areaId, vertexIndex, nodeId) => {
        startAreaVertexDrag(event, areaId, vertexIndex, nodeId);
      },
      isOverlayInteractive: Boolean(mode),
    }),
    [
      measurementScreenData,
      areaScreenData,
      areaPreviewScreen,
      axisGuides,
      baseProjection,
      previewProjection,
      previewLabel,
      previewAxisComponents,
      isDistanceMode,
      mode,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      handlePointerLeave,
      startDragHandle,
      startAreaVertexDrag,
    ],
  );

  const rescaleDialog: RescaleDialogState = {
    open: rescaleDialogOpen,
    metersInput: rescaleMetersInput,
    centimetersInput: rescaleCentimetersInput,
    setMetersInput: setRescaleMetersInput,
    setCentimetersInput: setRescaleCentimetersInput,
    onSubmit: handleRescaleSubmit,
    onClose: closeRescaleDialog,
  };

  return {
    mode,
    isDistanceMode,
    isAreaMode,
    toggleDistanceMode,
    toggleAreaMode,
    clearAll,
    overlayState,
    message,
    messageOffsetWithPanel: Boolean(
      (selectedElement?.type === 'distance' && selectedDistanceLabel) ||
      (selectedElement?.type === 'area' && selectedAreaLabel),
    ),
    setMessage: showMessage,
    selectedDistanceLabel,
    selectedDistanceChainLabel,
    selectedDistanceId: selectedElement?.type === 'distance' ? selectedElement.id : null,
    selectedAxisComponents,
    selectedMeasurementSegment: selectedMeasurement,
    selectedAreaLabel,
    selectedAreaPerimeterLabel,
    selectedAreaId: selectedElement?.type === 'area' ? selectedElement.id : null,
    selectDistance,
    selectArea,
    handleDeleteMeasurement,
    handleDeleteArea,
    openRescaleDialog,
    rescaleDialog,
  };
}
