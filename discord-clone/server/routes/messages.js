const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function formatMessage(m, senderMap) {
  const sender = senderMap[m.sender_id];
  return {
    id: m.id,
    content: m.content,
    createdAt: m.created_at,
    senderId: m.sender_id,
    senderName: sender ? sender.display_name : 'Unknown',
    senderColor: sender ? sender.avatar_color : '#5865F2',
    senderAvatarUrl: sender ? sender.avatar_url : null,
    senderNameColor: sender ? sender.name_color : null,
    recipientId: m.recipient_id,
    channelId: m.channel_id,
    messageType: m.message_type || 'text',
    joinRequest: m.join_request_id
      ? { id: m.join_request_id, status: m.join_request_status, userId: m.join_request_user_id, groupId: m.group_id }
      : null,
    groupInvite: m.group_invite_id
      ? {
          id: m.group_invite_id,
          status: m.group_invite_status,
          groupId: m.invite_group_id,
          groupName: m.invite_group_name,
          groupIconColor: m.invite_group_icon_color,
          groupIconUrl: m.invite_group_icon_url,
          inviterId: m.invite_inviter_id,
          inviteeId: m.invite_invitee_id
        }
      : null,
    attachment: m.attachment_url
      ? {
          url: m.attachment_url,
          name: m.attachment_name,
          type: m.attachment_type,
          size: m.attachment_size
        }
      : null
  };
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    nameColor: u.name_color,
    status: u.status,
    bannerUrl: u.banner_url,
    bannerZoom: u.banner_zoom,
    bannerOffsetX: u.banner_offset_x,
    bannerOffsetY: u.banner_offset_y
  };
}

async function buildSenderMap(messages) {
  const ids = [...new Set(messages.map((m) => m.sender_id))];
  if (ids.length === 0) return {};
  const result = await db.query('SELECT id, display_name, avatar_color, avatar_url, name_color FROM users WHERE id = ANY($1)', [ids]);
  const map = {};
  result.rows.forEach((r) => (map[r.id] = r));
  return map;
}

router.get('/others', async (req, res) => {
  try {
    const uid = req.user.id;
    const result = await db.query(
      `SELECT DISTINCT u.* FROM users u
       JOIN messages m ON (m.sender_id = u.id AND m.recipient_id = $1) OR (m.recipient_id = u.id AND m.sender_id = $1)
       WHERE u.id != $1
       AND NOT EXISTS (
         SELECT 1 FROM friendships f
         WHERE f.status = 'accepted'
         AND ((f.requester_id = $1 AND f.addressee_id = u.id) OR (f.requester_id = u.id AND f.addressee_id = $1))
       )`,
      [uid]
    );
    res.json({ users: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

const PAGE_SIZE = 200;

// DM history with a specific friend
router.get('/dm/:userId', async (req, res) => {
  try {
    const uid = req.user.id;
    const otherId = Number(req.params.userId);
    const before = req.query.before ? Number(req.query.before) : null;

    const friendshipResult = await db.query(
      `SELECT * FROM friendships WHERE status = 'accepted' AND
       ((requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1))`,
      [uid, otherId]
    );
    if (friendshipResult.rows.length === 0) {
      // Not friends — still allow it if they share a group (e.g. clicked
      // from the members tab), same rule enforced on the socket side.
      const sharedGroupResult = await db.query(
        `SELECT 1 FROM group_members gm1
         JOIN group_members gm2 ON gm2.group_id = gm1.group_id
         WHERE gm1.user_id = $1 AND gm2.user_id = $2 LIMIT 1`,
        [uid, otherId]
      );
      if (sharedGroupResult.rows.length === 0) {
        // Still allow it if a server invite connects the two of them —
        // that's delivered as a DM card and needs to be visible/actionable
        // even between people who aren't friends and don't share a group yet.
        const inviteConnection = await db.query(
          `SELECT 1 FROM group_invites WHERE
           (inviter_id = $1 AND invitee_id = $2) OR (inviter_id = $2 AND invitee_id = $1) LIMIT 1`,
          [uid, otherId]
        );
        if (inviteConnection.rows.length === 0) {
          return res.status(403).json({ error: 'You are not friends with this user' });
        }
      }
    }

    const params = [uid, otherId];
    let cursorClause = '';
    if (before) {
      params.push(before);
      cursorClause = `AND m.id < $${params.length}`;
    }

    const messagesResult = await db.query(
      `SELECT m.*,
              gi.status AS group_invite_status,
              gi.group_id AS invite_group_id,
              gi.inviter_id AS invite_inviter_id,
              gi.invitee_id AS invite_invitee_id,
              g.name AS invite_group_name,
              g.icon_color AS invite_group_icon_color,
              g.icon_url AS invite_group_icon_url
       FROM messages m
       LEFT JOIN group_invites gi ON gi.id = m.group_invite_id
       LEFT JOIN groups g ON g.id = gi.group_id
       WHERE
       ((m.sender_id = $1 AND m.recipient_id = $2) OR (m.sender_id = $2 AND m.recipient_id = $1))
       ${cursorClause}
       ORDER BY m.id DESC LIMIT ${PAGE_SIZE}`,
      params
    );

    // Query pulls back the most recent page newest-first so LIMIT keeps the
    // right end of a long history; flip back to ascending for display.
    const rows = messagesResult.rows.reverse();
    const senderMap = await buildSenderMap(rows);
    res.json({
      messages: rows.map((m) => formatMessage(m, senderMap)),
      hasMore: messagesResult.rows.length === PAGE_SIZE
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Message history for a single text channel
router.get('/channel/:channelId', async (req, res) => {
  try {
    const uid = req.user.id;
    const channelId = Number(req.params.channelId);
    const before = req.query.before ? Number(req.query.before) : null;

    const channelResult = await db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    const channel = channelResult.rows[0];
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [channel.group_id, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const params = [channelId];
    let cursorClause = '';
    if (before) {
      params.push(before);
      cursorClause = `AND m.id < $${params.length}`;
    }

    const messagesResult = await db.query(
      `SELECT m.*, gjr.status AS join_request_status, gjr.user_id AS join_request_user_id
       FROM messages m
       LEFT JOIN group_join_requests gjr ON gjr.id = m.join_request_id
       WHERE m.channel_id = $1 ${cursorClause}
       ORDER BY m.id DESC LIMIT ${PAGE_SIZE}`,
      params
    );

    // Same newest-first-then-reverse trick as the DM route above.
    const rows = messagesResult.rows.reverse();
    const senderMap = await buildSenderMap(rows);
    res.json({
      messages: rows.map((m) => formatMessage(m, senderMap)),
      hasMore: messagesResult.rows.length === PAGE_SIZE
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;