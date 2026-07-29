// Login/register form wiring. On success, hands off to App.enterApp().
const Auth = (() => {
  const { $ } = Utils;

  function doLogin() {
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    $('#login-error').textContent = '';
    Api.auth.login(username, password)
      .then((data) => onAuthSuccess(data))
      .catch((err) => { $('#login-error').textContent = err.message; });
  }

  function doRegister() {
    const displayName = $('#register-displayname').value.trim();
    const username = $('#register-username').value.trim();
    const password = $('#register-password').value;
    $('#register-error').textContent = '';
    Api.auth.register(username, password, displayName)
      .then((data) => onAuthSuccess(data))
      .catch((err) => { $('#register-error').textContent = err.message; });
  }

  function onAuthSuccess(data) {
    AppState.token = data.token;
    AppState.me = data.user;
    localStorage.setItem('chatter_token', AppState.token);
    App.enterApp();
  }

  function logout() {
    VoiceChat.leaveCurrent();
    localStorage.removeItem('chatter_token');
    AppState.token = null;
    AppState.me = null;
    if (AppState.socket) AppState.socket.disconnect();
    location.reload();
  }

  // Attempt to resume a session from a saved token on page load
  function tryResume() {
    if (!AppState.token) return;
    Api.auth.me().then((data) => {
      AppState.me = data.user;
      App.enterApp();
    }).catch(() => {
      localStorage.removeItem('chatter_token');
      AppState.token = null;
    });
  }

  function initUI() {
    $('#show-register').addEventListener('click', (e) => {
      e.preventDefault();
      $('#login-form').classList.add('hidden');
      $('#register-form').classList.remove('hidden');
    });
    $('#show-login').addEventListener('click', (e) => {
      e.preventDefault();
      $('#register-form').classList.add('hidden');
      $('#login-form').classList.remove('hidden');
    });

    $('#login-submit').addEventListener('click', doLogin);
    $('#login-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    $('#register-submit').addEventListener('click', doRegister);
    $('#register-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doRegister(); });

    $('#site-titlebar-close').addEventListener('click', () => {
      $('#modal-overlay').classList.remove('hidden');
      $('#logout-confirm-modal').classList.remove('hidden');
    });

    $('#logout-confirm-cancel').addEventListener('click', () => {
      $('#logout-confirm-modal').classList.add('hidden');
      $('#modal-overlay').classList.add('hidden');
    });

    $('#logout-confirm-close').addEventListener('click', () => {
      $('#logout-confirm-modal').classList.add('hidden');
      $('#modal-overlay').classList.add('hidden');
    });

    $('#logout-confirm-confirm').addEventListener('click', () => {
      $('#logout-confirm-modal').classList.add('hidden');
      $('#modal-overlay').classList.add('hidden');
      logout();
    });

    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target === $('#modal-overlay') && !$('#logout-confirm-modal').classList.contains('hidden')) {
        $('#logout-confirm-modal').classList.add('hidden');
        $('#modal-overlay').classList.add('hidden');
      }
    });

    initLogoutModalDrag();
  }

  // Lets the logout confirm popup be dragged around the screen by its
  // pixel-art titlebar, like a little retro desktop window.
  function initLogoutModalDrag() {
    Utils.makeModalDraggable($('#logout-confirm-modal'));
  }

  return { initUI, tryResume };
})();