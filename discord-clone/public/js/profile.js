// Simple profile edit modal: lets the user change their display name and
// avatar color, similar to Discord's "My Account" panel but pared down to
// the two fields the app actually has.
const Profile = (() => {
  const { $, $$, initials } = Utils;

  // avatar color selection removed
  let selectedAvatarUrl = null;
  let pendingAvatarFile = null;
  let selectedNameColor = null;

  // Profile banner: an image the user can upload in place of the default
  // gradient behind their avatar. Deferred until Save (unlike the 3D model,
  // this doesn't need a server URL just to preview - a local object URL is
  // enough), same pattern as the flat avatar photo above. zoom/offsetX/Y
  // frame it - drag-to-pan / scroll-to-zoom on the banner itself, or the
  // slider - the same way the 3D model preview is framed.
  let selectedBannerUrl = null;
  let pendingBannerFile = null;
  let selectedBannerZoom = 1.4;
  let selectedBannerOffsetX = 0;
  let selectedBannerOffsetY = 0;
  let bannerDragState = null; // { startX, startY, startOffsetX, startOffsetY } while dragging, else null

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
  // Manual override for which shape key(s) drive blinking - a comma-
  // separated string of exact names the user types in, for models whose
  // shape keys don't match anything in the built-in auto-detect list
  // (e.g. unusual or non-English names). Empty = auto-detect as before.
  let selectedBlinkShapeKeys = '';
  // Manual override for which shape key(s) drive the mouth-opening lip-sync
  // animation - same idea as selectedBlinkShapeKeys above, but for mouth
  // morphs instead of eye morphs. Empty = auto-detect as before.
  let selectedMouthShapeKeys = '';
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

  // Whether the 3D preview has been mounted yet for this modal session.
  // Mounting is deferred until the "3D Voice Avatar" tab is actually opened
  // (see switchTab) so three.js sees a real, already-laid-out box instead of
  // the 0x0 it'd get while that tab panel is still display:none.
  let modelPreviewMounted = false;

  // Live "how others see you" card at the top of the editor - mirrors the
  // display name input and selected color so changes show immediately.
  function renderPreviewCard() {
    const nameEl = $('#edit-profile-preview-name');
    if (!nameEl) return;
    const name = $('#edit-profile-displayname').value.trim() || AppState.me?.displayName || 'Display Name';
    nameEl.textContent = name;
    nameEl.style.color = selectedNameColor || '';
  }

  function switchTab(tabName) {
    $$('.profile-tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabName));
    $$('.profile-tab-panel').forEach((panel) => panel.classList.toggle('active', panel.dataset.tabPanel === tabName));
    if (tabName === 'avatar3d' && !modelPreviewMounted) {
      modelPreviewMounted = true;
      mountModelPreview(selectedModelUrl);
    }
  }

  // The Framing/Blinking/Lip sync/Gaze shape-key groups behave like an
  // accordion: clicking a group's header opens that group's controls and
  // collapses the rest, so only one set of sliders is on screen at a time.
  // Clicking the already-open group's header collapses it too, so everything
  // can be closed up if the person just wants the tidy, collapsed view.
  function expandFramingGroup(groupEl) {
    $$('.model-framing-group').forEach((g) => g.classList.add('collapsed'));
    groupEl.classList.remove('collapsed');
  }

  function initFramingAccordion() {
    $$('.model-framing-group-header').forEach((header) => {
      header.addEventListener('click', (e) => {
        // Don't hijack clicks on the enable/disable switch in the header -
        // those should just flip the toggle, not also drive the accordion.
        if (e.target.closest('.model-framing-group-switch')) return;
        const group = header.closest('.model-framing-group');
        if (group.classList.contains('collapsed')) {
          expandFramingGroup(group);
        } else {
          group.classList.add('collapsed');
        }
      });
    });
  }

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
      renderPreviewCard();
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
        renderPreviewCard();
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
    renderShapeKeyHint([]);
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
      blinkShapeKeys: selectedBlinkShapeKeys,
      mouthShapeKeys: selectedMouthShapeKeys,
      lookAtCursor: selectedLookEnabled,
      onReady: ({ shapeKeyNames } = {}) => {
        box.classList.remove('model-preview-loading');
        renderShapeKeyHint(shapeKeyNames || []);
      },
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
    $('#edit-profile-model-mouth-shapekeys-input').value = selectedMouthShapeKeys;
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
    selectedMouthShapeKeys = '';
    renderLipSyncSliders();
    if (modelPreviewInstance) {
      modelPreviewInstance.setLipSyncSettings({ mouthIntensity: selectedMouthIntensity, voiceStart: selectedVoiceStart, voiceMax: selectedVoiceMax });
      modelPreviewInstance.setMouthShapeKeys(selectedMouthShapeKeys);
    }
  }

  function applyMouthShapeKeysFromInput(value) {
    selectedMouthShapeKeys = value;
    if (modelPreviewInstance) modelPreviewInstance.setMouthShapeKeys(selectedMouthShapeKeys);
  }

  function renderBlinkSliders() {
    $('#edit-profile-model-blink-toggle').checked = selectedBlinkEnabled;
    $('#edit-profile-model-blink-intensity-slider').value = String(selectedBlinkIntensity);
    $('#edit-profile-model-blink-min-slider').value = String(selectedBlinkIntervalMin);
    $('#edit-profile-model-blink-max-slider').value = String(selectedBlinkIntervalMax);
    $('#edit-profile-model-blink-intensity-value').textContent = `${Math.round(selectedBlinkIntensity * 100)}%`;
    $('#edit-profile-model-blink-min-value').textContent = `${selectedBlinkIntervalMin.toFixed(1)}s`;
    $('#edit-profile-model-blink-max-value').textContent = `${selectedBlinkIntervalMax.toFixed(1)}s`;
    $('#edit-profile-model-blink-shapekeys-input').value = selectedBlinkShapeKeys;
    $('#edit-profile-model-blink-body').classList.toggle('group-disabled', !selectedBlinkEnabled);
  }

  // MMD models are almost always authored with Japanese morph names, and
  // that name is baked into the .pmx file itself - there's no English
  // version stored anywhere to read instead. This is a best-effort lookup
  // covering the standard morph names that show up on the vast majority of
  // MMD models (the "standard" facial morph set most modelers follow),
  // used only to label the datalist options below - the actual value typed
  // into the field (and matched against the model) always stays the real
  // Japanese name, since that's what findShapeKeys() needs to match against
  // the model's morph dictionary. Grouped by category so the blink field
  // (below) can filter down to just the eye-related ones instead of also
  // suggesting mouth/eyebrow morphs that have nothing to do with blinking.
  const SHAPE_KEY_TRANSLATIONS = {
    eyes: {
      'まばたき': 'Blink', 'まばたき2': 'Blink 2', 'まばたき１': 'Blink 1',
      'ウィンク': 'Wink (right)', 'ウィンク右': 'Wink (right)', 'ウィンク２': 'Wink 2',
      'ウィンク2': 'Wink 2', 'ウインク': 'Wink (right)', 'ウィンク左': 'Wink (left)',
      '笑い': 'Smile (eyes)', 'なごみ': 'Gentle eyes', 'びっくり': 'Surprised',
      'じと目': 'Half-lidded / doubtful eyes', 'ジト目': 'Half-lidded / doubtful eyes',
      '三角目': 'Narrowed / triangle eyes', '死に目': 'Dead / X eyes',
      'はぁと': 'Heart eyes', 'ハート': 'Heart eyes', '星目': 'Star eyes',
      '恐ろしい子': 'Wide shocked eyes', 'ハイライト消し': 'Highlight off',
      'ハイライト消': 'Highlight off', '白目': 'White / blank eyes',
      '瞳小': 'Small pupils', '瞳大': 'Large pupils', '光下': 'Eye light down',
      'つぶり': 'Eyes closed', 'つむり': 'Eyes closed',
      '眼球下': 'Eyes look down', '眼球上': 'Eyes look up',
    },
    mouth: {
      'あ': 'Ah (mouth open)', 'い': 'I (mouth)', 'う': 'U (mouth)', 'え': 'E (mouth)',
      'お': 'O (mouth)', 'わ': 'Wa (mouth)', 'ω': 'Small O mouth', 'ω□': 'Square small mouth',
      'にやり': 'Smirk / grin', 'にっこり': 'Big smile',
      '口角上げ': 'Mouth corners up', '口角下げ': 'Mouth corners down',
      '口横広げ': 'Mouth stretched wide', '口横狭め': 'Mouth narrowed',
      '歯無し上': 'Hide upper teeth', '歯無し下': 'Hide lower teeth',
      'ぺろっ': 'Tongue out', 'てへぺろ': 'Tongue out (playful)',
    },
    eyebrows: {
      '真面目': 'Serious eyebrows', '困る': 'Troubled eyebrows', '怒り': 'Angry eyebrows',
      '上': 'Eyebrows up', '下': 'Eyebrows down', '眉頭右': 'Right eyebrow inner',
      '眉頭左': 'Left eyebrow inner', 'キリッ': 'Determined', 'きりっ': 'Determined',
    },
    other: {
      '照れ': 'Blush', '青ざめ': 'Pale / shocked', '汗': 'Sweat drop',
      '涙': 'Tears', '怒': 'Anger mark',
    },
  };

  // Flat map of every known name -> translation, regardless of category -
  // used when labelling an option we've already decided to show.
  const SHAPE_KEY_TRANSLATIONS_FLAT = Object.assign({}, ...Object.values(SHAPE_KEY_TRANSLATIONS));

  function translateShapeKeyName(name) {
    if (SHAPE_KEY_TRANSLATIONS_FLAT[name]) return SHAPE_KEY_TRANSLATIONS_FLAT[name];
    // Some models suffix/prefix the base morph name (e.g. "まばたき_L").
    // Fall back to a substring match against the known set so those still
    // get a usable label instead of nothing.
    const match = Object.keys(SHAPE_KEY_TRANSLATIONS_FLAT).find((jp) => name.includes(jp));
    return match ? SHAPE_KEY_TRANSLATIONS_FLAT[match] : null;
  }

  // Same keyword list findShapeKeys() in avatar3d.js uses to auto-detect
  // blink morphs, plus a few extra eye-only terms - used here to catch
  // eye-related shape keys that aren't in the known-translation set above
  // (custom/unusual model names), so the filter below isn't limited to
  // only the names we happen to have a translation for.
  const EYE_RELATED_KEYWORDS = [
    'blink', 'eye', '目', 'まばたき', 'closeeye', 'eyelid', 'wink',
    'ウィンク', 'ウインク', '瞼', '瞳', '眼', '白目', 'ハイライト',
  ];

  function isEyeRelatedShapeKey(name) {
    if (SHAPE_KEY_TRANSLATIONS.eyes[name]) return true;
    const lower = name.toLowerCase();
    return EYE_RELATED_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }

  // Same idea as EYE_RELATED_KEYWORDS above, but matching findShapeKeys()'s
  // default mouth-morph name list, so the mouth shape-key field's
  // autocomplete only surfaces mouth-related morphs instead of also
  // suggesting eye/eyebrow ones.
  const MOUTH_RELATED_KEYWORDS = [
    'あ', 'い', 'う', 'え', 'お', 'mouth', 'open', '口', '開',
    'わ', 'ω', 'にやり', 'にっこり', '歯', 'ぺろ', 'てへ',
  ];

  function isMouthRelatedShapeKey(name) {
    if (SHAPE_KEY_TRANSLATIONS.mouth[name]) return true;
    const lower = name.toLowerCase();
    return MOUTH_RELATED_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }

  // Lists whatever shape keys the currently-loaded model actually has as
  // <option>s in a <datalist>, so the blink/mouth shape-key fields can
  // offer autocomplete instead of the user having to guess an exact name
  // (MMD models frequently use Japanese shape key names). Each field is
  // filtered down to its own related morphs only, so the other field's
  // morphs don't show up as noise. The fields themselves still need the
  // real (Japanese) name typed in to match the model, so `value` stays
  // untranslated - only the visible `label` gets an English hint where
  // one is known.
  function renderShapeKeyHint(names) {
    const datalist = $('#edit-profile-model-shapekeys-datalist');
    const mouthDatalist = $('#edit-profile-model-mouth-shapekeys-datalist');
    if (datalist) {
      datalist.innerHTML = '';
      names.filter(isEyeRelatedShapeKey).forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        // Most browsers render datalist options as "value — label" (e.g.
        // Chrome shows the value on the left, the label greyed-out on the
        // right), so the label only needs the translation itself - the
        // Japanese original is already shown via `value`.
        const translated = translateShapeKeyName(name);
        opt.label = translated || name;
        datalist.appendChild(opt);
      });
    }
    if (mouthDatalist) {
      mouthDatalist.innerHTML = '';
      names.filter(isMouthRelatedShapeKey).forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        const translated = translateShapeKeyName(name);
        opt.label = translated || name;
        mouthDatalist.appendChild(opt);
      });
    }
  }

  function applyBlinkShapeKeysFromInput(value) {
    selectedBlinkShapeKeys = value;
    if (modelPreviewInstance) modelPreviewInstance.setBlinkShapeKeys(selectedBlinkShapeKeys);
  }

  function applyBlinkToggle(enabled) {
    selectedBlinkEnabled = enabled;
    renderBlinkSliders();
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
    selectedBlinkShapeKeys = '';
    renderBlinkSliders();
    if (modelPreviewInstance) {
      modelPreviewInstance.setBlinkSettings({
        blinkIntensity: selectedBlinkIntensity,
        blinkIntervalMin: selectedBlinkIntervalMin,
        blinkIntervalMax: selectedBlinkIntervalMax,
        blinkEnabled: selectedBlinkEnabled
      });
      modelPreviewInstance.setBlinkShapeKeys(selectedBlinkShapeKeys);
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

  // Applies the current banner image/zoom/offset state to the preview box.
  // offsetX/Y are pixel offsets from center, so they're layered on top of
  // the CSS's own `center center` base position via calc() - increasing
  // offsetX pans the image right, offsetY pans it down.
  function renderBannerPreview() {
    const banner = $('#edit-profile-banner');
    const hasImage = !!selectedBannerUrl;
    banner.classList.toggle('has-banner-image', hasImage);
    if (hasImage) {
      banner.style.backgroundImage = `url("${selectedBannerUrl}")`;
      banner.style.backgroundSize = `${selectedBannerZoom * 100}%`;
      banner.style.backgroundPosition = `calc(50% + ${selectedBannerOffsetX}px) calc(50% + ${selectedBannerOffsetY}px)`;
    } else {
      banner.style.backgroundImage = '';
      banner.style.backgroundSize = '';
      banner.style.backgroundPosition = '';
    }
    $('#edit-profile-banner-remove-btn').classList.toggle('hidden', !hasImage);
  }

  function clampBannerOffsets() {
    // Loosely bounded rather than strictly locked to "never reveal empty
    // space behind the image" - that math (banner size * (zoom-1) / 2) felt
    // too restrictive to actually frame things the way people wanted, and
    // dragging a bit past the image's edge into empty space is fine. This
    // just keeps the drag from running away to something absurd; the real
    // safety net is the server's own clamp on save.
    const banner = $('#edit-profile-banner');
    const maxX = banner.offsetWidth;
    const maxY = banner.offsetHeight * 2;
    selectedBannerOffsetX = Math.min(maxX, Math.max(-maxX, selectedBannerOffsetX));
    selectedBannerOffsetY = Math.min(maxY, Math.max(-maxY, selectedBannerOffsetY));
  }

  function applyBannerZoom(value) {
    selectedBannerZoom = Number(value);
    clampBannerOffsets();
    renderBannerPreview();
  }

  function startBannerDrag(clientX, clientY) {
    if (!selectedBannerUrl) return;
    bannerDragState = { startX: clientX, startY: clientY, startOffsetX: selectedBannerOffsetX, startOffsetY: selectedBannerOffsetY };
    $('#edit-profile-banner').classList.add('dragging-banner-image');
  }

  function moveBannerDrag(clientX, clientY) {
    if (!bannerDragState) return;
    selectedBannerOffsetX = bannerDragState.startOffsetX + (clientX - bannerDragState.startX);
    selectedBannerOffsetY = bannerDragState.startOffsetY + (clientY - bannerDragState.startY);
    clampBannerOffsets();
    renderBannerPreview();
  }

  function endBannerDrag() {
    bannerDragState = null;
    $('#edit-profile-banner').classList.remove('dragging-banner-image');
  }

  function initBannerFraming() {
    const banner = $('#edit-profile-banner');

    banner.addEventListener('mousedown', (e) => {
      if (e.target.closest('.profile-banner-actions')) return; // don't drag when clicking the buttons
      e.preventDefault();
      startBannerDrag(e.clientX, e.clientY);
    });
    window.addEventListener('mousemove', (e) => moveBannerDrag(e.clientX, e.clientY));
    window.addEventListener('mouseup', endBannerDrag);

    banner.addEventListener('touchstart', (e) => {
      if (e.target.closest('.profile-banner-actions')) return;
      const t = e.touches[0];
      startBannerDrag(t.clientX, t.clientY);
    }, { passive: true });
    banner.addEventListener('touchmove', (e) => {
      if (!bannerDragState) return;
      const t = e.touches[0];
      moveBannerDrag(t.clientX, t.clientY);
    }, { passive: true });
    banner.addEventListener('touchend', endBannerDrag);

    // Scroll-to-zoom, same gesture as the 3D model preview.
    banner.addEventListener('wheel', (e) => {
      if (!selectedBannerUrl) return;
      e.preventDefault();
      const next = selectedBannerZoom - e.deltaY * 0.0015;
      applyBannerZoom(Math.min(3, Math.max(1.4, next)));
    }, { passive: false });
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
    selectedBlinkShapeKeys = AppState.me.avatarModelBlinkShapeKeys ?? '';
    selectedMouthShapeKeys = AppState.me.avatarModelMouthShapeKeys ?? '';
    selectedLookEnabled = AppState.me.avatarModelLookEnabled ?? true;
    selectedBannerUrl = AppState.me.bannerUrl || null;
    pendingBannerFile = null;
    selectedBannerZoom = AppState.me.bannerZoom ?? 1.4;
    selectedBannerOffsetX = AppState.me.bannerOffsetX ?? 0;
    selectedBannerOffsetY = AppState.me.bannerOffsetY ?? 0;
    renderPhotoPreview();
    renderBannerPreview();
    renderNameColorSwatches();
    renderModelSection();
    renderPreviewCard();
    modelPreviewMounted = false;
    switchTab('general');

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.remove('hidden');
    $('#edit-profile-displayname').focus();

    // The 3D preview is mounted lazily by switchTab() the first time the
    // "3D Voice Avatar" tab is opened - doing it eagerly here would target a
    // box that's still display:none (0x0 clientWidth/Height) since that tab
    // panel isn't the one shown by default.
  }

  function closeModal() {
    disposeModelPreview();
    modelPreviewMounted = false;
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

    const finalizeSave = (avatarUrl, bannerUrl) => {
      // Do not send avatarColor (removed from UI) so pass undefined
      Api.auth.updateMe({
        displayName, avatarColor: undefined, avatarUrl, nameColor: selectedNameColor,
        avatarModelUrl: selectedModelUrl, avatarMode,
        avatarModelZoom: selectedModelZoom, avatarModelOffsetX: selectedModelOffsetX, avatarModelOffsetY: selectedModelOffsetY, avatarModelRotationY: selectedModelRotationY,
        avatarModelMouthIntensity: selectedMouthIntensity, avatarModelVoiceStart: selectedVoiceStart, avatarModelVoiceMax: selectedVoiceMax,
        avatarModelBlinkIntensity: selectedBlinkIntensity, avatarModelBlinkIntervalMin: selectedBlinkIntervalMin, avatarModelBlinkIntervalMax: selectedBlinkIntervalMax, avatarModelBlinkEnabled: selectedBlinkEnabled,
        avatarModelBlinkShapeKeys: selectedBlinkShapeKeys,
        avatarModelMouthShapeKeys: selectedMouthShapeKeys,
        avatarModelLookEnabled: selectedLookEnabled,
        bannerUrl, bannerZoom: selectedBannerZoom, bannerOffsetX: selectedBannerOffsetX, bannerOffsetY: selectedBannerOffsetY
      })
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

    // Uploads whichever of the avatar photo / banner photo have a pending
    // local file, in parallel, then calls finalizeSave with both final URLs.
    // Files that weren't changed just pass through their existing URL.
    const avatarUpload = pendingAvatarFile ? Api.messages.upload(pendingAvatarFile) : Promise.resolve({ url: selectedAvatarUrl || null });
    const bannerUpload = pendingBannerFile ? Api.messages.upload(pendingBannerFile) : Promise.resolve({ url: selectedBannerUrl || null });

    if (pendingAvatarFile || pendingBannerFile) {
      $('#edit-profile-error').textContent = 'Uploading image...';
    }

    Promise.all([avatarUpload, bannerUpload])
      .then(([avatarData, bannerData]) => finalizeSave(avatarData.url, bannerData.url))
      .catch((err) => { $('#edit-profile-error').textContent = err.message; });
  }

  function initUI() {
    initFramingAccordion();
    initBannerFraming();
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
    $('#edit-profile-banner-upload-btn').addEventListener('click', () => $('#edit-profile-banner-file').click());
    $('#edit-profile-banner-remove-btn').addEventListener('click', () => {
      selectedBannerUrl = null;
      pendingBannerFile = null;
      selectedBannerZoom = 1;
      selectedBannerOffsetX = 0;
      selectedBannerOffsetY = 0;
      renderBannerPreview();
    });
    $('#edit-profile-banner-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingBannerFile = file;
      // Reset framing on a fresh image - the old offsets almost certainly
      // don't make sense for a differently-shaped photo. Start pre-zoomed in
      // a bit (rather than 1 = exactly `cover`, which leaves zero slack to
      // pan) so dragging has somewhere to go immediately - there's no slider
      // anymore, so scrolling to zoom first isn't something everyone will
      // discover on their own.
      selectedBannerZoom = 1.4;
      selectedBannerOffsetX = 0;
      selectedBannerOffsetY = 0;
      const reader = new FileReader();
      reader.onload = () => {
        selectedBannerUrl = reader.result;
        renderBannerPreview();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });

    $('#edit-profile-displayname').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
    });
    $('#edit-profile-displayname').addEventListener('input', renderPreviewCard);

    $$('.profile-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
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
      selectedBlinkShapeKeys = '';
      selectedMouthShapeKeys = '';
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
    $('#edit-profile-model-mouth-shapekeys-input').addEventListener('input', (e) => applyMouthShapeKeysFromInput(e.target.value));
    $('#edit-profile-model-mic-test').addEventListener('click', toggleMicTest);
    $('#edit-profile-model-blink-toggle').addEventListener('change', (e) => applyBlinkToggle(e.target.checked));
    $('#edit-profile-model-blink-intensity-slider').addEventListener('input', (e) => applyBlinkIntensityFromSlider(e.target.value));
    $('#edit-profile-model-blink-min-slider').addEventListener('input', (e) => applyBlinkMinFromSlider(e.target.value));
    $('#edit-profile-model-blink-max-slider').addEventListener('input', (e) => applyBlinkMaxFromSlider(e.target.value));
    $('#edit-profile-model-blink-shapekeys-input').addEventListener('input', (e) => applyBlinkShapeKeysFromInput(e.target.value));
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
          selectedBlinkShapeKeys = '';
          selectedMouthShapeKeys = '';
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