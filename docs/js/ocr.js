// Reading text from pictures: scanned PDFs and photos of pages, with Tesseract (tesseract.js, Turkish LSTM data).
// Loaded only when needed: the engine and the Turkish data are about 3.5 MB more (tesseract.js keeps the data in
// IndexedDB for next time), from jsdelivr like everything else.

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
  const { data } = await w.recognize(image, {}, { text: true, blocks: true });
  return data.blocks ? cleanOcr(data.blocks) : data.text || '';
}

// Tesseract's text, without what it read from icons and pictures: a line it is unsure of (confidence under 70)
// that holds no word of two letters ("5 9 ©" from a like button), and a word without a letter or digit it is
// unsure of ("«", "..."). A "©" right before a name is an "@" (a handle). Lines keep their breaks; a paragraph of
// Tesseract's, or a gap between two lines well beyond the paragraph's usual line gap (Tesseract often takes a
// screenshot's text and the buttons under it for one paragraph), becomes a blank line, for plainBlocks.
const WORDISH = /\p{L}{2}/u;
const SIGN = /^[^\p{L}\p{N}]+$/u;
export function cleanOcr(blocks) {
  const paras = [];
  for (const bl of blocks) {
    for (const pa of bl.paragraphs || []) {
      const all = pa.lines || [];
      const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1] || 0;
      const h = median(all.map((li) => li.bbox.y1 - li.bbox.y0));
      const gaps = all.slice(1).map((li, k) => li.bbox.y0 - all[k].bbox.y1);
      const wide = gaps.length >= 2 ? Math.max(1.5 * median(gaps), 0.5 * h) : Infinity;
      let lines = [];
      let lastY = null;
      for (const li of all) {
        const words = (li.words || []).filter((w) => !(SIGN.test(w.text) && w.confidence < 50));
        const text = words.map((w) => w.text).join(' ').replace(/©(?=[\p{L}\d_])/gu, '@').trim();
        if (!text || (li.confidence < 70 && !WORDISH.test(text))) continue;
        if (lines.length && li.bbox.y0 - lastY > wide) {
          paras.push(lines.join('\n'));
          lines = [];
        }
        lines.push(text);
        lastY = li.bbox.y1;
      }
      if (lines.length) paras.push(lines.join('\n'));
    }
  }
  return paras.join('\n\n');
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
