/**
 * Certification - live editing + image upload.
 * Koi server nahi chahiye; sab kuch browser mein chalta hai.
 *
 * Editing model:
 *  - .val / .seg fields: editable (contenteditable="true") with per-field input rules (data-filter).
 *  - .badge headings, .blank cells, .seg-static parts: static.
 *  - [data-unlockable] (title, badges, Requested By, Purpose, disclaimer, ribbon):
 *    DEFAULT LOCKED; toolbar "Unlock layout" button toggles.
 *  - Photo/Logo: right-click menu (upload / remove / lock).
 *
 * Persistence:
 *  - Text fields -> localStorage (small, synchronous).
 *  - Photo/Logo  -> IndexedDB (localStorage's ~5MB cap cannot hold base64 images reliably).
 *  - Layout lock (toolbar) is NOT saved: page always opens locked.
 */
(function () {
  'use strict';

  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 5 MB cap
  const MAX_PHOTO_SOURCE_BYTES = 20 * 1024 * 1024;   // photo box: editor decodes + downscales, so phone shots are fine
  const MIN_FONT_PX = 6;                      // auto-fit lower limit
  // .combo containers are skipped on purpose: their <input> is fitted directly.
  // .badge included: 14pt DIN badges shrink automatically if a label is wider than its cell.
  const FIT_SELECTOR = '.val:not(.combo), .fit, .badge, [data-multiline], .combo-input';
  const $ = (id) => document.getElementById(id);
  const pad2 = (n) => String(n).padStart(2, '0');

  /* ----------------------------------------------------------
   * 0. Persistence
   *    Fields are saved by DOCUMENT ORDER. Bump STORE_VERSION whenever a persisted field
   *    is added/removed/reordered in index.html, so stale data is dropped, not mis-assigned.
   * ---------------------------------------------------------- */
  const STORE_KEY = 'cert-form';
  const STORE_VERSION = 1;
  const PERSIST_SELECTOR = '[data-unlockable], [data-filter], [data-sync], .combo-input';
  let saveTimer = null;
  let resetting = false;

  const persistNodes = () => Array.from(document.querySelectorAll(PERSIST_SELECTOR));
  // Multiline (disclaimer): Enter makes <div>/<br> in contenteditable, and textContent drops them
  // (that is why all lines collapsed into one after reload). Walk the DOM and write real "\n" instead.
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
  const readValue = (el) => {
    if (el.tagName === 'INPUT') return el.value;
    if (el.hasAttribute('data-multiline')) return multilineText(el);
    return el.textContent;
  };

  function saveNow() {
    if (resetting) return;
    try {
      const locks = {};
      document.querySelectorAll('.upload').forEach((b) => { locks[b.id] = b.classList.contains('is-locked'); });
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: STORE_VERSION,
        f: persistNodes().map(readValue),
        locks: locks
      }));
    } catch (_) { /* private mode / quota: app still works, just not persisted */ }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 250);
  }

  function loadSaved() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      const nodes = persistNodes();
      if (!data || data.v !== STORE_VERSION || !Array.isArray(data.f) || data.f.length !== nodes.length) return;
      nodes.forEach((el, i) => {
        const val = data.f[i];
        if (typeof val !== 'string') return;
        if (el.tagName === 'INPUT') el.value = val;
        else el.textContent = val;                // textContent only: saved text can never inject HTML
      });
      if (data.locks) {
        document.querySelectorAll('.upload').forEach((b) => { if (data.locks[b.id]) setLocked(b, true); });
      }
    } catch (_) { /* corrupt JSON: ignore, defaults stay */ }
  }

  // --- IndexedDB for images ---
  const DB_NAME = 'cert-db';
  const DB_STORE = 'images';

  function openDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function dbOp(mode, fn) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const req = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB error')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB aborted')); };   // quota-exceeded yahin aata hai
    }));
  }

  function notify(msg) { document.dispatchEvent(new CustomEvent('cert:toast', { detail: msg })); }

  const imgPut = (key, val) => dbOp('readwrite', (s) => s.put(val, key))
    .catch(() => { notify('Image could not be saved in this browser (storage full or blocked). It will be lost on reload.'); });
  const imgGet = (key) => dbOp('readonly', (s) => s.get(key)).catch(() => undefined);
  const imgDel = (key) => dbOp('readwrite', (s) => s.delete(key)).catch(() => {});


  /* ----------------------------------------------------------
   * 1. Photo / Logo: upload, remove, lock (right-click menu)
   * ---------------------------------------------------------- */
  const isLocked = (box) => box.classList.contains('is-locked');

  function setLocked(box, locked) {
    box.classList.toggle('is-locked', !!locked);
    box.setAttribute('aria-disabled', locked ? 'true' : 'false');
  }


  function setImage(box, frame, dataUrl, persist) {
    let img = frame.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = box.getAttribute('aria-label') || 'Uploaded image';
      frame.appendChild(img);
    }
    img.src = dataUrl;
    box.classList.remove('is-empty');
    if (persist !== false) imgPut(box.id, dataUrl);
  }

  function clearImage(box) {
    const img = box.querySelector('.frame img');
    if (img) {
      if (box.id === 'photo-box') img.removeAttribute('src');   // #photo-img is permanent markup: keep the node
      else img.remove();
    }
    box.classList.add('is-empty');
    imgDel(box.id);
  }

  // Opens the editor; the BAKED result is what gets stored (IndexedDB) and shown.
  // source: { file } for a new photo, omitted = edit the photo that is on the sheet.
  function editPhoto(box, source) {
    const ed = window.CertPhotoEditor;
    const frame = box.querySelector('.frame');
    const img = $('photo-img');
    if (!ed || !frame) return Promise.resolve(false);
    const src = source || { src: img && img.getAttribute('src') };
    if (!src.file && !src.src) return Promise.resolve(false);
    return ed.open(src).then((url) => {
      if (!url) return false;
      setImage(box, frame, url, true);
      return true;
    });
  }

  function initUploadBox(box) {
    const input = box.querySelector('input[type="file"]');
    const frame = box.querySelector('.frame');
    if (!input || !frame) return;
    const isPhoto = box.id === 'photo-box';

    // Photo with a picture -> editor (mobile has no hover / right-click). Empty photo and logo -> file picker.
    const activate = () => {
      if (isLocked(box)) return;
      if (isPhoto && !box.classList.contains('is-empty') && window.CertPhotoEditor) editPhoto(box);
      else input.click();
    };

    box.addEventListener('click', (e) => {
      if (e.target !== input) activate();   // input.click() bubbles: avoid the loop
    });

    box.addEventListener('keydown', (e) => {
      if (isLocked(box)) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !box.classList.contains('is-empty')) {
        e.preventDefault();
        clearImage(box);
      }
    });

    box.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showCtx(box, e.clientX, e.clientY);
    });

    // opts.raw = already-baked image (backup restore): skip the editor.
    function loadFile(file, opts) {
      if (!file || isLocked(box)) return;

      if (!file.type || !file.type.startsWith('image/')) {
        notify('Please choose an image file (JPG, PNG, WEBP or SVG).');
        return;
      }
      const viaEditor = isPhoto && !(opts && opts.raw) && !!window.CertPhotoEditor;
      const cap = viaEditor ? MAX_PHOTO_SOURCE_BYTES : MAX_IMAGE_BYTES;
      if (file.size > cap) {
        notify('Image must be smaller than ' + (cap / 1048576) + ' MB.');
        return;
      }
      if (viaEditor) { editPhoto(box, { file: file }); return; }

      const reader = new FileReader();
      reader.onload = () => setImage(box, frame, String(reader.result), true);
      reader.onerror = () => notify('The image could not be read. Try another file.');
      reader.readAsDataURL(file);
    }
    box._loadFile = loadFile;

    input.addEventListener('change', () => {
      loadFile(input.files && input.files[0]);
      input.value = '';
    });

    // Saved image wapas lao (already baked: editor bypass)
    imgGet(box.id).then((url) => { if (typeof url === 'string' && url) setImage(box, frame, url, false); });
  }

  // --- right-click menu ---
  const ctx = $('ctx-menu');

  function hideCtx() { if (ctx) ctx.hidden = true; }

  function ctxItem(label, disabled, action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = label;
    b.disabled = !!disabled;
    b.addEventListener('click', () => { hideCtx(); action(); });
    ctx.appendChild(b);
  }

  function showCtx(box, x, y) {
    if (!ctx) return;
    const locked = isLocked(box);
    const empty = box.classList.contains('is-empty');
    const label = box.getAttribute('data-label') || 'image';

    ctx.textContent = '';
    ctxItem((empty ? 'Upload ' : 'Replace ') + label + '\u2026', locked, () => box.querySelector('input[type="file"]').click());
    if (box.id === 'photo-box' && window.CertPhotoEditor) ctxItem('Edit photo\u2026', locked || empty, () => editPhoto(box));
    ctxItem('Remove ' + label, locked || empty, () => { clearImage(box); });
    ctx.appendChild(document.createElement('hr'));
    ctxItem((locked ? 'Unlock ' : 'Lock ') + label, false, () => { setLocked(box, !locked); scheduleSave(); });

    ctx.hidden = false;
    const w = ctx.offsetWidth, h = ctx.offsetHeight;
    ctx.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    ctx.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    const first = ctx.querySelector('button:not(:disabled)');
    if (first) first.focus();
  }

  function initCtxMenu() {
    if (!ctx) return;
    document.addEventListener('pointerdown', (e) => { if (!ctx.hidden && !ctx.contains(e.target)) hideCtx(); }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ctx.hidden) hideCtx(); });
    window.addEventListener('scroll', hideCtx, true);
    window.addEventListener('resize', hideCtx);
    window.addEventListener('blur', hideCtx);
  }

  /* Ctrl+V se image paste (screenshot ya copied image) */
  let hoveredBox = null;

  function initImagePaste() {
    document.querySelectorAll('.upload').forEach((box) => {
      box.addEventListener('mouseenter', () => { hoveredBox = box; });
      box.addEventListener('mouseleave', () => { if (hoveredBox === box) hoveredBox = null; });
    });

    document.addEventListener('paste', (e) => {
      if (e.target && e.target.closest && e.target.closest('[contenteditable="true"], input')) return;

      const items = (e.clipboardData && e.clipboardData.items) || [];
      let file = null;
      for (const it of items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) { file = it.getAsFile(); break; }
      }
      if (!file) return;

      const active = document.activeElement && document.activeElement.closest
        ? document.activeElement.closest('.upload') : null;
      const box = active || hoveredBox || $('photo-box');
      if (box && box._loadFile) {
        e.preventDefault();
        box._loadFile(file);            // locked box ignores it
      }
    });
  }

  /* ----------------------------------------------------------
   * 2. Field rules: allowed characters + max length
   *    Har rule teen jagah lagta hai: typing (beforeinput), paste, aur input-fallback
   *    (IME / drag-drop). Uppercase wale rules lowercase ko khud capital kar dete hain.
   * ---------------------------------------------------------- */
  const FILTERS = {
    'alnum-upper':  { re: /^[A-Z0-9]$/, map: (s) => s.toUpperCase() },
    'digits':       { re: /^[0-9]$/ },
    'dob':          { re: /^[0-9]$/ },
    'english-name': { re: /^[A-Z \-]$/, map: (s) => s.toUpperCase() },   // A-Z, space, hyphen
    'english-text': { re: /^[A-Za-z ]$/ },
    // Arabic letters + diacritics + tatweel + Arabic supplement/presentation forms + space.
    // Arabic-Indic digits (U+0660-0669, U+06F0-06F9) deliberately excluded.
    'arabic': { re: /^[\u0621-\u063F\u0640-\u065F\u0670\u066E-\u06D3\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF ]$/ }
  };

  const isEditable = (el) => el && el.closest && el.closest('[contenteditable="true"]');
  const isMultiline = (el) => el.hasAttribute('data-multiline');
  const isDobField = (el) => el.getAttribute('data-filter') === 'dob';

  function filterText(el, raw) {
    const f = FILTERS[el.getAttribute('data-filter')];
    if (!f) return String(raw);
    let out = String(raw).replace(/\u00A0/g, ' ');      // NBSP -> normal space (else typed space is deleted)
    if (f.map) out = f.map(out);
    return Array.from(out).filter((c) => f.re.test(c)).join('');
  }

  // Kitne characters aur likhne ki jagah hai (selection replace hone wala hissa gin kar).
  function room(el) {
    const max = parseInt(el.getAttribute('data-max'), 10);
    if (!max) return Infinity;
    const count = (s) => (isDobField(el) ? s.replace(/\D/g, '') : s).length;
    let selected = 0;
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode) && el.contains(sel.focusNode)) {
      selected = count(sel.toString());
    }
    return Math.max(0, max - count(el.textContent) + selected);
  }

  function caretToEnd(el) {
    if (document.activeElement !== el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Chrome/Firefox leave a dangling <br> when the last character is deleted. That defeats :empty,
  // so the ghost placeholder (style.css) would never come back. Placeholder cells only.
  function stripEmptyBr(el) {
    if (el.hasAttribute('data-placeholder') && el.firstChild && el.textContent === '') el.textContent = '';
  }

  // DOB: sirf digits; 24012000 -> 24/01/2000 (slash tab lagta hai jab agla digit aaye: backspace smooth rehta hai)
  function maskDob(digits) {
    let s = digits.slice(0, 2);
    if (digits.length > 2) s += '/' + digits.slice(2, 4);
    if (digits.length > 4) s += '/' + digits.slice(4, 8);
    return s;
  }

  // Pure function: yahi rules poore text par bhi lagte hain aur caret se pehle wale hisse par bhi
  function normalizeValue(el, raw) {
    if (isDobField(el)) return maskDob(raw.replace(/\D/g, '').slice(0, 8));
    let out = filterText(el, raw);
    if (el.hasAttribute('data-collapse')) out = out.replace(/^ +/, '').replace(/ {2,}/g, ' ');
    const max = parseInt(el.getAttribute('data-max'), 10);
    return max ? out.slice(0, max) : out;
  }

  // Caret ka offset el ke andar (logical order: RTL mein bhi theek). Selection ho ya bahar ho to -1
  function caretOffset(el) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed || !el.contains(sel.anchorNode)) return -1;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  }

  function setCaret(el, pos) {
    const node = el.firstChild;
    if (!node) return;
    const r = document.createRange();
    r.setStart(node, Math.min(pos, node.length));
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function normalizeField(el) {
    const before = el.textContent;
    const after = normalizeValue(el, before);
    if (after === before) return;
    const focused = document.activeElement === el;
    const c = focused ? caretOffset(el) : -1;
    el.textContent = after;
    if (!focused) return;
    if (c < 0) { caretToEnd(el); return; }
    // Caret se pehle wale hisse ko wahi rules se guzaro: uski length hi naya caret hai
    setCaret(el, normalizeValue(el, before.slice(0, c)).length);
  }


  // Paste hamesha plain text: Word/web ka HTML/fonts/colors certificate kharab kar dete hain.
  document.addEventListener('paste', (e) => {
    const target = isEditable(e.target);
    if (!target) return;
    e.preventDefault();

    let text = (e.clipboardData || window.clipboardData).getData('text/plain');
    if (target.hasAttribute('data-filter')) {
      text = filterText(target, text).slice(0, room(target));
    } else {
      if (!isMultiline(target)) text = text.replace(/\s*[\r\n]+\s*/g, ' ');
      if (target.hasAttribute('data-nospace')) text = text.replace(/\s+/g, '');
    }
    if (!text) return;

    if (!document.execCommand('insertText', false, text)) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    }
  });

  document.addEventListener('beforeinput', (e) => {
    const t = isEditable(e.target);
    if (!t) return;

       
    if (e.inputType.indexOf('format') === 0 || e.inputType === 'insertFromDrop') {
      e.preventDefault();
      return;
    }

    // data-nospace (passport): space block
    if (t.hasAttribute('data-nospace') && typeof e.data === 'string' && /\s/.test(e.data)) {
      e.preventDefault();
      return;
    }
    if (!t.hasAttribute('data-filter')) return;

    // Single-line + drag-drop: block
    if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak' ||
        e.inputType === 'insertFromDrop') {
      e.preventDefault();
      return;
    }

    if (e.inputType === 'insertText' && typeof e.data === 'string') {
      const allowed = filterText(t, e.data).slice(0, room(t));
      if (allowed === e.data) return;                 // valid: browser ko insert karne do
      e.preventDefault();
      if (allowed) document.execCommand('insertText', false, allowed);   // e.g. 'a' -> 'A'
    }
  });

  document.addEventListener('drop', (e) => {
    if (isEditable(e.target)) e.preventDefault();
  });

  // Single-line fields mein Enter new line/div bana deta hai aur layout tod deta hai: block karo.
  document.addEventListener('keydown', (e) => {
    const t = isEditable(e.target);
    if (!t) return;
    if (t.hasAttribute('data-nospace') && (e.key === ' ' || e.key === 'Spacebar')) { e.preventDefault(); return; }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyB' || e.code === 'KeyI' || e.code === 'KeyU')) {
      e.preventDefault();
      return;
    }

    // English disclaimer: 3 lines (2 Enter) ke baad chothi line banana block karo
    if (e.key === 'Enter' && t.classList.contains('en') && t.closest('.note')) {
      const lineBreaks = (t.innerText.match(/\n/g) || []).length;
      if (lineBreaks >= 2) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === 'Enter' && !isMultiline(t)) {
      e.preventDefault();
      t.blur();
    }
  });

  /* ----------------------------------------------------------
   * 3. Auto-fit: text cell se bahar jaye to font chota kar do
   *    - single-line: asli text width measure hoti hai (Range), dono taraf ka padding minus karke,
   *      pehle proportional jump, phir 0.25px steps. Font kabhi MIN_FONT_PX se neeche nahi.
   *    - multiline (disclaimer): text height vs box height.
   *    - <input> (nationality): scrollWidth.
   * ---------------------------------------------------------- */
  // Viewport scaler (js/viewport.js) shrinks .page with transform: scale(s).
  // Range.getBoundingClientRect() returns SCALED screen pixels, while clientWidth/clientHeight/
  // font-size are UNSCALED layout pixels. Dividing by the scale puts both in the same unit,
  // so auto-fit gives the same result at any zoom. Missing/invalid value => 1 (old behaviour).
  function certScale() {
    const s = window.__certScale;
    return s > 0 ? s : 1;
  }

  function contentWidth(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().width / certScale();
  }

  function contentHeight(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getBoundingClientRect().height / certScale();
  }

  function fitValue(el) {
    el.style.fontSize = '';                           // CSS ka default size wapas
    if (!el.clientWidth) return;                      // hidden element
    let size = parseFloat(getComputedStyle(el).fontSize);

    if (el.tagName === 'INPUT') {
      while (el.scrollWidth > el.clientWidth + 0.5 && size > MIN_FONT_PX) {
        size -= 0.25;
        el.style.fontSize = size + 'px';
      }
      return;
    }

    if (el.hasAttribute('data-multiline')) {
      while (contentHeight(el) > el.clientHeight + 0.5 && size > MIN_FONT_PX) {
        size -= 0.25;
        el.style.fontSize = size + 'px';
      }
      return;
    }

    const cs = getComputedStyle(el);
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const need = contentWidth(el);
    if (avail <= 0 || need <= avail) return;

    size = Math.max(MIN_FONT_PX, size * avail / need);
    el.style.fontSize = size + 'px';
    let guard = 0;
    while (contentWidth(el) > avail + 0.25 && size > MIN_FONT_PX && guard++ < 60) {
      size -= 0.25;
      el.style.fontSize = size + 'px';
    }
  }

  const fitAll = () => document.querySelectorAll(FIT_SELECTOR).forEach(fitValue);

  // Span ke andar edit ho raha ho to uska parent .val fit hota hai
  function refit(node) {
    const box = node && node.closest && node.closest(FIT_SELECTOR);
    if (box) fitValue(box);
  }

  // Arabic <-> English mirror: ek tier mein likho, doosra khud badal jaye.
  function propagate(el) {
    const key = el.getAttribute('data-sync');
    if (key) {
      document.querySelectorAll('[data-sync="' + key + '"]').forEach((other) => {
        if (other === el) return;
        other.textContent = el.textContent;
        refit(other);
      });
    }
    refit(el);
  }

  // data-exact: exactly N characters (ID: 9 editable + fixed '2' = 10)
  function checkExact(el, strict) {
    const len = el.textContent.length;
    const bad = len !== 0 && len !== parseInt(el.getAttribute('data-exact'), 10);
    if (bad && !strict) return;                       // typing ke dauran red sirf blur par
    const key = el.getAttribute('data-sync');
    const group = key ? document.querySelectorAll('[data-sync="' + key + '"]') : [el];
    group.forEach((n) => n.classList.toggle('invalid', bad));
  }

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el || !el.matches) return;

    stripEmptyBr(el);
    if (el.hasAttribute('data-filter')) normalizeField(el);
    if (el.hasAttribute('data-dob')) updateDob(false);
    if (el.hasAttribute('data-exact')) checkExact(el, false);
    propagate(el);
    scheduleSave();
  });

  // Field chhodte waqt: default restore, zero padding, trim, validation
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!el || !el.hasAttribute) return;

    if (el.hasAttribute('data-default') && !el.textContent.trim()) {
      el.textContent = el.getAttribute('data-default');
    }
    if (el.hasAttribute('data-pad')) {
      el.textContent = el.textContent.padStart(parseInt(el.getAttribute('data-pad'), 10), '0');
    }
    if (el.hasAttribute('data-collapse')) el.textContent = el.textContent.trim();
    if (el.hasAttribute('data-exact')) checkExact(el, true);
    if (el.hasAttribute('data-dob')) updateDob(true);
    if (el.hasAttribute('data-sync') || el.hasAttribute('data-pad') || el.hasAttribute('data-default')) propagate(el);
    scheduleSave();
  });

  /* ----------------------------------------------------------
   * 3b. Auto dates + Certification No. YYMM
   *     Issue = aaj ki date, Expiry = Issue + 29 din
   *     Arabic side = Hijri (Umm al-Qura) D/M/YYYY, English side = DD/MM/YYYY.
   *     Cert No. middle segment = YY + MM of today (user edit nahi kar sakta).
   * ---------------------------------------------------------- */
  const VALIDITY_DAYS = 29;
  const HIJRI_FMT = 'en-US-u-ca-islamic-umalqura-nu-latn';

  function fmtGregorian(d) {
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  // Umm al-Qura parts via native Intl. Returns {y, m, d} (numbers) or null.
  function hijriParts(date) {
    try {
      const parts = new Intl.DateTimeFormat(HIJRI_FMT,
        { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(date);
      const get = (t) => { const p = parts.find((x) => x.type === t); return p ? parseInt(p.value, 10) : NaN; };
      const y = get('year'), m = get('month'), d = get('day');
      if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
      return { y: y, m: m, d: d };
    } catch (_) {
      return null;                                  // browser bina Hijri calendar support ke
    }
  }

  function fmtHijri(d) {
    const h = hijriParts(d);
    return h ? h.d + '/' + h.m + '/' + h.y : fmtGregorian(d);
  }

    /* Issue date PIN hoti hai (alag key 'cert-issued': PERSIST_SELECTOR / STORE_VERSION ko haath nahi lagta).
     renderDates()  = pinned date dikhao (init, beforeprint, export: koi side effect nahi)
     pinToday()     = aaj ki date pin karo (F5, New Record, batch start) */
  const ISSUED_KEY = 'cert-issued';
  let issuedIso = null;                                   // 'YYYY-MM-DD' (local), init() mein set hota hai

  const isoOf = (d) => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  const isoToDate = (iso) => { const p = iso.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
  const validIso = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(isoToDate(s)) === s;

  function readIssued() {
    try { const v = JSON.parse(localStorage.getItem(ISSUED_KEY)); return v && validIso(v.d) ? v.d : null; }
    catch (_) { return null; }
  }
  function writeIssued(iso) {
    try { localStorage.setItem(ISSUED_KEY, JSON.stringify({ d: iso })); } catch (_) { /* storage unavailable */ }
  }

  function renderDates() {
    const issue = isoToDate(issuedIso || isoOf(new Date()));
    const expiry = new Date(issue.getFullYear(), issue.getMonth(), issue.getDate() + VALIDITY_DAYS);
    const map = {
      'issue-ar': fmtHijri(issue),   'issue-en': fmtGregorian(issue),
      'expiry-ar': fmtHijri(expiry), 'expiry-en': fmtGregorian(expiry),
      'cert-ym': pad2(issue.getFullYear() % 100) + pad2(issue.getMonth() + 1)   // cert number issue date ke saath chalta hai
    };
    document.querySelectorAll('[data-auto]').forEach((el) => {
      const v = map[el.getAttribute('data-auto')];
      if (v) el.textContent = v;
    });
  }

  function pinToday() {
    issuedIso = isoOf(new Date());
    writeIssued(issuedIso);
    renderDates();
  }

  /* ----------------------------------------------------------
   * 3c. Date of Birth: Gregorian DD/MM/YYYY -> Hijri YYYY/MM/DD
   *     Strict validation: 31/02/2000, future dates, year < 1900 reject.
   * ---------------------------------------------------------- */

  function gregorianToHijriDob(text) {
    const m = /^\s*(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})\s*$/.exec(text || '');
    if (!m) return null;
    const d = parseInt(m[1], 10), mo = parseInt(m[2], 10), y = parseInt(m[3], 10);
    if (y < 1900) return null;

    // Noon local time: DST/timezone shifts se din nahi badalta.
    const dt = new Date(y, mo - 1, d, 12, 0, 0);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    if (dt > new Date()) return null;

    const h = hijriParts(dt);
    if (!h) return null;
    return h.y + '/' + pad2(h.m) + '/' + pad2(h.d);
  }

  function updateDob(strict) {
    const en = $('dob-en');
    const ar = $('dob-ar');
    if (!en || !ar) return;
    const text = en.textContent;
    const hijri = gregorianToHijriDob(text);
    const digits = text.replace(/\D/g, '').length;

    ar.textContent = hijri || '';
    // typing ke dauran red sirf complete-lekin-ghalat date par; blur par adhoori date par bhi
    en.classList.toggle('invalid', !hijri && (strict ? digits > 0 : digits === 8));
    refit(ar);
  }

  /* ----------------------------------------------------------
   * 3d. Nationality: do dropdowns (English + Arabic), ek doosre ko fill karte hain.
   *     Naya country add karna ho to sirf NATIONALITIES mein ek line: [English, Arabic, code].
   *     Pehle COMMON_COUNT entries "Common" group mein dikhti hain, baqi alphabetical.
   * ---------------------------------------------------------- */
  const NATIONALITIES = [
    ['Pakistan',     'باكستان',  'PK'],
    ['India',        'الهند',    'IN'],
    ['Bangladesh',   'بنجلاديش', 'BD'],
    ['Qatar',        'قطر',      'QA'],
    ['Yemen',        'اليمن',    'YE'],
    ['Saudi Arabia', 'السعودية', 'SA'],
    ['Egypt',        'مصر',      'EG'],
    ['Philippines',  'الفلبين',  'PH'],
    ['Nepal',        'نيبال',    'NP'],
    ['Sri Lanka',    'سريلانكا', 'LK'],
    // --- more (alphabetical) ---
    ['Afghanistan',  'أفغانستان', 'AF'],
    ['Algeria',      'الجزائر',  'DZ'],
    ['Bahrain',      'البحرين',  'BH'],
    ['Burkina Faso', 'بوركينا فاسو', 'BF'],
    ['Cambodia',     'كمبوديا',  'KH'],
    ['Cameroon',     'الكاميرون', 'CM'],
    ['Chad',         'تشاد',     'TD'],
    ['China',        'الصين',    'CN'],
    ['Comoros',      'جزر القمر', 'KM'],
    ['DR Congo',     'الكونغو الديمقراطية', 'CD'],
    ['Djibouti',     'جيبوتي',   'DJ'],
    ['Eritrea',      'إريتريا',  'ER'],
    ['Ethiopia',     'إثيوبيا',  'ET'],
    ['France',       'فرنسا',    'FR'],
    ['Gambia',       'غامبيا',   'GM'],
    ['Germany',      'ألمانيا',  'DE'],
    ['Ghana',        'غانا',     'GH'],
    ['Guinea',       'غينيا',    'GN'],
    ['Indonesia',    'إندونيسيا', 'ID'],
    ['Iran',         'إيران',    'IR'],
    ['Iraq',         'العراق',   'IQ'],
    ['Ivory Coast',  'ساحل العاج', 'CI'],
    ['Jordan',       'الأردن',   'JO'],
    ['Kazakhstan',   'كازاخستان', 'KZ'],
    ['Kenya',        'كينيا',    'KE'],
    ['Kuwait',       'الكويت',   'KW'],
    ['Kyrgyzstan',   'قيرغيزستان', 'KG'],
    ['Lebanon',      'لبنان',    'LB'],
    ['Libya',        'ليبيا',    'LY'],
    ['Malaysia',     'ماليزيا',  'MY'],
    ['Maldives',     'جزر المالديف', 'MV'],
    ['Mali',         'مالي',     'ML'],
    ['Mauritania',   'موريتانيا', 'MR'],
    ['Morocco',      'المغرب',   'MA'],
    ['Myanmar',      'ميانمار',  'MM'],
    ['Niger',        'النيجر',   'NE'],
    ['Nigeria',      'نيجيريا',  'NG'],
    ['Oman',         'عمان',     'OM'],
    ['Palestine',    'فلسطين',   'PS'],
    ['Russia',       'روسيا',    'RU'],
    ['Senegal',      'السنغال',  'SN'],
    ['Sierra Leone', 'سيراليون', 'SL'],
    ['Somalia',      'الصومال',  'SO'],
    ['South Africa', 'جنوب أفريقيا', 'ZA'],
    ['Sudan',        'السودان',  'SD'],
    ['Syria',        'سوريا',    'SY'],
    ['Tanzania',     'تنزانيا',  'TZ'],
    ['Thailand',     'تايلاند',  'TH'],
    ['Tunisia',      'تونس',     'TN'],
    ['Turkey',       'تركيا',    'TR'],
    ['Uganda',       'أوغندا',   'UG'],
    ['United Arab Emirates', 'الإمارات', 'AE'],
    ['United Kingdom', 'بريطانيا', 'GB'],
    ['United States', 'أمريكا',  'US'],
    ['Uzbekistan',   'أوزبكستان', 'UZ'],
    ['Vietnam',      'فيتنام',   'VN']
  
  ];
  const COMMON_COUNT = 10;

  const normEn = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
  // Arabic matching: harakat/tatweel hatao; alef/yaa/taa-marbuta ke variants barabar
  const normAr = (s) => String(s)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .trim().replace(/\s+/g, ' ');

  const BY_EN = {};
  const BY_AR = {};
  NATIONALITIES.forEach((n) => { BY_EN[normEn(n[0])] = n; BY_AR[normAr(n[1])] = n; });
  let kbFocus = false;        // true jab focus Tab navigation se aaya: combo list auto-open na ho
  let lastAuto = '';          // aakhri auto-filled Arabic naam (stale hone par clear karne ke liye)
  let enCombo = null;
  let arCombo = null;
  let openCombo = null;

  function syncNationality(from) {
    const en = $('nat-en');
    const ar = $('nat-ar');
    if (!en || !ar) return;

    if (from === 'ar') {
      const hit = BY_AR[normAr(ar.value)];
      if (hit) {
        en.value = hit[0];
        lastAuto = hit[1];
        if (enCombo) enCombo.setCommitted(en.value);
      }
    } else {
      const hit = BY_EN[normEn(en.value)];
      if (hit) {
        ar.value = hit[1];
        lastAuto = hit[1];
      } else if (ar.value === lastAuto) {
        ar.value = '';                                // purana auto-translation stale ho gaya
        lastAuto = '';
      }
      if (arCombo) arCombo.setCommitted(ar.value);
    }
    fitValue(en);
    fitValue(ar);
    scheduleSave();
  }

  function appendHighlighted(node, text, q) {
    const i = q ? text.toLowerCase().indexOf(q) : -1;
    if (i < 0) { node.textContent = text; return; }
    node.append(document.createTextNode(text.slice(0, i)));
    const mark = document.createElement('mark');
    mark.textContent = text.slice(i, i + q.length);
    node.append(mark, document.createTextNode(text.slice(i + q.length)));
  }

  // cfg: { input, combo, lang: 'en'|'ar', clean(value), onSync(), onChoose(entry) }
  function makeCombo(cfg) {
    const input = cfg.input;
    const combo = cfg.combo;
    const btn = combo.querySelector('.combo-btn');
    const isAr = cfg.lang === 'ar';
    const primary = isAr ? 1 : 0;
    const norm = isAr ? normAr : normEn;

    const menu = document.createElement('ul');
    menu.className = 'combo-menu no-print';
    menu.id = input.id + '-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', isAr ? 'الجنسية' : 'Nationality');
    menu.dir = isAr ? 'rtl' : 'ltr';
    input.setAttribute('aria-controls', menu.id);
    document.body.appendChild(menu);

    let items = [];
    let active = -1;
    let typed = false;          // user ne type kiya? to list filter hogi, warna poori list
    let isOpen = false;
    let committed = input.value;

    function setActive(i) {
      items.forEach((li, n) => li.classList.toggle('active', n === i));
      active = i;
      if (items[i]) {
        input.setAttribute('aria-activedescendant', items[i].id);
        items[i].scrollIntoView({ block: 'nearest' });
      } else {
        input.removeAttribute('aria-activedescendant');
      }
    }

    function groupLabel(text) {
      const li = document.createElement('li');
      li.className = 'combo-group';
      li.setAttribute('role', 'presentation');
      li.textContent = text;
      menu.appendChild(li);
    }

    function render() {
      const q = typed ? norm(input.value) : '';
      menu.textContent = '';
      items = [];

      const list = [];
      NATIONALITIES.forEach((n, i) => { if (!q || norm(n[primary]).includes(q)) list.push({ n: n, i: i }); });

      if (!list.length) {
        const li = document.createElement('li');
        li.className = 'combo-empty';
        li.textContent = isAr
          ? '\u0644\u0627 \u062A\u0648\u062C\u062F \u0646\u062A\u0627\u0626\u062C \u2014 Enter \u0644\u0627\u0633\u062A\u062E\u062F\u0627\u0645 \u0627\u0644\u0646\u0635'
          : 'No match \u2014 press Enter to use \u201C' + input.value.trim() + '\u201D';
        menu.appendChild(li);
        setActive(-1);
        return;
      }

      const current = norm(input.value);
      let group = -1;
      list.forEach((row) => {
        if (!q) {
          const g = row.i < COMMON_COUNT ? 0 : 1;
          if (g !== group) {
            group = g;
            groupLabel(isAr ? (g === 0 ? 'الأكثر شيوعاً' : 'جميع الدول') : (g === 0 ? 'Common' : 'All countries'));
          }
        }
        const n = row.n;
        const li = document.createElement('li');
        li.className = 'combo-opt' + (norm(n[primary]) === current ? ' selected' : '');
        li.id = input.id + '-opt-' + row.i;
        li.setAttribute('role', 'option');
        li.dataset.idx = String(row.i);

        const code = document.createElement('span');
        code.className = 'code';
        code.textContent = n[2];

        const pri = document.createElement('span');
        pri.className = 'pri' + (isAr ? ' ar' : '');
        if (isAr) { pri.lang = 'ar'; pri.textContent = n[1]; } else { appendHighlighted(pri, n[0], q); }

        const sec = document.createElement('span');
        sec.className = 'sec' + (isAr ? '' : ' ar');
        if (isAr) { sec.textContent = n[0]; } else { sec.lang = 'ar'; sec.textContent = n[1]; }

        li.append(code, pri, sec);
        menu.appendChild(li);
        items.push(li);
      });

      const sel = items.findIndex((li) => li.classList.contains('selected'));
      setActive(typed ? 0 : (sel >= 0 ? sel : 0));
    }

    function position() {
      const r = combo.getBoundingClientRect();
      menu.style.minWidth = Math.max(r.width, 240) + 'px';
      menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + 'px';
      const h = menu.offsetHeight;
      const below = window.innerHeight - r.bottom;
      const dropUp = below < h + 12 && r.top > h + 12;
      menu.classList.toggle('dropup', dropUp);
      menu.style.top = (dropUp ? r.top - h - 6 : r.bottom + 6) + 'px';
    }

    function close() {
      menu.classList.remove('open');
      combo.classList.remove('is-open');
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      isOpen = false;
      if (openCombo === api) openCombo = null;
    }

    function open() {
      if (openCombo && openCombo !== api) openCombo.close();   // ek waqt mein ek hi menu
      render();
      position();
      menu.classList.add('open');
      combo.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true');
      isOpen = true;
      openCombo = api;
    }

    function choose(entry) {
      cfg.onChoose(entry);
      typed = false;
      close();
      input.blur();
    }

    const api = {
      close: close,
      setCommitted: (v) => { committed = v; }
    };

    // Focus par poora text select: seedha type karke replace; list poori dikhti hai
    input.addEventListener('focus', () => {
      typed = false;
      input.select();
      input._selectOnUp = !kbFocus;
      if (!kbFocus) open();       // Tab se aaye to band; click / ArrowDown / typing se khulti hai
    });
    input.addEventListener('mouseup', (e) => {
      if (input._selectOnUp) { e.preventDefault(); input._selectOnUp = false; }
    });
    input.addEventListener('click', () => { if (!isOpen) open(); });

    input.addEventListener('input', () => {
      const clean = cfg.clean(input.value);
      if (clean !== input.value) input.value = clean;
      typed = true;
      cfg.onSync();
      open();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isOpen) open(); else if (items.length) setActive((active + 1) % items.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (!isOpen) open(); else if (items.length) setActive((active - 1 + items.length) % items.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (isOpen && items[active]) choose(NATIONALITIES[parseInt(items[active].dataset.idx, 10)]);
        else { close(); input.blur(); }               // custom text commit
      } else if (e.key === 'Escape') {
        if (isOpen) { e.preventDefault(); close(); }
      } else if (e.key === 'Tab') {
        close();
      }
    });

    input.addEventListener('blur', () => {
      close();
      input.value = input.value.trim().replace(/\s+/g, ' ');
      if (!input.value) input.value = committed;     // khali chhoda to purani value wapas
      committed = input.value;
      typed = false;
      cfg.onSync();
    });

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();                              // input ka focus na toote
      if (isOpen) close();
      else { typed = false; if (document.activeElement !== input) input.focus(); else open(); }
    });

    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.addEventListener('click', (e) => {
      const li = e.target.closest('.combo-opt');
      if (li) choose(NATIONALITIES[parseInt(li.dataset.idx, 10)]);
    });
    menu.addEventListener('mouseover', (e) => {
      const li = e.target.closest('.combo-opt');
      if (li) setActive(items.indexOf(li));
    });

    window.addEventListener('resize', () => { if (isOpen) position(); });
    window.addEventListener('scroll', () => { if (isOpen) position(); }, true);

    return api;
  }

  function initNationality() {
    const en = $('nat-en');
    const ar = $('nat-ar');
    const enBox = $('nat-en-combo');
    const arBox = $('nat-ar-combo');
    if (!en || !ar || !enBox || !arBox) return;

    const arabicRe = FILTERS.arabic.re;
    const cleanEn = (v) => v.replace(/[^A-Za-z ]/g, '').replace(/^ +/, '').replace(/ {2,}/g, ' ');
    const cleanAr = (v) => Array.from(v).filter((c) => arabicRe.test(c)).join('').replace(/^ +/, '').replace(/ {2,}/g, ' ');

    // Dono combos mein se kisi se bhi select karo: dono tier bharte hain
    const onChoose = (entry) => {
      en.value = entry[0];
      ar.value = entry[1];
      lastAuto = entry[1];
      enCombo.setCommitted(entry[0]);
      arCombo.setCommitted(entry[1]);
      fitValue(en);
      fitValue(ar);
      scheduleSave();
    };

    enCombo = makeCombo({ input: en, combo: enBox, lang: 'en', clean: cleanEn, onSync: () => syncNationality('en'), onChoose: onChoose });
    arCombo = makeCombo({ input: ar, combo: arBox, lang: 'ar', clean: cleanAr, onSync: () => syncNationality('ar'), onChoose: onChoose });

    syncNationality('en');
  }

  /* ----------------------------------------------------------
   * 4. Lock / unlock: title, badges, Requested By, Purpose, disclaimer, ribbon
   *    DEFAULT = LOCKED (aria-pressed="false")
   * ---------------------------------------------------------- */
  function applyLock(unlock) {
    const btn = $('lock-btn');
    document.querySelectorAll('[data-unlockable]').forEach((el) => {
      if (unlock) el.setAttribute('contenteditable', 'true');
      else el.removeAttribute('contenteditable');
    });
    if (!unlock && document.activeElement && document.activeElement.blur) document.activeElement.blur();
    if (btn) {
      btn.setAttribute('aria-pressed', String(unlock));
      btn.textContent = unlock ? 'Lock layout' : 'Unlock layout';
    }
  }

  function initLockToggle() {
    const btn = $('lock-btn');
    if (!btn) return;
    applyLock(btn.getAttribute('aria-pressed') === 'true');
    btn.addEventListener('click', () => applyLock(btn.getAttribute('aria-pressed') !== 'true'));
  }

  
