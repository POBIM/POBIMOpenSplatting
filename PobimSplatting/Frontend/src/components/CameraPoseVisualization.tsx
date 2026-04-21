'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface CameraPose {
  image_name: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  fx?: number;
  fy?: number;
  width?: number;
  height?: number;
  image_url?: string;
}

export interface SparsePoint {
  position: [number, number, number];
  color?: [number, number, number];
}

export interface CameraPosesData {
  project_id: string;
  project_name?: string;
  sfm_engine?: string;
  camera_count: number;
  cameras: CameraPose[];
  sparse_point_count?: number;
  sparse_points?: SparsePoint[];
}

interface Props {
  data: CameraPosesData;
  selectedCamera?: CameraPose | null;
  onCameraSelect?: (camera: CameraPose | null) => void;
}

type AxisPreset = 'default' | 'y-up' | 'z-up';

const AXIS_PRESETS: Record<AxisPreset, { label: string; matrix: THREE.Matrix4 }> = {
  'default': {
    label: 'Raw',
    matrix: new THREE.Matrix4().identity(),
  },
  'y-up': {
    label: 'X -90°',
    matrix: new THREE.Matrix4().makeRotationX(-Math.PI / 2),
  },
  'z-up': {
    label: 'X +90°',
    matrix: new THREE.Matrix4().makeRotationX(Math.PI / 2),
  },
};

const INITIAL_POINT_SIZE = 0.04;

function buildFrustumGeometry(aspectRatio: number, depth: number): THREE.BufferGeometry {
  const hw = depth * 0.4 * aspectRatio;
  const hh = depth * 0.4;

  const vertices = new Float32Array([
    0, 0, 0,
    -hw, -hh, -depth,
    hw, -hh, -depth,
    hw, hh, -depth,
    -hw, hh, -depth,
  ]);

  const indices = [
    0, 1, 2,
    0, 2, 3,
    0, 3, 4,
    0, 4, 1,
    1, 3, 2,
    1, 4, 3,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildFrustumEdges(aspectRatio: number, depth: number): THREE.BufferGeometry {
  const hw = depth * 0.4 * aspectRatio;
  const hh = depth * 0.4;

  const points = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(-hw, -hh, -depth),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(hw, -hh, -depth),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(hw, hh, -depth),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(-hw, hh, -depth),
    new THREE.Vector3(-hw, -hh, -depth), new THREE.Vector3(hw, -hh, -depth),
    new THREE.Vector3(hw, -hh, -depth), new THREE.Vector3(hw, hh, -depth),
    new THREE.Vector3(hw, hh, -depth), new THREE.Vector3(-hw, hh, -depth),
    new THREE.Vector3(-hw, hh, -depth), new THREE.Vector3(-hw, -hh, -depth),
  ];

  return new THREE.BufferGeometry().setFromPoints(points);
}

function computeSceneScale(cameras: CameraPose[]): number {
  if (cameras.length < 2) return 1;

  const positions = cameras.map(c => new THREE.Vector3(...c.position));
  const bbox = new THREE.Box3();
  for (const p of positions) {
    bbox.expandByPoint(p);
  }

  const size = new THREE.Vector3();
  bbox.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim < 0.01) return 1;
  return 5 / maxDim;
}

function computeCenter(cameras: CameraPose[]): THREE.Vector3 {
  if (cameras.length === 0) return new THREE.Vector3();
  const sum = new THREE.Vector3();
  for (const c of cameras) {
    sum.add(new THREE.Vector3(...c.position));
  }
  return sum.divideScalar(cameras.length);
}

function MiniSlider({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[color:var(--text-secondary)] select-none">
      <span className="w-[58px] shrink-0 font-bold text-[color:var(--text-secondary)]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1 cursor-pointer appearance-none bg-[color:var(--paper-muted-2)] accent-[var(--ink)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:bg-[var(--ink)]"
      />
      <span className="w-[34px] text-right font-mono tabular-nums text-[color:var(--text-muted)]">{value.toFixed(2)}</span>
    </label>
  );
}

