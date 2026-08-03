// Plays songs from YouTube in a voice channel, triggered by the "play
// <song>" voice command (see voice-speech.js) or relayed from whoever else
// in the call said it (see voice.js). Wraps the official YouTube IFrame
// Player API - the video itself isn't shown, only the audio track is
// audible, same as if you'd opened the video muted-visually in a tiny tab.
// There's no shared audio bus between participants, so each person's
// player starts independently when they get the video ID - close enough
// for "someone yelled play a song" but not frame-accurate sync.
const VoiceYoutube = (() => {
  let player = null;
  let apiReadyPromise = null;
  let onStateChange = null; // (status, info) - status: 'loading' | 'playing' | 'stopped' | 'error'
  let currentTitle = null;

  // The IFrame API loads itself async and calls a *global* callback when
  // ready (that's just how YouTube's embed script works) - wrap that in a
  // promise so callers can just await it instead of juggling globals.
  function loadApi() {
    if (apiReadyPromise) return apiReadyPromise;
    apiReadyPromise = new Promise((resolve) => {
      if (window.YT && window.YT.Player) { resolve(); return; }
      const prevCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prevCallback === 'function') prevCallback();
        resolve();
      };
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    });
    return apiReadyPromise;
  }

  // containerId must point at an element already in the DOM (see the
  // #voice-youtube-player div in index.html) - the Player constructor
  // replaces it with the actual <iframe>. Kept off-screen via CSS rather
  // than removed from the DOM, since a detached container breaks the API.
  async function init(containerId) {
    await loadApi();
    if (player) return player;
    player = await new Promise((resolve) => {
      const p = new YT.Player(containerId, {
        height: '1',
        width: '1',
        playerVars: { autoplay: 1, playsinline: 1 },
        events: {
          onReady: () => resolve(p),
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.PLAYING && onStateChange) onStateChange('playing', { title: currentTitle });
            if (e.data === YT.PlayerState.ENDED && onStateChange) onStateChange('stopped', {});
          },
          onError: () => { if (onStateChange) onStateChange('error', {}); }
        }
      });
    });
    return player;
  }

  // title is just for the "now playing" UI - it comes from whatever the
  // YouTube search returned (see Api.youtube.search), not re-verified here.
  async function play(videoId, title, startSeconds = 0) {
    currentTitle = title || null;
    if (onStateChange) onStateChange('loading', { title: currentTitle });
    const p = await init('voice-youtube-player');
    p.loadVideoById({ videoId, startSeconds: Number(startSeconds) || 0 });
  }

  function stop() {
    currentTitle = null;
    if (player && player.stopVideo) player.stopVideo();
    if (onStateChange) onStateChange('stopped', {});
  }

  function setOnStateChange(cb) {
    onStateChange = cb;
  }

  return { init, play, stop, setOnStateChange };
})();
