// Wake-word style voice command detector for voice chat. Uses the browser's
// built-in SpeechRecognition (Chrome/Edge; not available in Firefox and only
// partially in Safari) to listen continuously while connected to a voice
// channel. Handles two kinds of commands:
//  - fixed trigger words/phrases (configured in the voice-command settings
//    panel) - calls back with the matched phrase and an optional custom
//    uploaded sound URL.
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

  let TRIGGERS = DEFAULT_TRIGGERS.slice();
  let LANGUAGE = 'en-US';

  // Swaps in the current group's shared word list (from group.voiceCommandTriggers,
  // saved via the voice-command settings panel). Falls back to the defaults
  // for anything missing/invalid/empty, so recognition never ends up running
  // with zero triggers just because a field came back malformed.
  function setTriggers(list) {
    if (!Array.isArray(list) || list.length === 0) {
      TRIGGERS = DEFAULT_TRIGGERS.slice();
      return;
    }
    const cleaned = list
      .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim())
      .map((t) => ({
        phrase: t.phrase.trim().toLowerCase(),
        soundUrl: typeof t.soundUrl === 'string' && t.soundUrl.trim() ? t.soundUrl.trim() : null
      }));
    TRIGGERS = cleaned.length ? cleaned : DEFAULT_TRIGGERS.slice();
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
        if (onTrigger) onTrigger(match.phrase, match.soundUrl);
      }
    }
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

  // triggerCallback(phrase, soundUrl) is called whenever a trigger word is
  // heard. playCallback(query) is called whenever "play <something>" is
  // heard - query is the raw, uncleaned text said after "play".
  function start(triggerCallback, playCallback) {
    if (!supported() || listening) return;
    onTrigger = triggerCallback;
    onPlaySong = playCallback;
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
        checkForTrigger(result[0].transcript);
        checkForPlayCommand(result[0].transcript, !result.isFinal);
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

  return { supported, start, stop, setTriggers, setLanguage, getTriggers: () => TRIGGERS, DEFAULT_TRIGGERS };
})();