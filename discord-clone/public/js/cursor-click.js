// Shows a small random image next to the cursor on every click.
// Uses the user's custom uploads (from the Cursor tab) if any exist,
// otherwise falls back to the default images in /clicks.
(() => {
  const DEFAULT_IMAGES = [
    '/clicks/click1.png',
    '/clicks/click2.png',
    '/clicks/click3.png',
    '/clicks/click4.png',
    '/clicks/click5.png',
  ];
  const STORAGE_KEY = 'customClickImages';
  const SIZE = 32; // px
  const OFFSET_X = 14;
  const OFFSET_Y = -14;
  const LIFETIME_MS = 700;

  function getImages() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) && arr.length > 0 ? arr : DEFAULT_IMAGES;
    } catch {
      return DEFAULT_IMAGES;
    }
  }

  // Inject the fade/float animation once
  const style = document.createElement('style');
  style.textContent = `
    @keyframes cursorClickPop {
      0%   { opacity: 1; transform: translate(0, 0) scale(1); }
      100% { opacity: 0; transform: translate(0, -24px) scale(0.85); }
    }
    .cursor-click-pop {
      position: fixed;
      width: ${SIZE}px;
      height: ${SIZE}px;
      pointer-events: none;
      z-index: 10000;
      animation: cursorClickPop ${LIFETIME_MS}ms ease-out forwards;
    }
  `;
  document.head.appendChild(style);

  function spawnClickImage(x, y) {
    const images = getImages();
    const src = images[Math.floor(Math.random() * images.length)];
    const img = document.createElement('img');
    img.src = src;
    img.className = 'cursor-click-pop';
    img.style.left = `${x + OFFSET_X}px`;
    img.style.top = `${y + OFFSET_Y}px`;
    document.body.appendChild(img);
    setTimeout(() => img.remove(), LIFETIME_MS);
  }

  window.addEventListener('click', (e) => {
    spawnClickImage(e.clientX, e.clientY);
  });
})();