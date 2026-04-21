'use client';

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

interface MarkerPosition {
  id: number;
  position: [number, number, number];
  rotation: [number, number, number];
  level: 'floor' | 'low' | 'mid' | 'high';
  label: string;
  heightCm: string;
}

// Marker positions for a 4x3m room
// Floor markers: rotation X=-90deg to lay flat, face up
// Wall markers: positioned slightly off wall, facing into room
const MARKER_POSITIONS: MarkerPosition[] = [
  // Floor level (0-10cm) - lay flat on floor, facing up
  { id: 0, position: [-1.5, 0.01, -1.0], rotation: [-Math.PI/2, 0, 0], level: 'floor', label: 'พื้น มุม 1', heightCm: '0-10 cm' },
  { id: 1, position: [1.5, 0.01, 1.0], rotation: [-Math.PI/2, 0, 0], level: 'floor', label: 'พื้น มุม 2', heightCm: '0-10 cm' },
  { id: 2, position: [0, 0.01, 0], rotation: [-Math.PI/2, 0, 0], level: 'floor', label: 'พื้น กลาง', heightCm: '0 cm' },
  
  // Low level (30-50cm) - on walls, facing into room
  { id: 3, position: [-1.98, 0.4, 0], rotation: [0, Math.PI/2, 0], level: 'low', label: 'ผนัง A ต่ำ', heightCm: '30-50 cm' },
  { id: 4, position: [1.98, 0.4, 0], rotation: [0, -Math.PI/2, 0], level: 'low', label: 'ผนัง B ต่ำ', heightCm: '30-50 cm' },
  { id: 5, position: [0, 0.4, -1.48], rotation: [0, 0, 0], level: 'low', label: 'ผนัง C ต่ำ', heightCm: '30-50 cm' },
  
  // Mid level (100-120cm) - eye level sitting
  { id: 6, position: [-1.98, 1.1, 0.5], rotation: [0, Math.PI/2, 0], level: 'mid', label: 'ผนัง A กลาง', heightCm: '100-120 cm' },
  { id: 7, position: [1.98, 1.1, -0.5], rotation: [0, -Math.PI/2, 0], level: 'mid', label: 'ผนัง B กลาง', heightCm: '100-120 cm' },
  { id: 8, position: [0.8, 1.1, -1.48], rotation: [0, 0, 0], level: 'mid', label: 'ผนัง C กลาง', heightCm: '100-120 cm' },
  
  // High level (170-200cm) - eye level standing
  { id: 9, position: [-1.98, 1.85, -0.5], rotation: [0, Math.PI/2, 0], level: 'high', label: 'ผนัง A สูง', heightCm: '170-200 cm' },
  { id: 10, position: [1.98, 1.85, 0.5], rotation: [0, -Math.PI/2, 0], level: 'high', label: 'ผนัง B สูง', heightCm: '170-200 cm' },
  { id: 11, position: [-0.8, 1.85, -1.48], rotation: [0, 0, 0], level: 'high', label: 'ผนัง C สูง', heightCm: '170-200 cm' },
];

const LEVEL_COLORS = {
  floor: 0x22c55e,  // green
  low: 0x3b82f6,    // blue
  mid: 0xa855f7,    // purple
  high: 0xf97316,   // orange
};

interface Props {
  selectedMarkerId?: number | null;
  onMarkerSelect?: (id: number) => void;
}

