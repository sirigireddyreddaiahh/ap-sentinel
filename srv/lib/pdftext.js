'use strict';
// Text extraction for text-layer PDFs using pdf.js (maintained). Line breaks are rebuilt from text positions,
// so the field patterns in extract.js see one field per line.
let pdfjsPromise;
const loadPdfjs = () => (pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'));

async function pdfText(buf) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buf), disableFontFace: true, isEvalSupported: false, useSystemFonts: true,
  }).promise;
  let out = '';
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let lastY = null;
      for (const it of content.items) {
        const y = it.transform ? it.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 2) out += '\n';
        else if (out && !out.endsWith('\n')) out += ' ';
        out += it.str;
        lastY = y;
      }
      out += '\n';
    }
  } finally {
    if (doc && typeof doc.destroy === 'function') await doc.destroy();
  }
  return out.trim();
}

module.exports = { pdfText };
