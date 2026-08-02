const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(
  config.DATABASE_URL
    ? { connectionString: config.DATABASE_URL }
    : {
        host: config.PGHOST,
        port: config.PGPORT,
        user: config.PGUSER,
        password: config.PGPASSWORD,
        database: config.PGDATABASE
      }
);

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err);
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_color TEXT NOT NULL DEFAULT '#5865F2',
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Lets a user pick a color for their display name (shown next to messages
-- in DMs and group channels), independent of their avatar background color.
-- NULL means "use the default text color".
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_color TEXT;

-- A user can upload a full MMD model package (.pmx + textures) to use as a
-- 3D "speaker" avatar in voice channels instead of the flat profile photo.
-- avatar_model_url points at the .pmx file itself (served statically under
-- /uploads/models/<id>/...); its sibling texture files live alongside it in
-- the same folder so MMDLoader can resolve them by relative path.
-- avatar_mode is 'flat' (default, plain photo/initials) or '3d' (use the
-- model above in voice chat) — kept independent of avatar_model_url so a
-- user can temporarily switch back to flat without losing their upload.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mode TEXT NOT NULL DEFAULT 'flat';

-- How the 3D model is framed in its little viewport: zoom is a camera
-- distance multiplier (1 = default distance, <1 = zoomed in, >1 = zoomed
-- out) and offset_x/y pan the framing left/right/up/down. Set by the user
-- via drag-to-pan/scroll-to-zoom (or the slider) on their own model preview
-- in Edit Profile, then reused everywhere else the model renders (voice
-- tiles) so it's framed the same way consistently.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_zoom DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_offset_x DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_offset_y DOUBLE PRECISION NOT NULL DEFAULT 0;
-- Horizontal spin around the model, in radians, chosen the same way (drag or
-- a slider) alongside zoom/pan. Vertical tilt is deliberately not exposed -
-- just left/right so the user can pick which side faces the camera.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_rotation_y DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Lip-sync tuning for the 3D model: how far the mouth shape key opens at
-- most (0-1, mirrors the old hardcoded CONFIG.mouthLimit default of 0.5),
-- and the input-volume window (0-100, RMS-ish scale used by voice.js's
-- speaking meter) over which it ramps from closed to fully open - below
-- voice_start nothing happens, at/above voice_max it's fully open. Defaults
-- match what was previously hardcoded in avatar3d.js's CONFIG.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_mouth_intensity DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_voice_start DOUBLE PRECISION NOT NULL DEFAULT 5;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_voice_max DOUBLE PRECISION NOT NULL DEFAULT 59;

-- Blink tuning for the 3D model: how closed the eye shape key gets at the
-- peak of a blink (0-1, default 1 = fully closed, matching the old
-- hardcoded behavior), the random min/max seconds between blinks (defaults
-- match avatar3d.js's old hardcoded CONFIG.blinkIntervalMin/Max), and
-- whether blinking is on at all.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_blink_intensity DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_blink_interval_min DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_blink_interval_max DOUBLE PRECISION NOT NULL DEFAULT 4;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_blink_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_blink_shape_keys TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_mouth_shape_keys TEXT NOT NULL DEFAULT '';

-- Head/eye gaze tracking toggle (follows the cursor around the screen).
-- On by default, matching avatar3d.js's hardcoded default.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_model_look_enabled BOOLEAN NOT NULL DEFAULT true;

-- Profile banner: an image the user can upload to replace the default
-- gradient shown behind their avatar on the profile preview card.
-- banner_zoom/offset_x/offset_y frame it the same way the 3D model is framed
-- above (drag-to-pan / scroll-to-zoom, or the sliders) - zoom is a
-- background-size multiplier (1 = fills the banner box, >1 = zoomed in) and
-- offset_x/y are pixel offsets from center used to pan the image around.
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_zoom DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_offset_x DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS banner_offset_y DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Decorative ring drawn around the avatar on the profile preview card, the
-- member-card popover, and friend cards. avatar_border_style is 'none'
-- (default, plain bg-matching ring like before), 'solid' (ring painted in
-- avatar_border_color), 'glow' (same color, but as a soft outer glow rather
-- than a hard ring), or 'rainbow' (animated conic-gradient ring, ignores
-- avatar_border_color). Kept as a free-form hex string (like banner/name
-- color reuse a fixed palette, but this one also accepts a custom color
-- from the <input type=color> picker) rather than restricted to the fixed
-- swatch list, so people can match it to whatever they like.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_border_style TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_border_color TEXT;

-- Tints the card background beneath the banner (profile preview card,
-- member-card popover, friend cards) with a fade from this color down to
-- the normal card background, similar in spirit to Discord's profile theme
-- color. NULL means "no tint, just the plain card background".
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_accent_color TEXT;

-- User-uploaded GIF "profile effects" - decorative stickers (wings, fire,
-- sparkles, seasonal stuff, whatever) scattered around the profile card.
-- A BYO-image version of Nitro profile effects rather than a curated
-- catalog. Stored as a JSON array of { id, url, x, y, scale } objects:
-- x/y are pixel offsets from the card's center (same convention as
-- banner_offset_x/y), scale is a size multiplier off a fixed base sticker
-- size (see EFFECT_BASE_SIZE in public/js/utils.js). Count and per-field
-- ranges are enforced server-side in routes/auth.js (MAX_PROFILE_EFFECTS).
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_effects JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Deprecated: this used to hold each user's personal voice-chat command
-- words. That's now a shared, group-wide list instead (see
-- groups.voice_command_triggers below) so the whole group hears the same
-- trigger set - the client no longer reads or writes this column. Left in
-- place rather than dropped so existing data isn't destroyed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_command_triggers JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS friendships (
  id SERIAL PRIMARY KEY,
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(requester_id, addressee_id)
);

CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  icon_color TEXT NOT NULL DEFAULT '#5865F2',
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE groups ADD COLUMN IF NOT EXISTS icon_url TEXT;

-- Shared, group-wide voice-chat command words (see public/js/voice-speech.js):
-- saying one of these while connected to any voice channel in this group
-- fires an emoji reaction over the speaker's tile. Stored as a JSON array of
-- { phrase, emoji } objects, editable by any member of the group (same
-- permission model as renaming the group) so everyone hears the same set -
-- count/length limits enforced server-side in routes/groups.js.
ALTER TABLE groups ADD COLUMN IF NOT EXISTS voice_command_triggers JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Joining a group now requires an existing member to accept the request
-- (posted as a message in the group's default channel) rather than adding
-- the requester immediately.
--
-- NOTE: this used to have a UNIQUE(group_id, user_id) constraint so a repeat
-- request would upsert the same row (see the old ON CONFLICT insert in
-- routes/groups.js). That meant a user leaving and requesting to join again
-- reused the exact same request id, so the old (already-resolved) "invite"
-- message in chat and the new (pending) one both pointed at the same row and
-- always showed identical status. Each request now gets its own row/id;
-- only-one-*pending*-request-at-a-time is enforced in the route handler.
CREATE TABLE IF NOT EXISTS group_join_requests (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration for databases created before this constraint was removed. The
-- constraint's name depends on how/when the table was originally created
-- (inline UNIQUE(...) gets an auto-generated name, and older revisions of
-- this file also created a separately named unique index), so rather than
-- guessing a name and risking a silent no-op via "IF EXISTS", look up
-- whatever unique constraint(s) actually exist on these two columns and
-- drop them by their real name.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'group_join_requests'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE group_join_requests DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
DROP INDEX IF EXISTS idx_group_join_requests_unique;

-- Non-unique index to keep the "is there already a pending request"/search
-- lookups fast now that a (group_id, user_id) pair can have many rows.
CREATE INDEX IF NOT EXISTS idx_group_join_requests_lookup ON group_join_requests(group_id, user_id, status);

-- The other direction of joining a group: an existing member invites a
-- specific person rather than that person asking to join. The invite is
-- delivered as a card in the invitee's DM with the inviter (see
-- routes/groups.js '/:groupId/invites') and the invitee can accept or
-- decline it from there, same as a normal DM message.
CREATE TABLE IF NOT EXISTS group_invites (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invitee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_group_invites_lookup ON group_invites(group_id, invitee_id, status);

-- A group ("server") is now made up of channels, same as Discord: several
-- text channels and several voice channels, organized into categories.
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- text | voice
  category TEXT NOT NULL DEFAULT 'TEXT CHANNELS',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_group ON channels(group_id);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- exactly one of recipient_id / channel_id is set
  recipient_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Messages now belong to a channel rather than directly to a group.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE;

-- A message may carry a single file attachment (image, video, or any other
-- file) alongside or instead of text content.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_url TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_size INTEGER;

-- content used to be required; attachment-only messages send an empty string.
ALTER TABLE messages ALTER COLUMN content SET DEFAULT '';

-- A message can represent a group join request instead of regular chat text,
-- rendered as an "X wants to join" card with an Accept action. The 'system'
-- type is used for plain announcement lines (e.g. "X has joined the server")
-- that render without an avatar-attached author, unlike normal 'text' messages.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS join_request_id INTEGER REFERENCES group_join_requests(id) ON DELETE CASCADE;

-- A message can also represent a server invite sent to someone's DMs (the
-- 'group_invite' message_type), rendered as an "X invited you to join"
-- card with Accept/Decline actions, analogous to join_request above but
-- living in a DM instead of a channel.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_invite_id INTEGER REFERENCES group_invites(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_dm ON messages(sender_id, recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
`;

// Postgres (especially in Docker) can take a few seconds to accept
// connections after the container starts, so retry on startup — but only
// for actual connectivity errors. A real error in the SCHEMA string (e.g. a
// bad migration statement) isn't a "not ready yet" situation and used to
// get logged as one, then silently retried 20 times before finally
// surfacing, which made it very hard to tell "Postgres is still booting"
// apart from "the schema migration is broken".
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', '57P03', '08006', '08001', '08004']);

async function init(retries = 20, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(SCHEMA);
      console.log('Connected to Postgres and ensured schema exists.');
      return;
    } catch (err) {
      if (!CONNECTION_ERROR_CODES.has(err.code)) {
        console.error('Postgres schema setup failed (this is a real error, not a "not ready yet" retry):', err.message);
        throw err;
      }
      console.log(`Postgres not ready yet (attempt ${attempt}/${retries}): ${err.message}`);
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  init
};