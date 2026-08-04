const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');
const { JWT_SECRET } = require('../config');

const router = express.Router();

const COLORS = ['#5865F2', '#EB459E', '#57F287', '#FEE75C', '#ED4245', '#3BA55D', '#FAA61A'];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

const AVATAR_BORDER_STYLES = ['none', 'solid', 'glow', 'rainbow'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// Cap on how many GIF stickers a card can carry - keeps the JSON blob and
// the card itself from growing unbounded.
const MAX_PROFILE_EFFECTS = 8;
// Voice command words used to be a per-user field here; they're now a
// shared, group-wide list handled in routes/groups.js instead (see
// MAX_VOICE_TRIGGERS etc. there).

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
    avatarModelMouthShapeKeys: u.avatar_model_mouth_shape_keys,
    avatarModelSurpriseShapeKeys: u.avatar_model_surprise_shape_keys,
    avatarModelSurpriseEnabled: u.avatar_model_surprise_enabled,
    avatarModelLookEnabled: u.avatar_model_look_enabled,
    bannerUrl: u.banner_url,
    bannerZoom: u.banner_zoom,
    bannerOffsetX: u.banner_offset_x,
    bannerOffsetY: u.banner_offset_y,
    avatarBorderStyle: u.avatar_border_style,
    avatarBorderColor: u.avatar_border_color,
    profileAccentColor: u.profile_accent_color,
    profileEffects: u.profile_effects || [],
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
      avatarModelMouthShapeKeys,
      avatarModelSurpriseShapeKeys,
      avatarModelSurpriseEnabled,
      avatarModelLookEnabled,
      bannerUrl, bannerZoom, bannerOffsetX, bannerOffsetY,
      avatarBorderStyle, avatarBorderColor, profileAccentColor,
      profileEffects
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

    // Same idea as blink shape keys above, but for which shape key(s)
    // drive the mouth-opening lip-sync animation instead of the built-in
    // auto-detection ('あ', 'mouth', 'open', etc.). Empty means auto-detect.
    // Now stores up to 3 entries of { name, intensity } as JSON (see
    // profile.js's serializeMouthEntries), same shape as a single surprise
    // slot, so up to 3 shape keys can drive the mouth at once instead of
    // only ever one - the old 200-char plain-string ceiling is bumped up
    // with headroom to match.
    if (avatarModelMouthShapeKeys !== undefined) {
      const keys = String(avatarModelMouthShapeKeys).trim();
      if (keys.length > 600) {
        return res.status(400).json({ error: 'Mouth shape key list is too long (600 characters max)' });
      }
      updates.push(`avatar_model_mouth_shape_keys = $${idx++}`);
      values.push(keys);
    }

    if (avatarModelSurpriseShapeKeys !== undefined) {
      const keys = String(avatarModelSurpriseShapeKeys).trim();
      // Now stores up to 5 slots of up to 3 entries each (see profile.js's
      // serializeSurpriseProfile), so the old 2000-char ceiling from the
      // single-slot era is bumped up with headroom to match.
      if (keys.length > 4000) {
        return res.status(400).json({ error: 'Surprise shape key list is too long (4000 characters max)' });
      }
      updates.push(`avatar_model_surprise_shape_keys = $${idx++}`);
      values.push(keys);
    }

    // Whether holding the mouse down triggers the surprise expression at
    // all - same "boolean toggle" pattern as avatarModelBlinkEnabled above.
    if (avatarModelSurpriseEnabled !== undefined) {
      updates.push(`avatar_model_surprise_enabled = $${idx++}`);
      values.push(!!avatarModelSurpriseEnabled);
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

    // Avatar decoration: a ring/glow/rainbow border drawn around the avatar,
    // plus the color it uses (ignored client-side for 'rainbow' and 'none',
    // but still just stored as-is - the rendering rules decide what to do
    // with it). Free-form hex rather than the fixed COLORS palette, since
    // this comes from a color picker input, not preset swatches.
    if (avatarBorderStyle !== undefined) {
      if (!AVATAR_BORDER_STYLES.includes(avatarBorderStyle)) {
        return res.status(400).json({ error: 'Invalid avatar border style' });
      }
      updates.push(`avatar_border_style = $${idx++}`);
      values.push(avatarBorderStyle);
    }

    if (avatarBorderColor !== undefined) {
      if (avatarBorderColor !== null && !HEX_COLOR_RE.test(avatarBorderColor)) {
        return res.status(400).json({ error: 'Invalid avatar border color' });
      }
      updates.push(`avatar_border_color = $${idx++}`);
      values.push(avatarBorderColor || null);
    }

    // Tints the card background below the banner. Also free-form hex.
    if (profileAccentColor !== undefined) {
      if (profileAccentColor !== null && !HEX_COLOR_RE.test(profileAccentColor)) {
        return res.status(400).json({ error: 'Invalid profile accent color' });
      }
      updates.push(`profile_accent_color = $${idx++}`);
      values.push(profileAccentColor || null);
    }

    // Card effects: user-uploaded GIF stickers scattered around the card.
    // url must already be an uploaded file (this route doesn't accept raw
    // uploads itself - the client uploads each GIF via /api/upload first,
    // same as it does for the avatar photo and banner). Ids are always
    // regenerated server-side rather than trusting whatever the client
    // sent, and x/y/scale are clamped the same way the banner/3D-model
    // framing values are - they come from a drag/scroll gesture, so a
    // slightly out-of-range value shouldn't fail the whole save.
    if (profileEffects !== undefined) {
      if (!Array.isArray(profileEffects)) {
        return res.status(400).json({ error: 'Invalid profile effects' });
      }
      if (profileEffects.length > MAX_PROFILE_EFFECTS) {
        return res.status(400).json({ error: `You can only have up to ${MAX_PROFILE_EFFECTS} card effects` });
      }
      const cleaned = [];
      for (const fx of profileEffects) {
        if (!fx || typeof fx.url !== 'string' || !fx.url.trim()) {
          return res.status(400).json({ error: 'Each card effect needs an image' });
        }
        if (fx.url.length > 500) {
          return res.status(400).json({ error: 'Card effect image URL is too long' });
        }
        const x = Number(fx.x);
        const y = Number(fx.y);
        const scale = Number(fx.scale);
        const rotation = Number(fx.rotation);
        cleaned.push({
          id: crypto.randomBytes(6).toString('hex'),
          url: fx.url,
          x: Math.min(160, Math.max(-160, Number.isFinite(x) ? x : 0)),
          y: Math.min(160, Math.max(-160, Number.isFinite(y) ? y : 0)),
          scale: Math.min(4, Math.max(0.3, Number.isFinite(scale) ? scale : 1)),
          // Wrapped into [0, 360) rather than clamped, since rotation is
          // circular - a dragged-past-360 value is still a perfectly valid
          // angle, not an out-of-range one.
          rotation: Number.isFinite(rotation) ? ((rotation % 360) + 360) % 360 : 0
        });
      }
      updates.push(`profile_effects = $${idx++}::jsonb`);
      values.push(JSON.stringify(cleaned));
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