'use strict';
// OCR for scanned PDF pages, using tesseract.js. Set TESSDATA_PATH to a folder that holds eng.traineddata.
// Without it, tesseract.js downloads the English model from its default CDN on first use.
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    const dir = process.env.TESSDATA_PATH;
    workerPromise = createWorker('eng', 1, dir ? { langPath: dir, gzip: false } : {})
      .catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// png: a PNG image buffer. Returns the recognised text.
async function ocrImage(png) {
  const worker = await getWorker();
  const { data } = await worker.recognize(png);
  return (data && data.text) || '';
}

module.exports = { ocrImage };
