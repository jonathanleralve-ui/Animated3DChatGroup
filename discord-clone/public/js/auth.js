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

    $('#logout-btn').addEventListener('click', () => {
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
    const modal = $('#logout-confirm-modal');
    const titlebar = modal.querySelector('.pixel-modal-titlebar');
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

    // Re-center the popup each time it's opened, so it doesn't reopen
    // wherever it was last dragged to.
    const observer = new MutationObserver(() => {
      if (!modal.classList.contains('hidden')) {
        modal.style.left = '';
        modal.style.top = '';
        modal.style.transform = 'translate(-50%, -50%)';
      }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  return { initUI, tryResume };
})();