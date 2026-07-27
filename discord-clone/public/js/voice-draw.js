// Freehand whiteboard overlaid on the voice panel. Strokes are stored as
// fractional (0..1) coordinates relative to the overlay so they stay correct
// across resizes (panel drag, window resize, streaming toggling the layout).
// Fully synced over the socket to everyone else in the same voice channel -
// new joiners get the current board via 'voice:draw-state', same pattern as
// 'voice:existing-peers' in voice.js.
const VoiceDraw = (() => {
  const COLORS = ['#ffffff', '#ed4245', '#f0b232', '#3ba55d', '#5865f2', '#eb459e'];
  const SIZES = [3, 6, 12];

  let socket = null;
  let channelId = null;
  let isOpen = false;

  let layer = null, canvas = null, ctx = null;
  let strokes = new Map(); // strokeId -> { color, size, points: [{x,y}] }

  let color = COLORS[0];
  let size = SIZES[1];

  let drawing = false;
  let activeStrokeId = null;
  let pendingPoints = []; // batched points waiting to be emitted
  let flushRaf = null;

  function $(sel) { return document.querySelector(sel); }

  function init(_socket) {
    socket = _socket;

    socket.on('voice:draw-state', ({ strokes: list }) => {
      strokes = new Map((list || []).map((s) => [s.id, s]));
      redrawAll();
    });

    socket.on('voice:draw-point', ({ strokeId, color: c, size: sz, points }) => {
      let s = strokes.get(strokeId);
      if (!s) {
        s = { color: c, size: sz, points: [] };
        strokes.set(strokeId, s);
      }
      s.points.push(...points);
      drawStroke(s);
    });

    socket.on('voice:draw-clear', () => {
      strokes.clear();
      clearCanvas();
    });
  }

  // Called by VoiceChat on join/leave so this module knows which room to
  // scope its socket traffic to, and so the board resets on channel switch.
  function setActiveChannel(cid) {
    channelId = cid;
    strokes.clear();
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
    isOpen = true;
    updateToggleButton();
    resizeCanvas();
    redrawAll();
  }

  function closeOverlay() {
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
    layer.appendChild(buildToolbar());
    host.appendChild(layer);

    ctx = canvas.getContext('2d');
    wireCanvasEvents();

    new ResizeObserver(() => { resizeCanvas(); redrawAll(); }).observe(layer);
  }

  function buildToolbar() {
    const bar = document.createElement('div');
    bar.className = 'voice-draw-toolbar';

    const swatches = document.createElement('div');
    swatches.className = 'voice-draw-swatches';
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
      });
      swatches.appendChild(sw);
    });
    bar.appendChild(swatches);

    const sizes = document.createElement('div');
    sizes.className = 'voice-draw-sizes';
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

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'voice-draw-clear-btn';
    clearBtn.textContent = 'Clear';
    clearBtn.title = 'Clear board for everyone';
    clearBtn.addEventListener('click', () => {
      strokes.clear();
      clearCanvas();
      if (channelId) socket.emit('voice:draw-clear', { channelId });
    });
    bar.appendChild(clearBtn);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'voice-draw-close-btn';
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close drawing (keeps the board for others)';
    closeBtn.addEventListener('click', closeOverlay);
    bar.appendChild(closeBtn);

    return bar;
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

  function redrawAll() {
    if (!ctx) return;
    clearCanvas();
    strokes.forEach(drawStroke);
  }

  // Draws only the last two points of a stroke incrementally (cheap, called
  // on every incoming/local point) - redrawAll() is only used for full
  // repaints (resize, initial state load, clear).
  function drawStroke(stroke) {
    if (!ctx || !canvas || stroke.points.length < 2) return;
    const rect = layer.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    const pts = stroke.points;
    const from = pts[pts.length - 2];
    const to = pts[pts.length - 1];
    ctx.moveTo(from.x * w, from.y * h);
    ctx.lineTo(to.x * w, to.y * h);
    ctx.stroke();
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
      drawing = true;
      activeStrokeId = `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const p = pointToFraction(e);
      strokes.set(activeStrokeId, { color, size, points: [p] });
      pendingPoints = [p];
      canvas.setPointerCapture(e.pointerId);
      scheduleFlush();
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const p = pointToFraction(e);
      const s = strokes.get(activeStrokeId);
      s.points.push(p);
      drawStroke(s);
      pendingPoints.push(p);
      scheduleFlush();
    });

    const end = () => {
      if (!drawing) return;
      drawing = false;
      flushPending();
      activeStrokeId = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { if (drawing) end(); });
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
      channelId, strokeId: activeStrokeId, color, size, points: pendingPoints
    });
    pendingPoints = [];
  }

  return { init, setActiveChannel, toggle };
})();