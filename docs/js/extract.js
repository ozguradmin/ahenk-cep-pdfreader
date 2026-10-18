// A file in, paragraphs out: {kind, pages, blocks: [{text, heading, page?}], scanned, suspect, pdf?}.
// PDF through pdf.js (its text layer, laid out by js/text.js), DOCX / ODT / EPUB by reading their XML (fflate unzips),
// HTML, plain text and Markdown directly; images and scanned PDFs through OCR (js/ocr.js, loaded only then).
// The libraries are imported the first time they are needed, so the page itself stays small.

import { CDN } from './config.js';
import { cleanText, fixTurkish, layoutPages, plainBlocks } from './text.js';

let pdfjsP = null;
export function pdfjs() {
  if (!pdfjsP) {
    pdfjsP = import(`${CDN.pdfjs}legacy/build/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${CDN.pdfjs}legacy/build/pdf.worker.min.mjs`;
      return lib;
    });
    pdfjsP.catch(() => { pdfjsP = null; });
  }
  return pdfjsP;
}

let fflateP = null;
function fflate() {
  if (!fflateP) {
    fflateP = import(CDN.fflate);
    fflateP.catch(() => { fflateP = null; });
  }
  return fflateP;
}

export class ExtractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const EXT = {
  pdf: 'pdf', docx: 'docx', docm: 'docx', dotx: 'docx', odt: 'odt', ott: 'odt', epub: 'epub',
  html: 'html', htm: 'html', xhtml: 'html', txt: 'txt', text: 'txt', md: 'md', markdown: 'md', srt: 'txt', csv: 'txt',
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', bmp: 'image', gif: 'image', tif: 'image', tiff: 'image',
  doc: 'doc', rtf: 'rtf', pages: 'pages',
};

// What a file is: its first bytes win over its name (a .pdf that is really a Word file still opens).
async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ascii = String.fromCharCode(...head);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ascii.startsWith('%PDF')) return 'pdf';
  if (ascii.startsWith('PK')) return ['docx', 'odt', 'epub'].includes(EXT[ext]) ? EXT[ext] : 'zip';
  if (head[0] === 0xd0 && head[1] === 0xcf) return 'doc';
  if (ascii.startsWith('{\\rtf')) return 'rtf';
  if (/^image\//.test(file.type) || EXT[ext] === 'image') return 'image';
  return EXT[ext] || 'txt';
}

export async function extractFile(file, { onProgress = () => {}, askPassword = async () => null } = {}) {
  let kind = await sniff(file);
  if (kind === 'doc') throw new ExtractError('doc');
  if (kind === 'rtf' || kind === 'pages') throw new ExtractError(kind);
  const buf = kind === 'image' ? null : new Uint8Array(await file.arrayBuffer());
  if (kind === 'zip') kind = await zipKind(buf);
  let out;
  if (kind === 'pdf') out = await extractPdf(buf, onProgress, askPassword);
  else if (kind === 'docx') out = await extractDocx(buf);
  else if (kind === 'odt') out = await extractOdt(buf);
  else if (kind === 'epub') out = await extractEpub(buf, onProgress);
  else if (kind === 'html') out = { blocks: htmlBlocks(parseHtml(decodeText(buf))) };
  else if (kind === 'image') {
    const { ocrImage } = await import('./ocr.js');
    out = { blocks: await ocrImage(file, onProgress), ocr: true };
  } else if (kind === 'md') out = { blocks: plainBlocks(markdownToText(decodeText(buf))) };
  else out = { blocks: plainBlocks(decodeText(buf)) };
  // scanned / suspect: only a PDF's text layer can be missing or broken (js/text.js quality)
  return { kind, pages: null, scanned: false, suspect: false, ocr: false, ...out };
}

async function zipKind(buf) {
  const dir = zipNames(buf);
  if (dir.includes('word/document.xml')) return 'docx';
  if (dir.includes('META-INF/container.xml')) return 'epub';
  if (dir.includes('content.xml')) return 'odt';
  throw new ExtractError('unknown');
}

// File names in a zip's central directory (enough to tell DOCX, ODT and EPUB apart).
function zipNames(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const names = [];
  for (let k = 0; k < count && o + 46 <= buf.length; k++) {
    if (v.getUint32(o, true) !== 0x02014b50) break;
    const n = v.getUint16(o + 28, true);
    const m = v.getUint16(o + 30, true);
    const c = v.getUint16(o + 32, true);
    names.push(dec.decode(buf.subarray(o + 46, o + 46 + n)));
    o += 46 + n + m + c;
  }
  return names;
}

async function unzip(buf, want) {
  const { unzipSync, strFromU8 } = await fflate();
  let files;
  try {
    files = unzipSync(buf, { filter: (f) => want(f.name) });
  } catch (e) {
    throw new ExtractError('broken', String(e && e.message));
  }
  const text = {};
  for (const [name, bytes] of Object.entries(files)) text[name] = strFromU8(bytes);
  return text;
}

