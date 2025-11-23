import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { ScreenProjection, Vec3 } from '../useSplatScene';

export type SnapAxis = 'x' | 'y' | 'z';

export const SNAP_AXIS_CONFIG: Record<SnapAxis, { color: string; label: string; shortLabel: string }> = {
  x: { color: '#ef4444', label: 'แกน X', shortLabel: 'X' },
  y: { color: '#22c55e', label: 'แกน Y', shortLabel: 'Y' },
  z: { color: '#3b82f6', label: 'แกน Z', shortLabel: 'Z' },
};

type MeasurementModelSegment = {
  id: string;
  start: Vec3;
  end: Vec3;
};

export type MeasurementSegment = MeasurementModelSegment;

export type MeasurementScreenDatum = {
  id: string;
  startView: { x: number; y: number };
  endView: { x: number; y: number };
  midPoint: { x: number; y: number };
  label: string;
  isSelected: boolean;
};

type PreviewLine = {
  start: { x: number; y: number };
  end: { x: number; y: number };
  label: string;
  midPx: { x: number; y: number };
};

export type AxisComponentSummary = {
  values: Vec3;
  formatted: Record<SnapAxis, string>;
};

type PointerHandlers = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerLeave: () => void;
};

export interface MeasurementOverlayState {
  measurementScreenData: MeasurementScreenDatum[];
  previewLine: PreviewLine | null;
  pointerHandlers: PointerHandlers;
  handleStartDrag: (event: ReactPointerEvent, measurementId: string, handle: 'start' | 'end') => void;
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
  mode: 'distance' | null;
  isDistanceMode: boolean;
  toggleDistanceMode: () => void;
  clearAll: () => void;
  overlayState: MeasurementOverlayState;
  message: string | null;
  setMessage: (message: string | null) => void;
  messageOffsetWithPanel: boolean;
  selectedDistanceLabel: string | null;
  selectedDistanceId: string | null;
  selectedAxisComponents: AxisComponentSummary | null;
  selectedMeasurementSegment: MeasurementSegment | null;
  selectDistance: (id: string) => void;
  handleDeleteMeasurement: (id: string) => void;
  openRescaleDialog: () => void;
  rescaleDialog: RescaleDialogState;
}

interface UseMeasurementToolsOptions {
  pickWorldPoint: (canvasX: number, canvasY: number) => Vec3 | null;
  projectWorldToScreen: (position: Vec3) => ScreenProjection | null;
  modelToWorld: (local: Vec3) => Vec3 | null;
  worldToModel: (world: Vec3) => Vec3 | null;
  storageKey?: string | null;
}

type PersistedMeasurementState = {
  version: 1;
  scale: number;
  measurements: Array<{ id: string; start: Vec3; end: Vec3 }>;
  counter: number;
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

const formatAxisComponent = (value: number) => {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs < 1e-6) {
    return '0.000 m';
  }
  if (abs >= 100) {
    return `${value.toFixed(1)} m`;
  }
  if (abs >= 10) {
    return `${value.toFixed(2)} m`;
  }
  return `${value.toFixed(3)} m`;
};

const distanceBetween = (a: Vec3, b: Vec3) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};

