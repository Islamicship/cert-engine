/**
 * pwa.js - Service worker registration, install prompt, update lifecycle.
 *
 * @description
 * 1. Registers ./sw.js (only on https or localhost: service workers do not exist elsewhere).
 * 2. Shows the toolbar "Install app" button ONLY after the browser fires
 *    `beforeinstallprompt` (i.e. when installation is genuinely possible), and hides
 *    it again after install or when already running as an installed app.
 * 3. Update flow: when a new worker is installed and waiting, a small toast offers
 *    "Reload". Nothing reloads by itself, so a user in the middle of editing a
 *    certificate is never interrupted. On click the waiting worker is told to
 *    SKIP_WAITING, and the page reloads exactly once after the controller changes.
 *
 * Reload safety: before reloading, the focused field is blurred (runs script.js
 * focusout rules) and the `pagehide` handler in script.js saves all fields.
 */
(function () {
  'use strict';

  /** @type {string} Worker script path, relative to the page. */
  const SW_URL = './sw.js';

  /** @type {number} How often to look for a new worker while the app stays open (ms). */
  const UPDATE_CHECK_MS = 60 * 60 * 1000;

  const installBtn = document.getElementById('install-btn');

  /** @type {Event|null} The deferred beforeinstallprompt event. */
  let deferredPrompt = null;
  /** @type {boolean} True once the user pressed "Reload" in the toast. */
  let userRequestedReload = false;
  /** @type {boolean} Guards against a double reload. */
  let reloading = false;
  /** @type {HTMLElement|null} */
  let toast = null;

  /**
   * @description Whether the app already runs as an installed PWA.
   * @returns {boolean}
   */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;   // iOS
  }

  /**
   * @description Shows / hides the toolbar install button.
   * @param {boolean} visible
   * @returns {void}
   */
  function showInstall(visible) {
    if (!installBtn) return;
    installBtn.hidden = !visible;
  }

  /**
   * @description Wires the install prompt. The button stays hidden until the browser
   * says installation is possible, so it never appears where it would do nothing.
   * @returns {void}
   */
  function initInstall() {
    if (isStandalone()) { showInstall(false); return; }

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();               // suppress the mini-infobar: we show our own subtle button
      deferredPrompt = e;
      showInstall(true);
    });

    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      showInstall(false);
    });

    if (installBtn) {
      installBtn.addEventListener('click', function () {
        if (!deferredPrompt) return;
        const promptEvent = deferredPrompt;
        deferredPrompt = null;          // a prompt event can be used once
        showInstall(false);
        promptEvent.prompt();
        if (promptEvent.userChoice && promptEvent.userChoice.catch) promptEvent.userChoice.catch(function () {});
      });
    }
  }

  /**
   * @description Builds the "new version available" toast once and returns it.
   * @param {ServiceWorker} worker the waiting worker to activate on confirmation
   * @returns {HTMLElement}
   */
  function buildToast(worker) {
    const el = document.createElement('div');
    el.className = 'pwa-toast no-print';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');

    const msg = document.createElement('span');
    msg.textContent = 'A new version is available.';

    const actions = document.createElement('span');
    actions.className = 'pwa-toast__actions';

    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = 'Reload';
    reload.addEventListener('click', function () {
      userRequestedReload = true;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      worker.postMessage({ type: 'SKIP_WAITING' });
    });

    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'ghost';
    later.textContent = 'Later';
    later.addEventListener('click', function () { el.classList.remove('is-visible'); });

    actions.append(reload, later);
    el.append(msg, actions);
    document.body.appendChild(el);
    return el;
  }

  /**
   * @description Shows the update toast for a waiting worker.
   * @param {ServiceWorker} worker
   * @returns {void}
   */
  function promptUpdate(worker) {
    if (!toast) toast = buildToast(worker);
    // Force a layout read so the CSS transition runs from the hidden state.
    void toast.offsetWidth;
    toast.classList.add('is-visible');
  }

  /**
   * @description Registers the worker and wires the update lifecycle.
   * @returns {void}
   */
  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (!window.isSecureContext) return;               // http:// (non-localhost) / file://

    navigator.serviceWorker.addEventListener('controllerchange', function () {
      // The very first install also changes the controller (clients.claim): ignore that,
      // reload only when the user asked for the update.
      if (!userRequestedReload || reloading) return;
      reloading = true;
      window.location.reload();
    });

    window.addEventListener('load', function () {
      navigator.serviceWorker.register(SW_URL, { scope: './' }).then(function (reg) {
        // A worker may already be waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);

        reg.addEventListener('updatefound', function () {
          const installing = reg.installing;
          if (!installing) return;
          installing.addEventListener('statechange', function () {
            // 'installed' + an existing controller = this is an UPDATE, not the first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              promptUpdate(installing);
            }
          });
        });

        const check = function () { reg.update().catch(function () { /* offline: try later */ }); };
        setInterval(check, UPDATE_CHECK_MS);
        document.addEventListener('visibilitychange', function () {
          if (document.visibilityState === 'visible') check();
        });
      }).catch(function (err) {
        console.warn('[pwa] service worker registration failed:', err);
      });
    });
  }

  initInstall();
  initServiceWorker();
})();
