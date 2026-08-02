// Wake-word style voice command detector for voice chat. Uses the browser's
// built-in SpeechRecognition (Chrome/Edge; not available in Firefox and only
// partially in Safari) to listen continuously while connected to a voice
// channel, and calls back with an emoji when it hears one of the configured
// trigger phrases. Note this is NOT local/offline - Chrome's implementation
// streams audio to Google's servers to transcribe it. If the API isn't
// supported, start() just no-ops so voice chat itself is unaffected.
const VoiceSpeech = (() => {
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Fallback list used until the signed-in user has saved their own words
  // (or if they clear their list back to empty) - see setTriggers() below.
  const DEFAULT_TRIGGERS = [
    { phrase: 'party', emoji: '🎉' },
    { phrase: 'gg', emoji: '🏆' },
    { phrase: 'laugh', emoji: '😂' },
    { phrase: 'sad', emoji: '😢' },
    { phrase: 'wow', emoji: '😮' }
  ];

  let TRIGGERS = DEFAULT_TRIGGERS.slice();

  // Swaps in a member's custom word list (from AppState.me.voiceCommandTriggers,
  // saved via the voice-command settings panel). Falls back to the defaults
  // for anything missing/invalid/empty, so recognition never ends up running
  // with zero triggers just because a field came back malformed.
  function setTriggers(list) {
    if (!Array.isArray(list) || list.length === 0) {
      TRIGGERS = DEFAULT_TRIGGERS.slice();
      return;
    }
    const cleaned = list
      .filter((t) => t && typeof t.phrase === 'string' && t.phrase.trim() && typeof t.emoji === 'string' && t.emoji.trim())
      .map((t) => ({ phrase: t.phrase.trim().toLowerCase(), emoji: t.emoji.trim() }));
    TRIGGERS = cleaned.length ? cleaned : DEFAULT_TRIGGERS.slice();
  }

  const COOLDOWN_MS = 1500; // don't refire on the same breath/echoed word

  let recognition = null;
  let listening = false; // intent flag - distinguishes "stopped on purpose" from onend's auto-restart
  let onTrigger = null;
  let lastTriggerAt = 0;

  function supported() {
    return !!SpeechRecognitionImpl;
  }

  function checkForTrigger(transcript) {
    const heard = transcript.toLowerCase();
    const now = Date.now();
    if (now - lastTriggerAt < COOLDOWN_MS) return;
    const match = TRIGGERS.find((t) => heard.includes(t.phrase));
    if (match) {
      lastTriggerAt = now;
      console.log('[VoiceSpeech] trigger matched:', match.phrase, '->', match.emoji);
      if (onTrigger) onTrigger(match.emoji, match.phrase);
    }
  }

  // triggerCallback(emoji, phrase) is called whenever a trigger word is heard.
  function start(triggerCallback) {
    if (!supported() || listening) return;
    onTrigger = triggerCallback;
    listening = true;
    startRecognitionInstance();
  }

  function startRecognitionInstance() {
    recognition = new SpeechRecognitionImpl();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => console.log('[VoiceSpeech] listening for trigger words:', TRIGGERS.map((t) => t.phrase).join(', '));

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      console.log('[VoiceSpeech] heard:', result[0].transcript, result.isFinal ? '(final)' : '(interim)');
      checkForTrigger(result[0].transcript);
    };

    // Chrome silently ends recognition after a stretch of silence (or the
    // occasional network hiccup) - restart it as long as we're still
    // supposed to be listening. `listening` is only false once stop() was
    // called on purpose, so this keeps "always listening" actually always on.
    recognition.onend = () => {
      if (listening) {
        try { startRecognitionInstance(); } catch (err) { /* races with a pending stop() - ignore */ }
      }
    };

    recognition.onerror = (e) => {
      // 'no-speech' and 'aborted' fire constantly in normal use (just gaps
      // between words). 'network' is also expected noise in continuous mode -
      // Chrome periodically loses its connection to the speech backend even
      // on a fine connection, and onend's restart below recovers from it
      // automatically. Only worth logging anything else.
      if (e.error !== 'no-speech' && e.error !== 'aborted' && e.error !== 'network') {
        console.warn('[VoiceSpeech] recognition error:', e.error);
      }
    };

    try { recognition.start(); } catch (err) { /* ignore double-start races */ }
  }

  function stop() {
    listening = false;
    if (recognition) {
      recognition.onend = null;
      recognition.onresult = null;
      try { recognition.stop(); } catch (err) { /* already stopped */ }
      recognition = null;
    }
  }

  return { supported, start, stop, setTriggers, getTriggers: () => TRIGGERS, DEFAULT_TRIGGERS };
})();