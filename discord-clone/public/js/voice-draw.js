// Freehand whiteboard overlaid on the voice panel. Strokes are stored as
// fractional (0..1) coordinates relative to the overlay so they stay correct
// across resizes (panel drag, window resize, streaming toggling the layout).
// Fully synced over the socket to everyone else in the same voice channel -
// new joiners get the current board via 'voice:draw-state', same pattern as
// 'voice:existing-peers' in voice.js.
//
// Tools: pen, eraser (true pixel erase via destination-out compositing),
// line / rect / ellipse (drag-to-preview shapes), and text (click to place
// a label). Every committed mark is a "stroke" with a `tool` field so
// remote clients render it identically; shapes/text are sent as one
// complete stroke on release, pen/eraser stream points as you draw.
const VoiceDraw = (() => {
  const COLORS = ['#ffffff', '#ed4245', '#f0b232', '#3ba55d', '#5865f2', '#eb459e'];
  const SIZES = [2, 5, 10, 18];
  const TOOLS = [
    { id: 'pen', label: 'Pen', icon: '✏️' },
    { id: 'eraser', label: 'Eraser', icon: '🧽' },
    { id: 'line', label: 'Line', icon: '╱' },
    { id: 'rect', label: 'Rectangle', icon: '▭' },
    { id: 'ellipse', label: 'Ellipse', icon: '◯' },
    { id: 'text', label: 'Text', icon: 'T' }
  ];

  let socket = null;
  let channelId = null;
  let isOpen = false;

  let layer = null, canvas = null, ctx = null;
  let strokes = new Map(); // strokeId -> { tool, color, size, points: [{x,y}], text? }

  let tool = 'pen';
  let color = COLORS[0];
  let size = SIZES[1];

  let drawing = false;
  let activeStrokeId = null;
  let pendingPoints = []; // batched points waiting to be emitted (pen/eraser only)
  let flushRaf = null;

  let shapeStart = null;   // {x,y} fraction, set on pointerdown for line/rect/ellipse
  let previewRaf = null;
  let lastPointerEvent = null;

  let ownStrokeStack = []; // strokeIds created by this client this session, for undo
  let textInput = null;    // active inline text-entry element, if any

  function $(sel) { return document.querySelector(sel); }
  function uid() { return `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

  function init(_socket) {
    socket = _socket;

    socket.on('voice:draw-state', ({ strokes: list }) => {
      strokes = new Map((list || []).map((s) => [s.id, s]));
      redrawAll();
    });

    socket.on('voice:draw-point', ({ strokeId, tool: t, color: c, size: sz, text, points }) => {
      let s = strokes.get(strokeId);
      if (!s) {
        s = { tool: t || 'pen', color: c, size: sz, text, points: [] };
        strokes.set(strokeId, s);
      }
      s.points.push(...points);
      drawStrokeIncremental(s);
    });

    socket.on('voice:draw-undo', ({ strokeId }) => {
      if (strokes.delete(strokeId)) redrawAll();
    });

    socket.on('voice:draw-clear', () => {
      strokes.clear();
      ownStrokeStack = [];
      clearCanvas();
    });
  }

  // Called by VoiceChat on join/leave so this module knows which room to
  // scope its socket traffic to, and so the board resets on channel switch.
  function setActiveChannel(cid) {
    channelId = cid;
    strokes.clear();
    ownStrokeStack = [];
    if (!cid) closeOverlay();
    else if (layer) clearCanvas();
  }

  function toggle() {
    if (!channelId) return;
    isOpen ? closeOverlay() : openOverlay();
  }

  function openOverlay() {
    if (!channelId) return;
    mount();
    layer.classList.remove('hidden');
    layer.classList.remove('closing');
    isOpen = true;
    updateToggleButton();
    resizeCanvas();
    redrawAll();
  }

  function closeOverlay() {
    cancelTextInput();
    if (layer) layer.classList.add('hidden');
    isOpen = false;
    updateToggleButton();
  }

  function updateToggleButton() {
    const btn = $('#voice-draw-btn');
    if (btn) btn.classList.toggle('active-danger', isOpen);
  }

  // ============ MOUNTING ============

  function mount() {
    if (layer) return;
    const host = $('#voice-panel-scroll');
    if (!host) return;

    layer = document.createElement('div');
    layer.id = 'voice-draw-layer';
    layer.className = 'voice-draw-layer hidden';

    canvas = document.createElement('canvas');
    canvas.className = 'voice-draw-canvas';
    layer.appendChild(canvas);

    const eraserCursor = document.createElement('div');
    eraserCursor.className = 'voice-draw-eraser-cursor hidden';
    layer.appendChild(eraserCursor);

    layer.appendChild(buildToolbar());
    host.appendChild(layer);

    ctx = canvas.getContext('2d');
    wireCanvasEvents();

    new ResizeObserver(() => { resizeCanvas(); redrawAll(); }).observe(layer);
  }

  function toolButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-draw-tool-btn';
    btn.dataset.tool = t.id;
    btn.title = t.label;
    btn.textContent = t.icon;
    if (t.id === tool) btn.classList.add('selected');
    btn.addEventListener('click', () => setTool(t.id, btn));
    return btn;
  }

  function setTool(id, btnEl) {
    cancelTextInput();
    tool = id;
    layer.querySelectorAll('.voice-draw-tool-btn').forEach((el) => el.classList.remove('selected'));
    (btnEl || layer.querySelector(`.voice-draw-tool-btn[data-tool="${id}"]`))?.classList.add('selected');
    canvas.classList.toggle('tool-eraser', id === 'eraser');
    canvas.classList.toggle('tool-text', id === 'text');
    canvas.classList.toggle('tool-shape', id === 'line' || id === 'rect' || id === 'ellipse');
    layer.querySelector('.voice-draw-eraser-cursor')?.classList.toggle('hidden', id !== 'eraser');
  }

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'voice-draw-toolbar';

    const tools = document.createElement('div');
    tools.className = 'voice-draw-group voice-draw-tools';
    TOOLS.forEach((t) => tools.appendChild(toolButton(t)));
    bar.appendChild(tools);
    bar.appendChild(divider());

    const swatches = document.createElement('div');
    swatches.className = 'voice-draw-group voice-draw-swatches';
    COLORS.forEach((c) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'voice-draw-swatch';
      sw.style.background = c;
      if (c === color) sw.classList.add('selected');
      sw.title = 'Pick color';
      sw.addEventListener('click', () => {
        color = c;
        swatches.querySelectorAll('.voice-draw-swatch').forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
        customColorInput.value = c;
      });
      swatches.appendChild(sw);
    });

    // Custom color picker, shown as one more swatch with a rainbow ring
    const customWrap = document.createElement('label');
    customWrap.className = 'voice-draw-swatch voice-draw-swatch-custom';
    customWrap.title = 'Custom color';
    const customColorInput = document.createElement('input');
    customColorInput.type = 'color';
    customColorInput.value = color;
    customColorInput.addEventListener('input', () => {
      color = customColorInput.value;
      swatches.querySelectorAll('.voice-draw-swatch').forEach((el) => el.classList.remove('selected'));
      customWrap.classList.add('selected');
    });
    customWrap.appendChild(customColorInput);
    swatches.appendChild(customWrap);
    bar.appendChild(swatches);
    bar.appendChild(divider());

    const sizes = document.createElement('div');
    sizes.className = 'voice-draw-group voice-draw-sizes';
    SIZES.forEach((sz) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'voice-draw-size-btn';
      if (sz === size) btn.classList.add('selected');
      const dot = document.createElement('span');
      dot.style.width = `${sz + 4}px`;
      dot.style.height = `${sz + 4}px`;
      btn.appendChild(dot);
      btn.title = 'Brush size';
      btn.addEventListener('click', () => {
        size = sz;
        sizes.querySelectorAll('.voice-draw-size-btn').forEach((el) => el.classList.remove('selected'));
        btn.classList.add('selected');
      });
      sizes.appendChild(btn);
    });
    bar.appendChild(sizes);
    bar.appendChild(divider());

    const actions = document.createElement('div');
    actions.className = 'voice-draw-group voice-draw-actions';

    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'voice-draw-icon-btn';
    undoBtn.textContent = '↶';
    undoBtn.title = 'Undo your last mark';
    undoBtn.addEventListener('click', undo);
    actions.appendChild(undoBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'voice-draw-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear board for everyone';
    clearBtn.addEventListener('click', () => {
      strokes.clear();
      ownStrokeStack = [];
      clearCanvas();
      if (channelId) socket.emit('voice:draw-clear', { channelId });
    });
    actions.appendChild(clearBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'voice-draw-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close drawing (keeps the board for others)';
    closeBtn.addEventListener('click', closeOverlay);
    actions.appendChild(closeBtn);

    bar.appendChild(actions);
    return bar;
  }

  function divider() {
    const d = document.createElement('div');
    d.className = 'voice-draw-divider';
    return d;
  }

  // ============ CANVAS SIZING / RENDERING ============

  function resizeCanvas() {
    if (!canvas || !layer) return;
    const rect = layer.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clearCanvas() {
    if (!ctx || !canvas) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // Full repaint - used on resize, initial load, undo, and remote clear.
  // Iterates strokes in insertion order so eraser marks correctly punch
  // through only what was drawn before them.
  function redrawAll() {
    if (!ctx) return;
    clearCanvas();
    strokes.forEach(drawStrokeFull);
  }

  function applyStrokeStyle(ctx, stroke) {
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // Draws a stroke's ENTIRE path in one pass. Used for full repaints, where
  // partial (last-segment-only) rendering would leave strokes looking cut off.
  function drawStrokeFull(stroke) {
    if (!ctx || !canvas || !layer) return;
    const rect = layer.getBoundingClientRect();
    const w = rect.width, h = rect.height;

    if (stroke.tool === 'text') {
      const p = stroke.points[0];
      if (!p) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = stroke.color;
      ctx.font = `600 ${(stroke.size || 5) * 2.2 + 8}px "gg sans", -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(stroke.text || '', p.x * w, p.y * h);
      ctx.restore();
      return;
    }

    if (!stroke.points || stroke.points.length < 2) return;
    ctx.save();
    applyStrokeStyle(ctx, stroke);
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * w, y = p.y * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Draws only the last two points of a stroke - cheap, called on every
  // incoming/local point while pen/eraser drawing is in progress.
  function drawStrokeIncremental(stroke) {
    if (!ctx || !canvas || !layer || stroke.tool === 'text' || stroke.points.length < 2) return;
    const rect = layer.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    ctx.save();
    applyStrokeStyle(ctx, stroke);
    ctx.beginPath();
    const pts = stroke.points;
    const from = pts[pts.length - 2];
    const to = pts[pts.length - 1];
    ctx.moveTo(from.x * w, from.y * h);
    ctx.lineTo(to.x * w, to.y * h);
    ctx.stroke();
    ctx.restore();
  }

  // ============ SHAPE MATH ============

  function shapePoints(kind, start, end) {
    if (kind === 'line') return [start, end];
    if (kind === 'rect') {
      return [
        { x: start.x, y: start.y }, { x: end.x, y: start.y },
        { x: end.x, y: end.y }, { x: start.x, y: end.y },
        { x: start.x, y: start.y }
      ];
    }
    if (kind === 'ellipse') {
      const cx = (start.x + end.x) / 2, cy = (start.y + end.y) / 2;
      const rx = Math.abs(end.x - start.x) / 2, ry = Math.abs(end.y - start.y) / 2;
      const pts = [];
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
      }
      return pts;
    }
    return [start, end];
  }

  // ============ POINTER INPUT ============

  function pointToFraction(e) {
    const rect = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    };
  }

  function wireCanvasEvents() {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;

      if (tool === 'text') { startTextInput(e); return; }

      const p = pointToFraction(e);

      if (tool === 'line' || tool === 'rect' || tool === 'ellipse') {
        shapeStart = p;
        canvas.setPointerCapture(e.pointerId);
        return;
      }

      // pen / eraser: freehand streaming
      drawing = true;
      activeStrokeId = uid();
      strokes.set(activeStrokeId, { tool, color, size, points: [p] });
      ownStrokeStack.push(activeStrokeId);
      pendingPoints = [p];
      canvas.setPointerCapture(e.pointerId);
      scheduleFlush();
    });

    canvas.addEventListener('pointermove', (e) => {
      lastPointerEvent = e;
      moveEraserCursor(e);

      if (shapeStart) { scheduleShapePreview(e); return; }

      if (!drawing) return;
      const p = pointToFraction(e);
      const s = strokes.get(activeStrokeId);
      s.points.push(p);
      drawStrokeIncremental(s);
      pendingPoints.push(p);
      scheduleFlush();
    });

    const end = (e) => {
      if (shapeStart) {
        const endPt = e ? pointToFraction(e) : shapeStart;
        commitShape(shapeStart, endPt);
        shapeStart = null;
        redrawAll();
        return;
      }
      if (!drawing) return;
      drawing = false;
      flushPending();
      activeStrokeId = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      layer.querySelector('.voice-draw-eraser-cursor')?.classList.add('hidden');
      if (drawing) end();
    });
    canvas.addEventListener('pointerenter', () => {
      if (tool === 'eraser') layer.querySelector('.voice-draw-eraser-cursor')?.classList.remove('hidden');
    });
  }

  function moveEraserCursor(e) {
    if (tool !== 'eraser') return;
    const cursor = layer.querySelector('.voice-draw-eraser-cursor');
    if (!cursor) return;
    const rect = layer.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    cursor.style.width = `${size + 6}px`;
    cursor.style.height = `${size + 6}px`;
    cursor.style.transform = `translate(${x - (size + 6) / 2}px, ${y - (size + 6) / 2}px)`;
  }

  // Throttled live preview while dragging a shape - redraws committed board
  // then overlays the in-progress shape without touching the strokes map.
  function scheduleShapePreview(e) {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(() => {
      previewRaf = null;
      if (!shapeStart) return;
      const end = pointToFraction(e);
      redrawAll();
      drawStrokeFull({ tool, color, size, points: shapePoints(tool, shapeStart, end) });
    });
  }

  function commitShape(start, end) {
    if (Math.abs(end.x - start.x) < 0.002 && Math.abs(end.y - start.y) < 0.002) return; // ignore a stray click
    const strokeId = uid();
    const points = shapePoints(tool, start, end);
    const stroke = { tool, color, size, points };
    strokes.set(strokeId, stroke);
    ownStrokeStack.push(strokeId);
    if (channelId) socket.emit('voice:draw-point', { channelId, strokeId, tool, color, size, points });
  }

  // ============ TEXT TOOL ============

  function startTextInput(e) {
    cancelTextInput();
    const p = pointToFraction(e);
    const rect = layer.getBoundingClientRect();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'voice-draw-text-input';
    input.style.left = `${p.x * rect.width}px`;
    input.style.top = `${p.y * rect.height}px`;
    input.style.color = color;
    input.style.fontSize = `${size * 2.2 + 8}px`;
    input.placeholder = 'Type, then Enter';
    layer.appendChild(input);
    textInput = input;
    setTimeout(() => input.focus(), 0);

    const commit = () => {
      const text = input.value.trim();
      cancelTextInput();
      if (!text) return;
      const strokeId = uid();
      const stroke = { tool: 'text', color, size, points: [p], text };
      strokes.set(strokeId, stroke);
      ownStrokeStack.push(strokeId);
      drawStrokeFull(stroke);
      if (channelId) socket.emit('voice:draw-point', { channelId, strokeId, tool: 'text', color, size, text, points: [p] });
    };

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commit();
      else if (ev.key === 'Escape') cancelTextInput();
    });
    input.addEventListener('blur', commit);
  }

  function cancelTextInput() {
    if (textInput) { textInput.remove(); textInput = null; }
  }

  // ============ UNDO ============

  function undo() {
    const strokeId = ownStrokeStack.pop();
    if (!strokeId) return;
    strokes.delete(strokeId);
    redrawAll();
    if (channelId) socket.emit('voice:draw-undo', { channelId, strokeId });
  }

  // Batches rapid pointermove points into one socket emit per animation
  // frame instead of one per event, same spirit as the gaze-broadcast
  // throttling in voice.js.
  function scheduleFlush() {
    if (flushRaf) return;
    flushRaf = requestAnimationFrame(() => {
      flushRaf = null;
      flushPending();
    });
  }

  function flushPending() {
    if (!pendingPoints.length || !channelId || !activeStrokeId) { pendingPoints = []; return; }
    socket.emit('voice:draw-point', {
      channelId, strokeId: activeStrokeId, tool, color, size, points: pendingPoints
    });
    pendingPoints = [];
  }

  return { init, setActiveChannel, toggle };
})();