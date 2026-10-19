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
      const w = await T.createWorker('tur', 1, { logger: (m) => report(m) });
      // automatic page segmentation: columns and blocks (tesseract.js would read a page as one block of text,
      // which interleaves the lines of two columns)
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      return w;
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

// Tesseract's text, laid out for reading, without what it read from pictures.
//  - Layout: Tesseract runs with automatic page segmentation (PSM 3, set in worker()), so a two-column page comes as
//    blocks, column by column. Consecutive blocks in the same column (their x ranges overlap) are one run: its
//    lines go top to bottom, and pieces of one row close to each other are joined left to right (an answer's letter
//    "B" and its text can come as two blocks; a footer far to the right of the last line stays apart).
//  - Pictures: a line Tesseract is unsure of (confidence under 55; patterns, photos and drawings read as letters
//    come out at 0-50, real text at 80-96), or under 70 with no word of two letters ("5 9 ©" from a like button),
//    and a word without a letter or digit it is unsure of ("«", "..."). A "©" right before a name is an "@".
//  - Paragraphs: lines keep their breaks; each block of Tesseract's is a paragraph of its own, and so is a stretch
//    after a gap well beyond the run's usual line gap: a blank line between them, for plainBlocks.
const WORDISH = /\p{L}{2}/u;
const SIGN = /^[^\p{L}\p{N}]+$/u;
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1] || 0;

// a list bullet as Tesseract reads it ("e Lökosit", "© ALP"), before a capital or a digit (not "o": the pronoun)
const BULLET = /^(?:[e©®•°*·]|[-–—])\s+(?=[\p{Lu}\d])/u;
function readable(li) {
  const words = (li.words || []).filter((w) => !(SIGN.test(w.text) && w.confidence < 50));
  const text = words.map((w) => w.text).join(' ').replace(/©(?=[\p{L}\d_])/gu, '@').replace(BULLET, '').trim();
  if (!text || li.confidence < 55 || (li.confidence < 70 && !WORDISH.test(text))) return '';
  // a column of bullets read as one line: "© © © © O ©"
  const tokens = text.split(/\s+/);
  if (tokens.length >= 4 && tokens.filter((t) => t.length === 1).length >= 0.7 * tokens.length) return '';
  return text;
}

// A line as pieces: Tesseract can take a footer at the far right ("drdahiliye.com") for the end of the line
// beside it; words more than 4 line heights apart are pieces of their own. -> [{text, x0, x1, y0, y1}]
function pieces(li) {
  const h = li.bbox.y1 - li.bbox.y0;
  const words = li.words || [];
  const groups = [];
  for (const w of words) {
    const g = groups[groups.length - 1];
    if (g && w.bbox.x0 - g[g.length - 1].bbox.x1 <= 4 * h) g.push(w);
    else groups.push([w]);
  }
  if (groups.length < 2) {
    const text = readable(li);
    return text ? [{ text, ...li.bbox }] : [];
  }
  return groups.map((g) => {
    const conf = g.reduce((n, w) => n + w.confidence, 0) / g.length;
    const text = readable({ words: g, confidence: conf });
    const box = { x0: g[0].bbox.x0, x1: g[g.length - 1].bbox.x1, y0: Math.min(...g.map((w) => w.bbox.y0)), y1: Math.max(...g.map((w) => w.bbox.y1)) };
    return text ? { text, ...box } : null;
  }).filter(Boolean);
}

