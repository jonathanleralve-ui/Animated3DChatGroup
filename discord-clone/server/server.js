require('dotenv').config();
const express = require('express');
const http = require('http');
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
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.use('/api/auth', authRoutes);
app.use('/api/friends', friendRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api', channelRoutes); // exposes /api/groups/:groupId/channels and /api/channels/:channelId
app.use('/api/messages', messageRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/upload/avatar-model', avatarModelRoutes);
app.use('/api/youtube', youtubeRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Fallback to the SPA for any non-API route
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
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
    server.listen(port, () => {
      server.off('error', onError);
      resolve(port);
    });
  });

  const actualPort = await tryListen(requestedPort);
  console.log(`Discord-clone server running at http://localhost:${actualPort}`);
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});