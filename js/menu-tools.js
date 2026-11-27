/**
 * menu-tools.js - Desktop menu bar (Alt access keys), property bar, tool palette, undo/redo,
 * Find & Replace, clipboard commands, JSON backup, CSV batch, Help dialogs.
 *
 * @description
 * Pure add-on module. It never edits script.js internals: it talks to the app only through
 *   - the DOM (same PERSIST_SELECTOR as script.js, same DOCUMENT ORDER),
 *   - native events (input / focusout / blur / beforeprint) that script.js already listens to,
 *   - window.CertApp (script.js), window.CertViewport (viewport.js), #install-btn (pwa.js),
 *   - box._loadFile (exposed by script.js on .upload boxes) and the 'cert-db' IndexedDB.
 *
 * It injects NOTHING into .page / .grid. Extra DOM lives in: #menubar / #propbar (inside the
 * header), #floating-palette, #stage (one overlay div for the alignment grid) and <body>
 * (dialogs, Find panel, toasts).
 *
 * Load order (index.html): viewport.js -> script.js -> menu-tools.js (all `defer`).
 *
 * COUPLING CONTRACT (if script.js / index.html change, review these):
 *   PERSIST_SELECTOR must equal script.js; DEFAULTS must equal the HTML placeholder values;
 *   header ids: #menubar #propbar #pb-size-dd #pb-size-btn #pb-view-dd #pb-view-btn #pb-view-label
 *               #pb-view-pct #pb-print #pb-undo #pb-redo #lock-btn #install-btn.
 *   OPTIONAL (2 words in script.js): window.CertApp.fitAll / .save. Used when present.
 *
 * v2 CHANGES (workspace chrome only, certificate untouched):
 *   - trackHeaderHeight(): writes the REAL header height to --header-h-total on <html>; the palette
 *     docks below it (css/menu-tools.css). Palette drag is clamped below the header too.
 *   - Escape (no dialog / menu / find open) and a double-click on the canvas always return to the
 *     Select tool, so Hand / Zoom can never trap the user.
 *   - Urdu subtitles are no longer rendered in the menu bar (clean File / Edit / View / Data Tools / Help).
 */
