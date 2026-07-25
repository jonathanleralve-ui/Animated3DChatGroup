// Voice channel membership + WebRTC signaling relay (mesh topology, one
// RTCPeerConnection per pair — the actual media never touches the server,
// we just relay offers/answers/ICE candidates between peers).
// Rooms are keyed by voice CHANNEL id now (a group can have several voice channels).

// channelId -> Map of socketId -> { userId, displayName, avatarColor, avatarUrl, nameColor, sharing }
const voiceRooms = new Map();

function voiceRoom(channelId) {
  if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Map());
  return voiceRooms.get(channelId);
}

function voicePeerList(channelId) {
  return Array.from(voiceRoom(channelId).entries()).map(([socketId, info]) => ({
    socketId,
    ...info
  }));
}

// Simplified snapshot used for the channel list in the sidebar — every group
// member sees this, not just people currently in the call.
function getRoster(channelId) {
  return Array.from(voiceRoom(channelId).values()).map((info) => ({
    userId: info.userId,
    displayName: info.displayName,
    avatarColor: info.avatarColor,
    avatarUrl: info.avatarUrl,
    nameColor: info.nameColor,
    avatarModelUrl: info.avatarModelUrl,
    avatarMode: info.avatarMode,
    avatarModelZoom: info.avatarModelZoom,
    avatarModelOffsetX: info.avatarModelOffsetX,
    avatarModelOffsetY: info.avatarModelOffsetY,
    avatarModelRotationY: info.avatarModelRotationY,
    avatarModelMouthIntensity: info.avatarModelMouthIntensity,
    avatarModelVoiceStart: info.avatarModelVoiceStart,
    avatarModelVoiceMax: info.avatarModelVoiceMax,
    avatarModelBlinkIntensity: info.avatarModelBlinkIntensity,
    avatarModelBlinkIntervalMin: info.avatarModelBlinkIntervalMin,
    avatarModelBlinkIntervalMax: info.avatarModelBlinkIntervalMax,
    avatarModelBlinkEnabled: info.avatarModelBlinkEnabled,
    avatarModelLookEnabled: info.avatarModelLookEnabled,
    sharing: info.sharing,
    muted: info.muted
  }));
}

function broadcastRoster(io, channelId) {
  io.to(`channel:${channelId}`).emit('voice:roster-update', { channelId, participants: getRoster(channelId) });
}

function leaveVoiceChannel(io, socket, channelId) {
  if (!channelId) return;
  const room = voiceRoom(channelId);
  if (room.has(socket.id)) {
    room.delete(socket.id);
    socket.leave(`voice:${channelId}`);
    io.to(`voice:${channelId}`).emit('voice:peer-left', { socketId: socket.id });
    broadcastRoster(io, channelId);
  }
  if (socket.currentVoiceChannel === channelId) socket.currentVoiceChannel = null;
  if (room.size === 0) voiceRooms.delete(channelId);
}

function registerVoiceHandlers(io, socket, db) {
  const uid = socket.userId;

  socket.on('voice:join', async ({ channelId, muted }) => {
    try {
      const cid = Number(channelId);

      const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [cid]);
      const channel = channelResult.rows[0];
      if (!channel) {
        socket.emit('error:message', { error: 'Voice channel not found' });
        return;
      }

      const isMember = await db.query(
        'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
        [channel.group_id, uid]
      );
      if (isMember.rows.length === 0) {
        socket.emit('error:message', { error: 'Not a member of this group' });
        return;
      }

      // A socket can only be in one voice channel at a time — leave any previous one first
      if (socket.currentVoiceChannel) {
        leaveVoiceChannel(io, socket, socket.currentVoiceChannel);
      }

      const userResult = await db.query('SELECT display_name, avatar_color, avatar_url, name_color, avatar_model_url, avatar_mode, avatar_model_zoom, avatar_model_offset_x, avatar_model_offset_y, avatar_model_rotation_y, avatar_model_mouth_intensity, avatar_model_voice_start, avatar_model_voice_max, avatar_model_blink_intensity, avatar_model_blink_interval_min, avatar_model_blink_interval_max, avatar_model_blink_enabled, avatar_model_look_enabled FROM users WHERE id = $1', [uid]);
      const user = userResult.rows[0];

      // Tell the joining client who is already in the channel, so it can initiate connections to each
      socket.emit('voice:existing-peers', { peers: voicePeerList(cid) });

      const info = {
        userId: uid, displayName: user.display_name, avatarColor: user.avatar_color, avatarUrl: user.avatar_url,
        nameColor: user.name_color, avatarModelUrl: user.avatar_model_url, avatarMode: user.avatar_mode,
        avatarModelZoom: user.avatar_model_zoom, avatarModelOffsetX: user.avatar_model_offset_x, avatarModelOffsetY: user.avatar_model_offset_y,
        avatarModelRotationY: user.avatar_model_rotation_y,
        avatarModelMouthIntensity: user.avatar_model_mouth_intensity,
        avatarModelVoiceStart: user.avatar_model_voice_start,
        avatarModelVoiceMax: user.avatar_model_voice_max,
        avatarModelBlinkIntensity: user.avatar_model_blink_intensity,
        avatarModelBlinkIntervalMin: user.avatar_model_blink_interval_min,
        avatarModelBlinkIntervalMax: user.avatar_model_blink_interval_max,
        avatarModelBlinkEnabled: user.avatar_model_blink_enabled,
        avatarModelLookEnabled: user.avatar_model_look_enabled,
        sharing: false, muted: !!muted
      };
      voiceRoom(cid).set(socket.id, info);
      socket.currentVoiceChannel = cid;
      socket.join(`voice:${cid}`);

      socket.to(`voice:${cid}`).emit('voice:peer-joined', { socketId: socket.id, ...info });
      broadcastRoster(io, cid);
    } catch (err) {
      console.error('voice:join error', err);
      socket.emit('error:message', { error: 'Failed to join voice channel' });
    }
  });

  socket.on('voice:leave', ({ channelId }) => {
    leaveVoiceChannel(io, socket, Number(channelId));
  });

  // Relay WebRTC offers/answers/ICE candidates directly to a specific peer socket
  socket.on('voice:signal', ({ to, data }) => {
    if (!to) return;
    io.to(to).emit('voice:signal', { from: socket.id, data });
  });

  socket.on('voice:screen-share-toggle', ({ channelId, sharing }) => {
    const cid = Number(channelId);
    const room = voiceRoom(cid);
    const info = room.get(socket.id);
    if (!info) return;
    info.sharing = !!sharing;
    io.to(`voice:${cid}`).emit('voice:peer-screen-update', { socketId: socket.id, sharing: info.sharing });
    broadcastRoster(io, cid);
  });

  socket.on('voice:mute-toggle', ({ channelId, muted }) => {
    const cid = Number(channelId);
    const room = voiceRoom(cid);
    const info = room.get(socket.id);
    if (!info) return;
    info.muted = !!muted;
    io.to(`voice:${cid}`).emit('voice:peer-mute-update', { socketId: socket.id, muted: info.muted });
    broadcastRoster(io, cid);
  });
}

module.exports = { registerVoiceHandlers, leaveVoiceChannel, getRoster };