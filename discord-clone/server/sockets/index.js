const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const db = require('../db');
const presence = require('./presence');
const { registerMessagingHandlers } = require('./messaging');
const { registerVoiceHandlers, leaveVoiceChannel } = require('./voice');

function initSockets(io) {
  // Every socket must present a valid JWT (same one used for the REST API) before connecting
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth && socket.handshake.auth.token;
      if (!token) return next(new Error('Missing auth token'));
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.id;
      socket.username = payload.username;
      next();
    } catch (err) {
      next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', async (socket) => {
    const uid = socket.userId;

    presence.addSocket(uid, socket.id);
    presence.broadcastStatus(io, uid, 'online').catch((err) => console.error('broadcastStatus error', err));

    // Personal room for DMs, plus a room per channel (text and voice) in
    // every group they belong to — text channels need it so messages land
    // even when that channel isn't active, and voice channels need it so
    // "who's in this voice channel" roster updates reach every member's
    // sidebar, not just the people currently in the call.
    socket.join(`user:${uid}`);
    try {
      const channels = await db.query(
        `SELECT c.id FROM channels c
         JOIN group_members gm ON gm.group_id = c.group_id
         WHERE gm.user_id = $1`,
        [uid]
      );
      channels.rows.forEach((c) => socket.join(`channel:${c.id}`));
    } catch (err) {
      console.error('Error joining channel rooms', err);
    }

    // Explicit join used when opening a text channel, in case membership/channels changed since connect
    socket.on('channel:join', async (channelId) => {
      try {
        const cid = Number(channelId);
        const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [cid]);
        const channel = channelResult.rows[0];
        if (!channel) return;

        const isMember = await db.query(
          'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
          [channel.group_id, uid]
        );
        if (isMember.rows.length > 0) socket.join(`channel:${cid}`);
      } catch (err) {
        console.error('channel:join error', err);
      }
    });

    registerMessagingHandlers(io, socket, db);
    registerVoiceHandlers(io, socket, db);

    // Round-trip latency check for the titlebar ping display: client sends
    // a timestamp, we ack immediately, client computes Date.now() - the
    // timestamp it sent to get real RTT (not socket.io's internal heartbeat,
    // which isn't exposed to app code).
    socket.on('ping:check', (clientTime, cb) => {
      if (typeof cb === 'function') cb(clientTime);
    });

    socket.on('disconnect', () => {
      if (socket.currentVoiceChannel) {
        leaveVoiceChannel(io, socket, socket.currentVoiceChannel);
      }

      const wasLast = presence.removeSocket(uid, socket.id);
      if (wasLast) {
        presence.broadcastStatus(io, uid, 'offline').catch((err) => console.error('broadcastStatus error', err));
      }
    });
  });
}

module.exports = initSockets;