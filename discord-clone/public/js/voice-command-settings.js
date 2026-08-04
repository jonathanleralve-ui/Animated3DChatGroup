// Settings panel for the group's shared VoiceSpeech trigger word list (the
// ⚙️ button in the voice call bar). Shared across every member of the
// group currently connected to voice - not personal to whoever opens the
// panel - so anyone can add/edit/remove words (and attach a sound clip that
// plays for the whole channel), and pick which language the recognizer
// listens for, and everyone in the call hears the same set. Each row is a
// { phrase, soundUrl } object - no icon, just the word and its sound; edits
// (plus the language dropdown) are staged locally and only sent to the
// server on Save. avatarReaction, toggled per-row with the 😮 button, makes
// saying that word also pulse the hold/surprise expression on the
// speaker's own avatar - see pulseAvatarReaction() in voice.js. reactionSlot
// picks *which* saved slot (see Edit Profile's slot tabs) to use for that -
// left as "Active slot" (null) it just mirrors whatever's normally live.
const VoiceCommandSettings = (() => {
  const { $ } = Utils;

  // Matches SURPRISE_SLOT_COUNT in profile.js / groups.js - fixed at 5
  // since the slot picker here is just "which of your saved slots" and
  // doesn't need to know what any particular user actually has configured.
  const SURPRISE_SLOT_COUNT = 5;

  let rows = []; // staged edits: [{ phrase, soundUrl, soundName, uploading }]
  let editingGroupId = null; // which group's shared list we're editing

  function currentGroup() {
    if (!editingGroupId || typeof AppState === 'undefined' || !AppState.groupsData) return null;
    return AppState.groupsData.find((g) => g.id === editingGroupId) || null;
  }

  function open() {
    editingGroupId = (typeof VoiceChat !== 'undefined') ? VoiceChat.getConnectedGroupId() : null;
    if (!editingGroupId) return; // panel only makes sense while connected to a voice channel

    const group = currentGroup();
    const saved = (group && group.voiceCommandTriggers) || [];
    rows = (saved.length ? saved : VoiceSpeech.DEFAULT_TRIGGERS).map((t) => ({
      phrase: t.phrase,
      soundUrl: t.soundUrl || null,
      soundName: t.soundUrl ? soundNameFromUrl(t.soundUrl) : null,
      avatarReaction: !!t.avatarReaction,
      reactionSlot: Number.isInteger(t.reactionSlot) ? t.reactionSlot : null,
      uploading: false
    }));
    $('#voice-commands-language').value = (group && group.voiceCommandLanguage) || 'en-US';
    $('#voice-commands-error').textContent = '';
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

  function renderRows() {
    const list = $('#voice-commands-list');
    list.innerHTML = '';
    if (rows.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No words yet - add one below.</div>';
      return;
    }
    rows.forEach((row, i) => {
      const itemEl = document.createElement('div');
      itemEl.className = 'voice-commands-item';
      itemEl.appendChild(buildRow(row, i));
      list.appendChild(itemEl);
    });
  }

  // A single row: just the word to say and its sound clip, side by side -
  // no icon, no extra label text.
  function buildRow(row, i) {
    const rowEl = document.createElement('div');
    rowEl.className = 'voice-commands-row';

    const phraseInput = document.createElement('input');
    phraseInput.type = 'text';
    phraseInput.placeholder = 'word to say';
    phraseInput.maxLength = 30;
    phraseInput.value = row.phrase;
    phraseInput.addEventListener('input', () => { rows[i].phrase = phraseInput.value; });
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

    // Toggles whether saying this word also pulses the "hold" surprise
    // expression on the speaker's own avatar (same effect as pressing and
    // holding the mouse on it) - independent of the sound clip, so a word
    // can play a sound, react, both, or neither.
    const reactionBtn = document.createElement('button');
    reactionBtn.type = 'button';
    reactionBtn.className = 'voice-commands-reaction-btn' + (row.avatarReaction ? ' active' : '');
    reactionBtn.title = row.avatarReaction ? 'Avatar reacts when said (click to turn off)' : 'Avatar reacts when said (click to turn on)';
    reactionBtn.textContent = '😮';
    reactionBtn.addEventListener('click', () => {
      rows[i].avatarReaction = !rows[i].avatarReaction;
      renderRows();
    });
    rowEl.appendChild(reactionBtn);

    // Which saved slot (see Edit Profile's slot tabs) that reaction should
    // use - only meaningful, and only shown, once React is toggled on.
    // "Active slot" (null) just mirrors whatever's normally live, same as
    // a plain mouse-hold - the rest let the word force a specific one.
    if (row.avatarReaction) {
      const slotSelect = document.createElement('select');
      slotSelect.className = 'voice-commands-slot-select';
      slotSelect.title = 'Which saved expression slot this word triggers';
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
        rows[i].reactionSlot = slotSelect.value === '' ? null : Number(slotSelect.value);
      });
      rowEl.appendChild(slotSelect);
    }

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
        rows[i].soundUrl = null;
        rows[i].soundName = null;
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
      rows.splice(i, 1);
      renderRows();
    });
    rowEl.appendChild(removeBtn);

    return rowEl;
  }

  function uploadSound(file, i) {
    const errorEl = $('#voice-commands-error');
    errorEl.textContent = '';

    if (!SOUND_MIME_RE.test(file.type) && !SOUND_EXT_RE.test(file.name)) {
      errorEl.textContent = 'Please choose an audio file (mp3, wav, ogg, m4a...)';
      return;
    }

    rows[i].uploading = true;
    renderRows();

    Api.messages.upload(file)
      .then((data) => {
        rows[i].soundUrl = data.url;
        rows[i].soundName = soundNameFromUrl(data.url);
      })
      .catch((err) => { errorEl.textContent = err.message; })
      .finally(() => {
        rows[i].uploading = false;
        renderRows();
      });
  }

  function addRow() {
    if (rows.length >= 15) {
      $('#voice-commands-error').textContent = 'You can only have up to 15 voice command words';
      return;
    }
    rows.push({ phrase: '', soundUrl: null, soundName: null, avatarReaction: false, reactionSlot: null, uploading: false });
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
      errorEl.textContent = 'Join a voice channel to edit this group\'s words';
      return;
    }

    if (rows.some((r) => r.uploading)) {
      errorEl.textContent = 'Wait for the sound upload to finish first';
      return;
    }

    const cleaned = rows
      .map((r) => ({
        phrase: r.phrase.trim(),
        soundUrl: r.soundUrl || null,
        avatarReaction: !!r.avatarReaction,
        reactionSlot: r.avatarReaction && Number.isInteger(r.reactionSlot) ? r.reactionSlot : null
      }))
      .filter((r) => r.phrase || r.soundUrl); // drop fully-blank rows silently

    for (const r of cleaned) {
      if (!r.phrase) {
        errorEl.textContent = 'Each row needs a word';
        return;
      }
    }

    const language = $('#voice-commands-language').value || 'en-US';

    Api.groups.updateVoiceCommands(editingGroupId, cleaned, language)
      .then((data) => {
        // The group:updated broadcast (handled in groups.js) also patches
        // AppState.groupsData and re-applies the triggers if we're still in
        // this group's voice call, but apply them here too so Save feels
        // instant rather than waiting on our own echoed socket event.
        const idx = AppState.groupsData.findIndex((g) => g.id === data.group.id);
        if (idx !== -1) AppState.groupsData[idx] = data.group;
        if (typeof VoiceChat !== 'undefined' && VoiceChat.getConnectedGroupId() === data.group.id) {
          VoiceSpeech.setTriggers(data.group.voiceCommandTriggers);
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
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay') && !$('#voice-commands-modal').classList.contains('hidden')) {
        close();
      }
    });
  }

  return { initUI };
})();
