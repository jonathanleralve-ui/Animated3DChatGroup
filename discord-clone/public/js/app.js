// Bootstrap: rail navigation (Friends home vs a group) and the transition
// from the auth screen into the main app once a session is established.
const App = (() => {
  const { $, $$, initials } = Utils;

  function showFriendsHome() {
    setActiveRail($('#rail-home'));
    AppState.activeGroup = null;
    AppState.activeChat = null;
    $('#friends-panel').classList.remove('hidden');
    $('#group-panel').classList.add('hidden');
    $('#add-friend-panel').classList.add('hidden');
    $('#edit-profile-panel').classList.add('hidden');
    $('#empty-state').classList.add('hidden');
    $('#chat-panel').classList.add('hidden');
    $('#friends-lists-panel').classList.remove('hidden');
    VoiceChat.refreshPanelForGroup(null);
  }

  function setActiveRail(el) {
    $$('.rail-item').forEach((r) => r.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  function enterApp() {
    $('#auth-screen').classList.add('hidden');
    $('#app-screen').classList.remove('hidden');

    $('#me-name').textContent = AppState.me.displayName;
    $('#me-name').style.color = (AppState.me.nameColor && /^#[0-9a-fA-F]{6}$/.test(AppState.me.nameColor)) ? AppState.me.nameColor : '';
    const meAvatar = $('#me-avatar');
    meAvatar.style.background = AppState.me.avatarColor;
    if (AppState.me.avatarUrl) {
      meAvatar.innerHTML = '';
      const img = document.createElement('img');
      img.src = AppState.me.avatarUrl;
      img.alt = AppState.me.displayName;
      meAvatar.appendChild(img);
    } else {
      meAvatar.textContent = initials(AppState.me.displayName);
    }

    SocketClient.connect();
    VoiceChat.init(AppState.socket, AppState.me);
    VoiceDraw.init(AppState.socket);
    initVoiceControls();

    Friends.refresh();
    Groups.refresh();
    showFriendsHome();
  }

  function initVoiceControls() {
    $('#voice-leave-btn').addEventListener('click', () => VoiceChat.leaveCurrent());
    $('#voice-mute-btn').addEventListener('click', () => VoiceChat.toggleMute());
    $('#voice-share-btn').addEventListener('click', () => VoiceChat.toggleScreenShare());
    $('#voice-draw-btn').addEventListener('click', () => VoiceDraw.toggleToolbar());
    $('#voice-now-playing-stop').addEventListener('click', () => VoiceChat.stopSong());
    $('#voice-now-playing-pause').addEventListener('click', () => VoiceChat.togglePauseSong());
    $('#voice-now-playing-mute').addEventListener('click', () => VoiceChat.toggleSongMute());
  }

  function init() {
    $('#rail-home').addEventListener('click', showFriendsHome);
    Auth.initUI();
    Friends.initUI();
    Groups.initUI();
    Chat.initUI();
    Profile.initUI();
    VoiceChat.initResizeHandle();
    VoiceCommandSettings.initUI();
    Auth.tryResume();
  }

  return { init, enterApp, showFriendsHome, setActiveRail };
})();

App.init();