export default function RoomMarkerVisualization({ selectedMarkerId, onMarkerSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const markersRef = useRef<THREE.Mesh[]>([]);
  const cameraPathRef = useRef<THREE.Group | null>(null);
  const animationFrameRef = useRef<number>(0);
  const hoveredMarkerIdRef = useRef<number | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<MarkerPosition | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });
  const [showCameraPath, setShowCameraPath] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [currentStep, setCurrentStep] = useState(0);

  // Camera path waypoints for scanning
  const CAMERA_PATH = [
    { pos: [-1.5, 1.5, 1.2], lookAt: [-1.5, 1, -1], label: '1. เริ่มมุมห้อง - ถ่ายผนัง A+C', tilt: 'ก้มลงถ่ายพื้น' },
    { pos: [-1.5, 1.5, 0], lookAt: [-2, 1, 0], label: '2. เดินไปผนัง A - กวาดขึ้นลง', tilt: 'เงยขึ้นถ่ายสูง' },
    { pos: [-1.5, 1.5, -1], lookAt: [0, 1, -1.5], label: '3. มุมผนัง A+C - ถ่ายมุม', tilt: 'ก้มถ่าย markers พื้น' },
    { pos: [0, 1.5, -1], lookAt: [0, 1, -1.5], label: '4. กลางผนัง C - ถ่ายตรง', tilt: 'กวาดซ้าย-ขวา' },
    { pos: [1.5, 1.5, -1], lookAt: [2, 1, 0], label: '5. มุมผนัง B+C', tilt: 'เงยขึ้นถ่าย markers สูง' },
    { pos: [1.5, 1.5, 0], lookAt: [2, 1, 0], label: '6. เดินไปผนัง B', tilt: 'กวาดขึ้นลง' },
    { pos: [1.5, 1.5, 1], lookAt: [0, 0.5, 0], label: '7. มุมตรงข้าม - ถ่ายกลางห้อง', tilt: 'ก้มถ่ายพื้นกลาง' },
    { pos: [0, 1.5, 1], lookAt: [0, 1, -1], label: '8. ด้านหน้า - ถ่ายทั้งห้อง', tilt: 'กวาดซ้าย-ขวา-บน-ล่าง' },
    { pos: [0, 0.8, 0], lookAt: [0, 0, -1], label: '9. กลางห้อง (นั่ง) - มุมต่ำ', tilt: 'หมุนรอบ 360°' },
  ];

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf8fafc);
    sceneRef.current = scene;

    // Camera
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
    camera.position.set(5, 4, 5);
    cameraRef.current = camera;

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 3;
    controls.maxDistance = 15;
    controls.maxPolarAngle = Math.PI / 2;
    controlsRef.current = controls;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(5, 10, 5);
    directionalLight.castShadow = true;
    directionalLight.shadow.mapSize.width = 2048;
    directionalLight.shadow.mapSize.height = 2048;
    scene.add(directionalLight);

    // Room dimensions (4m x 3m x 2.5m)
    const roomWidth = 4;
    const roomDepth = 3;
    const roomHeight = 2.5;

    // Floor
    const floorGeometry = new THREE.PlaneGeometry(roomWidth, roomDepth);
    const floorMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xe5e7eb,
      roughness: 0.8,
    });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid on floor
    const gridHelper = new THREE.GridHelper(Math.max(roomWidth, roomDepth), 10, 0xcccccc, 0xdddddd);
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    // Walls (semi-transparent)
    const wallMaterial = new THREE.MeshStandardMaterial({ 
      color: 0xffffff,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
    });

    // Back wall
    const backWall = new THREE.Mesh(
      new THREE.PlaneGeometry(roomWidth, roomHeight),
      wallMaterial
    );
    backWall.position.set(0, roomHeight / 2, -roomDepth / 2);
    scene.add(backWall);

    // Left wall
    const leftWall = new THREE.Mesh(
      new THREE.PlaneGeometry(roomDepth, roomHeight),
      wallMaterial
    );
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-roomWidth / 2, roomHeight / 2, 0);
    scene.add(leftWall);

    // Right wall
    const rightWall = new THREE.Mesh(
      new THREE.PlaneGeometry(roomDepth, roomHeight),
      wallMaterial
    );
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.set(roomWidth / 2, roomHeight / 2, 0);
    scene.add(rightWall);

    // Wall edges
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x94a3b8 });
    
    const edges = [
      // Floor corners
      [[-roomWidth/2, 0, -roomDepth/2], [roomWidth/2, 0, -roomDepth/2]],
      [[-roomWidth/2, 0, -roomDepth/2], [-roomWidth/2, 0, roomDepth/2]],
      [[roomWidth/2, 0, -roomDepth/2], [roomWidth/2, 0, roomDepth/2]],
      [[-roomWidth/2, 0, roomDepth/2], [roomWidth/2, 0, roomDepth/2]],
      // Vertical edges
      [[-roomWidth/2, 0, -roomDepth/2], [-roomWidth/2, roomHeight, -roomDepth/2]],
      [[roomWidth/2, 0, -roomDepth/2], [roomWidth/2, roomHeight, -roomDepth/2]],
      [[-roomWidth/2, 0, roomDepth/2], [-roomWidth/2, roomHeight, roomDepth/2]],
      [[roomWidth/2, 0, roomDepth/2], [roomWidth/2, roomHeight, roomDepth/2]],
      // Top edges
      [[-roomWidth/2, roomHeight, -roomDepth/2], [roomWidth/2, roomHeight, -roomDepth/2]],
      [[-roomWidth/2, roomHeight, -roomDepth/2], [-roomWidth/2, roomHeight, roomDepth/2]],
      [[roomWidth/2, roomHeight, -roomDepth/2], [roomWidth/2, roomHeight, roomDepth/2]],
    ];

    edges.forEach(([start, end]) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(...start),
        new THREE.Vector3(...end)
      ]);
      const line = new THREE.Line(geometry, edgeMaterial);
      scene.add(line);
    });

    // Height reference lines with labels
    const heightLevels = [
      { height: 0.4, label: '40cm', color: 0x3b82f6 },
      { height: 1.1, label: '110cm', color: 0xa855f7 },
      { height: 1.85, label: '185cm', color: 0xf97316 },
    ];

    heightLevels.forEach(({ height, color }) => {
      const lineMaterial = new THREE.LineDashedMaterial({ 
        color, 
        dashSize: 0.1, 
        gapSize: 0.05,
        transparent: true,
        opacity: 0.5
      });
      const points = [
        new THREE.Vector3(-roomWidth/2, height, -roomDepth/2),
        new THREE.Vector3(-roomWidth/2, height, roomDepth/2),
      ];
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, lineMaterial);
      line.computeLineDistances();
      scene.add(line);
    });

    // Create markers
    markersRef.current = [];
    MARKER_POSITIONS.forEach((markerPos) => {
      const markerSize = 0.15;
      
      // Use PlaneGeometry for flat markers
      const geometry = new THREE.PlaneGeometry(markerSize, markerSize);
      const material = new THREE.MeshStandardMaterial({ 
        color: LEVEL_COLORS[markerPos.level],
        emissive: LEVEL_COLORS[markerPos.level],
        emissiveIntensity: 0.3,
        side: THREE.DoubleSide,
      });
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(...markerPos.position);
      marker.rotation.set(...markerPos.rotation);
      marker.castShadow = true;
      marker.userData = { markerData: markerPos };
      scene.add(marker);
      markersRef.current.push(marker);

      // Add white background for marker (like real ArUco)
      const bgGeometry = new THREE.PlaneGeometry(markerSize * 1.2, markerSize * 1.2);
      const bgMaterial = new THREE.MeshStandardMaterial({ 
        color: 0xffffff,
        side: THREE.DoubleSide,
      });
      const bg = new THREE.Mesh(bgGeometry, bgMaterial);
      bg.position.set(0, 0, -0.001); // Slightly behind the marker
      marker.add(bg);

      // Add marker border/frame
      const borderGeometry = new THREE.EdgesGeometry(new THREE.PlaneGeometry(markerSize * 1.2, markerSize * 1.2));
      const borderMaterial = new THREE.LineBasicMaterial({ color: 0x000000 });
      const border = new THREE.LineSegments(borderGeometry, borderMaterial);
      border.position.set(0, 0, 0.001);
      marker.add(border);

      // Add ID label sprite - floating above/in front of marker
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      canvas.width = 128;
      canvas.height = 64;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.roundRect(0, 0, 128, 64, 8);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = 'bold 28px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`ID: ${markerPos.id}`, 64, 32);
      
      const texture = new THREE.CanvasTexture(canvas);
      const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true });
      const sprite = new THREE.Sprite(spriteMaterial);
      sprite.scale.set(0.2, 0.1, 1);
      
      // Position label floating above marker
      if (markerPos.level === 'floor') {
        sprite.position.set(0, 0.12, 0);
      } else {
        sprite.position.set(0, 0.12, 0);
      }
      marker.add(sprite);
    });

    // Create camera path visualization
    const cameraPathGroup = new THREE.Group();
    cameraPathGroup.visible = false;
    cameraPathRef.current = cameraPathGroup;
    scene.add(cameraPathGroup);

    // Path line
    const pathPoints = CAMERA_PATH.map(wp => new THREE.Vector3(...wp.pos as [number, number, number]));
    pathPoints.push(pathPoints[0]); // Close the loop
    const pathGeometry = new THREE.BufferGeometry().setFromPoints(pathPoints);
    const pathMaterial = new THREE.LineDashedMaterial({ 
      color: 0xef4444, 
      dashSize: 0.1, 
      gapSize: 0.05,
      linewidth: 2 
    });
    const pathLine = new THREE.Line(pathGeometry, pathMaterial);
    pathLine.computeLineDistances();
    cameraPathGroup.add(pathLine);

    // Waypoint markers and direction arrows
    CAMERA_PATH.forEach((wp, idx) => {
      // Camera position sphere
      const sphereGeom = new THREE.SphereGeometry(0.08);
      const sphereMat = new THREE.MeshStandardMaterial({ 
        color: 0xef4444,
        emissive: 0xef4444,
        emissiveIntensity: 0.3
      });
      const sphere = new THREE.Mesh(sphereGeom, sphereMat);
      sphere.position.set(...wp.pos as [number, number, number]);
      cameraPathGroup.add(sphere);

      // Step number label
      const labelCanvas = document.createElement('canvas');
      const labelCtx = labelCanvas.getContext('2d')!;
      labelCanvas.width = 64;
      labelCanvas.height = 64;
      labelCtx.fillStyle = '#ef4444';
      labelCtx.beginPath();
      labelCtx.arc(32, 32, 28, 0, Math.PI * 2);
      labelCtx.fill();
      labelCtx.fillStyle = 'white';
      labelCtx.font = 'bold 32px Arial';
      labelCtx.textAlign = 'center';
      labelCtx.textBaseline = 'middle';
      labelCtx.fillText((idx + 1).toString(), 32, 32);
      
      const labelTexture = new THREE.CanvasTexture(labelCanvas);
      const labelSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture }));
      labelSprite.scale.set(0.2, 0.2, 1);
      labelSprite.position.set(wp.pos[0], wp.pos[1] + 0.2, wp.pos[2]);
      cameraPathGroup.add(labelSprite);

      // Direction arrow (look direction)
      const lookAtVec = new THREE.Vector3(...wp.lookAt as [number, number, number]);
      const posVec = new THREE.Vector3(...wp.pos as [number, number, number]);
      const direction = lookAtVec.clone().sub(posVec).normalize();
      
      const arrowHelper = new THREE.ArrowHelper(
        direction,
        posVec,
        0.4,
        0x22c55e,
        0.1,
        0.08
      );
      cameraPathGroup.add(arrowHelper);
    });

    // Raycaster for hover detection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    const onMouseMove = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      
      setTooltipPos({ x: event.clientX - rect.left, y: event.clientY - rect.top });

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(markersRef.current, true);

      if (intersects.length > 0) {
        // Find the parent marker mesh if hovered on child (border/sprite)
        let targetMesh = intersects[0].object as THREE.Mesh;
        while (targetMesh && !targetMesh.userData?.markerData && targetMesh.parent) {
          targetMesh = targetMesh.parent as THREE.Mesh;
        }
        
        const markerData = targetMesh?.userData?.markerData as MarkerPosition | undefined;
        if (markerData) {
          setHoveredMarker(markerData);
          container.style.cursor = 'pointer';
        } else {
          setHoveredMarker(null);
          container.style.cursor = 'grab';
        }
      } else {
        setHoveredMarker(null);
        container.style.cursor = 'grab';
      }
    };

    const onClick = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(markersRef.current, true);

      if (intersects.length > 0 && onMarkerSelect) {
        // Find the parent marker mesh if clicked on child (border/sprite)
        let targetMesh = intersects[0].object as THREE.Mesh;
        while (targetMesh && !targetMesh.userData?.markerData && targetMesh.parent) {
          targetMesh = targetMesh.parent as THREE.Mesh;
        }
        
        const markerData = targetMesh?.userData?.markerData as MarkerPosition | undefined;
        if (markerData && typeof markerData.id === 'number') {
          onMarkerSelect(markerData.id);
        }
      }
    };

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('click', onClick);

    // Animation
    const animate = () => {
      animationFrameRef.current = requestAnimationFrame(animate);
      controls.update();

      // Highlight selected/hovered marker
      markersRef.current.forEach((marker) => {
        const markerData = marker.userData.markerData as MarkerPosition;
        const material = marker.material as THREE.MeshStandardMaterial;
        
        if (markerData.id === selectedMarkerId || markerData.id === hoveredMarkerIdRef.current) {
          material.emissiveIntensity = 0.6;
          marker.scale.setScalar(1.2);
        } else {
          material.emissiveIntensity = 0.2;
          marker.scale.setScalar(1);
        }
      });

      renderer.render(scene, camera);
    };
    animate();

    // Resize handler
    const handleResize = () => {
      const newWidth = container.clientWidth;
      const newHeight = container.clientHeight;
      camera.aspect = newWidth / newHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(newWidth, newHeight);
    };
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('click', onClick);
      cancelAnimationFrame(animationFrameRef.current);
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, [selectedMarkerId, onMarkerSelect]);

  // Update hover effect in animation loop
  useEffect(() => {
    hoveredMarkerIdRef.current = hoveredMarker?.id ?? null;
    markersRef.current.forEach((marker) => {
      const markerData = marker.userData.markerData as MarkerPosition;
      const material = marker.material as THREE.MeshStandardMaterial;
      
      if (markerData.id === selectedMarkerId || markerData.id === hoveredMarker?.id) {
        material.emissiveIntensity = 0.6;
        marker.scale.setScalar(1.2);
      } else {
        material.emissiveIntensity = 0.2;
        marker.scale.setScalar(1);
      }
    });
  }, [selectedMarkerId, hoveredMarker?.id]);

  // Toggle camera path visibility
  useEffect(() => {
    if (cameraPathRef.current) {
      cameraPathRef.current.visible = showCameraPath;
    }
  }, [showCameraPath]);

  // Animate camera to waypoint
  const animateToWaypoint = (stepIndex: number) => {
    if (!cameraRef.current || !controlsRef.current) return;
    
    const wp = CAMERA_PATH[stepIndex];
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    
    const startPos = camera.position.clone();
    const endPos = new THREE.Vector3(...wp.pos as [number, number, number]);
    const lookAt = new THREE.Vector3(...wp.lookAt as [number, number, number]);
    
    let progress = 0;
    const duration = 1000; // 1 second
    const startTime = Date.now();
    
    const animateStep = () => {
      progress = (Date.now() - startTime) / duration;
      if (progress >= 1) {
        camera.position.copy(endPos);
        controls.target.copy(lookAt);
        controls.update();
        setIsAnimating(false);
        return;
      }
      
      // Smooth easing
      const eased = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(startPos, endPos, eased);
      controls.target.lerp(lookAt, eased * 0.1);
      controls.update();
      
      requestAnimationFrame(animateStep);
    };
    
    setIsAnimating(true);
    animateStep();
  };

  const nextStep = () => {
    const next = (currentStep + 1) % CAMERA_PATH.length;
    setCurrentStep(next);
    animateToWaypoint(next);
  };

  const prevStep = () => {
    const prev = (currentStep - 1 + CAMERA_PATH.length) % CAMERA_PATH.length;
    setCurrentStep(prev);
    animateToWaypoint(prev);
  };

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      
      {/* Tooltip */}
      {hoveredMarker && (
        <div 
          className="brutal-card pointer-events-none absolute z-10 px-3 py-2 text-sm"
          style={{ 
            left: tooltipPos.x + 10, 
            top: tooltipPos.y - 60,
            transform: 'translateX(-50%)'
          }}
        >
          <div className="text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">ID: {hoveredMarker.id}</div>
          <div className="text-sm text-[color:var(--text-secondary)]">{hoveredMarker.label}</div>
          <div className="text-xs text-[color:var(--text-muted)]">ความสูง: {hoveredMarker.heightCm}</div>
        </div>
      )}

      {/* Legend */}
      <div className="brutal-card absolute bottom-3 left-3 p-3 text-xs">
        <div className="mb-2 font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">ระดับความสูง</div>
        <div className="space-y-1.5">
          <div className="flex items-center">
            <div className="mr-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)]" style={{ backgroundColor: '#22c55e' }}></div>
            <span className="text-[color:var(--text-secondary)]">พื้น (0-10 cm)</span>
          </div>
          <div className="flex items-center">
            <div className="mr-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)]" style={{ backgroundColor: '#3b82f6' }}></div>
            <span className="text-[color:var(--text-secondary)]">ต่ำ (30-50 cm)</span>
          </div>
          <div className="flex items-center">
            <div className="mr-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)]" style={{ backgroundColor: '#a855f7' }}></div>
            <span className="text-[color:var(--text-secondary)]">กลาง (100-120 cm)</span>
          </div>
          <div className="flex items-center">
            <div className="mr-2 h-3 w-3 border-[var(--border-w)] border-[color:var(--ink)]" style={{ backgroundColor: '#f97316' }}></div>
            <span className="text-[color:var(--text-secondary)]">สูง (170-200 cm)</span>
          </div>
        </div>
      </div>

      {/* Camera Path Toggle */}
      <div className="absolute bottom-3 right-3 overflow-hidden">
        <button
          type="button"
          onClick={() => setShowCameraPath(!showCameraPath)}
          className={`brutal-btn brutal-btn-xs ${
            showCameraPath 
              ? 'brutal-btn-primary'
              : ''
          }`}
        >
          🎬 {showCameraPath ? 'ซ่อนเส้นทาง' : 'แสดงเส้นทางถ่าย'}
        </button>
      </div>

      {/* Camera Path Controls - Show when path is visible */}
      {showCameraPath && (
        <div className="brutal-card absolute bottom-16 right-3 max-w-[220px] p-3">
          <div className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-primary)]">
            🎥 ขั้นตอนที่ {currentStep + 1}/{CAMERA_PATH.length}
          </div>
          <div className="mb-2 text-xs text-[color:var(--text-secondary)]">
            {CAMERA_PATH[currentStep].label}
          </div>
          <div className="mb-3 text-xs text-[color:var(--text-muted)]">
            💡 {CAMERA_PATH[currentStep].tilt}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={prevStep}
              disabled={isAnimating}
              className="brutal-btn brutal-btn-xs flex-1 justify-center"
            >
              ◀ ก่อน
            </button>
            <button
              type="button"
              onClick={nextStep}
              disabled={isAnimating}
              className="brutal-btn brutal-btn-primary brutal-btn-xs flex-1 justify-center"
            >
              ถัดไป ▶
            </button>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="brutal-card absolute top-3 right-3 px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
        🖱️ ลากเพื่อหมุน • Scroll เพื่อซูม
      </div>

      {/* Room dimensions */}
      <div className="brutal-card absolute top-3 left-3 px-3 py-2 text-xs font-bold uppercase tracking-[0.14em] text-[color:var(--text-secondary)]">
        📐 ห้องจำลอง 4×3×2.5 เมตร
      </div>
    </div>
  );
}