/* ----------------------------------------------------------
   * Floating Smart Tooltip Controller (0.5s Delay + Hide on Click)
   * ---------------------------------------------------------- */
  function initSmartTooltips() {
    const tip = document.createElement('div');
    tip.className = 'ui-tooltip no-print';
    document.body.appendChild(tip);

    let hoverTimer = null;

    function getHint(el) {
      if (el.closest('#photo-box')) return el.closest('#photo-box').classList.contains('is-empty') ? 'Click to upload photo' : 'Click to edit photo';
      if (el.closest('#logo-box')) return 'Click to upload logo';
      if (el.closest('.name-en')) return 'Full Name (English)';
      if (el.closest('.name-ar')) return 'الاسم بالعربية';
      if (el.closest('[data-sync="id"]')) return 'National ID (9 digits)';
      if (el.closest('[data-sync="passport"]')) return 'Passport Number';
      if (el.closest('#dob-en')) return 'Birth Date (DD/MM/YYYY)';
      if (el.closest('#nat-en') || el.closest('#nat-ar')) return 'Select / Type Nationality';
      if (el.closest('[data-sync="cert-prefix"]')) return 'Cert Prefix';
      if (el.closest('[data-sync="cert-seq"]')) return 'Cert Sequence';
      if (el.closest('.title .en')) return 'Certificate Title (EN)';
      if (el.closest('.title .ar')) return 'عنوان الشهادة (AR)';
      if (el.closest('.note .en')) return 'English Disclaimer (3 lines)';
      if (el.closest('.note .ar')) return 'إخلاء المسؤولية بالعربية';
      return null;
    }

    function hideTip() {
      clearTimeout(hoverTimer);
      tip.classList.remove('is-visible');
    }

    document.addEventListener('mouseover', (e) => {
      const target = e.target.closest('[contenteditable="true"], .upload, .combo-input');
      if (!target) {
        hideTip();
        return;
      }

      const hint = getHint(target);
      if (!hint) {
        hideTip();
        return;
      }

      // 500ms hover delay
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        tip.textContent = hint;
        const rect = target.getBoundingClientRect();
        tip.style.left = rect.left + rect.width / 2 + 'px';
        tip.style.top = rect.top + 'px';
        tip.classList.add('is-visible');
      }, 500);
    });

    document.addEventListener('mouseout', (e) => {
      const to = e.relatedTarget;
      if (!to || !to.closest('[contenteditable="true"], .upload, .combo-input')) {
        hideTip();
      }
    });

    // Click karte hi ya focus aate hi tooltip foran remove ho jaye
    document.addEventListener('mousedown', hideTip);
    document.addEventListener('click', hideTip);
    window.addEventListener('scroll', hideTip, true);
  }

  /* ----------------------------------------------------------
   * 5. Excel / Word Style Tab Navigation + Auto Select-All
   * ---------------------------------------------------------- */
  function selectAllContent(el) {
    if (!el) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.select();
      return;
    }
    if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }
  }

    function initExcelTabNavigation() {
    const SELECTOR = '[contenteditable="true"], .combo-input:not([disabled])';

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;

      const active = document.activeElement;
      const current = active && active.closest(SELECTOR);
      if (!current) return;

      // Live query + AR/EN mirror (data-sync) duplicates skip: har group ka sirf pehla (Arabic tier) cell
      const seen = new Set();
      const fields = Array.from(document.querySelectorAll(SELECTOR)).filter((el) => {
        if (!(el.offsetWidth > 0 && el.offsetHeight > 0) || el.closest('[aria-hidden="true"]')) return false;
        const key = el.getAttribute('data-sync');
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fields.length <= 1) return;

      // Agar user mirror (English tier) mein hai, to uska representative dhoondo
      const key = current.getAttribute('data-sync');
      const anchor = key ? fields.find((f) => f.getAttribute('data-sync') === key) : current;
      const currentIndex = fields.indexOf(anchor);
      if (currentIndex === -1) return;

      e.preventDefault();

      const step = e.shiftKey ? -1 : 1;
      const nextEl = fields[(currentIndex + step + fields.length) % fields.length];

      kbFocus = true;
      nextEl.focus();
      kbFocus = false;
      requestAnimationFrame(() => selectAllContent(nextEl));
    });
  }
  
  /* ----------------------------------------------------------
   * 6. Init + print helper
   * ---------------------------------------------------------- */
  function hardenEditors() {
    persistNodes().forEach((el) => {
      el.setAttribute('spellcheck', 'false');
      el.setAttribute('autocorrect', 'off');
      el.setAttribute('autocapitalize', 'off');
      el.setAttribute('data-gramm', 'false');
      el.setAttribute('data-gramm_editor', 'false');
      el.setAttribute('data-enable-grammarly', 'false');
    });
  }

  function init() {
    document.querySelectorAll('.upload').forEach(initUploadBox);
    initImagePaste();
    initCtxMenu();
    hardenEditors();
    // Disclaimer uses white-space: pre-wrap, so HTML indentation must not become visible lines
    document.querySelectorAll('[data-multiline]').forEach((el) => { el.textContent = el.textContent.trim().replace(/\s*\n\s*/g, ' '); });
    loadSaved();                    // text + locks: nationality/checks se PEHLE
    initLockToggle();
    initNationality();
    initSmartTooltips();
    initExcelTabNavigation(); // <-- Yeh line add karein
    

    document.querySelectorAll('[data-exact]').forEach((el) => checkExact(el, true));

    window.addEventListener('beforeprint', () => {
      // blur pehle: focusout rules (padding/default restore) aur nationality commit chal jaate hain
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      renderDates();
      updateDob(true);
      syncNationality('en');
      fitAll();
      saveNow();
    });
    
    // Desktop Menu tools ke liye clean API expose karein
        window.CertApp = {
      // Pinned date dobara dikhata hai. export-tools.js ka prepare() isi ko chalata hai: date badalti nahi.
      refreshDates: function () {
        renderDates();
        updateDob(true);
        syncNationality('en');
        fitAll();
        saveNow();
      },
      // Aaj ki date pin karo (F5, New Record, batch start)
      pinToday: function () {
        pinToday();
        updateDob(true);
        syncNationality('en');
        fitAll();
        saveNow();
      },
      getIssued: function () { return issuedIso; },
      setIssued: function (iso) {                       // backup restore
        if (!validIso(iso)) return false;
        issuedIso = iso;
        writeIssued(iso);
        renderDates();
        saveNow();
        return true;
      },
      issueIsStale: function () { return !!issuedIso && issuedIso !== isoOf(new Date()); },
      // menu-tools.js ka batch validator yahi use karta hai: Arabic ki definition sirf FILTERS.arabic mein
      isArabicText: function (s) {
        s = String(s);
        return s.length > 0 && Array.from(s).every((c) => FILTERS.arabic.re.test(c));
      },
      // Batch navigation ke liye: photo ka src nikalna / set karna
      getPhoto: function () {
        const box = $('photo-box');
        const img = $('photo-img');
        if (!box || !img || box.classList.contains('is-empty')) return null;
        return img.getAttribute('src') || null;
      },
      // Lock ko BYPASS karta hai: batch mein record badalne par photo hamesha usi record ki honi chahiye
      setPhoto: function (dataUrl) {
        const box = $('photo-box');
        const frame = $('photo-frame');
        if (!box || !frame) return false;
        if (typeof dataUrl === 'string' && /^data:image\//i.test(dataUrl)) {
          setImage(box, frame, dataUrl, true);      // IDB mein bhi jata hai: reload par wahi photo aayegi jo screen par hai
        } else if (!box.classList.contains('is-empty')) {
          clearImage(box);
        }
        return true;
      },

      fitAll: fitAll,
      save: saveNow,
      clearPhoto: function () {
        const box = $('photo-box');
        if (!box || isLocked(box) || box.classList.contains('is-empty')) return false;
        clearImage(box);
        return true;
      }
    };
    

    window.addEventListener('pagehide', saveNow);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });

    issuedIso = readIssued();
    if (!issuedIso) { issuedIso = isoOf(new Date()); writeIssued(issuedIso); }   // pehli load: aaj ki date pin
    renderDates();
    updateDob(false);
    fitAll();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();