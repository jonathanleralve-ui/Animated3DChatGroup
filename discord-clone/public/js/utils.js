// Small DOM query and formatting helpers shared by every other module.
const Utils = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function initials(name) {
    return (name || '?').trim().charAt(0).toUpperCase();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(iso) {
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z');
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function avatarEl(user, size = '') {
    const el = document.createElement('div');
    el.className = `avatar ${size}`;
    el.style.background = user.avatarColor || user.senderColor || '#5865F2';
    if (user.avatarUrl) {
      el.innerHTML = '';
      const img = document.createElement('img');
      img.src = user.avatarUrl;
      img.alt = user.displayName || user.senderName || 'avatar';
      el.appendChild(img);
    } else {
      el.textContent = initials(user.displayName || user.senderName);
    }
    return el;
  }

  function avatarWithStatus(user) {
    // Status dot removed: return plain avatar element only
    return avatarEl(user);
  }

  // Base size (px) a profile effect sticker renders at before its own
  // `scale` multiplier is applied - shared between the editable version in
  // profile.js and this read-only renderer so a sticker looks the same
  // size everywhere it's shown.
  const EFFECT_BASE_SIZE = 56;

  // Renders a user's uploaded GIF "profile effects" (wings/fire/sparkles/
  // etc.) into `layerEl` as plain, non-interactive positioned stickers -
  // used by the member-card popover and friend cards. The editable version
  // (drag to move, scroll to resize, click to remove) lives in profile.js
  // since it needs a lot more state than a read-only display does.
  function renderProfileEffects(layerEl, effects) {
    if (!layerEl) return;
    layerEl.innerHTML = '';
    (effects || []).forEach((fx) => {
      if (!fx || !fx.url) return;
      const el = document.createElement('div');
      el.className = 'profile-effect-sticker';
      const size = EFFECT_BASE_SIZE * (fx.scale || 1);
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.left = `calc(50% + ${fx.x || 0}px)`;
      el.style.top = `calc(50% + ${fx.y || 0}px)`;
      const img = document.createElement('img');
      img.src = fx.url;
      img.alt = '';
      img.draggable = false;
      el.appendChild(img);
      layerEl.appendChild(el);
    });
  }

  function applyNameColor(el, color) {
    if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
      el.style.color = color;
    }
  }

  // Applies a user's avatar border (ring/glow/rainbow) and card accent color
  // to a profile-preview-card's ring + card elements. Shared by the edit-
  // profile preview card, the group member-card popover, and friend cards
  // so all three stay visually in sync - same idea as applyNameColor above.
  function applyCardTheming(cardEl, ringEl, user) {
    if (ringEl) {
      ringEl.classList.remove('avatar-border-solid', 'avatar-border-glow', 'avatar-border-rainbow');
      ringEl.style.removeProperty('--avatar-border-color');
      const style = user && user.avatarBorderStyle;
      const color = user && user.avatarBorderColor;
      if (style === 'rainbow') {
        ringEl.classList.add('avatar-border-rainbow');
      } else if ((style === 'solid' || style === 'glow') && color && /^#[0-9a-fA-F]{6}$/.test(color)) {
        ringEl.classList.add(style === 'glow' ? 'avatar-border-glow' : 'avatar-border-solid');
        ringEl.style.setProperty('--avatar-border-color', color);
      }
    }
    if (cardEl) {
      const accent = user && user.profileAccentColor;
      if (accent && /^#[0-9a-fA-F]{6}$/.test(accent)) {
        cardEl.classList.add('has-accent');
        cardEl.style.setProperty('--profile-accent', accent);
      } else {
        cardEl.classList.remove('has-accent');
        cardEl.style.removeProperty('--profile-accent');
      }
    }
  }

  // Given a plain-text video URL, return an embeddable iframe URL, or null
  // if it isn't a recognized video link. Covers YouTube, Vimeo, Twitch
  // (VODs, clips, and live channels), Dailymotion, Streamable, Loom,
  // and Twitter/X (tweet embeds, including any attached video).
  function getVideoEmbedUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.replace(/^www\.|^m\./, '');
    const path = u.pathname;

    if (host === 'youtube.com') {
      if (path === '/watch') {
        const id = u.searchParams.get('v');
        if (id) return `https://www.youtube.com/embed/${id}`;
      }
      const shorts = path.match(/^\/shorts\/([\w-]+)/);
      if (shorts) return `https://www.youtube.com/embed/${shorts[1]}`;
      const live = path.match(/^\/live\/([\w-]+)/);
      if (live) return `https://www.youtube.com/embed/${live[1]}`;
      return null;
    }
    if (host === 'youtu.be') {
      const id = path.slice(1);
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }

    if (host === 'vimeo.com') {
      const match = path.match(/^\/(\d+)/);
      return match ? `https://player.vimeo.com/video/${match[1]}` : null;
    }

    if (host === 'dailymotion.com') {
      const match = path.match(/^\/video\/([\w]+)/);
      return match ? `https://www.dailymotion.com/embed/video/${match[1]}` : null;
    }
    if (host === 'dai.ly') {
      const id = path.slice(1);
      return id ? `https://www.dailymotion.com/embed/video/${id}` : null;
    }

    if (host === 'streamable.com') {
      const id = path.slice(1).split('/')[0];
      return id ? `https://streamable.com/e/${id}` : null;
    }

    if (host === 'loom.com') {
      const match = path.match(/^\/share\/([\w]+)/);
      return match ? `https://www.loom.com/embed/${match[1]}` : null;
    }

    // Twitch requires a `parent` param matching the embedding page's own
    // hostname, or it refuses to load — filled in from the current page.
    if (host === 'twitch.tv') {
      const parent = window.location.hostname;
      const clip = path.match(/\/clip\/([\w-]+)/);
      if (clip) return `https://clips.twitch.tv/embed?clip=${clip[1]}&parent=${parent}`;
      const vod = path.match(/^\/videos\/(\d+)/);
      if (vod) return `https://player.twitch.tv/?video=${vod[1]}&parent=${parent}`;
      const channel = path.match(/^\/([a-zA-Z0-9_]+)\/?$/);
      if (channel) return `https://player.twitch.tv/?channel=${channel[1]}&parent=${parent}`;
      return null;
    }
    if (host === 'clips.twitch.tv') {
      const slug = path.slice(1).split('/')[0];
      return slug ? `https://clips.twitch.tv/embed?clip=${slug}&parent=${window.location.hostname}` : null;
    }

    // Twitter/X: the tweet id is all we need — this is the same embed
    // endpoint their own widgets.js script loads into an iframe, so it
    // renders (including any attached video) without that script.
    if (host === 'twitter.com' || host === 'x.com') {
      const tweet = path.match(/\/status\/(\d+)/);
      return tweet ? `https://platform.twitter.com/embed/Tweet.html?id=${tweet[1]}` : null;
    }

    return null;
  }

  // Renders `text` into `container` as text nodes with any http(s) URLs
  // turned into clickable links. Returns the embed URL of the first
  // recognized video link found (or null), so the caller can render a
  // player beneath the message.
  function linkifyText(container, text) {
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    let lastIndex = 0;
    let match;
    let embedUrl = null;

    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[0];
      if (match.index > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const a = document.createElement('a');
      a.href = url;
      a.textContent = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'message-link';
      container.appendChild(a);

      if (!embedUrl) embedUrl = getVideoEmbedUrl(url);

      lastIndex = match.index + url.length;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
    return embedUrl;
  }

  // A message counts as "emoji-only" when, once whitespace is stripped, it's
  // made up entirely of emoji characters (plus their variation-selector/ZWJ
  // modifiers) and there aren't too many of them — mirrors how Discord/Slack
  // only "jumbo" a handful of emoji, not a wall of them.
  const EMOJI_ONLY_REGEX = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D)+$/u;
  const EMOJI_ONLY_MAX_LENGTH = 24;

  function isEmojiOnly(text) {
    const trimmed = (text || '').trim();
    if (!trimmed || trimmed.length > EMOJI_ONLY_MAX_LENGTH) return false;
    return EMOJI_ONLY_REGEX.test(trimmed);
  }

  // Makes a .pixel-modal draggable by its titlebar, like a little retro
  // desktop window. Call once per modal element. Automatically re-centers
  // the modal each time its `hidden` class is toggled off, so it doesn't
  // reopen wherever it was last dragged to.
  function makeModalDraggable(modal) {
    if (!modal) return;
    const titlebar = modal.querySelector('.pixel-modal-titlebar');
    if (!titlebar) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    function onPointerDown(e) {
      // Don't start a drag when the close button itself is clicked.
      if (e.target.closest('.pixel-modal-close')) return;

      dragging = true;
      titlebar.classList.add('dragging');

      const rect = modal.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      // Switch from the default translate-centered position to an
      // explicit left/top so it can be moved freely from here on.
      modal.style.transform = 'none';
      modal.style.left = `${rect.left}px`;
      modal.style.top = `${rect.top}px`;

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
      if (!dragging) return;

      const rect = modal.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;

      const nextX = Math.min(Math.max(0, e.clientX - offsetX), Math.max(0, maxX));
      const nextY = Math.min(Math.max(0, e.clientY - offsetY), Math.max(0, maxY));

      modal.style.left = `${nextX}px`;
      modal.style.top = `${nextY}px`;
    }

    function onPointerUp() {
      dragging = false;
      titlebar.classList.remove('dragging');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    titlebar.addEventListener('pointerdown', onPointerDown);

    const observer = new MutationObserver(() => {
      if (!modal.classList.contains('hidden')) {
        modal.style.left = '';
        modal.style.top = '';
        modal.style.transform = 'translate(-50%, -50%)';
      }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  // Drags a panel by a handle element, same pointer mechanics as
  // makeModalDraggable, but WITHOUT the auto-recenter-on-unhide behavior —
  // this is for panels (like the DM chat pop-up) that also have a normal
  // non-floating mode, so we don't want every class change to snap its
  // position. Callers are responsible for resetting position/transform
  // themselves when switching modes. Dragging only starts if `panel` has
  // the `activeClass` class at the time of the pointerdown.
  function makeFloatingDraggable(panel, handle, activeClass) {
    if (!panel || !handle) return;

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    function onPointerDown(e) {
      if (e.target.closest('.pixel-modal-close')) return;
      if (activeClass && !panel.classList.contains(activeClass)) return;

      dragging = true;
      handle.classList.add('dragging');

      const rect = panel.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;

      panel.style.transform = 'none';
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
      if (!dragging) return;

      const rect = panel.getBoundingClientRect();
      const maxX = window.innerWidth - rect.width;
      const maxY = window.innerHeight - rect.height;

      const nextX = Math.min(Math.max(0, e.clientX - offsetX), Math.max(0, maxX));
      const nextY = Math.min(Math.max(0, e.clientY - offsetY), Math.max(0, maxY));

      panel.style.left = `${nextX}px`;
      panel.style.top = `${nextY}px`;
    }

    function onPointerUp() {
      dragging = false;
      handle.classList.remove('dragging');
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    handle.addEventListener('pointerdown', onPointerDown);
  }

  return { $, $$, initials, escapeHtml, formatTime, avatarEl, avatarWithStatus, applyNameColor, applyCardTheming, EFFECT_BASE_SIZE, renderProfileEffects, linkifyText, getVideoEmbedUrl, isEmojiOnly, makeModalDraggable, makeFloatingDraggable };
})();