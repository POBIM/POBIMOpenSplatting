'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { InfoPanel } from './splat-viewer/InfoPanel';
import { TransformPanel } from './splat-viewer/TransformPanel';
import { CameraControlPanel } from './splat-viewer/CameraControlPanel';
import { ViewCube } from './splat-viewer/ViewCube';
import { IconSidebar } from './splat-viewer/IconSidebar';
import { Vec3, useSplatScene } from './splat-viewer/useSplatScene';
import { useMeasurementTools, type SnapAxis } from './splat-viewer/measurement/useMeasurementTools';
import { MeasurementOverlay } from './splat-viewer/measurement/MeasurementOverlay';
import { usePointEditor } from './splat-viewer/point-editor/usePointEditor';
import { PointEditorOverlay } from './splat-viewer/point-editor/PointEditorOverlay';
import { PointEditorPanel } from './splat-viewer/point-editor/PointEditorPanel';
import { Crosshair } from './splat-viewer/Crosshair';
import { UploadCloud } from 'lucide-react';
import api from '@/lib/api';

const DEFAULT_ROTATION: Vec3 = { x: 0, y: 0, z: 0 };
const DEFAULT_POSITION: Vec3 = { x: 0, y: 0, z: 0 };
const KEYBOARD_ZOOM_FINE_FACTOR = 0.4;
const KEYBOARD_ZOOM_MIN_STEP = 0.03;

type LocalProjectSelection = {
  objectUrl: string;
  name: string;
  size: number;
  lastModified: number;
  measurementKey: string;
};

