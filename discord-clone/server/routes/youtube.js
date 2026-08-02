const express = require('express');
const auth = require('../middleware/auth');
const { YOUTUBE_API_KEY } = require('../config');

const router = express.Router();
router.use(auth);

// Backs the "play <song>" voice command (see public/js/voice-speech.js).
// The client sends whatever raw text it heard after "play" - not cleaned up
// or guaranteed to be a real song title - and we just hand it straight to
// YouTube's search and return the first result. The API key never reaches
// the client; this is the only thing that talks to Google.
router.get('/search', async (req, res) => {
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube search is not configured on this server' });
  }

  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.status(400).json({ error: 'Missing search query' });
  if (q.length > 200) return res.status(400).json({ error: 'Search query is too long' });

  try {
    const url = new URL('https://www.googleapis.com/youtube/v3/search');
    url.searchParams.set('part', 'snippet');
    url.searchParams.set('type', 'video');
    url.searchParams.set('maxResults', '1');
    url.searchParams.set('q', q);
    url.searchParams.set('key', YOUTUBE_API_KEY);

    const ytRes = await fetch(url);
    const data = await ytRes.json();

    if (!ytRes.ok) {
      console.error('YouTube search failed', data);
      return res.status(502).json({ error: 'YouTube search failed' });
    }

    const item = data.items && data.items[0];
    if (!item) return res.status(404).json({ error: 'No results found' });

    res.json({
      videoId: item.id.videoId,
      title: item.snippet.title,
      channelTitle: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails && item.snippet.thumbnails.default
        ? item.snippet.thumbnails.default.url
        : null
    });
  } catch (err) {
    console.error('YouTube search error', err);
    res.status(502).json({ error: 'YouTube search failed' });
  }
});

module.exports = router;