export function useMeasurementTools({
  pickWorldPoint,
  projectWorldToScreen,
  modelToWorld,
  worldToModel,
  storageKey,
}: UseMeasurementToolsOptions): MeasurementTools {
  const [mode, setMode] = useState<'distance' | null>(null);
  const [anchorPoint, setAnchorPoint] = useState<Vec3 | null>(null);
  const [previewPoint, setPreviewPoint] = useState<Vec3 | null>(null);
  const [measurements, setMeasurements] = useState<MeasurementModelSegment[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [measurementScale, setMeasurementScale] = useState(1);
  const [rescaleDialogOpen, setRescaleDialogOpen] = useState(false);
  const [rescaleMetersInput, setRescaleMetersInput] = useState('');
  const [rescaleCentimetersInput, setRescaleCentimetersInput] = useState('');
  const dragRef = useRef<{ measurementId: string; target: 'start' | 'end'; pointerId: number } | null>(null);
  const measurementCounterRef = useRef(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const toModel = useCallback(
    (world: Vec3 | null): Vec3 | null => {
      if (!world) return null;
      return worldToModel ? worldToModel(world) : world;
    },
    [worldToModel],
  );

  const toWorld = useCallback(
    (model: Vec3 | null): Vec3 | null => {
      if (!model) return null;
      return modelToWorld ? modelToWorld(model) : model;
    },
    [modelToWorld],
  );

  const persistState = useCallback(
    (nextMeasurements: MeasurementModelSegment[], nextScale: number) => {
      if (!storageKey || typeof window === 'undefined') {
        return;
      }
      const payload: PersistedMeasurementState = {
        version: 1,
        scale: nextScale,
        measurements: nextMeasurements.map((m) => ({
          id: m.id,
          start: m.start,
          end: m.end,
        })),
        counter: measurementCounterRef.current,
      };
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(payload));
      } catch (err) {
        console.warn('Failed to persist measurements', err);
      }
    },
    [storageKey],
  );

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') {
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<PersistedMeasurementState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.measurements)) {
        return;
      }
      const restored = parsed.measurements
        .map((item) => {
          if (!item.id || !item.start || !item.end) return null;
          return {
            id: String(item.id),
            start: { x: item.start.x ?? 0, y: item.start.y ?? 0, z: item.start.z ?? 0 },
            end: { x: item.end.x ?? 0, y: item.end.y ?? 0, z: item.end.z ?? 0 },
          };
        })
        .filter(Boolean) as MeasurementModelSegment[];
      setMeasurements(restored);
      setMessage(null);
      measurementCounterRef.current = Math.max(parsed.counter ?? restored.length, restored.length);
      if (typeof parsed.scale === 'number' && Number.isFinite(parsed.scale) && parsed.scale > 0) {
        setMeasurementScale(parsed.scale);
      }
    } catch (err) {
      console.warn('Failed to restore measurement state', err);
    }
  }, [storageKey]);

  useEffect(() => {
    persistState(measurements, measurementScale);
  }, [measurements, measurementScale, persistState]);

  const addMeasurement = useCallback(
    (start: Vec3, end: Vec3) => {
      const id = `m-${measurementCounterRef.current++}`;
      setMeasurements((prev) => [...prev, { id, start, end }]);
      setSelectedId(id);
      setMessage('สร้างเส้นวัดแล้ว คลิกต่อเพื่อเพิ่มจุดหรือกด ESC เพื่อออก');
    },
    [],
  );

  const pickAtEvent = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): Vec3 | null => {
      const overlay = overlayRef.current;
      if (!overlay) {
        return null;
      }
      const rect = overlay.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const world = pickWorldPoint(x, y);
      return toModel(world);
    },
    [pickWorldPoint, toModel],
  );

  const formatAxisSummary = useCallback(
    (start: Vec3, end: Vec3): AxisComponentSummary => {
      const dx = (end.x - start.x) * measurementScale;
      const dy = (end.y - start.y) * measurementScale;
      const dz = (end.z - start.z) * measurementScale;
      return {
        values: { x: dx, y: dy, z: dz },
        formatted: {
          x: formatAxisComponent(dx),
          y: formatAxisComponent(dy),
          z: formatAxisComponent(dz),
        },
      };
    },
    [measurementScale],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!mode) {
        return;
      }

      overlayRef.current = event.currentTarget;

      if (event.button === 2) {
        event.preventDefault();
        setAnchorPoint(null);
        setPreviewPoint(null);
        setMessage('ยกเลิกการเชื่อมต่อจุดแล้ว');
        return;
      }

      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const pickedModel = pickAtEvent(event);
      if (!pickedModel) {
        setMessage('ไม่พบตำแหน่งสำหรับวัด');
        return;
      }

      if (!anchorPoint) {
        setAnchorPoint(pickedModel);
        setPreviewPoint(null);
        setMessage('เลือกจุดถัดไปเพื่อสร้างเส้นวัด');
        return;
      }

      addMeasurement(anchorPoint, pickedModel);
      setAnchorPoint(pickedModel);
      setPreviewPoint(null);
    },
    [mode, pickAtEvent, anchorPoint, addMeasurement],
  );

  const updateDraggingMeasurement = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.pointerId !== pointerId) return;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const rect = overlay.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const world = pickWorldPoint(x, y);
      const model = toModel(world);
      if (!model) return;

      setMeasurements((prev) =>
        prev.map((segment) => {
          if (segment.id !== drag.measurementId) {
            return segment;
          }
          return drag.target === 'start'
            ? { ...segment, start: { ...model } }
            : { ...segment, end: { ...model } };
        }),
      );
      setPreviewPoint(null);
      setAnchorPoint(null);
    },
    [pickWorldPoint, toModel],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!mode) {
        return;
      }
      if (!overlayRef.current) {
        overlayRef.current = event.currentTarget;
      }
      if (dragRef.current) {
        updateDraggingMeasurement(event.pointerId, event.clientX, event.clientY);
        return;
      }

      const pickedModel = pickAtEvent(event);
      if (!pickedModel) {
        setPreviewPoint(null);
        return;
      }

      if (anchorPoint) {
        setPreviewPoint(pickedModel);
      }
    },
    [mode, anchorPoint, pickAtEvent, updateDraggingMeasurement],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (dragRef.current && dragRef.current.pointerId === event.pointerId) {
        dragRef.current = null;
      }
    },
    [],
  );

  const handlePointerLeave = useCallback(() => {
    if (dragRef.current) {
      return;
    }
    setPreviewPoint(null);
  }, []);

  const handleStartDrag = useCallback(
    (event: ReactPointerEvent, measurementId: string, target: 'start' | 'end') => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = { measurementId, target, pointerId: event.pointerId };
      const current = event.currentTarget as HTMLElement | null;
      current?.setPointerCapture?.(event.pointerId);
      setSelectedId(measurementId);
    },
    [],
  );

  const toggleDistanceMode = useCallback(() => {
    setMode((prev) => {
      if (prev === 'distance') {
        setAnchorPoint(null);
        setPreviewPoint(null);
        setMessage(null);
        dragRef.current = null;
        return null;
      }
      setMessage('โหมดวัดระยะ: คลิก 2 จุดเพื่อสร้างเส้น');
      return 'distance';
    });
  }, []);

  const clearAll = useCallback(() => {
    setMeasurements([]);
    setAnchorPoint(null);
    setPreviewPoint(null);
    setSelectedId(null);
    setMessage(null);
    measurementCounterRef.current = 0;
  }, []);

  const selectDistance = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const handleDeleteMeasurement = useCallback(
    (id: string) => {
      setMeasurements((prev) => prev.filter((segment) => segment.id !== id));
      if (selectedId === id) {
        setSelectedId(null);
      }
    },
    [selectedId],
  );

  const measurementScreenData = useMemo<MeasurementScreenDatum[]>(() => {
    return measurements
      .map((segment) => {
        const startWorld = toWorld(segment.start);
        const endWorld = toWorld(segment.end);
        if (!startWorld || !endWorld) {
          return null;
        }
        const startProj = projectWorldToScreen(startWorld);
        const endProj = projectWorldToScreen(endWorld);
        if (!startProj || !endProj || !startProj.visible || !endProj.visible) {
          return null;
        }
        const distance = distanceBetween(startWorld, endWorld) * measurementScale;
        return {
          id: segment.id,
          startView: { x: startProj.nx * 100, y: startProj.ny * 100 },
          endView: { x: endProj.nx * 100, y: endProj.ny * 100 },
          midPoint: {
            x: (startProj.x + endProj.x) * 0.5,
            y: (startProj.y + endProj.y) * 0.5,
          },
          label: formatDistance(distance),
          isSelected: selectedId === segment.id,
        };
      })
      .filter(Boolean) as MeasurementScreenDatum[];
  }, [measurements, projectWorldToScreen, selectedId, toWorld, measurementScale]);

  const previewLine = useMemo<PreviewLine | null>(() => {
    if (!anchorPoint || !previewPoint) {
      return null;
    }
    const anchorWorld = toWorld(anchorPoint);
    const previewWorld = toWorld(previewPoint);
    if (!anchorWorld || !previewWorld) {
      return null;
    }
    const startProj = projectWorldToScreen(anchorWorld);
    const endProj = projectWorldToScreen(previewWorld);
    if (!startProj || !endProj || !startProj.visible || !endProj.visible) {
      return null;
    }
    const distance = distanceBetween(anchorWorld, previewWorld) * measurementScale;
    return {
      start: { x: startProj.nx * 100, y: startProj.ny * 100 },
      end: { x: endProj.nx * 100, y: endProj.ny * 100 },
      label: formatDistance(distance),
      midPx: { x: (startProj.x + endProj.x) * 0.5, y: (startProj.y + endProj.y) * 0.5 },
    };
  }, [anchorPoint, previewPoint, projectWorldToScreen, toWorld, measurementScale]);

  const selectedMeasurement = useMemo(() => {
    return measurements.find((m) => m.id === selectedId) ?? null;
  }, [measurements, selectedId]);

  const selectedDistanceLabel = useMemo(() => {
    if (!selectedMeasurement) {
      return null;
    }
    const startWorld = toWorld(selectedMeasurement.start);
    const endWorld = toWorld(selectedMeasurement.end);
    if (!startWorld || !endWorld) return null;
    return formatDistance(distanceBetween(startWorld, endWorld) * measurementScale);
  }, [selectedMeasurement, toWorld, measurementScale]);

  const selectedAxisComponents = useMemo(() => {
    if (!selectedMeasurement) return null;
    return formatAxisSummary(selectedMeasurement.start, selectedMeasurement.end);
  }, [formatAxisSummary, selectedMeasurement]);

  const openRescaleDialog = useCallback(() => {
    if (!selectedMeasurement) {
      setMessage('กรุณาเลือกเส้นวัดก่อนปรับมาตราส่วน');
      return;
    }
    setRescaleDialogOpen(true);
    setRescaleMetersInput('');
    setRescaleCentimetersInput('');
  }, [selectedMeasurement]);

  const closeRescaleDialog = useCallback(() => {
    setRescaleDialogOpen(false);
  }, []);

  const handleRescaleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!selectedMeasurement) {
        closeRescaleDialog();
        return;
      }
      const meters = Number.parseFloat(rescaleMetersInput || '0') || 0;
      const centimeters = Number.parseFloat(rescaleCentimetersInput || '0') || 0;
      const desired = meters + centimeters / 100;
      if (!(desired > 0)) {
        return;
      }
      const startWorld = toWorld(selectedMeasurement.start);
      const endWorld = toWorld(selectedMeasurement.end);
      if (!startWorld || !endWorld) {
        return;
      }
      const currentLength = distanceBetween(startWorld, endWorld) * measurementScale;
      if (currentLength <= 0) {
        return;
      }
      const factor = desired / currentLength;
      setMeasurementScale((prev) => prev * factor);
      setMessage('ปรับมาตราส่วนเรียบร้อยแล้ว');
      closeRescaleDialog();
    },
    [closeRescaleDialog, rescaleCentimetersInput, rescaleMetersInput, selectedMeasurement, toWorld, measurementScale],
  );

  const pointerHandlers: PointerHandlers = useMemo(
    () => ({
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerLeave,
    }),
    [handlePointerDown, handlePointerMove, handlePointerUp, handlePointerLeave],
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
    isDistanceMode: mode === 'distance',
    toggleDistanceMode,
    clearAll,
    overlayState: {
      measurementScreenData,
      previewLine,
      pointerHandlers,
      handleStartDrag,
      isOverlayInteractive: Boolean(mode),
    },
    message,
    setMessage,
    messageOffsetWithPanel: Boolean(selectedMeasurement),
    selectedDistanceLabel,
    selectedDistanceId: selectedId,
    selectedAxisComponents,
    selectedMeasurementSegment: selectedMeasurement,
    selectDistance,
    handleDeleteMeasurement,
    openRescaleDialog,
    rescaleDialog,
  };
}
