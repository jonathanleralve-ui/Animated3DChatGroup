const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const auth = require('../middleware/auth');
const { JWT_SECRET } = require('../config');

const router = express.Router();

const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatarColor: u.avatar_color,
    avatarUrl: u.avatar_url,
    nameColor: u.name_color,
    avatarModelUrl: u.avatar_model_url,
    avatarMode: u.avatar_mode,
    avatarModelZoom: u.avatar_model_zoom,
    avatarModelOffsetX: u.avatar_model_offset_x,
    avatarModelOffsetY: u.avatar_model_offset_y,
    avatarModelRotationY: u.avatar_model_rotation_y,
    avatarModelMouthIntensity: u.avatar_model_mouth_intensity,
    avatarModelVoiceStart: u.avatar_model_voice_start,
    avatarModelVoiceMax: u.avatar_model_voice_max,
    avatarModelBlinkIntensity: u.avatar_model_blink_intensity,
    avatarModelBlinkIntervalMin: u.avatar_model_blink_interval_min,
    avatarModelBlinkIntervalMax: u.avatar_model_blink_interval_max,
    avatarModelBlinkEnabled: u.avatar_model_blink_enabled,
    avatarModelBlinkShapeKeys: u.avatar_model_blink_shape_keys,
    avatarModelLookEnabled: u.avatar_model_look_enabled,
    bannerUrl: u.banner_url,
    bannerZoom: u.banner_zoom,
    bannerOffsetX: u.banner_offset_x,
    bannerOffsetY: u.banner_offset_y,
    status: u.status
  };
}

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const uname = String(username).trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(uname)) {
      return res.status(400).json({ error: 'Username must be 3-20 characters: letters, numbers, underscore only' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await db.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'That username is already taken' });
    }

    const hash = bcrypt.hashSync(String(password), 10);
    const name = (displayName && String(displayName).trim()) || uname;

    const inserted = await db.query(
      `INSERT INTO users (username, display_name, password_hash, avatar_color, status)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [uname, name, hash, randomColor(), 'online']
    );

    const user = inserted.rows[0];
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    const uname = String(username).trim().toLowerCase();
    const result = await db.query('SELECT * FROM users WHERE username = $1', [uname]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    await db.query('UPDATE users SET status = $1 WHERE id = $2', ['online', user.id]);

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

router.patch('/me', auth, async (req, res) => {
  try {
    const {
      displayName, avatarColor, avatarUrl, nameColor, avatarModelUrl, avatarMode,
      avatarModelZoom, avatarModelOffsetX, avatarModelOffsetY, avatarModelRotationY,
      avatarModelMouthIntensity, avatarModelVoiceStart, avatarModelVoiceMax,
      avatarModelBlinkIntensity, avatarModelBlinkIntervalMin, avatarModelBlinkIntervalMax, avatarModelBlinkEnabled,
      avatarModelBlinkShapeKeys,
      avatarModelLookEnabled,
      bannerUrl, bannerZoom, bannerOffsetX, bannerOffsetY
    } = req.body || {};
    const updates = [];
    const values = [];
    let idx = 1;

    if (displayName !== undefined) {
      const name = String(displayName).trim();
      if (!name) return res.status(400).json({ error: 'Display name cannot be empty' });
      if (name.length > 32) return res.status(400).json({ error: 'Display name must be 32 characters or fewer' });
      updates.push(`display_name = $${idx++}`);
      values.push(name);
    }

    if (avatarColor !== undefined) {
      if (!COLORS.includes(avatarColor)) {
        return res.status(400).json({ error: 'Invalid avatar color' });
      }
      updates.push(`avatar_color = $${idx++}`);
      values.push(avatarColor);
    }

    if (avatarUrl !== undefined) {
      updates.push(`avatar_url = $${idx++}`);
      values.push(avatarUrl || null);
    }

    if (nameColor !== undefined) {
      if (nameColor !== null && !COLORS.includes(nameColor)) {
        return res.status(400).json({ error: 'Invalid name color' });
      }
      updates.push(`name_color = $${idx++}`);
      values.push(nameColor || null);
    }

    if (avatarModelUrl !== undefined) {
      updates.push(`avatar_model_url = $${idx++}`);
      values.push(avatarModelUrl || null);
    }

    if (avatarMode !== undefined) {
      if (!['flat', '3d'].includes(avatarMode)) {
        return res.status(400).json({ error: 'Invalid avatar mode' });
      }
      updates.push(`avatar_mode = $${idx++}`);
      values.push(avatarMode);
    }

    // Clamp rather than reject out-of-range framing values - these come from
    // a drag/scroll gesture client-side, so a stray value (e.g. a fast
    // scroll landing just past the intended max) shouldn't fail the whole
    // profile save.
    if (avatarModelZoom !== undefined) {
      const z = Number(avatarModelZoom);
      if (!Number.isFinite(z)) return res.status(400).json({ error: 'Invalid zoom value' });
      updates.push(`avatar_model_zoom = $${idx++}`);
      values.push(Math.min(3, Math.max(0.3, z)));
    }

    if (avatarModelOffsetX !== undefined) {
      const x = Number(avatarModelOffsetX);
      if (!Number.isFinite(x)) return res.status(400).json({ error: 'Invalid offset value' });
      updates.push(`avatar_model_offset_x = $${idx++}`);
      values.push(Math.min(2, Math.max(-2, x)));
    }

    if (avatarModelOffsetY !== undefined) {
      const y = Number(avatarModelOffsetY);
      if (!Number.isFinite(y)) return res.status(400).json({ error: 'Invalid offset value' });
      updates.push(`avatar_model_offset_y = $${idx++}`);
      values.push(Math.min(2, Math.max(-2, y)));
    }

    if (avatarModelRotationY !== undefined) {
      const r = Number(avatarModelRotationY);
      if (!Number.isFinite(r)) return res.status(400).json({ error: 'Invalid rotation value' });
      // Wrap into (-PI, PI] rather than clamp - rotation is circular, so a
      // value just past PI should wrap around to just past -PI, not get
      // stuck at the boundary.
      const wrapped = Math.atan2(Math.sin(r), Math.cos(r));
      updates.push(`avatar_model_rotation_y = $${idx++}`);
      values.push(wrapped);
    }

    // Lip-sync tuning: how far the mouth shape key opens (0-1) and the
    // input-volume window (0-100) it ramps over. Clamped rather than
    // rejected, same reasoning as the framing values above - these come
    // from sliders, so a slightly out-of-range value shouldn't fail the
    // whole save.
    if (avatarModelMouthIntensity !== undefined) {
      const m = Number(avatarModelMouthIntensity);
      if (!Number.isFinite(m)) return res.status(400).json({ error: 'Invalid mouth intensity value' });
      updates.push(`avatar_model_mouth_intensity = $${idx++}`);
      values.push(Math.min(1, Math.max(0, m)));
    }

    if (avatarModelVoiceStart !== undefined) {
      const s = Number(avatarModelVoiceStart);
      if (!Number.isFinite(s)) return res.status(400).json({ error: 'Invalid voice start threshold' });
      updates.push(`avatar_model_voice_start = $${idx++}`);
      values.push(Math.min(100, Math.max(0, s)));
    }

    if (avatarModelVoiceMax !== undefined) {
      const x = Number(avatarModelVoiceMax);
      if (!Number.isFinite(x)) return res.status(400).json({ error: 'Invalid voice max threshold' });
      updates.push(`avatar_model_voice_max = $${idx++}`);
      values.push(Math.min(100, Math.max(0, x)));
    }

    // Blink tuning: intensity (0-1), interval min/max (0.2-20s), enabled
    // (bool). Same clamp-not-reject reasoning as the fields above.
    if (avatarModelBlinkIntensity !== undefined) {
      const b = Number(avatarModelBlinkIntensity);
      if (!Number.isFinite(b)) return res.status(400).json({ error: 'Invalid blink intensity value' });
      updates.push(`avatar_model_blink_intensity = $${idx++}`);
      values.push(Math.min(1, Math.max(0, b)));
    }

    if (avatarModelBlinkIntervalMin !== undefined) {
      const bMin = Number(avatarModelBlinkIntervalMin);
      if (!Number.isFinite(bMin)) return res.status(400).json({ error: 'Invalid blink interval value' });
      updates.push(`avatar_model_blink_interval_min = $${idx++}`);
      values.push(Math.min(20, Math.max(0.2, bMin)));
    }

    if (avatarModelBlinkIntervalMax !== undefined) {
      const bMax = Number(avatarModelBlinkIntervalMax);
      if (!Number.isFinite(bMax)) return res.status(400).json({ error: 'Invalid blink interval value' });
      updates.push(`avatar_model_blink_interval_max = $${idx++}`);
      values.push(Math.min(20, Math.max(0.2, bMax)));
    }

    if (avatarModelBlinkEnabled !== undefined) {
      updates.push(`avatar_model_blink_enabled = $${idx++}`);
      values.push(!!avatarModelBlinkEnabled);
    }

    // Manual override for which shape key(s) drive blinking - a plain
    // comma-separated string of names the user typed in, since plenty of
    // models use shape key names the built-in auto-detection can't guess.
    // Empty string means "fall back to auto-detection". Just length-capped,
    // not otherwise validated - an unmatched name simply results in no
    // shape key being found client-side, same as a typo would.
    if (avatarModelBlinkShapeKeys !== undefined) {
      const keys = String(avatarModelBlinkShapeKeys).trim();
      if (keys.length > 200) {
        return res.status(400).json({ error: 'Blink shape key list is too long (200 characters max)' });
      }
      updates.push(`avatar_model_blink_shape_keys = $${idx++}`);
      values.push(keys);
    }

    if (avatarModelLookEnabled !== undefined) {
      updates.push(`avatar_model_look_enabled = $${idx++}`);
      values.push(!!avatarModelLookEnabled);
    }

    if (bannerUrl !== undefined) {
      updates.push(`banner_url = $${idx++}`);
      values.push(bannerUrl || null);
    }

    // Same clamp-not-reject reasoning as the 3D model framing values above -
    // these come from a drag/scroll gesture or slider client-side.
    if (bannerZoom !== undefined) {
      const z = Number(bannerZoom);
      if (!Number.isFinite(z)) return res.status(400).json({ error: 'Invalid banner zoom value' });
      updates.push(`banner_zoom = $${idx++}`);
      values.push(Math.min(3, Math.max(1, z)));
    }

    if (bannerOffsetX !== undefined) {
      const x = Number(bannerOffsetX);
      if (!Number.isFinite(x)) return res.status(400).json({ error: 'Invalid banner offset value' });
      updates.push(`banner_offset_x = $${idx++}`);
      values.push(Math.min(300, Math.max(-300, x)));
    }

    if (bannerOffsetY !== undefined) {
      const y = Number(bannerOffsetY);
      if (!Number.isFinite(y)) return res.status(400).json({ error: 'Invalid banner offset value' });
      updates.push(`banner_offset_y = $${idx++}`);
      values.push(Math.min(300, Math.max(-300, y)));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    values.push(req.user.id);
    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );

    const user = publicUser(result.rows[0]);

    // Broadcast like presence updates do — cheaper than tracking exactly
    // which friends/group members currently have this person visible
    // somewhere (friends list, member list, DM header, etc.), and every
    // client already ignores updates for users it isn't displaying.
    const io = req.app.get('io');
    io.emit('profile:updated', { user });

    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong, please try again' });
  }
});

module.exports = router;