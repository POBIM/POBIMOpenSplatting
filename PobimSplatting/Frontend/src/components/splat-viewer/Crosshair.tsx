'use client';

type CrosshairProps = {
  size?: number;
  thickness?: number;
  gap?: number;
  color?: string;
  opacity?: number;
};

export function Crosshair({
  size = 20,
  thickness = 2,
  gap = 6,
  color = '#ff0000',
  opacity = 0.9,
}: CrosshairProps) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2">
      <svg
        width={size * 2 + gap * 2}
        height={size * 2 + gap * 2}
        viewBox={`0 0 ${size * 2 + gap * 2} ${size * 2 + gap * 2}`}
        style={{ opacity }}
      >
        {/* Horizontal line - Left */}
        <line
          x1={0}
          y1={size + gap}
          x2={size}
          y2={size + gap}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {/* Horizontal line - Right */}
        <line
          x1={size + gap * 2}
          y1={size + gap}
          x2={size * 2 + gap * 2}
          y2={size + gap}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {/* Vertical line - Top */}
        <line
          x1={size + gap}
          y1={0}
          x2={size + gap}
          y2={size}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {/* Vertical line - Bottom */}
        <line
          x1={size + gap}
          y1={size + gap * 2}
          x2={size + gap}
          y2={size * 2 + gap * 2}
          stroke={color}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {/* Center dot */}
        <circle
          cx={size + gap}
          cy={size + gap}
          r={1.5}
          fill={color}
        />
      </svg>
    </div>
  );
}
