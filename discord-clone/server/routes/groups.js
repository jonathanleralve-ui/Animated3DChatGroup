const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { getRoster } = require('../sockets/voice');

const router = express.Router();
router.use(auth);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    nameColor: u.name_color,
    bannerUrl: u.banner_url,
    bannerZoom: u.banner_zoom,
    bannerOffsetX: u.banner_offset_x,
    bannerOffsetY: u.banner_offset_y,
    avatarBorderStyle: u.avatar_border_style,
    avatarBorderColor: u.avatar_border_color,
    profileAccentColor: u.profile_accent_color,
    status: u.status
  };
}

const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// Every connected socket joins a `user:${id}` room for the lifetime of its
// connection (see sockets/index.js), regardless of what groups/channels it
// belongs to — so broadcasting a group-wide change is just "look up who's
// in the group right now and emit to each of their user rooms" rather than
// needing a dedicated per-group socket room to stay in sync with membership.
async function memberUserIds(groupId) {
  const result = await db.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
  return result.rows.map((r) => r.user_id);
}
function memberRooms(userIds) {
  return userIds.map((id) => `user:${id}`);
}

// List groups the current user belongs to
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.* FROM groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       ORDER BY g.created_at ASC`,
      [req.user.id]
    );

    res.json({
      groups: result.rows.map((g) => ({
        id: g.id,
        name: g.name,
        iconColor: g.icon_color,
        iconUrl: g.icon_url,
        ownerId: g.owner_id
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Create a group (creator becomes owner + member); optional initial member usernames/ids
router.post('/', async (req, res) => {
  const client = await db.pool.connect();
  try {
    const { name, memberIds } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Group name is required' });

    const uid = req.user.id;

    await client.query('BEGIN');

    const inserted = await client.query(
      'INSERT INTO groups (name, icon_color, owner_id) VALUES ($1, $2, $3) RETURNING *',
      [String(name).trim().slice(0, 50), randomColor(), uid]
    );
    const group = inserted.rows[0];

    await client.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [group.id, uid]);

    if (Array.isArray(memberIds)) {
      for (const mid of memberIds) {
        if (Number(mid) !== uid) {
          await client.query(
            'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [group.id, Number(mid)]
          );
        }
      }
    }

    await client.query('COMMIT');

    const formattedGroup = { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id };

    // The creator sees this group locally right after their own request
    // resolves, but anyone else added at creation time (checked off in the
    // "Add Friends" list) has no other signal that it exists — without
    // this they'd only see it in their rail after a refresh.
    if (Array.isArray(memberIds)) {
      const addedIds = [...new Set(memberIds.map(Number).filter((mid) => Number.isInteger(mid) && mid !== uid))];
      if (addedIds.length > 0) {
        const io = req.app.get('io');
        io.to(memberRooms(addedIds)).emit('group:added', { group: formattedGroup });
      }
    }

    res.status(201).json({
      group: formattedGroup
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  } finally {
    client.release();
  }
});

// Rename a group — any group member can do it, same as channels
router.patch('/:groupId', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Only group members can rename this group' });

    const { name, iconUrl } = req.body || {};
    const cleanName = String(name || '').trim().slice(0, 50);
    if (!cleanName) return res.status(400).json({ error: 'Group name is required' });

    const updated = await db.query(
      'UPDATE groups SET name = $2, icon_url = $3 WHERE id = $1 RETURNING *',
      [groupId, cleanName, iconUrl || null]
    );
    const group = updated.rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const formattedGroup = { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id };

    const io = req.app.get('io');
    const memberIds = await memberUserIds(groupId);
    io.to(memberRooms(memberIds)).emit('group:updated', { group: formattedGroup });

    res.json({ group: formattedGroup });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Get members of a group (must be a member)
router.get('/:groupId/members', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const result = await db.query(
      `SELECT u.* FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = $1`,
      [groupId]
    );

    res.json({ members: result.rows.map(publicUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Snapshot of who's currently connected to each voice channel in this group —
// used to populate the sidebar when the group is first opened; live updates
// after that arrive over the socket as 'voice:roster-update'.
router.get('/:groupId/voice-rosters', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const channelsResult = await db.query(
      `SELECT id FROM channels WHERE group_id = $1 AND type = 'voice'`,
      [groupId]
    );

    const rosters = {};
    channelsResult.rows.forEach((c) => { rosters[c.id] = getRoster(c.id); });

    res.json({ rosters });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Search groups by name — includes groups the user already belongs to
// (flagged via isMember) so they show an "Already in it" tag instead of
// being hidden entirely.
router.get('/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ groups: [] });

    const result = await db.query(
      `SELECT g.*,
              (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) AS member_count,
              EXISTS (
                SELECT 1 FROM group_members gm3 WHERE gm3.group_id = g.id AND gm3.user_id = $2
              ) AS is_member,
              EXISTS (
                SELECT 1 FROM group_join_requests gjr
                WHERE gjr.group_id = g.id AND gjr.user_id = $2 AND gjr.status = 'pending'
              ) AS pending_request
       FROM groups g
       WHERE g.name ILIKE $1
       ORDER BY g.name ASC
       LIMIT 10`,
      [`%${q}%`, req.user.id]
    );

    res.json({
      groups: result.rows.map((g) => ({
        id: g.id,
        name: g.name,
        iconColor: g.icon_color,
        iconUrl: g.icon_url,
        ownerId: g.owner_id,
        memberCount: Number(g.member_count),
        isMember: g.is_member,
        pendingRequest: g.pending_request
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Request to join a group. Instead of adding the requester immediately, this
// posts a "wants to join" card into the group's default text channel — any
// existing member can accept it from chat (see /:groupId/join-requests/:id/accept).
router.post('/:groupId/join-requests', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    if (!Number.isInteger(groupId)) return res.status(400).json({ error: 'Invalid group' });

    const groupResult = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const group = groupResult.rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length > 0) return res.status(400).json({ error: 'You are already in this group' });

    const existing = await db.query(
      `SELECT * FROM group_join_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'`,
      [groupId, uid]
    );
    if (existing.rows.length > 0) {
      return res.status(200).json({ requestId: existing.rows[0].id, alreadyPending: true });
    }

    const inserted = await db.query(
      `INSERT INTO group_join_requests (group_id, user_id, status)
       VALUES ($1, $2, 'pending')
       RETURNING *`,
      [groupId, uid]
    );
    const request = inserted.rows[0];

    // Post the request as a message in the group's first text channel
    // ("general", by convention) so members see and can act on it in chat.
    const channelResult = await db.query(
      `SELECT * FROM channels WHERE group_id = $1 AND type = 'text' ORDER BY position ASC, id ASC LIMIT 1`,
      [groupId]
    );
    const channel = channelResult.rows[0];

    if (channel) {
      const msgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type, join_request_id)
         VALUES ($1, $2, $3, '', 'join_request', $4) RETURNING id, created_at`,
        [uid, channel.id, groupId, request.id]
      );
      const requesterResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const requester = requesterResult.rows[0];

      const io = req.app.get('io');
      io.to(`channel:${channel.id}`).emit('channel:message', {
        id: msgInserted.rows[0].id,
        content: '',
        createdAt: msgInserted.rows[0].created_at,
        senderId: uid,
        senderName: requester.display_name,
        senderColor: requester.avatar_color,
        channelId: channel.id,
        messageType: 'join_request',
        joinRequest: { id: request.id, status: 'pending', userId: uid, groupId }
      });
    }

    res.status(201).json({ requestId: request.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Accept a pending join request (any existing member can do this)
router.post('/:groupId/join-requests/:requestId/accept', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const requestId = Number(req.params.requestId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const requestResult = await db.query(
      'SELECT * FROM group_join_requests WHERE id = $1 AND group_id = $2',
      [requestId, groupId]
    );
    const request = requestResult.rows[0];
    if (!request) return res.status(404).json({ error: 'Join request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request was already resolved' });

    await db.query(`UPDATE group_join_requests SET status = 'accepted' WHERE id = $1`, [requestId]);
    await db.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, request.user_id]
    );

    const groupResult = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const group = groupResult.rows[0];

    const io = req.app.get('io');

    const msgResult = await db.query('SELECT channel_id FROM messages WHERE join_request_id = $1 LIMIT 1', [requestId]);
    const channelId = msgResult.rows[0] && msgResult.rows[0].channel_id;
    if (channelId) {
      io.to(`channel:${channelId}`).emit('group:join-request-resolved', { requestId, groupId, status: 'accepted' });

      // Post a "X has joined the server" system line in the same channel so
      // everyone watching chat sees the group gain a member in real time.
      const joinerResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [request.user_id]);
      const joiner = joinerResult.rows[0];

      const systemMsgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type)
         VALUES ($1, $2, $3, $4, 'system') RETURNING id, created_at`,
        [request.user_id, channelId, groupId, `${joiner.display_name} has joined the server`]
      );

      io.to(`channel:${channelId}`).emit('channel:message', {
        id: systemMsgInserted.rows[0].id,
        content: `${joiner.display_name} has joined the server`,
        createdAt: systemMsgInserted.rows[0].created_at,
        senderId: request.user_id,
        senderName: joiner.display_name,
        senderColor: joiner.avatar_color,
        channelId,
        messageType: 'system'
      });
    }

    // The requester isn't in the channel room yet, so notify them directly
    // so their client can refresh its group list and open the new group.
    io.to(`user:${request.user_id}`).emit('group:joined', {
      group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id }
    });

    // Everyone else with this group's member sidebar open should see the
    // new face show up live instead of only on refresh.
    const joinerInfo = await db.query('SELECT * FROM users WHERE id = $1', [request.user_id]);
    const memberIds = await memberUserIds(groupId);
    io.to(memberRooms(memberIds)).emit('group:member-added', { groupId, member: publicUser(joinerInfo.rows[0]) });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Decline a pending join request (any existing member can do this)
