// Text side of the page, pure functions (no DOM), so tests run them in Node:
//  - layoutPages: pdf.js text items -> paragraphs (lines, columns, hyphenation, running headers and page numbers)
//  - cleanText / fixTurkish: what PDFs and old documents get wrong (ligatures, ý/þ/ð for ı/ş/ğ, invisible marks)
//  - parseEditor / segment: the edited text -> blocks -> segments (a sentence or a few) with the pause after each
//  - speakable: what the model should not read aloud (links, citation numbers, bullets)

const TERMINAL = /[.!?…:;]["'’”»)\]]*$/;
const SENTENCE_END = /[.!?…]["'’”»)\]]*$/;
const LOWER_START = /^[a-zçğıöşüâîû]/;
const LETTER = /\p{L}/u;
const BULLET = /^[•·▪▫■□●○◦‣⁃►▶➢➤✓✔∙*-]\s+/;

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

// ---- characters ----------------------------------------------------------------------------------------------------

// Turkish text set in an old Windows-1252 font often comes out with Icelandic letters where ı, ş, ğ (and İ, Ş, Ğ)
// belong. These letters never occur in Turkish, so if they outnumber the right ones the whole text is mapped back.
const ICELANDIC = { ý: 'ı', þ: 'ş', ð: 'ğ', Ý: 'İ', Þ: 'Ş', Ð: 'Ğ' };
export function turkishFixNeeded(text) {
  const wrong = (text.match(/[ýþðÝÞÐ]/g) || []).length;
  const right = (text.match(/[ışğİŞĞ]/g) || []).length;
  return wrong >= 3 && wrong > right;
}
export const mapIcelandic = (text) => text.replace(/[ýþðÝÞÐ]/g, (c) => ICELANDIC[c]);
export const fixTurkish = (text) => (turkishFixNeeded(text) ? mapIcelandic(text) : text);

// NFKC turns ligatures (ﬁ, ﬂ), full-width forms and the like into plain letters; then invisible and private-use
// characters go. Soft hyphens are kept here: at the end of a line they mean "hyphenated", see joinLines.
export function cleanText(text) {
  return text
    .normalize('NFKC')
    .replace(/i\u0307/g, 'i') // "İ".toLowerCase() leftovers
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\uE000-\uF8FF\uFFFD]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, ' ')
    .replace(/[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000]+/g, ' ');
}

// Two lines of one paragraph: a word broken at the end of the first ("kitap-" + "ların") is mended.
export function joinLines(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (/\u00AD$/.test(a)) return a.slice(0, -1) + b;
  if (/\p{L}[-\u2010]$/u.test(a) && LOWER_START.test(b)) return a.slice(0, -1) + b;
  if (/\p{L}[-\u2010]$/u.test(a) && /^\p{Lu}/u.test(b)) return `${a.slice(0, -1)}-${b}`; // "Doğu-" + "Batı"
  return `${a} ${b}`;
}

// ---- PDF layout ----------------------------------------------------------------------------------------------------

// items: [{str, x, y, w, h, eol}] in content-stream order (y grows upwards, as in PDF) -> lines
export function pageLines(items) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      cur.text = cur.text.replace(/\s+/g, ' ').trim();
      if (cur.text) lines.push(cur);
    }
    cur = null;
  };
  for (const it of items) {
    const s = it.str ?? '';
    const h = it.h > 0 ? it.h : cur ? cur.h : 10;
    if (!s.length) {
      if (it.eol) flush();
      continue;
    }
    if (cur) {
      const big = Math.max(h, cur.h);
      const gap = it.x - cur.x1;
      // justified text can report runs that overlap the previous one (stretched spaces): only a start left of the
      // line's own start, a jump in height or a wide gap (a column gutter) begins a new line
      const sameLine = Math.abs(it.y - cur.y) <= 0.5 * big && it.x > cur.x0 && gap < 2.5 * big;
      if (!sameLine) flush();
    }
    if (!cur) {
      cur = { text: s, x0: it.x, x1: it.x + it.w, y: it.y, h };
    } else {
      if (it.x - cur.x1 > 0.2 * Math.max(h, cur.h) && !/\s$/.test(cur.text) && !/^\s/.test(s)) cur.text += ' ';
      cur.text += s;
      cur.x1 = Math.max(cur.x1, it.x + it.w);
      // a superscript or a smaller run does not make the line smaller; its baseline stays the line's
      if (h > cur.h) cur.h = h;
    }
    if (it.eol) flush();
  }
  flush();
  return lines;
}