(function () {
  'use strict';

  /* ======================================================================
   * 0. Constants + tiny helpers
   * ====================================================================== */
  const PERSIST_SELECTOR = '[data-unlockable], [data-filter], [data-sync], .combo-input'; // == script.js
  const FORM_KEY = 'cert-form';
  const DB_NAME = 'cert-db';
  const DB_STORE = 'images';
  const PALETTE_KEY = 'cert-palette-pos';
  const HISTORY_MAX = 30;
  const HISTORY_DELAY = 350;
  const ZOOM_STEP = 1.1;
  const ZOOM_TOOL_STEP = 1.2;
  const ZOOM_PRESETS = [0.5, 0.75, 1.25, 1.5, 2];
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;      // same cap as script.js uploads
  const BACKUP_APP = 'cert-engine';
  const APP_NAME = 'Certification Engine';

  // Record defaults == the placeholder text in index.html. Used by "New Record".
  const DEFAULTS = {
    nameAr: 'الاسم الكامل',
    nameEn: 'FULL NAME',
    id: '000000000',
    passport: 'A0000000',
    dob: '01/01/2000',
    seq: '000000',
    natEn: 'Pakistan',
    natAr: 'باكستان'
  };
  const PLACEHOLDER_NAME_EN = DEFAULTS.nameEn;
  const PLACEHOLDER_NAME_AR = DEFAULTS.nameAr;

  const $ = (id) => document.getElementById(id);
  const qa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const q1 = (sel) => document.querySelector(sel);
  const pad2 = (n) => String(n).padStart(2, '0');
  const V = () => window.CertViewport;
  const pb = {};                                // property-bar elements, filled in buildPropBar()

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Layout-independent key name: Arabic / Urdu keyboards report e.key in Arabic letters,
  // e.code stays "KeyF". Used for Alt access keys and Ctrl shortcuts.
  function keyOf(e) {
    const c = e.code || '';
    if (/^Key[A-Z]$/.test(c)) return c.slice(3).toLowerCase();
    if (/^Digit[0-9]$/.test(c)) return c.slice(5);
    if (/^Numpad[0-9]$/.test(c)) return c.slice(6);
    if (c === 'Equal' || c === 'NumpadAdd') return '+';
    if (c === 'Minus' || c === 'NumpadSubtract') return '-';
    return String(e.key || '').toLowerCase();
  }

  function localStamp() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function isTyping(t) {
    return !!(t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]'));
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /* ---------- toast ---------- */
  let toastEl = null;
  let toastTimer = 0;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = mk('div', 'mt-toast no-print');
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    void toastEl.offsetWidth;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), ms || 3200);
  }
  

  /* ---------- dialogs (native <dialog>: focus trap + Esc for free) ---------- */
  document.addEventListener('cert:toast', (e) => { if (e.detail) toast(String(e.detail)); });
  function confirmDialog(title, message, okLabel) {
    return new Promise((resolve) => {
      const dlg = mk('dialog', 'mt-modal no-print');
      dlg.setAttribute('aria-label', title);
      const cancel = mk('button', 'ghost', 'Cancel');
      const ok = mk('button', '', okLabel || 'OK');
      cancel.type = 'button';
      ok.type = 'button';
      const row = mk('div', 'mt-modal__actions');
      row.append(cancel, ok);
      dlg.append(mk('h2', 'mt-modal__title', title), mk('p', 'mt-modal__text', message), row);
      let result = false;
      cancel.addEventListener('click', () => dlg.close());
      ok.addEventListener('click', () => { result = true; dlg.close(); });
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      document.body.appendChild(dlg);
      dlg.showModal();
      cancel.focus();                         // destructive action: default focus = Cancel
    });
  }

  // Read-only information dialog. nodes: DOM nodes; opts: { wide, extra: [buttons] }
  function infoDialog(title, nodes, opts) {
    opts = opts || {};
    const dlg = mk('dialog', 'mt-modal no-print' + (opts.wide ? ' mt-modal--wide' : ''));
    dlg.setAttribute('aria-label', title);
    const close = mk('button', '', 'Close');
    close.type = 'button';
    const row = mk('div', 'mt-modal__actions');
    (opts.extra || []).forEach((b) => row.append(b));
    row.append(close);
    dlg.append(mk('h2', 'mt-modal__title', title));
    nodes.forEach((n) => dlg.append(n));
    dlg.append(row);
    close.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
    close.focus();
    return dlg;
  }

  function statusList(rows) {
    const dl = mk('dl', 'mt-status');
    rows.forEach((r) => { dl.append(mk('dt', '', r[0]), mk('dd', '', r[1])); });
    return dl;
  }

  /* ---------- file helpers ---------- */
  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = mk('input');
      inp.type = 'file';
      inp.accept = accept;
      inp.hidden = true;
      const done = (f) => { inp.remove(); resolve(f); };
      inp.addEventListener('change', () => done((inp.files && inp.files[0]) || null));
      inp.addEventListener('cancel', () => done(null));
      document.body.appendChild(inp);
      inp.click();
    });
  }

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type }));
    const a = mk('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- IndexedDB (peek / delete in script.js's image store) ---------- */
  function idbOpen(cb) {
    if (!window.indexedDB) { cb(null); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
    };
    req.onerror = () => cb(null);
    req.onsuccess = () => cb(req.result);
  }

  function idbGet(key) {
    return new Promise((resolve) => {
      idbOpen((db) => {
        if (!db) { resolve(null); return; }
        try {
          const tx = db.transaction(DB_STORE, 'readonly');
          const r = tx.objectStore(DB_STORE).get(key);
          tx.oncomplete = () => { db.close(); resolve(typeof r.result === 'string' ? r.result : null); };
          tx.onerror = tx.onabort = () => { db.close(); resolve(null); };
        } catch (_) { db.close(); resolve(null); }
      });
    });
  }

  function idbDel(key) {
    return new Promise((resolve) => {
      idbOpen((db) => {
        if (!db) { resolve(); return; }
        try {
          const tx = db.transaction(DB_STORE, 'readwrite');
          tx.objectStore(DB_STORE).delete(key);
          tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
        } catch (_) { db.close(); resolve(); }
      });
    });
  }

  /* ---------- menu icons (24x24 stroke paths; static literals only) ---------- */
  const ICON_PATHS = {
    'new': 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M12 12v6 M9 15h6',
    'open': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'save': 'M5 3h11l4 4v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M8 3v5h7V3 M8 21v-7h8v7',
    'pdf': 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h4',
    'image': 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9h.01',
    'send': 'M22 2L11 13 M22 2l-7 20-4-9-9-4z',
    'mail': 'M3 5h18v14H3z M3 7l9 6 9-6',
    'download': 'M12 3v12 M7 10l5 5 5-5 M4 21h16',
    'monitor': 'M3 4h18v12H3z M8 21h8 M12 16v5',
    'print': 'M6 9V3h12v6 M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2 M7 14h10v7H7z',
    'exit': 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9',
    'undo': 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11',
    'redo': 'M15 14l5-5-5-5 M20 9H9.5A5.5 5.5 0 0 0 4 14.5v0A5.5 5.5 0 0 0 9.5 20H13',
    'cut': 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M20 4L8.12 15.88 M14.47 14.48L20 20 M8.12 8.12L12 12',
    'copy': 'M9 9h11v11H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    'paste': 'M8 4H6a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-2 M9 2h6v4H9z',
    'selectall': 'M4 4h16v16H4z M8 8h8v8H8z',
    'find': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3',
    'clear': 'M3 6h18 M8 6V4h8v2 M6 6l1 14h10l1-14',
    'zoomin': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3 M8 11h6 M11 8v6',
    'zoomout': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3 M8 11h6',
    'refresh': 'M21 12a9 9 0 1 1-3-6.7 M21 4v5h-5',
    'batch': 'M4 6h16 M4 12h16 M4 18h10',
    'next': 'M9 6l6 6-6 6',
    'prev': 'M15 6l-6 6 6 6',
    'end': 'M6 6l12 12 M18 6L6 18',
    'keyboard': 'M3 6h18v12H3z M7 10h.01 M11 10h.01 M15 10h.01 M7 14h10',
    'book': 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z M4 21V5',
    'info': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 8h.01'
  };

  function iconEl(name) {
    const span = mk('span', 'mb-ico');
    const p = ICON_PATHS[name];
    if (p) span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + p + '"/></svg>';   // static literal, no user data
    return span;
  }

  /* ======================================================================
   * 1. Field I/O (mirrors script.js persistence, DOCUMENT ORDER)
   * ====================================================================== */
  const persistNodes = () => qa(PERSIST_SELECTOR);

  // Same walker as script.js: <div>/<br> from Enter become real "\n".
  function multilineText(root) {
    let out = '';
    (function walk(node) {
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) { out += n.nodeValue; return; }
        if (n.nodeName === 'BR') { out += '\n'; return; }
        if (n.nodeType !== 1) return;
        const block = n.nodeName === 'DIV' || n.nodeName === 'P';
        if (block && out && !out.endsWith('\n')) out += '\n';
        walk(n);
        if (block && out && !out.endsWith('\n')) out += '\n';
      });
    })(root);
    return out.replace(/\u00A0/g, ' ').replace(/\r/g, '').replace(/\n+$/, '');
  }

  function readValue(el) {
    if (el.tagName === 'INPUT') return el.value;
    if (el.hasAttribute('data-multiline')) return multilineText(el);
    return el.textContent;
  }

  function writeValue(el, val) {
    if (el.tagName === 'INPUT') el.value = val;
    else el.textContent = val;               // textContent only: imported text can never inject HTML
  }

  // Re-use script.js's own listeners: they normalise, mirror AR<->EN, refit, validate and save.
  function fire(el) {
    if (el.tagName === 'INPUT') {
      el.dispatchEvent(new Event('blur'));    // combo: trim + sync + save, WITHOUT opening the dropdown
      return;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  }

  function storeVersion() {
    try {
      const d = JSON.parse(localStorage.getItem(FORM_KEY));
      return d && typeof d.v === 'number' ? d.v : null;
    } catch (_) { return null; }
  }

  function fitAllSafe() {
    if (window.CertApp && typeof window.CertApp.fitAll === 'function') window.CertApp.fitAll();
  }

  /* ======================================================================
   * 2. Undo / Redo (snapshot stack, max 30 steps, fields only)
   * ====================================================================== */
  const hist = { stack: [], idx: -1 };
  let histTimer = 0;
  let restoring = false;                      // true while WE write to fields: our own listeners stay quiet

  const snap = () => persistNodes().map(readValue);
  const sameSnap = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const canUndo = () => hist.idx > 0;
  const canRedo = () => hist.idx >= 0 && hist.idx < hist.stack.length - 1;

  function record() {
    clearTimeout(histTimer);
    histTimer = 0;
    if (restoring) return;
    const s = snap();
    if (hist.idx >= 0 && sameSnap(hist.stack[hist.idx], s)) { syncProp(); return; }
    hist.stack.length = hist.idx + 1;         // typing after an undo drops the redo branch
    hist.stack.push(s);
    if (hist.stack.length > HISTORY_MAX + 1) hist.stack.shift();   // baseline + 30 steps
    hist.idx = hist.stack.length - 1;
    syncProp();
  }

  function scheduleRecord() {
    if (restoring) return;
    clearTimeout(histTimer);
    histTimer = setTimeout(record, HISTORY_DELAY);
    scheduleAudit();
  }

  function flush() { if (histTimer) record(); }

  function applySnapshot(vals) {
    const nodes = persistNodes();
    if (vals.length !== nodes.length) return false;
    const changed = [];
    nodes.forEach((el, i) => {
      if (readValue(el) !== vals[i]) { writeValue(el, vals[i]); changed.push(el); }
    });
    changed.forEach(fire);
    return true;
  }

  // Run a programmatic change as ONE undo step, without our own listeners recording noise.
  function guarded(fn) {
    flush();
    restoring = true;
    try { fn(); } finally { restoring = false; }
    record();
    scheduleAudit();
  }

  function restore(vals) {
    restoring = true;
    try { applySnapshot(vals); } finally { restoring = false; }
    scheduleAudit();
    syncProp();
  }

  function undo() {
    flush();
    if (!canUndo()) { toast('Nothing to undo'); return; }
    hist.idx--;
    restore(hist.stack[hist.idx]);
  }

  function redo() {
    flush();
    if (!canRedo()) { toast('Nothing to redo'); return; }
    hist.idx++;
    restore(hist.stack[hist.idx]);
  }

  /* ======================================================================
   * 3. Record fields (New / Clear / Batch all go through applyRecord)
   * ====================================================================== */
  function recordTargets() {
    return {
      nameAr: qa('.name-ar'),
      nameEn: qa('.name-en'),
      id: qa('[data-sync="id"]'),
      passport: qa('[data-sync="passport"]'),
      dob: qa('#dob-en'),
      seq: qa('[data-sync="cert-seq"]')
    };
  }

  function applyRecord(rec) {
    const t = recordTargets();
    Object.keys(t).forEach((k) => {
      if (rec[k] === undefined) return;
      t[k].forEach((el) => { writeValue(el, rec[k]); fire(el); });
    });
    const en = $('nat-en');
    const ar = $('nat-ar');
    if (rec.natEn !== undefined && en) { en.value = rec.natEn; en.dispatchEvent(new Event('blur')); }
    if (rec.natAr && ar) { ar.value = rec.natAr; ar.dispatchEvent(new Event('blur')); }
  }

  function captureRecord() {
    const g = (sel) => { const n = q1(sel); return n ? n.textContent : ''; };
    return {
      nameAr: g('.name-ar'), nameEn: g('.name-en'),
      id: g('[data-sync="id"]'), passport: g('[data-sync="passport"]'),
      dob: g('#dob-en'), seq: g('[data-sync="cert-seq"]'),
      natEn: $('nat-en') ? $('nat-en').value : '', natAr: $('nat-ar') ? $('nat-ar').value : ''
    };
  }

  /* ======================================================================
   * 4. File menu: New, Import, Save, Send To, Exit / Reset
   * ====================================================================== */
  async function newRecord() {
    const ok = await confirmDialog(
      'New Record',
      'Name, ID, passport, date of birth, nationality and certificate sequence go back to their defaults, ' +
      'and the photo is removed. Layout texts stay. Field changes can be undone with Ctrl+Z; the photo removal cannot.',
      'Reset record'
    );
    if (!ok) return;
    guarded(() => applyRecord(DEFAULTS));
    if (window.CertApp && typeof window.CertApp.clearPhoto === 'function') window.CertApp.clearPhoto();
    if (window.CertApp && typeof window.CertApp.pinToday === 'function') window.CertApp.pinToday();
    toast('Blank record ready');
  }

  async function exportBackup() {
    flush();
    const nodes = persistNodes();
    const payload = {
      app: BACKUP_APP,
      schema: 1,
      exportedAt: new Date().toISOString(),
      storeVersion: storeVersion(),
      count: nodes.length,
      fields: snap(),
      photo: await idbGet('photo-box'),
      logo: await idbGet('logo-box'),         // null while the default assets/logo.png is in use
      issued: window.CertApp && window.CertApp.getIssued ? window.CertApp.getIssued() : null
    };
    download('cert-backup-' + localStamp() + '.json', JSON.stringify(payload), 'application/json');
    toast('Backup downloaded');
  }

  async function applyImage(boxId, dataUrl) {
    const box = $(boxId);
    if (!box || typeof box._loadFile !== 'function' || typeof dataUrl !== 'string') return 'skipped';
    if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/i.test(dataUrl)) return 'invalid';
    if (box.classList.contains('is-locked')) return 'locked';
    const blob = await (await fetch(dataUrl)).blob();
    if (blob.size > MAX_IMAGE_BYTES) return 'too-big';
    box._loadFile(new File([blob], boxId + '.img', { type: blob.type }));
    return 'ok';
  }

  async function importFile() {
    const file = await pickFile('.json,.cert,application/json');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast('Import failed: file is too large'); return; }

    let data;
    try { data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); }
    catch (_) { toast('Import failed: not valid JSON'); return; }

    if (Array.isArray(data) || (data && Array.isArray(data.records))) {
      toast('That is a batch file: use Data Tools → Batch CSV Import');
      return;
    }
    if (!data || data.app !== BACKUP_APP || !Array.isArray(data.fields)) {
      toast('Import failed: not a Certification Engine backup');
      return;
    }
    const nodes = persistNodes();
    const sv = storeVersion();
    const versionClash = sv !== null && typeof data.storeVersion === 'number' && data.storeVersion !== sv;
    if (versionClash || data.fields.length !== nodes.length || !data.fields.every((v) => typeof v === 'string')) {
      toast('Import failed: backup was made with a different layout version');
      return;
    }

    guarded(() => applySnapshot(data.fields));
    if (typeof data.issued === 'string' && window.CertApp && typeof window.CertApp.setIssued === 'function') {
      window.CertApp.setIssued(data.issued);
    }

    const notes = [];
    for (const [key, id] of [['photo', 'photo-box'], ['logo', 'logo-box']]) {
      if (data[key] == null) continue;
      let r = 'skipped';
      try { r = await applyImage(id, data[key]); } catch (_) { r = 'invalid'; }
      if (r === 'locked') notes.push(key + ' skipped (box is locked)');
      else if (r === 'invalid' || r === 'too-big') notes.push(key + ' skipped (bad image)');
    }
    toast('Backup imported' + (notes.length ? ' — ' + notes.join(', ') : ''));
  }

  /* ---------- Save as PDF / JPG (js/export-tools.js renders; this only drives the UI) ---------- */
  let exporting = false;

  async function exportAs(kind) {
    const X = window.CertExport;
    if (!X) { toast('Export module is not loaded (js/export-tools.js)'); return; }
    if (exporting) { toast('An export is already running…'); return; }
    const miss = revealMissing();                       // HARD gate: required fields incomplete = export nahi
    if (miss.length) {
      toast('Cannot save ' + kind.toUpperCase() + ': ' + miss.length + ' required field' + (miss.length === 1 ? '' : 's') +
        ' missing (' + miss.map((r) => r.label).join(', ') + ')', 7000);
      return;
    }
    if (!(await printGuard('Save as ' + kind.toUpperCase()))) return;
    exporting = true;
    flush();
    toast('Rendering ' + kind.toUpperCase() + ' at 300 DPI…');
    try {
      const r = await (kind === 'pdf' ? X.savePdf() : X.saveJpg());
      toast(kind.toUpperCase() + ' saved: ' + r.name);
    } catch (err) {
      console.error('[export]', err);
      const why = err && err.message ? err.message : 'unknown error';
      // Safari / blocked canvas: PDF ke liye print dialog ka vector raasta offer karo
      if (kind === 'pdf' && await confirmDialog(
        'PDF export failed',
        why + '. Open the print dialog instead? Choose "Save as PDF" there (vector PDF, selectable text).',
        'Open print dialog'
      )) {
        window.print();
      } else {
        toast('Export failed: ' + why);
      }
    } finally {
      exporting = false;
      restoreEd();
    }
  }

    
  const SAMPLE_RIBBON = ['www.company.com', '@company', 'facebook.com/company'];
  let guarding = false;

  function defaultsFound() {
    flush();
    const g = (sel) => { const n = q1(sel); return n ? n.textContent.trim() : ''; };
    const found = [];

    const nameEn = g('.name-en');
    if (!nameEn || nameEn === DEFAULTS.nameEn) found.push('Name (EN)');
    const nameAr = g('.name-ar');
    if (!nameAr || nameAr === DEFAULTS.nameAr) found.push('Name (AR)');
    const id = g('[data-sync="id"]');
    if (!id || /^0+$/.test(id)) found.push('ID No.');
    const pp = g('[data-sync="passport"]');
    if (!pp || pp === DEFAULTS.passport) found.push('Passport number');
    const seq = g('[data-sync="cert-seq"]');
    if (!seq || /^0+$/.test(seq)) found.push('Certification sequence');
    if ($('photo-box') && $('photo-box').classList.contains('is-empty')) found.push('Photo');

    // Layout placeholders (ribbon + disclaimer)
    const ribbon = qa('.ribbon [data-unlockable]').map((n) => n.textContent.trim());
    if (ribbon.some((t) => SAMPLE_RIBBON.indexOf(t) >= 0)) found.push('Footer contact details');
    const note = qa('.note p').map((n) => n.textContent).join(' ');
    if (/Company Name/i.test(note) || note.indexOf('\u0627\u0633\u0645 \u0627\u0644\u0634\u0631\u0643\u0629') >= 0) {
      found.push('Disclaimer company name');
    }

        if (window.CertApp && typeof window.CertApp.issueIsStale === 'function' && window.CertApp.issueIsStale()) {
      found.push('Issue date is not today (' + g('[data-auto="issue-en"]') + '): press F5 to set today');
    }

    // DOB 01/01/2000 asli records mein bhi hota hai: sirf yaad dilao, alag se mention
    if (g('#dob-en') === DEFAULTS.dob) found.push('Date of Birth (01/01/2000: check if intended)');
    return found;
  }

  // true = aage barho, false = user ne cancel kiya
  async function printGuard(action) {
    if (guarding) return false;
    const found = defaultsFound();
    if (!found.length) return true;
    guarding = true;
    try {
      return await confirmDialog(
        action,
        'These fields still look like default / sample data: ' + found.join(', ') + '. Continue anyway?',
        'Continue anyway'
      );
    } finally {
      guarding = false;
    }
  }

  async function printWithGuard() {
    if (await printGuard('Print')) window.print();
  }

  /* ---------- Send To ---------- */
  function summaryLines() {
    const g = (sel) => { const n = q1(sel); return n ? n.textContent.trim() : ''; };
    const idv = g('[data-sync="id"]');
    return [
      'Certification No.: ' + g('[data-sync="cert-prefix"]') + g('[data-auto="cert-ym"]') + g('[data-sync="cert-seq"]'),
      'Name (EN): ' + g('.name-en'),
      'Name (AR): ' + g('.name-ar'),
      'ID No.: 2' + idv,
      'Passport No.: ' + g('[data-sync="passport"]'),
      'Date of Issue: ' + g('[data-auto="issue-en"]') + '  (Hijri ' + g('[data-auto="issue-ar"]') + ')',
      'Date of Expiry: ' + g('[data-auto="expiry-en"]') + '  (Hijri ' + g('[data-auto="expiry-ar"]') + ')'
    ];
  }

  function mailRecipient() {
    flush();
    const g = (sel) => { const n = q1(sel); return n ? n.textContent.trim() : ''; };
    const certNo = g('[data-sync="cert-prefix"]') + g('[data-auto="cert-ym"]') + g('[data-sync="cert-seq"]');
    const subject = 'Certification ' + certNo + ' — ' + g('.name-en');
    const url = 'mailto:?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(summaryLines().join('\r\n'));
    const a = mk('a');
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Opening your mail app… (mailto cannot attach the photo or PDF)');
  }

  const installBtn = () => $('install-btn');
  const installAvailable = () => { const b = installBtn(); return !!b && !b.hidden; };

  function installApp() {
    if (!installAvailable()) {
      toast('Install is not available: already installed, or this browser does not offer it');
      return;
    }
    installBtn().click();                     // pwa.js owns the deferred beforeinstallprompt event
  }

  /* ---------- Exit / Reset Form ---------- */
  async function factoryReset() {
    const ok = await confirmDialog(
      'Exit / Reset Form',
      'Wipes EVERYTHING this app saved in this browser: all field values, edited layout texts, the photo, ' +
      'the custom logo and the lock states. The page then reloads in its initial blank state. ' +
      'This cannot be undone. (A web page cannot close its own tab, so "exit" means reset + reload.)',
      'Wipe and reload'
    );
    if (!ok) return;
    const wipe = () => { try { localStorage.removeItem(FORM_KEY); localStorage.removeItem('cert-issued'); } catch (_) { /* ignore */ } };
    await Promise.all([idbDel('photo-box'), idbDel('logo-box')]);
    wipe();
    // script.js saves on pagehide / visibilitychange. Our listeners are registered AFTER its own,
    // so they run last and delete the key again: the reload really starts blank.
    window.addEventListener('pagehide', wipe);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') wipe(); });
    window.location.reload();
  }

  /* ======================================================================
   * 5. Edit menu: clipboard, select all, summary, find & replace
   * ====================================================================== */
  function clearFields() {
    guarded(() => applyRecord({ nameAr: '', nameEn: '', id: '', passport: '', dob: '' }));
    toast('Fields cleared (Ctrl+Z to undo)');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true, () => false);
    }
    const ta = mk('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { /* blocked */ }
    ta.remove();
    return Promise.resolve(ok);
  }

  async function copySummary() {
    toast((await copyText(summaryLines().join('\n'))) ? 'Summary copied' : 'Copy blocked by the browser');
  }

  /* ---------- last editable cell (focus + selection survive the trip through a menu) ---------- */
  let lastEd = null;                          // { el, range }

  function edFromSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 1 ? n : n.parentElement);
    const ed = el && el.closest ? el.closest('[contenteditable="true"]') : null;
    return ed ? { el: ed, range: sel.getRangeAt(0).cloneRange() } : null;
  }

  function restoreEd() {
    const r = lastEd;
    if (!r || !r.el.isConnected) return false;
    try { r.el.focus({ preventScroll: true }); } catch (_) { return false; }
    if (r.range) {
      try {
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r.range.cloneRange());
      } catch (_) { /* range invalidated by a focusout rule (trim / pad): caret stays where focus() put it */ }
    }
    return document.activeElement === r.el;
  }

  function trackEditable() {
    document.addEventListener('focusin', (e) => {
      const t = e.target;
      const ed = t && t.closest ? t.closest('[contenteditable="true"]') : null;
      if (ed) lastEd = { el: ed, range: null };
      else if (t && t.matches && t.matches('.combo-input')) lastEd = null;
    }, true);
    document.addEventListener('selectionchange', () => {
      const ed = edFromSelection();
      if (ed) lastEd = ed;
    });
    document.addEventListener('mousedown', (e) => {
      const keep = e.target.closest && e.target.closest('[contenteditable="true"], .app-header, .mt-find, dialog, .floating-palette, .mt-case-pop');
      if (!keep) lastEd = null;
    }, true);
  }

  function selectContents(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

    // Edit menu state (CorelDraw / Illustrator): Cut/Copy ko selection chahiye, Paste ko target cell.
  // Nationality <input> sirf tab jab woh focused ho (mouse se menu kholne par focus wahin rehta hai).
  function selState() {
    const a = document.activeElement;
    if (a && a.matches && a.matches('.combo-input')) {
      return { target: true, has: a.selectionStart !== a.selectionEnd };
    }
    const r = lastEd;
    if (r && r.el.isConnected) return { target: true, has: !!(r.range && !r.range.collapsed) };
    return { target: false, has: false };
  }

  function clipEl() {
    const a = document.activeElement;
    if (a && a.matches && a.matches('.combo-input')) return a;
    return restoreEd() ? lastEd.el : null;
  }

  async function clipCopy(cut) {
    const el = clipEl();
    if (!el) { toast('Click inside a text cell first'); return; }
    const isInput = el.tagName === 'INPUT';
    const sel = window.getSelection();
    const has = isInput ? el.selectionStart !== el.selectionEnd : !!sel && !sel.isCollapsed;
    if (!has) { toast('Select some text first'); return; }      // poora cell ab kabhi khud select nahi hota
    const text = isInput ? el.value.slice(el.selectionStart, el.selectionEnd) : String(sel);
    let ok = false;
    try { ok = document.execCommand(cut ? 'cut' : 'copy'); } catch (_) { ok = false; }
    if (!ok) {
      ok = await copyText(text);
      if (ok && cut) { try { document.execCommand('delete'); } catch (_) { /* ignore */ } }
    }
    toast(ok ? (cut ? 'Cut' : 'Copied') : 'Clipboard blocked by the browser');
  }

  async function clipPaste() {
    if (!clipEl()) { toast('Click inside a text cell first'); return; }
    let text = '';
    try { text = await navigator.clipboard.readText(); }
    catch (_) { toast('The browser blocked clipboard reading — press Ctrl+V in the cell instead'); return; }
    const el = clipEl();                                  // permission prompt ke dauran focus drift ho sakta hai
    if (!el || !text) return;
    text = text.replace(/\s*[\r\n]+\s*/g, el.hasAttribute('data-multiline') ? '\n' : ' ');
    if (el.hasAttribute('data-nospace')) text = text.replace(/\s+/g, '');
    if (!text) return;
    document.execCommand('insertText', false, text);      // script.js beforeinput filters + <input> maxlength dono lagte hain
  }
  /* ---------- Select All > All Form Fields ---------- */
  function selectAllFields() {
    const cells = qa('[contenteditable="true"], .combo-input');
    cells.forEach((c) => c.classList.add('mt-flash'));
    setTimeout(() => cells.forEach((c) => c.classList.remove('mt-flash')), 1400);
    const first = q1('.name-en');
    if (first) { first.focus(); selectContents(first); }
  }

  /* ---------- Find and Replace (modeless panel, runs through script.js field rules) ---------- */
  const find = { panel: null, needle: null, repl: null, mcase: null, status: null, pos: { ei: -1, off: -1 }, hitEl: null };

  function findTargets() {
    const seen = new Set();
    const out = [];
    qa('[contenteditable="true"], .combo-input').forEach((el) => {
      const key = el.getAttribute('data-sync');
      if (key) { if (seen.has(key)) return; seen.add(key); }   // AR/EN mirrors: one pass only, else a replace could run twice
      out.push(el);
    });
    return out;
  }

  const findText = (el) => readValue(el).replace(/\u00A0/g, ' ');

  function findHits(needle, mcase) {
    const re = new RegExp(escapeRe(needle), mcase ? 'g' : 'gi');
    const hits = [];
    findTargets().forEach((el, ei) => {
      for (const m of findText(el).matchAll(re)) hits.push({ el: el, ei: ei, start: m.index });
    });
    return hits;
  }

  function findStatus(msg) { if (find.status) find.status.textContent = msg; }

  function clearHit() {
    if (find.hitEl) find.hitEl.classList.remove('mt-find-hit');
    find.hitEl = null;
  }

  function resetFindPos() { find.pos = { ei: -1, off: -1 }; clearHit(); findStatus(''); }

  function findNext() {
    const needle = find.needle.value;
    if (!needle) { findStatus('Type the text to find.'); return; }
    const hits = findHits(needle, find.mcase.checked);
    clearHit();
    if (!hits.length) { find.pos = { ei: -1, off: -1 }; findStatus('No matches.'); return; }
    let idx = hits.findIndex((h) => h.ei > find.pos.ei || (h.ei === find.pos.ei && h.start > find.pos.off));
    const wrapped = idx < 0;
    if (wrapped) idx = 0;
    const h = hits[idx];
    find.pos = { ei: h.ei, off: h.start };
    find.hitEl = h.el;
    h.el.classList.add('mt-find-hit');
    try { h.el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
    findStatus('Match ' + (idx + 1) + ' of ' + hits.length + (wrapped && hits.length > 1 ? ' (wrapped)' : ''));
  }

  function replaceAll() {
    const needle = find.needle.value;
    if (!needle) { findStatus('Type the text to find.'); return; }
    const repl = find.repl.value;
    const re = new RegExp(escapeRe(needle), find.mcase.checked ? 'g' : 'gi');
    const jobs = [];
    findTargets().forEach((el) => {
      let n = 0;
      const after = findText(el).replace(re, () => { n++; return repl; });   // function replacer: "$&" in the text stays literal
      if (n) jobs.push({ el: el, after: after, n: n });
    });
    clearHit();
    resetFindPos();
    if (!jobs.length) { findStatus('No matches.'); return; }

    let total = 0;
    let adjusted = 0;
    guarded(() => {
      jobs.forEach((j) => {
        writeValue(j.el, j.after);
        fire(j.el);                                          // script.js: filter, uppercase, max length, mirror, refit, save
        total += j.n;
        if (readValue(j.el) !== j.after) adjusted++;
      });
    });
    fitAllSafe();
    findStatus('Replaced ' + total + ' occurrence' + (total === 1 ? '' : 's') + ' in ' + jobs.length + ' field' + (jobs.length === 1 ? '' : 's') +
      (adjusted ? ' — ' + adjusted + ' adjusted by field rules (case, allowed characters, length).' : '.'));
  }

  function closeFind() {
    if (!find.panel || find.panel.hidden) return;
    find.panel.hidden = true;
    clearHit();
    restoreEd();
  }

  function buildFind() {
    const panel = mk('div', 'mt-find no-print');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Find and Replace');
    panel.hidden = true;

    const head = mk('div', 'mt-find__head');
    const x = mk('button', 'mt-find__x', '✕');
    x.type = 'button';
    x.title = 'Close (Esc)';
    x.setAttribute('aria-label', 'Close');
    head.append(mk('span', 'mt-find__title', 'Find and Replace'), x);

    function field(label, id) {
      const row = mk('label', 'mt-find__row');
      row.append(mk('span', 'mt-find__lbl', label));
      const inp = mk('input');
      inp.type = 'text';
      inp.id = id;
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      row.append(inp);
      return { row: row, inp: inp };
    }
    const f1 = field('Find what', 'mt-find-what');
    const f2 = field('Replace with', 'mt-find-with');

    const check = mk('label', 'mt-find__check');
    const box = mk('input');
    box.type = 'checkbox';
    check.append(box, mk('span', '', 'Match case'));

    const status = mk('div', 'mt-find__status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const actions = mk('div', 'mt-find__actions');
    const next = mk('button', 'ghost', 'Find Next');
    const all = mk('button', '', 'Replace All');
    next.type = 'button';
    all.type = 'button';
    actions.append(next, all);

    panel.append(head, f1.row, f2.row, check, status, actions);
    document.body.appendChild(panel);

    Object.assign(find, { panel: panel, needle: f1.inp, repl: f2.inp, mcase: box, status: status });

    f1.inp.addEventListener('input', resetFindPos);
    box.addEventListener('change', resetFindPos);
    f1.inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(); } });
    f2.inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); replaceAll(); } });
    panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeFind(); } });
    x.addEventListener('click', closeFind);
    next.addEventListener('click', findNext);
    all.addEventListener('click', replaceAll);
  }

  function openFind() {
    if (!find.panel) buildFind();
    const s = String(window.getSelection() || '').trim();
    if (s && s.length <= 60 && !/[\r\n]/.test(s)) { find.needle.value = s; resetFindPos(); }
    const hdr = q1('.app-header');
    find.panel.style.top = ((hdr ? hdr.getBoundingClientRect().bottom : 60) + 10) + 'px';
    find.panel.hidden = false;
    find.needle.focus();
    find.needle.select();
  }

  /* ======================================================================
   * 6. View menu: zoom, grid, audit
   * ====================================================================== */
  // Zoom needs CertViewport.setZoom: all scaling stays in ONE engine,
  // so window.__certScale (used by script.js auto-fit) is always truthful.
  function zoomBy(factor, cx, cy) {
    const vp = V();
    const stage = $('stage');
    const viewport = $('viewport');
    if (!vp || typeof vp.setZoom !== 'function' || !stage || !viewport) {
      toast('Zoom needs the viewport.js patch');
      return;
    }
    const s0 = vp.getScale() || 1;
    const hasPoint = typeof cx === 'number' && typeof cy === 'number';
    const r0 = stage.getBoundingClientRect();
    const px = hasPoint ? (cx - r0.left) / s0 : 0;
    const py = hasPoint ? (cy - r0.top) / s0 : 0;

    vp.setZoom(s0 * factor);

    if (!hasPoint) return;
    const s1 = vp.getScale();
    const r1 = stage.getBoundingClientRect();
    viewport.scrollLeft += (r1.left + px * s1) - cx;    // keep the point under the cursor fixed
    window.scrollBy(0, (r1.top + py * s1) - cy);
  }

  const zoomIn = () => zoomBy(ZOOM_STEP, window.innerWidth / 2, window.innerHeight / 2);
  const zoomOut = () => zoomBy(1 / ZOOM_STEP, window.innerWidth / 2, window.innerHeight / 2);
  const setViewMode = (m) => { const vp = V(); if (vp) vp.setMode(m); };
  const viewModeIs = (m) => { const vp = V(); return !!vp && vp.getMode() === m; };
  const zoomIs = (f) => { const vp = V(); return !!vp && vp.getMode() === 'zoom' && Math.abs(vp.getScale() - f) < 0.01; };
  function setZoomTo(f) {
    const vp = V();
    if (!vp || typeof vp.setZoom !== 'function') { toast('Zoom needs the viewport.js patch'); return; }
    vp.setZoom(f);
  }

  /* ---------- alignment grid ---------- */
  let gridOn = false;
  function toggleGrid() {
    const stage = $('stage');
    if (!stage) return;
    let g = $('mt-grid');
    if (!g) {
      g = mk('div', 'mt-grid no-print');
      g.id = 'mt-grid';
      g.setAttribute('aria-hidden', 'true');
      g.hidden = true;
      stage.appendChild(g);                  // sibling of .page, NOT inside it: DOM order of fields untouched
    }
    gridOn = !gridOn;
    g.hidden = !gridOn;
  }

  /* ---------- pre-flight audit ---------- */
  let auditOn = false;
  let auditTimer = 0;
  let lastPhotoEmpty = null;

  const AUDIT_CHECKS = [
    { label: 'Photo',
      nodes: () => [$('photo-box')],
      ok: () => { const b = $('photo-box'); return !!b && !b.classList.contains('is-empty'); } },
    { label: 'ID No.',
      nodes: () => qa('.idno'),
      ok: () => { const s = q1('[data-sync="id"]'); const t = s ? s.textContent : ''; return /^\d{9}$/.test(t) && !/^0+$/.test(t); } },
    { label: 'Date of Birth',
      nodes: () => [$('dob-en')],
      ok: () => { const a = $('dob-ar'); return !!a && a.textContent.trim() !== ''; } },
    { label: 'Name (EN)',
      nodes: () => qa('.name-en'),
      ok: () => { const n = q1('.name-en'); const t = n ? n.textContent.trim() : ''; return !!t && t !== PLACEHOLDER_NAME_EN; } },
    { label: 'Name (AR)',
      nodes: () => qa('.name-ar'),
      ok: () => { const n = q1('.name-ar'); const t = n ? n.textContent.trim() : ''; return !!t && t !== PLACEHOLDER_NAME_AR; } }
  ];

  function runAudit() {
    auditTimer = 0;
    qa('.mt-audit-miss, .mt-audit-ok').forEach((n) => n.classList.remove('mt-audit-miss', 'mt-audit-ok'));
    const badge = $('fp-audit-badge');
    document.documentElement.classList.toggle('mt-audit-on', auditOn);
    if (!auditOn) { if (badge) badge.hidden = true; return; }

    const missing = [];
    AUDIT_CHECKS.forEach((c) => {
      const ok = !!c.ok();
      if (!ok) missing.push(c.label);
      c.nodes().forEach((n) => { if (n) n.classList.add(ok ? 'mt-audit-ok' : 'mt-audit-miss'); });
    });
    if (badge) {
      badge.hidden = false;
      badge.classList.toggle('is-ok', !missing.length);
      badge.textContent = missing.length ? String(missing.length) : '✓';
      badge.title = missing.length ? 'Missing: ' + missing.join(', ') : 'All mandatory fields present';
    }
    const pbtn = $('palette-audit');
    if (pbtn) pbtn.title = 'Pre-flight Audit (A)' + (missing.length ? ' — missing: ' + missing.join(', ') : '');
  }

  function scheduleAudit() {
    scheduleReady();                                      // required-fields chip bhi isi trigger se update hota hai
    if (!auditOn || auditTimer) return;
    auditTimer = setTimeout(runAudit, 80);
  }

  function toggleAudit() {
    auditOn = !auditOn;
    const btn = $('palette-audit');
    if (btn) btn.setAttribute('aria-pressed', String(auditOn));
    runAudit();
    toast(auditOn ? 'Pre-flight audit ON' : 'Pre-flight audit OFF');
  }

  function initAudit() {
    const box = $('photo-box');
    if (!box || typeof MutationObserver !== 'function') return;
    lastPhotoEmpty = box.classList.contains('is-empty');
    // Our own audit classes also mutate this node: react ONLY when the is-empty state really flips.
    new MutationObserver(() => {
      const now = box.classList.contains('is-empty');
      if (now !== lastPhotoEmpty) { lastPhotoEmpty = now; scheduleAudit(); }
    }).observe(box, { attributes: true, attributeFilter: ['class'] });
  }

    /* ======================================================================
   * 6b. Required fields: HARD gate for Save PDF / JPG (Print sirf confirm guard: native print rok nahi sakte)
   *     Field bharte hi red ring khud hat jati hai (refreshReady). Photo ya passport zaroori na ho
   *     to uski entry REQUIRED se hata do.
   * ====================================================================== */
  const cellText = (sel) => { const n = q1(sel); return n ? n.textContent.trim() : ''; };
  const ready = { chip: null, label: null };
  let readyTimer = 0;

  const REQUIRED = [
    { label: 'Photo',
      nodes: () => [$('photo-box')],
      target: () => $('photo-box'),
      ok: () => { const b = $('photo-box'); return !!b && !b.classList.contains('is-empty'); } },
    { label: 'Certification sequence',
      nodes: () => qa('[data-sync="cert-seq"]'),
      target: () => q1('[data-sync="cert-seq"]'),
      ok: () => { const t = cellText('[data-sync="cert-seq"]'); return /^\d{1,6}$/.test(t) && parseInt(t, 10) > 0; } },
    { label: 'Name (EN)',
      nodes: () => qa('.name-en'),
      target: () => q1('.name-en'),
      ok: () => { const t = cellText('.name-en'); return !!t && t !== DEFAULTS.nameEn; } },
    { label: 'Name (AR)',
      nodes: () => qa('.name-ar'),
      target: () => q1('.name-ar'),
      ok: () => { const t = cellText('.name-ar'); return !!t && t !== DEFAULTS.nameAr; } },
    { label: 'ID No. (9 digits)',
      nodes: () => qa('.idno'),
      target: () => q1('[data-sync="id"]'),
      ok: () => { const t = cellText('[data-sync="id"]'); return /^\d{9}$/.test(t) && !/^0+$/.test(t); } },
    { label: 'Passport number',
      nodes: () => qa('.passport'),
      target: () => q1('[data-sync="passport"]'),
      ok: () => { const t = cellText('[data-sync="passport"]'); return !!t && t !== DEFAULTS.passport; } },
    { label: 'Date of Birth',
      nodes: () => qa('#dob-en, #dob-ar'),
      target: () => $('dob-en'),
      ok: () => { const a = $('dob-ar'); return !!a && a.textContent.trim() !== ''; } }   // Hijri tabhi bharta hai jab DOB valid ho
  ];

  const missingRequired = () => REQUIRED.filter((r) => !r.ok());

  function whyBlocked() {
    const m = missingRequired();
    return m.length ? 'Disabled. Missing: ' + m.map((r) => r.label).join(', ') : '';
  }

  // Missing fields ko red ring do, pehle par scroll + focus. Missing list wapas karta hai.
  function revealMissing() {
    const miss = missingRequired();
    qa('.mt-missing').forEach((n) => n.classList.remove('mt-missing'));
    miss.forEach((r) => r.nodes().forEach((n) => { if (n) n.classList.add('mt-missing'); }));
    const el = miss.length ? miss[0].target() : null;
    if (el) {
      try { el.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) { /* ignore */ }
      try { el.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      if (el.isContentEditable) selectContents(el);
    }
    refreshReady();
    return miss;
  }

  function refreshReady() {
    readyTimer = 0;
    const miss = missingRequired();
    const still = new Set(miss);
    REQUIRED.forEach((r) => {
      if (!still.has(r)) r.nodes().forEach((n) => { if (n) n.classList.remove('mt-missing'); });
    });
    if (!ready.chip) return;
    const ok = !miss.length;
    ready.chip.classList.toggle('is-ok', ok);
    ready.label.textContent = ok ? 'Ready to export' : miss.length + ' required field' + (miss.length === 1 ? '' : 's') + ' missing';
    ready.chip.title = ok ? 'All required fields are complete' : 'Missing: ' + miss.map((r) => r.label).join(', ') + ' (click to show)';
  }

  function scheduleReady() {
    if (readyTimer) return;
    readyTimer = setTimeout(refreshReady, 80);
  }

  /* ======================================================================
   * 7. Data tools: recalc dates + batch (CSV / JSON)
   * ====================================================================== */
  function recalcDates() {
        const app = window.CertApp;
    if (app && typeof app.pinToday === 'function') {
      app.pinToday();                          // F5 = "aaj ki date pin karo" + Hijri / nationality sync
      scheduleAudit();
      toast('Issue date set to today');
      return;
    }
    if (app && typeof app.refreshDates === 'function') {
      app.refreshDates();
      scheduleAudit();
      toast('Dates recalculated');
      return;
    }
    // Fallback (script.js without CertApp): replay the beforeprint / afterprint pair.
    // viewport.js collapses the stage while "printing": remember the scroll position and put it back.
    const vpEl = $('viewport');
    const sx = vpEl ? vpEl.scrollLeft : 0;
    const sy = window.scrollY;
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('afterprint'));
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (vpEl) vpEl.scrollLeft = sx;
      window.scrollTo(window.scrollX, sy);
    }));
    toast('Dates recalculated');
  }

  const ALIASES = {
    nameEn:   ['nameen', 'name', 'fullname', 'englishname', 'nameenglish', 'nameinenglish'],
    nameAr:   ['namear', 'arabicname', 'namearabic', 'nameinarabic'],
    id:       ['id', 'idno', 'idnumber', 'iqama', 'iqamano', 'iqamanumber', 'nationalid'],
    passport: ['passport', 'passportno', 'passportnumber'],
    dob:      ['dob', 'dateofbirth', 'birthdate', 'birthday'],
    natEn:    ['nationality', 'nationalityen', 'natEn'.toLowerCase()],
    natAr:    ['nationalityar', 'natar'],
    seq:      ['seq', 'certseq', 'sequence', 'certsequence']
  };
  const KEY_TO_FIELD = {};
  Object.keys(ALIASES).forEach((f) => { KEY_TO_FIELD[f.toLowerCase()] = f; ALIASES[f].forEach((k) => { KEY_TO_FIELD[k] = f; }); });
  const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

  const isArabicText = (s) => (window.CertApp && window.CertApp.isArabicText ? window.CertApp.isArabicText(s) : true);
  function normDob(s) {
    s = String(s).trim();
    let d, m, y, x;
    if ((x = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(s))) { d = +x[1]; m = +x[2]; y = +x[3]; }
    else if ((x = /^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/.exec(s))) { y = +x[1]; m = +x[2]; d = +x[3]; }
    else return null;
    const dt = new Date(y, m - 1, d, 12);
    if (y < 1900 || dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d || dt > new Date()) return null;
    return pad2(d) + '/' + pad2(m) + '/' + y;
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t']
      .map((d) => [d, firstLine.split(d).length])
      .sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  // -> { records, warnings, ignoredCols }
  function parseBatch(text) {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    let objs;
    const ignored = new Set();

    if (/^[\[{]/.test(trimmed)) {
      const j = JSON.parse(trimmed);
      const arr = Array.isArray(j) ? j : j && j.records;
      if (!Array.isArray(arr)) throw new Error('JSON needs an array of records or {"records": [...]}');
      objs = arr.filter((o) => o && typeof o === 'object');
    } else {
      const rows = parseCsv(trimmed);
      if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
      const head = rows[0];
      objs = rows.slice(1).map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] != null ? r[i] : ''; }); return o; });
    }

    const warnings = [];
    const records = [];
    objs.forEach((raw, i) => {
      const rec = {};
      Object.keys(raw).forEach((k) => {
        const f = KEY_TO_FIELD[normKey(k)];
        if (!f) { ignored.add(k); return; }
        rec[f] = raw[k] == null ? '' : String(raw[k]).trim();
      });
      const n = i + 1;
      if (rec.id !== undefined) {
        let d = rec.id.replace(/\D/g, '');
        if (d.length === 10 && d[0] === '2') d = d.slice(1);
        if (d.length !== 9) warnings.push('Row ' + n + ': ID must be 9 digits (or 10 starting with 2) — got "' + rec.id + '"');
        rec.id = d;
      }
      if (rec.passport !== undefined) rec.passport = rec.passport.replace(/\s+/g, '').toUpperCase();
      if (rec.dob !== undefined && rec.dob !== '') {
        const nd = normDob(rec.dob);
        if (nd) rec.dob = nd; else warnings.push('Row ' + n + ': unreadable / future DOB "' + rec.dob + '" (use DD/MM/YYYY or YYYY-MM-DD)');
      }
      if (rec.nameEn !== undefined && rec.nameEn && !/^[A-Za-z \-]+$/.test(rec.nameEn)) {
        warnings.push('Row ' + n + ': English name has characters outside A-Z, space, hyphen — they will be dropped');
      }
      if (rec.nameAr !== undefined && rec.nameAr && !isArabicText(rec.nameAr)) {
        warnings.push('Row ' + n + ': Arabic name has non-Arabic characters — they will be dropped');
      }
      if (rec.seq !== undefined) rec.seq = rec.seq.replace(/\D/g, '').slice(0, 6);
      if (Object.keys(rec).some((k) => rec[k] !== '')) records.push(rec);
    });
    if (!records.length) throw new Error('No usable rows found (check the column names)');
    return { records: records, warnings: warnings, ignoredCols: Array.from(ignored) };
  }

  /* ---------- batch state + pager ---------- */
  const batch = { records: [], cache: {}, index: -1 };
  let pager = null;
  // A column missing from the file must BLANK the field, never keep the previous candidate's value
  // (a certificate with someone else's passport number is the worst failure mode of a batch tool).
  const BATCH_BASE = { nameAr: '', nameEn: '', id: '', passport: '', dob: '', natEn: DEFAULTS.natEn };
  const batchRecord = (i) => {
    if (batch.cache[i]) return batch.cache[i];
    const r = Object.assign({}, BATCH_BASE, batch.records[i]);
    if (!r.natEn) r.natEn = DEFAULTS.natEn;
    return r;
  };

  const batchActive = () => batch.records.length > 0;

  function renderPager() {
    if (!pager) return;
    pager.root.hidden = !batchActive();
    if (!batchActive()) return;
    pager.count.textContent = (batch.index + 1) + ' / ' + batch.records.length;
    const cur = batch.index >= 0 ? batchRecord(batch.index) : {};
    pager.rec.textContent = cur.nameEn || cur.nameAr || '';
    pager.prev.disabled = batch.index <= 0;
    pager.next.disabled = batch.index >= batch.records.length - 1;
  }

  function goTo(i) {
    if (!batchActive() || i < 0 || i >= batch.records.length) return;
    if (batch.index >= 0) batch.cache[batch.index] = captureRecord();   // keep manual edits of the record we leave
    batch.index = i;
    guarded(() => applyRecord(batchRecord(i)));
    renderPager();
  }

  const nextRecord = () => goTo(batch.index + 1);
  const prevRecord = () => goTo(batch.index - 1);

  function endBatch() {
    batch.records = []; batch.cache = {}; batch.index = -1;
    renderPager();
    toast('Batch ended');
  }

  function loadBatch(records) {
    const cur = parseInt((q1('[data-sync="cert-seq"]') || {}).textContent, 10);
    const start = cur > 0 ? cur : 1;                       // field wali seq se shuru; 000000 ho to 1 se
    const p6 = (n) => String(n).padStart(6, '0');
    if (start + records.length - 1 > 999999) {
      toast('Batch rejected: ' + records.length + ' records from ' + p6(start) + ' would pass 999999', 7000);
      return;
    }
    records.forEach((r, i) => { if (!r.seq) r.seq = p6(start + i); });   // file mein diya hua seq override karta hai
    batch.records = records;
    batch.cache = {};
    batch.index = -1;
    if (window.CertApp && typeof window.CertApp.pinToday === 'function') window.CertApp.pinToday();
    goTo(0);
    toast(records.length + ' records loaded (seq ' + p6(start) + ' to ' + p6(start + records.length - 1) + ') — use ◀ / ▶ in the menu bar');
  }

  /* ---------- batch dialog ---------- */
  const TEMPLATE_CSV =
    '\uFEFFname_en,name_ar,name_ar,id,passport,dob,nationality,nationality_ar,seq\r\n' +
    'MOHAMMED ALI,محمد علي,212345678,AB1234567,24/01/1990,Pakistan,,000001\r\n';

  function openBatchDialog() {
    const dlg = mk('dialog', 'mt-modal mt-modal--wide no-print');
    dlg.setAttribute('aria-label', 'Batch CSV Import');
    dlg.append(mk('h2', 'mt-modal__title', 'Batch CSV Import'));

    const help = mk('p', 'mt-modal__help');
    help.append(
      'CSV (comma, semicolon or tab; UTF-8) or JSON array. Columns: ',
      mk('code', '', 'name_en'), ' ', mk('code', '', 'name_ar'), ' ', mk('code', '', 'id'), ' ',
      mk('code', '', 'passport'), ' ', mk('code', '', 'dob'), ' ', mk('code', '', 'nationality'), ' ',
      mk('code', '', 'nationality_ar'), ' ', mk('code', '', 'seq'),
      '. DOB is read as DD/MM/YYYY or YYYY-MM-DD. Unknown columns are ignored.'
    );

    const fileRow = mk('div', 'mt-file-row');
    const chooseBtn = mk('button', '', 'Choose file…');
    const tplBtn = mk('button', 'ghost', 'Download CSV template');
    const fileName = mk('span', 'mt-file-name', 'No file selected');
    chooseBtn.type = 'button';
    tplBtn.type = 'button';
    fileRow.append(chooseBtn, tplBtn, fileName);

    const result = mk('div', 'mt-result');

    const cancel = mk('button', 'ghost', 'Cancel');
    const load = mk('button', '', 'Load records');
    cancel.type = 'button';
    load.type = 'button';
    load.disabled = true;
    const actions = mk('div', 'mt-modal__actions');
    actions.append(cancel, load);

    dlg.append(help, fileRow, result, actions);

    let parsed = null;

    function render(p) {
      result.textContent = '';
      result.append(mk('p', 'mt-summary', p.records.length + ' record(s) ready' +
        (p.warnings.length ? ' — ' + p.warnings.length + ' warning(s)' : '') + '.'));

      const wrap = mk('div', 'mt-preview');
      const table = mk('table');
      const thead = mk('thead');
      const hr = mk('tr');
      ['#', 'Name (EN)', 'Name (AR)', 'ID', 'Passport', 'DOB'].forEach((h) => hr.append(mk('th', '', h)));
      thead.append(hr);
      const tbody = mk('tbody');
      p.records.slice(0, 5).forEach((r, i) => {
        const tr = mk('tr');
        const ar = mk('td', 'ar', r.nameAr || '');
        ar.setAttribute('lang', 'ar');
        tr.append(mk('td', '', String(i + 1)), mk('td', '', r.nameEn || ''), ar,
          mk('td', '', r.id || ''), mk('td', '', r.passport || ''), mk('td', '', r.dob || ''));
        tbody.append(tr);
      });
      table.append(thead, tbody);
      wrap.append(table);
      result.append(wrap);
      if (p.records.length > 5) result.append(mk('p', 'mt-modal__help', '… and ' + (p.records.length - 5) + ' more.'));

      if (p.ignoredCols.length) result.append(mk('p', 'mt-modal__help', 'Ignored columns: ' + p.ignoredCols.join(', ')));
      if (p.warnings.length) {
        const ul = mk('ul', 'mt-warn-list');
        p.warnings.slice(0, 25).forEach((w) => ul.append(mk('li', '', w)));
        if (p.warnings.length > 25) ul.append(mk('li', '', '… and ' + (p.warnings.length - 25) + ' more.'));
        result.append(ul);
      }
    }

    chooseBtn.addEventListener('click', async () => {
      const f = await pickFile('.csv,.json,.txt,text/csv,application/json');
      if (!f) return;
      parsed = null;
      load.disabled = true;
      fileName.textContent = f.name;
      result.textContent = '';
      if (f.size > MAX_FILE_BYTES) { result.append(mk('p', 'mt-summary', 'File is too large (25 MB max).')); return; }
      try {
        parsed = parseBatch(await f.text());
        render(parsed);
        load.disabled = false;
      } catch (err) {
        result.append(mk('p', 'mt-summary', 'Cannot read this file: ' + (err && err.message ? err.message : 'unknown error')));
      }
    });

    tplBtn.addEventListener('click', () => download('cert-batch-template.csv', TEMPLATE_CSV, 'text/csv'));
    cancel.addEventListener('click', () => dlg.close());
    load.addEventListener('click', () => { if (parsed) { const recs = parsed.records; dlg.close(); loadBatch(recs); } });
    dlg.addEventListener('close', () => dlg.remove());

    document.body.appendChild(dlg);
    dlg.showModal();
    chooseBtn.focus();
  }

  /* ======================================================================
   * 8. Help menu: shortcuts, quick start, PWA status, about
   * ====================================================================== */
  const SHORTCUTS = [
    ['Menus', [['Alt + F', 'File'], ['Alt + E', 'Edit'], ['Alt + V', 'View'], ['Alt + D', 'Data Tools'], ['Alt + H', 'Help'],
      ['↑ ↓', 'Move through the menu'], ['← →', 'Switch menu / open or close submenu'],
      ['Enter', 'Run the highlighted item'], ['Esc', 'Close menu, back to the cell']]],
    ['File', [['Ctrl + N', 'New record'], ['Ctrl + O', 'Open / import JSON'], ['Ctrl + S', 'Save as PDF (image, 300 DPI)'], ['Ctrl + Shift + S', 'Save as JPG (300 DPI)'], ['Ctrl + P', 'Print / Save as PDF']]],
    ['Edit', [['Ctrl + Z', 'Undo'], ['Ctrl + Y', 'Redo'], ['Ctrl + X / C / V', 'Cut / Copy / Paste'], ['Ctrl + F', 'Find and Replace']]],
    ['View', [['F4', 'Fit to width'], ['Shift + F4', 'Fit whole page'], ['Ctrl + 1', 'Actual size (100%)'], ['Ctrl + +  /  Ctrl + −', 'Zoom in / out']]],
    ['Data', [['F5', 'Recalculate dates & sync']]],
    ['Cells', [['Tab / Shift + Tab', 'Next / previous cell (selects all text)'], ['Enter', 'Finish a single-line cell'],
      ['V  H  Z  A', 'Select, Hand, Zoom tool, Audit (when not typing)'],
      ['Esc / double-click canvas', 'Hand or Zoom tool back to Select']]],
    ['Help', [['F1', 'This guide']]]
  ];

  function openShortcuts() {
    const grid = mk('div', 'mt-kbd-grid');
    SHORTCUTS.forEach((g) => {
      const sec = mk('section', 'mt-kbd-group');
      sec.append(mk('h3', 'mt-kbd-title', g[0]));
      const table = mk('table', 'mt-kbd-table');
      const tbody = mk('tbody');
      g[1].forEach((r) => {
        const tr = mk('tr');
        const keys = mk('td', 'mt-kbd-keys');
        keys.append(mk('kbd', '', r[0]));
        tr.append(keys, mk('td', '', r[1]));
        tbody.append(tr);
      });
      table.append(tbody);
      sec.append(table);
      grid.append(sec);
    });
    const note = mk('p', 'mt-modal__help',
      'Ctrl+N and Ctrl+W are reserved by Chrome / Edge inside a normal browser tab: Ctrl+N works in the installed app window. ' +
      'While this page has focus, F5 and Ctrl+F belong to the app (Ctrl+R still reloads the page).');
    infoDialog('Keyboard Shortcuts', [grid, note], { wide: true });
  }

  function openQuickStart() {
    const items = [
      'Fill the record: Name (English and Arabic), ID No. (9 digits after the fixed 2), Passport, Date of Birth as DD/MM/YYYY (the Hijri date is computed for you) and Nationality (either dropdown fills the other).',
      'Photo: click the photo box, right-click it for Upload / Remove / Lock, or paste an image with Ctrl+V. The outer frame is 35.814 × 41.481 mm; the picture is fitted at 37.042 mm height and is never stretched.',
      'Excel-style editing: Tab and Shift+Tab jump between cells and select their whole text; Enter finishes a single-line cell.',
      'Layout texts (titles, badges, Requested By, disclaimer, ribbon) are locked. Use the lock badge at the top right to unlock them, and lock them again when done.',
      'Dates: issue date is today, expiry is 29 days later. F5 recalculates them.',
      'Printing: Ctrl+P. The sheet is A4 portrait with zero margin; in the browser print dialog choose Scale 100% and Margins: None.',
      'Batch: Data Tools → Batch CSV Import loads many people; ◀ ▶ in the menu bar page through them.',
      'Everything is saved in this browser automatically. File → Save Backup As writes a JSON copy you can restore with File → Open.'
    ];
    const ol = mk('ol', 'mt-guide');
    items.forEach((t) => ol.append(mk('li', '', t)));
    infoDialog('Quick Start Guide', [ol], { wide: true });
  }

  async function collectPwaRows() {
    const hasSw = 'serviceWorker' in navigator;
    let reg = null;
    let names = [];
    try { if (hasSw) reg = await navigator.serviceWorker.getRegistration('./'); } catch (_) { /* ignore */ }
    try { if (window.caches) names = (await caches.keys()).filter((n) => n.indexOf('cert-engine-') === 0); } catch (_) { /* ignore */ }
    const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    const controlled = hasSw && !!navigator.serviceWorker.controller;
    return {
      reg: reg,
      controlled: controlled,
      names: names,
      rows: [
        ['Secure context', window.isSecureContext ? 'Yes (https or localhost)' : 'No — service workers are disabled'],
        ['Service worker', !hasSw ? 'Not supported' : reg ? (reg.active ? 'Active' : reg.installing ? 'Installing…' : 'Registered') : 'Not registered'],
        ['Controls this page', controlled ? 'Yes — works offline' : 'No (reload once after the first install)'],
        ['Update waiting', reg && reg.waiting ? 'Yes — use the Reload prompt' : 'No'],
        ['Offline cache', names.length ? names.join(', ') : 'None'],
        ['Display mode', standalone ? 'Installed app window' : 'Browser tab'],
        ['Install available', installAvailable() ? 'Yes' : 'No (already installed, or not offered by this browser)']
      ]
    };
  }

  async function openPwaStatus() {
    const holder = mk('div');
    const msg = mk('p', 'mt-modal__help', '');
    const check = mk('button', '', 'Check for updates');
    check.type = 'button';

    async function render() {
      const info = await collectPwaRows();
      holder.textContent = '';
      holder.append(statusList(info.rows));
      return info;
    }
    await render();

    check.addEventListener('click', async () => {
      const info = await render();
      if (!info.reg) { msg.textContent = 'No service worker is registered, so there is nothing to update.'; return; }
      check.disabled = true;
      msg.textContent = 'Checking…';
      try {
        await info.reg.update();
        await render();
        msg.textContent = 'Check finished. If a new version exists, the Reload prompt appears as soon as it has downloaded.';
      } catch (_) {
        msg.textContent = 'Could not reach the server (offline?). Try again when connected.';
      }
      check.disabled = false;
    });

    infoDialog('Check for Updates / PWA Status', [holder, msg], { extra: [check] });
  }

  async function openAbout() {
    const info = await collectPwaRows();
    const rows = [
      ['Application', APP_NAME],
      ['Offline engine', info.controlled ? 'Ready (service worker active)' : 'Not controlling this page yet'],
      ['Offline cache', info.names.length ? info.names.join(', ') : 'None'],
      ['Paper', 'A4 portrait, 210 × 297 mm, @page margin 0'],
      ['Data grid', 'Row 196.85 mm · tier 7.923 mm · gap 1.898 mm'],
      ['Photo frame', '35.814 × 41.481 mm (image height 37.042 mm)'],
      ['Data location', 'Stays in this browser (localStorage + IndexedDB); nothing is uploaded']
    ];
    infoDialog('About CertEngine', [statusList(rows)]);
  }

  /* ======================================================================
   * 9. Menu definitions
   * ====================================================================== */
  // `alt` (Urdu) is kept as data only: it is NOT rendered in the menu bar any more (see buildMenubar).
  const MENUS = [
    { id: 'file', host: 'bar', label: 'File', access: 'f', alt: 'فائل', items: [
      { label: 'New Record', icon: 'new', kbd: 'Ctrl+N', tip: 'Reset record fields and photo to defaults', run: newRecord },
      { label: 'Open / Import JSON…', icon: 'open', kbd: 'Ctrl+O', tip: 'Load a backup (.json / .cert)', run: importFile },
      { label: 'Save as PDF (image, 300 DPI)', icon: 'pdf', kbd: 'Ctrl+S', tip: 'Flat image PDF: text is not selectable. Use Print for a vector PDF', run: () => exportAs('pdf'), disabled: () => missingRequired().length > 0, why: whyBlocked },
      { label: 'Save as JPG (High Quality)', icon: 'image', kbd: 'Ctrl+Shift+S', tip: 'A4 JPG, 2480 x 3508 px (300 DPI)', run: () => exportAs('jpg'), disabled: () => missingRequired().length > 0, why: whyBlocked },
      { label: 'Save Backup As…', icon: 'save', tip: 'Download field values and photos as JSON', run: exportBackup },
      '-',
      { label: 'Send To', icon: 'send', sub: [
        { label: 'Mail Recipient…', icon: 'mail', tip: 'Open your mail app with the certificate details', run: mailRecipient },
        { label: 'Download Backup Package (.json)', icon: 'download', run: exportBackup },
        { label: 'Desktop Shortcut (Install App)', icon: 'monitor', tip: 'Install this app on your computer', run: installApp, disabled: () => !installAvailable() }
      ] },
      '-',
      { label: 'Print / Save as PDF', icon: 'print', kbd: 'Ctrl+P', tip: 'Open the print dialog', run: printWithGuard },
      { label: 'Exit / Reset Form…', icon: 'exit', tip: 'Wipe all saved data and reload blank', run: factoryReset }
    ] },
    { id: 'edit', host: 'bar', label: 'Edit', access: 'e', alt: 'ترمیم', items: [
      { label: 'Undo', icon: 'undo', kbd: 'Ctrl+Z', tip: 'Undo last field edit', run: undo, disabled: () => !canUndo() },
      { label: 'Redo', icon: 'redo', kbd: 'Ctrl+Y', tip: 'Redo field edit', run: redo, disabled: () => !canRedo() },
      '-',
      { label: 'Cut', icon: 'cut', kbd: 'Ctrl+X', tip: 'Cut the selected text', run: () => clipCopy(true), disabled: () => !selState().has },
      { label: 'Copy', icon: 'copy', kbd: 'Ctrl+C', tip: 'Copy the selected text', run: () => clipCopy(false), disabled: () => !selState().has },
      { label: 'Paste', icon: 'paste', kbd: 'Ctrl+V', tip: 'Paste plain text', run: clipPaste, disabled: () => !selState().target },
      '-',
      { label: 'Select All', icon: 'selectall', sub: [
        { label: 'All Form Fields', icon: 'selectall', tip: 'Highlight every editable cell and select the English name', run: selectAllFields },
        { label: 'Copy Certificate Summary', icon: 'copy', tip: 'Copy name, ID, passport and dates as text', run: copySummary }
      ] },
      { label: 'Find and Replace…', icon: 'find', kbd: 'Ctrl+F', run: openFind },
      '-',
      { label: 'Clear Field Values', icon: 'clear', tip: 'Empty name, ID, passport and DOB', run: clearFields }
    ] },
    { id: 'view', host: 'bar', label: 'View', access: 'v', alt: 'دیکھیں', items: [
      { label: 'Fit to Width', kbd: 'F4', check: () => viewModeIs('width'), run: () => setViewMode('width') },
      { label: 'Fit Whole Page', kbd: 'Shift+F4', check: () => viewModeIs('page'), run: () => setViewMode('page') },
      { label: 'Actual Size (100%)', kbd: 'Ctrl+1', check: () => viewModeIs('actual'), run: () => setViewMode('actual') },
      { label: 'Zoom In', icon: 'zoomin', kbd: 'Ctrl + +', run: zoomIn },
      { label: 'Zoom Out', icon: 'zoomout', kbd: 'Ctrl + −', run: zoomOut },
      '-',
      { label: 'Alignment Grid Overlay', tip: 'Screen-only 10 mm / 5 mm dashed grid', check: () => gridOn, run: toggleGrid },
      { label: 'Pre-flight QA / Audit Highlights', kbd: 'A', tip: 'Highlight missing mandatory fields', check: () => auditOn, run: toggleAudit }
    ] },
    { id: 'data', host: 'bar', label: 'Data Tools', access: 'd', alt: 'ڈیٹا ٹولز', items: [
      { label: 'Recalculate Dates & Sync', icon: 'refresh', kbd: 'F5', tip: 'Re-sync Gregorian / Hijri issue and expiry dates', run: recalcDates },
      { label: 'Batch CSV Import…', icon: 'batch', tip: 'Load many candidates and page through them', run: openBatchDialog },
      '-',
      { label: 'Next Record', icon: 'next', run: nextRecord, disabled: () => !batchActive() || batch.index >= batch.records.length - 1 },
      { label: 'Previous Record', icon: 'prev', run: prevRecord, disabled: () => !batchActive() || batch.index <= 0 },
      { label: 'End Batch', icon: 'end', run: endBatch, disabled: () => !batchActive() }
    ] },
    { id: 'help', host: 'bar', label: 'Help', access: 'h', alt: 'مدد', items: [
      { label: 'Keyboard Shortcuts Guide', icon: 'keyboard', kbd: 'F1', run: openShortcuts },
      { label: 'Quick Start Guide', icon: 'book', run: openQuickStart },
      '-',
      { label: 'Check for Updates / PWA Status', icon: 'refresh', run: openPwaStatus },
      { label: 'About CertEngine', icon: 'info', run: openAbout }
    ] }
  ];

  const PROP_SIZE = [
    { label: 'A4  (210 × 297 mm)', check: () => true, run: () => toast('A4 is the only print geometry: the certificate grid is millimetre-locked') },
    '-',
    { label: 'Other sizes are locked', disabled: () => true, run: () => {} }
  ];

  const PROP_VIEW = [
    { label: 'Fit Width', check: () => viewModeIs('width'), run: () => setViewMode('width') },
    { label: 'Fit Page', check: () => viewModeIs('page'), run: () => setViewMode('page') },
    { label: '100% (Actual Size)', check: () => viewModeIs('actual'), run: () => setViewMode('actual') },
    '-'
  ].concat(ZOOM_PRESETS.map((f) => ({ label: Math.round(f * 100) + '%', check: () => zoomIs(f), run: () => setZoomTo(f) })));

  /* ======================================================================
   * 10. Menu engine (menu bar + property-bar dropdowns, submenus, keyboard model)
   * ====================================================================== */
  const tops = [];          // { host: 'bar'|'prop', access, btn, list, wrap }
  const registry = [];      // every item incl. submenu items: { def, btn }
  let openIdx = -1;
  let mbSeq = 0;

  const itemsOf = (ul) => Array.from(ul.children)
    .filter((li) => !li.classList.contains('mb-sep'))
    .map((li) => li.firstElementChild)
    .filter((b) => b && !b.disabled);

  const subOf = (b) => (b.parentElement ? b.parentElement.querySelector(':scope > ul.mb-sub') : null);

  function closeSub(b) {
    const s = subOf(b);
    if (!s) return;
    s.hidden = true;
    s.classList.remove('flip');
    b.setAttribute('aria-expanded', 'false');
    s.querySelectorAll('ul.mb-sub').forEach((x) => { x.hidden = true; });
    s.querySelectorAll('.mb-item[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
  }

  function closeSiblingSubs(ul, keep) {
    Array.from(ul.children).forEach((li) => {
      const sb = li.querySelector(':scope > .mb-item[aria-haspopup]');
      if (sb && sb !== keep) closeSub(sb);
    });
  }

  function openSub(b, focusFirst) {
    const s = subOf(b);
    if (!s) return;
    closeSiblingSubs(b.closest('ul.mb-list'), b);
    s.hidden = false;
    b.setAttribute('aria-expanded', 'true');
    s.classList.remove('flip');
    if (s.getBoundingClientRect().right > window.innerWidth - 8) s.classList.add('flip');   // no room on the right: open to the left
    if (focusFirst) { const l = itemsOf(s); if (l[0]) l[0].focus(); }
  }

  function toggleSub(b, focusFirst) {
    if (b.getAttribute('aria-expanded') === 'true' && !focusFirst) closeSub(b);
    else openSub(b, focusFirst);
  }

  function refreshStates() {
    registry.forEach((r) => {
      if (r.def.disabled) {
        const d = !!r.def.disabled();
        r.btn.disabled = d;
        if (r.def.why) r.btn.title = d ? r.def.why() : (r.btn.dataset.title || r.btn.title);   // disabled kyun hai, tooltip mein
      }
      if (r.def.check) r.btn.setAttribute('aria-checked', String(!!r.def.check()));
    });
  }

  function closeMenus(refocusTop) {
    if (openIdx < 0) return;
    const t = tops[openIdx];
    t.list.hidden = true;
    t.list.querySelectorAll('ul.mb-sub').forEach((s) => { s.hidden = true; s.classList.remove('flip'); });
    t.list.querySelectorAll('.mb-item[aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    t.btn.setAttribute('aria-expanded', 'false');
    openIdx = -1;
    if (refocusTop) t.btn.focus();
  }

  function focusEdge(i, last) {
    const l = itemsOf(tops[i].list);
    const b = last ? l[l.length - 1] : l[0];
    if (b) b.focus();
  }

  function openMenu(i, focusFirst) {
    if (openIdx === i) return;
    closeMenus(false);
    refreshStates();
    const t = tops[i];
    t.list.hidden = false;
    t.btn.setAttribute('aria-expanded', 'true');
    openIdx = i;
    if (focusFirst) focusEdge(i, false);
  }

  // After a menu command: if focus is still inside the header (keyboard path), give it back to the cell.
  function returnFocus() {
    const a = document.activeElement;
    if (a && a.closest && a.closest('.app-header')) {
      if (!restoreEd() && a.blur) a.blur();
    }
  }

  function activate(def) {
    closeMenus(false);
    returnFocus();
    Promise.resolve().then(def.run).catch((err) => { console.error('[menu-tools]', err); toast('Action failed'); });
  }

  function buildList(defs, ul) {
    defs.forEach((def) => {
      const li = mk('li');
      if (def === '-') {
        li.className = 'mb-sep';
        li.setAttribute('role', 'separator');
        ul.append(li);
        return;
      }
      li.setAttribute('role', 'none');
      const b = mk('button', 'mb-item');
      b.type = 'button';
      b.id = 'mb-item-' + (++mbSeq);
      b.tabIndex = -1;
      b.setAttribute('role', def.check ? 'menuitemcheckbox' : 'menuitem');
      if (def.check) b.setAttribute('aria-checked', 'false');
      b.title = (def.tip || def.label) + (def.kbd ? ' (' + def.kbd + ')' : '');
      b.dataset.title = b.title;
      b.append(def.check ? mk('span', 'mb-ico') : iconEl(def.icon), mk('span', 'mb-text', def.label), mk('span', 'mb-kbd', def.kbd || ''), mk('span', 'mb-arrow'));
      li.append(b);

      if (def.sub) {
        li.classList.add('mb-has-sub');
        b.setAttribute('aria-haspopup', 'menu');
        b.setAttribute('aria-expanded', 'false');
        const sub = mk('ul', 'mb-list mb-sub');
        sub.setAttribute('role', 'menu');
        sub.setAttribute('aria-labelledby', b.id);
        sub.hidden = true;
        buildList(def.sub, sub);
        li.append(sub);
      }

      b.addEventListener('click', (e) => {
        if (def.sub) { toggleSub(b, e.detail === 0); return; }     // detail 0 = keyboard-initiated click
        activate(def);
      });
      ul.append(li);
      registry.push({ def: def, btn: b });
    });
  }

  function attachMenu(cfg) {
    if (!cfg.btn || !cfg.wrap) return;
    const list = mk('ul', 'mb-list');
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-labelledby', cfg.btn.id);
    list.hidden = true;
    buildList(cfg.defs, list);
    cfg.wrap.append(list);

    const mi = tops.length;
    tops.push({ host: cfg.host, access: cfg.access || '', btn: cfg.btn, list: list, wrap: cfg.wrap });
    cfg.btn.setAttribute('aria-expanded', 'false');

    cfg.btn.addEventListener('click', (e) => {
      if (openIdx === mi) closeMenus(false);
      else openMenu(mi, e.detail === 0);
    });
    cfg.btn.addEventListener('mouseenter', () => {
      if (openIdx >= 0 && openIdx !== mi && tops[openIdx].host === cfg.host) openMenu(mi, false);
    });
    list.addEventListener('mouseover', (e) => {
      const b = e.target.closest('.mb-item');
      if (!b || b.disabled) return;
      closeSiblingSubs(b.closest('ul.mb-list'), b);
      if (b.hasAttribute('aria-haspopup')) openSub(b, false);
    });
  }

  function buildLabel(label, access) {
    const span = mk('span', 'mb-label');
    const i = label.toLowerCase().indexOf(access);
    if (i < 0) { span.textContent = label; return span; }
    span.append(label.slice(0, i), mk('u', '', label.charAt(i)), label.slice(i + 1));
    return span;
  }

  function buildPager(nav) {
    const root = mk('div', 'mb-batch');
    root.hidden = true;
    const prev = mk('button', '', '◀ Prev');
    const count = mk('span', 'mb-count', '0 / 0');
    const next = mk('button', '', 'Next ▶');
    const rec = mk('span', 'mb-rec', '');
    const end = mk('button', '', '✕');
    [prev, next, end].forEach((b) => { b.type = 'button'; });
    prev.title = 'Previous record';
    next.title = 'Next record';
    end.title = 'End batch';
    end.setAttribute('aria-label', 'End batch');
    prev.addEventListener('click', prevRecord);
    next.addEventListener('click', nextRecord);
    end.addEventListener('click', endBatch);
    root.append(prev, count, next, rec, end);
    nav.append(root);
    pager = { root: root, prev: prev, next: next, count: count, rec: rec };
  }

  function buildMenubar() {
    const nav = $('menubar');
    if (!nav) return;
    nav.setAttribute('role', 'menubar');
    nav.setAttribute('aria-label', 'Application menu');

    MENUS.forEach((m) => {
      const wrap = mk('div', 'mb-menu');
      wrap.setAttribute('role', 'none');
      const btn = mk('button', 'mb-top');
      btn.type = 'button';
      btn.id = 'mb-top-' + m.id;
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-keyshortcuts', 'Alt+' + m.access.toUpperCase());
      btn.setAttribute('aria-label', m.label + ' menu');          // clean visual label; screen readers get the full name
      btn.title = m.label + ' menu (Alt+' + m.access.toUpperCase() + ')';
      btn.append(buildLabel(m.label, m.access));
      wrap.append(btn);
      nav.append(wrap);
      attachMenu({ host: m.host, btn: btn, wrap: wrap, defs: m.items, access: m.access });
    });
    buildPager(nav);
  }

  /* ---------- property bar ---------- */
  function syncProp() {
    if (pb.undo) pb.undo.disabled = !canUndo();
    if (pb.redo) pb.redo.disabled = !canRedo();
    const vp = V();
    if (!vp || !pb.viewLabel) return;
    const m = vp.getMode();
    const pct = Math.round((vp.getScale() || 1) * 100) + '%';
    pb.viewLabel.textContent = m === 'width' ? 'Fit Width' : m === 'page' ? 'Fit Page' : m === 'actual' ? '100%' : pct;
    if (pb.viewPct) pb.viewPct.textContent = pct;
  }

  function buildPropBar() {
    pb.undo = $('pb-undo');
    pb.redo = $('pb-redo');
    pb.print = $('pb-print');
    pb.viewLabel = $('pb-view-label');
    pb.viewPct = $('pb-view-pct');

    attachMenu({ host: 'prop', btn: $('pb-size-btn'), wrap: $('pb-size-dd'), defs: PROP_SIZE });
    attachMenu({ host: 'prop', btn: $('pb-view-btn'), wrap: $('pb-view-dd'), defs: PROP_VIEW });

    if (pb.print) pb.print.addEventListener('click', printWithGuard);
    if (pb.undo) pb.undo.addEventListener('click', undo);
    if (pb.redo) pb.redo.addEventListener('click', redo);
    const bar = $('propbar');
    if (bar) {
      const chip = mk('button', 'pb-chip');
      chip.type = 'button';
      chip.id = 'pb-ready';
      const label = mk('span', 'pb-chip__label', 'Checking…');
      chip.append(label);
      chip.addEventListener('click', () => {
        if (!revealMissing().length) toast('All required fields are complete');
      });
      bar.append(chip);
      ready.chip = chip;
      ready.label = label;
    }

    // viewport.js has no change event: it writes data-mode on #viewport and --cert-scale on <html>.
    if (typeof MutationObserver === 'function') {
      const mo = new MutationObserver(syncProp);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
      const vpEl = $('viewport');
      if (vpEl) mo.observe(vpEl, { attributes: true, attributeFilter: ['data-mode'] });
    }
    window.addEventListener('resize', syncProp);
    syncProp();
  }

  /* ---------- keyboard model ---------- */
  function topIndexIn(host, from, dir) {
    const idxs = [];
    tops.forEach((t, i) => { if (t.host === host) idxs.push(i); });
    const at = idxs.indexOf(from);
    return idxs[(at + dir + idxs.length) % idxs.length];
  }

  function onHeaderKey(e) {
    const topBtn = e.target.closest('.mb-top, .pb-dd-btn');
    const item = e.target.closest('.mb-item');

    if (topBtn) {
      const i = tops.findIndex((t) => t.btn === topBtn);
      if (i < 0) return;
      const host = tops[i].host;
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && host === 'bar') {
        e.preventDefault();
        const ni = topIndexIn(host, i, e.key === 'ArrowRight' ? 1 : -1);
        if (openIdx >= 0) openMenu(ni, true); else tops[ni].btn.focus();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        openMenu(i, false);
        focusEdge(i, false);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        openMenu(i, false);
        focusEdge(i, true);
      } else if (e.key === 'Escape') {
        closeMenus(false);
      }
      return;
    }

    if (!item || openIdx < 0) return;
    const ul = item.closest('ul.mb-list');
    const list = itemsOf(ul);
    const at = list.indexOf(item);
    const inSub = ul.classList.contains('mb-sub');
    const closeThisSub = () => {
      const parent = document.getElementById(ul.getAttribute('aria-labelledby'));
      if (parent) { closeSub(parent); parent.focus(); }
    };

    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); if (list.length) list[(at + 1) % list.length].focus(); break;
      case 'ArrowUp': e.preventDefault(); if (list.length) list[(at - 1 + list.length) % list.length].focus(); break;
      case 'Home': e.preventDefault(); if (list.length) list[0].focus(); break;
      case 'End': e.preventDefault(); if (list.length) list[list.length - 1].focus(); break;
      case 'ArrowRight':
        e.preventDefault();
        if (item.hasAttribute('aria-haspopup')) openSub(item, true);
        else if (tops[openIdx].host === 'bar') openMenu(topIndexIn('bar', openIdx, 1), true);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (inSub) closeThisSub();
        else if (tops[openIdx].host === 'bar') openMenu(topIndexIn('bar', openIdx, -1), true);
        break;
      case 'Escape':
        e.preventDefault();
        if (inSub) { closeThisSub(); break; }
        { const t = tops[openIdx]; closeMenus(false); if (!restoreEd()) t.btn.focus(); }
        break;
      case 'Tab': closeMenus(false); break;
      default: break;
    }
  }

  // Menu opened with the mouse keeps focus in the cell: route Esc / arrows into the menu from there.
  function onOutsideKey(e) {
    if (openIdx < 0) return;
    if (e.target.closest && e.target.closest('.app-header')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(false); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      focusEdge(openIdx, e.key === 'ArrowUp');
    }
  }

  function initMenuKeys() {
    const header = q1('.app-header');
    if (!header) return;
    // Buttons never take focus on mouse-down: the cell keeps its focus + selection (needed by Cut / Copy / Paste).
    header.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    header.addEventListener('keydown', onHeaderKey);
    document.addEventListener('keydown', onOutsideKey, true);
    document.addEventListener('pointerdown', (e) => {
      if (openIdx >= 0 && !e.target.closest('.mb-menu, .pb-dd')) closeMenus(false);
    }, true);
    window.addEventListener('blur', () => closeMenus(false));
    window.addEventListener('resize', () => closeMenus(false));
  }

  function toggleViaKeyboard(i) {
    if (openIdx === i) { closeMenus(false); restoreEd(); return; }
    openMenu(i, true);
  }

  /* ======================================================================
   * 11. Tool palette (Select / Hand / Zoom / Audit / Case)
   * ====================================================================== */
  let tool = 'select';
  let caseEnabled = true;

  const ICONS = {
    select: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3l14 7-6 2.2L10.8 19z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>',
    zoom: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/></svg>',
    audit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1z"/><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2"/><path d="M9 14l2 2 4-4"/></svg>',
    grip: '<svg viewBox="0 0 18 10" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="2" r="1.2"/><circle cx="9" cy="2" r="1.2"/><circle cx="15" cy="2" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="15" cy="8" r="1.2"/></g></svg>'
  };

  function setTool(name) {
    if (name !== 'select' && name !== 'hand' && name !== 'zoom') return;
    tool = name;
    const b = document.body;
    b.classList.toggle('tool-hand', name === 'hand');
    b.classList.toggle('tool-zoom', name === 'zoom');
    if (name !== 'zoom') b.classList.remove('zoom-out');
    qa('.fp-btn[data-tool]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.tool === name)));
    if (name !== 'select' && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    hidePop();
  }

  function buildPalette() {
    const pal = $('floating-palette');
    if (!pal) return;
    pal.setAttribute('role', 'toolbar');
    pal.setAttribute('aria-label', 'Tools');
    pal.setAttribute('aria-orientation', 'vertical');

    const grip = mk('div', 'fp-grip');
    grip.innerHTML = ICONS.grip;             // static literal, no user data
    grip.title = 'Drag to move (double-click to reset)';
    pal.append(grip);

    function btn(id, title, icon, key) {
      const b = mk('button', 'fp-btn');
      b.type = 'button';
      b.id = id;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = icon;                    // static literal
      if (key) b.append(mk('span', 'fp-key', key));
      pal.append(b);
      return b;
    }

    const sel = btn('palette-select', 'Select / Edit (V)', ICONS.select, 'V');
    const hand = btn('palette-hand', 'Hand / Pan (H)', ICONS.hand, 'H');
    const zoom = btn('palette-zoom', 'Zoom (Z) — click to zoom in, Alt+click to zoom out', ICONS.zoom, 'Z');
    sel.dataset.tool = 'select';
    hand.dataset.tool = 'hand';
    zoom.dataset.tool = 'zoom';
    pal.append(mk('div', 'fp-sep'));

    const audit = btn('palette-audit', 'Pre-flight Audit (A)', ICONS.audit, 'A');
    audit.classList.add('fp-toggle');
    const badge = mk('span', 'fp-badge');
    badge.id = 'fp-audit-badge';
    badge.hidden = true;
    audit.append(badge);

    const cs = btn('palette-case', 'Text Case Utility — popover appears when text is selected', '', '');
    cs.textContent = 'Aa';
    cs.classList.add('fp-toggle');
    cs.setAttribute('aria-pressed', 'true');

    sel.addEventListener('click', () => setTool('select'));
    hand.addEventListener('click', () => setTool('hand'));
    zoom.addEventListener('click', () => setTool('zoom'));
    audit.addEventListener('click', toggleAudit);
    cs.addEventListener('click', () => {
      caseEnabled = !caseEnabled;
      cs.setAttribute('aria-pressed', String(caseEnabled));
      if (!caseEnabled) hidePop();
      toast(caseEnabled ? 'Case popover ON' : 'Case popover OFF');
    });

    initPaletteDrag(pal, grip);
    setTool('select');                       // strict default: Select is active on load
  }

  function initPaletteDrag(pal, grip) {
    let drag = null;
    // The header (z-index 900) paints over the palette (850): never let a dragged / restored
    // position slide underneath it, or the Select tool is lost again.
    const minTop = () => { const h = q1('.app-header'); return (h ? h.offsetHeight : 0) + 4; };
    const clampIntoView = () => {
      if (!pal.classList.contains('is-free')) return;
      const r = pal.getBoundingClientRect();
      pal.style.left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - r.width - 4)) + 'px';
      pal.style.top = Math.min(Math.max(minTop(), r.top), Math.max(minTop(), window.innerHeight - r.height - 4)) + 'px';
    };

    try {
      const p = JSON.parse(localStorage.getItem(PALETTE_KEY));
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        pal.classList.add('is-free');
        pal.style.left = p.x + 'px';
        pal.style.top = p.y + 'px';
        clampIntoView();
      }
    } catch (_) { /* ignore */ }

    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = pal.getBoundingClientRect();
      pal.classList.add('is-free');
      pal.style.left = r.left + 'px';
      pal.style.top = r.top + 'px';
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const w = pal.offsetWidth, h = pal.offsetHeight;
      pal.style.left = Math.min(Math.max(4, e.clientX - drag.dx), Math.max(4, window.innerWidth - w - 4)) + 'px';
      pal.style.top = Math.min(Math.max(minTop(), e.clientY - drag.dy), Math.max(minTop(), window.innerHeight - h - 4)) + 'px';
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      try {
        const r = pal.getBoundingClientRect();
        localStorage.setItem(PALETTE_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
      } catch (_) { /* ignore */ }
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => {
      pal.classList.remove('is-free');
      pal.style.left = '';
      pal.style.top = '';
      try { localStorage.removeItem(PALETTE_KEY); } catch (_) { /* ignore */ }
    });
    window.addEventListener('resize', clampIntoView);
  }

  /* ---------- Hand (pan) + Zoom (click) interactions ---------- */
  function initCanvasTools() {
    const viewport = $('viewport');
    if (!viewport) return;
    let pan = null;

    viewport.addEventListener('pointerdown', (e) => {
      if (tool !== 'hand' || e.button !== 0) return;
      pan = { x: e.clientX, y: e.clientY, id: e.pointerId };
      viewport.setPointerCapture(e.pointerId);
      document.body.classList.add('is-panning');
      e.preventDefault();
    });
    viewport.addEventListener('pointermove', (e) => {
      if (!pan || e.pointerId !== pan.id) return;
      viewport.scrollLeft -= e.clientX - pan.x;            // horizontal: only scrolls in zoom/actual mode
      window.scrollBy(0, -(e.clientY - pan.y));            // vertical: document scroll
      pan.x = e.clientX;
      pan.y = e.clientY;
    });
    const endPan = () => { pan = null; document.body.classList.remove('is-panning'); };
    viewport.addEventListener('pointerup', endPan);
    viewport.addEventListener('pointercancel', endPan);
    viewport.addEventListener('lostpointercapture', endPan);

    viewport.addEventListener('click', (e) => {
      if (tool !== 'zoom') return;
      zoomBy(e.altKey ? 1 / ZOOM_TOOL_STEP : ZOOM_TOOL_STEP, e.clientX, e.clientY);
    });

    // Fail-safe: while Hand / Zoom is active every child of #viewport ignores the pointer, so a
    // double-click always lands on the canvas background itself and returns to Select.
    viewport.addEventListener('dblclick', () => { if (tool !== 'select') setTool('select'); });

    const altSync = (e) => { if (tool === 'zoom') document.body.classList.toggle('zoom-out', e.altKey); };
    document.addEventListener('keydown', altSync);
    document.addEventListener('keyup', altSync);
    window.addEventListener('blur', () => document.body.classList.remove('zoom-out'));
  }

  /* ======================================================================
   * 12. Text-case popover (only after a deliberate selection, never after Tab select-all)
   * ====================================================================== */
  let pop = null;

  function transformCase(s, mode) {
    if (mode === 'upper') return s.toUpperCase();
    if (mode === 'lower') return s.toLowerCase();
    if (mode === 'title') return s.toLowerCase().replace(/(^|[\s\-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    // trim: collapse runs of spaces per line, KEEP line breaks (disclaimer is multi-line)
    return s.split('\n').map((l) => l.replace(/[ \t\u00A0]+/g, ' ').trim()).join('\n');
  }

  function selectionTarget() {
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT' && a.type === 'text' && a.selectionStart !== a.selectionEnd) {
      if (a.closest && a.closest('.mt-find')) return null;
      // script.js select-all's the nationality input on every focus/click: that is not a deliberate selection.
      if (a.selectionStart === 0 && a.selectionEnd === a.value.length) return null;
      return { kind: 'input', el: a, rect: a.getBoundingClientRect() };
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    const ed = node && node.closest ? node.closest('[contenteditable="true"]') : null;
    if (!ed || !ed.contains(sel.focusNode)) return null;
    return { kind: 'ce', el: ed, text: sel.toString(), rect: sel.getRangeAt(0).getBoundingClientRect() };
  }

  function hidePop() { if (pop) pop.hidden = true; }

  function showPop() {
    if (!caseEnabled || tool !== 'select') { hidePop(); return; }
    const t = selectionTarget();
    if (!t) { hidePop(); return; }
    pop.hidden = false;
    const w = pop.offsetWidth, h = pop.offsetHeight;
    const left = Math.min(Math.max(8, t.rect.left + t.rect.width / 2 - w / 2), window.innerWidth - w - 8);
    let top = t.rect.top - h - 8;
    if (top < 8) top = t.rect.bottom + 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  function applyCase(mode) {
    const t = selectionTarget();
    if (!t) { hidePop(); return; }
    if (t.kind === 'input') {
      const el = t.el, s = el.selectionStart, e = el.selectionEnd;
      el.setRangeText(transformCase(el.value.slice(s, e), mode), s, e, 'select');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const out = transformCase(t.text, mode);
      // insertText goes through script.js beforeinput filters: fields that force CAPS keep their rules.
      if (out !== t.text) document.execCommand('insertText', false, out);
    }
    hidePop();
  }

  function initCasePopover() {
    pop = mk('div', 'mt-case-pop no-print');
    pop.setAttribute('role', 'toolbar');
    pop.setAttribute('aria-label', 'Text case');
    pop.hidden = true;
    [['upper', 'UPPER', 'Uppercase'], ['lower', 'lower', 'Lowercase'], ['title', 'Title', 'Title Case'], ['trim', 'Trim', 'Trim spaces']]
      .forEach(([mode, label, tip]) => {
        const b = mk('button', '', label);
        b.type = 'button';
        b.title = tip;
        b.addEventListener('click', () => applyCase(mode));
        pop.append(b);
      });
    pop.addEventListener('mousedown', (e) => e.preventDefault());     // keep the text selection alive
    document.body.appendChild(pop);

    document.addEventListener('mouseup', () => setTimeout(showPop, 0));
    document.addEventListener('keyup', (e) => { if (e.shiftKey && e.key.indexOf('Arrow') === 0) showPop(); });
    document.addEventListener('keydown', (e) => { if (e.key !== 'Shift') hidePop(); }, true);
    document.addEventListener('mousedown', (e) => { if (!pop.contains(e.target)) hidePop(); }, true);
    window.addEventListener('scroll', hidePop, true);
    window.addEventListener('resize', hidePop);
  }

  /* ======================================================================
   * 13. Global shortcuts (Alt access keys, Ctrl, F-keys, single-key tools)
   * ====================================================================== */
  function initShortcuts() {
    document.addEventListener('keydown', (e) => {
      const dialogOpen = !!q1('dialog[open]');
      const mod = e.ctrlKey || e.metaKey;
      const k = keyOf(e);

      // ---- Fail-safe: Escape ALWAYS leaves Hand / Zoom (no dialog / menu / Find panel handled it first) ----
      if (e.key === 'Escape' && tool !== 'select' && !dialogOpen && openIdx < 0 && !e.defaultPrevented) {
        e.preventDefault();
        setTool('select');
        return;
      }

      // ---- Alt + letter: menu access keys (File / Edit / View / Data Tools / Help) ----
      if (e.altKey && !mod && !e.shiftKey) {
        if (dialogOpen) return;
        const i = tops.findIndex((t) => t.host === 'bar' && t.access === k);
        if (i >= 0) {
          e.preventDefault();
          e.stopPropagation();
          toggleViaKeyboard(i);
        }
        return;
      }

      if (e.defaultPrevented && !mod) return;

      // ---- Function keys ----
      if (!mod && !e.altKey && /^F\d{1,2}$/.test(e.key)) {
        if (dialogOpen) return;
        if (e.key === 'F1') { e.preventDefault(); openShortcuts(); }
        else if (e.key === 'F4') { e.preventDefault(); setViewMode(e.shiftKey ? 'page' : 'width'); }
        else if (e.key === 'F5' && !e.shiftKey) { e.preventDefault(); recalcDates(); }
        return;
      }

      // ---- Ctrl / Cmd ----
      if (mod && !e.altKey) {
        if (dialogOpen) return;
        if (e.target.closest && e.target.closest('.mt-find')) return;   // native undo / select-all inside the Find fields
        const plain = !e.shiftKey;
        if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
        else if (k === 'y') { e.preventDefault(); redo(); }
        else if (k === 'n' && plain) { e.preventDefault(); newRecord(); }
        else if (k === 'o' && plain) { e.preventDefault(); importFile(); }
        else if (k === 's') { e.preventDefault(); exportAs(e.shiftKey ? 'jpg' : 'pdf'); }
        else if (k === 'f' && plain) { e.preventDefault(); openFind(); }
        else if (k === '1' && plain) { e.preventDefault(); setViewMode('actual'); }
        else if (k === '+') { e.preventDefault(); zoomIn(); }
        else if (k === '-') { e.preventDefault(); zoomOut(); }
        else if (k === 'p') { e.preventDefault(); printWithGuard(); }
        return;                                   // Ctrl+X/C/V/A etc: native
      }

      // ---- single-key tools (only when not typing) ----
      if (e.altKey || e.shiftKey || e.repeat || dialogOpen) return;
      if (isTyping(e.target)) return;
      if (e.target && e.target.closest && e.target.closest('.app-header')) return;

      switch (k) {
        case 'v': setTool('select'); break;
        case 'h': setTool('hand'); break;
        case 'z': setTool('zoom'); break;
        case 'a': toggleAudit(); break;
        case 'escape': setTool('select'); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  /* ======================================================================
   * 14. Init
   * ====================================================================== */
  // Publishes the REAL header height (it wraps on narrow screens, so a hard-coded 82px would be wrong)
  // as --header-h-total on <html>. css/menu-tools.css docks the palette at calc(var(--header-h-total) + 14px).
  function trackHeaderHeight() {
    const h = q1('.app-header');
    if (!h) return;
    const set = () => document.documentElement.style.setProperty('--header-h-total', h.offsetHeight + 'px');
    set();
    if (typeof ResizeObserver === 'function') new ResizeObserver(set).observe(h);
    window.addEventListener('resize', set);
  }

  function init() {
    trackHeaderHeight();
    buildMenubar();
    buildPropBar();
    initMenuKeys();
    buildPalette();
    initCanvasTools();
    initCasePopover();
    initShortcuts();
    initAudit();
    trackEditable();

    // capture phase: runs even if a handler stops propagation; debounced, so it records AFTER script.js normalised.
    document.addEventListener('input', scheduleRecord, true);
    document.addEventListener('focusout', scheduleRecord, true);

    requestAnimationFrame(record);             // baseline = state after script.js loaded the saved data
    requestAnimationFrame(refreshReady);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.CertMenuTools = {
    undo: undo, redo: redo, setTool: setTool,
    getTool: () => tool,
    toggleAudit: toggleAudit, toggleGrid: toggleGrid,
    nextRecord: nextRecord, prevRecord: prevRecord,
    openFind: openFind, openShortcuts: openShortcuts
  };
})();