// Custom cursor upload (name shown next to button, no preview box)
(() => {
  const STORAGE_KEY = 'customCursorImage';
  const STORAGE_NAME_KEY = 'customCursorFileName';

  function applyCursor(dataUrl) {
    document.body.style.cursor = dataUrl ? `url("${dataUrl}") 0 0, auto` : '';
  }

  function setFileNameLabel(labelEl, fileName) {
    labelEl.textContent = fileName || 'Default';
  }

  function init() {
    const fileInput = document.getElementById('edit-profile-cursor-file');
    const uploadBtn = document.getElementById('edit-profile-cursor-upload-btn');
    const removeBtn = document.getElementById('edit-profile-cursor-remove-btn');
    const label = document.getElementById('edit-profile-cursor-filename');
    if (!fileInput || !uploadBtn || !removeBtn || !label) return;

    const savedData = localStorage.getItem(STORAGE_KEY);
    const savedName = localStorage.getItem(STORAGE_NAME_KEY);
    if (savedData) {
      applyCursor(savedData);
      setFileNameLabel(label, savedName);
      removeBtn.classList.remove('hidden');
    }

    uploadBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        localStorage.setItem(STORAGE_KEY, dataUrl);
        localStorage.setItem(STORAGE_NAME_KEY, file.name);
        applyCursor(dataUrl);
        setFileNameLabel(label, file.name);
        removeBtn.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
      fileInput.value = '';
    });

    removeBtn.addEventListener('click', () => {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_NAME_KEY);
      applyCursor(null);
      setFileNameLabel(label, null);
      removeBtn.classList.add('hidden');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();