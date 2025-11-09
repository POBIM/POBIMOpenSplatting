import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { RefObject } from 'react';

import type {
  PointPickResult,
  ScreenProjection,
  Vec3,
} from '../useSplatScene';

export type PointSelectionMode = 'picker' | 'rectangle' | 'polygon';
export type SelectionModifier = 'set' | 'add' | 'toggle';

export interface CanvasPoint {
  x: number;
  y: number;
}

export interface RectangleSelectionOverlay {
  origin: CanvasPoint;
  current: CanvasPoint;
  modifier: SelectionModifier;
}

export interface PolygonSelectionOverlay {
  points: CanvasPoint[];
  preview: CanvasPoint | null;
  modifier: SelectionModifier;
  isDrawing: boolean;
}

export interface PointEditorSelectionEntry {
  index: number;
  world: Vec3 | null;
  screen: ScreenProjection | null;
}

interface UsePointEditorOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  pickPoint: (x: number, y: number) => PointPickResult | null;
  projectWorldToScreen: (position: Vec3) => ScreenProjection | null;
  getPointWorldPosition: (index: number) => Vec3 | null;
  worldToModel: (position: Vec3) => Vec3 | null;
  forEachVisiblePoint: (callback: (index: number, local: Vec3, world: Vec3) => void | boolean) => void;
  mutatePointPositions: (
    indices: number[],
    mutator: (position: Vec3, index: number) => Vec3 | null,
  ) => boolean;
  setPointsHidden: (indices: number[], hidden: boolean) => void;
  clearHiddenPoints: () => void;
  setSelectedPoints: (indices: number[]) => void;
  hiddenPointCount: number;
  totalPointCount: number;
  sourceKey: string | null;
}

interface UsePointEditorResult {
  active: boolean;
  setActive: (value: boolean) => void;
  toggleActive: () => void;
  resetState: () => void;

  selection: number[];
  selectionEntries: PointEditorSelectionEntry[];
  hoveredEntry: PointEditorSelectionEntry | null;
  selectionCount: number;
  hiddenCount: number;
  totalCount: number;

  selectionMode: PointSelectionMode;
  setSelectionMode: (mode: PointSelectionMode) => void;
  rectangleSelection: RectangleSelectionOverlay | null;
  polygonOverlay: PolygonSelectionOverlay;
  completePolygonSelection: () => void;
  cancelPolygonSelection: () => void;

  nudgeStep: number;
  setNudgeStep: (value: number) => void;
  nudgeSelection: (axis: keyof Vec3, delta: number) => void;
  rotateSelection: (axis: keyof Vec3, degrees: number) => void;

  clearSelection: () => void;
  deleteSelection: () => void;
  unhideAll: () => void;
}

const canvasCoordinates = (canvas: HTMLCanvasElement, event: PointerEvent): CanvasPoint => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
};

const determineModifier = (event: PointerEvent): SelectionModifier => {
  if (event.shiftKey) {
    return 'add';
  }
  if (event.metaKey || event.ctrlKey) {
    return 'toggle';
  }
  return 'set';
};

const normalizeRectangle = (origin: CanvasPoint, current: CanvasPoint) => {
  const minX = Math.min(origin.x, current.x);
  const maxX = Math.max(origin.x, current.x);
  const minY = Math.min(origin.y, current.y);
  const maxY = Math.max(origin.y, current.y);
  return { minX, maxX, minY, maxY };
};

const isPointInPolygon = (point: CanvasPoint, polygon: CanvasPoint[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) {
      inside = !inside;
    }
  }
  return inside;
};

const areSelectionsEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