const PAGE_NUMBER = /^[-–—\s]*(?:(?:sayfa|page|sf\.?|s\.)\s*)?\d{1,4}(?:\s*(?:\/|of|-|–)\s*\d{1,4})?[-–—\s]*$/i;
const ROMAN = /^[ivxlcdm]{1,7}$/i;
// running headers sit at the same height on every page; body text that happens to repeat does not
const headerKey = (l) => `${l.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()}@${Math.round(l.y / 4)}`;

// Running headers and footers: a line among the two top or bottom lines of a page that repeats (numbers aside) on
// at least half of the pages; page numbers alone at the top or bottom of a page.
export function dropFurniture(pages) {
  const edge = (lines) => {
    const byY = [...lines].sort((a, b) => b.y - a.y);
    return new Set([...byY.slice(0, 2), ...byY.slice(-2)]);
  };
  const edges = pages.map((p) => edge(p.lines));
  const counts = new Map();
  edges.forEach((set) => {
    const seen = new Set();
    for (const l of set) if (l.text.length <= 120) seen.add(headerKey(l));
    for (const k of seen) counts.set(k, (counts.get(k) || 0) + 1);
  });
  const n = pages.length;
  const repeated = (k) => n >= 2 && (counts.get(k) || 0) >= Math.max(2, Math.ceil(n * 0.5));
  return pages.map((p, i) => ({
    ...p,
    lines: p.lines.filter((l) => {
      if (!edges[i].has(l)) return true;
      const t = l.text.trim();
      if (PAGE_NUMBER.test(t) || ROMAN.test(t)) return false;
      return t.length > 120 || !repeated(headerKey(l));
    }),
  }));
}

// lines of one page -> paragraphs {text, heading, h}. bodyH: the document's usual font size.
export function pageParagraphs(lines, bodyH) {
  if (!lines.length) return [];
  const gaps = [];
  for (let i = 1; i < lines.length; i++) {
    const dy = lines[i - 1].y - lines[i].y;
    if (dy > 0 && dy < 2.5 * Math.max(lines[i].h, lines[i - 1].h) && Math.abs(lines[i].h - bodyH) < 0.2 * bodyH) gaps.push(dy);
  }
  const lineGap = median(gaps) || bodyH * 1.25;
  const sameColumn = (a, b) => a && b && Math.abs(a.x0 - b.x0) < 3 * bodyH && Math.abs(a.h - b.h) < 0.2 * bodyH;
  const leftOf = (l) => quantile(lines.filter((o) => Math.abs(o.x0 - l.x0) < 5 * bodyH).map((o) => o.x0), 0.1);
  const paras = [];
  let cur = null;
  let curLines = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = lines[i - 1];
    let start = !cur;
    if (cur && prev) {
      const dy = prev.y - l.y;
      const sizeChange = Math.abs(l.h - prev.h) > 0.2 * bodyH;
      // the last line of a paragraph stops short of its neighbours in the same column: the line before it in the
      // same paragraph, or the line after it
      const refs = [curLines[curLines.length - 2], l].filter((o) => sameColumn(o, prev));
      const shortPrev = TERMINAL.test(prev.text) && refs.length > 0 && prev.x1 < Math.max(...refs.map((o) => o.x1)) - 2 * bodyH;
      const indent = SENTENCE_END.test(prev.text) && l.x0 > leftOf(l) + 0.8 * bodyH && l.x0 - leftOf(l) < 6 * bodyH;
      start = dy < -0.5 * l.h || dy > lineGap * 1.3 + 0.5 || sizeChange || shortPrev || indent || BULLET.test(l.text);
    }
    if (start) {
      if (cur) paras.push(cur);
      cur = { text: l.text, h: l.h, lines: 1 };
      curLines = [l];
    } else {
      cur.text = joinLines(cur.text, l.text);
      cur.lines += 1;
      curLines.push(l);
    }
  }
  if (cur) paras.push(cur);
  for (const p of paras) {
    p.heading = p.h > bodyH * 1.15 && p.text.length < 140 && !SENTENCE_END.test(p.text);
  }
  return paras;
}

