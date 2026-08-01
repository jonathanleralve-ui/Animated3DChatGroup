// Friends list (online/all/pending tabs), friend requests, and the
// "Add Friend" form.
const Friends = (() => {
  const { $, $$, escapeHtml, avatarEl, avatarWithStatus, applyNameColor } = Utils;

  function refresh() {
    return Promise.all([Api.friends.list(), Api.messages.others()]).then(([friendsData, othersData]) => {
      AppState.friendsData = friendsData;
      AppState.elseData = othersData.users;
      renderTabs();
    });
  }

  function handlePresenceUpdate(userId, status) {
    let changed = false;
    const f = AppState.friendsData.friends.find((x) => x.id === userId);
    if (f) { f.status = status; changed = true; }
    const o = (AppState.elseData || []).find((x) => x.id === userId);
    if (o) { o.status = status; changed = true; }
    if (changed) renderTabs();
  }

  // A friend (or someone in the "Else" list) changed their display name,
  // avatar, or colors elsewhere — patch whichever cached list(s) they show
  // up in instead of leaving stale info until the next full refresh().
  function handleProfileUpdated(user) {
    let changed = false;
    ['friends', 'incoming', 'outgoing'].forEach((key) => {
      const idx = AppState.friendsData[key].findIndex((u) => u.id === user.id);
      if (idx !== -1) {
        Object.assign(AppState.friendsData[key][idx], user);
        changed = true;
      }
    });
    const elseIdx = (AppState.elseData || []).findIndex((u) => u.id === user.id);
    if (elseIdx !== -1) {
      Object.assign(AppState.elseData[elseIdx], user);
      changed = true;
    }
    if (changed) renderTabs();
  }

  function renderTabs() {
    const { friends, incoming, outgoing } = AppState.friendsData;

    renderFriendList('#tab-friends', friends, "You haven't added anyone yet.");
    renderFriendList('#tab-else', AppState.elseData || [], 'No other conversations yet.');

    const pendingEl = $('#tab-pending');
    pendingEl.innerHTML = '';
    updatePendingDot(incoming);
    if (incoming.length === 0 && outgoing.length === 0) {
      pendingEl.innerHTML = '<div class="empty-list-hint">No pending requests.</div>';
      return;
    }
    if (incoming.length) {
      pendingEl.appendChild(sectionLabel(`INCOMING — ${incoming.length}`));
      incoming.forEach((u) => pendingEl.appendChild(buildIncomingRow(u)));
    }
    if (outgoing.length) {
      pendingEl.appendChild(sectionLabel(`OUTGOING — ${outgoing.length}`));
      outgoing.forEach((u) => pendingEl.appendChild(buildOutgoingRow(u)));
    }
  }

  function setTabDotVisible(tab, visible) {
    const dot = $(`#tab-dot-${tab}`);
    if (dot) dot.classList.toggle('hidden', !visible);
  }

  function markTabUnread(senderId) {
    const status = friendStatusFor(senderId);
    if (status === 'friends') {
      AppState.unreadFriendsTabSenders[senderId] = true;
      setTabDotVisible('friends', true);
    } else {
      AppState.unreadElseTabSenders[senderId] = true;
      setTabDotVisible('else', true);
      if (!(AppState.elseData || []).some((u) => u.id === senderId)) {
        refresh();
        return;
      }
    }
    renderTabs();
  }

  function clearSenderTabUnread(userId) {
    if (AppState.unreadFriendsTabSenders[userId]) {
      delete AppState.unreadFriendsTabSenders[userId];
      if (Object.keys(AppState.unreadFriendsTabSenders).length === 0) setTabDotVisible('friends', false);
    }
    if (AppState.unreadElseTabSenders[userId]) {
      delete AppState.unreadElseTabSenders[userId];
      if (Object.keys(AppState.unreadElseTabSenders).length === 0) setTabDotVisible('else', false);
    }
    renderTabs();
  }

  function clearFriendsTabUnread() {
    AppState.unreadFriendsTabSenders = {};
    setTabDotVisible('friends', false);
  }

  function clearElseTabUnread() {
    AppState.unreadElseTabSenders = {};
    setTabDotVisible('else', false);
  }

  function updatePendingDot(incoming) {
    if (!AppState.seenIncomingRequestIds) AppState.seenIncomingRequestIds = new Set();
    const hasNew = incoming.some((u) => !AppState.seenIncomingRequestIds.has(u.friendshipId));
    setTabDotVisible('pending', hasNew);
  }

  function clearPendingUnread() {
    AppState.seenIncomingRequestIds = new Set(AppState.friendsData.incoming.map((u) => u.friendshipId));
    setTabDotVisible('pending', false);
  }

  function sectionLabel(text) {
    const label = document.createElement('div');
    label.className = 'panel-hint';
    label.textContent = text;
    return label;
  }

  function renderFriendList(selector, list, emptyMsg) {
    const el = $(selector);
    el.innerHTML = '';
    if (list.length === 0) {
      el.innerHTML = `<div class="empty-list-hint">${emptyMsg}</div>`;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'friend-card-grid';
    list.forEach((f) => grid.appendChild(buildFriendCard(f)));
    el.appendChild(grid);
  }

  function buildFriendCard(f) {
    const wrap = document.createElement('div');
    wrap.className = 'profile-preview-wrap';

    const card = document.createElement('div');
    card.className = 'profile-preview-card friend-card';

    const banner = document.createElement('div');
    banner.className = 'profile-preview-banner';
    if (f.bannerUrl) {
      banner.classList.add('has-banner-image');
      const zoom = f.bannerZoom || 1;
      const offsetX = f.bannerOffsetX || 0;
      const offsetY = f.bannerOffsetY || 0;
      banner.style.backgroundImage = `url("${f.bannerUrl}")`;
      banner.style.backgroundSize = `${zoom * 100}%`;
      banner.style.backgroundPosition = `calc(50% + ${offsetX}px) calc(50% + ${offsetY}px)`;
    }
    card.appendChild(banner);

    const ring = document.createElement('div');
    ring.className = 'profile-preview-avatar-ring';
    const avatarBox = document.createElement('div');
    avatarBox.className = 'profile-preview-avatar';
    avatarBox.appendChild(avatarWithStatus(f));
    ring.appendChild(avatarBox);
    card.appendChild(ring);
    Utils.applyCardTheming(card, ring, f);

    const body = document.createElement('div');
    body.className = 'profile-preview-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'profile-preview-name';
    nameEl.textContent = f.displayName;
    applyNameColor(nameEl, f.nameColor);
    body.appendChild(nameEl);

    if (f.username) {
      const userEl = document.createElement('div');
      userEl.className = 'profile-preview-username';
      userEl.textContent = `@${f.username}`;
      body.appendChild(userEl);
    }

    const statusEl = document.createElement('div');
    statusEl.className = 'friend-card-status';
    statusEl.textContent = f.status === 'online' ? 'Online' : 'Offline';
    body.appendChild(statusEl);

    card.appendChild(body);

    if (AppState.unreadDmSenders[f.id]) {
      const dot = document.createElement('span');
      dot.className = 'friend-card-unread-dot';
      card.appendChild(dot);
    }

    card.addEventListener('click', () => Chat.openDM(f));

    wrap.appendChild(card);
    const effectsLayer = document.createElement('div');
    effectsLayer.className = 'profile-effects-layer';
    Utils.renderProfileEffects(effectsLayer, f.profileEffects);
    wrap.appendChild(effectsLayer);

    return wrap;
  }

  function buildIncomingRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.appendChild(avatarEl(u));
    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">Incoming request</div>`;
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'icon-btn';
    acceptBtn.textContent = '✓';
    acceptBtn.title = 'Accept';
    acceptBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Api.friends.accept(u.friendshipId).then(refresh);
    });

    const declineBtn = document.createElement('button');
    declineBtn.className = 'icon-btn decline';
    declineBtn.textContent = '✕';
    declineBtn.title = 'Decline';
    declineBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Api.friends.remove(u.friendshipId).then(refresh);
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    row.appendChild(actions);
    return row;
  }

  function buildOutgoingRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row';
    row.appendChild(avatarEl(u));
    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">Pending...</div>`;
    row.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'friend-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'icon-btn decline';
    cancelBtn.textContent = '✕';
    cancelBtn.title = 'Cancel request';
    cancelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      Api.friends.remove(u.friendshipId).then(refresh);
    });
    actions.appendChild(cancelBtn);
    row.appendChild(actions);
    return row;
  }

  let searchDebounce = null;
  let searchToken = 0;

  function friendStatusFor(userId) {
    const data = AppState.friendsData || { friends: [], incoming: [], outgoing: [] };
    if (data.friends.some((f) => f.id === userId)) return 'friends';
    if (data.outgoing.some((f) => f.id === userId)) return 'outgoing';
    if (data.incoming.some((f) => f.id === userId)) return 'incoming';
    return null;
  }

  function buildSearchResultRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row search-result-row';
    row.appendChild(avatarEl(u));

    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">@${escapeHtml(u.username)}</div>`;
    row.appendChild(meta);

    const action = document.createElement('div');
    action.className = 'search-result-action';

    const status = friendStatusFor(u.id);
    if (status === 'friends') {
      action.textContent = 'Friends';
      action.classList.add('muted');
    } else if (status === 'outgoing') {
      action.textContent = 'Pending';
      action.classList.add('muted');
    } else if (status === 'incoming') {
      action.textContent = 'Respond in Pending';
      action.classList.add('muted');
    } else {
      action.textContent = '+ Add';
      action.classList.add('addable');
      row.classList.add('clickable');
      row.addEventListener('click', () => sendRequestFromSearch(u, row, action));
    }
    row.appendChild(action);
    return row;
  }

  function sendRequestFromSearch(u, row, action) {
    row.classList.remove('clickable');
    row.classList.add('sending');
    action.textContent = 'Sending...';
    $('#add-friend-error').textContent = '';
    Api.friends.sendRequest(u.username)
      .then(() => {
        row.classList.remove('sending');
        action.classList.remove('addable');
        action.classList.add('sent');
        action.textContent = '✓ Request Sent';
        return refresh();
      })
      .catch((err) => {
        row.classList.remove('sending');
        row.classList.add('clickable');
        action.textContent = '+ Add';
        $('#add-friend-error').textContent = err.message;
      });
  }

  function renderSearchResults(users) {
    const el = $('#add-friend-results');
    el.innerHTML = '';
    if (users.length === 0) {
      el.innerHTML = '<div class="empty-list-hint">No matching usernames.</div>';
      return;
    }
    users.forEach((u) => el.appendChild(buildSearchResultRow(u)));
  }

  function runSearch(query) {
    const myToken = ++searchToken;
    if (!query) {
      $('#add-friend-results').innerHTML = '';
      return;
    }
    Api.friends.search(query)
      .then((data) => {
        if (myToken !== searchToken) return; // a newer search superseded this one
        renderSearchResults(data.users);
      })
      .catch(() => {
        if (myToken !== searchToken) return;
        $('#add-friend-results').innerHTML = '<div class="empty-list-hint">Search failed, try again.</div>';
      });
  }

  function openAddFriendPanel() {
    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#friends-lists-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#group-settings-panel').classList.add('hidden');
    $('#add-friend-error').textContent = '';
    $('#add-friend-input').value = '';
    $('#add-friend-results').innerHTML = '';
    $('#add-friend-panel').classList.remove('hidden');
    $('#add-friend-input').focus();
  }

  function closeAddFriendPanel() {
    clearTimeout(searchDebounce);
    $('#add-friend-panel').classList.add('hidden');
    if (AppState.activeChat) {
      $('#chat-panel').classList.remove('hidden');
    } else {
      $('#friends-lists-panel').classList.remove('hidden');
    }
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $('.tab-btn[data-tab="friends"]').classList.add('active');
    $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
    $('#tab-friends').classList.remove('hidden');
  }

  function initUI() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');

        if (btn.dataset.tab === 'add') {
          openAddFriendPanel();
          return;
        }

        // Clicking a Friends/Else/Pending tab always shows that list in the
        // main content area, taking over from whatever else was showing
        // there (a DM/channel, the empty placeholder, add-friend, etc).
        $('#add-friend-panel').classList.add('hidden');
        $('#chat-panel').classList.add('hidden');
        $('#empty-state').classList.add('hidden');
        $('#friends-lists-panel').classList.remove('hidden');
        $$('.tab-panel').forEach((p) => p.classList.add('hidden'));
        $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');

        if (btn.dataset.tab === 'friends') clearFriendsTabUnread();
        else if (btn.dataset.tab === 'else') clearElseTabUnread();
        else if (btn.dataset.tab === 'pending') clearPendingUnread();
      });
    });

    $('#add-friend-close').addEventListener('click', closeAddFriendPanel);

    $('#add-friend-input').addEventListener('input', () => {
      const query = $('#add-friend-input').value.trim();
      $('#add-friend-error').textContent = '';
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => runSearch(query), 250);
    });
  }

  return { refresh, renderTabs, handlePresenceUpdate, handleProfileUpdated, initUI, markTabUnread, clearSenderTabUnread };
})();