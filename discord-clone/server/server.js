require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { Server } = require('socket.io');

const { PORT, UPLOAD_DIR } = require('./config');
const db = require('./db');
const initSockets = require('./sockets');

const authRoutes = require('./routes/auth');
const friendRoutes = require('./routes/friends');
const groupRoutes = require('./routes/groups');
const channelRoutes = require('./routes/channels');
const messageRoutes = require('./routes/messages');
const uploadRoutes = require('./routes/upload');
const avatarModelRoutes = require('./routes/avatarModel');
const youtubeRoutes = require('./routes/youtube');

const app = express();

// If certs/*.pem exist (see mkcert setup in the README), serve over HTTPS
// so camera/mic/etc. work when accessed via a LAN IP instead of localhost -
// browsers only allow getUserMedia on secure origins (https, or literally
// "localhost"). Falls back to plain HTTP if no certs are present, so
// nothing breaks for anyone who hasn't set this up.
const certsDir = path.join(__dirname, '..', 'certs');
const keyPath = process.env.SSL_KEY_PATH || (fs.existsSync(certsDir)
  ? fs.readdirSync(certsDir).map((f) => path.join(certsDir, f)).find((f) => f.endsWith('-key.pem'))
  : null);
const certPath = process.env.SSL_CERT_PATH || (fs.existsSync(certsDir)
  ? fs.readdirSync(certsDir).map((f) => path.join(certsDir, f)).find((f) => f.endsWith('.pem') && !f.endsWith('-key.pem'))
  : null);
const useHttps = !!(keyPath && certPath && fs.existsSync(keyPath) && fs.existsSync(certPath));

const server = useHttps
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);
const io = new Server(server);
app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api', channelRoutes); // exposes /api/groups/:groupId/channels and /api/channels/:channelId
app.use('/api/messages', messageRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/upload/avatar-model', avatarModelRoutes);
app.use('/api/youtube', youtubeRoutes);

// No favicon in the project yet - respond quietly instead of a noisy 404.
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Fallback to the SPA for any non-API route. Requests that look like static
// asset files (have a file extension) but weren't matched by express.static
// above genuinely don't exist - return a proper 404 for those instead of
// silently serving index.html, so clients (e.g. GLTFLoader/fetch) can tell
// the difference between "page not found" and "asset missing".
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (path.extname(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

initSockets(io);

async function start() {
  await db.init();

  const requestedPort = Number(PORT) || 3000;
  const tryListen = (port) => new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE') {
        const fallbackPort = port + 1;
        server.off('error', onError);
        console.warn(`Port ${port} is busy; trying ${fallbackPort} instead.`);
        tryListen(fallbackPort).then(resolve).catch(reject);
        return;
      }

      server.off('error', onError);
      reject(err);
    };

    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve(port);
    });
  });

  const actualPort = await tryListen(requestedPort);
  const scheme = useHttps ? 'https' : 'http';
  console.log(`Discord-clone server running at ${scheme}://localhost:${actualPort}`);
  if (!useHttps) {
    console.log('Running over plain HTTP, camera/mic will only work via localhost, not a LAN IP.');
    console.log('See README for mkcert setup to enable HTTPS.');
  }
  }

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});