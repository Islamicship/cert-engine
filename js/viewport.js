/**
 * viewport.js - Canvas scaler for the A4 certificate (Canva / Figma model).
 *
 * @description
 * An A4 sheet is 210mm (~794px) wide, which overflows a 360-430px phone. Instead of
 * making the sheet fluid (which would break the millimetre-locked tiers), the whole
 * sheet is scaled with transform: scale(s). Every dimension keeps its exact ratio.
 *
 * DOM contract (see index.html):
 *   #viewport  > #stage > .page        and the toolbar buttons #fit-btn
 *
 * Algorithm (zero layout shift):
 *   1. base size   = .page offsetWidth/offsetHeight (layout px, unaffected by transforms)
 *   2. avail size  = viewport content width x (window.innerHeight - toolbar height - gutters)
 *   3. scale       = mode-dependent, never above 1 (no upscaling: crisp text, true mm on desktop)
 *   4. apply       : page.transform = scale(s); stage.width/height = base * s
 *                    -> layout box === visual box, so there are no ghost scrollbars.
 *
 * View modes (button #fit-btn cycles them, choice persisted in 'cert-view-mode'):
 *   'width'  fit to width, page scrolls vertically   (default; ideal on phones)
 *   'page'   fit whole sheet inside the screen       (full-screen fit toggle)
 *   'actual' 100%, pan horizontally if needed
 * Native pinch-zoom keeps working because the page is plain DOM and the layout
 * viewport width does not change when the user pinch-zooms.
 *
 * Exports:
 *   window.__certScale  current scale factor (number). script.js divides getBoundingClientRect
 *                       measurements by it so auto-fit stays correct while scaled.
 *   window.CertViewport { setMode, getMode, refresh, getScale }
 *   CSS variable --cert-scale on <html>.
 *
 * Print: scale is reset to 1 on beforeprint / print media and restored afterwards.
 * css/viewport.css additionally forces transform:none !important for @media print.
 */