router.post('/:groupId/join-requests/:requestId/decline', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const requestId = Number(req.params.requestId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const requestResult = await db.query(
      'SELECT * FROM group_join_requests WHERE id = $1 AND group_id = $2',
      [requestId, groupId]
    );
    const request = requestResult.rows[0];
    if (!request) return res.status(404).json({ error: 'Join request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'This request was already resolved' });

    await db.query(`UPDATE group_join_requests SET status = 'declined' WHERE id = $1`, [requestId]);

    const io = req.app.get('io');

    const msgResult = await db.query('SELECT channel_id FROM messages WHERE join_request_id = $1 LIMIT 1', [requestId]);
    const channelId = msgResult.rows[0] && msgResult.rows[0].channel_id;
    if (channelId) {
      io.to(`channel:${channelId}`).emit('group:join-request-resolved', { requestId, groupId, status: 'declined' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Search any user by username to invite them into a group (used by the "+"
// button on a group's member list). Unlike the friends search, this is
// scoped to the group so results can flag whether the user is already a
// member or already has a pending invite waiting in their DMs.
router.get('/:groupId/invitable-users', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ users: [] });

    const result = await db.query(
      `SELECT u.*,
              EXISTS (
                SELECT 1 FROM group_members gm WHERE gm.group_id = $1 AND gm.user_id = u.id
              ) AS is_member,
              EXISTS (
                SELECT 1 FROM group_invites gi
                WHERE gi.group_id = $1 AND gi.invitee_id = u.id AND gi.status = 'pending'
              ) AS pending_invite
       FROM users u
       WHERE u.username ILIKE $2 AND u.id != $3
       ORDER BY u.username ASC
       LIMIT 10`,
      [groupId, `%${q}%`, uid]
    );

    res.json({ users: result.rows.map((u) => ({ ...publicUser(u), isMember: u.is_member, pendingInvite: u.pending_invite })) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Invite a specific person to a group — delivered as a message in the
// invitee's DM with the inviter (see messages.js formatMessage / the
// group_invite message_type) rather than adding them right away. The
// invitee accepts or declines it from their own DMs.
router.post('/:groupId/invites', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const { userId } = req.body || {};
    const inviteeId = Number(userId);
    if (!Number.isInteger(inviteeId)) return res.status(400).json({ error: 'A user to invite is required' });
    if (inviteeId === uid) return res.status(400).json({ error: "You can't invite yourself" });

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const group = (await db.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const invitee = (await db.query('SELECT * FROM users WHERE id = $1', [inviteeId])).rows[0];
    if (!invitee) return res.status(404).json({ error: 'User not found' });

    const alreadyMember = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, inviteeId]
    );
    if (alreadyMember.rows.length > 0) return res.status(400).json({ error: 'That person is already in this group' });

    const existingInvite = await db.query(
      `SELECT * FROM group_invites WHERE group_id = $1 AND invitee_id = $2 AND status = 'pending'`,
      [groupId, inviteeId]
    );
    if (existingInvite.rows.length > 0) {
      return res.status(200).json({ inviteId: existingInvite.rows[0].id, alreadyPending: true });
    }

    const inserted = await db.query(
      `INSERT INTO group_invites (group_id, inviter_id, invitee_id, status)
       VALUES ($1, $2, $3, 'pending') RETURNING *`,
      [groupId, uid, inviteeId]
    );
    const invite = inserted.rows[0];

    const msgInserted = await db.query(
      `INSERT INTO messages (sender_id, recipient_id, content, message_type, group_invite_id)
       VALUES ($1, $2, '', 'group_invite', $3) RETURNING id, created_at`,
      [uid, inviteeId, invite.id]
    );

    const inviterResult = await db.query('SELECT display_name, avatar_color, avatar_url, name_color FROM users WHERE id = $1', [uid]);
    const inviter = inviterResult.rows[0];

    const payload = {
      id: msgInserted.rows[0].id,
      content: '',
      createdAt: msgInserted.rows[0].created_at,
      senderId: uid,
      senderName: inviter.display_name,
      senderColor: inviter.avatar_color,
      senderAvatarUrl: inviter.avatar_url,
      senderNameColor: inviter.name_color,
      recipientId: inviteeId,
      messageType: 'group_invite',
      groupInvite: {
        id: invite.id,
        status: 'pending',
        groupId: group.id,
        groupName: group.name,
        groupIconColor: group.icon_color,
        groupIconUrl: group.icon_url,
        inviterId: uid,
        inviteeId
      }
    };

    const io = req.app.get('io');
    io.to(`user:${uid}`).to(`user:${inviteeId}`).emit('dm:message', payload);

    res.status(201).json({ inviteId: invite.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Accept an invite — only the invitee can do this
router.post('/:groupId/invites/:inviteId/accept', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const inviteId = Number(req.params.inviteId);

    const inviteResult = await db.query(
      'SELECT * FROM group_invites WHERE id = $1 AND group_id = $2',
      [inviteId, groupId]
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.invitee_id !== uid) return res.status(403).json({ error: 'This invite is not for you' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite was already resolved' });

    await db.query(`UPDATE group_invites SET status = 'accepted' WHERE id = $1`, [inviteId]);
    await db.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, uid]
    );

    const group = (await db.query('SELECT * FROM groups WHERE id = $1', [groupId])).rows[0];

    const io = req.app.get('io');
    io.to(`user:${invite.inviter_id}`).to(`user:${uid}`).emit('group:invite-resolved', { inviteId, status: 'accepted' });

    // Existing members watching this group's member list have no other
    // signal that someone new just joined via invite (unlike join-requests
    // and direct-add, which already broadcast this) — without it they'd
    // only see the new face after a refresh.
    const joinerUser = (await db.query('SELECT * FROM users WHERE id = $1', [uid])).rows[0];
    const memberIds = await memberUserIds(groupId);
    io.to(memberRooms(memberIds)).emit('group:member-added', { groupId, member: publicUser(joinerUser) });

    // Post a "X has joined the server" system line in the default channel,
    // same as accepting a join request does, so existing members see it.
    const channelResult = await db.query(
      `SELECT * FROM channels WHERE group_id = $1 AND type = 'text' ORDER BY position ASC, id ASC LIMIT 1`,
      [groupId]
    );
    const channel = channelResult.rows[0];
    if (channel) {
      const joinerResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
      const joiner = joinerResult.rows[0];
      const systemMsgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type)
         VALUES ($1, $2, $3, $4, 'system') RETURNING id, created_at`,
        [uid, channel.id, groupId, `${joiner.display_name} has joined the server`]
      );
      io.to(`channel:${channel.id}`).emit('channel:message', {
        id: systemMsgInserted.rows[0].id,
        content: `${joiner.display_name} has joined the server`,
        createdAt: systemMsgInserted.rows[0].created_at,
        senderId: uid,
        senderName: joiner.display_name,
        senderColor: joiner.avatar_color,
        channelId: channel.id,
        messageType: 'system'
      });
    }

    // The invitee isn't in the group's rooms yet, so tell their client
    // directly to refresh its group list and hop into the new group.
    io.to(`user:${uid}`).emit('group:joined', {
      group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Decline an invite — only the invitee can do this
router.post('/:groupId/invites/:inviteId/decline', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const inviteId = Number(req.params.inviteId);

    const inviteResult = await db.query(
      'SELECT * FROM group_invites WHERE id = $1 AND group_id = $2',
      [inviteId, groupId]
    );
    const invite = inviteResult.rows[0];
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.invitee_id !== uid) return res.status(403).json({ error: 'This invite is not for you' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite was already resolved' });

    await db.query(`UPDATE group_invites SET status = 'declined' WHERE id = $1`, [inviteId]);

    const io = req.app.get('io');
    io.to(`user:${invite.inviter_id}`).to(`user:${uid}`).emit('group:invite-resolved', { inviteId, status: 'declined' });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Add a friend to a group
router.post('/:groupId/members', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);
    const { userId } = req.body || {};

    const memberCheck = await db.query(
      'SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2',
      [groupId, uid]
    );
    if (memberCheck.rows.length === 0) return res.status(403).json({ error: 'Not a member of this group' });

    const targetResult = await db.query('SELECT * FROM users WHERE id = $1', [Number(userId)]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'User not found' });

    await db.query(
      'INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [groupId, target.id]
    );

    const io = req.app.get('io');
    const memberIds = await memberUserIds(groupId);
    io.to(memberRooms(memberIds)).emit('group:member-added', { groupId, member: publicUser(target) });

    // Unlike join-request/invite acceptance, the target didn't take any
    // action here, so don't jump them into the group — just make sure it
    // shows up in their rail live instead of only after a refresh.
    const groupResult = await db.query('SELECT * FROM groups WHERE id = $1', [groupId]);
    const group = groupResult.rows[0];
    io.to(`user:${target.id}`).emit('group:added', {
      group: { id: group.id, name: group.name, iconColor: group.icon_color, iconUrl: group.icon_url, ownerId: group.owner_id }
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

// Leave a group
router.delete('/:groupId/members/me', async (req, res) => {
  try {
    const uid = req.user.id;
    const groupId = Number(req.params.groupId);

    const userResult = await db.query('SELECT display_name, avatar_color FROM users WHERE id = $1', [uid]);
    const user = userResult.rows[0];

    await db.query('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, uid]);

    const io = req.app.get('io');
    const remainingMemberIds = await memberUserIds(groupId);
    io.to(memberRooms(remainingMemberIds)).emit('group:member-removed', { groupId, userId: uid });

    // Announce the departure in the group's default text channel, same place
    // "X has joined the server" is posted on accept.
    const channelResult = await db.query(
      `SELECT * FROM channels WHERE group_id = $1 AND type = 'text' ORDER BY position ASC, id ASC LIMIT 1`,
      [groupId]
    );
    const channel = channelResult.rows[0];

    if (channel && user) {
      const systemMsgInserted = await db.query(
        `INSERT INTO messages (sender_id, channel_id, group_id, content, message_type)
         VALUES ($1, $2, $3, $4, 'system') RETURNING id, created_at`,
        [uid, channel.id, groupId, `${user.display_name} has left the server`]
      );

      io.to(`channel:${channel.id}`).emit('channel:message', {
        id: systemMsgInserted.rows[0].id,
        content: `${user.display_name} has left the server`,
        createdAt: systemMsgInserted.rows[0].created_at,
        senderId: uid,
        senderName: user.display_name,
        senderColor: user.avatar_color,
        channelId: channel.id,
        messageType: 'system'
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;