const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const iconv = require('iconv-lite');

const ALLOWED_EXTENSIONS = new Set(['.pmx', '.png', '.jpg', '.jpeg', '.bmp', '.tga', '.spa', '.sph', '.dds']);

function resolveEntryName(entry) {
  const forced = entry.entryName;
  if (!forced.includes('\uFFFD')) return forced;
  try {
    const reDecoded = iconv.decode(entry.rawEntryName, 'shift_jis');
    if (reDecoded && !reDecoded.includes('\uFFFD')) return reDecoded;
  } catch (e) {
    // fall through to best-effort forced name below
  }
  return forced;
}

function sanitizeRelativePath(entryName) {
  const normalized = String(entryName || '')
    .replace(/\\/g, '/')
    .replace(/^\//, '');

  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  if (parts.some((part) => part === '')) return null;

  const resolvedParts = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..') return null;
    resolvedParts.push(part);
  }

  return resolvedParts.join('/');
}

function toPublicUrl(destDir, relativeFilePath) {
  const rel = path.posix.normalize(relativeFilePath).replace(/^\//, '');
  const encoded = rel.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `/uploads/models/${path.basename(destDir)}/${encoded}`;
}

function extractAvatarModelPackage({ zip, destDir, userId }) {
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const safeEntries = entries.filter((entry) => sanitizeRelativePath(resolveEntryName(entry)));
  const pmxEntries = safeEntries.filter((entry) => resolveEntryName(entry).toLowerCase().endsWith('.pmx'));
  if (pmxEntries.length === 0) return { pmxFilename: null, modelUrl: null, fileCount: 0 };

  const pmxEntry = pmxEntries.reduce((largest, e) =>
    e.header.size > largest.header.size ? e : largest
  );

  const usedNames = new Set();
  let pmxFilename = null;
  let modelRelativePath = null;

  for (const entry of safeEntries) {
    const resolvedName = resolveEntryName(entry);
    const ext = path.extname(resolvedName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;

    const relPath = sanitizeRelativePath(resolvedName);
    if (!relPath) continue;

    const targetPath = path.join(destDir, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    const baseName = path.basename(relPath);
    const uniqueName = usedNames.has(baseName) ? `${crypto.randomBytes(4).toString('hex')}-${baseName}` : baseName;
    usedNames.add(uniqueName);

    fs.writeFileSync(path.join(destDir, relPath), entry.getData());

    if (entry === pmxEntry) {
      pmxFilename = relPath;
      modelRelativePath = relPath;
    }
  }

  if (!pmxFilename) return { pmxFilename: null, modelUrl: null, fileCount: 0 };

  return {
    pmxFilename,
    modelUrl: toPublicUrl(destDir, modelRelativePath),
    fileCount: usedNames.size
  };
}

module.exports = {
  resolveEntryName,
  sanitizeRelativePath,
  toPublicUrl,
  extractAvatarModelPackage
};
