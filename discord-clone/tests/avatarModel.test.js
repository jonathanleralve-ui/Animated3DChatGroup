const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

const { extractAvatarModelPackage, toPublicUrl } = require('../server/routes/avatarModelUtils');

test('preserves nested texture folders and encodes non-ASCII paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-model-'));

  try {
    const zip = new AdmZip();
    zip.addFile('character/model.pmx', Buffer.from('pmx'));
    zip.addFile('character/textures/皮肤.png', Buffer.from('texture'));
    zip.addFile('character/textures/space name.png', Buffer.from('texture'));

    const result = extractAvatarModelPackage({ zip, destDir: tempDir, userId: '42' });

    assert.ok(fs.existsSync(path.join(tempDir, 'character', 'textures', '皮肤.png')));
    assert.ok(fs.existsSync(path.join(tempDir, 'character', 'textures', 'space name.png')));
    assert.match(result.modelUrl, /character\/model\.pmx$/);
    assert.equal(toPublicUrl(tempDir, 'character/textures/皮肤.png'), '/uploads/models/' + path.basename(tempDir) + '/character/textures/' + encodeURIComponent('皮肤.png'));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('keeps extraction inside the upload root even for traversal-like names', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-model-safe-'));

  try {
    const zip = new AdmZip();
    zip.addFile('character/model.pmx', Buffer.from('pmx'));
    zip.addFile('folder/../evil.pmx', Buffer.from('evil'));

    const result = extractAvatarModelPackage({ zip, destDir: tempDir, userId: '99' });

    assert.ok(fs.existsSync(path.join(tempDir, 'character', 'model.pmx')));
    assert.ok(fs.existsSync(path.join(tempDir, 'evil.pmx')));
    assert.equal(fs.existsSync(path.join(tempDir, '..', 'evil.pmx')), false);
    assert.equal(result.fileCount, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