export default function CameraPoseVisualization({ data, selectedCamera: selectedCameraProp, onCameraSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frustumGroupRef = useRef<THREE.Group | null>(null);
  const sparsePointsRef = useRef<THREE.Points | null>(null);
  const contentGroupRef = useRef<THREE.Group | null>(null);
  const animFrameRef = useRef<number>(0);

  const [hoveredCamera, setHoveredCamera] = useState<CameraPose | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const [frustumScale, setFrustumScale] = useState(1.0);
  const [pointSize, setPointSize] = useState(INITIAL_POINT_SIZE);
  const [axisPreset, setAxisPreset] = useState<AxisPreset>('default');
  const [flipX, setFlipX] = useState(false);
  const [flipY, setFlipY] = useState(false);
  const [flipZ, setFlipZ] = useState(false);
  const [rotXDeg, setRotXDeg] = useState(0);
  const [rotYDeg, setRotYDeg] = useState(0);
  const [rotZDeg, setRotZDeg] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const initScene = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);
    sceneRef.current = scene;

    const cam = new THREE.PerspectiveCamera(50, width / height, 0.01, 500);
    cameraRef.current = cam;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(cam, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 0.5;
    controls.maxDistance = 200;
    controlsRef.current = controls;

    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambient);
    const directional = new THREE.DirectionalLight(0xffffff, 0.7);
    directional.position.set(10, 20, 10);
    scene.add(directional);

    const contentGroup = new THREE.Group();
    contentGroupRef.current = contentGroup;
    scene.add(contentGroup);

    const cameras = data.cameras;
    const scale = computeSceneScale(cameras);
    const center = computeCenter(cameras);

    const gridSize = 10;
    const gridDivisions = 20;
    const gridHelper = new THREE.GridHelper(gridSize, gridDivisions, 0x333333, 0x1a1a1a);
    gridHelper.position.set(center.x * scale, 0, center.z * scale);
    scene.add(gridHelper);

    const axesSize = gridSize * 0.3;
    const axesGroup = new THREE.Group();
    axesGroup.position.copy(gridHelper.position);

    const xArrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0.01, 0),
      axesSize, 0xff3333, axesSize * 0.08, axesSize * 0.05
    );
    axesGroup.add(xArrow);

    const yArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.01, 0),
      axesSize, 0x33ff33, axesSize * 0.08, axesSize * 0.05
    );
    axesGroup.add(yArrow);

    const zArrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0.01, 0),
      axesSize, 0x3377ff, axesSize * 0.08, axesSize * 0.05
    );
    axesGroup.add(zArrow);

    scene.add(axesGroup);

    const frustumGroup = new THREE.Group();
    frustumGroupRef.current = frustumGroup;
    contentGroup.add(frustumGroup);

    const hueStep = cameras.length > 1 ? 360 / cameras.length : 0;
    const aspectRatio = cameras.length > 0 && cameras[0].width && cameras[0].height
      ? cameras[0].width / cameras[0].height
      : 16 / 9;

    const baseFrustumDepth = 0.25;
    const frustumGeometry = buildFrustumGeometry(aspectRatio, baseFrustumDepth);
    const edgesGeometry = buildFrustumEdges(aspectRatio, baseFrustumDepth);

    cameras.forEach((camPose, idx) => {
      const hue = (idx * hueStep) % 360;
      const color = new THREE.Color().setHSL(hue / 360, 0.85, 0.6);

      const faceMaterial = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.25,
        side: THREE.DoubleSide,
        depthWrite: false,
      });

      const edgeMaterial = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
      });

      const mesh = new THREE.Mesh(frustumGeometry.clone(), faceMaterial);
      const edges = new THREE.LineSegments(edgesGeometry.clone(), edgeMaterial);

      const group = new THREE.Group();
      group.add(mesh);
      group.add(edges);

      const pos = new THREE.Vector3(...camPose.position).multiplyScalar(scale);
      group.position.copy(pos);

      const q = new THREE.Quaternion(
        camPose.quaternion[1],
        camPose.quaternion[2],
        camPose.quaternion[3],
        camPose.quaternion[0]
      );
      group.setRotationFromQuaternion(q);

      group.userData = { cameraPose: camPose, index: idx, baseColor: color };
      frustumGroup.add(group);
    });

    if (data.sparse_points && data.sparse_points.length > 0) {
      const sp = data.sparse_points;
      const pointCount = sp.length;
      const positions = new Float32Array(pointCount * 3);
      const colors = new Float32Array(pointCount * 3);

      for (let i = 0; i < pointCount; i++) {
        positions[i * 3] = sp[i].position[0] * scale;
        positions[i * 3 + 1] = sp[i].position[1] * scale;
        positions[i * 3 + 2] = sp[i].position[2] * scale;

        if (sp[i].color) {
          colors[i * 3] = sp[i].color![0] / 255;
          colors[i * 3 + 1] = sp[i].color![1] / 255;
          colors[i * 3 + 2] = sp[i].color![2] / 255;
        } else {
          colors[i * 3] = 0.45;
          colors[i * 3 + 1] = 0.45;
          colors[i * 3 + 2] = 0.50;
        }
      }

      const pointsGeometry = new THREE.BufferGeometry();
      pointsGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      pointsGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

      const pointsMaterial = new THREE.PointsMaterial({
        size: INITIAL_POINT_SIZE,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        sizeAttenuation: true,
        depthWrite: false,
      });

      const sparsePointsObj = new THREE.Points(pointsGeometry, pointsMaterial);
      sparsePointsObj.renderOrder = -1;
      sparsePointsRef.current = sparsePointsObj;
      contentGroup.add(sparsePointsObj);
    } else {
      sparsePointsRef.current = null;
    }

    const scaledCenter = center.clone().multiplyScalar(scale);
    controls.target.copy(scaledCenter);
    cam.position.set(
      scaledCenter.x + 6,
      scaledCenter.y + 4,
      scaledCenter.z + 6
    );
    controls.update();

    const raycaster = new THREE.Raycaster();
    raycaster.params.Line = { threshold: 0.1 };
    const mouse = new THREE.Vector2();

    const onMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      setTooltipPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });

      raycaster.setFromCamera(mouse, cam);
      const meshChildren: THREE.Object3D[] = [];
      frustumGroup.children.forEach(g => {
        g.children.forEach(child => {
          if (child instanceof THREE.Mesh) meshChildren.push(child);
        });
      });

      const intersects = raycaster.intersectObjects(meshChildren, false);
      if (intersects.length > 0) {
        const parentGroup = intersects[0].object.parent;
        const camData = parentGroup?.userData?.cameraPose as CameraPose | undefined;
        if (camData) {
          setHoveredCamera(camData);
          container.style.cursor = 'pointer';
          return;
        }
      }
      setHoveredCamera(null);
      container.style.cursor = 'grab';
    };

    const onClick = (event: MouseEvent) => {
      if (!onCameraSelect) return;
      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, cam);
      const meshChildren: THREE.Object3D[] = [];
      frustumGroup.children.forEach(g => {
        g.children.forEach(child => {
          if (child instanceof THREE.Mesh) meshChildren.push(child);
        });
      });

      const intersects = raycaster.intersectObjects(meshChildren, false);
      if (intersects.length > 0) {
        const parentGroup = intersects[0].object.parent;
        const camData = parentGroup?.userData?.cameraPose as CameraPose | undefined;
        if (camData) {
          onCameraSelect(camData);
          return;
        }
      }
      onCameraSelect(null);
    };

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('click', onClick);

    const animate = () => {
      animFrameRef.current = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, cam);
    };
    animate();

    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('click', onClick);
      cancelAnimationFrame(animFrameRef.current);
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [data, onCameraSelect]);

  useEffect(() => {
    const cleanup = initScene();
    return cleanup;
  }, [initScene]);

  useEffect(() => {
    if (!frustumGroupRef.current) return;
    const SELECTED_COLOR = new THREE.Color(0x8b0000); // dark red
    frustumGroupRef.current.children.forEach(group => {
      const camData = group.userData?.cameraPose as CameraPose | undefined;
      if (!camData) return;
      const isSelected = selectedCameraProp?.image_name === camData.image_name;
      const isHovered = hoveredCamera?.image_name === camData.image_name;
      const baseColor = group.userData.baseColor as THREE.Color;
      group.children.forEach(child => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshStandardMaterial;
          if (isSelected) {
            mat.color.copy(SELECTED_COLOR);
            mat.opacity = 0.6;
          } else if (isHovered) {
            mat.color.copy(baseColor);
            mat.opacity = 0.5;
          } else {
            mat.color.copy(baseColor);
            mat.opacity = 0.25;
          }
        }
        if (child instanceof THREE.LineSegments) {
          const mat = child.material as THREE.LineBasicMaterial;
          if (isSelected) {
            mat.color.copy(SELECTED_COLOR);
            mat.opacity = 1.0;
          } else if (isHovered) {
            mat.color.copy(baseColor);
            mat.opacity = 1.0;
          } else {
            mat.color.copy(baseColor);
            mat.opacity = 0.9;
          }
        }
      });
      const scale = isSelected ? 1.6 : isHovered ? 1.3 : 1.0;
      group.scale.setScalar(scale * frustumScale);
    });
  }, [hoveredCamera, selectedCameraProp, frustumScale]);

  useEffect(() => {
    if (!sparsePointsRef.current) return;
    const mat = sparsePointsRef.current.material as THREE.PointsMaterial;
    mat.size = pointSize;
  }, [pointSize]);

  useEffect(() => {
    if (!contentGroupRef.current) return;
    const group = contentGroupRef.current;
    const preset = AXIS_PRESETS[axisPreset];

    const manualRot = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(
        rotXDeg * THREE.MathUtils.DEG2RAD,
        rotYDeg * THREE.MathUtils.DEG2RAD,
        rotZDeg * THREE.MathUtils.DEG2RAD,
        'XYZ',
      ),
    );

    const flipScale = new THREE.Matrix4().makeScale(
      flipX ? -1 : 1,
      flipY ? -1 : 1,
      flipZ ? -1 : 1,
    );

    // preset → manual rotation → flip
    const combined = new THREE.Matrix4()
      .multiply(preset.matrix)
      .multiply(manualRot)
      .multiply(flipScale);

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    combined.decompose(pos, quat, scl);

    group.position.copy(pos);
    group.quaternion.copy(quat);
    group.scale.copy(scl);
  }, [axisPreset, flipX, flipY, flipZ, rotXDeg, rotYDeg, rotZDeg]);

  const hasSparsePoints = (data.sparse_points && data.sparse_points.length > 0) || false;

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" />

      {hoveredCamera && (
        <div
          className="brutal-card pointer-events-none absolute z-10 max-w-xs px-3 py-2 text-sm"
          style={{
            left: Math.min(tooltipPos.x + 12, (containerRef.current?.clientWidth || 400) - 200),
            top: tooltipPos.y - 50,
          }}
        >
          <div className="truncate text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">
            {hoveredCamera.image_name}
          </div>
          <div className="mt-1 text-xs text-[color:var(--text-secondary)]">
            pos: ({hoveredCamera.position.map(v => v.toFixed(2)).join(', ')})
          </div>
          {hoveredCamera.width && hoveredCamera.height && (
            <div className="text-xs text-[color:var(--text-muted)]">
              {hoveredCamera.width}&times;{hoveredCamera.height}
            </div>
          )}
        </div>
      )}

      <div className="absolute top-3 right-3 z-20 flex flex-col items-end gap-2">
        <div className="brutal-card px-3 py-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
          Drag to orbit &middot; Scroll to zoom &middot; Right-click to pan
        </div>

        <button
          type="button"
          onClick={() => setSettingsOpen(o => !o)}
          className="brutal-btn brutal-btn-xs"
          title="Scene controls"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5" role="img" aria-label="Settings">
            <title>Settings</title>
            <path fillRule="evenodd" d="M8.34 1.804A1 1 0 019.32 1h1.36a1 1 0 01.98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 011.262.125l.962.962a1 1 0 01.125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 01.804.98v1.362a1 1 0 01-.804.98l-1.473.295c-.144.497-.342.971-.587 1.416l.834 1.25a1 1 0 01-.125 1.262l-.962.962a1 1 0 01-1.262.125l-1.25-.834c-.445.245-.919.443-1.416.587l-.294 1.473a1 1 0 01-.98.804H9.32a1 1 0 01-.98-.804l-.295-1.473a5.961 5.961 0 01-1.416-.587l-1.25.834a1 1 0 01-1.262-.125l-.962-.962a1 1 0 01-.125-1.262l.834-1.25a5.964 5.964 0 01-.587-1.416L1.804 11.66a1 1 0 01-.804-.98V9.32a1 1 0 01.804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 01.125-1.262l.962-.962A1 1 0 015.38 3.22l1.25.834c.445-.245.919-.443 1.416-.587l.294-1.473zM13 10a3 3 0 11-6 0 3 3 0 016 0z" clipRule="evenodd" />
          </svg>
          Controls
        </button>

        {settingsOpen && (
          <div className="brutal-card w-[240px] overflow-hidden">
            <div className="flex items-center justify-between border-b-[var(--border-w)] border-[color:var(--ink)] bg-[color:var(--paper-muted)] px-3 pb-1.5 pt-2.5">
              <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-secondary)]">Scene</span>
              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="brutal-btn brutal-btn-xs"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 px-3 py-2.5">
              <MiniSlider
                label="Frustum"
                value={frustumScale}
                min={0.2}
                max={3.0}
                step={0.05}
                onChange={setFrustumScale}
              />

              {hasSparsePoints && (
                <MiniSlider
                  label="Points"
                  value={pointSize}
                  min={0.005}
                  max={0.2}
                  step={0.005}
                  onChange={setPointSize}
                />
              )}

              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">
                <span className="w-[58px] shrink-0 font-bold text-[color:var(--text-secondary)]">Axis</span>
                <div className="flex gap-1 flex-1">
                  {(Object.keys(AXIS_PRESETS) as AxisPreset[]).map(key => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setAxisPreset(key)}
                      className={`border-[var(--border-w)] px-1.5 py-[3px] text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${
                        axisPreset === key
                          ? 'border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--text-on-ink)]'
                          : 'border-[color:var(--ink)] bg-[color:var(--paper-card)] text-[color:var(--text-secondary)] hover:bg-[color:var(--paper-muted)]'
                      }`}
                    >
                      {AXIS_PRESETS[key].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">
                <span className="w-[58px] shrink-0 font-bold text-[color:var(--text-secondary)]">Flip</span>
                <div className="flex gap-1.5 flex-1">
                  {([
                    { label: 'X', color: '#ff3333', active: flipX, toggle: () => setFlipX(f => !f) },
                    { label: 'Y', color: '#33ff33', active: flipY, toggle: () => setFlipY(f => !f) },
                    { label: 'Z', color: '#3377ff', active: flipZ, toggle: () => setFlipZ(f => !f) },
                  ] as const).map(ax => (
                    <button
                      key={ax.label}
                      type="button"
                      onClick={ax.toggle}
                        className={`flex items-center gap-1 border-[var(--border-w)] px-2 py-[3px] text-[10px] font-bold uppercase tracking-[0.12em] transition-colors ${
                          ax.active
                            ? 'border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--text-on-ink)]'
                            : 'border-[color:var(--ink)] bg-[color:var(--paper-card)] text-[color:var(--text-secondary)] hover:bg-[color:var(--paper-muted)]'
                        }`}
                      >
                      <span
                        className="inline-block h-1.5 w-1.5"
                        style={{ backgroundColor: ax.color }}
                      />
                      {ax.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-1 space-y-1.5 border-t-[var(--border-w)] border-[color:var(--paper-muted-2)] pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[color:var(--text-secondary)]">Rotate</span>
                  {(rotXDeg !== 0 || rotYDeg !== 0 || rotZDeg !== 0) && (
                    <button
                      type="button"
                      onClick={() => { setRotXDeg(0); setRotYDeg(0); setRotZDeg(0); }}
                      className="brutal-btn brutal-btn-xs"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {([
                  { label: 'X', color: '#ff3333', value: rotXDeg, set: setRotXDeg },
                  { label: 'Y', color: '#33ff33', value: rotYDeg, set: setRotYDeg },
                  { label: 'Z', color: '#3377ff', value: rotZDeg, set: setRotZDeg },
                ] as const).map(ax => (
                  <label key={ax.label} className="flex items-center gap-2 text-[11px] uppercase tracking-[0.12em] text-[color:var(--text-secondary)] select-none">
                    <span className="w-[58px] shrink-0 flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5" style={{ backgroundColor: ax.color }} />
                      <span className="font-bold text-[color:var(--text-secondary)]">{ax.label}</span>
                    </span>
                    <input
                      type="range"
                      min={-180}
                      max={180}
                      step={1}
                      value={ax.value}
                      onChange={e => ax.set(parseFloat(e.target.value))}
                      className="flex-1 h-1 cursor-pointer appearance-none bg-[color:var(--paper-muted-2)] accent-[var(--ink)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:bg-[var(--ink)]"
                    />
                    <span className="w-[34px] text-right font-mono tabular-nums text-[10px] text-[color:var(--text-muted)]">{ax.value}°</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="brutal-card absolute bottom-3 left-3 px-3 py-2 text-xs">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2" style={{ backgroundColor: '#ff3333' }} /> X
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2" style={{ backgroundColor: '#33ff33' }} /> Y
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-2 w-2" style={{ backgroundColor: '#3377ff' }} /> Z
          </span>
        </div>
      </div>
    </div>
  );
}
