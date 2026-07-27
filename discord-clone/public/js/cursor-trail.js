// Cursor trail with selectable styles: comet, sparkle
(() => {
  const STORAGE_ENABLED_KEY = 'cursorTrailEnabled';
  const STORAGE_STYLE_KEY = 'cursorTrailStyle';

  const canvas = document.createElement('canvas');
  canvas.id = 'cursor-trail-canvas';
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '9999';
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  let particles = [];
  let points = []; // comet only
  let last = null;

  let enabled = localStorage.getItem(STORAGE_ENABLED_KEY) !== 'false';
  let style = localStorage.getItem(STORAGE_STYLE_KEY) || 'comet';
  if (style !== 'comet' && style !== 'sparkle') style = 'comet'; // guard against stale saved values

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function interpolate(from, to, spacing) {
    const pts = [];
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.min(Math.floor(dist / spacing), 20);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pts.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    return pts;
  }

  function onMouseMove(e) {
    if (!enabled) return;
    const point = { x: e.clientX, y: e.clientY };

    if (style === 'comet') {
      points.push({ ...point, alpha: 1 });
      if (points.length > 50) points.shift();
      last = point;
      return;
    }

    // sparkle
    const newPoints = last ? interpolate(last, point, 6) : [point];
    newPoints.forEach((p) => {
      particles.push({
        x: p.x, y: p.y, alpha: 1,
        size: Math.random() * 3 + 3,
        rotation: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.3,
      });
    });
    last = point;
  }
  window.addEventListener('mousemove', onMouseMove);

  function drawSparkle(p) {
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rotation);
    ctx.beginPath();
    const spikes = 4;
    const outer = p.size * 2;
    const inner = p.size * 0.6;
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const angle = (Math.PI / spikes) * i;
      ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(255, 240, 150, ${p.alpha})`;
    ctx.shadowColor = 'rgba(255, 240, 150, 0.9)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.restore();
  }

  function drawComet() {
    if (points.length < 2) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (let i = 1; i < points.length - 1; i++) {
      const p0 = points[i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const t = i / points.length; // thin near the tail, thick near the head

      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
      ctx.strokeStyle = `rgba(255, 255, 255, ${t * p1.alpha})`;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
      ctx.shadowBlur = 10;
      ctx.lineWidth = 1 + t * 6;
      ctx.stroke();
    }

    // Bright white "head" at the cursor for a shooting-star look
    const head = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(head.x, head.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${head.alpha})`;
    ctx.shadowColor = 'rgba(255, 255, 255, 1)';
    ctx.shadowBlur = 12;
    ctx.fill();
  }

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (style === 'comet') {
      points.forEach((p) => { p.alpha -= 0.025; });
      points = points.filter((p) => p.alpha > 0);
      drawComet();
    } else {
      particles.forEach((p) => {
        p.rotation += p.spin;
        drawSparkle(p);
        p.alpha -= 0.045;
        p.size *= 0.97;
      });
      particles = particles.filter((p) => p.alpha > 0);
    }

    requestAnimationFrame(animate);
  }
  animate();

  function clearTrail() {
    particles = [];
    points = [];
    last = null;
  }

  function initControls() {
    const toggle = document.getElementById('edit-profile-cursor-trail-toggle');
    const styleSelect = document.getElementById('edit-profile-cursor-trail-style');

    if (toggle) {
      toggle.checked = enabled;
      toggle.addEventListener('change', () => {
        enabled = toggle.checked;
        localStorage.setItem(STORAGE_ENABLED_KEY, enabled ? 'true' : 'false');
        if (!enabled) clearTrail();
      });
    }

    if (styleSelect) {
      styleSelect.value = style;
      styleSelect.addEventListener('change', () => {
        style = styleSelect.value;
        localStorage.setItem(STORAGE_STYLE_KEY, style);
        clearTrail();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initControls);
  } else {
    initControls();
  }
})();