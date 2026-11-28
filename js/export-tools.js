/**
 * export-tools.js - One-click "Save as PDF / JPG" for the A4 certificate (300 DPI, offline).
 *
 * @description
 * HOW IT RENDERS
 *   1. The live .page is cloned and serialised to XHTML.
 *   2. style.css is fetched and every url(...) in it (fonts, background.png) is inlined as a data URI;
 *      <img> sources (logo, ribbon icons, photo) are inlined the same way.
 *   3. Clone + CSS go into an SVG <foreignObject> that is exactly 210mm x 297mm. The browser's OWN layout
 *      engine lays it out, so mm geometry, Arabic shaping, auto-fit sizes and the DIN font are identical to
 *      the screen. No html2canvas-style re-implementation of CSS.
 *   4. The SVG is drawn once onto a 2480 x 3508 canvas (A4 @ 300 DPI), then
 *        JPG = canvas -> JPEG (quality 0.95, JFIF density patched to 300 dpi)
 *        PDF = the same JPEG wrapped in a hand-written single-page A4 PDF (DCTDecode, no library).
 *
 * WHAT IT DOES NOT DO
 *   The PDF is a flat image: text is not selectable. Ctrl+P -> "Save as PDF" is still the vector route.
 *
 * Screen-only decoration (ghost placeholders, red .invalid line, "Locked" pill, outlines, combo arrows) is
 * stripped, i.e. the export looks like the print, but uses the 297mm screen geometry (no 296.5mm guard).
 *
 * Needs a Chromium-class browser (Chrome / Edge): Safari taints the canvas for SVG foreignObject.
 * The SVG must be loaded from a data: URL (a blob: URL taints the canvas in Chrome too).
 *
 * Public API: window.CertExport = { savePdf(), saveJpg(), renderCanvas() }  (each returns a Promise).
 * Load order: any time before the first click (menu-tools.js calls it lazily).
 */
