// Settings panel for the group's shared VoiceSpeech trigger word list (the
// ⚙️ button in the voice call bar). Shared across every member of the
// group currently connected to voice - not personal to whoever opens the
// panel - so anyone can add/edit/remove words (and attach a sound clip that
// plays for the whole channel), and pick which language the recognizer
// listens for, and everyone in the call hears the same set. Each row is a
// { phrase, emoji, soundUrl } object; edits (plus the language dropdown)
// are staged locally and only sent to the server on Save.
const VoiceCommandSettings = (() => {
  const { $ } = Utils;

  let rows = []; // staged edits: [{ phrase, emoji, soundUrl, soundName, uploading }]
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
      emoji: t.emoji,
      soundUrl: t.soundUrl || null,
      soundName: t.soundUrl ? soundNameFromUrl(t.soundUrl) : null,
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

      const rowEl = document.createElement('div');
      rowEl.className = 'voice-commands-row';

      const phraseInput = document.createElement('input');
      phraseInput.type = 'text';
      phraseInput.placeholder = 'word to say';
      phraseInput.maxLength = 30;
      phraseInput.value = row.phrase;
      phraseInput.addEventListener('input', () => { rows[i].phrase = phraseInput.value; });

      const emojiInput = document.createElement('input');
      emojiInput.type = 'text';
      emojiInput.placeholder = '🎉';
      emojiInput.maxLength = 8;
      emojiInput.className = 'voice-commands-emoji-input';
      emojiInput.value = row.emoji;
      emojiInput.addEventListener('input', () => { rows[i].emoji = emojiInput.value; });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'voice-commands-row-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove word';
      removeBtn.addEventListener('click', () => {
        rows.splice(i, 1);
        renderRows();
      });

      rowEl.appendChild(phraseInput);
      rowEl.appendChild(emojiInput);
      rowEl.appendChild(removeBtn);
      itemEl.appendChild(rowEl);
      itemEl.appendChild(buildSoundRow(row, i));
      list.appendChild(itemEl);
    });
  }

  // Sub-row under the phrase/emoji pair: lets a member attach (or clear) an
  // uploaded sound clip that plays for the whole voice channel, in addition
  // to the emoji, when this word is heard.
  function buildSoundRow(row, i) {
    const soundRow = document.createElement('div');
    soundRow.className = 'voice-commands-sound-row';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.className = 'hidden';

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'voice-commands-sound-btn';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) uploadSound(file, i);
    });
    uploadBtn.addEventListener('click', () => fileInput.click());

    const statusEl = document.createElement('span');
    statusEl.className = 'voice-commands-sound-status';

    if (row.uploading) {
      uploadBtn.textContent = '⏳ Uploading…';
      uploadBtn.disabled = true;
    } else if (row.soundUrl) {
      uploadBtn.textContent = '🔊 Replace Sound';
      statusEl.textContent = row.soundName || 'Sound attached';
    } else {
      uploadBtn.textContent = '🔊 Add Sound';
      statusEl.textContent = 'Plays for the whole voice channel when heard';
    }

    soundRow.appendChild(fileInput);
    soundRow.appendChild(uploadBtn);
    soundRow.appendChild(statusEl);

    if (row.soundUrl && !row.uploading) {
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'voice-commands-sound-play';
      playBtn.title = 'Preview';
      playBtn.textContent = '▶';
      playBtn.addEventListener('click', () => {
        try { new Audio(row.soundUrl).play(); } catch (err) { /* ignore preview failures */ }
      });

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

      soundRow.appendChild(playBtn);
      soundRow.appendChild(clearBtn);
    }

    return soundRow;
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
    rows.push({ phrase: '', emoji: '', soundUrl: null, soundName: null, uploading: false });
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
      .map((r) => ({ phrase: r.phrase.trim(), emoji: r.emoji.trim(), soundUrl: r.soundUrl || null }))
      .filter((r) => r.phrase || r.emoji || r.soundUrl); // drop fully-blank rows silently

    for (const r of cleaned) {
      if (!r.phrase || !r.emoji) {
        errorEl.textContent = 'Each word needs both text and an emoji';
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