// ---- text files ------------------------------------------------------------------------------------------------------

// UTF-8 when it is valid UTF-8 (or has a BOM), UTF-16 with its BOM, otherwise Windows-1254 (Turkish).
export function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('windows-1254').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

export function markdownToText(md) {
  return md
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, '\n$1\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '• ')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '\n');
}

// ---- PDF ---------------------------------------------------------------------------------------------------------------

async function extractPdf(data, onProgress, askPassword) {
  const lib = await pdfjs();
  const task = lib.getDocument({
    data,
    cMapUrl: `${CDN.pdfjs}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN.pdfjs}standard_fonts/`,
    isEvalSupported: false,
  });
  task.onPassword = async (update, reason) => {
    const pw = await askPassword(reason === lib.PasswordResponses.INCORRECT_PASSWORD);
    if (pw === null || pw === undefined) task.destroy();
    else update(pw);
  };
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') throw new ExtractError('password');
    if (task.destroyed) throw new ExtractError('password');
    throw new ExtractError('broken', String(e && e.message));
  }
  const pages = [];
  const n = doc.numPages;
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const [a, b, c, d, x, y] = it.transform;
      // text running up or down the margin (journal sidebars, stamps) is not part of the reading order
      if (Math.abs(b) > Math.abs(a) * 0.5 && it.str.trim()) continue;
      items.push({ str: cleanText(it.str), x, y, w: it.width, h: Math.hypot(c, d) || it.height, eol: it.hasEOL });
    }
    pages.push({ items });
    page.cleanup();
    onProgress({ stage: 'pdf', done: i, total: n });
  }
  const laid = layoutPages(pages);
  return { pages: n, pdf: doc, ...laid };
}

// ---- DOCX ----------------------------------------------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new ExtractError('broken', 'XML');
  return doc;
}

async function extractDocx(buf) {
  const files = await unzip(buf, (n) => n === 'word/document.xml' || n === 'word/styles.xml');
  if (!files['word/document.xml']) throw new ExtractError('broken', 'word/document.xml');
  const doc = parseXml(files['word/document.xml']);
  // Built-in styles keep their English name ("heading 1") whatever the Word language; their ids do not ("Balk1").
  const headingStyles = new Set();
  if (files['word/styles.xml']) {
    const styles = parseXml(files['word/styles.xml']);
    for (const s of styles.getElementsByTagNameNS(W, 'style')) {
      const name = s.getElementsByTagNameNS(W, 'name')[0]?.getAttributeNS(W, 'val') || '';
      if (/^(heading \d|title|subtitle|başlık|baslik)/i.test(name)) headingStyles.add(s.getAttributeNS(W, 'styleId'));
    }
  }
  const blocks = [];
  const runText = (node) => {
    let s = '';
    for (const ch of node.childNodes) {
      if (ch.nodeType !== 1) continue;
      switch (ch.localName) {
        case 't': s += ch.textContent; break;
        case 'tab': case 'br': case 'cr': s += ' '; break;
        case 'noBreakHyphen': s += '-'; break;
        case 'sym': break;
        case 'del': case 'delText': case 'instrText': case 'pPr': case 'rPr': case 'txbxContent':
        case 'footnoteReference': case 'endnoteReference': case 'commentReference': case 'fldData': break;
        default: s += runText(ch);
      }
    }
    return s;
  };
  const para = (p) => {
    const text = fixTurkish(cleanText(runText(p))).trim();
    if (!text) return;
    const pPr = Array.from(p.childNodes).find((c) => c.localName === 'pPr');
    const styleId = pPr && Array.from(pPr.childNodes).find((c) => c.localName === 'pStyle')?.getAttributeNS(W, 'val');
    const outline = pPr && Array.from(pPr.childNodes).some((c) => c.localName === 'outlineLvl');
    blocks.push({ text, heading: (styleId && headingStyles.has(styleId)) || outline || /^(heading|title|başlık|balk)/i.test(styleId || '') });
  };
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType !== 1) continue;
      if (ch.localName === 'p') para(ch);
      else if (ch.localName === 'tbl') table(ch);
      else if (ch.localName === 'sectPr') continue;
      else walk(ch);
    }
  };
  // a table row is read as one paragraph, its cells separated by commas
  const table = (tbl) => {
    for (const tr of Array.from(tbl.childNodes).filter((c) => c.localName === 'tr')) {
      const cells = Array.from(tr.childNodes).filter((c) => c.localName === 'tc').map((tc) => {
        const ps = Array.from(tc.getElementsByTagNameNS(W, 'p'));
        return ps.map((p) => cleanText(runText(p)).trim()).filter(Boolean).join(' ');
      }).filter(Boolean);
      if (cells.length) blocks.push({ text: fixTurkish(cells.join(', ')), heading: false });
    }
  };
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  if (body) walk(body);
  return { blocks };
}

