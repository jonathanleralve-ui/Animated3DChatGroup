// Owns the single socket.io connection and routes incoming realtime events
// to whichever module cares about them. Chat.js / Friends.js expose small
// handler functions for this to call instead of reaching into their internals.
const SocketClient = (() => {
  function connect() {
    AppState.socket = io({ auth: { token: AppState.token } });
    const socket = AppState.socket;

    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
    });

    socket.on('presence:update', ({ userId, status }) => {
      Friends.handlePresenceUpdate(userId, status);
    });

    socket.on('dm:message', (msg) => {
      Chat.handleIncomingMessage('dm', msg);
    });

    socket.on('channel:message', (msg) => {
      Chat.handleIncomingMessage('channel', msg);
    });

    socket.on('message:deleted', ({ id }) => {
      Chat.handleMessageDeleted(id);
    });

    socket.on('group:join-request-resolved', ({ requestId, status }) => {
      Chat.handleJoinRequestResolved(requestId, status);
    });

    socket.on('group:invite-resolved', ({ inviteId, status }) => {
      Chat.handleGroupInviteResolved(inviteId, status);
    });

    socket.on('friend:request', () => Friends.refresh());
    socket.on('friend:accepted', () => Friends.refresh());
    socket.on('friend:removed', () => Friends.refresh());

    socket.on('profile:updated', ({ user }) => {
      Friends.handleProfileUpdated(user);
      Groups.handleProfileUpdated(user);
      Chat.handleProfileUpdated(user);
    });

    socket.on('group:updated', ({ group }) => {
      Groups.handleGroupUpdated(group);
    });

    socket.on('group:member-added', ({ groupId }) => {
      Groups.refreshActiveMembers(groupId);
    });

    socket.on('group:member-removed', ({ groupId }) => {
      Groups.refreshActiveMembers(groupId);
    });

    socket.on('channel:created', ({ channel }) => {
      Groups.handleChannelCreated(channel);
    });

    socket.on('channel:renamed', ({ channel }) => {
      Groups.handleChannelRenamed(channel);
    });

    socket.on('channel:deleted', ({ channelId, groupId }) => {
      Groups.handleChannelDeleted(channelId, groupId);
    });

    socket.on('group:joined', ({ group }) => {
      Groups.handleJoined(group);
    });

    socket.on('group:added', ({ group }) => {
      Groups.handleAdded(group);
    });

    socket.on('voice:roster-update', ({ channelId, participants }) => {
      Groups.handleVoiceRosterUpdate(channelId, participants);
    });

    socket.on('typing', ({ scope, from, channelId, senderName, senderNameColor }) => {
      Chat.handleTypingEvent(scope, from, channelId, senderName, senderNameColor);
    });

    socket.on('error:message', ({ error }) => {
      alert(error);
    });

    startPingLoop(socket);

    return socket;
  }

  // Pings the server every few seconds via an acked event and shows the
  // round-trip time in the titlebar. Colored like a typical ping meter:
  // green = good, yellow = mid, red = poor, grey = disconnected.
  function startPingLoop(socket) {
    const el = document.getElementById('site-titlebar-ping');
    if (!el) return;

    if (AppState.pingInterval) clearInterval(AppState.pingInterval);

    const setPing = (ms) => {
      el.classList.remove('ping-ok', 'ping-bad', 'ping-down');
      if (ms == null) {
        el.textContent = '-- ms';
        el.classList.add('ping-down');
        return;
      }
      el.textContent = `${ms} ms`;
      if (ms > 100) el.classList.add('ping-bad');
      else if (ms > 50) el.classList.add('ping-ok');
    };

    const sendPing = () => {
      if (!socket.connected) {
        setPing(null);
        return;
      }
      const sentAt = Date.now();
      socket.timeout(5000).emit('ping:check', sentAt, (err) => {
        if (err) { setPing(null); return; }
        setPing(Date.now() - sentAt);
      });
    };

    socket.on('disconnect', () => setPing(null));
    socket.on('connect', sendPing);

    sendPing();
    AppState.pingInterval = setInterval(sendPing, 1000);
  }

  return { connect };
})();