// pages: [{items}] from pdf.js -> {blocks: [{text, heading, page}], letters, suspect}
export function layoutPages(pages) {
  let withLines = pages.map((p) => ({ lines: pageLines(p.items) }));
  const sizes = [];
  for (const p of withLines) for (const l of p.lines) for (let k = 0; k < Math.min(50, l.text.length); k += 5) sizes.push(Math.round(l.h * 4) / 4);
  const bodyH = median(sizes) || 10;
  withLines = dropFurniture(withLines);
  const blocks = [];
  withLines.forEach((p, i) => {
    const paras = pageParagraphs(p.lines, bodyH);
    paras.forEach((para, j) => {
      const text = para.text.replace(BULLET, '').trim();
      if (!text) return;
      const last = blocks[blocks.length - 1];
      // a paragraph that runs on from the previous page
      if (j === 0 && last && last.page === i && !last.heading && !para.heading
        && !SENTENCE_END.test(last.text) && (LOWER_START.test(text) || /[-\u00AD]$/.test(last.text))) {
        last.text = joinLines(last.text, text);
        return;
      }
      blocks.push({ text, heading: para.heading, page: i + 1 });
    });
  });
  for (const b of blocks) b.text = b.text.replace(/\u00AD/g, '');
  // the Turkish letters are judged on the whole document, not block by block
  if (turkishFixNeeded(blocks.map((b) => b.text).join(' '))) for (const b of blocks) b.text = mapIcelandic(b.text);
  return { blocks, ...quality(blocks.map((b) => b.text).join(' '), pages.length) };
}

// Is the text layer usable? Scanned pages have none; a broken font encoding gives letters that are not words.
export function quality(text, pages = 1) {
  const letters = (text.match(/\p{L}/gu) || []).length;
  const vowels = (text.match(/[aeıioöuüâîûAEIİOÖUÜ]/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean);
  const longWords = words.filter((w) => w.length > 25).length;
  const perPage = letters / Math.max(1, pages);
  const scanned = perPage < 40;
  const suspect = !scanned && (vowels / Math.max(1, letters) < 0.22 || longWords / Math.max(1, words.length) > 0.08);
  return { letters, scanned, suspect };
}

// ---- plain text ----------------------------------------------------------------------------------------------------

// A plain text (a .txt, or OCR output) -> blocks. Blank lines separate paragraphs and single line breaks inside one
// are joined. Without blank lines, each line is a paragraph unless the text is hard-wrapped (lines of about the same
// width): then a paragraph ends at a short line that ends a sentence.
export function plainBlocks(raw) {
  const text = fixTurkish(cleanText(raw.replace(/\r\n?/g, '\n')));
  const out = [];
  const push = (t) => {
    const s = t.replace(/\u00AD/g, '').trim();
    if (s && (LETTER.test(s) || /\d/.test(s))) out.push({ text: s, heading: false });
  };
  const joinAll = (lines, breakAfter) => {
    let cur = '';
    lines.forEach((l, i) => {
      if (cur && BULLET.test(l)) {
        push(cur);
        cur = '';
      }
      cur = joinLines(cur, l.replace(BULLET, ''));
      if (breakAfter && breakAfter(l, i)) {
        push(cur);
        cur = '';
      }
    });
    push(cur);
  };
  if (/\n[ \t]*\n/.test(text)) {
    for (const chunk of text.split(/\n[ \t]*\n+/)) joinAll(chunk.split('\n').map((l) => l.trim()).filter(Boolean));
    return mendBreaks(out);
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const wide = quantile(lines.map((l) => l.length), 0.9);
  const hardWrapped = lines.length >= 4 && wide <= 110 && lines.filter((l) => l.length > wide * 0.6).length > lines.length * 0.5;
  if (hardWrapped) joinAll(lines, (l) => SENTENCE_END.test(l) && l.length < wide * 0.75);
  else for (const l of lines) push(l.replace(BULLET, ''));
  return out;
}

// A blank line in the middle of a sentence (OCR does this with wide line spacing): the paragraph goes on when the
// next one starts in lower case and this one does not end a sentence.
function mendBreaks(blocks) {
  const out = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && !TERMINAL.test(last.text) && LOWER_START.test(b.text)) last.text = joinLines(last.text, b.text);
    else out.push({ ...b });
  }
  return out;
}

// ---- editor -> segments --------------------------------------------------------------------------------------------

export const blocksToText = (blocks) => blocks.map((b) => b.text).join('\n\n');

export function looksLikeHeading(t) {
  return t.length <= 90 && !TERMINAL.test(t) && !/[,]$/.test(t) && /^[\p{Lu}\d]/u.test(t) && t.split(/\s+/).length <= 12;
}

