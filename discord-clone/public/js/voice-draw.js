// Always-on freehand whiteboard layered over the voice panel. Unlike a
// classic "open the whiteboard" overlay, this is mounted for the whole
// duration a user is in a voice channel and stays pointer-transparent by
// default, so the panel underneath (mute button, avatars, tiles) keeps
// working normally. Picking any drawing tool from the small floating
// toolbar "arms" the canvas to capture the mouse; picking the Select tool
// (the default) disarms it again. Strokes themselves are always rendered
// for everyone in the channel, whether or not that person currently has a
// drawing tool armed - only the ability to draw is gated, never the
// ability to see.
//
// Strokes are stored as fractional (0..1) coordinates relative to the
// overlay so they stay correct across resizes (panel drag, window resize,
// streaming toggling the layout). Synced over the socket to everyone else
// in the same voice channel - new joiners get the current board via
// 'voice:draw-state', same pattern as 'voice:existing-peers' in voice.js.
const VoiceDraw = (() => {
  const COLORS = ['#ffffff', '#ed4245', '#f0b232', '#3ba55d', '#5865f2', '#eb459e'];
  const SIZES = [2, 5, 10, 18];
  const TOOLS = [
    { id: 'select', label: 'Select (click through to the call)', icon: '↖' },
    { id: 'pen', label: 'Pen', icon: '✏️' },
    { id: 'eraser', label: 'Eraser', icon: '🧽' },
    { id: 'line', label: 'Line', icon: '╱' },
    { id: 'rect', label: 'Rectangle', icon: '▭' },
    { id: 'ellipse', label: 'Ellipse', icon: '◯' },
    { id: 'text', label: 'Text', icon: 'T' }
  ];

  let socket = null;
  let channelId = null;

  let layer = null, canvas = null, ctx = null;
  let strokes = new Map(); // strokeId -> { tool, color, size, points: [{x,y}], text? }

  let tool = 'select';
  let color = COLORS[0];
  let size = SIZES[1];
  let toolbarOpen = false;

  let drawing = false;
  let activeStrokeId = null;
  let pendingPoints = []; // batched points waiting to be emitted (pen/eraser only)
  let flushRaf = null;

  let shapeStart = null;   // {x,y} fraction, set on pointerdown for line/rect/ellipse
  let previewRaf = null;

  let ownStrokeStack = []; // strokeIds created by this client this session, for undo
  let textInput = null;    // active inline text-entry element, if any
  let resizeObserver = null;

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

  // Called by VoiceChat on join/leave. The board is mounted (and strokes
  // rendered) for the entire time a channel is active - there is no
  // separate open/close step. Leaving the channel tears everything down.
  function setActiveChannel(cid) {
    const changingChannel = channelId !== cid;
    channelId = cid;
    if (!cid) {
      teardown();
      return;
    }
    strokes.clear();
    ownStrokeStack = [];
    if (changingChannel) { setTool('select'); setToolbarOpen(false); }
    mount();
  }

  // ============ MOUNTING ============

  function mount() {
    if (layer) return;
    // Mounted on the whole panel (not just the scrollable participants/video
    // area) so the top controls bar - Leave Call, Mute, Draw toggle, etc. -
    // is drawable too. It's still safe: the layer stays pointer-events:none
    // by default so those buttons work normally, and the resize handle has
    // a higher z-index so it's always draggable even with a tool armed.
    const host = $('#voice-panel');
    if (!host) return;

    layer = document.createElement('div');
    layer.id = 'voice-draw-layer';
    layer.className = 'voice-draw-layer';

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
    applyToolState();
    applyToolbarVisibility();

    resizeObserver = new ResizeObserver(() => { resizeCanvas(); redrawAll(); });
    resizeObserver.observe(layer);
    resizeCanvas();
  }

  function teardown() {
    cancelTextInput();
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    if (layer) { layer.remove(); layer = null; }
    canvas = null; ctx = null;
    drawing = false; activeStrokeId = null; shapeStart = null;
    strokes.clear();
    ownStrokeStack = [];
  }

  function applyToolbarVisibility() {
    if (!layer) return;
    layer.querySelector('.voice-draw-toolbar')?.classList.toggle('hidden', !toolbarOpen);
    const btn = $('#voice-draw-btn');
    if (btn) btn.classList.toggle('active-danger', toolbarOpen);
    // Closing the toolbar also disarms drawing - can't leave the canvas
    // capturing clicks with no way to see which tool is active.
    if (!toolbarOpen && tool !== 'select') setTool('select');
  }

  function setToolbarOpen(open) {
    toolbarOpen = open;
    applyToolbarVisibility();
  }

  function toggleToolbar() {
    if (!channelId) return;
    setToolbarOpen(!toolbarOpen);
  }

  function toolButton(t) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-draw-tool-btn';
    btn.dataset.tool = t.id;
    btn.title = t.label;
    btn.textContent = t.icon;
    if (t.id === tool) btn.classList.add('selected');
    btn.addEventListener('click', () => setTool(t.id));
    return btn;
  }

  // Arms/disarms canvas pointer capture. 'select' lets clicks fall through
  // to the voice panel underneath (mute button, tiles, avatars); any other
  // tool captures the pointer so you can draw.
  function setTool(id) {
    cancelTextInput();
    tool = id;
    if (layer) {
      layer.querySelectorAll('.voice-draw-tool-btn').forEach((el) => {
        el.classList.toggle('selected', el.dataset.tool === id);
      });
      applyToolState();
    }
  }

  function applyToolState() {
    if (!canvas || !layer) return;
    const armed = tool !== 'select';
    canvas.style.pointerEvents = armed ? 'auto' : 'none';
    canvas.classList.toggle('tool-eraser', tool === 'eraser');
    canvas.classList.toggle('tool-text', tool === 'text');
    canvas.classList.toggle('tool-shape', tool === 'line' || tool === 'rect' || tool === 'ellipse');
    layer.querySelector('.voice-draw-eraser-cursor')?.classList.toggle('hidden', tool !== 'eraser');
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
  //
  // Points are stored as fractions of the layer's WIDTH for both x and y
  // (not width/height independently). That means a single scale factor -
  // dragging the resize handle to make the panel taller changes rect.height
  // but not rect.width, so existing strokes keep their exact size and
  // position and the extra room just appears as blank canvas below them,
  // instead of the whole drawing stretching to fill the new height.
  function drawStrokeFull(stroke) {
    if (!ctx || !canvas || !layer) return;
    const rect = layer.getBoundingClientRect();
    const u = rect.width;

    if (stroke.tool === 'text') {
      const p = stroke.points[0];
      if (!p) return;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = stroke.color;
      ctx.font = `600 ${(stroke.size || 5) * 2.2 + 8}px "gg sans", -apple-system, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(stroke.text || '', p.x * u, p.y * u);
      ctx.restore();
      return;
    }

    if (!stroke.points || stroke.points.length < 2) return;
    ctx.save();
    applyStrokeStyle(ctx, stroke);
    ctx.beginPath();
    stroke.points.forEach((p, i) => {
      const x = p.x * u, y = p.y * u;
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
    const u = rect.width;
    ctx.save();
    applyStrokeStyle(ctx, stroke);
    ctx.beginPath();
    const pts = stroke.points;
    const from = pts[pts.length - 2];
    const to = pts[pts.length - 1];
    ctx.moveTo(from.x * u, from.y * u);
    ctx.lineTo(to.x * u, to.y * u);
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

  // x and y are both expressed as fractions of the layer's WIDTH (see the
  // rendering functions above for why) - so x is bounded to the visible
  // [0,1] range, but y only has a floor at 0. If the panel is shorter than
  // it is wide, a point below the current bottom edge is still a valid,
  // stable coordinate - it just isn't visible until the panel grows.
  function pointToFraction(e) {
    const rect = layer.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, (e.clientY - rect.top) / rect.width)
    };
  }

  function wireCanvasEvents() {
    canvas.addEventListener('pointerdown', (e) => {
      if (tool === 'select') return; // shouldn't fire, pointer-events is none, but stay safe
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
    input.style.top = `${p.y * rect.width}px`;
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

  return { init, setActiveChannel, toggleToolbar };
})();