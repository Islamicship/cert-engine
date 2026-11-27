/**
 * photo-editor.js - Modal photo editor. Bakes crop / rotate / flip into pixels.
 *
 * API: window.CertPhotoEditor.open({ file: File } | { src: dataUrl }) -> Promise<string|null>
 *      resolves with a baked JPEG data URL (700 x 875, 4:5), or null on cancel.
 *
 * MODEL (all in OUTPUT units, i.e. the frame is OUT_W x OUT_H):
 *   point -> scale(fx*s, fy*s) -> rotate(theta) -> translate(tx, ty) -> frame centre
 *   Cover clamp: in image-local space |u| <= half-size - m, where
 *     mx = W/2|cos| + H/2|sin|,  my = W/2|sin| + H/2|cos|   (frame half-extent seen from the image axes)
 *   Preview and bake use the SAME paint() routine, so what you see is what is saved.
 *   Flips are screen-space: they negate tx/ty and the angle, so the sliders stay intuitive.
 *
 * CROP BEHAVIOUR (Google Photos / Windows Photos style):
 *   - Resize the crop box -> on release the box ANIMATES back to the maximum size and the image zooms
 *     with it (similarity transform about the box centre, so the cropped content never shifts).
 *   - Shift + wheel resizes the box; it auto-fills ~0.4 s after the last wheel tick.
 *   - Double click / double tap, key F, or the "Fill frame" button = fill the view with the current crop.
 *   - Undo / Redo (Ctrl+Z, Ctrl+Shift+Z / Ctrl+Y, or buttons). One gesture = one history step.
 *   - Key 0 = reset, "Fit image" button = show whole image again (keeps rotate / flip).
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
  const FILL_MS = 260;               // crop-box "snap back to full size" animation
  const WHEEL_FILL_MS = 380;         // idle time after Shift+wheel before auto-fill
  const DBL_MS = 320;                // double tap / click window
  const HIST_MAX = 60;

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
    undo: 'M9 14L4 9l5-5|M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'M15 14l5-5-5-5|M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    fill: 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7',
    alert: 'M12 9v4|M12 17h.01|M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    image: 'M4 5h16v14H4z|M4 16l5-5 4 4 3-3 4 4|M9 9h.01'
  };

  const KEYS = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Equal', 'NumpadAdd', 'Minus', 'NumpadSubtract',
    'BracketLeft', 'BracketRight', 'KeyF', 'Digit0', 'Numpad0'
  ]);

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
  let vw = 0, vh = 0, dpr = 1, sFit = 1;
  let src = null, iw = 0, ih = 0, srcInfo = null;
  let session = null, loadToken = 0, isBusy = false;
  let raf = 0, showGrid = false, gridTimer = 0, noteTimer = 0, fillTimer = 0;
  const S = { z: 1, tx: 0, ty: 0, quarter: 0, fine: 0, fx: 1, fy: 1 };
  const ptrs = new Map();
  let last = null, rect = null;
  let B = null, drag = null;            // B = crop box (stage px, 4:5 locked), drag = active pointer action
  const V = { cx: 0, cy: 0, s: 1 };     // image view: centre (stage px) + scale (stage px per source px)
  let anim = null;                      // running "fill" animation
  let tap = null, prevTap = null;       // double tap detection
  const undoStack = [], redoStack = [];
  let markOn = false, markTimer = 0;    // coalesces continuous actions (wheel, sliders, keys) into one history step

  function resetState() {
    S.quarter = 0; S.fine = 0; S.fx = 1; S.fy = 1;
  }

  /* --------------------------------------------------------------- geometry */
  const angle = () => (S.quarter * 90 + S.fine) * Math.PI / 180;
  const EDGE = 2;                      // min gap between crop box and stage border (px)
  const MIN_BOX = 48;                  // smallest crop box width (px)
  const ASPECT = OUT_W / OUT_H;        // 0.8
  const GRAB = { nw: [1, 1], ne: [0, 1], sw: [1, 0], se: [0, 0], n: [0.5, 1], s: [0.5, 0], w: [1, 0.5], e: [0, 0.5] };
  const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

  // Half-extent of a w x h box as seen from the image's own (rotated) axes.
  function ext(w, h) {
    const th = angle(), c = Math.abs(Math.cos(th)), s = Math.abs(Math.sin(th));
    return { x: w / 2 * c + h / 2 * s, y: w / 2 * s + h / 2 * c };
  }

  // Is box b fully inside the stage AND inside the (rotated) image footprint?
  function fits(b) {
    if (b.x < EDGE || b.y < EDGE || b.x + b.w > vw - EDGE || b.y + b.h > vh - EDGE) return false;
    const th = angle(), cs = Math.cos(th), sn = Math.sin(th), e = ext(b.w, b.h);
    const px = b.x + b.w / 2 - V.cx, py = b.y + b.h / 2 - V.cy;
    const ux = px * cs + py * sn, uy = -px * sn + py * cs;           // R(-theta) * p
    return Math.abs(ux) + e.x <= iw * V.s / 2 + 0.01 && Math.abs(uy) + e.y <= ih * V.s / 2 + 0.01;
  }

  // Keep the image covering the crop box: zoom up if needed (about box centre), then clamp image centre.
  function cover() {
    if (!src || !B) return;
    const th = angle(), cs = Math.cos(th), sn = Math.sin(th), e = ext(B.w, B.h);
    const bx = B.x + B.w / 2, by = B.y + B.h / 2;
    const sMin = Math.max(2 * e.x / iw, 2 * e.y / ih) * 1.002;       // 0.2% overscan
    if (V.s < sMin) {
      const r = sMin / V.s;
      V.cx = bx + (V.cx - bx) * r; V.cy = by + (V.cy - by) * r; V.s = sMin;
    }
    const px = bx - V.cx, py = by - V.cy;
    const ax = Math.max(0, iw * V.s / 2 - e.x), ay = Math.max(0, ih * V.s / 2 - e.y);
    const ux = clamp(px * cs + py * sn, -ax, ax);
    const uy = clamp(-px * sn + py * cs, -ay, ay);
    V.cx = bx - (ux * cs - uy * sn);
    V.cy = by - (ux * sn + uy * cs);
  }

  // tx, ty, s in the units of the current context (stage px for preview, output px for bake).
  function paint(g, tx, ty, s) {
    g.save();
    g.translate(tx, ty);
    g.rotate(angle());
    g.scale(S.fx * s, S.fy * s);
    g.drawImage(src, -iw / 2, -ih / 2);
    g.restore();
  }

  function padPx() { return vw < 520 ? 16 : 28; }
  function fitScale() { const p = padPx(); return Math.min((vw - 2 * p) / iw, (vh - 2 * p) / ih); }

  function fitView() {
    if (!vw) layout();
    if (!vw || !src) return;
    sFit = fitScale();
    V.s = sFit; V.cx = vw / 2; V.cy = vh / 2;
    const w = Math.min(iw * V.s, ih * V.s * ASPECT) * 0.9, h = w / ASPECT;   // 90% of the largest 4:5 box
    B = { x: (vw - w) / 2, y: (vh - h) / 2, w: w, h: h };
  }

  /* ---------------------------------------------------------------- history */
  function snap() {
    return { q: S.quarter, f: S.fine, fx: S.fx, fy: S.fy, cx: V.cx, cy: V.cy, s: V.s, bx: B.x, by: B.y, bw: B.w, bh: B.h };
  }

  function same(a, b) {
    return a.q === b.q && a.fx === b.fx && a.fy === b.fy && Math.abs(a.f - b.f) < 1e-6 &&
      Math.abs(a.cx - b.cx) < 0.25 && Math.abs(a.cy - b.cy) < 0.25 &&
      Math.abs(a.s - b.s) < 1e-4 * Math.max(a.s, b.s) &&
      Math.abs(a.bx - b.bx) < 0.25 && Math.abs(a.by - b.by) < 0.25 && Math.abs(a.bw - b.bw) < 0.25;
  }

  function syncHist() {
    if (!ui.undo) return;
    const on = !!src && !isBusy;
    ui.undo.disabled = !on || !undoStack.length;
    ui.redo.disabled = !on || !redoStack.length;
  }

  function clearHist() {
    undoStack.length = 0; redoStack.length = 0;
    clearTimeout(markTimer); markOn = false;
    syncHist();
  }

  function pushHist() {                                              // record the state BEFORE a change
    if (!src || !B) return;
    const cur = snap(), top = undoStack[undoStack.length - 1];
    if (top && same(top, cur)) return;
    undoStack.push(cur);
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack.length = 0;
    syncHist();
  }

  function mark() {                                                  // continuous actions inside 450 ms = one step
    clearTimeout(markTimer);
    if (!markOn) { markOn = true; pushHist(); }
    markTimer = setTimeout(() => { markOn = false; }, 450);
  }

  function restore(a) {
    S.quarter = a.q; S.fine = a.f; S.fx = a.fx; S.fy = a.fy;
    V.cx = a.cx; V.cy = a.cy; V.s = a.s;
    B = { x: a.bx, y: a.by, w: a.bw, h: a.bw / ASPECT };
    changed();
  }

  function undo() {
    stopAnim(true);
    if (!src || !B || isBusy) return;
    const cur = snap();
    while (undoStack.length && same(undoStack[undoStack.length - 1], cur)) undoStack.pop();
    if (!undoStack.length) { syncHist(); return; }
    redoStack.push(cur);
    restore(undoStack.pop());
    flash();
  }

  function redo() {
    stopAnim(true);
    if (!src || !B || isBusy) return;
    const cur = snap();
    while (redoStack.length && same(redoStack[redoStack.length - 1], cur)) redoStack.pop();
    if (!redoStack.length) { syncHist(); return; }
    undoStack.push(cur);
    restore(redoStack.pop());
    flash();
  }

  function mapSnap(a, ow, oh, kf) {                                  // keep history valid when the stage is resized
    a.cx = vw / 2 + (a.cx - ow / 2) * kf;
    a.cy = vh / 2 + (a.cy - oh / 2) * kf;
    a.s *= kf;
    a.bx = vw / 2 + (a.bx - ow / 2) * kf;
    a.by = vh / 2 + (a.by - oh / 2) * kf;
    a.bw *= kf; a.bh *= kf;
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
    if (!src || !B) return;

    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    paint(c, V.cx, V.cy, V.s);

    const bx = B.x, by = B.y, bw = B.w, bh = B.h;

    c.fillStyle = 'rgba(8,11,13,.64)';                       // dim everything outside the box
    c.beginPath();
    c.rect(0, 0, vw, vh);
    c.rect(bx, by, bw, bh);
    c.fill('evenodd');

    c.lineWidth = 1.5;
    c.strokeStyle = 'rgba(255,255,255,.9)';
    c.strokeRect(bx, by, bw, bh);

    if (showGrid) {                                          // rule of thirds, only while adjusting
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(255,255,255,.42)';
      c.beginPath();
      for (let i = 1; i < 3; i++) {
        c.moveTo(bx + bw * i / 3, by); c.lineTo(bx + bw * i / 3, by + bh);
        c.moveTo(bx, by + bh * i / 3); c.lineTo(bx + bw, by + bh * i / 3);
      }
      c.stroke();
    }

    const L = Math.min(22, bw / 5), x0 = bx, y0 = by, x1 = bx + bw, y1 = by + bh;
    const mx = bx + bw / 2, my = by + bh / 2, hl = Math.min(18, bw / 6), vl = Math.min(18, bh / 6);
    c.lineWidth = 3;
    c.lineCap = 'square';
    c.strokeStyle = '#fff';
    c.beginPath();
    c.moveTo(x0, y0 + L); c.lineTo(x0, y0); c.lineTo(x0 + L, y0);        // corners
    c.moveTo(x1 - L, y0); c.lineTo(x1, y0); c.lineTo(x1, y0 + L);
    c.moveTo(x1, y1 - L); c.lineTo(x1, y1); c.lineTo(x1 - L, y1);
    c.moveTo(x0 + L, y1); c.lineTo(x0, y1); c.lineTo(x0, y1 - L);
    c.moveTo(mx - hl, y0); c.lineTo(mx + hl, y0);                        // edge handles
    c.moveTo(mx - hl, y1); c.lineTo(mx + hl, y1);
    c.moveTo(x0, my - vl); c.lineTo(x0, my + vl);
    c.moveTo(x1, my - vl); c.lineTo(x1, my + vl);
    c.stroke();
  }

  function layout() {
    if (!dlg || !dlg.open) return;
    const nw = ui.stage.clientWidth, nh = ui.stage.clientHeight;   // clientWidth, NOT getBoundingClientRect: open animation scales the dialog
    if (nw < 40 || nh < 40) return;
    stopAnim(true);                                                 // settle any animation in the OLD coordinates first
    const ow = vw, oh = vh;
    vw = nw; vh = nh;
    dpr = window.devicePixelRatio || 1;
    ui.canvas.width = Math.round(vw * dpr);
    ui.canvas.height = Math.round(vh * dpr);
    if (src && B && ow > 0 && (ow !== vw || oh !== vh)) rescale(ow, oh);
    schedule();
  }

  function rescale(ow, oh) {                                         // stage resized: keep the same framing
    const kf = Math.min(vw / ow, vh / oh);
    V.cx = vw / 2 + (V.cx - ow / 2) * kf;
    V.cy = vh / 2 + (V.cy - oh / 2) * kf;
    V.s *= kf;
    B = { x: vw / 2 + (B.x - ow / 2) * kf, y: vh / 2 + (B.y - oh / 2) * kf, w: B.w * kf, h: B.h * kf };
    undoStack.forEach((a) => mapSnap(a, ow, oh, kf));
    redoStack.forEach((a) => mapSnap(a, ow, oh, kf));
    sFit = fitScale();
    changed();
  }

  /* ------------------------------------------------------------ interaction */
  function touch() { showGrid = true; clearTimeout(gridTimer); ui.stage.classList.add('has-moved'); schedule(); }
  function release() { clearTimeout(gridTimer); gridTimer = setTimeout(() => { showGrid = false; schedule(); }, 800); }
  function flash() { touch(); release(); }

  function changed() { cover(); syncUI(); schedule(); }

  // Run before any discrete user action: settle running animation + open a history step.
  function begin() { stopAnim(true); clearTimeout(fillTimer); mark(); }

  /* ---- fill animation (crop box -> max size, image zooms with it) ---- */
  const reduceMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const ease = (t) => 1 - Math.pow(1 - t, 3);                        // easeOutCubic

  function targetBox() {
    const p = padPx();
    const w = Math.max(MIN_BOX, Math.min(vw - 2 * p, (vh - 2 * p) * ASPECT));
    return { w: w, h: w / ASPECT };
  }

  // State at progress e in [0,1]: whole configuration is scaled by k^e about the box centre,
  // while the box centre glides to the stage centre. Content under the box never changes.
  function setFill(a, e) {
    const k = Math.pow(a.k, e);
    const cx = a.bcx + (a.tcx - a.bcx) * e, cy = a.bcy + (a.tcy - a.bcy) * e;
    V.s = a.s0 * k;
    V.cx = cx + (a.vx0 - a.bcx) * k;
    V.cy = cy + (a.vy0 - a.bcy) * k;
    const w = a.w0 * k;
    B = { x: cx - w / 2, y: cy - w / ASPECT / 2, w: w, h: w / ASPECT };
  }

  function stopAnim(finishIt) {
    if (!anim) return;
    const a = anim;
    anim = null;
    cancelAnimationFrame(a.raf);
    if (finishIt && src && B) { setFill(a, 1); changed(); }
  }

  function fillBox(animate) {
    stopAnim(true);
    clearTimeout(fillTimer);
    if (!src || !B || isBusy || !vw) return;
    const t = targetBox();
    let k = t.w / B.w;
    k = clamp(k, Math.min(1, sFit / V.s), Math.max(sFit * ZMAX, V.s) / V.s);   // never zoom past the slider range
    const bcx = B.x + B.w / 2, bcy = B.y + B.h / 2, tcx = vw / 2, tcy = vh / 2;
    if (Math.abs(k - 1) < 0.003 && Math.hypot(bcx - tcx, bcy - tcy) < 0.5) return;

    const a = { k: k, s0: V.s, vx0: V.cx, vy0: V.cy, w0: B.w, bcx: bcx, bcy: bcy, tcx: tcx, tcy: tcy, t0: 0, raf: 0 };
    flash();
    if (!animate || reduceMotion()) { setFill(a, 1); changed(); return; }

    anim = a;
    const stepFn = (now) => {
      if (anim !== a) return;
      if (!a.t0) a.t0 = now;
      const t01 = Math.min(1, (now - a.t0) / FILL_MS);
      setFill(a, ease(t01));
      if (t01 < 1) {
        syncUI();
        draw();
        a.raf = requestAnimationFrame(stepFn);
      } else {
        anim = null;
        changed();
      }
    };
    a.raf = requestAnimationFrame(stepFn);
  }

  function fitAll() { begin(); fitView(); changed(); flash(); }      // show whole image again, keep rotate / flip

  /* ---- view (image) ---- */
  function viewZoomAt(px, py, f) {
    if (!src || !B) return;
    const s1 = clamp(V.s * f, sFit, Math.max(sFit * ZMAX, V.s));
    const r = s1 / V.s;
    if (r === 1) return;
    V.cx = px + (V.cx - px) * r;
    V.cy = py + (V.cy - py) * r;
    V.s = s1;
    changed();
  }

  const zoomCenter = (f) => { if (B) viewZoomAt(B.x + B.w / 2, B.y + B.h / 2, f); };
  function setZoomPct(v) { if (B) viewZoomAt(B.x + B.w / 2, B.y + B.h / 2, sFit * Math.exp(Math.log(ZMAX) * v / 100) / V.s); }
  function panView(dx, dy) { V.cx += dx; V.cy += dy; changed(); }

  // Rotate the image about the CROP BOX centre, so the content under the box stays put.
  function turn(q, fine) {
    if (!B) return;
    const th0 = angle();
    S.quarter = q; S.fine = fine;
    const d = angle() - th0, c = Math.cos(d), s = Math.sin(d);
    const bx = B.x + B.w / 2, by = B.y + B.h / 2, dx = V.cx - bx, dy = V.cy - by;
    V.cx = bx + dx * c - dy * s;
    V.cy = by + dx * s + dy * c;
    changed();
  }
  function setFine(v) { turn(S.quarter, clamp(Math.round(v * 10) / 10, -45, 45)); }
  function rotateQuarter(d) { turn((S.quarter + d + 4) % 4, S.fine); }

  function flip(axis) {
    // Screen-space mirror about the crop box centre: position mirrors, angle negates, scale sign flips.
    if (!B) return;
    const bx = B.x + B.w / 2, by = B.y + B.h / 2;
    if (axis === 'h') { S.fx = -S.fx; V.cx = 2 * bx - V.cx; } else { S.fy = -S.fy; V.cy = 2 * by - V.cy; }
    S.quarter = (4 - S.quarter) % 4;
    S.fine = -S.fine || 0;
    changed();
  }

  function reset() { begin(); resetState(); fitView(); changed(); flash(); }

  /* ---- crop box ---- */
  function boxAt(d, w) {                                             // d = fixed anchor {ax, ay, gx, gy}
    const h = w / ASPECT;
    return { x: d.ax - d.gx * w, y: d.ay - d.gy * h, w: w, h: h };
  }

  function fitBox(d, want) {                                         // biggest width <= want that still fits
    const w = Math.max(want, MIN_BOX);
    if (fits(boxAt(d, w))) return w;
    let lo = Math.min(MIN_BOX, B.w), hi = w;
    if (!fits(boxAt(d, lo))) return B.w;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (fits(boxAt(d, mid))) lo = mid; else hi = mid;
    }
    return lo;
  }

  function scaleBox(f) {                                             // Shift + wheel: resize about box centre
    if (!B) return;
    const d = { ax: B.x + B.w / 2, ay: B.y + B.h / 2, gx: 0.5, gy: 0.5 };
    B = boxAt(d, fitBox(d, B.w * f));
    syncUI(); schedule();
  }

  function slideInImage(b) {                                         // clamp box centre inside footprint (image-local axes)
    const th = angle(), cs = Math.cos(th), sn = Math.sin(th), e = ext(b.w, b.h);
    const px = b.x + b.w / 2 - V.cx, py = b.y + b.h / 2 - V.cy;
    const ax = Math.max(0, iw * V.s / 2 - e.x), ay = Math.max(0, ih * V.s / 2 - e.y);
    const ux = clamp(px * cs + py * sn, -ax, ax), uy = clamp(-px * sn + py * cs, -ay, ay);
    b.x = V.cx + ux * cs - uy * sn - b.w / 2;
    b.y = V.cy + ux * sn + uy * cs - b.h / 2;
  }

  function moveBox(nx, ny) {
    if (!B) return;
    const b = { x: nx, y: ny, w: B.w, h: B.h };
    for (let i = 0; i < 4 && !fits(b); i++) {
      slideInImage(b);
      b.x = clamp(b.x, EDGE, vw - EDGE - b.w);
      b.y = clamp(b.y, EDGE, vh - EDGE - b.h);
    }
    if (!fits(b)) return;
    B = b;
    schedule();
  }

  function nudge(dx, dy) { if (B) moveBox(B.x + dx, B.y + dy); }    // stage px (keyboard)

  function inBox(px, py) { return !!B && px >= B.x && px <= B.x + B.w && py >= B.y && py <= B.y + B.h; }

  function hitHandle(px, py) {
    if (!B) return null;
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const m = coarse ? 26 : 14, me = coarse ? 18 : 10;
    const x0 = B.x, y0 = B.y, x1 = B.x + B.w, y1 = B.y + B.h;
    const cs = [[x0, y0, 'nw'], [x1, y0, 'ne'], [x0, y1, 'sw'], [x1, y1, 'se']];
    for (const c of cs) if (Math.abs(px - c[0]) <= m && Math.abs(py - c[1]) <= m) return c[2];
    if (px >= x0 && px <= x1) {
      if (Math.abs(py - y0) <= me) return 'n';
      if (Math.abs(py - y1) <= me) return 's';
    }
    if (py >= y0 && py <= y1) {
      if (Math.abs(px - x0) <= me) return 'w';
      if (Math.abs(px - x1) <= me) return 'e';
    }
    return null;
  }

  function hoverCursor(e) {
    if (!src || isBusy) return;
    const r = ui.stage.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    const h = hitHandle(px, py);
    ui.canvas.style.cursor = h ? CURSOR[h] : (inBox(px, py) ? 'move' : 'grab');
  }

  function startResize(h, id) {
    const g = GRAB[h];                                               // g = anchor fraction (opposite corner / edge centre)
    return { type: 'resize', id: id, gx: g[0], gy: g[1], ax: B.x + g[0] * B.w, ay: B.y + g[1] * B.h };
  }

  function dragResize(e) {
    const d = drag, px = e.clientX - rect.left, py = e.clientY - rect.top;
    const sx = d.gx === 0 ? 1 : -1, sy = d.gy === 0 ? 1 : -1;        // growth direction away from the anchor
    const wx = (px - d.ax) * sx, wy = (py - d.ay) * sy * ASPECT;
    const want = d.gx === 0.5 ? wy : (d.gy === 0.5 ? wx : Math.max(wx, wy));
    B = boxAt(d, fitBox(d, want));
    syncUI(); schedule();
  }

  function gesture() {
    const p = Array.from(ptrs.values());
    if (!p.length) return null;
    if (p.length === 1) return { x: p[0].x, y: p[0].y, d: 0 };
    return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) };
  }

  function onDown(e) {
    if (!src || isBusy || !B) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (drag && drag.type !== 'view') return;                        // box drag in progress: ignore extra fingers
    stopAnim(true);                                                  // settle fill animation BEFORE hit-testing the box
    clearTimeout(fillTimer);
    ui.stage.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    rect = ui.stage.getBoundingClientRect();
    if (ptrs.size === 1) {
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const h = hitHandle(px, py);
      if (h) drag = startResize(h, e.pointerId);
      else if (inBox(px, py)) drag = { type: 'move', id: e.pointerId, sx: px, sy: py, bx: B.x, by: B.y };
      else drag = { type: 'view' };                                  // outside the box: pan the image
      pushHist();                                                    // one gesture = one undo step
      tap = drag.type === 'resize' ? null : { x: e.clientX, y: e.clientY, moved: false };
    } else {
      drag = { type: 'view' };                                       // two fingers: pinch + pan the image
      tap = null;
    }
    last = gesture();
    dlg.classList.add('is-drag');
    ui.stage.focus({ preventScroll: true });
    touch();
    e.preventDefault();
  }

  function onMove(e) {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap.moved = true;
    if (drag && drag.id === e.pointerId) {
      if (drag.type === 'resize') { dragResize(e); return; }
      if (drag.type === 'move') {
        moveBox(drag.bx + (e.clientX - rect.left) - drag.sx, drag.by + (e.clientY - rect.top) - drag.sy);
        return;
      }
    }
    if (!ptrs.has(e.pointerId)) { hoverCursor(e); return; }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const now = gesture();
    if (last && now) {
      if (ptrs.size >= 2 && last.d > 0 && now.d > 0) viewZoomAt(now.x - rect.left, now.y - rect.top, now.d / last.d);   // pinch
      panView(now.x - last.x, now.y - last.y);
    }
    last = now;
  }

  function onUp(e) {
    const wasResize = !!drag && drag.type === 'resize' && drag.id === e.pointerId;
    const single = ptrs.size === 1 && ptrs.has(e.pointerId);
    if (drag && drag.id === e.pointerId) drag = null;                // box drag finished
    if (!ptrs.delete(e.pointerId)) return;
    last = gesture();
    if (!ptrs.size) { drag = null; dlg.classList.remove('is-drag'); release(); }
    if (ptrs.size) return;

    if (wasResize) { tap = null; fillBox(true); return; }            // Google Photos: box snaps back, image zooms along

    if (single && tap && !tap.moved && e.type === 'pointerup') {     // double click / double tap = fill frame
      const now = performance.now();
      if (prevTap && now - prevTap.t < DBL_MS && Math.hypot(tap.x - prevTap.x, tap.y - prevTap.y) < 24) {
        prevTap = null;
        mark();
        fillBox(true);
      } else {
        prevTap = { x: tap.x, y: tap.y, t: now };
      }
    }
    tap = null;
  }

  function onWheel(e) {
    if (!src || isBusy) return;
    e.preventDefault();
    stopAnim(true);
    mark();
    const raw = e.deltaY || e.deltaX;                                // Shift swaps deltaY into deltaX on some browsers
    const dy = e.deltaMode === 1 ? raw * 16 : raw;
    const f = Math.exp(-dy * 0.0015);
    if (e.shiftKey) {
      scaleBox(f);                                                   // Shift + wheel = resize crop box
      clearTimeout(fillTimer);
      fillTimer = setTimeout(() => fillBox(true), WHEEL_FILL_MS);    // auto-fill once the wheel goes idle
    } else {
      const r = ui.stage.getBoundingClientRect();
      viewZoomAt(e.clientX - r.left, e.clientY - r.top, f);          // wheel = view zoom
    }
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

    if ((e.ctrlKey || e.metaKey) && !e.altKey && src && !isBusy) {   // history shortcuts (layout independent)
      if (e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    }

    if (e.ctrlKey || e.metaKey || e.altKey || !src || isBusy) return;
    if (!KEYS.has(e.code)) return;
    if (onRange && e.code.indexOf('Arrow') === 0) return;            // let sliders use their own arrow keys

    stopAnim(true);
    clearTimeout(fillTimer);
    mark();

    const step = e.shiftKey ? 20 : 4;                // stage px
    switch (e.code) {                                // e.code: layout independent (Arabic keyboards)
      case 'ArrowLeft':  nudge(-step, 0); break;
      case 'ArrowRight': nudge(step, 0); break;
      case 'ArrowUp':    nudge(0, -step); break;
      case 'ArrowDown':  nudge(0, step); break;
      case 'Equal': case 'NumpadAdd': zoomCenter(1.1); break;
      case 'Minus': case 'NumpadSubtract': zoomCenter(1 / 1.1); break;
      case 'BracketLeft':  if (e.shiftKey) rotateQuarter(-1); else setFine(S.fine - NUDGE_DEG); break;
      case 'BracketRight': if (e.shiftKey) rotateQuarter(1); else setFine(S.fine + NUDGE_DEG); break;
      case 'KeyF': fillBox(true); break;
      case 'Digit0': case 'Numpad0': e.preventDefault(); reset(); return;
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
      stopAnim(false);
      releaseSource();
      srcInfo = dec; src = dec.node; iw = dec.w; ih = dec.h;
      ui.srcVal.textContent = dec.ow + ' \u00D7 ' + dec.oh + ' px';
      ui.stage.classList.remove('is-empty');
      resetState();
      clearHist();                                   // new photo = fresh history
      fitView();
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
    const z = src && B ? V.s / sFit : 1;
    const zv = clamp(Math.log(Math.max(z, 1)) / Math.log(ZMAX) * 100, 0, 100);
    ui.zoom.value = String(zv);
    fill(ui.zoom, 0, zv);
    ui.zoomVal.textContent = Math.round(z * 100) + '%';

    ui.fine.value = String(S.fine);
    const pos = (S.fine + 45) / 90 * 100;
    fill(ui.fine, Math.min(50, pos), Math.max(50, pos));
    ui.fineVal.textContent = (S.fine > 0 ? '+' : '') + S.fine.toFixed(1) + '\u00B0';

    ui.stage.classList.toggle('is-low', !!src && !!B && V.s * OUT_W / B.w > LOW_RES);
    syncHist();
  }

  function syncEnabled() {
    const on = !!src && !isBusy;
    ui.ctrls.forEach((el) => { el.disabled = !on; });
    syncHist();
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
    stage.setAttribute('aria-label', 'Photo crop area. Arrow keys move, plus and minus zoom, brackets rotate, F fills the frame.');
    const canvas = mk('canvas', 'pe-canvas');
    const warn = mk('span', 'pe-warn');
    warn.append(icon('alert'), mk('span', '', 'Low resolution \u2014 photo may look soft'));
    const hint = mk('span', 'pe-hint', 'Drag box to move \u00B7 Drag corners/edges to resize \u00B7 Scroll to zoom \u00B7 Double-click to fill');
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

    const fillB = btn('pe-tool', 'Fill frame', 'fill', 'Zoom the crop to fill the view (F or double-click)');
    const fitB = btn('pe-tool', 'Fit image', 'image', 'Show the whole image again');
    const pairFill = mk('div', 'pe-pair');
    pairFill.append(fillB, fitB);
    const undoB = btn('pe-tool', 'Undo', 'undo', 'Undo (Ctrl + Z)');
    const redoB = btn('pe-tool', 'Redo', 'redo', 'Redo (Ctrl + Shift + Z)');
    const pairHist = mk('div', 'pe-pair');
    pairHist.append(undoB, redoB);
    const secCrop = section('Crop');
    secCrop.append(pairFill, pairHist);

    const info = mk('dl', 'pe-info');
    const srcVal = mk('dd', '', '\u2014');
    info.append(
      mk('dt', '', 'Frame'), mk('dd', '', '29.60 \u00D7 37.00 mm'),
      mk('dt', '', 'Output'), mk('dd', '', OUT_W + ' \u00D7 ' + OUT_H + ' px'),
      mk('dt', '', 'Source'), srcVal);
    const tip = mk('p', 'pe-tip', 'Arrows move \u00B7 + \u2212 zoom \u00B7 [ ] rotate \u00B7 F fill \u00B7 0 reset \u00B7 Ctrl+Z undo \u00B7 Enter apply \u00B7 Esc cancel. Paste or drop an image to replace it.');

    side.append(secZoom, secRot, secFlip, secCrop, info, tip);

    const body = mk('div', 'pe-body');
    body.append(stage, side);

    /* footer */
    const replaceBtn = btn('pe-btn pe-btn--ghost', 'Replace photo', 'upload', 'Choose another photo');
    const resetBtn = btn('pe-btn pe-btn--ghost', 'Reset', 'reset', 'Back to the original framing (0)');
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
      zoom: zRange, zoomVal: zVal, fine: fRange, fineVal: fVal, undo: undoB, redo: redoB,
      ctrls: [zMinus, zPlus, zRange, rotL, rotR, fMinus, fPlus, fRange, flipH, flipV, fillB, fitB, resetBtn, applyBtn]
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

    zMinus.addEventListener('click', () => { begin(); zoomCenter(1 / 1.15); flash(); });
    zPlus.addEventListener('click', () => { begin(); zoomCenter(1.15); flash(); });
    zRange.addEventListener('input', () => { begin(); setZoomPct(parseFloat(zRange.value)); touch(); release(); });
    rotL.addEventListener('click', () => { begin(); rotateQuarter(-1); flash(); });
    rotR.addEventListener('click', () => { begin(); rotateQuarter(1); flash(); });
    fMinus.addEventListener('click', () => { begin(); setFine(S.fine - NUDGE_DEG); flash(); });
    fPlus.addEventListener('click', () => { begin(); setFine(S.fine + NUDGE_DEG); flash(); });
    fRange.addEventListener('input', () => { begin(); setFine(parseFloat(fRange.value)); touch(); release(); });
    flipH.addEventListener('click', () => { begin(); flip('h'); flash(); });
    flipV.addEventListener('click', () => { begin(); flip('v'); flash(); });
    fillB.addEventListener('click', () => { begin(); fillBox(true); });
    fitB.addEventListener('click', fitAll);
    undoB.addEventListener('click', undo);
    redoB.addEventListener('click', redo);

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
    stopAnim(true);                                        // bake the SETTLED state, never a mid-animation frame
    clearTimeout(fillTimer);
    if (!src || isBusy || !session || !B) return;
    const c = document.createElement('canvas');
    c.width = OUT_W; c.height = OUT_H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';                                  // JPEG has no alpha (transparent PNG would turn black)
    g.fillRect(0, 0, OUT_W, OUT_H);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.translate(OUT_W / 2, OUT_H / 2);
    const f = OUT_W / B.w;                                 // stage px -> output px
    paint(g, (V.cx - (B.x + B.w / 2)) * f, (V.cy - (B.y + B.h / 2)) * f, V.s * f);
    const url = c.toDataURL('image/jpeg', JPEG_Q);
    c.width = 0; c.height = 0;
    finish(url);
  }

  function finish(result) {
    if (!session) return;
    const s = session;
    session = null;
    loadToken++;                                           // drop any decode still in flight
    stopAnim(false);
    releaseSource();
    B = null;
    ptrs.clear();
    drag = null; tap = null; prevTap = null;
    clearHist();
    clearTimeout(gridTimer); clearTimeout(noteTimer); clearTimeout(fillTimer);
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
    clearHist();
    tap = null; prevTap = null;
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