(function () {
  'use strict';

  /** @type {string} localStorage key for the chosen view mode. */
  const MODE_KEY = 'cert-view-mode';

  /** @type {ReadonlyArray<string>} Cycle order. */
  const MODES = ['width', 'page', 'actual'];

  /** @type {Object<string,string>} Button captions. */
  const MODE_LABEL = { width: 'Fit width', page: 'Fit page', actual: '100%' };

  /** @type {number} Upper bound: never upscale beyond the real A4 size. */
  const MAX_SCALE = 1;

  /** @type {number} Lower bound: guards against divide-by-tiny on broken measurements. */
  const MIN_SCALE = 0.1;

  /** @type {number} Ignore scale changes smaller than this (avoids sub-pixel jitter loops). */
  const EPSILON = 0.0005;

  const root = document.documentElement;
  const viewport = document.getElementById('viewport');
  const stage = document.getElementById('stage');
  const page = stage ? stage.querySelector('.page') : null;
  const toolbar = document.querySelector('.toolbar');
  const fitBtn = document.getElementById('fit-btn');

  if (!viewport || !stage || !page) return;   // markup missing: leave the page as it was

  let mode = 'width';
  let scale = 1;
  let lastAvailW = -1;
  let printing = false;
  let rafId = 0;
  let forceNext = false;
  let zoomFactor = 1;
  const MAX_ZOOM = 4;

  /**
   * @description Reads the saved view mode.
   * @returns {'width'|'page'|'actual'}
   */
  function readMode() {
    try {
      const v = localStorage.getItem(MODE_KEY);
      return MODES.indexOf(v) >= 0 ? v : 'width';
    } catch (_) {
      return 'width';
    }
  }

  /**
   * @description Persists the view mode (silent on failure).
   * @param {string} m
   * @returns {void}
   */
  function writeMode(m) {
    try { localStorage.setItem(MODE_KEY, m); } catch (_) { /* storage unavailable */ }
  }

  /**
   * @description True while the browser is in print layout.
   * @returns {boolean}
   */
  function isPrintMedia() {
    return !!(window.matchMedia && window.matchMedia('print').matches);
  }

  /**
   * @description True while the user is typing in a field. Used to ignore pure
   * height changes caused by the on-screen keyboard, so the sheet does not
   * suddenly shrink/jump under the user's fingers.
   * @returns {boolean}
   */
  function isEditing() {
    const a = document.activeElement;
    return !!(a && a.matches && a.matches('[contenteditable="true"], input, textarea, select'));
  }

  /**
   * @description Measures everything the algorithm needs.
   * @returns {{availW:number, availH:number, baseW:number, baseH:number}|null}
   *          null when the layout is not measurable yet (hidden / zero size).
   */
  function measure() {
    const cs = getComputedStyle(viewport);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const toolbarH = toolbar ? toolbar.offsetHeight : 0;

    const availW = viewport.clientWidth - padX;
    // innerHeight (layout viewport) is deliberately used instead of visualViewport:
    // the latter shrinks when the iOS keyboard opens and would rescale the sheet mid-typing.
    const availH = window.innerHeight - toolbarH - padY;
    const baseW = page.offsetWidth;
    const baseH = page.offsetHeight;

    if (!(availW > 0) || !(baseW > 0) || !(baseH > 0)) return null;
    return { availW: availW, availH: availH, baseW: baseW, baseH: baseH };
  }

  /**
   * @description Computes the scale factor for a view mode.
   * @param {{availW:number, availH:number, baseW:number, baseH:number}} m measurements
   * @param {'width'|'page'|'actual'} viewMode
   * @returns {number} factor in [MIN_SCALE, MAX_SCALE], floored to 4 decimals so the
   *          scaled sheet can never exceed the available width by rounding.
   */
  function computeScale(m, viewMode) {
      if (viewMode === 'zoom') return Math.floor(Math.min(MAX_ZOOM, Math.max(MIN_SCALE, zoomFactor)) * 10000) / 10000;
    let s = 1;
    if (viewMode === 'width') s = m.availW / m.baseW;
    else if (viewMode === 'page') s = Math.min(m.availW / m.baseW, m.availH / m.baseH);
    s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
    return Math.floor(s * 10000) / 10000;
  }

  /**
   * @description Writes a scale into the DOM: transform on the page, exact scaled size
   * on the stage, and the shared exports. The stage size is what removes ghost scrollbars.
   * @param {number} s scale factor
   * @param {number} baseW unscaled page width in px
   * @param {number} baseH unscaled page height in px
   * @returns {void}
   */
  function applyScale(s, baseW, baseH) {
    scale = s;
    window.__certScale = s;
    root.style.setProperty('--cert-scale', String(s));

    stage.style.width = (baseW * s) + 'px';
    stage.style.height = (baseH * s) + 'px';
    // At exactly 1 no transform at all: avoids needless rasterisation and keeps text crisp.
    page.style.transform = s === 1 ? 'none' : 'scale(' + s + ')';
  }

  /**
   * @description Removes every scaling side effect (used for print).
   * Keeps window.__certScale === the transform that is REALLY applied (1 here),
   * which is what script.js relies on when it measures text.
   * @returns {void}
   */
  function clearScale() {
    scale = 1;
    window.__certScale = 1;
    root.style.setProperty('--cert-scale', '1');
    stage.style.width = '';
    stage.style.height = '';
    page.style.transform = 'none';
  }

  /**
   * @description Recomputes and applies the scale. Skips work while printing, and skips
   * pure height changes while a field is focused (on-screen keyboard).
   * @returns {void}
   */
  function update() {
    if (printing || isPrintMedia()) return;

    const m = measure();
    if (!m) return;

    const forced = forceNext;
    forceNext = false;
    if (!forced && isEditing() && Math.abs(m.availW - lastAvailW) < 1) return;
    lastAvailW = m.availW;

    const next = computeScale(m, mode);
    if (!forced && Math.abs(next - scale) < EPSILON && root.classList.contains('vp-ready')) return;

    applyScale(next, m.baseW, m.baseH);
    viewport.setAttribute('data-mode', mode);
    // Same frame as the sizing above: from now on the page is absolutely positioned
    // inside a correctly sized stage (no flash, no layout jump).
    root.classList.add('vp-ready');
  }

  /**
   * @description Coalesces bursts of resize events into one update per animation frame.
   * @param {boolean} [force=false] bypass the keyboard / epsilon guards
   * @returns {void}
   */
  function schedule(force) {
    if (force) forceNext = true;
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      update();
    });
  }

  /**
   * @description Updates the toolbar button caption and accessible name.
   * @returns {void}
   */
  function renderButton() {
  if (!fitBtn) return;
  const label = mode === 'zoom' ? Math.round(scale * 100) + '%' : MODE_LABEL[mode];
  fitBtn.textContent = label;
  fitBtn.setAttribute('aria-label', 'View: ' + label + '. Click to change.');
  fitBtn.setAttribute('title', 'View: ' + label);
}

  /**
   * @description Sets, persists and applies a view mode.
   * @param {'width'|'page'|'actual'} m
   * @returns {void}
   */

  function setZoom(f) {
  if (!(f > 0)) return;
  zoomFactor = f;
  mode = 'zoom';
  forceNext = true;
  update();
  renderButton();
}

  /**
   * Absolute-scale zoom keeping the UNSCALED page point (px,py) under screen point (cx,cy).
   * One write + one forced layout read per call: callers must rAF-throttle.
   */
  function zoomAt(s, px, py, cx, cy) {
    if (printing) return;
    setZoom(s);
    const r = stage.getBoundingClientRect();
    viewport.scrollLeft += (r.left + px * scale) - cx;
    window.scrollBy(0, (r.top + py * scale) - cy);
  }

  function initGestures() {
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    const anchor = (cx, cy) => {
      const r = stage.getBoundingClientRect(), s = scale || 1;
      return { px: (cx - r.left) / s, py: (cy - r.top) / s };
    };
    let g = null, pend = null, raf = 0;

    // ---- 2-finger pinch (Android + iOS) ----
    viewport.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 2) return;
      const d0 = dist(e.touches);
      if (!(d0 > 0)) return;
      const m = mid(e.touches);
      g = Object.assign({ d0: d0, s0: scale || 1 }, anchor(m.x, m.y));
      page.style.willChange = 'transform';          // smooth during gesture; removed at end so text re-rasterises crisp
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    viewport.addEventListener('touchmove', (e) => {
      if (!g || e.touches.length !== 2) return;
      if (e.cancelable) e.preventDefault();
      const m = mid(e.touches);
      pend = { s: g.s0 * dist(e.touches) / g.d0, x: m.x, y: m.y };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (g && pend) zoomAt(pend.s, g.px, g.py, pend.x, pend.y);
        pend = null;
      });
    }, { passive: false });

    const end = (e) => {
      if (!g || e.touches.length >= 2) return;
      g = null; pend = null;
      page.style.willChange = '';
    };
    viewport.addEventListener('touchend', end);
    viewport.addEventListener('touchcancel', end);

    // ---- Ctrl + wheel / trackpad pinch: window-level, so zoom over the header can't zoom the browser either ----
    let wf = 1, wx = 0, wy = 0, wraf = 0;
    window.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1);
      dy = Math.max(-60, Math.min(60, dy));          // a real mouse notch (100) must not jump 2.7x
      wf *= Math.exp(-dy * 0.01);
      wx = e.clientX; wy = e.clientY;
      if (wraf) return;
      wraf = requestAnimationFrame(() => {
        wraf = 0;
        const f = wf; wf = 1;
        const a = anchor(wx, wy);
        zoomAt((scale || 1) * f, a.px, a.py, wx, wy);
      });
    }, { passive: false });

    // ---- iOS Safari ignores user-scalable=no: kill its page-zoom gestures ----
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((n) =>
      document.addEventListener(n, (e) => e.preventDefault(), { passive: false }));
  }

  function setMode(m) {
    if (MODES.indexOf(m) < 0) return;
    mode = m;
    writeMode(m);
    renderButton();
    schedule(true);
  }

  /**
   * @description Entry point: first synchronous layout, observers, print hooks.
   * @returns {void}
   */
  function init() {
    mode = readMode();
    renderButton();
    update();                       // synchronous: the very first paint is already scaled

    if (fitBtn) {
      fitBtn.addEventListener('click', function () {
        setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
      });
    }

    window.addEventListener('resize', function () { schedule(false); });
    window.addEventListener('orientationchange', function () { schedule(true); });
    window.addEventListener('pageshow', function () { schedule(true); });   // bfcache restore

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(function () { schedule(false); });
      ro.observe(viewport);
      if (toolbar) ro.observe(toolbar);     // toolbar may wrap to 2 rows -> changes 'page' mode height
    }

    // Web fonts change toolbar button widths (and therefore its wrapping/height).
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { schedule(true); });
    window.addEventListener('load', function () { schedule(true); });
      initGestures();

    // ---- Print: scale must be exactly 1 while the browser lays out the paper ----
    window.addEventListener('beforeprint', function () {
      printing = true;
      clearScale();
    });
    window.addEventListener('afterprint', function () {
      printing = false;
      schedule(true);
    });
    // Browsers that open print preview without firing beforeprint (older Safari):
    if (window.matchMedia) {
      const mq = window.matchMedia('print');
      const onPrintChange = function (e) {
        if (e.matches) { printing = true; clearScale(); }
        else { printing = false; schedule(true); }
      };
      if (mq.addEventListener) mq.addEventListener('change', onPrintChange);
      else if (mq.addListener) mq.addListener(onPrintChange);
    }
  }

  window.CertViewport = {
  getMode: function () { return mode; },
  setMode: setMode,
  setZoom: setZoom,           // <-- Add this line
  getScale: function () { return scale; },
  refresh: function () { schedule(true); }
};

  init();
})();
