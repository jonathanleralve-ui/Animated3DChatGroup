// The message pane: opening a DM or text channel, loading history, sending
// new messages, and reacting to realtime message/typing events from
// SocketClient.
const Chat = (() => {
  const { $, escapeHtml, initials, formatTime, avatarEl, linkifyText, isEmojiOnly } = Utils;

  let typingTimeout = null;
  // Who's currently typing, per chat: 'dm-<id>' or 'channel-<id>' -> Map(userId -> { name, timer })
  const typingUsers = {};
  let pendingFile = null;
  let pendingFileUrl = null;

  // History pagination state for the currently open chat. Reset every time
  // a new DM/channel is opened in openChatWindow -> loadHistory.
  let oldestLoadedMessageId = null;
  let hasMoreHistory = false;
  let isLoadingOlderMessages = false;
  // 'append' = new/initial messages go to the bottom (default). 'prepend' =
  // an older-history page is being spliced in at the top, so render
  // functions insert at the top and skip the auto-scroll-to-bottom.
  let insertMode = 'append';
  const MAX_UPLOAD_MB = 1024;
  const TOAST_DURATION_MS = 6000;

  // Popup shown top-right when a DM arrives for a conversation the user
  // isn't currently looking at — same idea as Discord's incoming-message
  // toast. Clicking it opens the DM; otherwise it dismisses itself.
  function showDmToast(msg) {
    const container = $('#dm-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'dm-toast';

    const av = avatarEl({
      displayName: msg.senderName,
      avatarColor: msg.senderColor,
      avatarUrl: msg.senderAvatarUrl
    });
    toast.appendChild(av);

    const body = document.createElement('div');
    body.className = 'dm-toast-body';
    const previewText = msg.messageType === 'group_invite'
      ? `Invited you to join ${msg.groupInvite && msg.groupInvite.groupName ? msg.groupInvite.groupName : 'a server'}`
      : (msg.attachment ? `📎 ${msg.attachment.name}` : msg.content);
    body.innerHTML = `
      <div class="dm-toast-name">${escapeHtml(msg.senderName)}</div>
      <div class="dm-toast-preview">${escapeHtml(previewText)}</div>
    `;
    toast.appendChild(body);

    let dismissTimer = null;
    function dismiss() {
      if (!toast.parentNode) return;
      clearTimeout(dismissTimer);
      toast.classList.add('leaving');
      setTimeout(() => toast.remove(), 200);
    }

    toast.addEventListener('click', () => {
      openDM({ id: msg.senderId, displayName: msg.senderName, avatarColor: msg.senderColor });
      dismiss();
    });

    container.appendChild(toast);
    dismissTimer = setTimeout(dismiss, TOAST_DURATION_MS);
  }

  function openDM(friend) {
    AppState.activeGroup = null;
    AppState.activeChat = { type: 'dm', id: friend.id, name: friend.displayName, color: friend.avatarColor };
    App.setActiveRail($('#rail-home'));
    Groups.clearDmUnread(friend.id);
    Friends.clearSenderTabUnread(friend.id);
    $('#sidebar-header').textContent = 'Friends';
    $('#group-panel').classList.add('hidden');
    $('#friends-panel').classList.remove('hidden');
    VoiceChat.refreshPanelForGroup(null);
    openChatWindow();
  }

  function openChannel(channel) {
    AppState.activeChat = {
      type: 'channel',
      id: channel.id,
      name: channel.name,
      groupId: channel.groupId
    };
    Groups.clearGroupUnread(channel.groupId);
    Groups.clearChannelUnread(channel.id);
    if (AppState.socket) AppState.socket.emit('channel:join', channel.id);
    openChatWindow();
    Groups.refreshChannelHighlight();
  }

  function openChatWindow() {
    const chat = AppState.activeChat;
    const panel = $('#chat-panel');
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#friends-lists-panel').classList.add('hidden');
    panel.classList.remove('hidden');

    const titleText = chat.type === 'dm' ? `@${chat.name}` : `# ${chat.name}`;
    $('#chat-title').textContent = titleText;
    $('#chat-popup-title').textContent = titleText;

    // DMs and channel chats both live embedded in the main chat area now.
    panel.classList.remove('dm-popup');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.transform = '';

    $('#chat-messages').innerHTML = '';
    const typingEl = $('#typing-indicator');
    typingEl.innerHTML = '';
    typingEl.classList.remove('visible');
    loadHistory();
    $('#chat-input').value = '';
    $('#chat-input').focus();
    clearPendingFile();
  }

  function loadHistory() {
    const chat = AppState.activeChat;
    oldestLoadedMessageId = null;
    hasMoreHistory = false;
    isLoadingOlderMessages = false;
    const request = chat.type === 'dm' ? Api.messages.dmHistory(chat.id) : Api.messages.channelHistory(chat.id);
    request.then((data) => {
      $('#chat-messages').innerHTML = '';
      data.messages.forEach((m) => appendMessage(m));
      scrollToBottom();
      oldestLoadedMessageId = data.messages.length ? data.messages[0].id : null;
      hasMoreHistory = !!data.hasMore;
    }).catch((err) => {
      $('#chat-messages').innerHTML = `<div class="empty-list-hint">${escapeHtml(err.message)}</div>`;
    });
  }

  // Called when the user scrolls near the top of the message pane. Fetches
  // the next page of older messages (before the oldest one currently
  // rendered) and splices it in above the existing history without moving
  // the messages already on screen.
  function loadOlderMessages() {
    const chat = AppState.activeChat;
    if (!chat || isLoadingOlderMessages || !hasMoreHistory || oldestLoadedMessageId == null) return;
    isLoadingOlderMessages = true;

    const request = chat.type === 'dm'
      ? Api.messages.dmHistory(chat.id, oldestLoadedMessageId)
      : Api.messages.channelHistory(chat.id, oldestLoadedMessageId);

    request.then((data) => {
      hasMoreHistory = !!data.hasMore;
      if (!data.messages.length) return;

      const list = $('#chat-messages');
      const previousScrollHeight = list.scrollHeight;
      const previousScrollTop = list.scrollTop;

      // data.messages is oldest-to-newest for this page; insert in reverse
      // so each insertBefore(firstChild) lands them in the right final order.
      insertMode = 'prepend';
      for (let i = data.messages.length - 1; i >= 0; i--) {
        appendMessage(data.messages[i]);
      }
      insertMode = 'append';

      // Keep whatever the user was looking at anchored in place instead of
      // jumping around as content gets added above it.
      list.scrollTop = previousScrollTop + (list.scrollHeight - previousScrollHeight);

      oldestLoadedMessageId = data.messages[0].id;
    }).catch((err) => {
      console.error('Failed to load older messages:', err);
    }).finally(() => {
      isLoadingOlderMessages = false;
    });
  }

  // Route a rendered row to the top (older-history splice) or bottom
  // (normal new/initial message) of the list depending on insertMode.
  function insertRow(list, row) {
    if (insertMode === 'prepend') {
      list.insertBefore(row, list.firstChild);
    } else {
      list.appendChild(row);
    }
  }

  // Auto-scroll only makes sense when we just added something at the
  // bottom; skip it while splicing older history in above the fold.
  function maybeScrollToBottom() {
    if (insertMode !== 'prepend') scrollToBottom();
  }

  function appendMessage(m) {
    if (m.messageType === 'join_request') {
      appendJoinRequestMessage(m);
      return;
    }
    if (m.messageType === 'group_invite') {
      appendGroupInviteMessage(m);
      return;
    }
    if (m.messageType === 'system') {
      appendSystemMessage(m);
      return;
    }

    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = `message-row ${m.senderId === AppState.me.id ? 'own' : ''}`;
    row.dataset.messageId = m.id;

    const av = avatarEl({
      displayName: m.senderName,
      avatarColor: m.senderColor,
      avatarUrl: m.senderAvatarUrl
    });
    row.appendChild(av);

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = `
      <div class="message-head">
        <span class="message-author">${escapeHtml(m.senderName)}</span>
        <span class="message-time">${formatTime(m.createdAt)}</span>
      </div>
      <div class="message-content"></div>
    `;
    if (m.content) {
      const contentEl = body.querySelector('.message-content');
      if (isEmojiOnly(m.content)) contentEl.classList.add('emoji-only');
      const embedUrl = linkifyText(contentEl, m.content);
      if (embedUrl) body.appendChild(renderVideoEmbed(embedUrl));
    }
    if (m.attachment) body.appendChild(renderAttachment(m.attachment));
    if (m.senderNameColor && /^#[0-9a-fA-F]{6}$/.test(m.senderNameColor)) {
      body.querySelector('.message-author').style.color = m.senderNameColor;
    }
    row.appendChild(body);

    // Own message, whatever it contains (text, image, video, or any other
    // file attachment) — same delete affordance either way.
    if (m.senderId === AppState.me.id) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'message-delete-btn';
      delBtn.title = 'Delete message';
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', () => deleteMessage(m.id));
      row.appendChild(delBtn);
    }

    insertRow(list, row);
    maybeScrollToBottom();
  }

  function deleteMessage(messageId) {
    if (!AppState.socket) return;
    if (!confirm('Delete this message? This cannot be undone.')) return;
    AppState.socket.emit('message:delete', { messageId });
  }

  function handleMessageDeleted(messageId) {
    const row = document.querySelector(`.message-row[data-message-id="${messageId}"]`);
    if (row) row.remove();
  }

  function appendSystemMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row system-message-row';
    row.innerHTML = `
      <div class="system-message-line">
        <span class="system-message-icon">•</span>
        <span class="system-message-text">${escapeHtml(m.content)}</span>
        <span class="message-time">${formatTime(m.createdAt)}</span>
      </div>
    `;
    insertRow(list, row);
    maybeScrollToBottom();
  }

  function appendJoinRequestMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row join-request-row';
    row.dataset.requestId = m.joinRequest.id;

    const av = avatarEl({
      displayName: m.senderName,
      avatarColor: m.senderColor,
      avatarUrl: m.senderAvatarUrl
    });
    row.appendChild(av);

    // The card is only ever shown inside the group being requested, so pull
    // the server name/color and the current channel name from local state
    // rather than the message payload.
    const group = AppState.activeGroup;
    const groupName = group ? group.name : 'this server';
    const groupColor = group ? group.iconColor : 'var(--blurple)';
    const groupIconUrl = group ? group.iconUrl : null;
    const channel = AppState.activeGroupChannels.find((c) => c.id === m.channelId);
    const channelName = channel ? channel.name : (AppState.activeChat ? AppState.activeChat.name : 'general');
    const isMe = m.senderId === AppState.me.id;

    const groupIconInner = groupIconUrl
      ? `<img src="${escapeHtml(groupIconUrl)}" alt="${escapeHtml(groupName)}">`
      : escapeHtml(initials(groupName));

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = `
      <div class="invite-card">
        <div class="invite-card-label">${isMe ? 'You sent an invite to join a server' : `${escapeHtml(m.senderName)} wants to join a server`}</div>
        <div class="invite-card-body">
          <div class="invite-card-icon" style="background: ${groupColor}">${groupIconInner}</div>
          <div class="invite-card-info">
            <div class="invite-card-server-name">${escapeHtml(groupName)}</div>
            <div class="invite-card-channel"># ${escapeHtml(channelName)}</div>
          </div>
          <button type="button" class="btn-invite-accept join-request-accept-btn">Accept</button>
          <button type="button" class="btn-invite-decline join-request-decline-btn">Decline</button>
          <span class="join-request-resolved-label hidden">Accepted ✓</span>
          <span class="join-request-declined-label hidden">Declined ✕</span>
        </div>
      </div>
    `;
    row.appendChild(body);
    insertRow(list, row);

    applyJoinRequestState(row, m.joinRequest);

    body.querySelector('.join-request-accept-btn').addEventListener('click', () => {
      const btn = body.querySelector('.join-request-accept-btn');
      btn.disabled = true;
      btn.textContent = 'Accepting...';
      Api.groups.acceptJoinRequest(m.joinRequest.groupId, m.joinRequest.id)
        .then(() => applyJoinRequestState(row, { status: 'accepted' }))
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = 'Accept';
          alert(err.message);
        });
    });

    body.querySelector('.join-request-decline-btn').addEventListener('click', () => {
      const btn = body.querySelector('.join-request-decline-btn');
      btn.disabled = true;
      btn.textContent = 'Declining...';
      Api.groups.declineJoinRequest(m.joinRequest.groupId, m.joinRequest.id)
        .then(() => applyJoinRequestState(row, { status: 'declined' }))
        .catch((err) => {
          btn.disabled = false;
          btn.textContent = 'Decline';
          alert(err.message);
        });
    });

    maybeScrollToBottom();
  }

  function applyJoinRequestState(row, joinRequest) {
    const acceptBtn = row.querySelector('.join-request-accept-btn');
    const declineBtn = row.querySelector('.join-request-decline-btn');
    const acceptedLabel = row.querySelector('.join-request-resolved-label');
    const declinedLabel = row.querySelector('.join-request-declined-label');
    if (joinRequest.status === 'accepted') {
      acceptBtn.classList.add('hidden');
      declineBtn.classList.add('hidden');
      acceptedLabel.classList.remove('hidden');
      declinedLabel.classList.add('hidden');
    } else if (joinRequest.status === 'declined') {
      acceptBtn.classList.add('hidden');
      declineBtn.classList.add('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.remove('hidden');
    } else {
      acceptBtn.classList.remove('hidden');
      declineBtn.classList.remove('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.add('hidden');
    }
  }

  function appendGroupInviteMessage(m) {
    const list = $('#chat-messages');
    const row = document.createElement('div');
    row.className = 'message-row group-invite-row';
    row.dataset.inviteId = m.groupInvite.id;

    const av = avatarEl({
      displayName: m.senderName,
      avatarColor: m.senderColor,
      avatarUrl: m.senderAvatarUrl
    });
    row.appendChild(av);

    const invite = m.groupInvite;
    const groupName = invite.groupName || 'this server';
    const groupColor = invite.groupIconColor || 'var(--blurple)';
    const groupIconUrl = invite.groupIconUrl;
    const isMe = m.senderId === AppState.me.id;

    const groupIconInner = groupIconUrl
      ? `<img src="${escapeHtml(groupIconUrl)}" alt="${escapeHtml(groupName)}">`
      : escapeHtml(initials(groupName));

    const body = document.createElement('div');
    body.className = 'message-body';
    body.innerHTML = `
      <div class="invite-card">
        <div class="invite-card-label">${isMe ? 'You invited them to join a server' : `${escapeHtml(m.senderName)} invited you to join a server`}</div>
        <div class="invite-card-body">
          <div class="invite-card-icon" style="background: ${groupColor}">${groupIconInner}</div>
          <div class="invite-card-info">
            <div class="invite-card-server-name">${escapeHtml(groupName)}</div>
            <div class="invite-card-channel">Server invite</div>
          </div>
          ${isMe ? '' : `
            <button type="button" class="btn-invite-accept group-invite-accept-btn">Accept</button>
            <button type="button" class="btn-invite-decline group-invite-decline-btn">Decline</button>
          `}
          <span class="join-request-resolved-label hidden">Accepted ✓</span>
          <span class="join-request-declined-label hidden">Declined ✕</span>
        </div>
      </div>
    `;
    row.appendChild(body);
    insertRow(list, row);

    applyGroupInviteState(row, invite);

    const acceptBtn = body.querySelector('.group-invite-accept-btn');
    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => {
        acceptBtn.disabled = true;
        acceptBtn.textContent = 'Accepting...';
        Api.groups.acceptInvite(invite.groupId, invite.id)
          .then(() => applyGroupInviteState(row, { status: 'accepted' }))
          .catch((err) => {
            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Accept';
            alert(err.message);
          });
      });
    }

    const declineBtn = body.querySelector('.group-invite-decline-btn');
    if (declineBtn) {
      declineBtn.addEventListener('click', () => {
        declineBtn.disabled = true;
        declineBtn.textContent = 'Declining...';
        Api.groups.declineInvite(invite.groupId, invite.id)
          .then(() => applyGroupInviteState(row, { status: 'declined' }))
          .catch((err) => {
            declineBtn.disabled = false;
            declineBtn.textContent = 'Decline';
            alert(err.message);
          });
      });
    }

    maybeScrollToBottom();
  }

  function applyGroupInviteState(row, invite) {
    const acceptBtn = row.querySelector('.group-invite-accept-btn');
    const declineBtn = row.querySelector('.group-invite-decline-btn');
    const acceptedLabel = row.querySelector('.join-request-resolved-label');
    const declinedLabel = row.querySelector('.join-request-declined-label');
    if (invite.status === 'accepted') {
      if (acceptBtn) acceptBtn.classList.add('hidden');
      if (declineBtn) declineBtn.classList.add('hidden');
      acceptedLabel.classList.remove('hidden');
      declinedLabel.classList.add('hidden');
    } else if (invite.status === 'declined') {
      if (acceptBtn) acceptBtn.classList.add('hidden');
      if (declineBtn) declineBtn.classList.add('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.remove('hidden');
    } else {
      if (acceptBtn) acceptBtn.classList.remove('hidden');
      if (declineBtn) declineBtn.classList.remove('hidden');
      acceptedLabel.classList.add('hidden');
      declinedLabel.classList.add('hidden');
    }
  }

  function handleGroupInviteResolved(inviteId, status) {
    const row = document.querySelector(`.group-invite-row[data-invite-id="${inviteId}"]`);
    if (!row) return;
    applyGroupInviteState(row, { status });
  }

  // If we're currently looking at a DM with this person, keep the chat
  // header's name in sync with their new display name live.
  function handleProfileUpdated(user) {
    const chat = AppState.activeChat;
    if (chat && chat.type === 'dm' && chat.id === user.id) {
      chat.name = user.displayName;
      chat.color = user.avatarColor;
      $('#chat-title').textContent = `@${chat.name}`;
    }
  }

  function isImage(type) { return /^image\//.test(type || ''); }
  function isVideo(type) { return /^video\//.test(type || ''); }

  function formatBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function renderVideoEmbed(embedUrl) {
    const wrap = document.createElement('div');
    const isTweet = embedUrl.indexOf('platform.twitter.com') !== -1;
    wrap.className = isTweet ? 'link-video-embed link-video-embed--tweet' : 'link-video-embed';
    const iframe = document.createElement('iframe');
    iframe.src = embedUrl;
    iframe.title = isTweet ? 'Embedded post' : 'Embedded video';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.frameBorder = '0';
    wrap.appendChild(iframe);
    return wrap;
  }

  function renderAttachment(att) {
    if (isImage(att.type)) {
      const link = document.createElement('a');
      link.href = att.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'attachment-image-link';
      link.title = 'Click to view full size';
      const img = document.createElement('img');
      img.src = att.url;
      img.alt = att.name || 'image attachment';
      img.className = 'attachment-image';
      link.appendChild(img);
      // Plain click opens an in-app full-resolution lightbox instead of
      // navigating away (which loses the original pixel data to the
      // browser's own fit-to-window downscaling). Ctrl/Cmd/middle-click
      // still falls through to opening the raw file in a new tab.
      link.addEventListener('click', (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        openLightbox(att.url, att.name);
      });
      return link;
    }
    if (isVideo(att.type)) {
      const video = document.createElement('video');
      video.src = att.url;
      video.controls = true;
      video.className = 'attachment-video';
      return video;
    }
    const chip = document.createElement('a');
    chip.href = att.url;
    chip.download = att.name || '';
    chip.target = '_blank';
    chip.rel = 'noopener noreferrer';
    chip.className = 'attachment-file-chip';
    chip.innerHTML = `
      <span class="attachment-file-icon">📄</span>
      <span class="attachment-file-info">
        <span class="attachment-file-name"></span>
        <span class="attachment-file-size">${escapeHtml(formatBytes(att.size))}</span>
      </span>
    `;
    chip.querySelector('.attachment-file-name').textContent = att.name || 'file';
    return chip;
  }

  function openLightbox(url, name) {
    let overlay = $('#lightbox-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'lightbox-overlay';
      overlay.className = 'lightbox-overlay';
      overlay.innerHTML = `
        <a class="lightbox-open-original" target="_blank" rel="noopener noreferrer">Open original ↗</a>
        <img class="lightbox-img" />
      `;
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeLightbox();
      });
      document.body.appendChild(overlay);
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLightbox();
      });
    }
    overlay.querySelector('.lightbox-img').src = url;
    overlay.querySelector('.lightbox-img').alt = name || '';
    overlay.querySelector('.lightbox-open-original').href = url;
    overlay.classList.add('open');
  }

  function closeLightbox() {
    const overlay = $('#lightbox-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function scrollToBottom() {
    const el = $('#chat-messages');
    el.scrollTop = el.scrollHeight;
  }

  function sendMessage() {
    const input = $('#chat-input');
    const content = input.value.trim();
    const chat = AppState.activeChat;
    if ((!content && !pendingFile) || !chat) return;

    const file = pendingFile;
    input.value = '';
    clearPendingFile();

    if (file) {
      setSendDisabled(true);
      Api.messages.upload(file)
        .then((attachment) => emitMessage(chat, content, attachment))
        .catch((err) => {
          $('#typing-indicator').textContent = err.message;
        })
        .finally(() => setSendDisabled(false));
    } else {
      emitMessage(chat, content, null);
    }
  }

  function emitMessage(chat, content, attachment) {
    if (chat.type === 'dm') {
      AppState.socket.emit('dm:send', { recipientId: chat.id, content, attachment });
    } else {
      AppState.socket.emit('channel:send', { channelId: chat.id, content, attachment });
    }
  }

  function setSendDisabled(disabled) {
    $('#chat-send').disabled = disabled;
    $('#chat-attach-btn').disabled = disabled;
  }

  function onFileSelected(file) {
    if (!file) return;
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      $('#typing-indicator').textContent = `File is too large (max ${MAX_UPLOAD_MB}MB)`;
      return;
    }
    pendingFile = file;
    renderPendingFile();
  }

  function renderPendingFile() {
    const preview = $('#attachment-preview');
    if (!pendingFile) {
      preview.classList.add('hidden');
      preview.classList.remove('media');
      preview.innerHTML = '';
      return;
    }
    preview.classList.remove('hidden');

    const showThumb = isImage(pendingFile.type) || isVideo(pendingFile.type);
    pendingFileUrl = showThumb ? URL.createObjectURL(pendingFile) : null;

    if (showThumb) {
      preview.classList.add('media');
      preview.innerHTML = `
        <div class="attachment-preview-card">
          <div class="attachment-preview-toolbar">
            <button type="button" class="attachment-preview-tool" id="attachment-preview-view" title="View">👁</button>
            <button type="button" class="attachment-preview-tool" id="attachment-preview-remove" title="Remove">🗑</button>
          </div>
          <div class="attachment-preview-media"></div>
          <div class="attachment-preview-caption"></div>
        </div>
      `;
      const mediaWrap = preview.querySelector('.attachment-preview-media');
      if (isImage(pendingFile.type)) {
        const img = document.createElement('img');
        img.src = pendingFileUrl;
        mediaWrap.appendChild(img);
      } else {
        const video = document.createElement('video');
        video.src = pendingFileUrl;
        video.muted = true;
        mediaWrap.appendChild(video);
      }
      preview.querySelector('.attachment-preview-caption').textContent = pendingFile.name;
      preview.querySelector('#attachment-preview-view').addEventListener('click', () => openLightbox(pendingFileUrl, pendingFile.name));
      preview.querySelector('#attachment-preview-remove').addEventListener('click', clearPendingFile);
    } else {
      preview.classList.remove('media');
      preview.innerHTML = `
        <span class="attachment-preview-name"></span>
        <span class="attachment-preview-size">${escapeHtml(formatBytes(pendingFile.size))}</span>
        <button type="button" class="attachment-preview-remove" id="attachment-preview-remove">✕</button>
      `;
      preview.querySelector('.attachment-preview-name').textContent = pendingFile.name;
      preview.querySelector('#attachment-preview-remove').addEventListener('click', clearPendingFile);
    }
  }

  function clearPendingFile() {
    pendingFile = null;
    if (pendingFileUrl) {
      URL.revokeObjectURL(pendingFileUrl);
      pendingFileUrl = null;
    }
    $('#chat-file-input').value = '';
    renderPendingFile();
  }

  function chatKey(type, id) {
    return `${type}-${id}`;
  }

  function activeChatKey() {
    const chat = AppState.activeChat;
    if (!chat) return null;
    return chatKey(chat.type, chat.id);
  }

  function registerTypingUser(key, userId, name) {
    if (!typingUsers[key]) typingUsers[key] = new Map();
    const users = typingUsers[key];
    if (users.has(userId)) clearTimeout(users.get(userId).timer);

    const timer = setTimeout(() => {
      users.delete(userId);
      renderTypingIndicator(key);
    }, 3000);

    users.set(userId, { name: name || 'Someone', timer });
    renderTypingIndicator(key);
  }

  function renderTypingIndicator(key) {
    if (key !== activeChatKey()) return; // event is for a chat that isn't open right now

    const el = $('#typing-indicator');
    const users = typingUsers[key];
    const names = users ? Array.from(users.values()).map((u) => u.name) : [];

    if (names.length === 0) {
      el.classList.remove('visible');
      el.innerHTML = '';
      return;
    }

    let text;
    if (names.length === 1) text = `${names[0]} is typing`;
    else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing`;
    else text = `${names.length} people are typing`;

    el.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span><span class="typing-text">${escapeHtml(text)}...</span>`;
    el.classList.add('visible');
  }

  function emitTyping() {
    const chat = AppState.activeChat;
    if (!chat || !AppState.socket) return;
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      AppState.socket.emit('typing', { scope: chat.type, id: chat.id });
    }, 150);
  }

  // ---- Called by SocketClient for incoming realtime events ----

  function handleIncomingMessage(kind, msg) {
    const chat = AppState.activeChat;
    if (kind === 'dm' && chat && chat.type === 'dm' && (msg.senderId === chat.id || msg.recipientId === chat.id)) {
      appendMessage(msg);
      return;
    }
    if (kind === 'channel' && chat && chat.type === 'channel' && msg.channelId === chat.id) {
      appendMessage(msg);
      return;
    }
    // Not the conversation currently open — flag it as unread (red dot on
    // the rail) and, for DMs, pop a toast too.
    if (kind === 'dm' && msg.senderId !== AppState.me.id) {
      showDmToast(msg);
      Groups.markDmUnread(msg.senderId);
      Friends.markTabUnread(msg.senderId);
    } else if (kind === 'channel' && msg.senderId !== AppState.me.id && msg.groupId) {
      Groups.markGroupUnread(msg.groupId);
      Groups.markChannelUnread(msg.channelId);
    }
  }

  function handleTypingEvent(scope, from, channelId, senderName) {
    const chat = AppState.activeChat;
    if (!chat) return;
    if (scope === 'dm' && chat.type === 'dm' && from === chat.id) {
      registerTypingUser(chatKey('dm', chat.id), from, senderName);
    } else if (scope === 'channel' && chat.type === 'channel' && channelId === chat.id) {
      registerTypingUser(chatKey('channel', chat.id), from, senderName);
    }
  }

  function handleJoinRequestResolved(requestId, status) {
    const row = document.querySelector(`.join-request-row[data-request-id="${requestId}"]`);
    if (!row) return;
    applyJoinRequestState(row, { status });
  }

  function initUI() {
    $('#chat-messages').addEventListener('scroll', () => {
      const el = $('#chat-messages');
      if (el.scrollTop < 150) loadOlderMessages();
    });

    $('#chat-send').addEventListener('click', sendMessage);
    $('#chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        sendMessage();
      } else {
        emitTyping();
      }
    });
    $('#chat-attach-btn').addEventListener('click', () => $('#chat-file-input').click());
    $('#chat-file-input').addEventListener('change', (e) => onFileSelected(e.target.files[0]));

    $('#chat-popup-close').addEventListener('click', () => {
      const panel = $('#chat-panel');
      panel.classList.add('hidden');
      panel.classList.remove('dm-popup');
      panel.style.left = '';
      panel.style.top = '';
      panel.style.transform = '';
      AppState.activeChat = null;
      $('#empty-state').classList.remove('hidden');
    });

    Utils.makeFloatingDraggable($('#chat-panel'), $('#chat-popup-titlebar'), 'dm-popup');

    EmojiPicker.init((emoji) => {
      const input = $('#chat-input');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
      const cursor = start + emoji.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      EmojiPicker.close();
    });
  }

  return {
    openDM,
    openChannel,
    openChatWindow,
    handleIncomingMessage,
    handleTypingEvent,
    handleJoinRequestResolved,
    handleGroupInviteResolved,
    handleProfileUpdated,
    handleMessageDeleted,
    initUI
  };
})();