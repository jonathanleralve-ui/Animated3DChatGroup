// Settings panel for voice-command trigger words (the ⚙️ button in the
// voice call bar). Split into two tabs:
//
//  - PUBLIC: the group's shared word list - just a word + a sound clip.
//    Shared across every member of the group currently connected to voice
//    (not personal to whoever opens the panel), so anyone can add/edit/
//    remove words, and everyone in the call hears the same set and the
//    same sound. Saved to the server on the group (group.voiceCommandTriggers).
//
//  - PRIVATE: this user's own personal word list - a word + a sound clip +
//    which saved avatar-reaction slot (see Edit Profile's slot tabs) it
//    fires. Only ever visible/editable by the person who set it up (stored
//    in this browser's localStorage, keyed by user + group - never sent to
//    the server or to other members), but the *effect* of saying it is
//    not private at all: it pulses the same hold/surprise expression on
//    your own avatar as a Public reaction would, which is broadcast live
//    to everyone else in the call exactly like any other avatar reaction
//    (see pulseAvatarReaction() in voice.js) - so other members do see the
//    reaction, they just can't see or edit the word/slot that caused it.
//
// The listening language dropdown is a single group-wide setting (the
// recognizer only understands one language per session) and applies to
// both tabs' words.
const VoiceCommandSettings = (() => {
  const { $ } = Utils;

  // Matches SURPRISE_SLOT_COUNT in profile.js / groups.js - fixed at 5
  // since the slot picker here is just "which of your saved slots" and
  // doesn't need to know what any particular user actually has configured.
  const SURPRISE_SLOT_COUNT = 5;
  const MAX_ROWS_PER_TAB = 15;

  let activeTab = 'public'; // 'public' | 'private'
  let publicRows = []; // staged edits: [{ phrase, soundUrl, soundName, uploading }]
  let privateRows = []; // staged edits: [{ phrase, soundUrl, soundName, reactionSlot, uploading }]
  let editingGroupId = null; // which group's shared list (and whose-scoped private list) we're editing

  function currentGroup() {
    if (!editingGroupId || typeof AppState === 'undefined' || !AppState.groupsData) return null;
    return AppState.groupsData.find((g) => g.id === editingGroupId) || null;
  }

  function activeRows() {
    return activeTab === 'private' ? privateRows : publicRows;
  }

  // ---- Private list storage (localStorage, scoped to this browser + user + group) ----

  function privateStorageKey(groupId) {
    const uid = (typeof AppState !== 'undefined' && AppState.me) ? AppState.me.id : 'anon';
    return `voice-private-triggers:${uid}:${groupId}`;
  }

  // Reads and sanitizes this user's saved private list for a group. Safe to
  // call with no panel open - used by voice.js at join-time to feed
  // VoiceSpeech.setPrivateTriggers().
  function getPrivateTriggers(groupId) {
    if (!groupId) return [];
    try {
      const raw = localStorage.getItem(privateStorageKey(groupId));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim())
        .map((t) => ({
          phrase: t.phrase,
          soundUrl: typeof t.soundUrl === 'string' ? t.soundUrl : null,
          reactionSlot: Number.isInteger(t.reactionSlot) ? t.reactionSlot : null
        }));
    } catch (err) {
      return []; // corrupt/blocked storage shouldn't break voice chat
    }
  }

  function savePrivateTriggers(groupId, list) {
    try {
      localStorage.setItem(privateStorageKey(groupId), JSON.stringify(list));
    } catch (err) {
      // storage full/blocked (private browsing etc.) - edits just won't persist across reload
    }
  }

  function open() {
    editingGroupId = (typeof VoiceChat !== 'undefined') ? VoiceChat.getConnectedGroupId() : null;
    if (!editingGroupId) return; // panel only makes sense while connected to a voice channel

    const group = currentGroup();
    const savedPublic = (group && group.voiceCommandTriggers) || [];
    publicRows = (savedPublic.length ? savedPublic : VoiceSpeech.DEFAULT_TRIGGERS).map((t) => ({
      phrase: t.phrase,
      soundUrl: t.soundUrl || null,
      soundName: t.soundUrl ? soundNameFromUrl() : null,
      uploading: false
    }));

    privateRows = getPrivateTriggers(editingGroupId).map((t) => ({
      phrase: t.phrase,
      soundUrl: t.soundUrl || null,
      soundName: t.soundUrl ? soundNameFromUrl() : null,
      reactionSlot: t.reactionSlot,
      uploading: false
    }));

    activeTab = 'public';
    $('#voice-commands-language').value = (group && group.voiceCommandLanguage) || 'en-US';
    $('#voice-commands-error').textContent = '';
    renderTabs();
    renderRows();
    $('#modal-overlay').classList.remove('hidden');
    $('#voice-commands-modal').classList.remove('hidden');
  }

  function close() {
    $('#modal-overlay').classList.add('hidden');
    $('#voice-commands-modal').classList.add('hidden');
  }

  // Uploaded sound URLs are random server-generated names (see
  // routes/upload.js), so there's no original filename to show - just label
  // it generically rather than displaying an ugly hash.
  function soundNameFromUrl() {
    return 'Sound attached';
  }

  const SOUND_MIME_RE = /^audio\//i;
  const SOUND_EXT_RE = /\.(mp3|wav|ogg|m4a|webm|aac|flac)$/i;

  function switchTab(tab) {
    if (tab === activeTab) return;
    activeTab = tab;
    renderTabs();
    renderRows();
  }

  function renderTabs() {
    const publicBtn = $('#voice-commands-tab-public');
    const privateBtn = $('#voice-commands-tab-private');
    publicBtn.classList.toggle('active', activeTab === 'public');
    privateBtn.classList.toggle('active', activeTab === 'private');

    $('#voice-commands-tab-hint').textContent = activeTab === 'public'
      ? "Shared with everyone in this group. Say one of these while connected to a voice channel here and it'll play the attached sound clip for the whole channel. Any member can edit this list."
      : "Only visible to you - stored on this device, not shared or editable by anyone else. Pick which saved expression slot each word triggers on your avatar; saying it still shows that reaction to everyone else in the call, same as a public one would.";
  }

  function renderRows() {
    const list = $('#voice-commands-list');
    list.innerHTML = '';
    const rows = activeRows();
    if (rows.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No words yet - add one below.</div>';
      return;
    }
    rows.forEach((row, i) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'voice-commands-item';
      itemEl.appendChild(activeTab === 'private' ? buildPrivateRow(row, i) : buildPublicRow(row, i));
      list.appendChild(itemEl);
    });
  }

  // Pieces shared by both row builders: the phrase input, the hidden file
  // input + upload button, and the preview/clear/remove buttons at the
  // end. Returns { rowEl, fileInput } so each builder can slot in its own
  // middle bits (reaction slot picker, etc.) between the sound button and
  // the trailing preview/remove buttons.
  function buildRowShell(row, i) {
    const rowEl = document.createElement('div');
    rowEl.className = 'voice-commands-row';

    const phraseInput = document.createElement('input');
    phraseInput.type = 'text';
    phraseInput.placeholder = 'word to say';
    phraseInput.maxLength = 30;
    phraseInput.value = row.phrase;
    phraseInput.addEventListener('input', () => { activeRows()[i].phrase = phraseInput.value; });
    rowEl.appendChild(phraseInput);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.className = 'hidden';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) uploadSound(file, i);
    });
    rowEl.appendChild(fileInput);

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'voice-commands-sound-btn';
    uploadBtn.title = row.soundUrl ? 'Replace sound' : 'Add sound';
    if (row.uploading) {
      uploadBtn.textContent = '⏳';
      uploadBtn.disabled = true;
    } else {
      uploadBtn.textContent = row.soundUrl ? '🔊' : '🔈';
    }
    uploadBtn.addEventListener('click', () => fileInput.click());
    rowEl.appendChild(uploadBtn);

    return { rowEl, fileInput };
  }

  function appendTrailingButtons(rowEl, row, i) {
    if (row.soundUrl && !row.uploading) {
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'voice-commands-sound-play';
      playBtn.title = 'Preview';
      playBtn.textContent = '▶';
      playBtn.addEventListener('click', () => {
        try { new Audio(row.soundUrl).play(); } catch (err) { /* ignore preview failures */ }
      });
      rowEl.appendChild(playBtn);

      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'voice-commands-sound-clear';
      clearBtn.title = 'Remove sound';
      clearBtn.textContent = '✕';
      clearBtn.addEventListener('click', () => {
        activeRows()[i].soundUrl = null;
        activeRows()[i].soundName = null;
        renderRows();
      });
      rowEl.appendChild(clearBtn);
    }

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'voice-commands-row-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove word';
    removeBtn.addEventListener('click', () => {
      activeRows().splice(i, 1);
      renderRows();
    });
    rowEl.appendChild(removeBtn);
  }

  // Public row: just the word and its sound clip, side by side - no icon,
  // no reaction controls (those live exclusively on the Private tab now).
  function buildPublicRow(row, i) {
    const { rowEl } = buildRowShell(row, i);
    appendTrailingButtons(rowEl, row, i);
    return rowEl;
  }

  // Private row: word, sound clip, and which saved expression slot (see
  // Edit Profile's slot tabs) saying it pulses on your own avatar - always
  // on, since reacting is the whole point of keeping a word private.
  // "Active slot" (blank) just mirrors whatever's normally live, same as a
  // plain mouse-hold; the rest force a specific one.
  function buildPrivateRow(row, i) {
    const { rowEl } = buildRowShell(row, i);

    const slotSelect = document.createElement('select');
    slotSelect.className = 'voice-commands-slot-select';
    slotSelect.title = 'Which saved expression slot this word triggers on your avatar';
    const activeOpt = document.createElement('option');
    activeOpt.value = '';
    activeOpt.textContent = 'Active slot';
    slotSelect.appendChild(activeOpt);
    for (let s = 0; s < SURPRISE_SLOT_COUNT; s += 1) {
      const opt = document.createElement('option');
      opt.value = String(s);
      opt.textContent = `Slot ${s + 1}`;
      slotSelect.appendChild(opt);
    }
    slotSelect.value = Number.isInteger(row.reactionSlot) ? String(row.reactionSlot) : '';
    slotSelect.addEventListener('change', () => {
      privateRows[i].reactionSlot = slotSelect.value === '' ? null : Number(slotSelect.value);
    });
    rowEl.appendChild(slotSelect);

    appendTrailingButtons(rowEl, row, i);
    return rowEl;
  }

  function uploadSound(file, i) {
    const errorEl = $('#voice-commands-error');
    errorEl.textContent = '';

    if (!SOUND_MIME_RE.test(file.type) && !SOUND_EXT_RE.test(file.name)) {
      errorEl.textContent = 'Please choose an audio file (mp3, wav, ogg, m4a...)';
      return;
    }

    const rows = activeRows();
    rows[i].uploading = true;
    renderRows();

    Api.messages.upload(file)
      .then((data) => {
        rows[i].soundUrl = data.url;
        rows[i].soundName = soundNameFromUrl();
      })
      .catch((err) => { errorEl.textContent = err.message; })
      .finally(() => {
        rows[i].uploading = false;
        renderRows();
      });
  }

  function addRow() {
    const rows = activeRows();
    if (rows.length >= MAX_ROWS_PER_TAB) {
      $('#voice-commands-error').textContent = `You can only have up to ${MAX_ROWS_PER_TAB} voice command words`;
      return;
    }
    if (activeTab === 'private') {
      rows.push({ phrase: '', soundUrl: null, soundName: null, reactionSlot: null, uploading: false });
    } else {
      rows.push({ phrase: '', soundUrl: null, soundName: null, uploading: false });
    }
    renderRows();
    // Focus the phrase input of the row just added, so typing can start immediately
    const list = $('#voice-commands-list');
    const last = list.querySelector('.voice-commands-item:last-child input[type="text"]');
    if (last) last.focus();
  }

  function save() {
    const errorEl = $('#voice-commands-error');
    errorEl.textContent = '';

    if (!editingGroupId) {
      errorEl.textContent = 'Join a voice channel to edit these words';
      return;
    }

    if (publicRows.some((r) => r.uploading) || privateRows.some((r) => r.uploading)) {
      errorEl.textContent = 'Wait for the sound upload to finish first';
      return;
    }

    const cleanedPublic = publicRows
      .map((r) => ({ phrase: r.phrase.trim(), soundUrl: r.soundUrl || null }))
      .filter((r) => r.phrase || r.soundUrl); // drop fully-blank rows silently

    const cleanedPrivate = privateRows
      .map((r) => ({
        phrase: r.phrase.trim(),
        soundUrl: r.soundUrl || null,
        reactionSlot: Number.isInteger(r.reactionSlot) ? r.reactionSlot : null
      }))
      .filter((r) => r.phrase || r.soundUrl);

    for (const r of cleanedPublic.concat(cleanedPrivate)) {
      if (!r.phrase) {
        errorEl.textContent = 'Each row needs a word';
        return;
      }
    }

    const language = $('#voice-commands-language').value || 'en-US';

    Api.groups.updateVoiceCommands(editingGroupId, cleanedPublic, language)
      .then((data) => {
        // The group:updated broadcast (handled in groups.js) also patches
        // AppState.groupsData and re-applies the public triggers if we're
        // still in this group's voice call, but apply them here too so
        // Save feels instant rather than waiting on our own echoed socket
        // event.
        const idx = AppState.groupsData.findIndex((g) => g.id === data.group.id);
        if (idx !== -1) AppState.groupsData[idx] = data.group;

        // Private list never touches the server - just this browser's
        // storage, scoped to this user and group.
        savePrivateTriggers(editingGroupId, cleanedPrivate);

        if (typeof VoiceChat !== 'undefined' && VoiceChat.getConnectedGroupId() === data.group.id) {
          VoiceSpeech.setTriggers(data.group.voiceCommandTriggers);
          VoiceSpeech.setPrivateTriggers(cleanedPrivate);
          VoiceSpeech.setLanguage(data.group.voiceCommandLanguage);
        }
        close();
      })
      .catch((err) => { errorEl.textContent = err.message; });
  }

  function initUI() {
    $('#voice-settings-btn').addEventListener('click', open);
    $('#voice-commands-close').addEventListener('click', close);
    $('#voice-commands-cancel').addEventListener('click', close);
    $('#voice-commands-add').addEventListener('click', addRow);
    $('#voice-commands-save').addEventListener('click', save);
    $('#voice-commands-tab-public').addEventListener('click', () => switchTab('public'));
    $('#voice-commands-tab-private').addEventListener('click', () => switchTab('private'));
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay') && !$('#voice-commands-modal').classList.contains('hidden')) {
        close();
      }
    });
  }

  return { initUI, getPrivateTriggers };
})();