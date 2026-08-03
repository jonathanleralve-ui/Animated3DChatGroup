const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const AdmZip = require('adm-zip');

const auth = require('../middleware/auth');
const { MODEL_UPLOAD_DIR, MAX_MODEL_ZIP_MB } = require('../config');
const { extractAvatarModelPackage } = require('./avatarModelUtils');

fs.mkdirSync(MODEL_UPLOAD_DIR, { recursive: true });

// The zip is small enough (<=MAX_MODEL_ZIP_MB) to buffer in memory — we need
// the whole thing anyway to read it as a zip archive.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MODEL_ZIP_MB * 1024 * 1024 }
});

const router = express.Router();
router.use(auth);

router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Model package is too large (max ${MAX_MODEL_ZIP_MB}MB)` });
    }
    if (err) {
      console.error('avatar-model upload error', err);
      return res.status(400).json({ error: 'Upload failed' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    let zip;
    try {
      zip = new AdmZip(req.file.buffer);
    } catch (e) {
      return res.status(400).json({ error: 'That does not look like a valid .zip file' });
    }

    const folderName = `${req.user.id}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const destDir = path.join(MODEL_UPLOAD_DIR, folderName);
    fs.mkdirSync(destDir, { recursive: true });

    const extracted = extractAvatarModelPackage({ zip, destDir, userId: req.user.id });
    if (!extracted.modelUrl) {
      fs.rmSync(destDir, { recursive: true, force: true });
      return res.status(400).json({ error: 'Could not extract the .pmx model file' });
    }

    res.json({
      modelUrl: extracted.modelUrl,
      fileCount: extracted.fileCount
    });
  });
});

module.exports = router;