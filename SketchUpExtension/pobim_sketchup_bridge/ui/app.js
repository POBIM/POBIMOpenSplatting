(function () {
  const SKETCHUP_MAX_ATTEMPTS = 20;
  const SKETCHUP_RETRY_DELAY = 100;
  const CAMERA_PUSH_DELAY = 100;
  const GRID_SIZE = 15;
  const GRID_STEP = 1.5;
  const MAX_SEGMENTS = 60000;
  const MAX_FACES = 40000;

  const dom = {
    canvas: null,
    ctx: null,
    modelName: null,
    meshStatus: null,
    splatStatus: null,
    cameraStatus: null,
    logPanel: null,
    resetButton: null,
    reloadButton: null,
    clearLogButton: null
  };

  const vec3 = {
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    cross: (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    }),
    length: (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
    normalize: (a) => {
      const len = vec3.length(a) || 1;
      return { x: a.x / len, y: a.y / len, z: a.z / len };
    }
  };

  const state = {
    originOffset: { x: 0, y: 0, z: 0 },
    unitScale: 0.0254,
    suppressCameraBroadcast: false,
    cameraBroadcastTimer: null,
    lastCameraFromSketchUp: null,
    cameraPose: {
      eye: { x: 3, y: 3, z: 3 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 60,
      aspect: 1
    },
    mesh: null,
    meshBounds: null,
    interaction: {
      active: false,
      pointerId: null,
      lastX: 0,
      lastY: 0,
      mode: 'orbit'
    }
  };

  function initDom() {
    dom.canvas = document.getElementById('viewerCanvas');
    dom.ctx = dom.canvas?.getContext('2d');
    dom.modelName = document.getElementById('modelName');
    dom.meshStatus = document.getElementById('meshStatus');
    dom.splatStatus = document.getElementById('splatStatus');
    dom.cameraStatus = document.getElementById('cameraStatus');
    dom.logPanel = document.getElementById('logPanel');
    dom.resetButton = document.getElementById('resetCamera');
    dom.reloadButton = document.getElementById('reloadMesh');
    dom.clearLogButton = document.getElementById('clearLog');
  }

  function ensureViewer() {
    if (!dom.canvas || !dom.ctx) {
      return;
    }

    handleResize();
    window.addEventListener('resize', handleResize);
    dom.canvas.addEventListener('pointerdown', handlePointerDown);
    dom.canvas.addEventListener('pointermove', handlePointerMove);
    dom.canvas.addEventListener('pointerup', handlePointerUp);
    dom.canvas.addEventListener('pointercancel', handlePointerUp);
    dom.canvas.addEventListener('wheel', handleWheel, { passive: false });
    dom.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    requestAnimationFrame(renderLoop);
  }

  function handleResize() {
    if (!dom.canvas || !dom.ctx) {
      return;
    }
    const rect = dom.canvas.getBoundingClientRect();
    const width = rect.width || dom.canvas.parentElement?.clientWidth || window.innerWidth;
    const height = rect.height || dom.canvas.parentElement?.clientHeight || window.innerHeight;
    dom.canvas.width = Math.max(1, Math.floor(width));
    dom.canvas.height = Math.max(1, Math.floor(height));
    state.cameraPose.aspect = dom.canvas.width / Math.max(dom.canvas.height, 1);
  }

  function renderLoop() {
    drawScene();
    requestAnimationFrame(renderLoop);
  }

  function drawScene() {
    if (!dom.ctx || !dom.canvas) {
      return;
    }
    const ctx = dom.ctx;
    const { width, height } = dom.canvas;
    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#020617');
    gradient.addColorStop(1, '#0f172a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    drawGrid(ctx);
    drawAxes(ctx);
    drawMeshFaces(ctx);
    drawMesh(ctx);
    drawCameraIndicator(ctx);
  }

  function drawGrid(ctx) {
    ctx.lineWidth = 1;
    for (let i = -GRID_SIZE; i <= GRID_SIZE; i += GRID_STEP) {
      const alpha = i === 0 ? 0.35 : 0.15;
      ctx.strokeStyle = `rgba(148, 163, 184, ${alpha})`;
      drawWorldLine(ctx, { x: i, y: -GRID_SIZE, z: 0 }, { x: i, y: GRID_SIZE, z: 0 });
      drawWorldLine(ctx, { x: -GRID_SIZE, y: i, z: 0 }, { x: GRID_SIZE, y: i, z: 0 });
    }
  }

  function drawAxes(ctx) {
    const origin = { x: 0, y: 0, z: 0 };
    ctx.lineWidth = 2;

    ctx.strokeStyle = 'rgba(248, 113, 113, 0.9)';
    drawWorldLine(ctx, origin, { x: 2, y: 0, z: 0 });

    ctx.strokeStyle = 'rgba(74, 222, 128, 0.9)';
    drawWorldLine(ctx, origin, { x: 0, y: 2, z: 0 });

    ctx.strokeStyle = 'rgba(96, 165, 250, 0.9)';
    drawWorldLine(ctx, origin, { x: 0, y: 0, z: 2 });
  }

  function drawMesh(ctx) {
    if (!state.mesh || !state.mesh.segments?.length) {
      return;
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(147, 197, 253, 0.75)';

    for (let i = 0; i < state.mesh.segments.length; i++) {
      const [aIndex, bIndex] = state.mesh.segments[i];
      const a = state.mesh.vertices[aIndex];
      const b = state.mesh.vertices[bIndex];
      if (!a || !b) {
        continue;
      }
      const screenA = projectPoint(a);
      const screenB = projectPoint(b);
      if (!screenA || !screenB) {
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(screenA.x, screenA.y);
      ctx.lineTo(screenB.x, screenB.y);
      ctx.stroke();
    }
  }

  function drawMeshFaces(ctx) {
    if (!state.mesh || !state.mesh.faces?.length) {
      return;
    }
    const faces = state.mesh.faces;
    const projected = [];
    for (let i = 0; i < faces.length; i++) {
      const [aIndex, bIndex, cIndex] = faces[i];
      const a = projectPoint(state.mesh.vertices[aIndex]);
      const b = projectPoint(state.mesh.vertices[bIndex]);
      const c = projectPoint(state.mesh.vertices[cIndex]);
      if (!a || !b || !c) {
        continue;
      }
      const depth = (a.depth + b.depth + c.depth) / 3;
      projected.push({ a, b, c, depth });
    }
    projected.sort((left, right) => right.depth - left.depth);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.18)';
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.35)';
    ctx.lineWidth = 1;
    for (let i = 0; i < projected.length; i++) {
      const face = projected[i];
      ctx.beginPath();
      ctx.moveTo(face.a.x, face.a.y);
      ctx.lineTo(face.b.x, face.b.y);
      ctx.lineTo(face.c.x, face.c.y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawCameraIndicator(ctx) {
    const screenPos = projectPoint(state.cameraPose.eye);
    if (!screenPos) {
      return;
    }
    ctx.fillStyle = 'rgba(14, 165, 233, 0.9)';
    ctx.beginPath();
    ctx.arc(screenPos.x, screenPos.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawWorldLine(ctx, start, end) {
    const a = projectPoint(start);
    const b = projectPoint(end);
    if (!a || !b) {
      return;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  function projectPoint(point) {
    const pose = state.cameraPose;
    const eye = pose.eye;
    const target = pose.target;
    const up = pose.up;
    const aspect = pose.aspect || 1;
    const fov = (pose.fov || 60) * (Math.PI / 180);

    const forward = vec3.normalize(vec3.sub(target, eye));
    const right = vec3.normalize(vec3.cross(forward, up));
    const trueUp = vec3.cross(right, forward);
    const relative = vec3.sub(point, eye);

    const x = vec3.dot(relative, right);
    const y = vec3.dot(relative, trueUp);
    const z = vec3.dot(relative, forward);

    if (z <= 0.05) {
      return null;
    }

    const scale = Math.tan(fov / 2);
    const ndcX = (x / (scale * z)) / aspect;
    const ndcY = y / (scale * z);

    const screenX = (ndcX * 0.5 + 0.5) * dom.canvas.width;
    const screenY = (-ndcY * 0.5 + 0.5) * dom.canvas.height;
    return { x: screenX, y: screenY, depth: z };
  }

  function handlePointerDown(event) {
    event.preventDefault();
    if (!dom.canvas) return;
    dom.canvas.setPointerCapture(event.pointerId);
    state.interaction = {
      active: true,
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
      mode: event.button === 2 || event.shiftKey ? 'pan' : 'orbit'
    };
  }

  function handlePointerMove(event) {
    if (state.interaction.active) {
      event.preventDefault();
    }
    const interaction = state.interaction;
    if (!interaction.active || interaction.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - interaction.lastX;
    const dy = event.clientY - interaction.lastY;
    interaction.lastX = event.clientX;
    interaction.lastY = event.clientY;

    if (interaction.mode === 'pan') {
      panCamera(dx, dy);
    } else {
      orbitCamera(dx, dy);
    }
  }

  function handlePointerUp(event) {
    const interaction = state.interaction;
    if (interaction.pointerId === event.pointerId) {
      state.interaction = { active: false, pointerId: null, lastX: 0, lastY: 0, mode: 'orbit' };
      scheduleCameraBroadcast();
    }
  }

  function handleWheel(event) {
    event.preventDefault();
    const delta = Math.sign(event.deltaY);
    const pose = state.cameraPose;
    const offset = vec3.sub(pose.eye, pose.target);
    const radius = Math.max(vec3.length(offset), 0.1);
    const factor = delta > 0 ? 1.1 : 0.9;
    const newRadius = Math.min(Math.max(radius * factor, 0.2), 200);
    const direction = vec3.normalize(offset);
    pose.eye = vec3.add(pose.target, vec3.scale(direction, newRadius));
    scheduleCameraBroadcast();
  }

  function orbitCamera(dx, dy) {
    const pose = state.cameraPose;
    const offset = vec3.sub(pose.eye, pose.target);
    const radius = Math.max(vec3.length(offset), 0.1);
    let theta = Math.atan2(offset.y, offset.x);
    let phi = Math.acos(offset.z / radius);

    theta -= dx * 0.005;
    phi = Math.min(Math.max(phi - dy * 0.005, 0.01), Math.PI - 0.01);

    const sinPhi = Math.sin(phi);
    const newOffset = {
      x: radius * Math.cos(theta) * sinPhi,
      y: radius * Math.sin(theta) * sinPhi,
      z: radius * Math.cos(phi)
    };

    pose.eye = vec3.add(pose.target, newOffset);
    scheduleCameraBroadcast();
    updateCameraStatus('Orbiting…');
  }

  function panCamera(dx, dy) {
    const pose = state.cameraPose;
    const forward = vec3.normalize(vec3.sub(pose.target, pose.eye));
    const right = vec3.normalize(vec3.cross(forward, pose.up));
    const up = vec3.normalize(vec3.cross(right, forward));
    const distance = vec3.length(vec3.sub(pose.eye, pose.target));
    const scale = distance * 0.0015;

    const move = vec3.add(vec3.scale(right, -dx * scale), vec3.scale(up, dy * scale));
    pose.eye = vec3.add(pose.eye, move);
    pose.target = vec3.add(pose.target, move);
    scheduleCameraBroadcast();
    updateCameraStatus('Panning…');
  }

  function scheduleCameraBroadcast() {
    if (state.suppressCameraBroadcast) {
      return;
    }
    if (state.cameraBroadcastTimer) {
      window.clearTimeout(state.cameraBroadcastTimer);
    }
    state.cameraBroadcastTimer = window.setTimeout(() => {
      state.cameraBroadcastTimer = null;
      pushCameraToSketchUp();
    }, CAMERA_PUSH_DELAY);
  }

  function pushCameraToSketchUp() {
    const pose = state.cameraPose;
    const payload = {
      eye: addOffset(pose.eye),
      target: addOffset(pose.target),
      up: pose.up,
      fov: pose.fov,
      aspect: pose.aspect
    };
    callSketchUp('dialogCameraChanged', JSON.stringify(payload));
    updateCameraStatus('Synced');
  }

  function addOffset(vec) {
    return {
      x: vec.x + state.originOffset.x,
      y: vec.y + state.originOffset.y,
      z: vec.z + state.originOffset.z
    };
  }

  function subtractOffset(vec = {}) {
    return {
      x: (vec.x || 0) - state.originOffset.x,
      y: (vec.y || 0) - state.originOffset.y,
      z: (vec.z || 0) - state.originOffset.z
    };
  }

  function callSketchUp(method, payload, options = {}) {
    const { attempt = 0, retry = false } = options;
    const api = window.sketchup;
    if (api && typeof api[method] === 'function') {
      try {
        return payload !== undefined ? api[method](payload) : api[method]();
      } catch (err) {
        log(`SketchUp call failed: ${method}`, 'error', err);
      }
      return undefined;
    }

    if (retry && attempt < SKETCHUP_MAX_ATTEMPTS) {
      window.setTimeout(() => {
        callSketchUp(method, payload, { retry: true, attempt: attempt + 1 });
      }, SKETCHUP_RETRY_DELAY);
    } else if (!retry) {
      log(`SketchUp method unavailable: ${method}`, 'warn');
    }
    return undefined;
  }

  function log(message, level = 'info', data = null) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = document.createElement('div');
    entry.className = `log-entry ${level}`;
    const timeSpan = document.createElement('span');
    timeSpan.className = 'time';
    timeSpan.textContent = timestamp;
    entry.appendChild(timeSpan);
    entry.appendChild(document.createTextNode(` ${message}`));

    if (data) {
      const detail = document.createElement('div');
      detail.style.opacity = '0.8';
      detail.style.marginTop = '0.25rem';
      detail.style.fontSize = '0.78rem';
      detail.textContent = typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data);
      entry.appendChild(detail);
    }

    dom.logPanel?.appendChild(entry);
    while (dom.logPanel && dom.logPanel.children.length > 120) {
      dom.logPanel.removeChild(dom.logPanel.firstChild);
    }
    if (dom.logPanel) {
      dom.logPanel.scrollTop = dom.logPanel.scrollHeight;
    }

    if (level === 'error') {
      console.error('[Bridge]', message, data);
    } else if (level === 'warn') {
      console.warn('[Bridge]', message, data);
    } else {
      console.log('[Bridge]', message, data);
    }
  }

  function updateMeshStatus(text, muted = false) {
    if (!dom.meshStatus) return;
    dom.meshStatus.textContent = text;
    dom.meshStatus.classList.toggle('muted', !!muted);
  }

  function updateSplatStatus(text, muted = false) {
    if (!dom.splatStatus) return;
    dom.splatStatus.textContent = text;
    dom.splatStatus.classList.toggle('muted', !!muted);
  }

  function updateCameraStatus(text, muted = false) {
    if (!dom.cameraStatus) return;
    dom.cameraStatus.textContent = text;
    dom.cameraStatus.classList.toggle('muted', !!muted);
  }

  function handleBridgeInit(payload = {}) {
    log('Received init payload', 'info', payload);
    dom.modelName.textContent = payload.model_name || 'Untitled Model';
    if (payload.origin_offset) {
      state.originOffset = { ...payload.origin_offset };
    }
    if (typeof payload.unit_scale === 'number') {
      state.unitScale = payload.unit_scale;
    }

    if (payload.mesh) {
      updateMeshStatus(`Cached • ${payload.mesh.name || 'proxy mesh'}`);
    } else {
      updateMeshStatus('Waiting…', true);
    }

    if (payload.gaussian) {
      updateSplatStatus(`Cached • ${payload.gaussian.name || '.ply'}`);
    } else {
      updateSplatStatus('Waiting…', true);
    }

    if (payload.camera) {
      applyCameraFromSketchUp(payload.camera);
    } else {
      requestCameraSync();
    }
  }

  async function handleMeshReady(payload = {}) {
    if (!payload.url) {
      updateMeshStatus('Mesh payload missing URL', true);
      log('Mesh payload missing URL', 'error', payload);
      return;
    }

    if (payload.origin_offset) {
      state.originOffset = { ...payload.origin_offset };
    }

    state.mesh = null;
    state.meshBounds = null;
    updateMeshStatus('Loading proxy mesh…', true);
    log('Mesh payload received', 'info', payload);

    try {
      const mesh = await loadMeshFromPayload(payload);
      state.mesh = mesh;
      state.meshBounds = mesh.bounds;
      updateMeshStatus(`Cached • ${payload.name || 'proxy mesh'}`);
      const diag = Math.sqrt(
        mesh.bounds.size.x ** 2 + mesh.bounds.size.y ** 2 + mesh.bounds.size.z ** 2
      );
      log(
        `Parsed mesh (${mesh.vertexCount} verts, ${mesh.segmentCount} edges, ${mesh.faceCount} faces)`,
        'success',
        { diagonal: diag.toFixed(3) }
      );

      if (!state.lastCameraFromSketchUp) {
        frameCameraOnMesh();
        scheduleCameraBroadcast();
      }
    } catch (err) {
      log('Failed to load mesh', 'error', err);
      updateMeshStatus('Failed to load mesh', true);
    }
  }

  function handleGaussianReady(payload = {}) {
    updateSplatStatus(`Ready • ${payload.name || 'splat'}`);
    log('Gaussian payload received', 'info', payload);
  }

  async function loadMeshFromPayload(payload) {
    const response = await fetch(payload.url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching mesh`);
    }
    const text = await response.text();
    const format = inferFormat(payload);
    if (format === 'dae') {
      return parseDaeText(text, payload.url);
    }
    return parseObjText(text, payload.url);
  }

  function parseObjText(text, sourceUrl) {
    const vertices = [];
    const segments = [];
    const faces = [];
    const lines = text.split(/\r?\n/);
    const origin = state.originOffset;
    const scale = state.unitScale || 1.0;

    const pushFace = (a, b, c) => {
      if (faces.length < MAX_FACES) {
        faces.push([a, b, c]);
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw) continue;
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;

      if (line.startsWith('v ')) {
        const parts = line
          .slice(2)
          .trim()
          .split(/\s+/)
          .map((value) => parseFloat(value));
        if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) {
          continue;
        }
        vertices.push({
          x: parts[0] * scale - origin.x,
          y: parts[1] * scale - origin.y,
          z: parts[2] * scale - origin.z
        });
      } else if (line.startsWith('f ')) {
        const tokens = line.slice(2).trim().split(/\s+/);
        const indices = tokens
          .map((token) => {
            const base = token.split('/')[0];
            const idx = parseInt(base, 10);
            return Number.isNaN(idx) ? null : idx - 1;
          })
          .filter((idx) => idx !== null && idx >= 0 && idx < vertices.length);
        if (indices.length < 2) {
          continue;
        }
        for (let j = 0; j < indices.length; j++) {
          const current = indices[j];
          const next = indices[(j + 1) % indices.length];
          if (current === next) continue;
          if (segments.length >= MAX_SEGMENTS) break;
          segments.push([current, next]);
        }
        for (let j = 1; j < indices.length - 1 && faces.length < MAX_FACES; j++) {
          pushFace(indices[0], indices[j], indices[j + 1]);
        }
      }
      if (segments.length >= MAX_SEGMENTS) {
        break;
      }
    }

    if (!vertices.length) {
      throw new Error('Mesh contains no vertices');
    }

    const bounds = computeBounds(vertices);

    return {
      sourceUrl,
      vertices,
      segments,
      faces,
      bounds,
      vertexCount: vertices.length,
      segmentCount: segments.length,
      faceCount: faces.length
    };
  }

  function parseDaeText(text, sourceUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Unable to parse DAE scene');
    }

    const sourceData = {};
    doc.querySelectorAll('source').forEach((source) => {
      const id = source.getAttribute('id');
      if (!id) return;
      const floatArray = source.querySelector('float_array');
      if (!floatArray) return;
      const accessor = source.querySelector('technique_common accessor');
      const stride = parseInt(accessor?.getAttribute('stride'), 10) || 3;
      const values = floatArray.textContent
        .trim()
        .split(/\s+/)
        .map((value) => parseFloat(value))
        .filter((value) => !Number.isNaN(value));
      sourceData[id] = { stride, values };
    });

    const verticesMap = {};
    doc.querySelectorAll('vertices').forEach((vertexNode) => {
      const id = vertexNode.getAttribute('id');
      if (!id) return;
      const positionInput = vertexNode.querySelector('input[semantic="POSITION"]');
      const sourceRef = positionInput?.getAttribute('source')?.replace(/^#/, '');
      if (sourceRef) {
        verticesMap[id] = sourceRef;
      }
    });

    const vertices = [];
    const faces = [];
    const sourceOffsets = {};
    const scale = state.unitScale || 1.0;
    const origin = state.originOffset;

    const ensureSource = (sourceId) => {
      if (!sourceId || !sourceData[sourceId]) {
        return null;
      }
      if (!sourceOffsets[sourceId]) {
        const { stride, values } = sourceData[sourceId];
        const offset = vertices.length;
        let count = 0;
        for (let i = 0; i < values.length; i += stride) {
          vertices.push({
            x: (values[i] || 0) * scale - origin.x,
            y: (values[i + 1] || 0) * scale - origin.y,
            z: (values[i + 2] || 0) * scale - origin.z
          });
          count += 1;
        }
        sourceOffsets[sourceId] = { offset, count };
      }
      return sourceOffsets[sourceId];
    };

    const segments = [];
    const seen = new Set();
    const addEdge = (a, b) => {
      if (a === b || a == null || b == null) return;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (segments.length < MAX_SEGMENTS) {
        segments.push([a, b]);
      }
    };
    const addFaceTriangles = (faceIndices) => {
      if (faceIndices.length < 3) {
        return;
      }
      for (let i = 1; i < faceIndices.length - 1 && faces.length < MAX_FACES; i++) {
        faces.push([faceIndices[0], faceIndices[i], faceIndices[i + 1]]);
      }
    };

    const processPrimitive = (node, faceCounts = null) => {
      const inputs = Array.from(node.querySelectorAll('input'));
      if (!inputs.length) {
        return;
      }
      const vertexInput =
        inputs.find((input) => input.getAttribute('semantic') === 'VERTEX') ||
        inputs.find((input) => input.getAttribute('semantic') === 'POSITION');
      if (!vertexInput) {
        return;
      }
      const vertexOffset = parseInt(vertexInput.getAttribute('offset'), 10) || 0;
      const strideWidth =
        inputs.reduce((max, input) => Math.max(max, parseInt(input.getAttribute('offset'), 10) || 0), 0) + 1;
      if (strideWidth <= 0) {
        return;
      }
      let positionSourceId = vertexInput.getAttribute('source')?.replace(/^#/, '');
      if (vertexInput.getAttribute('semantic') === 'VERTEX') {
        positionSourceId = verticesMap[positionSourceId];
      }
      const sourceMeta = ensureSource(positionSourceId);
      if (!sourceMeta) {
        return;
      }
      const indicesText = node.querySelector('p')?.textContent || '';
      const indices = indicesText
        .trim()
        .split(/\s+/)
        .map((value) => parseInt(value, 10))
        .filter((value) => !Number.isNaN(value));
      if (!indices.length) {
        return;
      }

      const collectFaceEdges = (faceIndices) => {
        for (let i = 0; i < faceIndices.length; i++) {
          const current = faceIndices[i];
          const next = faceIndices[(i + 1) % faceIndices.length];
          addEdge(current, next);
        }
      };

      const addFaceIndex = (localIndex, face) => {
        if (localIndex == null || Number.isNaN(localIndex)) {
          return;
        }
        if (localIndex < 0 || localIndex >= sourceMeta.count) {
          return;
        }
        face.push(sourceMeta.offset + localIndex);
      };

      if (!faceCounts) {
        const faceSize = node.tagName.toLowerCase() === 'triangles' ? 3 : 3;
        let cursor = 0;
        let currentFace = [];
        while (cursor + vertexOffset < indices.length && segments.length < MAX_SEGMENTS) {
          const vertexIndex = indices[cursor + vertexOffset];
          addFaceIndex(vertexIndex, currentFace);
          cursor += strideWidth;
          if (currentFace.length === faceSize) {
            collectFaceEdges(currentFace);
            addFaceTriangles(currentFace);
            currentFace = [];
          }
        }
      } else {
        let cursor = 0;
        for (let i = 0; i < faceCounts.length && segments.length < MAX_SEGMENTS; i++) {
          const count = faceCounts[i];
          const face = [];
          for (let v = 0; v < count; v++) {
            if (cursor + vertexOffset >= indices.length) {
              break;
            }
            const vertexIndex = indices[cursor + vertexOffset];
            addFaceIndex(vertexIndex, face);
            cursor += strideWidth;
          }
          if (face.length >= 2) {
            collectFaceEdges(face);
            addFaceTriangles(face);
          }
        }
      }
    };

    doc.querySelectorAll('triangles').forEach((node) => processPrimitive(node));
    doc.querySelectorAll('polylist').forEach((node) => {
      const vcountText = node.querySelector('vcount')?.textContent;
      if (!vcountText) return;
      const counts = vcountText
        .trim()
        .split(/\s+/)
        .map((value) => parseInt(value, 10))
        .filter((value) => !Number.isNaN(value) && value >= 2);
      processPrimitive(node, counts);
    });

    const bounds = computeBounds(vertices);
    return {
      sourceUrl,
      vertices,
      segments,
      faces,
      bounds,
      vertexCount: vertices.length,
      segmentCount: segments.length,
      faceCount: faces.length
    };
  }

  function inferFormat(payload) {
    if (payload.format) {
      return String(payload.format).toLowerCase();
    }
    try {
      const url = new URL(payload.url, window.location.href);
      const match = url.pathname.match(/\.([^.]+)$/);
      if (match) {
        return match[1].toLowerCase();
      }
    } catch (_err) {
      // ignore
    }
    return 'obj';
  }

  function computeBounds(vertices) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };

    vertices.forEach((vertex) => {
      if (vertex.x < min.x) min.x = vertex.x;
      if (vertex.y < min.y) min.y = vertex.y;
      if (vertex.z < min.z) min.z = vertex.z;
      if (vertex.x > max.x) max.x = vertex.x;
      if (vertex.y > max.y) max.y = vertex.y;
      if (vertex.z > max.z) max.z = vertex.z;
    });

    const center = {
      x: (min.x + max.x) * 0.5,
      y: (min.y + max.y) * 0.5,
      z: (min.z + max.z) * 0.5
    };
    const size = {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z
    };

    return { min, max, center, size };
  }

  function frameCameraOnMesh() {
    if (!state.meshBounds) {
      return;
    }
    const { center, size } = state.meshBounds;
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const distance = maxDim * 1.8;
    const direction = vec3.normalize({ x: 0.7, y: -0.55, z: 0.5 });
    state.cameraPose.target = center;
    state.cameraPose.eye = vec3.add(center, vec3.scale(direction, distance));
  }

  function applyCameraFromSketchUp(payload = {}) {
    if (!payload.eye || !payload.target) {
      return;
    }

    log('Camera update from SketchUp', 'info', payload);
    state.suppressCameraBroadcast = true;
    state.lastCameraFromSketchUp = Date.now();

    state.cameraPose.eye = subtractOffset(payload.eye);
    state.cameraPose.target = subtractOffset(payload.target);
    state.cameraPose.up = vec3.normalize(payload.up || { x: 0, y: 0, z: 1 });
    state.cameraPose.fov = payload.fov || state.cameraPose.fov;
    state.cameraPose.aspect =
      dom.canvas && dom.canvas.height
        ? dom.canvas.width / dom.canvas.height
        : payload.aspect || state.cameraPose.aspect;

    updateCameraStatus('Following SketchUp');
    window.setTimeout(() => {
      state.suppressCameraBroadcast = false;
    }, 150);
  }

  function requestCameraSync() {
    callSketchUp('requestCameraOnce');
  }

  function requestMeshReload() {
    updateMeshStatus('Reloading mesh…', true);
    callSketchUp('requestMeshReload');
  }

  function clearLog() {
    if (dom.logPanel) {
      dom.logPanel.innerHTML = '';
    }
  }

  function attachUiHandlers() {
    dom.resetButton?.addEventListener('click', () => {
      state.cameraPose.eye = { x: 3, y: 3, z: 3 };
      state.cameraPose.target = { x: 0, y: 0, z: 0 };
      state.cameraPose.up = { x: 0, y: 0, z: 1 };
      scheduleCameraBroadcast();
      log('Reset view to default');
    });
    dom.reloadButton?.addEventListener('click', () => {
      log('User requested mesh reload');
      requestMeshReload();
    });
    dom.clearLogButton?.addEventListener('click', clearLog);
  }

  function setupBridge() {
    window.PobimSketchBridge = {
      fromSketchUp(type, payload) {
        let parsed = payload;
        if (typeof payload === 'string' && payload.length) {
          try {
            parsed = JSON.parse(payload);
          } catch (err) {
            log(`Failed to parse payload for ${type}`, 'warn', err.message);
          }
        }

        switch (type) {
          case 'init':
            handleBridgeInit(parsed || {});
            break;
          case 'mesh-ready':
            Promise.resolve(handleMeshReady(parsed || {})).catch((err) => {
              log('Unhandled mesh-ready error', 'error', err);
            });
            break;
          case 'gaussian-ready':
            handleGaussianReady(parsed || {});
            break;
          case 'camera':
            applyCameraFromSketchUp(parsed || {});
            break;
          default:
            log(`Unknown event type: ${type}`, 'warn');
            break;
        }
      }
    };

    const pending = Array.isArray(window.__pobimPendingEvents) ? window.__pobimPendingEvents.splice(0) : [];
    pending.forEach(({ type, payload }) => {
      try {
        window.PobimSketchBridge.fromSketchUp(type, payload);
      } catch (err) {
        log(`Failed to process pending event: ${type}`, 'error', err);
      }
    });
  }

  function bootstrap() {
    initDom();
    ensureViewer();
    attachUiHandlers();
    setupBridge();
    log('Viewer initialized. Waiting for SketchUp…');
    callSketchUp('bridgeReady', JSON.stringify({ version: 3 }), { retry: true });
    requestCameraSync();
  }

  window.addEventListener('error', (event) => {
    log(`Runtime error: ${event.message}`, 'error');
  });

  window.addEventListener('unhandledrejection', (event) => {
    log(`Unhandled rejection: ${event.reason}`, 'error');
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