(function () {
  'use strict';

  const DPI = 300;
  const MM_PER_IN = 25.4;
  const PX_W = Math.round(210 / MM_PER_IN * DPI);          // 2480
  const PX_H = Math.round(297 / MM_PER_IN * DPI);          // 3508
  const CSS_W = 210 / MM_PER_IN * 96;                      // 793.7008 CSS px (1mm = 96/25.4 px)
  const CSS_H = 297 / MM_PER_IN * 96;                      // 1122.5197 CSS px
  const PDF_W = 595.276;                                   // A4 in PDF points
  const PDF_H = 841.89;
  const JPEG_QUALITY = 0.95;
  /** The SVG image loads its fonts lazily on first paint: draw once small, wait, then draw for real. */
  const FONT_SETTLE_MS = 300;
  const CSS_URL = 'style.css';
  const URL_RE = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;

  /* Everything the print stylesheet hides, plus what @media screen adds. Stronger than hoping the cloned
     DOM is clean: these rules use !important and also beat the @media screen rules inside style.css. */
  const EXPORT_CSS =
    '.cert-export-root{position:relative;width:210mm;height:297mm;margin:0;padding:0;overflow:hidden;' +
      "background:#fff;color:#1f2937;font-family:'Inter',Arial,sans-serif}" +
    '.cert-export-root .page{margin:0!important;box-shadow:none!important}' +
    '.cert-export-root *{outline:none!important}' +
    '.upload.is-empty .hint{visibility:hidden}' +
    '.logo{border-color:transparent!important}' +
    '.upload.is-locked::after{content:none!important;display:none!important}' +
    '.invalid{box-shadow:none!important}' +
    '[data-placeholder]::before{content:""!important;display:none!important}' +
    '.no-print{display:none!important}' +
    '.combo-btn,.combo-menu{display:none!important}' +
    '.combo-input{-webkit-appearance:none!important;appearance:none!important;border:none!important;' +
      'background:transparent!important;box-shadow:none!important}';

  /* ---------------------------------------------------------------- helpers */

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }

  const dataUrlCache = new Map();          // absolute URL -> data URI (successes only)

  /**
   * @description Fetches a same-origin file (served from the Service Worker cache when offline) as a data URI.
   * @param {string} url absolute or relative URL
   * @returns {Promise<string>} rejects on 404 / network error
   */
  async function toDataUrl(url) {
    if (/^data:/i.test(url)) return url;
    const abs = new URL(url, document.baseURI).href;
    if (dataUrlCache.has(abs)) return dataUrlCache.get(abs);
    const res = await fetch(abs);
    if (!res.ok) throw new Error(abs + ' -> ' + res.status);
    const data = await blobToDataUrl(await res.blob());
    dataUrlCache.set(abs, data);
    return data;
  }

  let cssPromise = null;

  /**
   * @description style.css with every url(...) inlined. Missing optional files (licensed DIN, Helvetica, Arial)
   * are left as plain url() and are simply skipped by the browser, exactly like on screen.
   * Cached for the session: fonts/background never change while the app is open.
   * @returns {Promise<string>}
   */
  function getCss() {
    if (!cssPromise) {
      cssPromise = (async () => {
        const cssUrl = new URL(CSS_URL, document.baseURI).href;
        const res = await fetch(cssUrl);
        if (!res.ok) throw new Error('style.css could not be loaded (' + res.status + ')');
        const css = await res.text();

        const wanted = new Set();
        css.replace(URL_RE, (m, q, u) => { if (!/^data:/i.test(u)) wanted.add(u); return m; });
        const resolved = new Map();
        await Promise.all(Array.from(wanted).map(async (u) => {
          try { resolved.set(u, await toDataUrl(new URL(u, cssUrl).href)); } catch (_) { /* optional file missing */ }
        }));
        return css.replace(URL_RE, (m, q, u) => (resolved.has(u) ? 'url("' + resolved.get(u) + '")' : m));
      })().catch((err) => { cssPromise = null; throw err; });   // a failure must not be cached
    }
    return cssPromise;
  }

  /**
   * @description Clone of the live sheet, cleaned for export and serialised as XHTML.
   * @returns {Promise<string>}
   */
  async function serializePage() {
    const page = document.querySelector('#stage > .page') || document.querySelector('.page');
    if (!page) throw new Error('Certificate sheet not found');
    const clone = page.cloneNode(true);

    // <input> keeps its typed text in the .value PROPERTY; cloneNode only copies the attribute.
    const live = page.querySelectorAll('.combo-input');
    clone.querySelectorAll('.combo-input').forEach((el, i) => { el.setAttribute('value', live[i].value); });

    clone.removeAttribute('style');                                   // drops viewport.js transform: scale(s)
    clone.querySelectorAll('input[type="file"], .combo-btn').forEach((n) => n.remove());
    clone.querySelectorAll('[data-placeholder]').forEach((n) => n.removeAttribute('data-placeholder'));
    clone.querySelectorAll('[contenteditable]').forEach((n) => n.removeAttribute('contenteditable'));

    // An SVG image may not load anything external: every <img> must carry its pixels with it.
    await Promise.all(Array.from(clone.querySelectorAll('img')).map(async (img) => {
      try { img.setAttribute('src', await toDataUrl(img.src)); } catch (_) { img.remove(); }
    }));

    return new XMLSerializer().serializeToString(clone);
  }

  function buildSvg(css, pageXhtml) {
    const safeCss = css.replace(/]]>/g, ']]]]><![CDATA[>') + EXPORT_CSS;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + PX_W + '" height="' + PX_H + '"' +
      ' viewBox="0 0 ' + CSS_W + ' ' + CSS_H + '" preserveAspectRatio="none">' +
      '<foreignObject x="0" y="0" width="' + CSS_W + '" height="' + CSS_H + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" class="cert-export-root">' +
      '<style><![CDATA[' + safeCss + ']]></style>' + pageXhtml +
      '</div></foreignObject></svg>';
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('The browser could not render the certificate (SVG load failed)'));
      img.src = src;
    });
  }

  /** Same housekeeping as beforeprint: commit the focused cell, refresh dates / Hijri / fit. */
  function prepare() {
    const a = document.activeElement;
    if (a && a.blur) a.blur();
    if (window.CertApp && typeof window.CertApp.refreshDates === 'function') window.CertApp.refreshDates();
  }

  /* ----------------------------------------------------------------- render */

  /**
   * @description Renders the sheet to a 2480 x 3508 canvas.
   * @returns {Promise<HTMLCanvasElement>}
   */
  async function renderCanvas() {
    prepare();
    const [css, xhtml] = await Promise.all([getCss(), serializePage()]);
    // data: URL, NOT blob: URL. Chrome marks the canvas tainted for a blob: SVG that contains foreignObject
    // (toBlob then throws SecurityError); the same SVG as a data: URL is allowed.
    const svgUrl = await blobToDataUrl(new Blob([buildSvg(css, xhtml)], { type: 'image/svg+xml;charset=utf-8' }));
    const img = await loadImage(svgUrl);

    // Warm-up: the first paint of an SVG image triggers font decoding inside it.
    const warm = document.createElement('canvas');
    warm.width = warm.height = 16;
    warm.getContext('2d').drawImage(img, 0, 0, 16, 16);
    await wait(FONT_SETTLE_MS);

    const canvas = document.createElement('canvas');
    canvas.width = PX_W;
    canvas.height = PX_H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';                                     // JPEG has no alpha: transparent would turn black
    ctx.fillRect(0, 0, PX_W, PX_H);
    ctx.drawImage(img, 0, 0, PX_W, PX_H);
    return canvas;
  }

  /* ------------------------------------------------------------ JPEG / PDF */

  /** Chrome writes a JFIF header with density 1:1 and no unit (= "72 dpi" to Word/Photoshop). Set 300 dpi. */
  function setJfifDpi(b, dpi) {
    const jfif = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0 &&
      b[6] === 0x4A && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46 && b[10] === 0;
    if (!jfif) return b;
    b[13] = 1;                                                  // units: dots per inch
    b[14] = dpi >> 8; b[15] = dpi & 255;                        // X density
    b[16] = dpi >> 8; b[17] = dpi & 255;                        // Y density
    return b;
  }

  function canvasToJpegBytes(canvas) {
    return new Promise((resolve, reject) => {
      try {
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('JPEG encoding failed')); return; }
          blob.arrayBuffer().then((buf) => resolve(setJfifDpi(new Uint8Array(buf), DPI)), reject);
        }, 'image/jpeg', JPEG_QUALITY);
      } catch (err) {
        reject(new Error('This browser blocks canvas export for SVG content: use Chrome or Edge'));
      }
    });
  }

  const pdfEscape = (s) => String(s).replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');

  /**
   * @description Minimal valid PDF 1.4: one A4 page, the JPEG stretched over the full page (zero margin).
   * @param {Uint8Array} jpeg DCT data (3 components)
   * @param {number} wPx image width
   * @param {number} hPx image height
   * @param {string} title document title (ASCII only, anything else becomes "?")
   * @returns {Blob}
   */
  function buildPdf(jpeg, wPx, hPx, title) {
    const enc = new TextEncoder();
    const parts = [];
    const offsets = [];
    let len = 0;
    const push = (x) => { const u = typeof x === 'string' ? enc.encode(x) : x; parts.push(u); len += u.length; };
    const begin = (n) => { offsets[n] = len; push(n + ' 0 obj\n'); };
    const end = () => push('\nendobj\n');

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));      // binary marker comment

    begin(1); push('<< /Type /Catalog /Pages 2 0 R >>'); end();
    begin(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); end();
    begin(3);
    push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PDF_W + ' ' + PDF_H + ']' +
      ' /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>');
    end();
    begin(4);
    push('<< /Type /XObject /Subtype /Image /Width ' + wPx + ' /Height ' + hPx +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>\nstream\n');
    push(jpeg);
    push('\nendstream');
    end();
    const content = 'q ' + PDF_W + ' 0 0 ' + PDF_H + ' 0 0 cm /Im0 Do Q';
    begin(5); push('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'); end();

    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = 'D:' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
    begin(6);
    push('<< /Title (' + pdfEscape(title) + ') /Producer (Certification Engine) /CreationDate (' + stamp + ') >>');
    end();

    const xrefAt = len;
    let xref = 'xref\n0 7\n0000000000 65535 f \n';
    for (let n = 1; n <= 6; n++) xref += String(offsets[n]).padStart(10, '0') + ' 00000 n \n';   // 20 bytes per entry
    push(xref + 'trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');
    return new Blob(parts, { type: 'application/pdf' });
  }

  /* ---------------------------------------------------------------- save */

  function baseName() {
    const t = (sel) => { const n = document.querySelector(sel); return n ? n.textContent.trim() : ''; };
    const no = t('[data-sync="cert-prefix"]') + t('[data-auto="cert-ym"]') + t('[data-sync="cert-seq"]');
    const nm = t('.name-en').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return ('Certification_' + no + (nm ? '_' + nm : '')).replace(/[^A-Za-z0-9_-]/g, '');
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function savePdf() {
    const name = baseName();
    const canvas = await renderCanvas();
    const jpeg = await canvasToJpegBytes(canvas);
    canvas.width = canvas.height = 0;                           // release ~35 MB of pixels
    saveBlob(buildPdf(jpeg, PX_W, PX_H, name), name + '.pdf');
    return { name: name + '.pdf', bytes: jpeg.length };
  }

  async function saveJpg() {
    const name = baseName();
    const canvas = await renderCanvas();
    const jpeg = await canvasToJpegBytes(canvas);
    canvas.width = canvas.height = 0;
    saveBlob(new Blob([jpeg], { type: 'image/jpeg' }), name + '.jpg');
    return { name: name + '.jpg', bytes: jpeg.length };
  }

  window.CertExport = { savePdf: savePdf, saveJpg: saveJpg, renderCanvas: renderCanvas };
})();