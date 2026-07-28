// Voice channel membership + WebRTC signaling relay (mesh topology, one
// RTCPeerConnection per pair — the actual media never touches the server,
// we just relay offers/answers/ICE candidates between peers).
// Rooms are keyed by voice CHANNEL id now (a group can have several voice channels).

// channelId -> Map of socketId -> { userId, displayName, avatarColor, avatarUrl, nameColor, sharing }
const voiceRooms = new Map();

// channelId -> Map of strokeId -> { tool, color, size, points: [{x,y}], text? }
// the shared whiteboard for that voice channel. Kept in memory only (same
// lifetime as voiceRooms) and wiped once the channel empties out, same as
// the rest of the call state. strokeId is always `${socketId}-...`, which
// doubles as an ownership check for undo (see voice:draw-undo below).
const voiceDraw = new Map();
const MAX_STROKES_PER_CHANNEL = 400; // oldest strokes drop off past this to bound memory

function drawState(channelId) {
  if (!voiceDraw.has(channelId)) voiceDraw.set(channelId, new Map());
  return voiceDraw.get(channelId);
}

function getDrawStrokes(channelId) {
  return Array.from(drawState(channelId).entries()).map(([id, s]) => ({ id, ...s }));
}

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
    avatarModelBlinkShapeKeys: info.avatarModelBlinkShapeKeys,
    avatarModelMouthShapeKeys: info.avatarModelMouthShapeKeys,
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
  if (room.size === 0) {
    voiceRooms.delete(channelId);
    voiceDraw.delete(channelId);
  }
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

      const userResult = await db.query('SELECT display_name, avatar_color, avatar_url, name_color, avatar_model_url, avatar_mode, avatar_model_zoom, avatar_model_offset_x, avatar_model_offset_y, avatar_model_rotation_y, avatar_model_mouth_intensity, avatar_model_voice_start, avatar_model_voice_max, avatar_model_blink_intensity, avatar_model_blink_interval_min, avatar_model_blink_interval_max, avatar_model_blink_enabled, avatar_model_blink_shape_keys, avatar_model_mouth_shape_keys, avatar_model_look_enabled FROM users WHERE id = $1', [uid]);
      const user = userResult.rows[0];

      // Tell the joining client who is already in the channel, so it can initiate connections to each
      socket.emit('voice:existing-peers', { peers: voicePeerList(cid) });
      // ...and hand them whatever's already been drawn on this channel's whiteboard
      socket.emit('voice:draw-state', { strokes: getDrawStrokes(cid) });

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
        avatarModelBlinkShapeKeys: user.avatar_model_blink_shape_keys,
        avatarModelMouthShapeKeys: user.avatar_model_mouth_shape_keys,
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

  // Relays where the sender's avatar is looking (dx/dy, both -1..1) so
  // other participants' copies of that avatar turn to match. High-frequency
  // and purely visual, so this skips voiceRoom bookkeeping and the
  // roster/broadcastRoster machinery entirely - just a direct relay to
  // everyone else in the room, same as voice:signal.
  socket.on('voice:gaze', ({ channelId, dx, dy }) => {
    const cid = Number(channelId);
    if (cid !== socket.currentVoiceChannel) return;
    socket.to(`voice:${cid}`).emit('voice:gaze', { socketId: socket.id, dx, dy });
  });

  const VALID_TOOLS = new Set(['pen', 'eraser', 'line', 'rect', 'ellipse', 'text']);

  // Shared whiteboard: relay a batch of points (freehand pen/eraser points,
  // or the complete outline of a shape, or a single placement point for
  // text) to the rest of the channel and append them to the stored stroke
  // so late joiners can catch up via voice:draw-state above.
  socket.on('voice:draw-point', ({ channelId, strokeId, tool, color, size, text, points }) => {
    const cid = Number(channelId);
    if (cid !== socket.currentVoiceChannel || !strokeId || !Array.isArray(points) || points.length === 0) return;
    // strokeIds are minted client-side as `${socket.id}-...` - reject anyone
    // trying to write a stroke under another socket's id.
    if (!strokeId.startsWith(`${socket.id}-`)) return;

    const state = drawState(cid);
    let stroke = state.get(strokeId);
    if (!stroke) {
      if (state.size >= MAX_STROKES_PER_CHANNEL) {
        const oldestId = state.keys().next().value;
        state.delete(oldestId);
      }
      stroke = {
        tool: VALID_TOOLS.has(tool) ? tool : 'pen',
        color: String(color || '#ffffff'),
        size: Number(size) || 4,
        points: []
      };
      if (typeof text === 'string') stroke.text = text.slice(0, 200);
      state.set(strokeId, stroke);
    }
    // x is a fraction of panel width, bounded to the visible [0,1] range.
    // y is ALSO a fraction of panel width (not height) - see voice-draw.js -
    // so a panel taller than it is wide is completely normal; only floor it
    // at 0 and cap it generously to guard against bad/malicious input.
    const clean = points
      .filter((p) => p && typeof p.x === 'number' && typeof p.y === 'number')
      .map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(20, Math.max(0, p.y)) }));
    stroke.points.push(...clean);

    socket.to(`voice:${cid}`).emit('voice:draw-point', {
      strokeId, tool: stroke.tool, color: stroke.color, size: stroke.size, text: stroke.text, points: clean
    });
  });

  // Undo: only the socket that created a stroke (same id prefix) may remove it.
  socket.on('voice:draw-undo', ({ channelId, strokeId }) => {
    const cid = Number(channelId);
    if (cid !== socket.currentVoiceChannel || !strokeId) return;
    if (!strokeId.startsWith(`${socket.id}-`)) return;
    const state = drawState(cid);
    if (!state.delete(strokeId)) return;
    socket.to(`voice:${cid}`).emit('voice:draw-undo', { strokeId });
  });

  socket.on('voice:draw-clear', ({ channelId }) => {
    const cid = Number(channelId);
    if (cid !== socket.currentVoiceChannel) return;
    voiceDraw.delete(cid);
    io.to(`voice:${cid}`).emit('voice:draw-clear');
  });
}

module.exports = { registerVoiceHandlers, leaveVoiceChannel, getRoster };