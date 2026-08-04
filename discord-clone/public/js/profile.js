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
  // morphs instead of eye morphs, and same shape as the surprise slots
  // below: up to 3 shape keys, each with its own intensity (0-1), so up to
  // 3 mouth morphs can be driven at once instead of only ever one. Empty
  // entries (blank name) are ignored and fall back to auto-detect.
  let selectedMouthShapeKeys = makeEmptyMouthEntries();
  // Manual overrides for the mouse-hold surprise expression. The user can
  // save up to 5 different combos ("slots"), each up to 3 shape keys with
  // their own intensity (0-1) - e.g. one slot for a startled face, another
  // for a wink, another for a full anime-shock take. Only one slot is
  // "active" at a time (activeSurpriseSlot) - that's the combo actually
  // broadcast and rendered when the user holds the mouse down, for
  // themselves and everyone else in the call. editingSurpriseSlot is purely
  // local UI state: which slot's fields are currently shown in Edit Profile
  // for tuning, independent of which one is live, so switching tabs to
  // tweak a different slot can't accidentally change what's playing until
  // the user explicitly hits "Use this slot on hold". Empty entries in a
  // slot are ignored; a slot with none set falls back to the built-in
  // surprise/shock keyword auto-detect if/when it's made active.
  const SURPRISE_SLOT_COUNT = 5;
  let selectedSurpriseSlots = makeEmptySurpriseSlots();
  let activeSurpriseSlot = 0;
  let editingSurpriseSlot = 0;
  // Whether holding the mouse down triggers the surprise expression at
  // all - same idea as selectedBlinkEnabled, just for this group instead.
  let selectedSurpriseEnabled = true;
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

  // Avatar border: a decorative ring around the avatar photo. 'none' is the
  // plain default ring; 'solid'/'glow' use selectedAvatarBorderColor (a
  // preset swatch or a fully custom hex value from the color picker);
  // 'rainbow' is a fixed animated gradient and ignores the color entirely.
  let selectedAvatarBorderStyle = 'none';
  let selectedAvatarBorderColor = null;
  // Card accent color: tints the profile card below the banner. NULL means
  // the plain default card background.
  let selectedAccentColor = null;

  // Card Effects: user-uploaded GIF stickers (wings, fire, sparkles, etc.)
  // scattered around the card. Each entry is { id, url, x, y, scale } - id
  // is a client-side temp id (the server always regenerates its own on
  // save, so duplicates/collisions there don't matter). Uploaded to the
  // server immediately on pick (same reasoning as the 3D model upload -
  // there's no good local-only preview path once it needs a real URL to
  // reuse elsewhere), rather than deferred until Save.
  let selectedEffects = [];
  let selectedEffectId = null; // which sticker is selected (shows remove btn + outline)
  let effectDragState = null; // { id, startX, startY, startFxX, startFxY, moved } while dragging, else null
  let effectRotateState = null; // { id, centerX, centerY, startAngle, startRotation } while rotating, else null
  let effectResizeState = null; // { id, centerX, centerY, startDist, startScale } while resizing, else null

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
    Utils.applyCardTheming($('#edit-profile-preview-card'), $('#edit-profile-avatar-ring'), {
      avatarBorderStyle: selectedAvatarBorderStyle,
      avatarBorderColor: selectedAvatarBorderColor,
      profileAccentColor: selectedAccentColor
    });
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

  function renderBorderStyleGroup() {
    $$('#edit-profile-borderstyle-group .style-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.style === selectedAvatarBorderStyle);
    });
    $('#edit-profile-border-color-row').classList.toggle(
      'hidden',
      selectedAvatarBorderStyle !== 'solid' && selectedAvatarBorderStyle !== 'glow'
    );
  }

  function renderBorderColorSwatches() {
    const list = $('#edit-profile-bordercolor-list');
    list.innerHTML = '';
    NAME_COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = `color-swatch${selectedAvatarBorderColor === color ? ' selected' : ''}`;
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        selectedAvatarBorderColor = color;
        renderBorderColorSwatches();
        renderPreviewCard();
      });
      list.appendChild(swatch);
    });
    $('#edit-profile-bordercolor-custom').value = selectedAvatarBorderColor || '#5865F2';
  }

  function renderAccentColorSwatches() {
    const list = $('#edit-profile-accentcolor-list');
    list.innerHTML = '';

    const defaultSwatch = document.createElement('div');
    defaultSwatch.className = `color-swatch${selectedAccentColor ? '' : ' selected'}`;
    defaultSwatch.style.background = 'var(--bg-lighter)';
    defaultSwatch.title = 'Default';
    defaultSwatch.addEventListener('click', () => {
      selectedAccentColor = null;
      renderAccentColorSwatches();
      renderPreviewCard();
    });
    list.appendChild(defaultSwatch);

    NAME_COLORS.forEach((color) => {
      const swatch = document.createElement('div');
      swatch.className = `color-swatch${selectedAccentColor === color ? ' selected' : ''}`;
      swatch.style.background = color;
      swatch.title = color;
      swatch.addEventListener('click', () => {
        selectedAccentColor = color;
        renderAccentColorSwatches();
        renderPreviewCard();
      });
      list.appendChild(swatch);
    });
    $('#edit-profile-accentcolor-custom').value = selectedAccentColor || '#5865F2';
  }

  // Golden-angle spiral so successively added stickers spread out around
  // the card instead of stacking in the same spot - same trick used for
  // evenly distributing points without any layout math.
  function defaultEffectPosition(index) {
    const angle = (index * 137.5) % 360;
    const radius = 100 + (index % 3) * 22;
    const rad = (angle * Math.PI) / 180;
    return {
      x: Math.round(Math.cos(rad) * radius),
      y: Math.round(Math.sin(rad) * radius * 0.65)
    };
  }

  function renderEffectsLayer() {
    const layer = $('#edit-profile-effects-layer');
    layer.innerHTML = '';
    $('#edit-profile-effect-count').textContent = selectedEffects.length
      ? `${selectedEffects.length}/8`
      : '';

    selectedEffects.forEach((fx) => {
      const el = document.createElement('div');
      el.className = `profile-effect-sticker editable${fx.id === selectedEffectId ? ' selected' : ''}`;
      const size = Utils.EFFECT_BASE_SIZE * (fx.scale || 1);
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `calc(50% + ${fx.x}px)`;
      el.style.top = `${Utils.EFFECT_ANCHOR_Y + fx.y}px`;
      el.style.setProperty('--fx-rotation', `${fx.rotation || 0}deg`);

      const img = document.createElement('img');
      img.src = fx.url;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'profile-effect-remove-btn';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeEffect(fx.id);
      });
      el.appendChild(removeBtn);

      // Rotate handle: drag around the sticker's center, angle-to-pointer
      // becomes the new rotation. Its own pointerdown stops propagation so
      // it doesn't also trigger the move-drag below.
      const rotateHandle = document.createElement('button');
      rotateHandle.type = 'button';
      rotateHandle.className = 'profile-effect-rotate-handle';
      rotateHandle.title = 'Drag to rotate';
      rotateHandle.textContent = '⟳';
      el.appendChild(rotateHandle);

      // Resize handle: drag out from the bottom-right corner, distance from
      // center vs. the distance at drag-start scales the sticker. Wheel-to-
      // resize (below) still works too - this just gives a visible, precise,
      // touch-friendly handle for the same thing.
      const resizeHandle = document.createElement('button');
      resizeHandle.type = 'button';
      resizeHandle.className = 'profile-effect-resize-handle';
      resizeHandle.title = 'Drag to resize';
      el.appendChild(resizeHandle);

      el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.profile-effect-remove-btn, .profile-effect-rotate-handle, .profile-effect-resize-handle')) return;
        e.preventDefault();
        e.stopPropagation();
        selectedEffectId = fx.id;
        renderEffectsList();
        effectDragState = { id: fx.id, startX: e.clientX, startY: e.clientY, startFxX: fx.x, startFxY: fx.y, moved: false };
        el.classList.add('dragging');
        el.setPointerCapture(e.pointerId);
      });
      el.addEventListener('pointermove', (e) => {
        if (!effectDragState || effectDragState.id !== fx.id) return;
        const dx = e.clientX - effectDragState.startX;
        const dy = e.clientY - effectDragState.startY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) effectDragState.moved = true;
        fx.x = Math.min(160, Math.max(-160, effectDragState.startFxX + dx));
        fx.y = Math.min(160, Math.max(-160, effectDragState.startFxY + dy));
        el.style.left = `calc(50% + ${fx.x}px)`;
        el.style.top = `${Utils.EFFECT_ANCHOR_Y + fx.y}px`;
      });
      const endDrag = (e) => {
        if (!effectDragState || effectDragState.id !== fx.id) return;
        el.classList.remove('dragging');
        effectDragState = null;
      };
      el.addEventListener('pointerup', endDrag);
      el.addEventListener('pointercancel', endDrag);

      rotateHandle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedEffectId = fx.id;
        renderEffectsList();
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);
        effectRotateState = { id: fx.id, centerX, centerY, startAngle, startRotation: fx.rotation || 0 };
        rotateHandle.setPointerCapture(e.pointerId);
      });
      rotateHandle.addEventListener('pointermove', (e) => {
        if (!effectRotateState || effectRotateState.id !== fx.id) return;
        const angle = Math.atan2(e.clientY - effectRotateState.centerY, e.clientX - effectRotateState.centerX) * (180 / Math.PI);
        fx.rotation = Math.round(effectRotateState.startRotation + (angle - effectRotateState.startAngle));
        el.style.setProperty('--fx-rotation', `${fx.rotation}deg`);
      });
      const endRotate = () => { effectRotateState = null; };
      rotateHandle.addEventListener('pointerup', endRotate);
      rotateHandle.addEventListener('pointercancel', endRotate);

      resizeHandle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectedEffectId = fx.id;
        renderEffectsList();
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const startDist = Math.max(10, Math.hypot(e.clientX - centerX, e.clientY - centerY));
        effectResizeState = { id: fx.id, centerX, centerY, startDist, startScale: fx.scale || 1 };
        resizeHandle.setPointerCapture(e.pointerId);
      });
      resizeHandle.addEventListener('pointermove', (e) => {
        if (!effectResizeState || effectResizeState.id !== fx.id) return;
        const dist = Math.hypot(e.clientX - effectResizeState.centerX, e.clientY - effectResizeState.centerY);
        fx.scale = Math.min(4, Math.max(0.3, effectResizeState.startScale * (dist / effectResizeState.startDist)));
        const s = Utils.EFFECT_BASE_SIZE * fx.scale;
        el.style.width = `${s}px`;
        el.style.height = `${s}px`;
      });
      const endResize = () => { effectResizeState = null; };
      resizeHandle.addEventListener('pointerup', endResize);
      resizeHandle.addEventListener('pointercancel', endResize);

      el.addEventListener('wheel', (e) => {
        e.preventDefault();
        fx.scale = Math.min(4, Math.max(0.3, (fx.scale || 1) - e.deltaY * 0.001));
        const s = Utils.EFFECT_BASE_SIZE * fx.scale;
        el.style.width = `${s}px`;
        el.style.height = `${s}px`;
      }, { passive: false });

      layer.appendChild(el);
    });
  }

  function removeEffect(id) {
    selectedEffects = selectedEffects.filter((x) => x.id !== id);
    if (selectedEffectId === id) selectedEffectId = null;
    renderEffectsLayer();
    renderEffectsList();
  }

  // Layer order: which sticker draws on top of which is just array order -
  // both the editable layer here and the read-only Utils.renderProfileEffects
  // append stickers to the DOM in array order with no z-index, so later in
  // the array = rendered later = visually on top. Moving a sticker "forward"
  // means moving it later in selectedEffects; "backward" means earlier.
  // delta is +1 (forward, toward front/top) or -1 (backward, toward back).
  function moveEffect(id, delta) {
    const from = selectedEffects.findIndex((x) => x.id === id);
    if (from === -1) return;
    const to = from + delta;
    if (to < 0 || to >= selectedEffects.length) return;
    const [fx] = selectedEffects.splice(from, 1);
    selectedEffects.splice(to, 0, fx);
    renderEffectsLayer();
    renderEffectsList();
  }

  // Thumbnail row under the "Card Effects" section - lets you find and
  // delete a sticker by its GIF even when it's small, tucked behind the
  // avatar/name, or otherwise awkward to click directly on the card.
  function renderEffectsList() {
    const list = $('#edit-profile-effect-list');
    list.innerHTML = '';
    selectedEffects.forEach((fx, index) => {
      const chip = document.createElement('div');
      chip.className = `profile-effect-chip${fx.id === selectedEffectId ? ' selected' : ''}`;

      const thumb = document.createElement('img');
      thumb.src = fx.url;
      thumb.alt = '';
      chip.appendChild(thumb);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'profile-effect-chip-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        removeEffect(fx.id);
      });
      chip.appendChild(removeBtn);

      // Layer order controls: which GIF sits on top of which. Forward
      // (toward the front/visually on top) and backward (toward the back/
      // visually underneath) move the sticker later/earlier in
      // selectedEffects - see moveEffect for why that controls stacking.
      // Disabled (greyed, inert) at whichever end a sticker's already at.
      const forwardBtn = document.createElement('button');
      forwardBtn.type = 'button';
      forwardBtn.className = 'profile-effect-chip-order profile-effect-chip-order--forward';
      forwardBtn.title = 'Bring forward (on top of the next one)';
      forwardBtn.textContent = '▲';
      forwardBtn.disabled = index === selectedEffects.length - 1;
      forwardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveEffect(fx.id, 1);
      });
      chip.appendChild(forwardBtn);

      const backwardBtn = document.createElement('button');
      backwardBtn.type = 'button';
      backwardBtn.className = 'profile-effect-chip-order profile-effect-chip-order--backward';
      backwardBtn.title = 'Send backward (behind the previous one)';
      backwardBtn.textContent = '▼';
      backwardBtn.disabled = index === 0;
      backwardBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        moveEffect(fx.id, -1);
      });
      chip.appendChild(backwardBtn);

      // Clicking the thumbnail itself (not the X or order buttons) just
      // selects it on the card, so it's easy to find which sticker you're
      // about to delete or reorder.
      chip.addEventListener('click', () => {
        selectedEffectId = fx.id;
        renderEffectsLayer();
        renderEffectsList();
      });

      list.appendChild(chip);
    });
  }

  function addEffectFiles(fileList) {
    const errorEl = $('#edit-profile-effect-error');
    errorEl.textContent = '';
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const room = 8 - selectedEffects.length;
    if (room <= 0) {
      errorEl.textContent = 'You can only have up to 8 card effects';
      return;
    }
    const toAdd = files.slice(0, room);
    if (files.length > toAdd.length) {
      errorEl.textContent = 'You can only have up to 8 card effects - added as many as would fit';
    }

    toAdd.forEach((file) => {
      if (!/^image\/gif$/i.test(file.type) && !/\.gif$/i.test(file.name)) {
        errorEl.textContent = 'Please choose GIF files';
        return;
      }
      const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      Api.messages.upload(file)
        .then((data) => {
          const pos = defaultEffectPosition(selectedEffects.length);
          selectedEffects.push({ id: tempId, url: data.url, x: pos.x, y: pos.y, scale: 1, rotation: 0 });
          renderEffectsLayer();
          renderEffectsList();
        })
        .catch((err) => { errorEl.textContent = err.message; });
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
    renderSurpriseControls();
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
      mouthShapeKeys: serializeMouthEntries(selectedMouthShapeKeys),
      surpriseShapeKeys: serializeSurpriseEntries(selectedSurpriseSlots[editingSurpriseSlot]),
      surpriseEnabled: selectedSurpriseEnabled,
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
    const entries = selectedMouthShapeKeys || makeEmptyMouthEntries();
    [0, 1, 2].forEach((index) => {
      const entry = entries[index] || { name: '', intensity: 1 };
      const input = $(`#edit-profile-model-mouth-${index + 1}-shapekeys-input`);
      const slider = $(`#edit-profile-model-mouth-${index + 1}-slider`);
      const value = $(`#edit-profile-model-mouth-${index + 1}-value`);
      if (input) input.value = entry.name || '';
      if (slider) slider.value = String(entry.intensity ?? 1);
      if (value) value.textContent = `${Math.round((entry.intensity ?? 1) * 100)}%`;
    });
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
    selectedMouthShapeKeys = makeEmptyMouthEntries();
    renderLipSyncSliders();
    if (modelPreviewInstance) {
      modelPreviewInstance.setLipSyncSettings({ mouthIntensity: selectedMouthIntensity, voiceStart: selectedVoiceStart, voiceMax: selectedVoiceMax });
      modelPreviewInstance.setMouthShapeKeys(serializeMouthEntries(selectedMouthShapeKeys));
    }
  }

  // Up to 3 mouth shape keys, each with its own name + relative intensity
  // (0-1) - same pattern as applySurpriseShapeKeysFromInput()/
  // applySurpriseIntensityFromSlider() below, just without the slot concept.
  function applyMouthShapeKeysFromInput(index, value) {
    const entries = selectedMouthShapeKeys;
    entries[index] = { ...(entries[index] || { name: '', intensity: 1 }), name: value };
    if (modelPreviewInstance) modelPreviewInstance.setMouthShapeKeys(serializeMouthEntries(entries));
  }

  function applyMouthIntensityFromKeySlider(index, value) {
    const intensity = Number(value);
    const entries = selectedMouthShapeKeys;
    entries[index] = { ...(entries[index] || { name: '', intensity: 1 }), intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1 };
    renderLipSyncSliders();
    if (modelPreviewInstance) modelPreviewInstance.setMouthShapeKeys(serializeMouthEntries(entries));
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
  // default mouth-morph name list. Standard MMD mouth morphs are usually
  // named with a single bare kana character ('あ','い','う','え','お','わ') -
  // matching those as a "contains" substring (like the multi-character
  // keywords below) is too loose, since that single kana can turn up
  // inside all kinds of unrelated names (e.g. the eye morph "恐ろしい子"
  // contains "い"). Those go through MOUTH_EXACT_NAMES instead, requiring
  // an exact match; only the longer, more distinctive keywords use "contains".
  const MOUTH_EXACT_NAMES = ['あ', 'い', 'う', 'え', 'お', 'わ', 'a', 'i', 'u', 'e', 'o'];
  const MOUTH_RELATED_KEYWORDS = [
    'mouth', 'open', '口', '開', 'ω', 'にやり', 'にっこり',
    '歯', 'ぺろ', 'てへ', '口角', '口横',
  ];

  function isMouthRelatedShapeKey(name) {
    // Never double-classify something the eye filter already claims -
    // keeps the two suggestion lists mutually exclusive.
    if (isEyeRelatedShapeKey(name)) return false;
    if (SHAPE_KEY_TRANSLATIONS.mouth[name]) return true;
    if (MOUTH_EXACT_NAMES.includes(name) || MOUTH_EXACT_NAMES.includes(name.toLowerCase())) return true;
    const lower = name.toLowerCase();
    return MOUTH_RELATED_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }

  function renderShapeKeyHint(names) {
    const datalist = $('#edit-profile-model-shapekeys-datalist');
    const mouthDatalist = $('#edit-profile-model-mouth-shapekeys-datalist');
    const surpriseDatalist = $('#edit-profile-model-surprise-shapekeys-datalist');
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
    if (surpriseDatalist) {
      // Surprise can be built from any shape key on the model - eyes,
      // eyebrows, mouth, or custom ones - so unlike the blink/mouth fields
      // above, this one is intentionally left unfiltered.
      surpriseDatalist.innerHTML = '';
      names.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        const translated = translateShapeKeyName(name);
        opt.label = translated || name;
        surpriseDatalist.appendChild(opt);
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

  function makeEmptySurpriseEntries() {
    return [{ name: '', intensity: 1 }, { name: '', intensity: 1 }, { name: '', intensity: 1 }];
  }

  // Same idea as makeEmptySurpriseEntries()/normalizeSurpriseEntryList()/
  // serializeSurpriseEntries() below, but for the lip-sync mouth shape
  // keys - up to 3 entries, no "slots" concept though, since lip sync
  // only ever has one active combo (unlike the hold-click surprise
  // expression, it isn't picked per voice-command).
  function makeEmptyMouthEntries() {
    return [{ name: '', intensity: 1 }, { name: '', intensity: 1 }, { name: '', intensity: 1 }];
  }

  // Reads whatever's saved on the profile for mouth shape keys - the new
  // JSON array of up to 3 { name, intensity } entries, or the older plain
  // comma-separated shape-key-name string (pre-dates per-key intensity) -
  // and always comes back with a full 3-entry array so the rest of the UI
  // doesn't need to know which era the saved data came from.
  function parseMouthShapeKeysValue(value) {
    if (!value) return makeEmptyMouthEntries();
    if (Array.isArray(value)) return normalizeSurpriseEntryList(value);

    const trimmed = String(value).trim();
    if (!trimmed) return makeEmptyMouthEntries();
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return normalizeSurpriseEntryList(parsed);
    } catch (e) {
      // Legacy plain comma-separated shape-key-name string.
      const names = trimmed.split(',').map((s) => s.trim()).filter(Boolean);
      return normalizeSurpriseEntryList(names.map((name) => ({ name, intensity: 1 })));
    }
    return makeEmptyMouthEntries();
  }

  function serializeMouthEntries(entries) {
    const normalized = (entries || makeEmptyMouthEntries()).slice(0, 3).map((entry) => ({
      name: String(entry?.name || '').trim(),
      intensity: Number.isFinite(Number(entry?.intensity)) ? Math.min(1, Math.max(0, Number(entry.intensity))) : 1,
    })).filter((entry) => entry.name);
    return JSON.stringify(normalized);
  }

  function makeEmptySurpriseSlots() {
    return Array.from({ length: SURPRISE_SLOT_COUNT }, () => makeEmptySurpriseEntries());
  }

  function normalizeSurpriseEntryList(list) {
    const source = Array.isArray(list) ? list : [];
    return [0, 1, 2].map((index) => {
      const entry = source[index];
      if (typeof entry === 'string') return { name: entry.trim(), intensity: 1 };
      if (entry && typeof entry === 'object') {
        const intensity = Number(entry.intensity);
        return { name: String(entry.name || '').trim(), intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1 };
      }
      return { name: '', intensity: 1 };
    });
  }

  // Reads whatever's saved on the profile - the new { slots, active } format,
  // the old flat array/JSON-string of up to 3 entries from before slots
  // existed, or the even older single-shape-key-name string - and always
  // comes back with a full 5-slot structure so the rest of the UI doesn't
  // need to know which era the saved data came from.
  function parseSurpriseProfile(value) {
    const empty = () => ({ slots: makeEmptySurpriseSlots(), active: 0 });
    if (!value) return empty();

    let parsed = value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return empty();
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        // Legacy plain single shape-key-name string (pre-dates JSON entries).
        const result = empty();
        result.slots[0] = normalizeSurpriseEntryList([{ name: trimmed, intensity: 1 }]);
        return result;
      }
    }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.slots)) {
      const result = empty();
      parsed.slots.slice(0, SURPRISE_SLOT_COUNT).forEach((entries, index) => {
        result.slots[index] = normalizeSurpriseEntryList(entries);
      });
      result.active = Number.isInteger(parsed.active) && parsed.active >= 0 && parsed.active < SURPRISE_SLOT_COUNT ? parsed.active : 0;
      return result;
    }

    if (Array.isArray(parsed)) {
      // Legacy single-slot format: a flat array of up to 3 entries.
      const result = empty();
      result.slots[0] = normalizeSurpriseEntryList(parsed);
      return result;
    }

    return empty();
  }

  function serializeSurpriseEntries(entries) {
    const normalized = (entries || makeEmptySurpriseEntries()).slice(0, 3).map((entry) => ({
      name: String(entry?.name || '').trim(),
      intensity: Number.isFinite(Number(entry?.intensity)) ? Math.min(1, Math.max(0, Number(entry.intensity))) : 1,
    })).filter((entry) => entry.name);
    return JSON.stringify(normalized);
  }

  function serializeSurpriseProfile(slots, active) {
    const cleanedSlots = (slots || makeEmptySurpriseSlots()).slice(0, SURPRISE_SLOT_COUNT).map((entries) => (entries || [])
      .slice(0, 3)
      .map((entry) => ({
        name: String(entry?.name || '').trim(),
        intensity: Number.isFinite(Number(entry?.intensity)) ? Math.min(1, Math.max(0, Number(entry.intensity))) : 1,
      }))
      .filter((entry) => entry.name));
    const activeIndex = Number.isInteger(active) && active >= 0 && active < SURPRISE_SLOT_COUNT ? active : 0;
    return JSON.stringify({ slots: cleanedSlots, active: activeIndex });
  }

  // Live-previews whichever slot is currently being edited (not necessarily
  // the active one) against the 3D preview, so the user can hold-click to
  // audition a slot before committing it with "Use this slot on hold".
  function previewCurrentSurpriseSlot() {
    if (!modelPreviewInstance) return;
    const entries = selectedSurpriseSlots[editingSurpriseSlot] || makeEmptySurpriseEntries();
    modelPreviewInstance.setSurpriseShapeKeys(serializeSurpriseEntries(entries));
  }

  function renderSurpriseSlotTabs() {
    $$('.surprise-slot-tab').forEach((tab) => {
      const idx = Number(tab.dataset.slot);
      tab.classList.toggle('editing', idx === editingSurpriseSlot);
      tab.classList.toggle('is-active-slot', idx === activeSurpriseSlot);
    });
    const hint = $('#edit-profile-model-surprise-slot-hint');
    if (hint) {
      hint.textContent = editingSurpriseSlot === activeSurpriseSlot
        ? `Editing slot ${editingSurpriseSlot + 1} - this is the one everyone sees when you hold click.`
        : `Editing slot ${editingSurpriseSlot + 1} (not live yet - slot ${activeSurpriseSlot + 1} is what everyone currently sees).`;
    }
  }

  function renderSurpriseControls() {
    const entries = selectedSurpriseSlots[editingSurpriseSlot] || makeEmptySurpriseEntries();
    [0, 1, 2].forEach((index) => {
      const entry = entries[index] || { name: '', intensity: 1 };
      const input = $(`#edit-profile-model-surprise-${index + 1}-shapekeys-input`);
      const slider = $(`#edit-profile-model-surprise-${index + 1}-slider`);
      const value = $(`#edit-profile-model-surprise-${index + 1}-value`);
      if (input) input.value = entry.name || '';
      if (slider) slider.value = String(entry.intensity ?? 1);
      if (value) value.textContent = `${Math.round((entry.intensity ?? 1) * 100)}%`;
    });
    const toggle = $('#edit-profile-model-surprise-toggle');
    if (toggle) toggle.checked = selectedSurpriseEnabled;
    const body = $('#edit-profile-model-surprise-body');
    if (body) body.classList.toggle('group-disabled', !selectedSurpriseEnabled);
    renderSurpriseSlotTabs();
  }

  function switchEditingSurpriseSlot(index) {
    editingSurpriseSlot = Math.min(SURPRISE_SLOT_COUNT - 1, Math.max(0, Number(index) || 0));
    renderSurpriseControls();
    previewCurrentSurpriseSlot();
  }

  function useEditingSlotAsActive() {
    activeSurpriseSlot = editingSurpriseSlot;
    renderSurpriseSlotTabs();
  }

  function applySurpriseShapeKeysFromInput(index, value) {
    const entries = selectedSurpriseSlots[editingSurpriseSlot];
    entries[index] = { ...(entries[index] || { name: '', intensity: 1 }), name: value };
    previewCurrentSurpriseSlot();
  }

  function applySurpriseIntensityFromSlider(index, value) {
    const intensity = Number(value);
    const entries = selectedSurpriseSlots[editingSurpriseSlot];
    entries[index] = { ...(entries[index] || { name: '', intensity: 1 }), intensity: Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 1 };
    renderSurpriseControls();
    previewCurrentSurpriseSlot();
  }

  function resetSurpriseSettings() {
    selectedSurpriseSlots[editingSurpriseSlot] = makeEmptySurpriseEntries();
    renderSurpriseControls();
    previewCurrentSurpriseSlot();
  }

  function applySurpriseToggle(enabled) {
    selectedSurpriseEnabled = enabled;
    renderSurpriseControls();
    if (modelPreviewInstance) modelPreviewInstance.toggleSurprise(selectedSurpriseEnabled);
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
    selectedMouthShapeKeys = parseMouthShapeKeysValue(AppState.me.avatarModelMouthShapeKeys ?? '');
    {
      const surprise = parseSurpriseProfile(AppState.me.avatarModelSurpriseShapeKeys ?? '');
      selectedSurpriseSlots = surprise.slots;
      activeSurpriseSlot = surprise.active;
      editingSurpriseSlot = surprise.active;
    }
    selectedSurpriseEnabled = AppState.me.avatarModelSurpriseEnabled ?? true;
    selectedLookEnabled = AppState.me.avatarModelLookEnabled ?? true;
    selectedBannerUrl = AppState.me.bannerUrl || null;
    pendingBannerFile = null;
    selectedBannerZoom = AppState.me.bannerZoom ?? 1.4;
    selectedBannerOffsetX = AppState.me.bannerOffsetX ?? 0;
    selectedBannerOffsetY = AppState.me.bannerOffsetY ?? 0;
    selectedAvatarBorderStyle = AppState.me.avatarBorderStyle || 'none';
    selectedAvatarBorderColor = AppState.me.avatarBorderColor || null;
    selectedAccentColor = AppState.me.profileAccentColor || null;
    selectedEffects = (AppState.me.profileEffects || []).map((fx) => ({ ...fx }));
    selectedEffectId = null;
    $('#edit-profile-effect-error').textContent = '';
    renderPhotoPreview();
    renderBannerPreview();
    renderNameColorSwatches();
    renderBorderStyleGroup();
    renderBorderColorSwatches();
    renderAccentColorSwatches();
    renderEffectsLayer();
    renderEffectsList();
    renderModelSection();
    renderPreviewCard();
    modelPreviewMounted = false;
    switchTab('general');

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
    $('#friends-lists-panel').classList.add('hidden');
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
    } else if (!AppState.activeGroup) {
      $('#friends-lists-panel').classList.remove('hidden');
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
        avatarModelMouthShapeKeys: serializeMouthEntries(selectedMouthShapeKeys),
        avatarModelSurpriseShapeKeys: serializeSurpriseProfile(selectedSurpriseSlots, activeSurpriseSlot),
        avatarModelSurpriseEnabled: selectedSurpriseEnabled,
        avatarModelLookEnabled: selectedLookEnabled,
        bannerUrl, bannerZoom: selectedBannerZoom, bannerOffsetX: selectedBannerOffsetX, bannerOffsetY: selectedBannerOffsetY,
        avatarBorderStyle: selectedAvatarBorderStyle, avatarBorderColor: selectedAvatarBorderColor,
        profileAccentColor: selectedAccentColor,
        profileEffects: selectedEffects.map(({ url, x, y, scale, rotation }) => ({ url, x, y, scale, rotation }))
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

    $$('#edit-profile-borderstyle-group .style-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectedAvatarBorderStyle = btn.dataset.style;
        if ((selectedAvatarBorderStyle === 'solid' || selectedAvatarBorderStyle === 'glow') && !selectedAvatarBorderColor) {
          selectedAvatarBorderColor = NAME_COLORS[0];
        }
        renderBorderStyleGroup();
        renderBorderColorSwatches();
        renderPreviewCard();
      });
    });
    $('#edit-profile-bordercolor-custom').addEventListener('input', (e) => {
      selectedAvatarBorderColor = e.target.value;
      renderBorderColorSwatches();
      renderPreviewCard();
    });
    $('#edit-profile-accentcolor-custom').addEventListener('input', (e) => {
      selectedAccentColor = e.target.value;
      renderAccentColorSwatches();
      renderPreviewCard();
    });

    $('#edit-profile-effect-add-btn').addEventListener('click', () => $('#edit-profile-effect-file').click());
    $('#edit-profile-effect-file').addEventListener('change', (e) => {
      addEffectFiles(e.target.files);
      e.target.value = '';
    });
    $('#edit-profile-effects-layer').addEventListener('pointerdown', (e) => {
      if (e.target.closest('.profile-effect-sticker')) return;
      selectedEffectId = null;
      renderEffectsLayer();
      renderEffectsList();
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
      selectedMouthShapeKeys = makeEmptyMouthEntries();
      selectedSurpriseSlots = makeEmptySurpriseSlots();
      activeSurpriseSlot = 0;
      editingSurpriseSlot = 0;
      selectedSurpriseEnabled = true;
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
    $('#edit-profile-model-mouth-1-shapekeys-input').addEventListener('input', (e) => applyMouthShapeKeysFromInput(0, e.target.value));
    $('#edit-profile-model-mouth-2-shapekeys-input').addEventListener('input', (e) => applyMouthShapeKeysFromInput(1, e.target.value));
    $('#edit-profile-model-mouth-3-shapekeys-input').addEventListener('input', (e) => applyMouthShapeKeysFromInput(2, e.target.value));
    $('#edit-profile-model-mouth-1-slider').addEventListener('input', (e) => applyMouthIntensityFromKeySlider(0, e.target.value));
    $('#edit-profile-model-mouth-2-slider').addEventListener('input', (e) => applyMouthIntensityFromKeySlider(1, e.target.value));
    $('#edit-profile-model-mouth-3-slider').addEventListener('input', (e) => applyMouthIntensityFromKeySlider(2, e.target.value));
    $('#edit-profile-model-mic-test').addEventListener('click', toggleMicTest);
    $('#edit-profile-model-blink-toggle').addEventListener('change', (e) => applyBlinkToggle(e.target.checked));
    $('#edit-profile-model-blink-intensity-slider').addEventListener('input', (e) => applyBlinkIntensityFromSlider(e.target.value));
    $('#edit-profile-model-blink-min-slider').addEventListener('input', (e) => applyBlinkMinFromSlider(e.target.value));
    $('#edit-profile-model-blink-max-slider').addEventListener('input', (e) => applyBlinkMaxFromSlider(e.target.value));
    $('#edit-profile-model-blink-shapekeys-input').addEventListener('input', (e) => applyBlinkShapeKeysFromInput(e.target.value));
    $('#edit-profile-model-blink-reset').addEventListener('click', resetBlinkSettings);
    $('#edit-profile-model-surprise-1-shapekeys-input').addEventListener('input', (e) => applySurpriseShapeKeysFromInput(0, e.target.value));
    $('#edit-profile-model-surprise-2-shapekeys-input').addEventListener('input', (e) => applySurpriseShapeKeysFromInput(1, e.target.value));
    $('#edit-profile-model-surprise-3-shapekeys-input').addEventListener('input', (e) => applySurpriseShapeKeysFromInput(2, e.target.value));
    $('#edit-profile-model-surprise-1-slider').addEventListener('input', (e) => applySurpriseIntensityFromSlider(0, e.target.value));
    $('#edit-profile-model-surprise-2-slider').addEventListener('input', (e) => applySurpriseIntensityFromSlider(1, e.target.value));
    $('#edit-profile-model-surprise-3-slider').addEventListener('input', (e) => applySurpriseIntensityFromSlider(2, e.target.value));
    $('#edit-profile-model-surprise-reset').addEventListener('click', resetSurpriseSettings);
    $('#edit-profile-model-surprise-use-slot').addEventListener('click', useEditingSlotAsActive);
    $('#edit-profile-model-surprise-toggle').addEventListener('change', (e) => applySurpriseToggle(e.target.checked));
    $$('.surprise-slot-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchEditingSurpriseSlot(tab.dataset.slot));
    });
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
          selectedMouthShapeKeys = makeEmptyMouthEntries();
          selectedSurpriseSlots = makeEmptySurpriseSlots();
          activeSurpriseSlot = 0;
          editingSurpriseSlot = 0;
          selectedSurpriseEnabled = true;
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