'use strict';
// Renders PDF pages to bitmaps, used for QR reading and for OCR of scanned pages.
// pdf.js draws each page onto an @napi-rs/canvas surface, so no browser is needed.
const { createCanvas } = require('@napi-rs/canvas');
const jsQR = require('jsqr');
const path = require('path');

// Standard PDF fonts (Helvetica etc.) ship with pdfjs-dist; pdf.js needs them to draw text.
const STANDARD_FONTS = path.resolve(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';

let pdfjsPromise = null;
const loadPdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));

class CanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  }
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; }
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; }
}

// Returns up to maxPages pages as { width, height, rgba, png }.
async function renderPages(buf, { maxPages = 2, scale = 2 } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, canvasFactory: new CanvasFactory(), standardFontDataUrl: STANDARD_FONTS,
  }).promise;
  const pages = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const width = Math.floor(viewport.width), height = Math.floor(viewport.height);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({ width, height, rgba: ctx.getImageData(0, 0, width, height).data, png: canvas.toBuffer('image/png') });
    }
  } finally {
    if (doc && typeof doc.destroy === 'function') await doc.destroy();
  }
  return pages;
}

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// First QR code on any page whose content is a compact JWS (the form used for IRN QR codes).
function findQrJwt(pages) {
  for (const pg of pages) {
    const code = jsQR(pg.rgba, pg.width, pg.height, { inversionAttempts: 'attemptBoth' });
    const text = code && code.data ? code.data.trim() : '';
    if (JWT_RE.test(text)) return text;
  }
  return null;
}

module.exports = { renderPages, findQrJwt };
