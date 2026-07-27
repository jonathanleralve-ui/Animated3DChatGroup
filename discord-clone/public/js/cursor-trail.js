// Smooth white cursor trail, toggleable
(() => {
  const STORAGE_KEY = 'cursorTrailEnabled';
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
  let last = null;
  let enabled = localStorage.getItem(STORAGE_KEY) !== 'false'; // default true

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  function onMouseMove(e) {
    if (!enabled) return;
    const point = { x: e.clientX, y: e.clientY };

    if (last) {
      const dist = Math.hypot(point.x - last.x, point.y - last.y);
      const steps = Math.min(Math.ceil(dist / 4), 20);
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        particles.push({
          x: last.x + (point.x - last.x) * t,
          y: last.y + (point.y - last.y) * t,
          alpha: 1,
          size: 3,
        });
      }
    } else {
      particles.push({ x: point.x, y: point.y, alpha: 1, size: 3 });
    }
    last = point;
  }
  window.addEventListener('mousemove', onMouseMove);

  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${p.alpha * 0.8})`;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
      ctx.shadowBlur = 6;
      ctx.fill();
      p.alpha -= 0.045;
      p.size *= 0.97;
    });
    particles = particles.filter((p) => p.alpha > 0);
    requestAnimationFrame(animate);
  }
  animate();

  // Hook up the toggle once the edit-profile panel exists in the DOM
  function initToggle() {
    const toggle = document.getElementById('edit-profile-cursor-trail-toggle');
    if (!toggle) return;
    toggle.checked = enabled;
    toggle.addEventListener('change', () => {
      enabled = toggle.checked;
      localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
      if (!enabled) {
        particles = [];
        last = null;
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToggle);
  } else {
    initToggle();
  }
})();