// Simple profile edit modal: lets the user change their display name and
// avatar color, similar to Discord's "My Account" panel but pared down to
// the two fields the app actually has.
const Profile = (() => {
  const { $, $$, initials } = Utils;

  // avatar color selection removed
  let selectedAvatarUrl = null;
  let pendingAvatarFile = null;
  let selectedNameColor = null;

  // 3D voice avatar: a zipped MMD model package (.pmx + textures) the user
  // can upload to appear as a 3D lip-synced model in voice channels instead
  // of their flat photo. avatarMode toggles which one is actually used.
  //
  // The model is uploaded to the server as soon as it's picked (rather than
  // deferred until Save) because MMDLoader needs a real URL to resolve the
  // model's texture files against — there's no reliable way to preview
  // straight out of the local .zip before it's been extracted server-side.
  let selectedModelUrl = null;
  let avatarMode = 'flat';
  let modelPreviewInstance = null;
  // Framing (zoom/pan) for the 3D model, set by dragging/scrolling on the
  // preview or the zoom slider below it, and saved to the profile so it's
  // reused everywhere the model renders (voice tiles, other people's screens).
  let selectedModelZoom = 1;
  let selectedModelOffsetX = 0;
  let selectedModelOffsetY = 0;
  let selectedModelRotationY = 0;
  // Lip-sync tuning: how far the mouth shape key opens at most (0-1), and
  // the input-volume window (0-100, same RMS-ish scale voice.js's speaking
  // meter uses) it ramps open across. Defaults match avatar3d.js's CONFIG.
  let selectedMouthIntensity = 0.5;
  let selectedVoiceStart = 5;
  let selectedVoiceMax = 59;
  // Blink tuning: how closed the eye shape key gets at the peak of a blink
  // (0-1), the random min/max seconds between blinks, and whether blinking
  // is on at all. Defaults match avatar3d.js's CONFIG.
  let selectedBlinkIntensity = 1;
  let selectedBlinkIntervalMin = 2;
  let selectedBlinkIntervalMax = 4;
  let selectedBlinkEnabled = true;
  // Head/eye gaze tracking toggle. Default matches avatar3d.js's default.
  let selectedLookEnabled = true;

  // Optional live mic test so the user can see/hear how their thresholds
  // respond to actual speech while tuning them, instead of guessing. Fully
  // self-contained here (separate from voice.js's own speaking detector,
  // which only runs during an actual voice-channel call).
  let micStream = null;
  let micAudioCtx = null;
  let micRafId = null;
  let micTestActive = false;

  const NAME_COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];

  function renderNameColorSwatches() {
    const list = $('#edit-profile-namecolor-list');
    list.innerHTML = '';

    const defaultSwatch = document.createElement('div');
    defaultSwatch.className = `color-swatch${selectedNameColor ? '' : ' selected'}`;
    defaultSwatch.style.background = 'var(--text-normal)';
    defaultSwatch.title = 'Default';
    defaultSwatch.addEventListener('click', () => {
      selectedNameColor = null;
      renderNameColorSwatches();
    });
    list.appendChild(defaultSwatch);

    NAME_COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = `color-swatch${selectedNameColor === color ? ' selected' : ''}`;
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        selectedNameColor = color;
        renderNameColorSwatches();
      });
      list.appendChild(swatch);
    });
  }

  function renderModelSection() {
    const status = $('#edit-profile-model-status');
    const hasModel = !!selectedModelUrl;
    status.textContent = hasModel ? 'A 3D model is set for voice chat' : 'No 3D model uploaded yet';

    $('#edit-profile-model-remove-btn').classList.toggle('hidden', !hasModel);
    $('#edit-profile-model-framing').classList.toggle('hidden', !hasModel);
    $('#edit-profile-model-zoom-slider').value = String(selectedModelZoom);
    $('#edit-profile-model-rotation-slider').value = String(selectedModelRotationY);
    renderLipSyncSliders();
    renderBlinkSliders();
    $('#edit-profile-model-look-toggle').checked = selectedLookEnabled;

    const toggle = $('#edit-profile-3d-toggle');
    toggle.checked = avatarMode === '3d';
    toggle.disabled = !hasModel;
    $('#edit-profile-3d-toggle-label').classList.toggle('disabled-label', !hasModel);
  }

  function disposeModelPreview() {
    stopMicTest();
    if (modelPreviewInstance) {
      try { modelPreviewInstance.dispose(); } catch (e) { /* noop */ }
      modelPreviewInstance = null;
    }
    const box = $('#edit-profile-model-preview');
    box.classList.remove('model-preview-loading', 'model-preview-error');
    box.innerHTML = '<span id="edit-profile-model-preview-placeholder">No model</span>';
  }

  function mountModelPreview(modelUrl) {
    disposeModelPreview();
    if (!modelUrl) return;

    const box = $('#edit-profile-model-preview');
    box.innerHTML = '';
    box.classList.add('model-preview-loading');

    if (!window.Avatar3D) {
      // three.js module hasn't finished loading yet — very unlikely, but
      // fail quietly rather than throw.
      box.classList.remove('model-preview-loading');
      box.classList.add('model-preview-error');
      return;
    }

    modelPreviewInstance = window.Avatar3D.createAvatar(box, {
      modelUrl,
      controls: true,
      zoom: selectedModelZoom,
      offsetX: selectedModelOffsetX,
      offsetY: selectedModelOffsetY,
      rotationY: selectedModelRotationY,
      mouthIntensity: selectedMouthIntensity,
      voiceStart: selectedVoiceStart,
      voiceMax: selectedVoiceMax,
      blinkIntensity: selectedBlinkIntensity,
      blinkIntervalMin: selectedBlinkIntervalMin,
      blinkIntervalMax: selectedBlinkIntervalMax,
      blinkEnabled: selectedBlinkEnabled,
      lookAtCursor: selectedLookEnabled,
      onReady: () => box.classList.remove('model-preview-loading'),
      onError: () => {
        box.classList.remove('model-preview-loading');
        box.classList.add('model-preview-error');
      },
      onFramingChange: ({ zoom, offsetX, offsetY, rotationY }) => {
        selectedModelZoom = zoom;
        selectedModelOffsetX = offsetX;
        selectedModelOffsetY = offsetY;
        selectedModelRotationY = rotationY;
        $('#edit-profile-model-zoom-slider').value = String(zoom);
        $('#edit-profile-model-rotation-slider').value = String(rotationY);
      }
    });
  }

  function applyZoomFromSlider(value) {
    selectedModelZoom = Number(value);
    if (modelPreviewInstance) modelPreviewInstance.setFraming({ zoom: selectedModelZoom });
  }

  function applyRotationFromSlider(value) {
    selectedModelRotationY = Number(value);
    if (modelPreviewInstance) modelPreviewInstance.setFraming({ rotationY: selectedModelRotationY });
  }

  function resetFraming() {
    selectedModelZoom = 1;
    selectedModelOffsetX = 0;
    selectedModelOffsetY = 0;
    selectedModelRotationY = 0;
    $('#edit-profile-model-zoom-slider').value = '1';
    $('#edit-profile-model-rotation-slider').value = '0';
    if (modelPreviewInstance) modelPreviewInstance.setFraming({ zoom: 1, offsetX: 0, offsetY: 0, rotationY: 0 });
  }

  function renderLipSyncSliders() {
    $('#edit-profile-model-mouth-slider').value = String(selectedMouthIntensity);
    $('#edit-profile-model-voicestart-slider').value = String(selectedVoiceStart);
    $('#edit-profile-model-voicemax-slider').value = String(selectedVoiceMax);
    $('#edit-profile-model-mouth-value').textContent = `${Math.round(selectedMouthIntensity * 100)}%`;
    $('#edit-profile-model-voicestart-value').textContent = `${Math.round(selectedVoiceStart)}%`;
    $('#edit-profile-model-voicemax-value').textContent = `${Math.round(selectedVoiceMax)}%`;
  }

  function applyMouthIntensityFromSlider(value) {
    selectedMouthIntensity = Number(value);
    renderLipSyncSliders();
    if (modelPreviewInstance) modelPreviewInstance.setLipSyncSettings({ mouthIntensity: selectedMouthIntensity });
  }

  function applyVoiceStartFromSlider(value) {
    selectedVoiceStart = Number(value);
    // Keep start strictly below max so the ramp never inverts - nudge max
    // up along with it rather than silently clamping/rejecting the drag.
    if (selectedVoiceStart >= selectedVoiceMax) {
      selectedVoiceMax = Math.min(100, selectedVoiceStart + 1);
    }
    renderLipSyncSliders();
    if (modelPreviewInstance) modelPreviewInstance.setLipSyncSettings({ voiceStart: selectedVoiceStart, voiceMax: selectedVoiceMax });
  }

  function applyVoiceMaxFromSlider(value) {
    selectedVoiceMax = Number(value);
    if (selectedVoiceMax <= selectedVoiceStart) {
      selectedVoiceStart = Math.max(0, selectedVoiceMax - 1);
    }
    renderLipSyncSliders();
    if (modelPreviewInstance) modelPreviewInstance.setLipSyncSettings({ voiceStart: selectedVoiceStart, voiceMax: selectedVoiceMax });
  }

  function resetLipSync() {
    selectedMouthIntensity = 0.5;
    selectedVoiceStart = 5;
    selectedVoiceMax = 59;
    renderLipSyncSliders();
    if (modelPreviewInstance) {
      modelPreviewInstance.setLipSyncSettings({ mouthIntensity: selectedMouthIntensity, voiceStart: selectedVoiceStart, voiceMax: selectedVoiceMax });
    }
  }

  function renderBlinkSliders() {
    $('#edit-profile-model-blink-toggle').checked = selectedBlinkEnabled;
    $('#edit-profile-model-blink-intensity-slider').value = String(selectedBlinkIntensity);
    $('#edit-profile-model-blink-min-slider').value = String(selectedBlinkIntervalMin);
    $('#edit-profile-model-blink-max-slider').value = String(selectedBlinkIntervalMax);
    $('#edit-profile-model-blink-intensity-value').textContent = `${Math.round(selectedBlinkIntensity * 100)}%`;
    $('#edit-profile-model-blink-min-value').textContent = `${selectedBlinkIntervalMin.toFixed(1)}s`;
    $('#edit-profile-model-blink-max-value').textContent = `${selectedBlinkIntervalMax.toFixed(1)}s`;
  }

  function applyBlinkToggle(enabled) {
    selectedBlinkEnabled = enabled;
    if (modelPreviewInstance) modelPreviewInstance.setBlinkSettings({ blinkEnabled: selectedBlinkEnabled });
  }

  function applyBlinkIntensityFromSlider(value) {
    selectedBlinkIntensity = Number(value);
    renderBlinkSliders();
    if (modelPreviewInstance) modelPreviewInstance.setBlinkSettings({ blinkIntensity: selectedBlinkIntensity });
  }

  function applyBlinkMinFromSlider(value) {
    selectedBlinkIntervalMin = Number(value);
    // Keep min at or below max, same "nudge the other one" approach as the
    // voice thresholds - a min past the max would never actually be used.
    if (selectedBlinkIntervalMin > selectedBlinkIntervalMax) {
      selectedBlinkIntervalMax = Math.min(20, selectedBlinkIntervalMin);
    }
    renderBlinkSliders();
    if (modelPreviewInstance) modelPreviewInstance.setBlinkSettings({ blinkIntervalMin: selectedBlinkIntervalMin, blinkIntervalMax: selectedBlinkIntervalMax });
  }

  function applyBlinkMaxFromSlider(value) {
    selectedBlinkIntervalMax = Number(value);
    if (selectedBlinkIntervalMax < selectedBlinkIntervalMin) {
      selectedBlinkIntervalMin = Math.max(0.2, selectedBlinkIntervalMax);
    }
    renderBlinkSliders();
    if (modelPreviewInstance) modelPreviewInstance.setBlinkSettings({ blinkIntervalMin: selectedBlinkIntervalMin, blinkIntervalMax: selectedBlinkIntervalMax });
  }

  function resetBlinkSettings() {
    selectedBlinkIntensity = 1;
    selectedBlinkIntervalMin = 2;
    selectedBlinkIntervalMax = 4;
    selectedBlinkEnabled = true;
    renderBlinkSliders();
    if (modelPreviewInstance) {
      modelPreviewInstance.setBlinkSettings({
        blinkIntensity: selectedBlinkIntensity,
        blinkIntervalMin: selectedBlinkIntervalMin,
        blinkIntervalMax: selectedBlinkIntervalMax,
        blinkEnabled: selectedBlinkEnabled
      });
    }
  }

  function applyLookToggle(enabled) {
    selectedLookEnabled = enabled;
    if (modelPreviewInstance) modelPreviewInstance.setLookAtCursor(selectedLookEnabled);
  }

  function stopMicTest() {
    micTestActive = false;
    $('#edit-profile-model-mic-test').classList.remove('mic-test-active');
    $('#edit-profile-model-mic-error').textContent = '';
    if (micRafId) cancelAnimationFrame(micRafId);
    micRafId = null;
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    if (micAudioCtx) { try { micAudioCtx.close(); } catch (e) { /* noop */ } micAudioCtx = null; }
    if (modelPreviewInstance) modelPreviewInstance.setVoiceLevel(0);
  }

  function startMicTest() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#edit-profile-model-mic-error').textContent = 'Microphone access is not available in this browser';
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      if (!micTestActive) { stream.getTracks().forEach((t) => t.stop()); return; } // toggled off mid-request
      micStream = stream;
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      micAudioCtx = new AudioCtx();
      const source = micAudioCtx.createMediaStreamSource(stream);
      const analyser = micAudioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!micTestActive) return;
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        if (modelPreviewInstance) modelPreviewInstance.setVoiceLevel(rms);
        micRafId = requestAnimationFrame(tick);
      };
      tick();
    }).catch(() => {
      $('#edit-profile-model-mic-error').textContent = 'Microphone permission was denied';
      micTestActive = false;
      $('#edit-profile-model-mic-test').classList.remove('mic-test-active');
    });
  }

  function toggleMicTest() {
    if (micTestActive) { stopMicTest(); return; }
    micTestActive = true;
    $('#edit-profile-model-mic-test').classList.add('mic-test-active');
    $('#edit-profile-model-mic-error').textContent = '';
    startMicTest();
  }

  function renderPhotoPreview() {
    const preview = $('#edit-profile-photo-preview');
    preview.innerHTML = '';
    if (selectedAvatarUrl) {
      const img = document.createElement('img');
      img.src = selectedAvatarUrl;
      img.alt = 'Profile preview';
      preview.appendChild(img);
    } else if (AppState.me?.displayName) {
      preview.textContent = initials(AppState.me.displayName);
    } else {
      preview.textContent = '?';
    }
    $('#edit-profile-remove-photo-btn').classList.toggle('hidden', !selectedAvatarUrl);
  }

  function openModal() {
    $('#edit-profile-error').textContent = '';
    $('#edit-profile-displayname').value = AppState.me.displayName;
    selectedAvatarUrl = AppState.me.avatarUrl || null;
    pendingAvatarFile = null;
    selectedNameColor = AppState.me.nameColor || null;
    selectedModelUrl = AppState.me.avatarModelUrl || null;
    avatarMode = AppState.me.avatarMode || 'flat';
    selectedModelZoom = AppState.me.avatarModelZoom ?? 1;
    selectedModelOffsetX = AppState.me.avatarModelOffsetX ?? 0;
    selectedModelOffsetY = AppState.me.avatarModelOffsetY ?? 0;
    selectedModelRotationY = AppState.me.avatarModelRotationY ?? 0;
    selectedMouthIntensity = AppState.me.avatarModelMouthIntensity ?? 0.5;
    selectedVoiceStart = AppState.me.avatarModelVoiceStart ?? 5;
    selectedVoiceMax = AppState.me.avatarModelVoiceMax ?? 59;
    selectedBlinkIntensity = AppState.me.avatarModelBlinkIntensity ?? 1;
    selectedBlinkIntervalMin = AppState.me.avatarModelBlinkIntervalMin ?? 2;
    selectedBlinkIntervalMax = AppState.me.avatarModelBlinkIntervalMax ?? 4;
    selectedBlinkEnabled = AppState.me.avatarModelBlinkEnabled ?? true;
    selectedLookEnabled = AppState.me.avatarModelLookEnabled ?? true;
    renderPhotoPreview();
    renderNameColorSwatches();
    renderModelSection();

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.remove('hidden');
    $('#edit-profile-displayname').focus();

    // Mount the 3D preview only after the panel (and its 320x320 box) is
    // actually laid out - doing this before unhiding the panel would leave
    // the container at 0x0 clientWidth/Height, and the renderer/camera
    // would silently fall back to a 96x96 canvas stretched to fill the box.
    mountModelPreview(selectedModelUrl);
  }

  function closeModal() {
    disposeModelPreview();
    $('#edit-profile-panel').classList.add('hidden');
    if (AppState.activeChat) {
      $('#chat-panel').classList.remove('hidden');
    } else {
      $('#empty-state').classList.remove('hidden');
    }
  }

  function save() {
    const displayName = $('#edit-profile-displayname').value.trim();
    $('#edit-profile-error').textContent = '';

    if (!displayName) {
      $('#edit-profile-error').textContent = 'Display name cannot be empty';
      return;
    }

    const finalizeSave = (avatarUrl) => {
      // Do not send avatarColor (removed from UI) so pass undefined
      Api.auth.updateMe(displayName, undefined, avatarUrl, selectedNameColor, selectedModelUrl, avatarMode, selectedModelZoom, selectedModelOffsetX, selectedModelOffsetY, selectedModelRotationY, selectedMouthIntensity, selectedVoiceStart, selectedVoiceMax, selectedBlinkIntensity, selectedBlinkIntervalMin, selectedBlinkIntervalMax, selectedBlinkEnabled, selectedLookEnabled)
        .then((data) => {
          Object.assign(AppState.me, data.user);
          $('#me-name').textContent = AppState.me.displayName;
          $('#me-name').style.color = AppState.me.nameColor || '';
          const meAvatar = $('#me-avatar');
          meAvatar.style.background = AppState.me.avatarColor;
          if (AppState.me.avatarUrl) {
            meAvatar.innerHTML = '';
            const img = document.createElement('img');
            img.src = AppState.me.avatarUrl;
            img.alt = AppState.me.displayName;
            meAvatar.appendChild(img);
          } else {
            meAvatar.textContent = initials(AppState.me.displayName);
          }
          closeModal();
          if (typeof VoiceChat !== 'undefined') VoiceChat.refreshSelfTile();
        })
        .catch((err) => { $('#edit-profile-error').textContent = err.message; });
    };

    const withAvatarUrl = (cb) => {
      if (pendingAvatarFile) {
        $('#edit-profile-error').textContent = 'Uploading image...';
        Api.messages.upload(pendingAvatarFile).then((data) => cb(data.url)).catch((err) => {
          $('#edit-profile-error').textContent = err.message;
        });
      } else {
        cb(selectedAvatarUrl || null);
      }
    };

    withAvatarUrl((avatarUrl) => finalizeSave(avatarUrl));
  }

  function initUI() {
    $('#edit-profile-btn').addEventListener('click', openModal);
    $('#edit-profile-cancel').addEventListener('click', closeModal);
    $('#edit-profile-close').addEventListener('click', closeModal);
    $('#edit-profile-save').addEventListener('click', save);
    $('#edit-profile-upload-btn').addEventListener('click', () => $('#edit-profile-file').click());
    $('#edit-profile-remove-photo-btn').addEventListener('click', () => {
      selectedAvatarUrl = null;
      pendingAvatarFile = null;
      renderPhotoPreview();
    });
    $('#edit-profile-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingAvatarFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        selectedAvatarUrl = reader.result;
        renderPhotoPreview();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('#edit-profile-displayname').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });

    $('#edit-profile-model-upload-btn').addEventListener('click', () => $('#edit-profile-model-file').click());
    $('#edit-profile-model-remove-btn').addEventListener('click', () => {
      selectedModelUrl = null;
      avatarMode = 'flat';
      selectedModelZoom = 1;
      selectedModelOffsetX = 0;
      selectedModelOffsetY = 0;
      selectedModelRotationY = 0;
      selectedMouthIntensity = 0.5;
      selectedVoiceStart = 5;
      selectedVoiceMax = 59;
      selectedBlinkIntensity = 1;
      selectedBlinkIntervalMin = 2;
      selectedBlinkIntervalMax = 4;
      selectedBlinkEnabled = true;
      selectedLookEnabled = true;
      renderModelSection();
      disposeModelPreview();
    });
    $('#edit-profile-model-zoom-slider').addEventListener('input', (e) => applyZoomFromSlider(e.target.value));
    $('#edit-profile-model-rotation-slider').addEventListener('input', (e) => applyRotationFromSlider(e.target.value));
    $('#edit-profile-model-zoom-reset').addEventListener('click', resetFraming);
    $('#edit-profile-model-mouth-slider').addEventListener('input', (e) => applyMouthIntensityFromSlider(e.target.value));
    $('#edit-profile-model-voicestart-slider').addEventListener('input', (e) => applyVoiceStartFromSlider(e.target.value));
    $('#edit-profile-model-voicemax-slider').addEventListener('input', (e) => applyVoiceMaxFromSlider(e.target.value));
    $('#edit-profile-model-lipsync-reset').addEventListener('click', resetLipSync);
    $('#edit-profile-model-mic-test').addEventListener('click', toggleMicTest);
    $('#edit-profile-model-blink-toggle').addEventListener('change', (e) => applyBlinkToggle(e.target.checked));
    $('#edit-profile-model-blink-intensity-slider').addEventListener('input', (e) => applyBlinkIntensityFromSlider(e.target.value));
    $('#edit-profile-model-blink-min-slider').addEventListener('input', (e) => applyBlinkMinFromSlider(e.target.value));
    $('#edit-profile-model-blink-max-slider').addEventListener('input', (e) => applyBlinkMaxFromSlider(e.target.value));
    $('#edit-profile-model-blink-reset').addEventListener('click', resetBlinkSettings);
    $('#edit-profile-model-look-toggle').addEventListener('change', (e) => applyLookToggle(e.target.checked));
    $('#edit-profile-model-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!/\.zip$/i.test(file.name)) {
        $('#edit-profile-error').textContent = 'Please choose a .zip containing your .pmx model and textures';
        return;
      }
      $('#edit-profile-error').textContent = '';
      $('#edit-profile-model-status').textContent = 'Uploading model…';
      Api.avatarModel.upload(file)
        .then((data) => {
          selectedModelUrl = data.modelUrl;
          selectedModelZoom = 1;
          selectedModelOffsetX = 0;
          selectedModelOffsetY = 0;
          selectedModelRotationY = 0;
          selectedMouthIntensity = 0.5;
          selectedVoiceStart = 5;
          selectedVoiceMax = 59;
          selectedBlinkIntensity = 1;
          selectedBlinkIntervalMin = 2;
          selectedBlinkIntervalMax = 4;
          selectedBlinkEnabled = true;
          selectedLookEnabled = true;
          renderModelSection();
          mountModelPreview(selectedModelUrl);
        })
        .catch((err) => {
          $('#edit-profile-error').textContent = err.message;
          renderModelSection();
        });
    });
    $('#edit-profile-3d-toggle').addEventListener('change', (e) => {
      avatarMode = e.target.checked ? '3d' : 'flat';
    });
  }

  return { initUI };
})();