export function usePointEditor({
  canvasRef,
  pickPoint,
  projectWorldToScreen,
  getPointWorldPosition,
  worldToModel,
  forEachVisiblePoint,
  mutatePointPositions,
  setPointsHidden,
  clearHiddenPoints,
  setSelectedPoints,
  hiddenPointCount,
  totalPointCount,
  sourceKey,
}: UsePointEditorOptions): UsePointEditorResult {
  const [active, setActive] = useState(false);
  const [selection, setSelection] = useState<number[]>([]);
  const [hoveredEntry, setHoveredEntry] = useState<PointEditorSelectionEntry | null>(null);
  const [selectionMode, setSelectionModeState] = useState<PointSelectionMode>('picker');
  const [rectangleSelection, setRectangleSelection] = useState<RectangleSelectionOverlay | null>(null);
  const [polygonPoints, setPolygonPoints] = useState<CanvasPoint[]>([]);
  const polygonPointsRef = useRef<CanvasPoint[]>([]);
  const [polygonPreview, setPolygonPreview] = useState<CanvasPoint | null>(null);
  const polygonModifierRef = useRef<SelectionModifier>('set');
  const polygonDrawingRef = useRef(false);
  const [nudgeStep, setNudgeStep] = useState(0.05);
  const dragPointerIdRef = useRef<number | null>(null);

  const selectionEntries = useMemo<PointEditorSelectionEntry[]>(() => {
    if (selection.length === 0) {
      return [];
    }
    return selection.map((index) => {
      const world = getPointWorldPosition(index);
      const screen = world ? projectWorldToScreen(world) : null;
      return {
        index,
        world,
        screen,
      };
    });
  }, [selection, getPointWorldPosition, projectWorldToScreen]);

  const selectionCount = selection.length;

  const updateSelection = useCallback(
    (indices: number[], modifier: SelectionModifier) => {
      const unique = Array.from(new Set(indices));
      if (unique.length === 0 && modifier === 'set') {
        setSelection((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      setSelection((prev) => {
        const set = new Set(prev);
        if (modifier === 'set') {
          const next = unique.slice().sort((a, b) => a - b);
          return areSelectionsEqual(prev, next) ? prev : next;
        }
        if (modifier === 'add') {
          unique.forEach((value) => set.add(value));
        } else if (modifier === 'toggle') {
          unique.forEach((value) => {
            if (set.has(value)) {
              set.delete(value);
            } else {
              set.add(value);
            }
          });
        }
        const next = Array.from(set).sort((a, b) => a - b);
        return areSelectionsEqual(prev, next) ? prev : next;
      });
    },
    [],
  );

  const applySelectionFromPredicate = useCallback(
    (modifier: SelectionModifier, predicate: (screen: ScreenProjection) => boolean) => {
      const indices: number[] = [];
      forEachVisiblePoint((index, _local, world) => {
        const screen = projectWorldToScreen(world);
        if (!screen || !screen.visible) {
          return;
        }
        if (predicate(screen)) {
          indices.push(index);
        }
      });
      updateSelection(indices, modifier);
    },
    [forEachVisiblePoint, projectWorldToScreen, updateSelection],
  );

  const performPickerSelection = useCallback(
    (canvasX: number, canvasY: number, modifier: SelectionModifier) => {
      const result = pickPoint(canvasX, canvasY);
      if (!result) {
        if (modifier === 'set') {
          setSelection((prev) => (prev.length === 0 ? prev : []));
        }
        return;
      }
      updateSelection([result.index], modifier);
    },
    [pickPoint, updateSelection],
  );

  const hideSelection = useCallback(() => {
    if (selection.length === 0) {
      return;
    }
    setPointsHidden(selection, true);
    setSelection([]);
    setHoveredEntry(null);
  }, [selection, setPointsHidden]);

  const unhideAll = useCallback(() => {
    clearHiddenPoints();
  }, [clearHiddenPoints]);

  const nudgeSelection = useCallback(
    (axis: keyof Vec3, delta: number) => {
      if (selection.length === 0 || delta === 0) {
        return;
      }
      const changed = mutatePointPositions(selection, (position) => {
        const next = { ...position };
        next[axis] += delta;
        return next;
      });
      if (changed) {
        setSelection((prev) => [...prev]);
      }
    },
    [selection, mutatePointPositions],
  );

  const rotateSelection = useCallback(
    (axis: keyof Vec3, degrees: number) => {
      if (selection.length === 0 || !Number.isFinite(degrees) || degrees === 0) {
        return;
      }
      const radians = (degrees * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);

      const center = selection.reduce<Vec3 | null>((acc, index) => {
        const world = getPointWorldPosition(index);
        if (!world) {
          return acc;
        }
        if (!acc) {
          return { ...world };
        }
        return {
          x: acc.x + world.x,
          y: acc.y + world.y,
          z: acc.z + world.z,
        };
      }, null);

      if (!center) {
        return;
      }
      center.x /= selection.length;
      center.y /= selection.length;
      center.z /= selection.length;

      const changed = mutatePointPositions(selection, (_local, index) => {
        const world = getPointWorldPosition(index);
        if (!world) {
          return null;
        }
        const shifted = {
          x: world.x - center.x,
          y: world.y - center.y,
          z: world.z - center.z,
        };
        let rotated: Vec3 = { ...shifted };
        switch (axis) {
          case 'x':
            rotated = {
              x: shifted.x,
              y: shifted.y * cos - shifted.z * sin,
              z: shifted.y * sin + shifted.z * cos,
            };
            break;
          case 'y':
            rotated = {
              x: shifted.x * cos + shifted.z * sin,
              y: shifted.y,
              z: -shifted.x * sin + shifted.z * cos,
            };
            break;
          case 'z':
          default:
            rotated = {
              x: shifted.x * cos - shifted.y * sin,
              y: shifted.x * sin + shifted.y * cos,
              z: shifted.z,
            };
            break;
        }
        const rotatedWorld = {
          x: rotated.x + center.x,
          y: rotated.y + center.y,
          z: rotated.z + center.z,
        };
        return worldToModel(rotatedWorld);
      });

      if (changed) {
        setSelection((prev) => [...prev]);
      }
    },
    [selection, mutatePointPositions, getPointWorldPosition, worldToModel],
  );

  const clearSelection = useCallback(() => {
    setSelection([]);
    setHoveredEntry(null);
  }, []);

  const toggleActive = useCallback(() => {
    setActive((prev) => !prev);
  }, []);

  const resetState = useCallback(() => {
    setActive(false);
    setSelection([]);
    setHoveredEntry(null);
    setRectangleSelection(null);
    polygonDrawingRef.current = false;
    polygonPointsRef.current = [];
    setPolygonPoints([]);
    setPolygonPreview(null);
  }, []);

  const setSelectionMode = useCallback((mode: PointSelectionMode) => {
    setSelectionModeState(mode);
    setRectangleSelection(null);
    polygonDrawingRef.current = false;
    polygonPointsRef.current = [];
    setPolygonPoints([]);
    setPolygonPreview(null);
  }, []);

  const completePolygonSelection = useCallback(() => {
    if (!polygonDrawingRef.current || polygonPointsRef.current.length < 3) {
      polygonDrawingRef.current = false;
      polygonPointsRef.current = [];
      setPolygonPoints([]);
      setPolygonPreview(null);
      return;
    }
    const modifier = polygonModifierRef.current;
    const polygon = polygonPointsRef.current.slice();
    applySelectionFromPredicate(modifier, (screen) => isPointInPolygon({ x: screen.x, y: screen.y }, polygon));
    polygonDrawingRef.current = false;
    polygonPointsRef.current = [];
    setPolygonPoints([]);
    setPolygonPreview(null);
  }, [applySelectionFromPredicate]);

  const cancelPolygonSelection = useCallback(() => {
    polygonDrawingRef.current = false;
    polygonPointsRef.current = [];
    setPolygonPoints([]);
    setPolygonPreview(null);
  }, []);

  useEffect(() => {
    setSelectedPoints(selection);
  }, [selection, setSelectedPoints]);

  useEffect(() => {
    if (!active) {
      setHoveredEntry(null);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button === 2) {
        if (selectionMode === 'polygon' && polygonDrawingRef.current) {
          cancelPolygonSelection();
        }
        return;
      }

      const { x, y } = canvasCoordinates(canvas, event);
      const modifier = determineModifier(event);

      if (selectionMode === 'picker') {
        performPickerSelection(x, y, modifier);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (selectionMode === 'rectangle') {
        dragPointerIdRef.current = event.pointerId;
        canvas.setPointerCapture(event.pointerId);
        const overlay: RectangleSelectionOverlay = { origin: { x, y }, current: { x, y }, modifier };
        setRectangleSelection(overlay);
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (selectionMode === 'polygon') {
        event.preventDefault();
        event.stopPropagation();
        polygonModifierRef.current = polygonDrawingRef.current ? polygonModifierRef.current : modifier;
        if (!polygonDrawingRef.current) {
          polygonDrawingRef.current = true;
          polygonPointsRef.current = [{ x, y }];
        } else {
          polygonPointsRef.current = [...polygonPointsRef.current, { x, y }];
        }
        setPolygonPoints(polygonPointsRef.current.slice());
        setPolygonPreview({ x, y });

        if (event.detail > 1 && polygonPointsRef.current.length >= 3) {
          completePolygonSelection();
        }
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const { x, y } = canvasCoordinates(canvas, event);

      if (selectionMode === 'rectangle' && dragPointerIdRef.current === event.pointerId && rectangleSelection) {
        setRectangleSelection({ ...rectangleSelection, current: { x, y } });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (selectionMode === 'polygon' && polygonDrawingRef.current) {
        setPolygonPreview({ x, y });
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (selectionMode === 'picker') {
        const result = pickPoint(x, y);
        if (!result) {
          setHoveredEntry(null);
          return;
        }
        const world = getPointWorldPosition(result.index) ?? result.world ?? null;
        const screen = world ? projectWorldToScreen(world) : null;
        setHoveredEntry({ index: result.index, world, screen });
      }
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (selectionMode === 'rectangle' && dragPointerIdRef.current === event.pointerId && rectangleSelection) {
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch (error) {
          // ignore
        }
        const { origin, current, modifier } = rectangleSelection;
        const { minX, maxX, minY, maxY } = normalizeRectangle(origin, current);
        applySelectionFromPredicate(modifier, (screen) => {
          return screen.x >= minX && screen.x <= maxX && screen.y >= minY && screen.y <= maxY;
        });
        setRectangleSelection(null);
        dragPointerIdRef.current = null;
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const handlePointerLeave = () => {
      if (selectionMode === 'picker') {
        setHoveredEntry(null);
      }
      if (selectionMode === 'rectangle') {
        setRectangleSelection(null);
        dragPointerIdRef.current = null;
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointerleave', handlePointerLeave);
    canvas.addEventListener('contextmenu', handleContextMenu);

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointerleave', handlePointerLeave);
      canvas.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [
    active,
    applySelectionFromPredicate,
    cancelPolygonSelection,
    canvasRef,
    getPointWorldPosition,
    performPickerSelection,
    pickPoint,
    projectWorldToScreen,
    rectangleSelection,
    selectionMode,
  ]);

  useEffect(() => {
    if (!polygonDrawingRef.current) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelPolygonSelection();
      }
      if (event.key === 'Enter') {
        completePolygonSelection();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [cancelPolygonSelection, completePolygonSelection]);

  useEffect(() => {
    if (sourceKey === null) {
      resetState();
      return;
    }
    setSelection([]);
    setHoveredEntry(null);
    setRectangleSelection(null);
    polygonDrawingRef.current = false;
    polygonPointsRef.current = [];
    setPolygonPoints([]);
    setPolygonPreview(null);
  }, [sourceKey, resetState]);

  useEffect(() => {
    if (!active) {
      setRectangleSelection(null);
      polygonDrawingRef.current = false;
      polygonPointsRef.current = [];
      setPolygonPoints([]);
      setPolygonPreview(null);
    }
  }, [active]);

  const polygonOverlay: PolygonSelectionOverlay = useMemo(() => ({
    points: polygonPoints,
    preview: polygonPreview,
    modifier: polygonModifierRef.current,
    isDrawing: polygonDrawingRef.current,
  }), [polygonPoints, polygonPreview]);

  return {
    active,
    setActive,
    toggleActive,
    resetState,
    selection,
    selectionEntries,
    hoveredEntry,
    selectionCount,
    hiddenCount: hiddenPointCount,
    totalCount: totalPointCount,
    selectionMode,
    setSelectionMode,
    rectangleSelection,
    polygonOverlay,
    completePolygonSelection,
    cancelPolygonSelection,
    nudgeStep,
    setNudgeStep,
    nudgeSelection,
    rotateSelection,
    clearSelection,
    deleteSelection: hideSelection,
    unhideAll,
  };
}
