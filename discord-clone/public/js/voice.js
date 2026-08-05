const VoiceChat = (() => {
  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  const SPEAKING_THRESHOLD = 0.02; // RMS volume above this counts as "talking"
  const SPEAKING_HOLD_MS = 350;    // keep ring lit briefly between words

  // Custom voice command feedback sounds. Place your files under public/audio
  // and update these paths to match the file names you want to use.
  const VOICE_COMMAND_SUCCESS_SOUND = '/audio/voice-success.mp3';
  const VOICE_COMMAND_FAIL_SOUND = '/audio/voice-fail.mp3';

  let socket = null;
  let me = null;

  let connectedChannelId = null;
  let connectedChannelName = null;
  let connectedGroupId = null;
  let openGroupId = null;

  let localMicStream = null;
  let localScreenStream = null;
  let sharingScreen = false;
  let muted = false;

  // Pending "release" for a voice-command-triggered avatar reaction - see
  // pulseAvatarReaction(). Speech has no natural mouse-up moment, so this
  // is what auto-releases the hold after a timeout instead.
  let voiceReactionTimer = null;
  // Fallback when a trigger doesn't specify its own duration (e.g. an
  // older saved word from before this was configurable). Clamped range
  // mirrors what the settings panel and server both enforce.
  const VOICE_COMMAND_REACTION_HOLD_MS = 1200;
  const VOICE_COMMAND_REACTION_HOLD_MS_MIN = 200;
  const VOICE_COMMAND_REACTION_HOLD_MS_MAX = 10000;

  const peers = {};
  const speakingDetectors = {}; // key ('self' or socketId) -> { audioCtx, source, rafId }
  const avatar3DInstances = {}; // key -> { api, modelUrl, container }
  let gazeBroadcastInterval = null;
  let lastSentGazeDX = 0, lastSentGazeDY = 0;

  // Per-participant avatar-ring diameter (px), adjustable by hovering the
  // ring and scrolling the wheel. renderParticipants() rebuilds the tile
  // DOM from scratch on every join/leave/mute/share change, so the size
  // itself has to live here (keyed like avatar3DInstances) rather than on
  // the element, or it'd reset back to default on the next re-render.
  const tileSizes = {}; // key -> diameter in px
  // key -> { x, y } in px, relative to #voice-participants' top-left.
  // Absent = tile stays in the normal flex-wrap flow (the default grid
  // layout); once a tile's been dragged, it switches to free positioning
  // and stays there across re-renders until the page reloads.
  const tilePositions = {};
  const TILE_SIZE_DEFAULT = 250;
  const TILE_SIZE_MIN = 64;
  const TILE_SIZE_MAX = 360;
  const TILE_SIZE_STEP = 12;

  // key -> { x, y } in px, relative to #voice-panel-scroll's top-left (the
  // shared container for both the avatar tiles and the screen-share
  // tiles). Lets a screen-share ("live share") tile be dragged anywhere
  // across the whole voice chat area, not just within its own row.
  const streamTilePositions = {};

  function $(sel) { return document.querySelector(sel); }
  const { avatarEl, initials } = Utils;

  // ============ PUBLIC API ============

  function init(_socket, _me) {
    socket = _socket;
    me = _me;

    socket.on('voice:existing-peers', ({ peers: list }) => {
      list.forEach((p) => connectToPeer(p.socketId, p, true));
      renderParticipants();
    });

    socket.on('voice:peer-joined', (p) => {
      connectToPeer(p.socketId, p, false);
      renderParticipants();
    });

    socket.on('voice:peer-left', ({ socketId }) => {
      teardownPeer(socketId);
      renderParticipants();
    });

    socket.on('voice:peer-screen-update', ({ socketId, sharing }) => {
      if (peers[socketId]) peers[socketId].info.sharing = sharing;
      if (!sharing) removeRemoteVideoTile(socketId);
      renderParticipants();
    });

    socket.on('voice:peer-mute-update', ({ socketId, muted: peerMuted }) => {
      if (peers[socketId]) peers[socketId].info.muted = peerMuted;
      renderParticipants();
    });

    // Someone else saved profile/avatar changes (new active surprise slot,
    // new framing, new model, etc.) while already connected to the call -
    // see the voice:profile-update emit in refreshSelfTile() below. Merge
    // the fresh fields into our cached copy of their info so their tile
    // picks it up on the very next re-render instead of only after they
    // leave and rejoin the channel.
    socket.on('voice:peer-profile-update', ({ socketId, ...info }) => {
      if (peers[socketId]) Object.assign(peers[socketId].info, info);
      renderParticipants();
    });

    // Someone else's avatar just turned to look somewhere - apply it to
    // our copy of their tile if it's mounted. Doesn't touch renderParticipants
    // at all - this is purely a visual nudge on an already-mounted instance,
    // way too frequent to justify rebuilding the whole tile list.
    socket.on('voice:gaze', ({ socketId, dx, dy }) => {
      const inst = avatar3DInstances[socketId];
      if (inst && inst.api.setRemoteGaze) inst.api.setRemoteGaze({ dx, dy });
    });

    // Someone else is mouse-holding their own tile - mirror the surprise
    // expression on our copy of their avatar. slotIndex, if present, means
    // a voice command asked for a specific saved slot rather than
    // whatever's active for them normally.
    socket.on('voice:mouse-hold', ({ socketId, held, slotIndex }) => {
      const inst = avatar3DInstances[socketId];
      if (inst && inst.api.setMouseHoldSurprise) inst.api.setMouseHoldSurprise(held, slotIndex);
    });

    // Someone else's voice command fired a reaction - show it over their tile.
    socket.on('voice:reaction', ({ soundUrl }) => {
      showReaction(soundUrl);
    });

    // Someone else said "play <song>" - load the same video into our own
    // hidden player too, so the whole channel hears it.
    const startCurrentSong = ({ videoId, title, startedAt }) => {
      if (typeof VoiceYoutube === 'undefined' || !videoId) return;
      const startSeconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
      VoiceYoutube.play(videoId, title, Math.max(0, startSeconds));
    };

    socket.on('voice:play-song', ({ videoId, title, startedAt }) => {
      startCurrentSong({ videoId, title, startedAt });
    });

    socket.on('voice:stop-song', () => {
      if (typeof VoiceYoutube === 'undefined') return;
      VoiceYoutube.stop();
    });

    socket.on('voice:current-song', (song) => {
      startCurrentSong(song);
    });

    if (typeof VoiceYoutube !== 'undefined') {
      VoiceYoutube.setOnStateChange((status, info) => updateNowPlayingBar(status, info));
    }

    startGazeBroadcast();

    socket.on('voice:signal', async ({ from, data }) => {
      const entry = peers[from];
      if (!entry) return;
      const pc = entry.pc;
      try {
        if (data.description) {
          const isOffer = data.description.type === 'offer';
          const collision = isOffer && (entry.makingOffer || pc.signalingState !== 'stable');
          entry.ignoreOffer = !entry.polite && collision;
          if (entry.ignoreOffer) return;

          await pc.setRemoteDescription(data.description);
          if (isOffer) {
            await pc.setLocalDescription();
            socket.emit('voice:signal', { to: from, data: { description: pc.localDescription } });
          }
        } else if (data.candidate) {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!entry.ignoreOffer) console.error('addIceCandidate failed', err);
          }
        }
      } catch (err) {
        console.error('voice:signal handling error', err);
      }
    });

    socket.on('disconnect', () => {
      connectedChannelId = null;
      connectedGroupId = null;
      Object.keys(peers).forEach(teardownPeer);
      stopSpeakingDetection('self');
      disposeAvatar3D('self');
      if (typeof VoiceDraw !== 'undefined') VoiceDraw.setActiveChannel(null);
    });
  }

  function refreshPanelForGroup(groupId) {
    openGroupId = groupId;
    const panel = $('#voice-panel');
    if (!panel) return;

    const visible = connectedChannelId && connectedGroupId === groupId;
    panel.classList.toggle('hidden', !visible);
    if (visible) {
      $('#voice-controls').classList.remove('hidden');
      updateMuteButton();
      updateShareButton();
      renderParticipants();
    }
  }

  function isConnectedTo(channelId) {
    return connectedChannelId === channelId;
  }

  function isConnectedToGroup(groupId) {
    return connectedChannelId && connectedGroupId === groupId;
  }

  // Group id for whatever voice channel we're currently connected to (or
  // null if none) - used by voice-command-settings.js to know which
  // group's shared trigger list to edit.
  function getConnectedGroupId() {
    return connectedChannelId ? connectedGroupId : null;
  }

  async function joinChannel(channelId, channelName, groupId) {
    if (connectedChannelId === channelId) return;
    if (connectedChannelId) await leaveCurrent();

    try {
      localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // No mic, permission denied, or no device at all — that's fine, the
      // user can still join and listen. They just won't transmit audio
      // until/unless a mic becomes available (e.g. re-granting permission
      // and rejoining).
      console.warn('Joining voice without a microphone:', err.message);
      localMicStream = null;
    }

    muted = !localMicStream;
    connectedChannelId = channelId;
    connectedChannelName = channelName;
    connectedGroupId = groupId;
    resetPanelHeight();
    socket.emit('voice:join', { channelId, muted });

    $('#edit-profile-panel').classList.add('hidden');

    if (localMicStream) {
      startSpeakingDetection('self', localMicStream);
      if (typeof VoiceSpeech !== 'undefined' && VoiceSpeech.supported()) {
        const group = (typeof AppState !== 'undefined' && AppState.groupsData) ? AppState.groupsData.find((g) => g.id === groupId) : null;
        VoiceSpeech.setTriggers(group && group.voiceCommandTriggers);
        VoiceSpeech.setLanguage(group && group.voiceCommandLanguage);
        VoiceSpeech.start(
          (phrase, soundUrl, avatarReaction, reactionSlot, reactionHoldMs) => triggerReaction(soundUrl, avatarReaction, reactionSlot, reactionHoldMs),
          (query) => playSongCommand(query),
          (action) => {
            if (action === 'mute') return muteSong();
            if (action === 'unmute') return unmuteSong();
            if (action === 'stop' || action === 'remove') return stopSong();
            if (action === 'pause') return pauseSong();
            if (action === 'resume') return resumeSong();
          }
        );
      }
    }
    if (typeof VoiceDraw !== 'undefined') VoiceDraw.setActiveChannel(channelId);

    if (typeof Groups !== 'undefined') Groups.refreshChannelHighlight();
    refreshPanelForGroup(openGroupId);
  }

  async function leaveCurrent() {
    if (!connectedChannelId) return;
    const cid = connectedChannelId;
    const gid = connectedGroupId;

    socket.emit('voice:leave', { channelId: cid });
    Object.keys(peers).forEach(teardownPeer);
    stopSpeakingDetection('self');
    if (voiceReactionTimer) { clearTimeout(voiceReactionTimer); voiceReactionTimer = null; }
    disposeAvatar3D('self');
    if (typeof VoiceDraw !== 'undefined') VoiceDraw.setActiveChannel(null);
    if (typeof VoiceSpeech !== 'undefined') VoiceSpeech.stop();
    if (typeof VoiceYoutube !== 'undefined') VoiceYoutube.stop();
    updateNowPlayingBar('stopped', {});

    if (localMicStream) {
      localMicStream.getTracks().forEach((t) => t.stop());
      localMicStream = null;
    }
    if (localScreenStream) {
      localScreenStream.getTracks().forEach((t) => t.stop());
      localScreenStream = null;
    }
    sharingScreen = false;
    muted = false;
    connectedChannelId = null;
    connectedChannelName = null;
    connectedGroupId = null;

    clearVideoGrid();

    if (typeof Groups !== 'undefined') Groups.refreshChannelHighlight();
    refreshPanelForGroup(openGroupId);
    void gid;
  }

  function playReactionSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (err) { /* audio not available - reaction still shows visually */ }
  }

  function playCustomFeedbackSound(path) {
    if (!path) return;
    try {
      const audioEl = new Audio(path);
      audioEl.volume = 0.55;
      audioEl.play().catch(() => {
        console.warn('[VoiceChat] custom feedback sound failed to play:', path);
      });
    } catch (err) {
      console.warn('[VoiceChat] failed to create Audio for feedback sound:', err);
    }
  }

  function playSuccessSound() {
    playCustomFeedbackSound(VOICE_COMMAND_SUCCESS_SOUND);
  }

  function playFailSound() {
    playCustomFeedbackSound(VOICE_COMMAND_FAIL_SOUND);
  }

  // Plays a member-uploaded sound clip for a triggered voice command. Falls
  // back to the little synth chime if playback fails for any reason (file
  // missing, browser blocked autoplay, unsupported format, etc.) so a bad
  // clip never leaves the reaction silent.
  function playCustomSound(url) {
    try {
      const audioEl = new Audio(url);
      audioEl.volume = 0.6;
      audioEl.play().catch(() => playReactionSound());
    } catch (err) {
      playReactionSound();
    }
  }

  // No icon/popup - a voice command's only feedback is audio. soundUrl, if
  // the trigger has one, plays instead of the default chime - every
  // participant in the channel plays it locally on their own end (there's
  // no shared audio bus for it), so it's not perfectly in sync but fires
  // for everyone.
  function showReaction(soundUrl) {
    if (soundUrl) playCustomSound(soundUrl); else playReactionSound();
  }

  // Called when our own voice command fires: play it locally right away
  // (no need to wait on a round trip to our own screen) and tell the server
  // to relay it to everyone else currently in the channel. If the matched
  // trigger has "React" turned on in the settings panel, also pulse the
  // hold/surprise expression on our own avatar - optionally using a
  // specific saved slot (reactionSlot, 0-based) and a custom hold duration
  // (reactionHoldMs) rather than the defaults.
  function triggerReaction(soundUrl, avatarReaction, reactionSlot, reactionHoldMs) {
    if (!connectedChannelId) return;
    showReaction(soundUrl);
    socket.emit('voice:reaction', { channelId: connectedChannelId, soundUrl });
    if (avatarReaction) pulseAvatarReaction(reactionSlot, reactionHoldMs);
  }

  // Simulates a brief mouse-hold on our own avatar for a voice command
  // tagged "React" - same mechanism as actually pressing and holding the
  // mouse (setMouseHoldSurprise + the voice:mouse-hold broadcast so other
  // participants' copy of our tile reacts too), just timed automatically
  // since a spoken word has no release moment of its own. Saying the word
  // again before it lets go extends the hold (using the newer of the two
  // durations) rather than re-triggering the broadcast, so it reads as one
  // continuous reaction, not a flicker.
  function pulseAvatarReaction(slotIndex, holdMs) {
    if (!connectedChannelId) return;
    const duration = Number.isFinite(holdMs)
      ? Math.min(VOICE_COMMAND_REACTION_HOLD_MS_MAX, Math.max(VOICE_COMMAND_REACTION_HOLD_MS_MIN, holdMs))
      : VOICE_COMMAND_REACTION_HOLD_MS;
    const selfInst = avatar3DInstances['self'];
    if (selfInst && selfInst.api.setMouseHoldSurprise) selfInst.api.setMouseHoldSurprise(true, slotIndex);
    if (voiceReactionTimer) {
      clearTimeout(voiceReactionTimer);
    } else {
      const payload = { channelId: connectedChannelId, held: true };
      if (Number.isInteger(slotIndex)) payload.slotIndex = slotIndex;
      socket.emit('voice:mouse-hold', payload);
    }
    voiceReactionTimer = setTimeout(() => {
      voiceReactionTimer = null;
      const inst = avatar3DInstances['self'];
      if (inst && inst.api.setMouseHoldSurprise) inst.api.setMouseHoldSurprise(false);
      if (connectedChannelId) socket.emit('voice:mouse-hold', { channelId: connectedChannelId, held: false });
    }, duration);
  }

  // Fired when our own "play <song>" voice command is heard. query is
  // whatever raw text speech recognition captured after "play" - looked up
  // as-is on YouTube server-side, no local cleanup needed.
  function playSongCommand(query) {
    if (!connectedChannelId || typeof VoiceYoutube === 'undefined') return;
    updateNowPlayingBar('loading', { title: query });
    Api.youtube.search(query)
      .then((result) => {
        if (!connectedChannelId) return; // left the call while the search was in flight
        playSuccessSound();
        socket.emit('voice:play-song', { channelId: connectedChannelId, videoId: result.videoId, title: result.title });
      })
      .catch((err) => {
        console.warn('[VoiceChat] YouTube search failed:', err.message);
        playFailSound();
        updateNowPlayingBar('error', {});
      });
  }

  let songMuted = false;

  function updateSongMuteButton() {
    const btn = $('#voice-now-playing-mute');
    if (!btn) return;
    btn.textContent = songMuted ? '🔇' : '🔊';
    btn.title = songMuted ? 'Unmute' : 'Mute';
  }

  function pauseSong() {
    if (typeof VoiceYoutube !== 'undefined') VoiceYoutube.pause();
  }

  function resumeSong() {
    if (typeof VoiceYoutube !== 'undefined') VoiceYoutube.resume();
  }

  function toggleSongMute() {
    if (typeof VoiceYoutube === 'undefined') return;
    if (songMuted) {
      VoiceYoutube.unmute();
      songMuted = false;
    } else {
      VoiceYoutube.mute();
      songMuted = true;
    }
    updateSongMuteButton();
  }

  function stopSong() {
    if (typeof VoiceYoutube !== 'undefined') VoiceYoutube.stop();
    songMuted = false;
    updateSongMuteButton();
    if (connectedChannelId) socket.emit('voice:stop-song', { channelId: connectedChannelId });
  }

  // Reflects the current song (or lack of one) in the small bar above the
  // voice controls. 'loading' shows the query while the YouTube search is
  // in flight, 'playing' swaps in the confirmed title once it starts,
  // 'stopped'/'error' hide the bar again.
  function updateNowPlayingBar(status, info) {
    const bar = $('#voice-now-playing');
    const label = $('#voice-now-playing-title');
    if (!bar || !label) return;
    if (status === 'loading') {
      label.textContent = `Looking up "${info.title}"…`;
      bar.classList.remove('hidden');
      updateSongMuteButton();
    } else if (status === 'playing') {
      label.textContent = info.title || 'Playing…';
      bar.classList.remove('hidden');
      updateSongMuteButton();
    } else if (status === 'paused') {
      label.textContent = info.title ? `${info.title} (paused)` : 'Paused';
      bar.classList.remove('hidden');
      updateSongMuteButton();
    } else {
      bar.classList.add('hidden');
    }
  }

  function toggleMute() {
    if (!localMicStream) return;
    muted = !muted;
    localMicStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (connectedChannelId) socket.emit('voice:mute-toggle', { channelId: connectedChannelId, muted });
    updateMuteButton();
    renderParticipants();
  }

  const SCREEN_SHARE_CONSTRAINTS = {
    video: {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 60, max: 60 }
    },
    audio: true
  };
  const SCREEN_SHARE_MAX_BITRATE = 6_000_000; // 6 Mbps — headroom to sustain 1080p without the encoder needing to shrink it

  // Screen shares are mostly static text/UI, not fast motion, so bias the
  // encoder toward resolution over frame rate and give it enough bitrate
  // headroom that WebRTC's default bandwidth estimate doesn't blur things out.
  //
  // scaleResolutionDownBy: 1 + degradationPreference: 'maintain-resolution'
  // together tell WebRTC it is NEVER allowed to shrink the encoded resolution
  // to cope with bandwidth — it must drop frame rate/quality instead. On a
  // poor connection this can mean stutter or lag rather than a smaller,
  // smoother picture; that's the explicit tradeoff of forcing a fixed
  // resolution instead of letting WebRTC adapt.
  async function applyScreenShareEncoding(sender) {
    if (!sender) return;
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = SCREEN_SHARE_MAX_BITRATE;
      params.encodings[0].scaleResolutionDownBy = 1;
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch (err) {
      console.error('Could not raise screen-share quality', err);
    }
  }

  async function toggleScreenShare() {
    if (!connectedChannelId) return;
    if (sharingScreen) {
      stopScreenShare();
      return;
    }

    try {
      localScreenStream = await navigator.mediaDevices.getDisplayMedia(SCREEN_SHARE_CONSTRAINTS);
    } catch (err) {
      return;
    }

    const track = localScreenStream.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => stopScreenShare();

    Object.values(peers).forEach(({ pc }) => applyScreenShareEncoding(pc.addTrack(track, localScreenStream)));

    sharingScreen = true;
    socket.emit('voice:screen-share-toggle', { channelId: connectedChannelId, sharing: true });
    showLocalVideoTile(localScreenStream);
    updateShareButton();
    renderParticipants();
  }

  function stopScreenShare() {
    if (!sharingScreen) return;

    Object.values(peers).forEach(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) pc.removeTrack(sender);
    });

    if (localScreenStream) localScreenStream.getTracks().forEach((t) => t.stop());
    localScreenStream = null;
    sharingScreen = false;

    if (connectedChannelId) socket.emit('voice:screen-share-toggle', { channelId: connectedChannelId, sharing: false });
    removeLocalVideoTile();
    updateShareButton();
    renderParticipants();
  }

  // ============ INTERNAL: PEER CONNECTIONS ============

  function connectToPeer(socketId, info, isInitiator) {
    if (peers[socketId]) return;

    const polite = socket.id > socketId;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry = { pc, polite, makingOffer: false, ignoreOffer: false, info: { ...info }, videoEl: null };
    peers[socketId] = entry;

    if (localMicStream) {
      localMicStream.getTracks().forEach((t) => pc.addTrack(t, localMicStream));
    }
    if (sharingScreen && localScreenStream) {
      localScreenStream.getTracks().forEach((t) => applyScreenShareEncoding(pc.addTrack(t, localScreenStream)));
    }

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('voice:signal', { to: socketId, data: { description: pc.localDescription } });
      } catch (err) {
        console.error('negotiation error', err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) socket.emit('voice:signal', { to: socketId, data: { candidate } });
    };

    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        let audioEl = document.getElementById(`voice-audio-${socketId}`);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = `voice-audio-${socketId}`;
          audioEl.autoplay = true;
          document.body.appendChild(audioEl);
        }
        const stream = event.streams[0] || new MediaStream([event.track]);
        audioEl.srcObject = stream;
        startSpeakingDetection(socketId, stream);
      } else if (event.track.kind === 'video') {
        showRemoteVideoTile(socketId, entry.info, event.streams[0] || new MediaStream([event.track]));
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) teardownPeer(socketId);
    };
  }

  function teardownPeer(socketId) {
    const entry = peers[socketId];
    if (!entry) return;
    try { entry.pc.close(); } catch (e) { /* noop */ }
    delete peers[socketId];

    const audioEl = document.getElementById(`voice-audio-${socketId}`);
    if (audioEl) audioEl.remove();

    stopSpeakingDetection(socketId);
    removeRemoteVideoTile(socketId);
    disposeAvatar3D(socketId);
  }

  // ============ INTERNAL: SPEAKING DETECTION ============

  function startSpeakingDetection(key, stream) {
    stopSpeakingDetection(key);
    if (!stream || stream.getAudioTracks().length === 0) return;

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let lastAboveThresholdAt = 0;
      let isSpeaking = false;

      const detector = { audioCtx, source, rafId: null };
      speakingDetectors[key] = detector;

      function tick() {
        if (!speakingDetectors[key]) return; // stopped
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const now = performance.now();
        if (rms > SPEAKING_THRESHOLD) lastAboveThresholdAt = now;

        const inst = avatar3DInstances[key];
        if (inst) inst.api.setVoiceLevel(rms);

        const nowSpeaking = now - lastAboveThresholdAt < SPEAKING_HOLD_MS;
        if (nowSpeaking !== isSpeaking) {
          isSpeaking = nowSpeaking;
          setSpeakingClass(key, isSpeaking);
        }
        detector.rafId = requestAnimationFrame(tick);
      }
      tick();
    } catch (err) {
      console.error('speaking detection failed to start', err);
    }
  }

  function stopSpeakingDetection(key) {
    const d = speakingDetectors[key];
    if (!d) return;
    if (d.rafId) cancelAnimationFrame(d.rafId);
    try { d.source.disconnect(); } catch (e) { /* noop */ }
    try { d.audioCtx.close(); } catch (e) { /* noop */ }
    delete speakingDetectors[key];
    setSpeakingClass(key, false);
  }

  function setSpeakingClass(key, isSpeaking) {
    const tile = document.querySelector(`[data-speaker="${CSS.escape(String(key))}"]`);
    if (!tile) return;
    const ring = tile.querySelector('.avatar-ring');
    if (ring) ring.classList.toggle('speaking', isSpeaking);
  }

  // ============ INTERNAL: 3D VOICE AVATARS ============
  // Each participant with avatarMode === '3d' gets a live MMD model instead
  // of a flat photo. renderParticipants() rebuilds the tile DOM constantly
  // (on every join/leave/mute/share change), so instances are cached here
  // by key and their canvas is just re-appended into the new tile rather
  // than reloaded from the network every time.

  function disposeAvatar3D(key) {
    const inst = avatar3DInstances[key];
    if (!inst) return;
    try { inst.api.dispose(); } catch (e) { /* noop */ }
    // Undo the window-wide hold-state broadcast listeners set up for the
    // local user's own tile in mountAvatar3D (see isSelf branch there) -
    // these are bound to window rather than the tile's own container, so
    // unlike a detached container they won't just quietly stop firing on
    // their own and need to be explicitly removed here.
    if (inst.holdListeners) {
      window.removeEventListener('pointerdown', inst.holdListeners.onDown);
      window.removeEventListener('pointerup', inst.holdListeners.onUp);
      window.removeEventListener('blur', inst.holdListeners.onUp);
    }
    delete avatar3DInstances[key];
  }

  // Samples the local user's own computed gaze direction and sends it to
  // everyone else in the voice channel, so their copy of this user's
  // avatar can turn to match (see mountAvatar3D's setRemoteGaze branch and
  // the voice:gaze listener above). Only sends when connected to a channel
  // and when the direction actually changed enough to matter, to keep this
  // cheap even at a fairly tight polling interval.
  function startGazeBroadcast() {
    if (gazeBroadcastInterval) return;
    gazeBroadcastInterval = setInterval(() => {
      if (!connectedChannelId) return;
      const selfInst = avatar3DInstances['self'];
      if (!selfInst || !selfInst.api.getGazeDirection) return;
      const { dx, dy } = selfInst.api.getGazeDirection();
      if (Math.abs(dx - lastSentGazeDX) < 0.03 && Math.abs(dy - lastSentGazeDY) < 0.03) return;
      lastSentGazeDX = dx;
      lastSentGazeDY = dy;
      socket.emit('voice:gaze', { channelId: connectedChannelId, dx, dy });
    }, 150);
  }

  function mountAvatar3D(ring, key, modelUrl, zoom, offsetX, offsetY, rotationY, mouthIntensity, voiceStart, voiceMax, blinkIntensity, blinkIntervalMin, blinkIntervalMax, blinkEnabled, blinkShapeKeys, lookAtCursor, surpriseShapeKeys, isSelf, mouthShapeKeys, surpriseEnabled) {
    let inst = avatar3DInstances[key];

    // Older cached participant data (or a peer who hasn't saved this
    // setting yet) can come through as undefined - default that to "on"
    // (avatar3d.js's own default) rather than letting toggleSurprise()
    // below treat undefined as "flip it" on every re-sync.
    const resolvedSurpriseEnabled = surpriseEnabled !== undefined ? !!surpriseEnabled : true;

    if (inst && inst.modelUrl !== modelUrl) {
      disposeAvatar3D(key);
      inst = null;
    }

    if (!inst) {
      const container = document.createElement('div');
      container.className = 'avatar avatar-3d-tile';
      if (!window.Avatar3D) {
        // three.js module hasn't finished loading yet (very unlikely by
        // the time someone is in a voice call) — fall back silently.
        container.textContent = '';
        ring.appendChild(container);
        return;
      }
      const api = window.Avatar3D.createAvatar(container, {
        modelUrl,
        zoom, offsetX, offsetY, rotationY,
        mouthIntensity, voiceStart, voiceMax,
        blinkIntensity, blinkIntervalMin, blinkIntervalMax, blinkEnabled, blinkShapeKeys,
        lookAtCursor,
        surpriseShapeKeys,
        surpriseEnabled: resolvedSurpriseEnabled,
        mouthShapeKeys,
        // Only the local user's own tile should watch the page's own
        // mouse down/up to drive its own surprise expression - other
        // participants' tiles must only react via setMouseHoldSurprise()
        // below, driven by their own voice:mouse-hold broadcast. Otherwise
        // holding the mouse anywhere made every avatar on screen react,
        // not just your own.
        localMouseHold: isSelf,
        onError: () => { container.classList.add('avatar-3d-error'); }
      });
      inst = avatar3DInstances[key] = { api, modelUrl, container };

      // Only the local user's own tile should broadcast its hold state.
      // avatar3d.js's own tile (localMouseHold: isSelf above) already
      // reacts to the window-wide mouse down/up for our own model's
      // surprise expression; separately, we piggyback the same
      // window-wide events here to relay the on/off state to everyone
      // else's client too, same idea as startGazeBroadcast() but
      // event-driven instead of polled since hold is a discrete on/off
      // rather than a continuous value.
      if (isSelf) {
        const onDown = () => {
          if (connectedChannelId) socket.emit('voice:mouse-hold', { channelId: connectedChannelId, held: true });
        };
        const onUp = () => {
          if (connectedChannelId) socket.emit('voice:mouse-hold', { channelId: connectedChannelId, held: false });
        };
        window.addEventListener('pointerdown', onDown);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('blur', onUp);
        inst.holdListeners = { onDown, onUp };
      }

      // createAvatar() just sized the renderer off container.clientWidth,
      // but the container is still detached at this point (it's only
      // appended to `ring` below, and `ring`'s own tile isn't inserted into
      // #voice-participants until renderParticipants() finishes) - so that
      // read was 0 and avatar3d.js fell back to a hardcoded 96px renderer,
      // which then gets stretched to fill the real (much bigger) circle via
      // CSS and looks pixelated. Once the current render pass has actually
      // landed in the document (rAF, after layout), re-measure and resize
      // for real - this is exactly what the wheel-resize handler already
      // does, just triggered automatically instead of waiting on a scroll.
      requestAnimationFrame(() => {
        if (avatar3DInstances[key] === inst) inst.api.resize();
      });
    } else {
      // Framing/lip-sync/blink/gaze can change (saved from Edit Profile)
      // without the model URL changing, e.g. after
      // VoiceChat.refreshSelfTile() - keep it in sync on an already-mounted
      // instance instead of only applying it at creation time.
      inst.api.setFraming({ zoom, offsetX, offsetY, rotationY });
      inst.api.setLipSyncSettings({ mouthIntensity, voiceStart, voiceMax });
      inst.api.setBlinkSettings({ blinkIntensity, blinkIntervalMin, blinkIntervalMax, blinkEnabled });
      inst.api.setBlinkShapeKeys(blinkShapeKeys);
      inst.api.setSurpriseShapeKeys(surpriseShapeKeys);
      inst.api.toggleSurprise(resolvedSurpriseEnabled);
      inst.api.setMouthShapeKeys(mouthShapeKeys);
      inst.api.setLookAtCursor(lookAtCursor);
    }

    ring.appendChild(inst.container);
  }

  // ============ INTERNAL: UI ============

  function renderParticipants() {
    const list = $('#voice-participants');
    if (!list) return;
    list.innerHTML = '';

    if (connectedChannelId) {
      list.appendChild(participantTile('self', me.displayName, me.avatarColor, muted, sharingScreen, true, me.avatarUrl, me.nameColor, me.avatarMode, me.avatarModelUrl, me.avatarModelZoom, me.avatarModelOffsetX, me.avatarModelOffsetY, me.avatarModelRotationY, me.avatarModelMouthIntensity, me.avatarModelVoiceStart, me.avatarModelVoiceMax, me.avatarModelBlinkIntensity, me.avatarModelBlinkIntervalMin, me.avatarModelBlinkIntervalMax, me.avatarModelBlinkEnabled, me.avatarModelBlinkShapeKeys, me.avatarModelLookEnabled, me.avatarModelSurpriseShapeKeys, me.avatarModelMouthShapeKeys, me.avatarModelSurpriseEnabled));
    }
    Object.entries(peers).forEach(([socketId, { info }]) => {
      list.appendChild(participantTile(socketId, info.displayName, info.avatarColor, !!info.muted, info.sharing, false, info.avatarUrl, info.nameColor, info.avatarMode, info.avatarModelUrl, info.avatarModelZoom, info.avatarModelOffsetX, info.avatarModelOffsetY, info.avatarModelRotationY, info.avatarModelMouthIntensity, info.avatarModelVoiceStart, info.avatarModelVoiceMax, info.avatarModelBlinkIntensity, info.avatarModelBlinkIntervalMin, info.avatarModelBlinkIntervalMax, info.avatarModelBlinkEnabled, info.avatarModelBlinkShapeKeys, info.avatarModelLookEnabled, info.avatarModelSurpriseShapeKeys, info.avatarModelMouthShapeKeys, info.avatarModelSurpriseEnabled));
    });

    if (list.children.length === 0) {
      list.innerHTML = '<div class="empty-list-hint">No one is in voice chat.</div>';
    }

    syncFreeformContainerHeight();
    enforcePanelMinHeight();
  }

  // Free-dragging voice tiles around #voice-participants. A tile starts in
  // the normal flex-wrap flow; grabbing and moving it past a small
  // threshold switches it to absolute positioning at wherever it's
  // dropped, saved in tilePositions so it stays put across re-renders
  // (mute/share/join/leave all call renderParticipants and rebuild the
  // DOM from scratch). A plain click/tap that never crosses the threshold
  // falls through untouched - there's nothing else to click on a tile
  // right now, but this keeps the door open for that.
  const TILE_DRAG_THRESHOLD = 4;
  let tileDrag = null;

  function beginTileDrag(e, key, tile) {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    const container = $('#voice-participants');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    tileDrag = {
      key,
      tile,
      container,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseLeft: tileRect.left - containerRect.left,
      baseTop: tileRect.top - containerRect.top,
      moved: false,
    };
    window.addEventListener('pointermove', onTileDragMove);
    window.addEventListener('pointerup', endTileDrag);
    window.addEventListener('pointercancel', endTileDrag);
  }

  // How tall #voice-participants can ever get, matching the same cap the
  // resize handle and computeMinHeight() use (window.innerHeight * 0.7)
  // minus whatever else the panel reserves (padding, the top bar, and the
  // share tile while streaming). Dragging a tile down is clamped to this
  // so it can never end up below where the panel's own resize handle
  // could ever scroll it into view.
  function getMaxParticipantsAreaHeight() {
    const panel = $('#voice-panel');
    if (!panel) return Infinity;
    const m = getPanelLayoutMetrics(panel);
    const maxPanelHeight = window.innerHeight * 0.7;
    const reserved = m.paddingTop + m.paddingBottom + m.topHeight + m.participantsMarginBottom
      + (m.isStreaming ? m.gridMarginBottom + STREAM_TILE_MIN : 0);
    return Math.max(0, maxPanelHeight - reserved);
  }

  // Keeps the panel height in sync with the dragged tile's position live,
  // in both directions: grows when it's pulled down past the current
  // bottom edge, and shrinks back when it's pulled back up - so the resize
  // separator tracks the drag like it's attached to the tile. Floored at
  // computeMinHeight (room for the controls bar plus a full tile row) and
  // capped at the same max the handle itself respects, and also accounts
  // for any other tiles that were already freely positioned elsewhere, so
  // shrinking to fit the one being dragged never hides another one.
  function syncPanelHeightToDrag(tileBottom) {
    const panel = $('#voice-panel');
    if (!panel || !tileDrag) return;
    const m = getPanelLayoutMetrics(panel);

    let maxBottom = tileBottom;
    Object.keys(tilePositions).forEach((key) => {
      if (key === tileDrag.key) return; // that one's covered by tileBottom, which tracks its live position
      const el = tileDrag.container.querySelector(`.voice-tile[data-speaker="${CSS.escape(key)}"]`);
      if (!el) return;
      maxBottom = Math.max(maxBottom, tilePositions[key].y + el.offsetHeight);
    });

    const needed = m.paddingTop + m.paddingBottom + m.topHeight + maxBottom + m.participantsMarginBottom
      + (m.isStreaming ? m.gridMarginBottom + STREAM_TILE_MIN : 0);

    const maxPanelHeight = window.innerHeight * 0.7;
    const minPanelHeight = computeMinHeight(panel);
    const target = Math.min(Math.max(Math.ceil(needed), minPanelHeight), maxPanelHeight);
    panel.style.setProperty('--voice-panel-height', `${target}px`);
    updateStreamTileHeight(panel);
  }

  function onTileDragMove(e) {
    if (!tileDrag) return;
    const dx = e.clientX - tileDrag.startClientX;
    const dy = e.clientY - tileDrag.startClientY;

    if (!tileDrag.moved) {
      if (Math.hypot(dx, dy) < TILE_DRAG_THRESHOLD) return;
      tileDrag.moved = true;
      tileDrag.tile.classList.add('voice-tile--dragging');
      tileDrag.tile.style.position = 'absolute';
      tileDrag.tile.style.margin = '0';
      try { tileDrag.tile.setPointerCapture(tileDrag.pointerId); } catch (err) { /* noop */ }
    }

    const containerRect = tileDrag.container.getBoundingClientRect();
    const maxLeft = Math.max(0, containerRect.width - tileDrag.tile.offsetWidth);
    const maxTop = Math.max(0, getMaxParticipantsAreaHeight() - tileDrag.tile.offsetHeight);
    const left = Math.min(maxLeft, Math.max(0, tileDrag.baseLeft + dx));
    const top = Math.min(maxTop, Math.max(0, tileDrag.baseTop + dy));
    tileDrag.tile.style.left = `${left}px`;
    tileDrag.tile.style.top = `${top}px`;
    syncPanelHeightToDrag(top + tileDrag.tile.offsetHeight);
  }

  function endTileDrag() {
    if (!tileDrag) return;
    const { key, tile, moved } = tileDrag;
    window.removeEventListener('pointermove', onTileDragMove);
    window.removeEventListener('pointerup', endTileDrag);
    window.removeEventListener('pointercancel', endTileDrag);
    if (moved) {
      tile.classList.remove('voice-tile--dragging');
      tilePositions[key] = { x: parseFloat(tile.style.left) || 0, y: parseFloat(tile.style.top) || 0 };
      syncFreeformContainerHeight();
    }
    tileDrag = null;
  }

  // Once at least one tile has been pulled out of the flow, the container
  // needs an explicit min-height covering the lowest dragged tile - an
  // absolutely-positioned child doesn't otherwise grow its parent, so
  // without this a tile dragged below the flex-flow content would get cut
  // off by the panel's scroll area instead of being reachable by scrolling
  // down to it.
  function syncFreeformContainerHeight() {
    const container = $('#voice-participants');
    if (!container) return;
    const keys = Object.keys(tilePositions);
    if (keys.length === 0) { container.style.minHeight = ''; return; }
    let maxBottom = 0;
    keys.forEach((key) => {
      const tile = container.querySelector(`.voice-tile[data-speaker="${CSS.escape(key)}"]`);
      if (!tile || !tilePositions[key]) return;
      maxBottom = Math.max(maxBottom, tilePositions[key].y + tile.offsetHeight);
    });
    if (maxBottom > 0) container.style.minHeight = `${Math.ceil(maxBottom) + 16}px`;
  }

  // Free-dragging screen-share ("live share") tiles anywhere across the
  // voice chat area. Unlike the avatar tiles above (which are confined to
  // #voice-participants), the drag container here is #voice-panel-scroll -
  // the shared scrollable ancestor of both #voice-participants and
  // #voice-video-grid - so a shared screen can be moved over the whole
  // panel, participants included. Position is remembered per key (the
  // socket id, or 'local' for your own share) and re-applied if the share
  // stops and starts again.
  let streamTileDrag = null;

  function beginStreamTileDrag(e, key, tile) {
    if (e.button !== undefined && e.button !== 0) return; // primary button/touch only
    if (e.target.closest && e.target.closest('.stream-expand-btn')) return; // let the fullscreen button work normally
    const container = $('#voice-panel-scroll');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    streamTileDrag = {
      key,
      tile,
      container,
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      baseLeft: tileRect.left - containerRect.left + container.scrollLeft,
      baseTop: tileRect.top - containerRect.top + container.scrollTop,
      moved: false,
    };
    window.addEventListener('pointermove', onStreamTileDragMove);
    window.addEventListener('pointerup', endStreamTileDrag);
    window.addEventListener('pointercancel', endStreamTileDrag);
  }

  function onStreamTileDragMove(e) {
    if (!streamTileDrag) return;
    const dx = e.clientX - streamTileDrag.startClientX;
    const dy = e.clientY - streamTileDrag.startClientY;

    if (!streamTileDrag.moved) {
      if (Math.hypot(dx, dy) < TILE_DRAG_THRESHOLD) return;
      streamTileDrag.moved = true;
      streamTileDrag.tile.classList.add('stream-tile--dragging');
      streamTileDrag.tile.style.position = 'absolute';
      streamTileDrag.tile.style.margin = '0';
      try { streamTileDrag.tile.setPointerCapture(streamTileDrag.pointerId); } catch (err) { /* noop */ }
    }

    const containerRect = streamTileDrag.container.getBoundingClientRect();
    const maxLeft = Math.max(0, containerRect.width - streamTileDrag.tile.offsetWidth);
    const left = Math.min(maxLeft, Math.max(0, streamTileDrag.baseLeft + dx));
    // No hard cap on top - the scroll container grows its scrollable area
    // to include absolutely-positioned descendants automatically, so
    // dragging a tile below the visible area just makes it reachable by
    // scrolling, same as the avatar tiles.
    const top = Math.max(0, streamTileDrag.baseTop + dy);
    streamTileDrag.tile.style.left = `${left}px`;
    streamTileDrag.tile.style.top = `${top}px`;
  }

  function endStreamTileDrag() {
    if (!streamTileDrag) return;
    const { key, tile, moved } = streamTileDrag;
    window.removeEventListener('pointermove', onStreamTileDragMove);
    window.removeEventListener('pointerup', endStreamTileDrag);
    window.removeEventListener('pointercancel', endStreamTileDrag);
    if (moved) {
      tile.classList.remove('stream-tile--dragging');
      streamTilePositions[key] = { x: parseFloat(tile.style.left) || 0, y: parseFloat(tile.style.top) || 0 };
    }
    streamTileDrag = null;
  }

  // Applies a remembered free position (if any) to a freshly-created
  // stream tile and wires up its drag handle, so both live-share tiles
  // behave consistently.
  function makeStreamTileDraggable(tile, key) {
    if (streamTilePositions[key]) {
      tile.style.position = 'absolute';
      tile.style.margin = '0';
      tile.style.left = `${streamTilePositions[key].x}px`;
      tile.style.top = `${streamTilePositions[key].y}px`;
    }
    tile.addEventListener('pointerdown', (e) => beginStreamTileDrag(e, key, tile));
  }

  function participantTile(key, name, color, isMuted, isSharing, isSelf, avatarUrl, nameColor, avatarMode, avatarModelUrl, avatarModelZoom, avatarModelOffsetX, avatarModelOffsetY, avatarModelRotationY, avatarModelMouthIntensity, avatarModelVoiceStart, avatarModelVoiceMax, avatarModelBlinkIntensity, avatarModelBlinkIntervalMin, avatarModelBlinkIntervalMax, avatarModelBlinkEnabled, avatarModelBlinkShapeKeys, avatarModelLookEnabled, avatarModelSurpriseShapeKeys, avatarModelMouthShapeKeys, avatarModelSurpriseEnabled) {
    const tile = document.createElement('div');
    tile.className = 'voice-tile';
    tile.dataset.speaker = key;
    if (tilePositions[key]) {
      tile.style.position = 'absolute';
      tile.style.margin = '0';
      tile.style.left = `${tilePositions[key].x}px`;
      tile.style.top = `${tilePositions[key].y}px`;
    }
    tile.addEventListener('pointerdown', (e) => beginTileDrag(e, key, tile));

    const ring = document.createElement('div');
    ring.className = 'avatar-ring';
    ring.style.setProperty('--ring-color', color || '#5865F2');
    ring.title = 'Scroll to resize';

    const size = tileSizes[key] || TILE_SIZE_DEFAULT;
    ring.style.width = `${size}px`;
    ring.style.height = `${size}px`;

    ring.addEventListener('wheel', (e) => {
      e.preventDefault();
      const current = tileSizes[key] || TILE_SIZE_DEFAULT;
      const delta = e.deltaY < 0 ? TILE_SIZE_STEP : -TILE_SIZE_STEP;
      const next = Math.min(TILE_SIZE_MAX, Math.max(TILE_SIZE_MIN, current + delta));
      if (next === current) return;
      tileSizes[key] = next;
      ring.style.width = `${next}px`;
      ring.style.height = `${next}px`;
      const inst = avatar3DInstances[key];
      if (inst) inst.api.resize();
      syncPanelToTileSize();
    }, { passive: false });

    if (avatarMode === '3d' && avatarModelUrl) {
      mountAvatar3D(ring, key, avatarModelUrl, avatarModelZoom, avatarModelOffsetX, avatarModelOffsetY, avatarModelRotationY, avatarModelMouthIntensity, avatarModelVoiceStart, avatarModelVoiceMax, avatarModelBlinkIntensity, avatarModelBlinkIntervalMin, avatarModelBlinkIntervalMax, avatarModelBlinkEnabled, avatarModelBlinkShapeKeys, isSelf && avatarModelLookEnabled, avatarModelSurpriseShapeKeys, isSelf, avatarModelMouthShapeKeys, avatarModelSurpriseEnabled);
    } else {
      disposeAvatar3D(key);
      const avatar = avatarEl({ displayName: name, avatarColor: color, avatarUrl: avatarUrl });
      ring.appendChild(avatar);
    }

    if (isMuted) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge muted-badge';
      badge.textContent = '🔇';
      ring.appendChild(badge);
    }
    if (isSharing) {
      const badge = document.createElement('div');
      badge.className = 'tile-badge share-badge';
      badge.textContent = '🖥️';
      ring.appendChild(badge);
    }

    const label = document.createElement('div');
    label.className = 'voice-tile-name';
    label.textContent = name + (isSelf ? ' (you)' : '');
    if (nameColor && /^#[0-9a-fA-F]{6}$/.test(nameColor)) {
      label.style.color = nameColor;
    }

    tile.appendChild(ring);
    tile.appendChild(label);
    return tile;
  }


  function showRemoteVideoTile(socketId, info, stream) {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    let tile = document.getElementById(`voice-tile-${socketId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'stream-tile';
      tile.id = `voice-tile-${socketId}`;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'stream-tile-label';
      label.textContent = `${info.displayName}'s screen`;
      tile.appendChild(label);
      tile.appendChild(buildExpandButton(tile));
      makeStreamTileDraggable(tile, socketId);
      grid.appendChild(tile);
    }
    const videoEl = tile.querySelector('video');
    videoEl.srcObject = stream;
    grid.classList.remove('hidden');
    ensureStreamVisible();
    updateStreamTileHeight();
  }

  function buildExpandButton(tile) {
    const btn = document.createElement('button');
    btn.className = 'stream-expand-btn';
    btn.type = 'button';
    btn.title = 'Fullscreen';
    btn.textContent = '⛶';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTileFullscreen(tile, btn);
    });

    // Keep the icon in sync if the user exits fullscreen via Esc, browser
    // controls, or by fullscreening a different tile.
    const syncIcon = () => {
      const active = document.fullscreenElement === tile || document.webkitFullscreenElement === tile;
      btn.textContent = active ? '✕' : '⛶';
      btn.title = active ? 'Exit fullscreen' : 'Fullscreen';
    };
    document.addEventListener('fullscreenchange', syncIcon);
    document.addEventListener('webkitfullscreenchange', syncIcon);

    return btn;
  }

  function toggleTileFullscreen(tile, btn) {
    const isActive = document.fullscreenElement === tile || document.webkitFullscreenElement === tile;
    if (isActive) {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      return;
    }
    if (tile.requestFullscreen) {
      tile.requestFullscreen().catch(() => { /* user gesture or platform restriction */ });
    } else if (tile.webkitRequestFullscreen) {
      tile.webkitRequestFullscreen();
    }
  }

  function removeRemoteVideoTile(socketId) {
    const tile = document.getElementById(`voice-tile-${socketId}`);
    if (tile) tile.remove();
    updateGridVisibility();
  }

  function showLocalVideoTile(stream) {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    let tile = document.getElementById('voice-tile-local');
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'stream-tile';
      tile.id = 'voice-tile-local';
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      tile.appendChild(video);
      const label = document.createElement('div');
      label.className = 'stream-tile-label';
      label.textContent = 'You are sharing your screen';
      tile.appendChild(label);
      tile.appendChild(buildExpandButton(tile));
      makeStreamTileDraggable(tile, 'local');
      grid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    grid.classList.remove('hidden');
    ensureStreamVisible();
    updateStreamTileHeight();
  }

  function removeLocalVideoTile() {
    const tile = document.getElementById('voice-tile-local');
    if (tile) tile.remove();
    updateGridVisibility();
  }

  function clearVideoGrid() {
    const grid = $('#voice-video-grid');
    if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
  }

  function updateGridVisibility() {
    const grid = $('#voice-video-grid');
    if (!grid) return;
    const empty = grid.children.length === 0;
    grid.classList.toggle('hidden', empty);
    // No streams left visible — undo any auto-grow/drag sizing that was only
    // there to accommodate the stream tile, back to the default panel size.
    if (empty) resetPanelHeight();
  }

  function updateMuteButton() {
    const btn = $('#voice-mute-btn');
    if (!btn) return;
    if (!localMicStream) {
      btn.textContent = '🔇';
      btn.title = 'No microphone — listening only';
      btn.disabled = true;
      btn.classList.remove('active-danger');
      return;
    }
    btn.disabled = false;
    btn.textContent = muted ? '🔇' : '🎙️';
    btn.title = muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('active-danger', muted);
  }

  function updateShareButton() {
    const btn = $('#voice-share-btn');
    if (!btn) return;
    btn.textContent = sharingScreen ? '🛑' : '🖥️';
    btn.title = sharingScreen ? 'Stop Sharing' : 'Share Screen';
    btn.classList.toggle('active-danger', sharingScreen);
  }

  // ============ RESIZE HANDLE ============
  // Lets the user drag the boundary between the voice panel and the chat
  // below it to make the participant/video area taller or shorter. Height is
  // stored as a CSS custom property on the panel. The size is intentionally
  // NOT remembered across sessions: every time a channel is (re)joined the
  // panel snaps back to the default height (see resetPanelHeight).

  const STREAM_TILE_MIN = 90;   // smallest a screen-share tile is allowed to shrink to
  const RESIZE_ABSOLUTE_MIN = 150; // fallback floor if layout can't be measured yet

  // Measures the real, currently-rendered pieces of the panel (controls bar,
  // an avatar tile, the share tile) so the min-height/stream-height math is
  // based on actual sizes rather than guessed constants that drift out of
  // sync with the CSS.
  function getPanelLayoutMetrics(panel) {
    const top = panel.querySelector('.voice-panel-top');
    const participants = panel.querySelector('#voice-participants');
    const grid = panel.querySelector('#voice-video-grid');

    const panelStyles = getComputedStyle(panel);
    const paddingTop = parseFloat(panelStyles.paddingTop) || 0;
    const paddingBottom = parseFloat(panelStyles.paddingBottom) || 0;

    const topHeight = top ? top.getBoundingClientRect().height : 0;

    const tiles = participants ? participants.querySelectorAll('.voice-tile') : [];
    let tileHeight = 0;
    tiles.forEach((t) => { tileHeight = Math.max(tileHeight, t.getBoundingClientRect().height); });
    const participantsMarginBottom = participants
      ? (parseFloat(getComputedStyle(participants).marginBottom) || 0)
      : 0;

    const isStreaming = !!(grid && !grid.classList.contains('hidden') && grid.children.length > 0);
    const gridMarginBottom = grid ? (parseFloat(getComputedStyle(grid).marginBottom) || 0) : 0;

    return { paddingTop, paddingBottom, topHeight, tileHeight, participantsMarginBottom, isStreaming, gridMarginBottom };
  }

  // Smallest the panel can be dragged to: enough room for the controls bar
  // plus one full row of avatar tiles, and — while someone is streaming —
  // enough extra room so the share tile stays visible too.
  function computeMinHeight(panel) {
    const m = getPanelLayoutMetrics(panel);
    if (!m.tileHeight) return RESIZE_ABSOLUTE_MIN;

    let min = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight + m.participantsMarginBottom;

    if (m.isStreaming) {
      min += m.gridMarginBottom + STREAM_TILE_MIN;
    }

    return Math.max(Math.ceil(min), RESIZE_ABSOLUTE_MIN);
  }

  // Called right when a wheel-resize changes an avatar's size: snaps the
  // panel height to exactly fit the tile, both growing (bigger avatar)
  // and shrinking (smaller avatar) - unlike enforcePanelMinHeight below,
  // which only ever grows. Resizing an avatar is a deliberate "make this
  // tile take up X space" action, so it's fine for it to also pull the
  // panel back in when the avatar shrinks, instead of leaving empty room.
  function syncPanelToTileSize(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;
    const min = computeMinHeight(panel);
    const maxHeight = window.innerHeight * 0.7;

    // computeMinHeight only measures a normal-flow row of tiles, so it has
    // no idea how far down a freely-dragged tile (tilePositions) currently
    // sits. Without this, resizing an avatar after dragging it down snaps
    // the panel back to "one row" height, clipping the dragged tile and
    // leaving the resize handle sitting in the middle of its avatar circle.
    // Fold in the lowest edge of any positioned tile too, same as
    // syncPanelHeightToDrag does mid-drag.
    let positionedNeeded = 0;
    const container = $('#voice-participants');
    const positionedKeys = Object.keys(tilePositions);
    if (container && positionedKeys.length) {
      const m = getPanelLayoutMetrics(panel);
      let maxBottom = 0;
      positionedKeys.forEach((key) => {
        const el = container.querySelector(`.voice-tile[data-speaker="${CSS.escape(key)}"]`);
        if (!el) return;
        maxBottom = Math.max(maxBottom, tilePositions[key].y + el.offsetHeight);
      });
      if (maxBottom > 0) {
        positionedNeeded = m.paddingTop + m.paddingBottom + m.topHeight + maxBottom + m.participantsMarginBottom
          + (m.isStreaming ? m.gridMarginBottom + STREAM_TILE_MIN : 0);
      }
    }

    const target = Math.min(Math.max(min, positionedNeeded), maxHeight);
    panel.style.setProperty('--voice-panel-height', `${target}px`);
    updateStreamTileHeight(panel);
  }

  // Called after every participants render: if the panel is currently
  // shorter than what's needed to show a full avatar tile, grow it to fit.
  // This only ever grows the panel, never shrinks it - dragging the handle
  // already refuses to go below computeMinHeight (see initResizeHandle),
  // so if we're under that min here it can only be because nobody has
  // touched the handle yet, never a deliberate smaller size the user
  // dragged to.
  function enforcePanelMinHeight(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;
    const min = computeMinHeight(panel);
    const current = panel.getBoundingClientRect().height;
    if (current < min) {
      panel.style.setProperty('--voice-panel-height', `${min}px`);
      updateStreamTileHeight(panel);
    }
  }

  // While streaming, grows/shrinks the share tile so it fills whatever extra
  // room dragging the panel bigger/smaller frees up (or takes away).
  function updateStreamTileHeight(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;
    const grid = $('#voice-video-grid');
    if (!grid || grid.classList.contains('hidden') || grid.children.length === 0) return;

    const m = getPanelLayoutMetrics(panel);
    const panelHeight = panel.getBoundingClientRect().height;
    const reserved = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight
      + m.participantsMarginBottom + m.gridMarginBottom;

    const maxAvailable = window.innerHeight * 0.6;
    let available = panelHeight - reserved;
    available = Math.min(Math.max(available, STREAM_TILE_MIN), maxAvailable);

    panel.style.setProperty('--stream-tile-height', `${Math.round(available)}px`);
  }

  const STREAM_TILE_DEFAULT = 180; // comfortable height a stream tile opens at, no drag needed

  // Called the moment a share starts. If the panel is currently too small to
  // show the stream at a comfortable size, grow it automatically — the user
  // shouldn't have to drag the handle just to see what was just shared.
  // Never shrinks a panel the user already made bigger themselves.
  function ensureStreamVisible(panel) {
    panel = panel || $('#voice-panel');
    if (!panel) return;

    const m = getPanelLayoutMetrics(panel);
    if (!m.isStreaming) return;

    const needed = m.paddingTop + m.paddingBottom + m.topHeight + m.tileHeight
      + m.participantsMarginBottom + m.gridMarginBottom + STREAM_TILE_DEFAULT;

    const maxHeight = window.innerHeight * 0.7;
    const target = Math.min(Math.ceil(needed), maxHeight);
    const currentHeight = panel.getBoundingClientRect().height;

    if (currentHeight < target) {
      panel.style.setProperty('--voice-panel-height', `${target}px`);
    }
  }

  // Snaps the panel back to its default (CSS-defined) height. Called every
  // time a voice channel is joined so a previous drag never carries over.
  function resetPanelHeight() {
    const panel = $('#voice-panel');
    if (!panel) return;
    panel.style.removeProperty('--voice-panel-height');
    updateStreamTileHeight(panel);
  }

  function initResizeHandle() {
    const handle = $('#voice-resize-handle');
    const panel = $('#voice-panel');
    if (!handle || !panel) return;

    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      startY = e.clientY;
      startHeight = panel.getBoundingClientRect().height;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxHeight = window.innerHeight * 0.7;
      const minHeight = computeMinHeight(panel);
      let newHeight = startHeight + (e.clientY - startY);
      newHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
      panel.style.setProperty('--voice-panel-height', `${newHeight}px`);
      updateStreamTileHeight(panel);
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
    });
  }

  function refreshSelfTile() {
    if (!connectedChannelId) return;
    renderParticipants();
    // Tell the server to re-read our profile and relay the fresh
    // avatar/surprise-slot fields to everyone else currently in the call -
    // see voice:profile-update on the server and voice:peer-profile-update
    // above. Without this, other participants (and a slot-targeted
    // mouse-hold voice command aimed at us) would keep using whatever was
    // cached from when we first joined, until we left and rejoined.
    socket.emit('voice:profile-update', { channelId: connectedChannelId });
  }

  return {
    init,
    joinChannel,
    leaveCurrent,
    toggleMute,
    toggleScreenShare,
    refreshPanelForGroup,
    isConnectedTo,
    isConnectedToGroup,
    getConnectedGroupId,
    initResizeHandle,
    refreshSelfTile,
    triggerReaction,
    pauseSong,
    resumeSong,
    toggleSongMute,
    stopSong
  };
})();