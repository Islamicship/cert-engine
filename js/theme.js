/**
 * theme.js - Workspace theme manager (auto | light | dark).
 *
 * @description
 * Controls ONLY the workspace around the A4 certificate (backdrop, toolbar,
 * dropdowns, tooltip). The certificate itself is never themed: css/theme.css
 * resets color-scheme on .page and uses --ws-* tokens that .page never reads.
 *
 * State model
 *   mode     : 'auto' | 'light' | 'dark'   what the user picked (persisted)
 *   resolved : 'light' | 'dark'            what is applied right now
 *   'auto' follows the OS via prefers-color-scheme and re-resolves live.
 *
 * Attributes written on <html> (css/theme.css keys off these):
 *   data-theme-mode = mode
 *   data-theme      = resolved
 *
 * Why an inline bootstrap ALSO exists in index.html <head>:
 *   This file is loaded with `defer`, i.e. after first paint. Without the
 *   bootstrap a dark-mode user would see a white flash (FOUC). The bootstrap
 *   duplicates only the 6-line resolve logic; this module then takes over.
 *
 * Persistence: localStorage key 'cert-theme' (wrapped in try/catch: private
 * mode / blocked storage must never break the app).
 */
(function () {
  'use strict';

  /** @type {string} localStorage key (fixed by the spec). */
  const STORAGE_KEY = 'cert-theme';

  /** @type {ReadonlyArray<string>} Cycle order of the toggle button. */
  const MODES = ['auto', 'light', 'dark'];

  /**
   * Browser UI colour (<meta name="theme-color">) per resolved theme.
   * Kept equal to --ws-bg in css/theme.css and to the manifest theme_color.
   * @type {{light: string, dark: string}}
   */
  const META_COLOR = { light: '#eceff1', dark: '#12161a' };

  /** @type {string} Human labels for the button tooltip / aria-label. */
  const LABELS = {
    auto: 'Theme: Auto (follows system)',
    light: 'Theme: Light',
    dark: 'Theme: Dark'
  };

  const root = document.documentElement;
  const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  /**
   * @description Reads the saved mode; anything unknown falls back to 'auto'.
   * @returns {'auto'|'light'|'dark'}
   */
  function readMode() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return MODES.indexOf(v) >= 0 ? v : 'auto';
    } catch (_) {
      return 'auto';
    }
  }

  /**
   * @description Persists the mode. Failure is silent by design.
   * @param {'auto'|'light'|'dark'} mode
   * @returns {void}
   */
  function writeMode(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (_) { /* storage unavailable */ }
  }

  /**
   * @description Turns a mode into the theme that must actually be shown.
   * @param {'auto'|'light'|'dark'} mode
   * @returns {'light'|'dark'}
   */
  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return mql && mql.matches ? 'dark' : 'light';
  }

  /**
   * @description Applies a mode to the document: attributes, meta theme-color
   * and the toggle button's accessible name. Idempotent.
   * @param {'auto'|'light'|'dark'} mode
   * @returns {'light'|'dark'} the resolved theme that was applied
   */
  function apply(mode) {
    const resolved = resolve(mode);
    root.setAttribute('data-theme-mode', mode);
    root.setAttribute('data-theme', resolved);

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', META_COLOR[resolved]);

    const btn = document.getElementById('theme-btn');
    if (btn) {
      btn.setAttribute('aria-label', LABELS[mode] + '. Click to change.');
      btn.setAttribute('title', LABELS[mode]);
    }
    return resolved;
  }

  /**
   * @description Sets and persists a mode.
   * @param {'auto'|'light'|'dark'} mode
   * @returns {void}
   */
  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) return;
    writeMode(mode);
    apply(mode);
  }

  /**
   * @description Advances auto -> light -> dark -> auto.
   * @returns {'auto'|'light'|'dark'} the new mode
   */
  function cycle() {
    const current = root.getAttribute('data-theme-mode') || readMode();
    const next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
    setMode(next);
    return next;
  }

  /**
   * @description Wires the toolbar button, the OS-preference listener and the
   * cross-tab storage sync.
   * @returns {void}
   */
  function init() {
    apply(readMode());

    const btn = document.getElementById('theme-btn');
    if (btn) btn.addEventListener('click', cycle);

    // Live OS switch: only matters while the user is on 'auto'.
    if (mql) {
      const onChange = () => {
        if ((root.getAttribute('data-theme-mode') || 'auto') === 'auto') apply('auto');
      };
      if (mql.addEventListener) mql.addEventListener('change', onChange);
      else if (mql.addListener) mql.addListener(onChange);   // Safari < 14
    }

    // Another tab changed the theme: follow it.
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) apply(readMode());
    });
  }

  /** Public API (handy from the console or future UI). */
  window.CertTheme = {
    getMode: () => root.getAttribute('data-theme-mode') || readMode(),
    getResolved: () => root.getAttribute('data-theme') || resolve(readMode()),
    setMode: setMode,
    cycle: cycle
  };

  init();
})();
