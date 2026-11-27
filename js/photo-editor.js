/**
 * photo-editor.js - Modal photo editor. Bakes crop / rotate / flip into pixels.
 *
 * API: window.CertPhotoEditor.open({ file: File } | { src: dataUrl }) -> Promise<string|null>
 *      resolves with a baked JPEG data URL (700 x 875, 4:5), or null on cancel.
 *
 * MODEL (all in OUTPUT units, i.e. the frame is OUT_W x OUT_H):
 *   point -> scale(fx*s, fy*s) -> rotate(theta) -> translate(tx, ty) -> frame centre
 *   s = minScale(theta) * z     z in [1, ZMAX]; minScale = smallest scale that still COVERS the frame.
 *   Cover clamp: in image-local space |u| <= half-size - m, where
 *     mx = W/2|cos| + H/2|sin|,  my = W/2|sin| + H/2|cos|   (frame half-extent seen from the image axes)
 *   Preview and bake use the SAME paint() routine, so what you see is what is saved.
 *   Flips are screen-space: they negate tx/ty and the angle, so the sliders stay intuitive.
 */
(function () {
  'use strict';

  const OUT_W = 700;                 // 29.60 : 37.00 mm == 4 : 5. 700 px = ~600 DPI (2x headroom over 300)
  const OUT_H = 875;
  const JPEG_Q = 0.92;
  const ZMAX = 6;
  const SRC_MAX = 2400;              // working bitmap: longest side
  const MAX_BYTES = 20 * 1024 * 1024;
  const NUDGE_DEG = 2;
  const LOW_RES = 1.4;               // drawn px per source px above this = soft result
  const STAGE_BG = '#0d1114';

  const PATHS = {
    close: 'M6 6l12 12|M18 6L6 18',
    crop: 'M6 2v14a2 2 0 0 0 2 2h14|M18 22V8a2 2 0 0 0-2-2H2',
    rotL: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5',
    rotR: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8|M21 3v5h-5',
    flipH: 'M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3|M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3|M12 2v2|M12 8v2|M12 14v2|M12 20v2',
    flipV: 'M21 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v3|M21 16v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3|M2 12h2|M8 12h2|M14 12h2|M20 12h2',
    minus: 'M5 12h14',
    plus: 'M12 5v14|M5 12h14',
    check: 'M5 13l4 4L19 7',
    upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4|M17 8l-5-5-5 5|M12 3v12',
    reset: 'M9 14L4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11',
    alert: 'M12 9v4|M12 17h.01|M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 3-3 4 4|M9 9h.01'
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function icon(name) {
    const s = mk('span', 'pe-ico');
    s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      PATHS[name].split('|').map((d) => '<path d="' + d + '"/>').join('') + '</svg>';   // static literals only
    return s;
  }

  function btn(cls, label, iconName, title) {
    const b = mk('button', cls);
    b.type = 'button';
    if (iconName) b.append(icon(iconName));
    if (label) b.append(mk('span', '', label));
    if (title) { b.title = title; if (!label) b.setAttribute('aria-label', title); }
    return b;
  }

  /* ------------------------------------------------------------------ state */
  const ui = {};
  let dlg = null, g2 = null;
  let vw = 0, vh = 0, dpr = 1, cropX = 0, cropY = 0, cropW = 0, cropH = 0, k = 1;
  let src = null, iw = 0, ih = 0, srcInfo = null;
  let session = null, loadToken = 0, isBusy = false;
  let raf = 0, showGrid = false, gridTimer = 0, noteTimer = 0;
  const S = { z: 1, tx: 0, ty: 0, quarter: 0, fine: 0, fx: 1, fy: 1 };
  const ptrs = new Map();
  let last = null, rect = null;

  function resetState() {
    S.z = 1; S.tx = 0; S.ty = 0; S.quarter = 0; S.fine = 0; S.fx = 1; S.fy = 1;
  }

  /* --------------------------------------------------------------- geometry */
  const angle = () => (S.quarter * 90 + S.fine) * Math.PI / 180;

  function limits() {
    const th = angle();
    const c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    const mx = OUT_W / 2 * c + OUT_H / 2 * s;
    const my = OUT_W / 2 * s + OUT_H / 2 * c;
    const min = Math.max(2 * mx / iw, 2 * my / ih) * 1.002;     // 0.2% overscan: no 1px gap from rounding
    return { mx: mx, my: my, min: min };
  }

  function constrain() {
    if (!src) return;
    S.z = clamp(S.z, 1, ZMAX);
    const L = limits();
    const s = L.min * S.z;
    const a = Math.max(0, iw * s / 2 - L.mx);
    const b = Math.max(0, ih * s / 2 - L.my);
    const th = angle(), cs = Math.cos(th), sn = Math.sin(th);
    let ux = S.tx * cs + S.ty * sn;                 // R(-theta) * t : translation in image-local axes
    let uy = -S.tx * sn + S.ty * cs;
    ux = clamp(ux, -a, a);
    uy = clamp(uy, -b, b);
    S.tx = ux * cs - uy * sn;                       // back to frame axes
    S.ty = ux * sn + uy * cs;
  }

  // Origin must already be at the frame centre, in OUTPUT units.
  function paint(g) {
    const s = limits().min * S.z;
    g.save();
    g.translate(S.tx, S.ty);
    g.rotate(angle());
    g.scale(S.fx * s, S.fy * s);
    g.drawImage(src, -iw / 2, -ih / 2);
    g.restore();
  }

  /* ---------------------------------------------------------------- drawing */
  function schedule() { if (!raf) raf = requestAnimationFrame(draw); }

  function draw() {
    raf = 0;
    if (!g2 || !vw) return;
    const c = g2;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = STAGE_BG;
    c.fillRect(0, 0, vw, vh);
    if (!src) return;

    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.save();
    c.translate(vw / 2, vh / 2);
    c.scale(k, k);
    paint(c);
    c.restore();

    c.fillStyle = 'rgba(8,11,13,.64)';                       // dim everything outside the frame
    c.beginPath();
    c.rect(0, 0, vw, vh);
    c.rect(cropX, cropY, cropW, cropH);
    c.fill('evenodd');

    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255,255,255,.9)';
    c.strokeRect(cropX, cropY, cropW, cropH);

    if (showGrid) {                                          // rule of thirds, only while adjusting
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255,255,255,.42)';
      c.beginPath();
      for (let i = 1; i < 3; i++) {
        c.moveTo(cropX + cropW * i / 3, cropY); c.lineTo(cropX + cropW * i / 3, cropY + cropH);
        c.moveTo(cropX, cropY + cropH * i / 3); c.lineTo(cropX + cropW, cropY + cropH * i / 3);
      }
      c.stroke();
    }

    const L = Math.min(22, cropW / 5), x0 = cropX, y0 = cropY, x1 = cropX + cropW, y1 = cropY + cropH;
    c.lineWidth = 3;
    c.lineCap = 'square';
    c.strokeStyle = '#fff';
    c.beginPath();
    c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0);
    c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
    c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1);
    c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
    c.stroke();
  }

  function layout() {
    if (!dlg || !dlg.open) return;
    vw = ui.stage.clientWidth;               // clientWidth, NOT getBoundingClientRect: the open animation scales the dialog
    vh = ui.stage.clientHeight;
    if (vw < 40 || vh < 40) return;
    dpr = window.devicePixelRatio || 1;
    ui.canvas.width = Math.round(vw * dpr);
    ui.canvas.height = Math.round(vh * dpr);
    const pad = vw < 520 ? 16 : 28;
    let ch = vh - pad * 2, cw = ch * OUT_W / OUT_H;
    if (cw > vw - pad * 2) { cw = vw - pad * 2; ch = cw * OUT_H / OUT_W; }
    cropW = cw; cropH = ch;
    k = cw / OUT_W;
    cropX = (vw - cw) / 2;
    cropY = (vh - ch) / 2;
    schedule();
  }

  /* ------------------------------------------------------------ interaction */
  function touch() { showGrid = true; clearTimeout(gridTimer); ui.stage.classList.add('has-moved'); schedule(); }
  function release() { clearTimeout(gridTimer); gridTimer = setTimeout(() => { showGrid = false; schedule(); }, 800); }
  function flash() { touch(); release(); }

  function changed() { constrain(); syncUI(); schedule(); }

  function zoomAt(px, py, f) {
    if (!src) return;
    const z1 = clamp(S.z * f, 1, ZMAX);
    const r = z1 / S.z;
    if (r === 1) return;
    const x = (px - vw / 2) / k, y = (py - vh / 2) / k;     // zoom point in output units
    S.tx = x - (x - S.tx) * r;
    S.ty = y - (y - S.ty) * r;
    S.z = z1;
    changed();
  }

  const zoomCenter = (f) => zoomAt(vw / 2, vh / 2, f);
  function setZoomPct(v) { zoomCenter(Math.exp(Math.log(ZMAX) * v / 100) / S.z); }
  function nudge(dx, dy) { S.tx += dx; S.ty += dy; changed(); }          // output units (keyboard)
  function pan(dx, dy) { nudge(dx / k, dy / k); }                         // screen px (pointer)
  function setFine(v) { S.fine = clamp(Math.round(v * 10) / 10, -45, 45); changed(); }
  function rotateQuarter(d) { S.quarter = (S.quarter + d + 4) % 4; changed(); }

  function flip(axis) {
    // Screen-space mirror: M*T*R(a)*F = T(M t) * R(-a) * (M F). Negate offset on that axis and the angle.
    if (axis === 'h') { S.fx = -S.fx; S.tx = -S.tx; } else { S.fy = -S.fy; S.ty = -S.ty; }
    S.quarter = (4 - S.quarter) % 4;
    S.fine = -S.fine || 0;
    changed();
  }

  function reset() { resetState(); changed(); flash(); }

  function gesture() {
    const p = Array.from(ptrs.values());
    if (!p.length) return null;
    if (p.length === 1) return { x: p[0].x, y: p[0].y, d: 0 };
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  }

  function onDown(e) {
    if (!src || isBusy) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ui.stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rect = ui.stage.getBoundingClientRect();
    last = gesture();
    dlg.classList.add('is-drag');
    ui.stage.focus({ preventScroll: true });
    touch();
    e.preventDefault();
  }

  function onMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = gesture();
    if (last && now) {
      if (ptrs.size >= 2 && last.d > 0 && now.d > 0) zoomAt(now.x - rect.left, now.y - rect.top, now.d / last.d);   // pinch
      pan(now.x - last.x, now.y - last.y);
    }
    last = now;
  }

  function onUp(e) {
    if (!ptrs.delete(e.pointerId)) return;
    last = gesture();
    if (!ptrs.size) { dlg.classList.remove('is-drag'); release(); }
  }

  function onWheel(e) {
    if (!src || isBusy) return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const r = ui.stage.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * 0.0015));
    flash();
  }

  function onKey(e) {
    const t = e.target;
    const onRange = !!(t.matches && t.matches('input[type="range"]'));
    const onField = !!(t.matches && t.matches('button, input'));

    if (e.key === 'Enter') {
      if (e.repeat || onField) return;               // repeat: Enter that OPENED the editor must not auto-apply
      e.preventDefault();
      apply();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || !src || isBusy) return;

    const step = e.shiftKey ? 40 : 8;
    switch (e.code) {                                // e.code: layout independent (Arabic keyboards)
      case 'ArrowLeft':  if (onRange) return; nudge(-step, 0); break;
      case 'ArrowRight': if (onRange) return; nudge(step, 0); break;
      case 'ArrowUp':    if (onRange) return; nudge(0, -step); break;
      case 'ArrowDown':  if (onRange) return; nudge(0, step); break;
      case 'Equal': case 'NumpadAdd': zoomCenter(1.1); break;
      case 'Minus': case 'NumpadSubtract': zoomCenter(1 / 1.1); break;
      case 'BracketLeft':  if (e.shiftKey) rotateQuarter(-1); else setFine(S.fine - NUDGE_DEG); break;
      case 'BracketRight': if (e.shiftKey) rotateQuarter(1); else setFine(S.fine + NUDGE_DEG); break;
      default: return;
    }
    e.preventDefault();
    flash();
  }

  /* ----------------------------------------------------------------- source */
  async function decode(blob) {
    let node = null;
    try { node = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }   // EXIF applied here
    catch (_) { try { node = await createImageBitmap(blob); } catch (__) { node = null; } }

    if (!node) {                                    // old engines: <img> also applies EXIF
      const url = URL.createObjectURL(blob);
      try {
        node = await new Promise((ok, bad) => {
          const im = new Image();
          im.onload = () => ok(im);
          im.onerror = () => bad(new Error('decode failed'));
          im.src = url;
        });
      } finally { URL.revokeObjectURL(url); }
    }

    const ow = node.naturalWidth || node.width, oh = node.naturalHeight || node.height;
    if (!(ow > 0) || !(oh > 0)) throw new Error('empty image');

    let w = ow, h = oh;
    const m = Math.max(ow, oh);
    if (m > SRC_MAX) {                              // keep preview smooth + memory low
      const f = SRC_MAX / m;
      w = Math.round(ow * f); h = Math.round(oh * f);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cg = c.getContext('2d');
      cg.imageSmoothingQuality = 'high';
      cg.drawImage(node, 0, 0, w, h);
      if (typeof node.close === 'function') node.close();
      node = c;
    }
    return {
      node: node, w: w, h: h, ow: ow, oh: oh,
      dispose: function () {
        if (typeof node.close === 'function') node.close();
        else if (node.tagName === 'CANVAS') { node.width = 0; node.height = 0; }
      }
    };
  }

  function setBusy(v) {
    isBusy = v;
    ui.stage.classList.toggle('is-busy', v);
    syncEnabled();
  }

  function showEmpty(msg) {
    ui.emptyMsg.textContent = msg;
    ui.stage.classList.add('is-empty');
    syncEnabled();
    schedule();
  }

  function notice(msg) {
    ui.note.textContent = msg;
    ui.note.classList.add('is-on');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => ui.note.classList.remove('is-on'), 3800);
  }

  function releaseSource() {
    if (srcInfo) srcInfo.dispose();
    srcInfo = null; src = null; iw = 0; ih = 0;
  }

  async function loadSource(o) {
    const token = ++loadToken;
    setBusy(true);
    try {
      const blob = o.file || await (await fetch(o.src)).blob();
      const dec = await decode(blob);
      if (token !== loadToken || !session) { dec.dispose(); return; }
      releaseSource();
      srcInfo = dec; src = dec.node; iw = dec.w; ih = dec.h;
      ui.srcVal.textContent = dec.ow + ' \u00D7 ' + dec.oh + ' px';
      ui.stage.classList.remove('is-empty');
      resetState();
      changed();
    } catch (err) {
      if (token !== loadToken) return;
      const msg = 'This browser cannot open that file. Use a JPG, PNG or WEBP photo.';
      if (src) notice(msg); else showEmpty(msg);
    } finally {
      if (token === loadToken) setBusy(false);
    }
  }

  function acceptFile(file) {
    if (!file) return;
    if (!file.type || file.type.indexOf('image/') !== 0) { notice('Please choose an image file (JPG, PNG or WEBP).'); return; }
    if (file.size > MAX_BYTES) { notice('Photo must be smaller than 20 MB.'); return; }
    loadSource({ file: file });
  }

  /* -------------------------------------------------------------------- UI */
  function fill(r, a, b) { r.style.setProperty('--a', a + '%'); r.style.setProperty('--b', b + '%'); }

  function syncUI() {
    if (!dlg) return;
    const zv = Math.log(S.z) / Math.log(ZMAX) * 100;
    ui.zoom.value = String(zv);
    fill(ui.zoom, 0, zv);
    ui.zoomVal.textContent = Math.round(S.z * 100) + '%';

    ui.fine.value = String(S.fine);
    const pos = (S.fine + 45) / 90 * 100;
    fill(ui.fine, Math.min(50, pos), Math.max(50, pos));
    ui.fineVal.textContent = (S.fine > 0 ? '+' : '') + S.fine.toFixed(1) + '\u00B0';

    ui.stage.classList.toggle('is-low', !!src && limits().min * S.z > LOW_RES);
  }

  function syncEnabled() {
    const on = !!src && !isBusy;
    ui.ctrls.forEach((el) => { el.disabled = !on; });
  }

  function section(title) {
    const s = mk('section', 'pe-sec');
    s.append(mk('h3', 'pe-sec__t', title));
    return s;
  }
  function labelRow(text, out) { const r = mk('div', 'pe-lbl'); r.append(mk('span', '', text), out); return r; }
  function sliderRow(a, r, b) { const w = mk('div', 'pe-slider'); w.append(a, r, b); return w; }
  function range(min, max, step, label) {
    const r = mk('input', 'pe-range');
    r.type = 'range'; r.min = min; r.max = max; r.step = step;
    r.setAttribute('aria-label', label);
    return r;
  }

  function build() {
    dlg = mk('dialog', 'pe-modal no-print');
    dlg.setAttribute('aria-label', 'Edit photo');

    /* header */
    const head = mk('header', 'pe-head');
    const badge = mk('span', 'pe-head__badge');
    badge.append(icon('crop'));
    const txt = mk('div', 'pe-head__txt');
    txt.append(mk('h2', 'pe-head__title', 'Edit photo'),
      mk('p', 'pe-head__sub', 'Certificate frame \u00B7 4:5 \u00B7 29.60 \u00D7 37.00 mm'));
    const xBtn = btn('pe-x', '', 'close', 'Close (Esc)');
    head.append(badge, txt, xBtn);

    /* stage */
    const stage = mk('div', 'pe-stage');
    stage.tabIndex = 0;
    stage.setAttribute('role', 'application');
    stage.setAttribute('aria-label', 'Photo crop area. Arrow keys move, plus and minus zoom, brackets rotate.');
    const canvas = mk('canvas', 'pe-canvas');
    const warn = mk('span', 'pe-warn');
    warn.append(icon('alert'), mk('span', '', 'Low resolution \u2014 photo may look soft'));
    const hint = mk('span', 'pe-hint', 'Drag to move \u00B7 Scroll or pinch to zoom');
    const note = mk('div', 'pe-note');
    note.setAttribute('role', 'status');
    note.setAttribute('aria-live', 'polite');
    const busy = mk('div', 'pe-busy');
    busy.setAttribute('role', 'status');
    busy.setAttribute('aria-label', 'Loading photo');
    busy.append(mk('span', 'pe-spin'));
    const empty = mk('div', 'pe-empty');
    const emptyMsg = mk('p', 'pe-empty__msg', '');
    const emptyBtn = btn('pe-btn', 'Choose photo\u2026', 'upload');
    empty.append(icon('image'), emptyMsg, emptyBtn);
    stage.append(canvas, warn, hint, note, busy, empty);

    /* side panel */
    const side = mk('aside', 'pe-side');

    const zMinus = btn('pe-step', '', 'minus', 'Zoom out (\u2212)');
    const zPlus = btn('pe-step', '', 'plus', 'Zoom in (+)');
    const zRange = range(0, 100, 0.1, 'Zoom');
    const zVal = mk('output', 'pe-val', '100%');
    const secZoom = section('Zoom');
    secZoom.append(labelRow('Scale', zVal), sliderRow(zMinus, zRange, zPlus));

    const rotL = btn('pe-tool', '90\u00B0 left', 'rotL', 'Rotate left 90\u00B0 (Shift + [)');
    const rotR = btn('pe-tool', '90\u00B0 right', 'rotR', 'Rotate right 90\u00B0 (Shift + ])');
    const pairRot = mk('div', 'pe-pair');
    pairRot.append(rotL, rotR);
    const fMinus = btn('pe-step', '\u22122\u00B0', '', 'Rotate \u22122\u00B0 ([)');
    const fPlus = btn('pe-step', '+2\u00B0', '', 'Rotate +2\u00B0 (])');
    const fRange = range(-45, 45, 0.5, 'Fine rotation');
    const fVal = mk('output', 'pe-val', '0.0\u00B0');
    const secRot = section('Rotate');
    secRot.append(pairRot, labelRow('Fine rotation', fVal), sliderRow(fMinus, fRange, fPlus));

    const flipH = btn('pe-tool', 'Flip horizontal', 'flipH', 'Mirror left / right');
    const flipV = btn('pe-tool', 'Flip vertical', 'flipV', 'Mirror top / bottom');
    const pairFlip = mk('div', 'pe-pair');
    pairFlip.append(flipH, flipV);
    const secFlip = section('Flip');
    secFlip.append(pairFlip);

    const info = mk('dl', 'pe-info');
    const srcVal = mk('dd', '', '\u2014');
    info.append(
      mk('dt', '', 'Frame'), mk('dd', '', '29.60 \u00D7 37.00 mm'),
      mk('dt', '', 'Output'), mk('dd', '', OUT_W + ' \u00D7 ' + OUT_H + ' px'),
      mk('dt', '', 'Source'), srcVal);
    const tip = mk('p', 'pe-tip', 'Arrows move \u00B7 + \u2212 zoom \u00B7 [ ] rotate \u00B7 Enter apply \u00B7 Esc cancel. Paste or drop an image to replace it.');

    side.append(secZoom, secRot, secFlip, info, tip);

    const body = mk('div', 'pe-body');
    body.append(stage, side);

    /* footer */
    const replaceBtn = btn('pe-btn pe-btn--ghost', 'Replace photo', 'upload', 'Choose another photo');
    const resetBtn = btn('pe-btn pe-btn--ghost', 'Reset', 'reset', 'Back to the original framing');
    const cancelBtn = btn('pe-btn pe-btn--ghost', 'Cancel');
    const applyBtn = btn('pe-btn', 'Apply', 'check', 'Apply (Enter)');
    const foot = mk('footer', 'pe-foot');
    foot.append(replaceBtn, mk('span', 'pe-foot__sp'), resetBtn, cancelBtn, applyBtn);

    const file = mk('input');
    file.type = 'file';
    file.accept = 'image/*';
    file.hidden = true;

    dlg.append(head, body, foot, file);
    document.body.appendChild(dlg);

    Object.assign(ui, {
      stage: stage, canvas: canvas, note: note, emptyMsg: emptyMsg, srcVal: srcVal,
      zoom: zRange, zoomVal: zVal, fine: fRange, fineVal: fVal,
      ctrls: [zMinus, zPlus, zRange, rotL, rotR, fMinus, fPlus, fRange, flipH, flipV, resetBtn, applyBtn]
    });
    g2 = canvas.getContext('2d', { alpha: false });

    /* wiring */
    xBtn.addEventListener('click', () => finish(null));
    cancelBtn.addEventListener('click', () => finish(null));
    applyBtn.addEventListener('click', apply);
    resetBtn.addEventListener('click', reset);
    const pick = () => file.click();
    replaceBtn.addEventListener('click', pick);
    emptyBtn.addEventListener('click', pick);
    file.addEventListener('change', () => { acceptFile(file.files && file.files[0]); file.value = ''; });

    zMinus.addEventListener('click', () => { zoomCenter(1 / 1.15); flash(); });
    zPlus.addEventListener('click', () => { zoomCenter(1.15); flash(); });
    zRange.addEventListener('input', () => { setZoomPct(parseFloat(zRange.value)); touch(); release(); });
    rotL.addEventListener('click', () => { rotateQuarter(-1); flash(); });
    rotR.addEventListener('click', () => { rotateQuarter(1); flash(); });
    fMinus.addEventListener('click', () => { setFine(S.fine - NUDGE_DEG); flash(); });
    fPlus.addEventListener('click', () => { setFine(S.fine + NUDGE_DEG); flash(); });
    fRange.addEventListener('input', () => { setFine(parseFloat(fRange.value)); touch(); release(); });
    flipH.addEventListener('click', () => { flip('h'); flash(); });
    flipV.addEventListener('click', () => { flip('v'); flash(); });

    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('lostpointercapture', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    dlg.addEventListener('keydown', onKey);

    // Paste / drop INSIDE the editor = Replace photo. stopPropagation: script.js has a document-level image paste handler.
    dlg.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (const it of items) {
        if (it.kind === 'file' && it.type.indexOf('image/') === 0) {
          e.preventDefault(); e.stopPropagation();
          acceptFile(it.getAsFile());
          return;
        }
      }
    });
    dlg.addEventListener('dragover', (e) => e.preventDefault());
    dlg.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      acceptFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });

    dlg.addEventListener('close', () => { if (session) finish(null); });    // Esc path
    if (typeof ResizeObserver === 'function') new ResizeObserver(layout).observe(stage);
    window.addEventListener('resize', layout);
  }

  /* ----------------------------------------------------------- open / close */
  function apply() {
    if (!src || isBusy || !session) return;
    const c = document.createElement('canvas');
    c.width = OUT_W; c.height = OUT_H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';                                  // JPEG has no alpha (transparent PNG would turn black)
    g.fillRect(0, 0, OUT_W, OUT_H);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.translate(OUT_W / 2, OUT_H / 2);
    paint(g);
    const url = c.toDataURL('image/jpeg', JPEG_Q);
    c.width = 0; c.height = 0;
    finish(url);
  }

  function finish(result) {
    if (!session) return;
    const s = session;
    session = null;
    loadToken++;                                           // drop any decode still in flight
    releaseSource();
    ptrs.clear();
    clearTimeout(gridTimer); clearTimeout(noteTimer);
    showGrid = false;
    dlg.classList.remove('is-drag');
    document.documentElement.classList.remove('pe-lock');
    if (dlg.open) dlg.close();
    s.resolve(result);
  }

  function open(opts) {
    if (session) return session.promise;
    if (!dlg) build();
    opts = opts || {};
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    session = { resolve: resolve, promise: promise };

    resetState();
    ui.stage.classList.remove('has-moved', 'is-low', 'is-empty', 'is-busy');
    ui.note.classList.remove('is-on');
    ui.srcVal.textContent = '\u2014';
    document.documentElement.classList.add('pe-lock');
    dlg.showModal();
    layout();
    ui.stage.focus({ preventScroll: true });
    syncUI();
    syncEnabled();

    if (opts.file || opts.src) loadSource(opts);
    else showEmpty('No photo selected.');
    return promise;
  }

  window.CertPhotoEditor = { open: open, isOpen: () => !!session };
})();