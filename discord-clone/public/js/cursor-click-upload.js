// Lets the user upload up to 5 custom click images, stored in localStorage
(() => {
  const STORAGE_KEY = 'customClickImages'; // JSON array of data URLs, max 5
  const MAX_IMAGES = 5;

  function loadImages() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.slice(0, MAX_IMAGES) : [];
    } catch {
      return [];
    }
  }

  function saveImages(images) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(images.slice(0, MAX_IMAGES)));
  }

  function render(grid, images) {
    grid.innerHTML = '';
    for (let i = 0; i < MAX_IMAGES; i++) {
      const slot = document.createElement('div');
      slot.className = 'click-image-slot';
      const dataUrl = images[i];

      if (dataUrl) {
        slot.classList.add('filled');

        const img = document.createElement('img');
        img.src = dataUrl;
        slot.appendChild(img);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'click-image-slot-remove';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const current = loadImages();
          current.splice(i, 1);
          saveImages(current);
          render(grid, loadImages());
        });
        slot.appendChild(removeBtn);
      } else {
        slot.textContent = '+';
        slot.addEventListener('click', () => fileInputRef.click());
      }
      grid.appendChild(slot);
    }
  }

  let fileInputRef;

  function init() {
    const grid = document.getElementById('edit-profile-click-image-grid');
    const fileInput = document.getElementById('edit-profile-click-image-file');
    const resetBtn = document.getElementById('edit-profile-click-image-reset-btn');
    if (!grid || !fileInput || !resetBtn) return;
    fileInputRef = fileInput;

    render(grid, loadImages());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (!file) return;

      const current = loadImages();
      if (current.length >= MAX_IMAGES) return;

      const reader = new FileReader();
      reader.onload = () => {
        current.push(reader.result);
        saveImages(current);
        render(grid, loadImages());
      };
      reader.readAsDataURL(file);
    });

    resetBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      render(grid, []);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();