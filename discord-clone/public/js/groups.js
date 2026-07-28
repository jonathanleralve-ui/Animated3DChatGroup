// Group rail icons, the channel list + member list shown when a group is
// open, and the create-group / add-member / create-channel modals.
const Groups = (() => {
  const { $, $$, escapeHtml, initials, avatarWithStatus, applyNameColor } = Utils;

  let createChannelType = 'text';
  let pendingRenameChannel = null;
  let pendingDeleteChannel = null;
  let selectedGroupIconUrl = null;
  let pendingGroupIconFile = null;

  function refresh() {
    return Api.groups.list().then((data) => {
      AppState.groupsData = data.groups;
      renderRail();
    });
  }

  function renderRail() {
    const container = $('#rail-groups');
    container.innerHTML = '';
    AppState.groupsData.forEach((g) => {
      const wrap = document.createElement('div');
      wrap.className = 'rail-item-wrap';

      const el = document.createElement('div');
      el.className = 'rail-item';
      el.title = g.name;
      el.dataset.groupId = g.id;
      el.style.background = g.iconColor;
      if (g.iconUrl) {
        el.innerHTML = '';
        const img = document.createElement('img');
        img.src = g.iconUrl;
        img.alt = g.name;
        el.appendChild(img);
      } else {
        el.textContent = initials(g.name);
      }
      el.addEventListener('click', () => open(g));
      wrap.appendChild(el);

      const dot = document.createElement('span');
      dot.className = 'unread-dot hidden';
      dot.dataset.groupDot = g.id;
      if (AppState.unreadGroupIds[g.id]) dot.classList.remove('hidden');
      wrap.appendChild(dot);

      container.appendChild(wrap);
    });
  }

  // Called whenever a channel message arrives for a group that isn't the
  // one currently open in the sidebar — lights up its rail dot.
  function markGroupUnread(groupId) {
    AppState.unreadGroupIds[groupId] = true;
    const dot = document.querySelector(`.unread-dot[data-group-dot="${groupId}"]`);
    if (dot) dot.classList.remove('hidden');
  }

  function markChannelUnread(channelId) {
    AppState.unreadChannelIds[channelId] = true;
    if (AppState.activeGroupChannels.some((c) => c.id === channelId)) renderChannels();
  }

  // Called when the user opens a group (or a channel within it) — clears
  // its rail dot.
  function clearGroupUnread(groupId) {
    delete AppState.unreadGroupIds[groupId];
    const dot = document.querySelector(`.unread-dot[data-group-dot="${groupId}"]`);
    if (dot) dot.classList.add('hidden');
  }

  function clearChannelUnread(channelId) {
    delete AppState.unreadChannelIds[channelId];
    if (AppState.activeGroupChannels.some((c) => c.id === channelId)) renderChannels();
  }

  // DMs don't have their own rail icon, so any unread private message lights
  // up the Friends/home icon instead, tracked per-sender so opening one DM
  // doesn't hide the dot for a still-unread one from someone else.
  function markDmUnread(senderId) {
    AppState.unreadDmSenders[senderId] = true;
    const dot = $('#rail-home-dot');
    if (dot) dot.classList.remove('hidden');
  }

  function clearDmUnread(senderId) {
    delete AppState.unreadDmSenders[senderId];
    if (Object.keys(AppState.unreadDmSenders).length === 0) {
      const dot = $('#rail-home-dot');
      if (dot) dot.classList.add('hidden');
    }
  }

  function open(g) {
    AppState.activeGroup = g;
    AppState.activeChat = null;
    App.setActiveRail(document.querySelector(`.rail-item[data-group-id="${g.id}"]`));
    clearGroupUnread(g.id);
    $('#sidebar-header').textContent = g.name;
    $('#friends-panel').classList.add('hidden');
    $('#group-panel').classList.remove('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#empty-state').classList.remove('hidden');
    $('#chat-panel').classList.add('hidden');

    VoiceChat.refreshPanelForGroup(g.id);

    Api.groups.members(g.id).then((data) => {
      AppState.activeMemberIds = data.members.map((m) => m.id);
      renderMembers(data.members);
    });

    Api.groups.voiceRosters(g.id).then((data) => {
      AppState.voiceRosters = data.rosters || {};
      refreshChannelHighlight();
    });

    loadChannels(g.id);
  }

  function loadChannels(groupId) {
    return Api.channels.list(groupId).then((data) => {
      AppState.activeGroupChannels = data.channels;
      renderChannels();
      // Land on the first text channel automatically, like Discord does.
      const firstText = data.channels.find((c) => c.type === 'text');
      if (firstText) Chat.openChannel(firstText);
    });
  }

  function renderChannels() {
    const container = $('#channel-list');
    container.innerHTML = '';
    if (!AppState.activeGroup) return;

    const isOwner = AppState.activeGroup.ownerId === AppState.me.id;
    const text = AppState.activeGroupChannels.filter((c) => c.type === 'text');
    const voice = AppState.activeGroupChannels.filter((c) => c.type === 'voice');

    container.appendChild(buildCategoryHeader('TEXT CHANNELS', 'text'));
    text.forEach((c) => container.appendChild(buildChannelRow(c, isOwner)));
    if (text.length === 0) container.appendChild(buildEmptyHint('No text channels yet.'));

    container.appendChild(buildCategoryHeader('VOICE CHANNELS', 'voice'));
    voice.forEach((c) => {
      container.appendChild(buildChannelRow(c, isOwner));
      const roster = AppState.voiceRosters[c.id];
      if (roster && roster.length > 0) container.appendChild(buildVoiceRosterList(roster));
    });
    if (voice.length === 0) container.appendChild(buildEmptyHint('No voice channels yet.'));
  }

  // Handle a realtime roster change for one voice channel (someone joined,
  // left, or started/stopped screen sharing) by updating local state and
  // re-rendering the channel list if that channel belongs to the open group.
  function handleVoiceRosterUpdate(channelId, participants) {
    AppState.voiceRosters[channelId] = participants;
    if (AppState.activeGroupChannels.some((c) => c.id === channelId)) {
      renderChannels();
    }
  }

  function buildVoiceRosterList(roster) {
    const list = document.createElement('div');
    list.className = 'voice-roster-list';
    roster.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'voice-roster-item';
      item.appendChild(avatarWithStatus(p));

      const name = document.createElement('span');
      name.className = 'voice-roster-name';
      name.textContent = p.displayName;
      applyNameColor(name, p.nameColor);
      item.appendChild(name);

      if (p.muted) {
        const muteBadge = document.createElement('span');
        muteBadge.className = 'voice-roster-mute-badge';
        muteBadge.textContent = '🔇';
        muteBadge.title = 'Muted';
        item.appendChild(muteBadge);
      }

      if (p.sharing) {
        const badge = document.createElement('span');
        badge.className = 'voice-roster-live-badge';
        badge.textContent = 'LIVE';
        item.appendChild(badge);
      }

      list.appendChild(item);
    });
    return list;
  }

  // Re-render without re-fetching, e.g. after switching the active text
  // channel or connecting/disconnecting from a voice channel.
  function refreshChannelHighlight() {
    if (AppState.activeGroup) renderChannels();
  }

  function buildEmptyHint(text) {
    const el = document.createElement('div');
    el.className = 'empty-list-hint';
    el.textContent = text;
    return el;
  }

  function buildCategoryHeader(label, type) {
    const el = document.createElement('div');
    el.className = 'channel-category';
    const span = document.createElement('span');
    span.textContent = label;
    el.appendChild(span);
    const addBtn = document.createElement('button');
    addBtn.className = 'channel-add-btn';
    addBtn.textContent = '+';
    addBtn.title = `Create ${type} channel`;
    addBtn.addEventListener('click', () => openCreateChannelModal(type));
    el.appendChild(addBtn);
    return el;
  }

  function buildChannelRow(c, isOwner) {
    const row = document.createElement('div');
    const isVoice = c.type === 'voice';
    const active = isVoice
      ? VoiceChat.isConnectedTo(c.id)
      : (AppState.activeChat && AppState.activeChat.type === 'channel' && AppState.activeChat.id === c.id);
    row.className = `channel-row ${isVoice ? 'voice-row' : ''} ${active ? 'active' : ''}`;

    const label = document.createElement('span');
    label.className = 'channel-row-label';
    label.textContent = `${isVoice ? '🔊' : '#'} ${c.name}`;
    row.appendChild(label);

    if (!isVoice && AppState.unreadChannelIds[c.id]) {
      const dot = document.createElement('span');
      dot.className = 'channel-row-unread-dot';
      row.appendChild(dot);
    }

    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'channel-actions';

    const menuBtn = document.createElement('button');
    menuBtn.className = 'channel-menu-btn';
    menuBtn.textContent = '⋯';
    menuBtn.title = 'Channel options';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.toggle('open');
    });

    const menu = document.createElement('div');
    menu.className = 'channel-menu';
    menu.addEventListener('click', (e) => e.stopPropagation());

    const renameBtn = document.createElement('button');
    renameBtn.className = 'channel-menu-item';
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.remove('open');
      openRenameChannelModal(c);
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'channel-menu-item danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      actionsWrap.classList.remove('open');
      openDeleteChannelModal(c);
    });

    menu.appendChild(renameBtn);
    menu.appendChild(deleteBtn);
    actionsWrap.appendChild(menuBtn);
    actionsWrap.appendChild(menu);
    row.appendChild(actionsWrap);

    row.addEventListener('click', (e) => {
      if (e.target.closest('.channel-actions') || e.target.closest('.channel-menu')) return;
      const actionsWrap = row.querySelector('.channel-actions');
      if (actionsWrap) actionsWrap.classList.remove('open');
      if (isVoice) {
        if (VoiceChat.isConnectedTo(c.id)) {
          VoiceChat.leaveCurrent();
        } else {
          VoiceChat.joinChannel(c.id, c.name, AppState.activeGroup.id);
        }
      } else {
        Chat.openChannel(c);
      }
    });

    return row;
  }

  function renderMembers(members) {
    const el = $('#group-members-list');
    el.innerHTML = '';
    members.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'member-row';
      if (m.id === AppState.activeGroup.ownerId) {
        row.classList.add('owner');
      }
      row.appendChild(avatarWithStatus(m));
      const meta = document.createElement('div');
      meta.className = 'friend-meta';
      const ownerLabel = m.id === AppState.activeGroup.ownerId ? ' 👑' : '';
      meta.innerHTML = `<div class="friend-name">${escapeHtml(m.displayName)}${m.id === AppState.me.id ? ' (you)' : ''}${ownerLabel}</div>`;
      applyNameColor(meta.querySelector('.friend-name'), m.nameColor);
      row.appendChild(meta);
      // Clicking a member opens a small profile card (avatar/banner/name)
      // instead of jumping straight into a DM — matches how clicking a
      // member is meant to work in the mockup (card first, "Send Message"
      // inside it does the actual DM redirect). The server allows DMing
      // anyone sharing a group even if they aren't friends yet.
      row.addEventListener('click', () => openMemberCard(m, row));
      el.appendChild(row);
    });
  }

  // Renders the small member-card popover (banner/avatar/name, same visual
  // language as the edit-profile preview card) anchored next to whichever
  // member row was clicked, with a "Send Message" button that opens a DM.
  function openMemberCard(member, anchorEl) {
    const popover = $('#member-card-popover');
    const backdrop = $('#member-card-backdrop');

    // Banner
    const banner = $('#member-card-banner');
    const hasBanner = !!member.bannerUrl;
    banner.classList.toggle('has-banner-image', hasBanner);
    if (hasBanner) {
      const zoom = member.bannerZoom || 1;
      const offsetX = member.bannerOffsetX || 0;
      const offsetY = member.bannerOffsetY || 0;
      banner.style.backgroundImage = `url("${member.bannerUrl}")`;
      banner.style.backgroundSize = `${zoom * 100}%`;
      banner.style.backgroundPosition = `calc(50% + ${offsetX}px) calc(50% + ${offsetY}px)`;
    } else {
      banner.style.backgroundImage = '';
      banner.style.backgroundSize = '';
      banner.style.backgroundPosition = '';
    }

    // Avatar
    const avatarBox = $('#member-card-avatar');
    avatarBox.innerHTML = '';
    avatarBox.appendChild(avatarWithStatus(member));

    // Name / username
    const nameEl = $('#member-card-name');
    const ownerLabel = AppState.activeGroup && member.id === AppState.activeGroup.ownerId ? ' 👑' : '';
    nameEl.textContent = `${member.displayName}${member.id === AppState.me.id ? ' (you)' : ''}${ownerLabel}`;
    nameEl.style.color = '';
    applyNameColor(nameEl, member.nameColor);
    $('#member-card-username').textContent = member.username ? `@${member.username}` : '';

    // "Send Message" jumps straight to (or opens) the DM with this member.
    // Hidden for your own card, since you can't DM yourself.
    const sendBtn = $('#member-card-send-btn');
    sendBtn.classList.toggle('hidden', member.id === AppState.me.id);
    sendBtn.onclick = () => {
      closeMemberCard();
      Chat.openDM(member);
    };

    backdrop.classList.remove('hidden');
    popover.classList.remove('hidden');
    positionMemberCard(anchorEl);
  }

  function positionMemberCard(anchorEl) {
    const popover = $('#member-card-popover');
    const rect = anchorEl.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    const margin = 8;

    // Prefer opening to the right of the member row; fall back to the left
    // if there isn't room, then clamp vertically within the viewport.
    let left = rect.right + margin;
    if (left + popRect.width > window.innerWidth - margin) {
      left = rect.left - popRect.width - margin;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - popRect.width - margin));

    let top = rect.top;
    top = Math.max(margin, Math.min(top, window.innerHeight - popRect.height - margin));

    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function closeMemberCard() {
    $('#member-card-popover').classList.add('hidden');
    $('#member-card-backdrop').classList.add('hidden');
  }

  function openCreateModal() {
    $('#create-group-name').value = '';
    const list = $('#create-group-friends');
    list.innerHTML = '';
    if (AppState.friendsData.friends.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">Add some friends first!</div>';
    }
    AppState.friendsData.friends.forEach((f) => {
      const row = document.createElement('label');
      row.className = 'friend-check-row';
      row.innerHTML = `<input type="checkbox" value="${f.id}" /> <span>${escapeHtml(f.displayName)}</span>`;
      list.appendChild(row);
    });
    showModal('create-group-modal');
  }

  function closeModals() {
    pendingRenameChannel = null;
    pendingDeleteChannel = null;
    $('#modal-overlay').classList.add('hidden');
    $('#select-group-action-modal').classList.add('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#join-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
    $('#rename-channel-modal').classList.add('hidden');
    $('#delete-channel-modal').classList.add('hidden');
    $('#leave-group-modal').classList.add('hidden');
  }

  function showModal(id) {
    $('#modal-overlay').classList.remove('hidden');
    $('#select-group-action-modal').classList.add('hidden');
    $('#create-group-modal').classList.add('hidden');
    $('#join-group-modal').classList.add('hidden');
    $('#add-member-modal').classList.add('hidden');
    $('#create-channel-modal').classList.add('hidden');
    $('#rename-channel-modal').classList.add('hidden');
    $('#delete-channel-modal').classList.add('hidden');
    $('#leave-group-modal').classList.add('hidden');
    $(`#${id}`).classList.remove('hidden');
  }

  function openRenameChannelModal(channel) {
    if (!channel) return;
    pendingRenameChannel = channel;
    $('#rename-channel-name').value = channel.name;
    $('#rename-channel-error').textContent = '';
    showModal('rename-channel-modal');
    setTimeout(() => $('#rename-channel-name').focus(), 0);
  }

  function openDeleteChannelModal(channel) {
    if (!channel) return;
    pendingDeleteChannel = channel;
    $('#delete-channel-message').textContent = `Delete #${channel.name}? This action cannot be undone.`;
    showModal('delete-channel-modal');
  }

  function confirmRenameChannel() {
    if (!pendingRenameChannel) return;
    const name = $('#rename-channel-name').value.trim();
    $('#rename-channel-error').textContent = '';
    if (!name) return;
    const cleanName = String(name).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50);
    if (!cleanName || cleanName === pendingRenameChannel.name) {
      $('#rename-channel-error').textContent = 'Choose a different channel name.';
      return;
    }
    Api.channels.rename(pendingRenameChannel.id, cleanName)
      .then(() => {
        closeModals();
        return loadChannels(AppState.activeGroup.id);
      })
      .catch((err) => {
        $('#rename-channel-error').textContent = err.message;
      });
  }

  function confirmDeleteChannel() {
    if (!pendingDeleteChannel) return;
    const channel = pendingDeleteChannel;
    const isVoice = channel.type === 'voice';
    closeModals();
    Api.channels.remove(channel.id)
      .then(() => {
        if (isVoice && VoiceChat.isConnectedTo(channel.id)) VoiceChat.leaveCurrent();
        if (!isVoice && AppState.activeChat && AppState.activeChat.id === channel.id) {
          AppState.activeChat = null;
          $('#empty-state').classList.remove('hidden');
          $('#chat-panel').classList.add('hidden');
        }
        return loadChannels(AppState.activeGroup.id);
      })
      .catch((err) => alert(err.message));
  }

  // Shown when the "+" rail button is clicked — lets the user pick between
  // creating a new group or joining an existing one before any group-specific
  // modal opens.
  function openSelectActionModal() {
    showModal('select-group-action-modal');
  }

  let joinSearchDebounce = null;
  let joinSearchToken = 0;

  function openJoinModal() {
    clearTimeout(joinSearchDebounce);
    joinSearchToken++;
    $('#join-group-search').value = '';
    $('#join-group-results').innerHTML = '';
    $('#join-group-error').textContent = '';
    showModal('join-group-modal');
    $('#join-group-search').focus();
  }

  function buildJoinResultRow(g) {
    const row = document.createElement('div');
    row.className = 'friend-row search-result-row';

    const icon = document.createElement('div');
    icon.className = 'avatar';
    icon.style.background = g.iconColor;
    if (g.iconUrl) {
      const img = document.createElement('img');
      img.src = g.iconUrl;
      img.alt = g.name;
      icon.appendChild(img);
    } else {
      icon.textContent = initials(g.name);
    }
    row.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    const memberLabel = `${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`;
    meta.innerHTML = `<div class="friend-name">${escapeHtml(g.name)}</div><div class="friend-sub">${memberLabel}</div>`;
    row.appendChild(meta);

    const action = document.createElement('div');
    action.className = 'search-result-action';
    row.appendChild(action);

    if (g.isMember) {
      action.classList.add('muted');
      action.textContent = 'Already in it';
    } else if (g.pendingRequest) {
      action.classList.add('muted');
      action.textContent = 'Waiting for approval';
    } else {
      action.classList.add('addable');
      action.textContent = '+ Ask to Join';
      row.classList.add('clickable');
      row.addEventListener('click', () => {
        if (!row.classList.contains('clickable')) return;
        joinFromSearch(g, row, action);
      });
    }

    return row;
  }

  function joinFromSearch(g, row, action) {
    row.classList.remove('clickable');
    row.classList.add('sending');
    action.textContent = 'Requesting...';
    $('#join-group-error').textContent = '';
    Api.groups.requestJoin(g.id)
      .then(() => {
        row.classList.remove('sending');
        action.classList.remove('addable');
        action.classList.add('muted');
        action.textContent = 'Waiting for approval';
      })
      .catch((err) => {
        row.classList.remove('sending');
        row.classList.add('clickable');
        action.textContent = '+ Ask to Join';
        $('#join-group-error').textContent = err.message;
      });
  }

  function renderJoinResults(groupsFound) {
    const el = $('#join-group-results');
    el.innerHTML = '';
    if (groupsFound.length === 0) {
      el.innerHTML = '<div class="empty-list-hint">No matching groups.</div>';
      return;
    }
    groupsFound.forEach((g) => el.appendChild(buildJoinResultRow(g)));
  }

  function runJoinSearch(query) {
    const myToken = ++joinSearchToken;
    if (!query) {
      $('#join-group-results').innerHTML = '';
      return;
    }
    Api.groups.search(query)
      .then((data) => {
        if (myToken !== joinSearchToken) return; // a newer search superseded this one
        renderJoinResults(data.groups);
      })
      .catch(() => {
        if (myToken !== joinSearchToken) return;
        $('#join-group-results').innerHTML = '<div class="empty-list-hint">Search failed, try again.</div>';
      });
  }

  let inviteSearchDebounce = null;
  let inviteSearchToken = 0;

  function openAddMemberModal() {
    if (!AppState.activeGroup) return;
    clearTimeout(inviteSearchDebounce);
    inviteSearchToken++;
    $('#add-member-search').value = '';
    $('#add-member-results').innerHTML = '';
    $('#add-member-error').textContent = '';
    showModal('add-member-modal');
    $('#add-member-search').focus();
  }

  function buildInviteResultRow(u) {
    const row = document.createElement('div');
    row.className = 'friend-row search-result-row';
    row.appendChild(avatarWithStatus(u));

    const meta = document.createElement('div');
    meta.className = 'friend-meta';
    meta.innerHTML = `<div class="friend-name">${escapeHtml(u.displayName)}</div><div class="friend-sub">@${escapeHtml(u.username)}</div>`;
    row.appendChild(meta);

    const action = document.createElement('div');
    action.className = 'search-result-action';
    row.appendChild(action);

    if (u.isMember) {
      action.classList.add('muted');
      action.textContent = 'Already in server';
    } else if (u.pendingInvite) {
      action.classList.add('muted');
      action.textContent = 'Invite sent';
    } else {
      action.classList.add('addable');
      action.textContent = '+ Invite';
      row.classList.add('clickable');
      row.addEventListener('click', () => {
        if (!row.classList.contains('clickable')) return;
        inviteFromSearch(u, row, action);
      });
    }

    return row;
  }

  function inviteFromSearch(u, row, action) {
    row.classList.remove('clickable');
    row.classList.add('sending');
    action.textContent = 'Sending...';
    $('#add-member-error').textContent = '';
    Api.groups.sendInvite(AppState.activeGroup.id, u.id)
      .then(() => {
        row.classList.remove('sending');
        action.classList.remove('addable');
        action.classList.add('muted');
        action.textContent = 'Invite sent';
      })
      .catch((err) => {
        row.classList.remove('sending');
        row.classList.add('clickable');
        action.textContent = '+ Invite';
        $('#add-member-error').textContent = err.message;
      });
  }

  function renderInviteResults(users) {
    const el = $('#add-member-results');
    el.innerHTML = '';
    if (users.length === 0) {
      el.innerHTML = '<div class="empty-list-hint">No matching usernames.</div>';
      return;
    }
    users.forEach((u) => el.appendChild(buildInviteResultRow(u)));
  }

  function runInviteSearch(query) {
    const myToken = ++inviteSearchToken;
    if (!query || !AppState.activeGroup) {
      $('#add-member-results').innerHTML = '';
      return;
    }
    Api.groups.searchInvitable(AppState.activeGroup.id, query)
      .then((data) => {
        if (myToken !== inviteSearchToken) return; // a newer search superseded this one
        renderInviteResults(data.users);
      })
      .catch(() => {
        if (myToken !== inviteSearchToken) return;
        $('#add-member-results').innerHTML = '<div class="empty-list-hint">Search failed, try again.</div>';
      });
  }

  function openCreateChannelModal(type) {
    if (!AppState.activeGroup) return;
    setCreateChannelType(type || 'text');
    $('#create-channel-name').value = '';
    $('#create-channel-error').textContent = '';
    // The modal is always opened from a specific "+" (Text or Voice), so
    // lock the type to that choice instead of letting it be switched —
    // the Text "+" only ever creates text channels, Voice "+" only voice.
    $('#channel-type-toggle').classList.add('hidden');
    $('#channel-type-locked').textContent = createChannelType === 'voice' ? '🔊 Voice Channel' : '💬 Text Channel';
    showModal('create-channel-modal');
  }

  function setCreateChannelType(type) {
    createChannelType = type;
    $('#channel-type-text').classList.toggle('active', type === 'text');
    $('#channel-type-voice').classList.toggle('active', type === 'voice');
  }

  function renderGroupIconPreview() {
    const preview = $('#group-settings-photo-preview');
    preview.innerHTML = '';
    if (selectedGroupIconUrl) {
      const img = document.createElement('img');
      img.src = selectedGroupIconUrl;
      img.alt = 'Group photo preview';
      preview.appendChild(img);
    } else if (AppState.activeGroup?.name) {
      preview.textContent = initials(AppState.activeGroup.name);
    } else {
      preview.textContent = '?';
    }
    $('#group-settings-remove-photo-btn').classList.toggle('hidden', !selectedGroupIconUrl);
  }

  function openGroupSettingsPanel() {
    if (!AppState.activeGroup) return;
    $('#group-settings-name').value = AppState.activeGroup.name;
    $('#group-settings-error').textContent = '';
    selectedGroupIconUrl = AppState.activeGroup.iconUrl || null;
    pendingGroupIconFile = null;
    renderGroupIconPreview();

    $('#chat-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#group-settings-panel').classList.remove('hidden');
    $('#group-settings-name').focus();
  }

  function closeGroupSettingsPanel() {
    $('#group-settings-panel').classList.add('hidden');
    if (AppState.activeChat) {
      $('#chat-panel').classList.remove('hidden');
    } else {
      $('#empty-state').classList.remove('hidden');
    }
  }

  function saveGroupSettings() {
    const name = $('#group-settings-name').value.trim();
    $('#group-settings-error').textContent = '';
    if (!name) { $('#group-settings-error').textContent = 'Group name is required'; return; }

    const groupId = AppState.activeGroup.id;

    const finalizeSave = (iconUrl) => {
      Api.groups.rename(groupId, name, iconUrl)
        .then(({ group }) => {
          AppState.activeGroup = group;
          $('#sidebar-header').textContent = group.name;
          closeGroupSettingsPanel();
          return refresh().then(() => {
            const el = document.querySelector(`.rail-item[data-group-id="${group.id}"]`);
            if (el) App.setActiveRail(el);
          });
        })
        .catch((err) => { $('#group-settings-error').textContent = err.message; });
    };

    if (pendingGroupIconFile) {
      $('#group-settings-error').textContent = 'Uploading image...';
      Api.messages.upload(pendingGroupIconFile)
        .then((data) => {
          finalizeSave(data.url);
        })
        .catch((err) => {
          $('#group-settings-error').textContent = err.message;
        });
      return;
    }

    finalizeSave(selectedGroupIconUrl || null);
  }

  function openLeaveGroupModal() {
    if (!AppState.activeGroup) return;
    $('#leave-group-message').textContent = `Are you sure you want to leave "${AppState.activeGroup.name}"?`;
    showModal('leave-group-modal');
  }

  function leaveActiveGroup() {
    if (!AppState.activeGroup) return;
    const groupId = AppState.activeGroup.id;
    closeModals();
    Api.groups.leave(groupId)
      .then(() => {
        if (VoiceChat.isConnectedToGroup(groupId)) VoiceChat.leaveCurrent();
        AppState.activeGroup = null;
        AppState.activeChat = null;
        return refresh();
      })
      .then(() => App.showFriendsHome())
      .catch((err) => alert(err.message));
  }

  // Called when a join request we sent gets accepted (via the group:joined
  // socket event) — refresh the rail and hop into the newly-joined group.
  function handleJoined(g) {
    return refresh().then(() => {
      const joined = AppState.groupsData.find((x) => x.id === g.id);
      if (joined) open(joined);
    });
  }

  // Someone else added us to a group directly (checked us off when creating
  // it, or used the direct add-member endpoint) rather than us accepting an
  // invite/join request — just make the new server show up in the rail
  // live, without yanking the person away from whatever they're doing.
  function handleAdded() {
    return refresh();
  }

  // Another member renamed the group or changed its icon — update the rail
  // and, if we're currently looking at this group, the sidebar header too.
  function handleGroupUpdated(group) {
    const idx = AppState.groupsData.findIndex((g) => g.id === group.id);
    if (idx !== -1) {
      AppState.groupsData[idx] = group;
      renderRail();
    }
    if (AppState.activeGroup && AppState.activeGroup.id === group.id) {
      AppState.activeGroup = group;
      $('#sidebar-header').textContent = group.name;
    }
  }

  // A friend/member changed their display name, avatar, or colors — refresh
  // this group's member list live if we're looking at one they're in.
  function handleProfileUpdated(user) {
    if (AppState.activeGroup && AppState.activeMemberIds.includes(user.id)) {
      refreshActiveMembers(AppState.activeGroup.id);
    }
  }

  // Shared by the group:member-added / group:member-removed socket
  // handlers — simplest to just refetch the member list rather than
  // patch it in place, and it's a small, infrequent request.
  function refreshActiveMembers(groupId) {
    if (!AppState.activeGroup || AppState.activeGroup.id !== groupId) return;
    return Api.groups.members(groupId).then((data) => {
      AppState.activeMemberIds = data.members.map((m) => m.id);
      renderMembers(data.members);
    });
  }

  // Another member created a channel — drop it into the sidebar live if
  // we're looking at this group (idempotent in case our own client already
  // added it via the REST response to our own create-channel call).
  function handleChannelCreated(channel) {
    if (!AppState.activeGroup || channel.groupId !== AppState.activeGroup.id) return;
    if (AppState.activeGroupChannels.some((c) => c.id === channel.id)) return;
    AppState.activeGroupChannels.push(channel);
    renderChannels();
  }

  function handleChannelRenamed(channel) {
    const idx = AppState.activeGroupChannels.findIndex((c) => c.id === channel.id);
    if (idx !== -1) {
      AppState.activeGroupChannels[idx] = channel;
      renderChannels();
    }
    if (AppState.activeChat && AppState.activeChat.type === 'channel' && AppState.activeChat.id === channel.id) {
      AppState.activeChat.name = channel.name;
      $('#chat-title').textContent = `# ${channel.name}`;
    }
  }

  function handleChannelDeleted(channelId, groupId) {
    if (AppState.activeGroup && AppState.activeGroup.id === groupId) {
      AppState.activeGroupChannels = AppState.activeGroupChannels.filter((c) => c.id !== channelId);
      renderChannels();
    }
    if (AppState.activeChat && AppState.activeChat.type === 'channel' && AppState.activeChat.id === channelId) {
      AppState.activeChat = null;
      $('#empty-state').classList.remove('hidden');
      $('#chat-panel').classList.add('hidden');
    }
  }

  function initUI() {
    // A channel's "..." menu opens on click; clicking anywhere else in the
    // document (another channel, the chat area, etc.) should close it,
    // instead of requiring the user to click the same button again.
    document.addEventListener('click', (e) => {
      if (e.target.closest('.channel-actions')) return;
      $$('.channel-actions.open').forEach((el) => el.classList.remove('open'));
    });

    $('#member-card-backdrop').addEventListener('click', closeMemberCard);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMemberCard();
    });

    $('#rail-add-group').addEventListener('click', openSelectActionModal);

    $('#select-group-action-cancel').addEventListener('click', closeModals);
    $('#select-group-action-close').addEventListener('click', closeModals);
    $('#select-create-group').addEventListener('click', openCreateModal);
    $('#select-join-group').addEventListener('click', openJoinModal);

    $('#create-group-cancel').addEventListener('click', closeModals);
    $('#create-group-close').addEventListener('click', closeModals);
    $('#create-group-back').addEventListener('click', openSelectActionModal);
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay')) closeModals();
    });

    $('#join-group-cancel').addEventListener('click', closeModals);
    $('#join-group-close').addEventListener('click', closeModals);
    $('#join-group-back').addEventListener('click', openSelectActionModal);
    $('#join-group-search').addEventListener('input', () => {
      const query = $('#join-group-search').value.trim();
      $('#join-group-error').textContent = '';
      clearTimeout(joinSearchDebounce);
      joinSearchDebounce = setTimeout(() => runJoinSearch(query), 250);
    });

    Utils.makeModalDraggable($('#select-group-action-modal'));
    Utils.makeModalDraggable($('#create-group-modal'));
    Utils.makeModalDraggable($('#join-group-modal'));

    $('#create-group-confirm').addEventListener('click', () => {
      const name = $('#create-group-name').value.trim();
      if (!name) return;
      const memberIds = Array.from($('#create-group-friends').querySelectorAll('input:checked')).map((i) => Number(i.value));
      Api.groups.create(name, memberIds)
        .then(({ group }) =>
          // Seed every new group with a default text + voice channel, same as Discord.
          Promise.all([
            Api.channels.create(group.id, 'general', 'text'),
            Api.channels.create(group.id, 'General', 'voice')
          ]).then(() => group)
        )
        .then((group) => {
          closeModals();
          return refresh().then(() => {
            const g = AppState.groupsData.find((x) => x.id === group.id);
            if (g) open(g);
          });
        })
        .catch((err) => alert(err.message));
    });

    $('#group-settings-btn').addEventListener('click', openGroupSettingsPanel);
    $('#group-settings-cancel').addEventListener('click', closeGroupSettingsPanel);
    $('#group-settings-close').addEventListener('click', closeGroupSettingsPanel);
    $('#group-settings-save').addEventListener('click', saveGroupSettings);
    $('#group-settings-upload-btn').addEventListener('click', () => $('#group-settings-file').click());
    $('#group-settings-remove-photo-btn').addEventListener('click', () => {
      selectedGroupIconUrl = null;
      pendingGroupIconFile = null;
      renderGroupIconPreview();
    });
    $('#group-settings-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingGroupIconFile = file;
      const reader = new FileReader();
      reader.onload = () => {
        selectedGroupIconUrl = reader.result;
        renderGroupIconPreview();
      };
      reader.readAsDataURL(file);
      e.target.value = '';
    });
    $('#group-settings-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveGroupSettings();
    });

    $('#group-add-member-btn').addEventListener('click', openAddMemberModal);
    $('#add-member-cancel').addEventListener('click', closeModals);
    $('#add-member-close').addEventListener('click', closeModals);
    Utils.makeModalDraggable($('#add-member-modal'));
    $('#add-member-search').addEventListener('input', () => {
      const query = $('#add-member-search').value.trim();
      $('#add-member-error').textContent = '';
      clearTimeout(inviteSearchDebounce);
      inviteSearchDebounce = setTimeout(() => runInviteSearch(query), 250);
    });

    $('#channel-type-text').addEventListener('click', () => setCreateChannelType('text'));
    $('#channel-type-voice').addEventListener('click', () => setCreateChannelType('voice'));
    $('#create-channel-cancel').addEventListener('click', closeModals);
    $('#create-channel-confirm').addEventListener('click', () => {
      const name = $('#create-channel-name').value.trim();
      $('#create-channel-error').textContent = '';
      if (!name) return;
      Api.channels.create(AppState.activeGroup.id, name, createChannelType)
        .then(() => {
          closeModals();
          return loadChannels(AppState.activeGroup.id);
        })
        .catch((err) => { $('#create-channel-error').textContent = err.message; });
    });

    $('#rename-channel-cancel').addEventListener('click', closeModals);
    $('#rename-channel-confirm').addEventListener('click', confirmRenameChannel);
    $('#delete-channel-cancel').addEventListener('click', closeModals);
    $('#delete-channel-confirm').addEventListener('click', confirmDeleteChannel);

    const leaveBtn = $('#group-leave-btn');
    if (leaveBtn) leaveBtn.addEventListener('click', openLeaveGroupModal);

    $('#leave-group-cancel').addEventListener('click', closeModals);
    $('#leave-group-close').addEventListener('click', closeModals);
    $('#leave-group-confirm').addEventListener('click', leaveActiveGroup);
    Utils.makeModalDraggable($('#leave-group-modal'));
  }

  return {
    refresh,
    open,
    initUI,
    refreshChannelHighlight,
    handleJoined,
    handleAdded,
    handleGroupUpdated,
    handleProfileUpdated,
    refreshActiveMembers,
    handleChannelCreated,
    handleChannelRenamed,
    handleChannelDeleted,
    handleVoiceRosterUpdate,
    markGroupUnread,
    clearGroupUnread,
    markChannelUnread,
    clearChannelUnread,
    markDmUnread,
    clearDmUnread
  };
})();