export function cleanOcr(blocks) {
  // runs of consecutive blocks in one column: [{x0, x1, lines: [{text, x0, x1, y0, y1, part}]}]
  const runs = [];
  let blk = 0;
  for (const bl of blocks) {
    blk += 1;
    const lines = [];
    for (const pa of bl.paragraphs || []) {
      for (const li of pa.lines || []) for (const pc of pieces(li)) lines.push({ ...pc, blk });
    }
    if (!lines.length) continue;
    const x0 = Math.min(...lines.map((l) => l.x0));
    const x1 = Math.max(...lines.map((l) => l.x1));
    const last = runs[runs.length - 1];
    const overlap = last ? Math.min(last.x1, x1) - Math.max(last.x0, x0) : 0;
    if (last && overlap > 0.3 * Math.min(last.x1 - last.x0, x1 - x0)) {
      last.lines.push(...lines);
      last.x0 = Math.min(last.x0, x0);
      last.x1 = Math.max(last.x1, x1);
    } else runs.push({ x0, x1, lines });
  }
  const paras = [];
  for (const run of runs) {
    // top to bottom (stable: lines of one row keep Tesseract's order), then pieces of one row joined
    const sorted = [...run.lines].sort((a, b) => a.y0 - b.y0);
    const lh = median(sorted.map((l) => l.y1 - l.y0));
    const rows = [];
    for (const l of sorted) {
      const row = rows[rows.length - 1];
      const shared = row ? Math.min(row.y1, l.y1) - Math.max(row.y0, l.y0) : 0;
      const apart = row ? Math.max(...row.pieces.map((q) => Math.max(q.x0 - l.x1, l.x0 - q.x1))) : 0;
      if (row && shared > 0.5 * Math.min(row.y1 - row.y0, l.y1 - l.y0) && apart < 4 * lh) {
        row.pieces.push(l);
        row.y0 = Math.min(row.y0, l.y0);
        row.y1 = Math.max(row.y1, l.y1);
      } else rows.push({ y0: l.y0, y1: l.y1, blk: l.blk, pieces: [l] });
    }
    for (const row of rows) row.text = row.pieces.sort((a, b) => a.x0 - b.x0).map((l) => l.text).join(' ');
    const h = median(rows.map((r) => r.y1 - r.y0));
    const gaps = rows.slice(1).map((r, k) => r.y0 - rows[k].y1);
    const wide = gaps.length >= 2 ? Math.max(1.5 * median(gaps), 0.5 * h) : Infinity;
    let lines = [];
    rows.forEach((r, k) => {
      const gap = k ? r.y0 - rows[k - 1].y1 : 0;
      // side by side (rows that overlap but stayed apart) is not one paragraph either
      if (lines.length && (gap > wide || r.blk !== rows[k - 1].blk || gap < -0.3 * h)) {
        paras.push(lines.join('\n'));
        lines = [];
      }
      lines.push(r.text);
    });
    if (lines.length) paras.push(lines.join('\n'));
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
  const read = []; // each page's paragraphs, as Tesseract's layout gives them
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
    read.push(text.split(/\n\n+/).map((t) => ({ text: t, page: list[k] })));
  }
  // running headers go first: plainBlocks would join one to the paragraph below it ("drdahiliye.com" starts in
  // lower case, so it reads as the rest of a sentence)
  const kept = dropRunning(read.flat(), list.length);
  const blocks = [];
  for (const page of list) {
    const text = kept.filter((p) => p.page === page).map((p) => p.text).join('\n\n');
    for (const b of plainBlocks(text)) blocks.push({ ...b, page });
  }
  return blocks;
}

// Running headers and footers: a page number standing alone, and a short block without digits or a colon that
// comes back the same on at least 3 pages and 40 % of them ("HEMATOLOJİ - ONKOLOJİ", "drdahiliye.com" on every other
// page). Lab values ("Hb: 12.9 g/dL", "PT: Normal") recur too, so a block with a digit or a colon always stays. A text
// layer gets the same from js/text.js (dropFurniture, by position); here the text is all there is.
function dropRunning(blocks, pages) {
  if (pages < 4) return blocks;
  const candidate = (b) => b.text.length <= 60 && !/[\d:\n]/.test(b.text);
  const key = (b) => b.text.toLocaleLowerCase('tr').replace(/[^\p{L}]+/gu, ' ').trim();
  const seen = new Map();
  for (const b of blocks.filter(candidate)) {
    if (!seen.has(key(b))) seen.set(key(b), new Set());
    seen.get(key(b)).add(b.page);
  }
  const running = (b) => {
    if (/^\W*\d{1,4}\W*$/.test(b.text)) return true;
    if (!candidate(b)) return false;
    const n = seen.get(key(b)).size;
    return n >= 3 && n >= 0.4 * pages;
  };
  return blocks.filter((b) => !running(b));
}

export async function ocrDone() {
  if (!workerP) return;
  const p = workerP;
  workerP = null;
  try {
    await (await p).terminate();
  } catch { /* already gone */ }
}
