// Settings panel for the group's shared VoiceSpeech trigger word list (the
// ⚙️ button in the voice call bar). Shared across every member of the
// group currently connected to voice - not personal to whoever opens the
// panel - so anyone can add/edit/remove words and everyone in the call
// hears the same set. Each row is a { phrase, emoji } pair; edits are
// staged in `rows` and only sent to the server on Save.
const VoiceCommandSettings = (() => {
  const { $ } = Utils;

  let rows = []; // staged edits: [{ phrase, emoji }]
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
    rows = (saved.length ? saved : VoiceSpeech.DEFAULT_TRIGGERS).map((t) => ({ phrase: t.phrase, emoji: t.emoji }));
    $('#voice-commands-error').textContent = '';
    renderRows();
    $('#modal-overlay').classList.remove('hidden');
    $('#voice-commands-modal').classList.remove('hidden');
  }

  function close() {
    $('#modal-overlay').classList.add('hidden');
    $('#voice-commands-modal').classList.add('hidden');
  }

  function renderRows() {
    const list = $('#voice-commands-list');
    list.innerHTML = '';
    if (rows.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No words yet - add one below.</div>';
      return;
    }
    rows.forEach((row, i) => {
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
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        rows.splice(i, 1);
        renderRows();
      });

      rowEl.appendChild(phraseInput);
      rowEl.appendChild(emojiInput);
      rowEl.appendChild(removeBtn);
      list.appendChild(rowEl);
    });
  }

  function addRow() {
    if (rows.length >= 15) {
      $('#voice-commands-error').textContent = 'You can only have up to 15 voice command words';
      return;
    }
    rows.push({ phrase: '', emoji: '' });
    renderRows();
    // Focus the phrase input of the row just added, so typing can start immediately
    const list = $('#voice-commands-list');
    const last = list.querySelector('.voice-commands-row:last-child input');
    if (last) last.focus();
  }

  function save() {
    const errorEl = $('#voice-commands-error');
    errorEl.textContent = '';

    if (!editingGroupId) {
      errorEl.textContent = 'Join a voice channel to edit this group\'s words';
      return;
    }

    const cleaned = rows
      .map((r) => ({ phrase: r.phrase.trim(), emoji: r.emoji.trim() }))
      .filter((r) => r.phrase || r.emoji); // drop fully-blank rows silently

    for (const r of cleaned) {
      if (!r.phrase || !r.emoji) {
        errorEl.textContent = 'Each word needs both text and an emoji';
        return;
      }
    }

    Api.groups.updateVoiceCommands(editingGroupId, cleaned)
      .then((data) => {
        // The group:updated broadcast (handled in groups.js) also patches
        // AppState.groupsData and re-applies the triggers if we're still in
        // this group's voice call, but apply them here too so Save feels
        // instant rather than waiting on our own echoed socket event.
        const idx = AppState.groupsData.findIndex((g) => g.id === data.group.id);
        if (idx !== -1) AppState.groupsData[idx] = data.group;
        if (typeof VoiceChat !== 'undefined' && VoiceChat.getConnectedGroupId() === data.group.id) {
          VoiceSpeech.setTriggers(data.group.voiceCommandTriggers);
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
