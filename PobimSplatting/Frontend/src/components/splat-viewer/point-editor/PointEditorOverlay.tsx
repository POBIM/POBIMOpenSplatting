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
          className="absolute border-[3px] border-[var(--ink)] bg-[color:rgba(10,26,63,0.08)]"
          style={rectangleStyle(rectangleSelection)}
        />
      )}

      {polygonOverlay.points.length > 0 && (
        <svg className="absolute inset-0">
          <title>Point editor overlay</title>
          {polygonPathPoints && (
            <polygon
              points={polygonPathPoints}
              fill="rgba(10,26,63,0.08)"
              stroke="var(--ink)"
              strokeWidth={2}
            />
          )}
          {polygonPreviewPoints && polygonPreviewPoints !== polygonPathPoints && (
            <polyline
              points={polygonPreviewPoints}
              fill="none"
              stroke="var(--ink)"
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
            className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[var(--ink)] bg-[color:rgba(10,26,63,0.14)]"
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
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[var(--ink)] bg-[color:rgba(10,26,63,0.22)]"
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