// ---- ODT -------------------------------------------------------------------------------------------------------------------

async function extractOdt(buf) {
  const files = await unzip(buf, (n) => n === 'content.xml');
  if (!files['content.xml']) throw new ExtractError('broken', 'content.xml');
  const doc = parseXml(files['content.xml']);
  const blocks = [];
  const inline = (node) => {
    let s = '';
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) s += ch.data;
      else if (ch.nodeType === 1) {
        const n = ch.localName;
        if (n === 's') s += ' '.repeat(Number(ch.getAttribute('text:c')) || 1);
        else if (n === 'tab' || n === 'line-break') s += ' ';
        else if (n === 'note' || n === 'annotation' || n === 'tracked-changes' || n === 'soft-page-break') continue;
        else s += inline(ch);
      }
    }
    return s;
  };
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType !== 1) continue;
      const n = ch.localName;
      if (n === 'p' || n === 'h') {
        const text = fixTurkish(cleanText(inline(ch))).trim();
        if (text) blocks.push({ text, heading: n === 'h' });
      } else if (n === 'table-row') {
        const cells = Array.from(ch.childNodes).filter((c) => c.localName === 'table-cell')
          .map((c) => cleanText(inline(c)).trim()).filter(Boolean);
        if (cells.length) blocks.push({ text: fixTurkish(cells.join(', ')), heading: false });
      } else if (n !== 'tracked-changes' && n !== 'annotation' && n !== 'note') walk(ch);
    }
  };
  const body = doc.getElementsByTagName('office:text')[0] || doc.documentElement;
  walk(body);
  return { blocks };
}

// ---- EPUB and HTML ---------------------------------------------------------------------------------------------------------

const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'blockquote', 'pre', 'li', 'ul', 'ol',
  'dl', 'dt', 'dd', 'figure', 'figcaption', 'table', 'tr', 'td', 'th', 'caption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'body']);
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'math', 'head', 'nav', 'button', 'select', 'textarea', 'iframe']);

export function parseHtml(text, type = 'text/html') {
  let doc = new DOMParser().parseFromString(text, type);
  if (type !== 'text/html' && doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(text, 'text/html');
  return doc;
}

// Block-level elements end paragraphs; footnote markers (numeric <sup>, EPUB noterefs) and footnotes are left out.
export function htmlBlocks(doc) {
  const root = doc.body || doc.documentElement;
  const blocks = [];
  let buf = '';
  const flush = (heading = false) => {
    const t = fixTurkish(cleanText(buf)).replace(/\s+/g, ' ').trim();
    if (t) blocks.push({ text: t, heading });
    buf = '';
  };
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        buf += ch.data;
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const tag = ch.localName.toLowerCase();
      if (SKIP.has(tag)) continue;
      const etype = ch.getAttribute('epub:type') || ch.getAttribute('role') || '';
      if (/noteref|footnote|endnote|rearnote|pagebreak|doc-noteref|doc-footnote|doc-pagebreak/.test(etype)) continue;
      if (tag === 'sup' && /^\s*[\d*†‡,\s-]+\s*$/.test(ch.textContent)) continue;
      if (tag === 'br') {
        buf += ' ';
        continue;
      }
      if (tag === 'img') continue;
      if (BLOCK.has(tag)) {
        flush();
        walk(ch);
        flush(/^h[1-6]$/.test(tag));
      } else {
        walk(ch);
      }
    }
  };
  walk(root);
  flush();
  return blocks;
}

async function extractEpub(buf, onProgress) {
  const files = await unzip(buf, (n) => /\.(xml|opf|x?html?|xht)$/i.test(n));
  const container = files['META-INF/container.xml'];
  if (!container) throw new ExtractError('broken', 'container.xml');
  const opfPath = parseXml(container).getElementsByTagName('rootfile')[0]?.getAttribute('full-path');
  if (!opfPath || !files[opfPath]) throw new ExtractError('broken', 'opf');
  const opf = parseXml(files[opfPath]);
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const items = new Map();
  for (const it of opf.getElementsByTagName('item')) items.set(it.getAttribute('id'), it);
  const spine = Array.from(opf.getElementsByTagName('itemref')).filter((r) => r.getAttribute('linear') !== 'no');
  const blocks = [];
  let k = 0;
  for (const ref of spine) {
    k += 1;
    const it = items.get(ref.getAttribute('idref'));
    if (!it || /\bnav\b/.test(it.getAttribute('properties') || '')) continue;
    const path = decodeURIComponent(new URL(it.getAttribute('href'), `https://x/${dir}`).pathname.slice(1));
    const html = files[path];
    if (!html) continue;
    blocks.push(...htmlBlocks(parseHtml(html, 'application/xhtml+xml')));
    onProgress({ stage: 'epub', done: k, total: spine.length });
  }
  return { blocks };
}
