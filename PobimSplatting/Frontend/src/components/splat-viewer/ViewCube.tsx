import { useEffect, useRef } from 'react';

import type { CameraAxes } from './useSplatScene';

type AlignDirection = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

interface ViewCubeProps {
  axes: CameraAxes | null;
  onAlign: (direction: AlignDirection) => void;
}

type ShapesMap = Record<string, SVGElement>;

const COLORS = {
  x: '#f44',
  y: '#4f4',
  z: '#77f',
};

const SCALE = 36;

export function ViewCube({ axes, onAlign }: ViewCubeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);
  const shapesRef = useRef<ShapesMap | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'view-cube-svg';
    svg.style.overflow = 'visible';

    const group = document.createElementNS(svg.namespaceURI, 'g');
    svg.appendChild(group);

    const circle = (color: string, fill: boolean, label?: string) => {
      const wrapper = document.createElementNS(svg.namespaceURI, 'g');
      const c = document.createElementNS(svg.namespaceURI, 'circle');
      c.setAttribute('fill', fill ? color : 'rgba(255,255,255,0.08)');
      c.setAttribute('stroke', color);
      c.setAttribute('stroke-width', '1.5');
      c.setAttribute('r', '10');
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      c.setAttribute('pointer-events', 'all');
      wrapper.appendChild(c);

      if (label) {
        const text = document.createElementNS(svg.namespaceURI, 'text');
        text.setAttribute('font-size', '10');
        text.setAttribute('font-family', 'Arial');
        text.setAttribute('font-weight', 'bold');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('alignment-baseline', 'central');
        text.textContent = label;
        wrapper.appendChild(text);
      }

      wrapper.setAttribute('cursor', 'pointer');
      group.appendChild(wrapper);
      return wrapper as SVGElement;
    };

    const line = (color: string) => {
      const l = document.createElementNS(svg.namespaceURI, 'line');
      l.setAttribute('stroke', color);
      l.setAttribute('stroke-width', '1.5');
      group.appendChild(l);
      return l as unknown as SVGElement;
    };

    const shapes: ShapesMap = {
      nx: circle(COLORS.x, false),
      ny: circle(COLORS.y, false),
      nz: circle(COLORS.z, false),
      xaxis: line(COLORS.x),
      yaxis: line(COLORS.y),
      zaxis: line(COLORS.z),
      px: circle(COLORS.x, true, 'X'),
      py: circle(COLORS.y, true, 'Y'),
      pz: circle(COLORS.z, true, 'Z'),
    };

    const bindAlign = (key: AlignDirection) => {
      const element = shapes[key];
      const target = element.querySelector('circle');
      if (!target) {
        return;
      }
      target.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
        onAlign(key);
      });
    };

    bindAlign('px');
    bindAlign('py');
    bindAlign('pz');
    bindAlign('nx');
    bindAlign('ny');
    bindAlign('nz');

    svgRef.current = svg as any;
    groupRef.current = group as any;
    shapesRef.current = shapes as any;
    container.appendChild(svg);

    return () => {
      container.removeChild(svg);
      shapesRef.current = null;
      groupRef.current = null;
      svgRef.current = null;
    };
  }, [onAlign]);

  useEffect(() => {
    const container = containerRef.current;
    const shapes = shapesRef.current;
    const svg = svgRef.current;
    const group = groupRef.current;
    if (!container || !shapes || !svg || !group || !axes) {
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;

    if (width && height) {
      const dims = sizeRef.current;
      if (width !== dims.width || height !== dims.height) {
        svg.setAttribute('width', width.toString());
        svg.setAttribute('height', height.toString());
        group.setAttribute('transform', `translate(${width * 0.5}, ${height * 0.5})`);
        dims.width = width;
        dims.height = height;
      }

      const transform = (element: SVGElement, x: number, y: number) => {
        element.setAttribute('transform', `translate(${x * SCALE}, ${y * SCALE})`);
      };

      const setLine = (element: SVGElement, x: number, y: number) => {
        const line = element as unknown as SVGLineElement;
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '0');
        line.setAttribute('x2', (x * SCALE).toString());
        line.setAttribute('y2', (y * SCALE).toString());
      };

      transform(shapes.px, axes.x.x, -axes.x.y);
      transform(shapes.nx, -axes.x.x, axes.x.y);
      transform(shapes.py, axes.y.x, -axes.y.y);
      transform(shapes.ny, -axes.y.x, axes.y.y);
      transform(shapes.pz, axes.z.x, -axes.z.y);
      transform(shapes.nz, -axes.z.x, axes.z.y);

      setLine(shapes.xaxis, axes.x.x, -axes.x.y);
      setLine(shapes.yaxis, axes.y.x, -axes.y.y);
      setLine(shapes.zaxis, axes.z.x, -axes.z.y);

      const order = [
        { elements: ['xaxis', 'px'], value: axes.x.z },
        { elements: ['yaxis', 'py'], value: axes.y.z },
        { elements: ['zaxis', 'pz'], value: axes.z.z },
        { elements: ['nx'], value: -axes.x.z },
        { elements: ['ny'], value: -axes.y.z },
        { elements: ['nz'], value: -axes.z.z },
      ].sort((a, b) => a.value - b.value);

      const fragment = document.createDocumentFragment();
      order.forEach(({ elements }) => {
        elements.forEach((key) => {
          const shape = shapes[key];
          if (shape) {
            fragment.appendChild(shape);
          }
        });
      });
      group.appendChild(fragment);
    }
  }, [axes]);

  return (
    <div className="pointer-events-none absolute right-4 top-12 z-1090" data-orbit-block="true">
      <div
        ref={containerRef}
        className="pointer-events-auto h-24 w-24 rounded-xl p-2"
        data-orbit-block="true"
      />
    </div>
  );
}
