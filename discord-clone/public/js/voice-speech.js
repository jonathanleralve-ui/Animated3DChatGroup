// Wake-word style voice command detector for voice chat. Uses the browser's
// built-in SpeechRecognition (Chrome/Edge; not available in Firefox and only
// partially in Safari) to listen continuously while connected to a voice
// channel. Handles two kinds of commands:
//  - fixed trigger words/phrases, from TWO sources merged together (see
//    rebuildTriggers): the group's shared Public list (word + optional
//    sound only) and this user's own local Private list (word + sound +
//    which saved avatar-reaction slot to fire) - both configured in the
//    voice-command settings panel (public/js/voice-command-settings.js).
//    Calls back with the matched phrase, an optional custom uploaded sound
//    URL, and whether/which slot to pulse the speaker's avatar-hold
//    reaction with.
//  - "play <song>" - calls back with whatever was said after "play" so the
//    caller can look it up on YouTube (see voice-youtube.js).
// No icon/emoji is shown for either - the only feedback is audio. Note this
// is NOT local/offline - Chrome's implementation streams audio to Google's
// servers to transcribe it. If the API isn't supported, start() just no-ops
// so voice chat itself is unaffected.
const VoiceSpeech = (() => {
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Fallback list used until the signed-in user has saved their own words
  // (or if they clear their list back to empty) - see setTriggers() below.
  const DEFAULT_TRIGGERS = [
    { phrase: 'party' },
    { phrase: 'gg' },
    { phrase: 'laugh' },
    { phrase: 'sad' },
    { phrase: 'wow' }
  ];

  let PUBLIC_TRIGGERS = DEFAULT_TRIGGERS.slice(); // the group's shared word list
  let PRIVATE_TRIGGERS = []; // this user's own personal word list (see voice-command-settings.js)
  let TRIGGERS = DEFAULT_TRIGGERS.slice(); // PUBLIC_TRIGGERS + PRIVATE_TRIGGERS merged - what matching actually checks
  let LANGUAGE = 'en-US';

  // Recomputes the merged list checkForTrigger() matches against, any time
  // either half changes. Falls back to the defaults only when BOTH halves
  // end up empty, same as the old single-list behavior.
  function rebuildTriggers() {
    const merged = PUBLIC_TRIGGERS.concat(PRIVATE_TRIGGERS);
    TRIGGERS = merged.length ? merged : DEFAULT_TRIGGERS.slice();
  }

  // Swaps in the current group's shared word list (from group.voiceCommandTriggers,
  // saved via the Public tab of the voice-command settings panel). This half
  // is just a word + optional sound - no avatar reaction, since that's now
  // exclusively a Private-tab thing (see setPrivateTriggers below).
  function setTriggers(list) {
    if (!Array.isArray(list) || list.length === 0) {
      PUBLIC_TRIGGERS = [];
    } else {
      PUBLIC_TRIGGERS = list
        .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim())
        .map((t) => ({
          phrase: t.phrase.trim().toLowerCase(),
          soundUrl: typeof t.soundUrl === 'string' && t.soundUrl.trim() ? t.soundUrl.trim() : null,
          avatarReaction: false,
          reactionSlot: null,
          reactionHoldMs: null
        }));
    }
    rebuildTriggers();
  }

  // Swaps in this user's own personal word list (from the Private tab -
  // stored locally per-user, not shared with the group, see
  // voice-command-settings.js's loadPrivateTriggers/getPrivateTriggers).
  // Every private trigger always reacts (that's the whole point of the
  // slot picker), so avatarReaction is forced true regardless of what's
  // in the stored row.
  function setPrivateTriggers(list) {
    if (!Array.isArray(list) || list.length === 0) {
      PRIVATE_TRIGGERS = [];
    } else {
      PRIVATE_TRIGGERS = list
        .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim())
        .map((t) => ({
          phrase: t.phrase.trim().toLowerCase(),
          soundUrl: typeof t.soundUrl === 'string' && t.soundUrl.trim() ? t.soundUrl.trim() : null,
          avatarReaction: true,
          reactionSlot: Number.isInteger(t.reactionSlot) ? t.reactionSlot : null,
          reactionHoldMs: Number.isFinite(t.reactionHoldMs) ? t.reactionHoldMs : null
        }));
    }
    rebuildTriggers();
  }

  // Sets which language the recognizer transcribes (BCP-47 tag, e.g.
  // 'en-US' or 'es-ES') - a group-wide setting from group.voiceCommandLanguage,
  // since the Web Speech API only listens in one language per session and
  // can't auto-detect between them. If recognition is already running, it's
  // restarted so the new language takes effect immediately instead of
  // waiting for the next join.
  function setLanguage(lang) {
    const next = (typeof lang === 'string' && lang.trim()) ? lang.trim() : 'en-US';
    if (next === LANGUAGE) return;
    LANGUAGE = next;
    if (listening) {
      if (recognition) {
        recognition.onend = null;
        try { recognition.stop(); } catch (err) { /* already stopped */ }
      }
      startRecognitionInstance();
    }
  }

  const COOLDOWN_MS = 1500; // don't refire on the same breath/echoed word
  const PLAY_COOLDOWN_MS = 4000; // song requests take longer to say/search than a one-word trigger
  const RESTART_BACKOFF_MS = 250; // avoid rapid restart loops if recognition ends repeatedly
  const RESTART_THROTTLE_MS = 2000; // reset restart count after this interval
  const MAX_RESTARTS_PER_WINDOW = 3; // stop restarting if recognition is failing rapidly
  // Matches "play <anything>" (optionally preceded by other words, e.g. "hey
  // can you play baby by justin bieber") and captures the song text. Only
  // checked against final results (see onresult below) so the capture group
  // has the whole request rather than firing on "play b" mid-sentence.
  const PLAY_RE = /\bplay\s+(.+)/i;

  let recognition = null;
  let currentRecognitionId = 0;
  let restartTimer = null;
  let restartCount = 0;
  let lastRestartAt = 0;
  let listening = false; // intent flag - distinguishes "stopped on purpose" from onend's auto-restart
  let onTrigger = null;
  let onPlaySong = null;
  let onSongControl = null;
  let lastTriggerAt = 0;
  let lastPlayAt = 0;

  function supported() {
    return !!SpeechRecognitionImpl;
  }

  function checkForTrigger(transcript) {
    const heard = transcript.toLowerCase();
    const now = Date.now();
    if (now - lastTriggerAt >= COOLDOWN_MS) {
      const match = TRIGGERS.find((t) => heard.includes(t.phrase));
      if (match) {
        lastTriggerAt = now;
        console.log('[VoiceSpeech] trigger matched:', match.phrase);
        if (onTrigger) onTrigger(match.phrase, match.soundUrl, match.avatarReaction, match.reactionSlot, match.reactionHoldMs);
      }
    }
  }

  function checkForSongControl(transcript, isFinal) {
    if (!isFinal || !onSongControl) return false;
    const heard = transcript.toLowerCase();
    const match = heard.match(/\b(stop|continue|remove)\b/i);
    if (!match) return false;
    const action = match[1].toLowerCase() === 'stop' ? 'pause' : match[1].toLowerCase() === 'remove' ? 'remove' : 'resume';
    if (action === 'pause') onSongControl('pause');
    else if (action === 'remove') onSongControl('remove');
    else onSongControl('resume');
    console.log('[VoiceSpeech] song control matched:', action);
    return true;
  }

  function checkForPlayCommand(transcript, allowInterim = false) {
    const now = Date.now();
    if (now - lastPlayAt < PLAY_COOLDOWN_MS) return;
    const match = transcript.match(PLAY_RE);
    if (!match || !match[1].trim()) return;

    const query = match[1].trim();
    if (query.length < 4) return;
    if (allowInterim && query.split(/\s+/).length === 1) return;

    lastPlayAt = now;
    console.log('[VoiceSpeech] play command matched:', query, allowInterim ? '(interim)' : '');
    if (onPlaySong) onPlaySong(query);
  }

  // triggerCallback(phrase, soundUrl, avatarReaction, reactionSlot, reactionHoldMs)
  // is called whenever a trigger word is heard. playCallback(query) is
  // called whenever "play <something>" is
  // heard - query is the raw, uncleaned text said after "play".
  function start(triggerCallback, playCallback, songControlCallback) {
    if (!supported() || listening) return;
    onTrigger = triggerCallback;
    onPlaySong = playCallback;
    onSongControl = songControlCallback;
    listening = true;
    startRecognitionInstance();
  }

  function startRecognitionInstance() {
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      try { recognition.stop(); } catch (err) { /* ignore already stopped */ }
      recognition = null;
    }

    const instanceId = ++currentRecognitionId;
    recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = LANGUAGE;

    recognition.onstart = () => console.log('[VoiceSpeech] listening for trigger words:', TRIGGERS.map((t) => t.phrase).join(', '));

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        console.log('[VoiceSpeech] heard:', result[0].transcript, result.isFinal ? '(final)' : '(interim)');
        // Trigger words fire the instant they're heard, even on interim
        // (in-progress) results - no waiting for Chrome to detect a pause.
        // COOLDOWN_MS in checkForTrigger already stops the same word from
        // refiring as the interim transcript keeps getting revised.
        checkForTrigger(result[0].transcript);
        if (result.isFinal) {
          // "play <song>" and song control ("stop"/"continue"/"remove")
          // stay final-only on purpose - they need the pause so the full
          // request/word is captured instead of cutting off mid-sentence.
          if (checkForSongControl(result[0].transcript, true)) continue;
          checkForPlayCommand(result[0].transcript, false);
        }
      }
    };

    // Chrome silently ends recognition after a stretch of silence (or the
    // occasional network hiccup) - restart it as long as we're still
    // supposed to be listening. `listening` is only false once stop() was
    // called on purpose, so this keeps "always listening" actually always on.
    recognition.onend = () => {
      if (instanceId !== currentRecognitionId) return;
      if (!listening) return;

      const now = Date.now();
      if (now - lastRestartAt > RESTART_THROTTLE_MS) {
        restartCount = 0;
      }
      lastRestartAt = now;
      restartCount += 1;
      if (restartCount > MAX_RESTARTS_PER_WINDOW) {
        console.warn('[VoiceSpeech] recognition restarting too often; giving up until stop/start resets it');
        return;
      }

      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = window.setTimeout(() => {
        restartTimer = null;
        if (listening && instanceId === currentRecognitionId) {
          try { startRecognitionInstance(); } catch (err) { /* races with a pending stop() - ignore */ }
        }
      }, RESTART_BACKOFF_MS);
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'permission-denied') {
        console.warn('[VoiceSpeech] recognition permission denied:', e.error);
        stop();
        return;
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted' && e.error !== 'network') {
        console.warn('[VoiceSpeech] recognition error:', e.error);
      }
    };

    try { recognition.start(); } catch (err) { /* ignore double-start races */ }
  }

  function stop() {
    listening = false;
    onSongControl = null;
    currentRecognitionId += 1; // invalidate any pending restart callbacks for old instances
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      try { recognition.stop(); } catch (err) { /* already stopped */ }
      recognition = null;
    }
  }

  return { supported, start, stop, setTriggers, setPrivateTriggers, setLanguage, getTriggers: () => TRIGGERS, DEFAULT_TRIGGERS };
})();