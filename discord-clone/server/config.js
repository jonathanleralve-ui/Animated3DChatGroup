const path = require('path');

module.exports = {
  JWT_SECRET: process.env.JWT_SECRET || 'dev-secret-change-me-in-production',
  PORT: process.env.PORT || 3000,

  // Where uploaded chat attachments are stored on disk, and the max size
  // (in MB) accepted per file.
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'),
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 1024),

  // Where extracted 3D avatar model packages (.pmx + textures) live on disk,
  // and the max size (in MB) accepted for the uploaded .zip.
  MODEL_UPLOAD_DIR: process.env.MODEL_UPLOAD_DIR || path.join(__dirname, 'uploads', 'models'),
  MAX_MODEL_ZIP_MB: Number(process.env.MAX_MODEL_ZIP_MB || 200),

  // Used by the "play <song>" voice command (server/routes/youtube.js) to
  // search YouTube for a video to play. Get one at
  // https://console.cloud.google.com/apis/credentials after enabling the
  // "YouTube Data API v3" on a project - the voice command silently no-ops
  // (server returns 500) if this isn't set.
  YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY || null,

  // Postgres connection. Either set DATABASE_URL directly, or the individual
  // PG* vars below (used by docker-compose out of the box).
  DATABASE_URL: process.env.DATABASE_URL || null,
  PGHOST: process.env.PGHOST || 'localhost',
  PGPORT: process.env.PGPORT || 5432,
  PGUSER: process.env.PGUSER || 'chatter',
  PGPASSWORD: process.env.PGPASSWORD || 'chatter',
  PGDATABASE: process.env.PGDATABASE || 'chatter'
};