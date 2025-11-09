import type {
  CanvasPoint,
  PointEditorSelectionEntry,
  PolygonSelectionOverlay,
  RectangleSelectionOverlay,
} from './usePointEditor';

interface PointEditorOverlayProps {
  active: boolean;
  selectionEntries: PointEditorSelectionEntry[];
  hoveredEntry: PointEditorSelectionEntry | null;
  rectangleSelection: RectangleSelectionOverlay | null;
  polygonOverlay: PolygonSelectionOverlay;
}

const rectangleStyle = (rect: RectangleSelectionOverlay) => {
  const minX = Math.min(rect.origin.x, rect.current.x);
  const minY = Math.min(rect.origin.y, rect.current.y);
  const width = Math.abs(rect.current.x - rect.origin.x);
  const height = Math.abs(rect.current.y - rect.origin.y);
  return {
    left: `${minX}px`,
    top: `${minY}px`,
    width: `${width}px`,
    height: `${height}px`,
  } as const;
};

const polygonPointsToSvg = (points: CanvasPoint[]) =>
  points.map((point) => `${point.x},${point.y}`).join(' ');

export function PointEditorOverlay({
  active,
  selectionEntries,
  hoveredEntry,
  rectangleSelection,
  polygonOverlay,
}: PointEditorOverlayProps) {
  if (!active) {
    return null;
  }

  const polygonPathPoints = polygonOverlay.points.length > 1
    ? polygonPointsToSvg(polygonOverlay.points)
    : '';

  const polygonPreviewPoints = polygonOverlay.isDrawing && polygonOverlay.preview
    ? polygonPointsToSvg([...polygonOverlay.points, polygonOverlay.preview])
    : polygonPathPoints;

  return (
    <div className="pointer-events-none absolute inset-0 z-40">
      {rectangleSelection && (
        <div
          className="absolute border border-red-400/80 bg-red-400/10"
          style={rectangleStyle(rectangleSelection)}
        />
      )}

      {polygonOverlay.points.length > 0 && (
        <svg className="absolute inset-0">
          {polygonPathPoints && (
            <polygon
              points={polygonPathPoints}
              fill="rgba(248, 113, 113, 0.12)"
              stroke="rgba(248, 113, 113, 0.6)"
              strokeWidth={2}
            />
          )}
          {polygonPreviewPoints && polygonPreviewPoints !== polygonPathPoints && (
            <polyline
              points={polygonPreviewPoints}
              fill="none"
              stroke="rgba(248, 113, 113, 0.45)"
              strokeWidth={1.5}
              strokeDasharray="6 6"
            />
          )}
        </svg>
      )}

      {selectionEntries.map(({ index, screen }) => {
        if (!screen || !screen.visible) {
          return null;
        }
        return (
          <div
            key={`point-selection-${index}`}
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-red-500 bg-red-500/30"
            style={{
              left: `${screen.x}px`,
              top: `${screen.y}px`,
              width: '14px',
              height: '14px',
            }}
          />
        );
      })}

      {hoveredEntry?.screen && hoveredEntry.screen.visible && (
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-sky-500 bg-sky-500/30"
          style={{
            left: `${hoveredEntry.screen.x}px`,
            top: `${hoveredEntry.screen.y}px`,
            width: '18px',
            height: '18px',
          }}
        />
      )}
    </div>
  );
}