// The editor's text: paragraphs are separated by a blank line (a single line break inside one is a space).
export function parseEditor(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).reduce((a, b) => joinLines(a, b), ''))
    .filter((p) => p && (LETTER.test(p) || /\d/.test(p)))
    .map((p) => ({ text: p, heading: looksLikeHeading(p) }));
}

let segmenter = null;
function sentences(text) {
  try {
    if (!segmenter && typeof Intl !== 'undefined' && Intl.Segmenter) segmenter = new Intl.Segmenter('tr', { granularity: 'sentence' });
  } catch { segmenter = null; }
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment.trim()).filter(Boolean);
  return (text.match(/[^.!?…]+(?:[.!?…]+["'’”»)\]]*|$)/g) || [text]).map((s) => s.trim()).filter(Boolean);
}

// A sentence longer than `max` characters is cut at its last comma, semicolon or colon before the limit (else a
// space), so that one highlight never covers half a page.
function splitLong(s, max = 320) {
  const out = [];
  let rest = s;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
    if (cut < max * 0.4) cut = head.lastIndexOf(' ');
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export const PAUSES = { sentence: 0.3, paragraph: 0.65, heading: 0.85 };

// blocks -> segments {text (shown), speak (read), pause (seconds after it), block (index), heading}.
// Fragments under MIN characters ("Dr.", "1.", "vb.") join the next sentence: the sentence splitter breaks there.
export function segment(blocks, MIN = 40) {
  const segs = [];
  blocks.forEach((b, bi) => {
    const parts = b.heading ? [b.text] : sentences(b.text).flatMap((s) => splitLong(s));
    const merged = [];
    for (const p of parts) {
      const last = merged[merged.length - 1];
      if (last !== undefined && last.length < MIN) merged[merged.length - 1] = `${last} ${p}`;
      else merged.push(p);
    }
    if (merged.length > 1 && merged[merged.length - 1].length < MIN / 2) {
      const tail = merged.pop();
      merged[merged.length - 1] += ` ${tail}`;
    }
    merged.forEach((text, k) => {
      const last = k === merged.length - 1;
      const pause = b.heading ? PAUSES.heading : last ? PAUSES.paragraph : PAUSES.sentence;
      segs.push({ text, speak: speakable(text), pause, block: bi, heading: !!b.heading });
    });
  });
  if (segs.length) segs[segs.length - 1].pause = 0.4;
  return segs;
}

// What is shown stays; what is read loses links, citation numbers like [12] or [3-5], and bullets.
export function speakable(text) {
  return text
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+\.\S+/gi, ' ')
    .replace(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g, '')
    .replace(/[•·▪▫■□●○◦‣⁃►▶➢➤✓✔∙]/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- numbers for the page ------------------------------------------------------------------------------------------

export const countWords = (text) => (text.match(/[\p{L}\d]+(?:['’][\p{L}]+)?/gu) || []).length;

// How much there is to say: characters, with numbers counted as the words they become ("52.000" is "elli iki bin").
export const spokenChars = (text) => text.length + 2.5 * (text.match(/\d/g) || []).length;

// A long document in parts of at most `max` spoken characters, cut between paragraphs. A heading in the last fifth
// of a part starts the next one, so parts tend to begin at a chapter. A paragraph longer than a part is one part.
// -> [{blocks, chars, from, to, title}] (from / to: first and last page, when the blocks know their page)
export function splitParts(blocks, max) {
  const parts = [];
  let cur = [];
  let size = 0;
  const close = () => {
    if (!cur.length) return;
    const pages = cur.map((b) => b.page).filter(Boolean);
    const head = cur.find((b) => b.heading);
    const title = (head ? head.text : cur[0].text).replace(/\s+/g, ' ').slice(0, 60);
    parts.push({ blocks: cur, chars: size, from: pages[0] || 0, to: pages[pages.length - 1] || 0, title });
    cur = [];
    size = 0;
  };
  for (const b of blocks) {
    const n = spokenChars(b.text) + 2;
    if (cur.length && (size + n > max || (b.heading && size > max * 0.8))) close();
    cur.push(b);
    size += n;
  }
  close();
  return parts;
}

// Seconds of speech for a number of characters of written text, at speed 1: about 14 characters a second with the
// pauses, from Ahenk Cep's chunker (18 letters a second of speech) and the page's pauses.
export const CHARS_PER_SECOND = 14;
export const speechSeconds = (chars, speed = 1) => chars / (CHARS_PER_SECOND * speed);