const formatFileSize = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[exponent]}`;
};

export default function SplatViewer() {
  const searchParams = useSearchParams();
  const fileUrlParam = searchParams ? searchParams.get('file') ?? searchParams.get('url') : null;
  const projectId = searchParams?.get('project') ?? null;

  const remotePlyUrl = useMemo(() => {
    if (fileUrlParam) return fileUrlParam;
    if (projectId) {
      const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
      return `${apiBaseUrl}/api/ply/${projectId}`;
    }
    return null;
  }, [fileUrlParam, projectId]);

  const [localProject, setLocalProject] = useState<LocalProjectSelection | null>(null);
  const [localUploadError, setLocalUploadError] = useState<string | null>(null);
  const [localDragActive, setLocalDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!projectId && !fileUrlParam) {
      return;
    }
    setLocalProject((previous) => {
      if (previous?.objectUrl) {
        URL.revokeObjectURL(previous.objectUrl);
      }
      return null;
    });
    setLocalUploadError(null);
  }, [projectId, fileUrlParam]);

  const activePlyUrl = useMemo(() => {
    return localProject?.objectUrl ?? remotePlyUrl;
  }, [localProject, remotePlyUrl]);

  const infoFileLabel = localProject ? localProject.name : remotePlyUrl;
  const viewerActive = Boolean(activePlyUrl);
  const showLocalUploadOverlay = !projectId && !fileUrlParam && !viewerActive;

  const measurementStorageKey = useMemo(() => {
    if (localProject) {
      return localProject.measurementKey;
    }
    if (!activePlyUrl) {
      return null;
    }
    return `pobim:measure:${encodeURIComponent(activePlyUrl)}`;
  }, [activePlyUrl, localProject]);

  const {
    canvasRef,
    loading,
    error,
    splatCount,
    hiddenPointCount,
    totalPointCount,
    resetScene,
    syncModelPosition,
    syncModelRotation,
    adjustZoom,
    cameraAxes,
    alignCamera,
    backgroundOptions,
    activeBackground,
    setBackground,
    showGrid,
    setGridVisible,
    showAxes,
    setAxesVisible,
    pickWorldPoint,
    pickPoint,
    projectWorldToScreen,
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
    mutatePointPositions,
    setPointsHidden,
    clearHiddenPoints,
    setSelectedPoints,
    forEachVisiblePoint,
  } = useSplatScene(activePlyUrl);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [showTransformPanel, setShowTransformPanel] = useState(false);
  const [showCameraControls, setShowCameraControls] = useState(false);
  const [modelRotation, setModelRotation] = useState<Vec3>(() => ({ ...DEFAULT_ROTATION }));
  const [modelPosition, setModelPosition] = useState<Vec3>(() => ({ ...DEFAULT_POSITION }));
  const [transformLoaded, setTransformLoaded] = useState(false);
  const [alignmentAxis, setAlignmentAxis] = useState<SnapAxis>('x');
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const viewerExitArmRef = useRef<{ armed: boolean; timer: number | null }>({ armed: false, timer: null });

  const measurement = useMeasurementTools({
    pickWorldPoint,
    projectWorldToScreen,
    worldToModel,
    modelToWorld,
    storageKey: measurementStorageKey,
  });

  const {
    mode: measureMode,
    isDistanceMode,
    toggleDistanceMode,
    clearAll,
    overlayState,
    message: measurementMessage,
    messageOffsetWithPanel,
    selectedDistanceLabel,
    selectedDistanceId,
    selectedAxisComponents,
    selectedMeasurementSegment,
    selectDistance,
    handleDeleteMeasurement,
    openRescaleDialog,
    rescaleDialog,
    setMessage: setMeasurementMessage,
  } = measurement;

  const {
    open: rescaleDialogOpen,
    metersInput: rescaleMetersInput,
    centimetersInput: rescaleCentimetersInput,
    setMetersInput: setRescaleMetersInput,
    setCentimetersInput: setRescaleCentimetersInput,
    onSubmit: handleRescaleSubmit,
    onClose: closeRescaleDialog,
  } = rescaleDialog;

  const pointEditor = usePointEditor({
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
    sourceKey: activePlyUrl,
  });

  const {
    active: pointEditorActive,
    toggleActive: togglePointEditorActive,
    selectionEntries: pointSelectionEntries,
    hoveredEntry: pointHoveredEntry,
    selectionCount: pointSelectionCount,
    hiddenCount: pointHiddenCount,
    totalCount: pointTotalCount,
    selectionMode: pointSelectionMode,
    setSelectionMode: setPointSelectionMode,
    rectangleSelection: pointRectangleSelection,
    polygonOverlay: pointPolygonOverlay,
    completePolygonSelection,
    cancelPolygonSelection,
    nudgeStep: pointNudgeStep,
    setNudgeStep: setPointNudgeStep,
    nudgeSelection: nudgeSelectedPoints,
    rotateSelection: rotateSelectedPoints,
    clearSelection: clearPointSelection,
    deleteSelection: deleteSelectedPoints,
    unhideAll: unhideAllHiddenPoints,
  } = pointEditor;

  const [pointRotationStep, setPointRotationStep] = useState(5);

  useEffect(() => {
    return () => {
      if (localProject?.objectUrl) {
        URL.revokeObjectURL(localProject.objectUrl);
      }
    };
  }, [localProject]);

  const triggerLocalFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const clearLocalProject = useCallback(() => {
    setLocalProject((previous) => {
      if (previous?.objectUrl) {
        URL.revokeObjectURL(previous.objectUrl);
      }
      return null;
    });
    setLocalUploadError(null);
  }, []);

  const handleChooseAnotherLocalFile = useCallback(() => {
    clearLocalProject();
    // Delay opening the dialog until the state update finishes in the next frame.
    requestAnimationFrame(() => {
      triggerLocalFileDialog();
    });
  }, [clearLocalProject, triggerLocalFileDialog]);

  const processLocalFile = useCallback((file: File) => {
    const extension = file.name.toLowerCase().split('.').pop();
    if (extension !== 'ply') {
      setLocalUploadError('รองรับเฉพาะไฟล์ Gaussian Splat (.ply)');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const measurementKey = `pobim:measure:local:${encodeURIComponent(file.name)}:${file.size}:${file.lastModified}`;
    const nextProject: LocalProjectSelection = {
      objectUrl,
      name: file.name,
      size: file.size,
      lastModified: file.lastModified,
      measurementKey,
    };

    setLocalProject((previous) => {
      if (previous?.objectUrl) {
        URL.revokeObjectURL(previous.objectUrl);
      }
      return nextProject;
    });
    setLocalUploadError(null);
  }, []);

  const handleLocalFileInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        processLocalFile(file);
      }
      event.target.value = '';
    },
    [processLocalFile],
  );

  const handleLocalDragEnter = useCallback((event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setLocalDragActive(true);
  }, []);

  const handleLocalDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handleLocalDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    // Ignore dragleave events that move between child elements
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    setLocalDragActive(false);
  }, []);

  const handleLocalDrop = useCallback(
    (event: DragEvent<HTMLFormElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setLocalDragActive(false);

      const file = event.dataTransfer?.files?.[0];
      if (file) {
        processLocalFile(file);
      }
    },
    [processLocalFile],
  );

  // Save transformation to backend (debounced)
  const saveTransformation = useCallback((position: Vec3, rotation: Vec3) => {
    if (!projectId || !transformLoaded) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(async () => {
      try {
        await api.saveTransformation(projectId, {
          position,
          rotation,
        });
      } catch (error) {
        console.error('Failed to save transformation:', error);
      }
    }, 300);
  }, [projectId, transformLoaded]);

  const hasFloatingPanel = messageOffsetWithPanel;
  const hasMeasurements = overlayState.measurementScreenData.length > 0;

  const applyModelTransform = useCallback(
    (nextPosition: Vec3, nextRotation: Vec3, options?: { persist?: boolean }) => {
      const persist = options?.persist ?? true;

      const positionChanged =
        Math.abs(nextPosition.x - modelPosition.x) > 1e-6 ||
        Math.abs(nextPosition.y - modelPosition.y) > 1e-6 ||
        Math.abs(nextPosition.z - modelPosition.z) > 1e-6;

      const rotationChanged =
        Math.abs(nextRotation.x - modelRotation.x) > 1e-6 ||
        Math.abs(nextRotation.y - modelRotation.y) > 1e-6 ||
        Math.abs(nextRotation.z - modelRotation.z) > 1e-6;

      if (!positionChanged && !rotationChanged) {
        return;
      }

      if (positionChanged) {
        setModelPosition({ ...nextPosition });
        syncModelPosition(nextPosition);
      }

      if (rotationChanged) {
        setModelRotation({ ...nextRotation });
        syncModelRotation(nextRotation);
      }

      if (persist) {
        const positionForSave = positionChanged ? nextPosition : modelPosition;
        const rotationForSave = rotationChanged ? nextRotation : modelRotation;
        saveTransformation({ ...positionForSave }, { ...rotationForSave });
      }
    },
    [
      modelPosition,
      modelRotation,
      syncModelPosition,
      syncModelRotation,
      saveTransformation,
    ],
  );

  const applyModelRotation = useCallback(
    (nextRotation: Vec3, options?: { persist?: boolean }) => {
      applyModelTransform(modelPosition, nextRotation, options);
    },
    [applyModelTransform, modelPosition],
  );

  const applyModelPosition = useCallback(
    (nextPosition: Vec3, options?: { persist?: boolean }) => {
      applyModelTransform(nextPosition, modelRotation, options);
    },
    [applyModelTransform, modelRotation],
  );

  const goBack = useCallback(() => window.history.back(), []);

  // Load transformation from backend when projectId is available
  useEffect(() => {
    if (!projectId || transformLoaded) return;

    const loadTransformation = async () => {
      try {
        const response = await api.getTransformation(projectId);
        if (response.transformation) {
          const nextPosition = response.transformation.position ?? modelPosition;
          const nextRotation = response.transformation.rotation ?? modelRotation;
          applyModelTransform({ ...nextPosition }, { ...nextRotation }, { persist: false });
        }
        setTransformLoaded(true);
      } catch (error) {
        console.error('Failed to load transformation:', error);
        // Use default values on error
        setTransformLoaded(true);
      }
    };

    loadTransformation();
  }, [projectId, transformLoaded, applyModelTransform, modelPosition, modelRotation]);

  const resetView = useCallback(() => {
    resetScene();
    applyModelTransform({ ...DEFAULT_POSITION }, { ...DEFAULT_ROTATION });
  }, [resetScene, applyModelTransform]);

  const updateModelRotation = useCallback(
    (axis: keyof Vec3, value: number) => {
      applyModelRotation({ ...modelRotation, [axis]: value });
    },
    [applyModelRotation, modelRotation],
  );

  const updateModelPosition = useCallback(
    (axis: keyof Vec3, value: number) => {
      applyModelPosition({ ...modelPosition, [axis]: value });
    },
    [applyModelPosition, modelPosition],
  );

  const nudgeModelRotation = useCallback(
    (axis: keyof Vec3, delta: number) => {
      applyModelRotation({ ...modelRotation, [axis]: modelRotation[axis] + delta });
    },
    [applyModelRotation, modelRotation],
  );

  const zoomCamera = useCallback((amount: number) => {
    if (!Number.isFinite(amount) || amount === 0) {
      return;
    }

    let direction = Math.sign(amount);
    let magnitude = Math.abs(amount);

    if (amount > 1) {
      direction = 1;
      magnitude = amount - 1;
    } else if (amount > 0 && amount < 1) {
      direction = -1;
      magnitude = 1 - amount;
    }

    if (direction === 0 || magnitude === 0) {
      return;
    }

    const scaledMagnitude = Math.max(magnitude * KEYBOARD_ZOOM_FINE_FACTOR, KEYBOARD_ZOOM_MIN_STEP);
    adjustZoom(direction * scaledMagnitude);
  }, [adjustZoom]);

  const handleOrbitAzimuthChange = useCallback((value: number) => {
    setOrbitAngles(value, orbitState.elevation);
  }, [setOrbitAngles, orbitState.elevation]);

  const handleOrbitElevationChange = useCallback((value: number) => {
    setOrbitAngles(orbitState.azimuth, value);
  }, [setOrbitAngles, orbitState.azimuth]);

  const handleOrbitDistanceChange = useCallback((value: number) => {
    setOrbitDistance(value);
  }, [setOrbitDistance]);

  const handleAlignmentAxisChange = useCallback((axis: SnapAxis) => {
    setAlignmentAxis(axis);
  }, []);

  const handleAlignModelToAxis = useCallback(() => {
    if (!selectedMeasurementSegment) {
      setMeasurementMessage('กรุณาเลือกเส้นวัดเพื่อใช้งานจัดแนว');
      return;
    }

    const startWorld = modelToWorld(selectedMeasurementSegment.start);
    const endWorld = modelToWorld(selectedMeasurementSegment.end);
    if (!startWorld || !endWorld) {
      setMeasurementMessage('ไม่สามารถคำนวณการจัดแนวได้');
      return;
    }

    const rotation = computeAlignmentRotation(startWorld, endWorld, alignmentAxis);

    if (!rotation) {
      setMeasurementMessage('ไม่สามารถคำนวณการจัดแนวได้');
      return;
    }

    applyModelRotation(rotation);
    setMeasurementMessage('จัดแนวโมเดลตามเส้นที่เลือกแล้ว');
  }, [
    selectedMeasurementSegment,
    alignmentAxis,
    computeAlignmentRotation,
    setMeasurementMessage,
    applyModelRotation,
    modelToWorld,
  ]);

  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen();
      setIsFullscreen(false);
    }
  }, []);

  // Exit measurement mode by toggling the current mode off
  const exitMeasurementMode = useCallback(() => {
    if (isDistanceMode) {
      toggleDistanceMode();
    }
  }, [isDistanceMode, toggleDistanceMode]);

  // ESC key exits measurement mode
  useEffect(() => {
    if (!measureMode) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'escape') {
        exitMeasurementMode();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [measureMode, exitMeasurementMode]);

  useEffect(() => {
    if (pointEditorActive && measureMode) {
      exitMeasurementMode();
    }
  }, [pointEditorActive, measureMode, exitMeasurementMode]);

  useEffect(() => {
    if (pointEditorActive) {
      setMeasurementMessage(null);
    }
  }, [pointEditorActive, setMeasurementMessage]);

  // Handle spawn point selection for Walk/Fly mode
  useEffect(() => {
    if (!waitingForSpawnPoint || !canvasRef.current) {
      return;
    }

    const canvas = canvasRef.current;

    const handleCanvasClick = (event: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;

      const worldPos = pickWorldPoint(x, y);
      if (worldPos) {
        handleSpawnPointSelected(worldPos);
      }
    };

    canvas.addEventListener('click', handleCanvasClick);

    return () => {
      canvas.removeEventListener('click', handleCanvasClick);
    };
  }, [waitingForSpawnPoint, canvasRef, pickWorldPoint, handleSpawnPointSelected]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.repeat && (e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_')) {
        e.preventDefault();
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          if (measureMode) {
            break;
          }
          if (!viewerExitArmRef.current.armed) {
            if (viewerExitArmRef.current.timer) {
              window.clearTimeout(viewerExitArmRef.current.timer);
            }
            viewerExitArmRef.current.armed = true;
            viewerExitArmRef.current.timer = window.setTimeout(() => {
              viewerExitArmRef.current.armed = false;
              viewerExitArmRef.current.timer = null;
            }, 1800);
            setMeasurementMessage('กด ESC อีกครั้งเพื่อกลับ');
            break;
          }
          if (viewerExitArmRef.current.timer) {
            window.clearTimeout(viewerExitArmRef.current.timer);
            viewerExitArmRef.current.timer = null;
          }
          viewerExitArmRef.current.armed = false;
          goBack();
          break;
        case 'r':
        case 'R':
          e.preventDefault();
          resetView();
          break;
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          nudgeModelRotation('y', -1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          nudgeModelRotation('y', 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          nudgeModelRotation('x', -1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          nudgeModelRotation('x', 1);
          break;
        case '+':
        case '=':
          e.preventDefault();
          zoomCamera(1.5);
          break;
        case '-':
        case '_':
          e.preventDefault();
          zoomCamera(0.5);
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      if (viewerExitArmRef.current.timer) {
        window.clearTimeout(viewerExitArmRef.current.timer);
        viewerExitArmRef.current.timer = null;
      }
      viewerExitArmRef.current.armed = false;
    };
  }, [goBack, resetView, toggleFullscreen, nudgeModelRotation, zoomCamera, measureMode, setMeasurementMessage]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  if (error) {
    return (
      <div className="brutal-shell relative flex h-full w-full items-center justify-center p-4">
        <input
          id="local-project-file-input"
          ref={fileInputRef}
          type="file"
          accept=".ply"
          className="hidden"
          onChange={handleLocalFileInputChange}
        />
        <div className="brutal-card relative max-w-sm p-6 text-center">
          <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
          <div className="relative mx-auto mb-4 flex h-12 w-12 items-center justify-center border-[3px] border-[var(--ink)] bg-[var(--error-bg)] text-lg font-black text-[var(--error-text)]">
            !
          </div>
          <div className="relative">
            <p className="brutal-eyebrow mb-3">Viewer Error</p>
            <h2 className="brutal-h2 mb-3">Viewer Unavailable</h2>
            <p className="mb-6 text-sm font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">{error}</p>
          </div>
          <div className="relative mt-6 flex flex-col gap-3">
            {localProject && !projectId ? (
              <>
                <button type="button" onClick={handleChooseAnotherLocalFile} className="btn-primary">
                  เลือกไฟล์อื่น
                </button>
                <button type="button" onClick={goBack} className="btn-secondary">
                  กลับ
                </button>
              </>
            ) : (
              <button type="button" onClick={goBack} className="btn-secondary">
                Go back
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="brutal-shell relative h-full w-full overflow-hidden">
      <input
        id="local-project-file-input"
        ref={fileInputRef}
        type="file"
        accept=".ply"
        className="hidden"
        onChange={handleLocalFileInputChange}
      />

      {viewerActive && loading && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[color:rgba(244,245,248,0.94)] p-4">
          <div className="brutal-card relative w-full max-w-sm p-6 text-center">
            <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
            <div className="relative">
              <div className="mx-auto mb-4 h-12 w-12 animate-spin border-[3px] border-[var(--ink)] border-t-transparent" />
              <p className="brutal-eyebrow mb-3">Loading Scene</p>
              <h2 className="brutal-h3">Preparing Viewer</h2>
              <p className="mt-2 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
                Loading Gaussian Splats
              </p>
            </div>
          </div>
        </div>
      )}

      {viewerActive && (
        <IconSidebar
          onBack={goBack}
          onReset={resetView}
          onToggleFullscreen={toggleFullscreen}
          isFullscreen={isFullscreen}
          onToggleTransform={() => setShowTransformPanel((prev) => !prev)}
          showTransform={showTransformPanel}
          onToggleCameraControls={() => setShowCameraControls((prev) => !prev)}
          cameraControlsOpen={showCameraControls}
          onToggleInfo={() => setShowInfo((prev) => !prev)}
          infoOpen={showInfo}
          splatCount={splatCount}
          backgroundOptions={backgroundOptions}
          activeBackground={activeBackground}
          onBackgroundSelect={setBackground}
          showGrid={showGrid}
          onToggleGrid={setGridVisible}
          showAxes={showAxes}
          onToggleAxes={setAxesVisible}
          measurementControls={{
            isDistanceMode,
            hasMeasurements,
            onToggleDistance: toggleDistanceMode,
            onClearAll: clearAll,
            disabled: pointEditorActive,
          }}
          pointEditorControls={{
            active: pointEditorActive,
            selectionCount: pointSelectionCount,
            hiddenCount: pointHiddenCount,
            onToggle: togglePointEditorActive,
          }}
        />
      )}

      {viewerActive && (showTransformPanel || showCameraControls || pointEditorActive) && (
        <div className="pointer-events-none absolute right-5 top-24 z-40 flex w-80 max-w-full flex-col gap-4">
          {showTransformPanel && (
            <div className="pointer-events-auto">
              <TransformPanel
                className="static"
                position={modelPosition}
                rotation={modelRotation}
                onPositionChange={updateModelPosition}
                onRotationChange={updateModelRotation}
                onReset={resetView}
                autoAlignControls={{
                  axis: alignmentAxis,
                  onAxisChange: handleAlignmentAxisChange,
                  onAlign: handleAlignModelToAxis,
                  canAlign: Boolean(selectedMeasurementSegment),
                }}
              />
            </div>
          )}
          {showCameraControls && (
            <div className="pointer-events-auto">
              <CameraControlPanel
                className="static"
                orbitState={orbitState}
                onAzimuthChange={handleOrbitAzimuthChange}
                onElevationChange={handleOrbitElevationChange}
                onDistanceChange={handleOrbitDistanceChange}
                projectionMode={projectionMode}
                onProjectionChange={setProjectionMode}
                fieldOfView={fieldOfView}
                onFieldOfViewChange={setFieldOfView}
                orthoHeight={orthoHeight}
                onOrthoHeightChange={setOrthoHeight}
                cameraMode={cameraMode}
                onCameraModeChange={setCameraMode}
                moveSpeed={moveSpeed}
                onMoveSpeedChange={setMoveSpeed}
                cameraHeight={cameraHeight}
                onCameraHeightChange={setCameraHeight}
                jumpHeight={jumpHeight}
                onJumpHeightChange={setJumpHeight}
                bulletSettings={bulletSettings}
                onBulletSettingsChange={setBulletSettings}
                gameModeSettings={gameModeSettings}
                onGameModeSettingsChange={setGameModeSettings}
                onReset={resetCamera}
              />
            </div>
          )}
          {pointEditorActive && (
            <PointEditorPanel
              active={pointEditorActive}
              selectionCount={pointSelectionCount}
              hiddenCount={pointHiddenCount}
              totalCount={pointTotalCount}
              selectionMode={pointSelectionMode}
              onChangeSelectionMode={setPointSelectionMode}
              isPolygonDrawing={pointPolygonOverlay.isDrawing}
              onCompletePolygon={completePolygonSelection}
              onCancelPolygon={cancelPolygonSelection}
              nudgeStep={pointNudgeStep}
              onChangeNudgeStep={setPointNudgeStep}
              onNudge={nudgeSelectedPoints}
              rotationStep={pointRotationStep}
              onChangeRotationStep={setPointRotationStep}
              onRotate={rotateSelectedPoints}
              onClearSelection={clearPointSelection}
              onDeleteSelection={deleteSelectedPoints}
              onUnhideAll={unhideAllHiddenPoints}
            />
          )}
        </div>
      )}

      {viewerActive && showInfo && (
        <InfoPanel projectId={projectId} fileLabel={infoFileLabel} />
      )}

      {viewerActive && cameraAxes && <ViewCube axes={cameraAxes} onAlign={alignCamera} />}

      {localProject && !projectId && viewerActive && (
        <div className="pointer-events-auto brutal-card absolute left-5 top-5 z-40 w-80 max-w-full p-3 text-left">
          <p className="brutal-eyebrow mb-2">Local Project</p>
          <p className="truncate text-sm font-black uppercase tracking-[0.08em] text-[var(--ink)]" title={localProject.name}>
            {localProject.name}
          </p>
          <p className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--text-secondary)]">
            Size {formatFileSize(localProject.size)}
          </p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={triggerLocalFileDialog} className="btn-primary text-xs">
              เปลี่ยนไฟล์
            </button>
            <button type="button" onClick={clearLocalProject} className="btn-secondary text-xs">
              ปิดไฟล์
            </button>
          </div>
        </div>
      )}

      <canvas ref={canvasRef} id="application-canvas" className="block h-full w-full" />

      {viewerActive && (
        <>
          {/* Measurement Overlay */}
          <MeasurementOverlay
            overlayState={overlayState}
            selectedDistanceLabel={selectedDistanceLabel}
            selectedDistanceId={selectedDistanceId}
            selectedAxisComponents={selectedAxisComponents}
            onSelectDistance={selectDistance}
            onDeleteMeasurement={handleDeleteMeasurement}
            onOpenRescaleDialog={openRescaleDialog}
          />

          <PointEditorOverlay
            active={pointEditorActive}
            selectionEntries={pointSelectionEntries}
            hoveredEntry={pointHoveredEntry}
            rectangleSelection={pointRectangleSelection}
            polygonOverlay={pointPolygonOverlay}
          />

          {/* Crosshair for Game Mode */}
          {cameraMode === 'game' && <Crosshair />}

          {/* Spawn Point Selection Message */}
          {waitingForSpawnPoint && (
            <div className="brutal-card-dark absolute bottom-24 left-1/2 z-50 -translate-x-1/2 px-5 py-3 text-sm font-bold uppercase tracking-[0.12em]">
              🎯 คลิกที่ Point เพื่อเลือกตำแหน่งเริ่มต้น
            </div>
          )}

          {/* Measurement Message */}
          {measurementMessage && !waitingForSpawnPoint && (
            <div
              className={`absolute left-1/2 z-50 -translate-x-1/2 border-[3px] border-[var(--ink)] bg-[var(--ink)] px-4 py-2.5 text-sm font-bold uppercase tracking-[0.12em] text-[var(--text-on-ink)] shadow-[var(--shadow-inv)] transition-all ${
                hasFloatingPanel ? 'bottom-36' : 'bottom-24'
              }`}
            >
              {measurementMessage}
            </div>
          )}

          {/* Rescale Dialog */}
          {rescaleDialogOpen && (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center bg-[color:rgba(10,26,63,0.28)] p-4"
              role="presentation"
            >
              <button
                type="button"
                aria-label="Close measurement scale dialog"
                className="absolute inset-0"
                onClick={closeRescaleDialog}
              />
              <div
                className="brutal-card relative w-full max-w-md p-5"
              >
                <p className="brutal-eyebrow mb-3">Measurement Scale</p>
                <h3 className="brutal-h3 mb-3">ปรับมาตราส่วน</h3>
                <p className="mb-5 text-sm font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
                  ระบุระยะจริงของเส้นที่เลือก เพื่อปรับมาตราส่วนการวัดทั้งหมด
                </p>
                <form onSubmit={handleRescaleSubmit}>
                  <div className="mb-6 flex gap-3">
                    <div className="flex-1">
                      <label className="brutal-label mb-2 block" htmlFor="rescale-meters">เมตร</label>
                      <input
                        id="rescale-meters"
                        type="number"
                        min="0"
                        step="1"
                        value={rescaleMetersInput}
                        onChange={(e) => setRescaleMetersInput(e.target.value)}
                        className="brutal-input"
                        placeholder="0"
                      />
                    </div>
                    <div className="flex-1">
                      <label className="brutal-label mb-2 block" htmlFor="rescale-centimeters">เซนติเมตร</label>
                      <input
                        id="rescale-centimeters"
                        type="number"
                        min="0"
                        max="99"
                        step="1"
                        value={rescaleCentimetersInput}
                        onChange={(e) => setRescaleCentimetersInput(e.target.value)}
                        className="brutal-input"
                        placeholder="0"
                      />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={closeRescaleDialog}
                      className="brutal-btn flex-1 justify-center py-2"
                    >
                      ยกเลิก
                    </button>
                    <button
                      type="submit"
                      className="brutal-btn brutal-btn-primary flex-1 justify-center py-2"
                    >
                      ปรับมาตราส่วน
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}

      {showLocalUploadOverlay && (
        <form
          className="absolute inset-0 z-[60] flex flex-col items-center justify-center bg-[var(--paper)] px-4"
          onSubmit={(event) => event.preventDefault()}
          onDragEnter={handleLocalDragEnter}
          onDragOver={handleLocalDragOver}
          onDragLeave={handleLocalDragLeave}
          onDrop={handleLocalDrop}
        >
          <div
            className={`relative w-full max-w-xl border-[3px] px-6 py-8 text-center shadow-[var(--shadow-lg)] transition-colors ${
              localDragActive
                ? 'border-[var(--ink)] bg-[var(--paper-muted)]'
                : 'border-[var(--ink)] bg-[var(--paper-card)]'
            }`}
          >
            <div className="brutal-dot-bg pointer-events-none absolute inset-0" />
            <div className="relative mx-auto flex h-14 w-14 items-center justify-center border-[3px] border-[var(--ink)] bg-[var(--ink)] text-[var(--text-on-ink)] shadow-[var(--shadow-inv)]">
              <UploadCloud className="h-8 w-8" />
            </div>
            <div className="relative">
              <p className="brutal-eyebrow mt-5">Local Import</p>
              <h2 className="brutal-h2 mt-4">เปิดโปรเจกต์จากเครื่องของคุณ</h2>
            </div>
            <p className="relative mt-3 text-sm font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">
              ลากไฟล์ Gaussian Splat (.ply) มาวาง หรือเลือกไฟล์ที่สร้างจาก Pobim เพื่อเริ่มตรวจสอบ
            </p>
            <div className="relative mt-8 flex flex-col gap-2 sm:flex-row sm:justify-center sm:gap-3">
              <button type="button" onClick={triggerLocalFileDialog} className="btn-primary">
                เลือกไฟล์จากเครื่อง
              </button>
              <Link href="/projects" className="btn-secondary">
                เลือกจาก Projects
              </Link>
            </div>
            {localUploadError && (
              <p className="relative mt-4 text-sm font-bold uppercase tracking-[0.08em] text-[var(--error-text)]">{localUploadError}</p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
