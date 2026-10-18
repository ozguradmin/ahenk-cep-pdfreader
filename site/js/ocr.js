// Reading text from pictures: scanned PDFs and photos of pages, with Tesseract (tesseract.js, Turkish LSTM data).
// Loaded only when needed: the engine and the Turkish data are about 10 MB more, from jsdelivr like everything else.

import { CDN } from './config.js';
import { plainBlocks } from './text.js';

let workerP = null;
let report = () => {};

function worker() {
  if (!workerP) {
    workerP = (async () => {
      const mod = await import(CDN.tesseract);
      const T = mod.default || mod;
      return T.createWorker('tur', 1, { logger: (m) => report(m) });
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

// onProgress({stage: 'ocr-load', frac}) while the engine loads, then {stage: 'ocr', done, total, frac}
async function recognize(image, i, n, onProgress) {
  report = (m) => {
    if (m.status === 'recognizing text') onProgress({ stage: 'ocr', done: i, total: n, frac: (i + m.progress) / n });
    else onProgress({ stage: 'ocr-load', frac: m.progress || 0 });
  };
  const w = await worker();
  onProgress({ stage: 'ocr', done: i, total: n, frac: i / n });
  const { data } = await w.recognize(image);
  return data.text || '';
}

export async function ocrImage(file, onProgress = () => {}) {
  const text = await recognize(file, 0, 1, onProgress);
  return plainBlocks(text);
}

// Each page drawn at about 2000 pixels wide (enough for body text, small enough for a phone's memory).
export async function ocrPdf(pdf, onProgress = () => {}, pages = null) {
  const list = pages || Array.from({ length: pdf.numPages }, (_, i) => i + 1);
  const blocks = [];
  for (let k = 0; k < list.length; k++) {
    const page = await pdf.getPage(list[k]);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1, 2000 / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    const text = await recognize(canvas, k, list.length, onProgress);
    canvas.width = 0;
    canvas.height = 0;
    page.cleanup();
    for (const b of plainBlocks(text)) blocks.push({ ...b, page: list[k] });
  }
  return blocks;
}

export async function ocrDone() {
  if (!workerP) return;
  const p = workerP;
  workerP = null;
  try {
    await (await p).terminate();
  } catch { /* already gone */ }
}
