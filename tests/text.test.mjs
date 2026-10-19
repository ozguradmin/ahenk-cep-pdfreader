// The text side of the page (docs/js/text.js): PDF layout, plain text, segments. Run: node --test tests/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cleanText, fixTurkish, joinLines, layoutPages, parseEditor, plainBlocks, quality, segment, speakable, splitParts,
} from '../docs/js/text.js';

// one pdf.js-like text item per line of a page: [text, x, y, width, size]
const page = (lines) => ({ items: lines.map(([str, x, y, w, h = 10]) => ({ str, x, y, w, h, eol: true })) });

test('hyphenated words are mended, real hyphens kept', () => {
  assert.equal(joinLines('kitap-', 'ların'), 'kitapların');
  assert.equal(joinLines('kitap\u2010', 'ların'), 'kitapların');
  assert.equal(joinLines('Doğu-', 'Batı'), 'Doğu-Batı');
  assert.equal(joinLines('bir', 'iki'), 'bir iki');
});

test('Icelandic letters from old Turkish fonts are mapped back', () => {
  assert.equal(fixTurkish('Ýstanbul\'da þimdi saðanak yaðmur yaðýyor.'), 'İstanbul\'da şimdi sağanak yağmur yağıyor.');
  assert.equal(fixTurkish('Þu an ı, ş ve ğ doğru.'), 'Þu an ı, ş ve ğ doğru.');
});

test('ligatures and invisible characters', () => {
  assert.equal(cleanText('ﬁkir\u200B ve ﬂüt'), 'fikir ve flüt');
});

test('paragraphs by gap, running headers and page numbers dropped, paragraph continued across pages', () => {
  const pages = [];
  for (let n = 1; n <= 3; n++) {
    pages.push(page([
      ['Ahenk Dergisi', 200, 800, 100, 8],
      ['Birinci satır burada uzunca bir cümleyle', 50, 700, 400],
      ['devam ediyor ve sonunda bitiyor.', 50, 688, 250],
      ['Yeni paragraf boşluktan sonra başlıyor ve', 50, 660, 400],
      [['sayfanın sonunda yarım kalı-', 'ikinci sayfada da yarım kalı-', 'burada bitiyor.'][n - 1], 50, 648, 400],
      [String(n), 250, 40, 6, 8],
    ]));
    const first = ['', 'yor ve yeni sayfada sürüyor.', 'Üçüncü sayfa yeni bir paragrafla başlıyor.'][n - 1];
    if (n > 1) pages[n - 1].items.splice(1, 2, { str: first, x: 50, y: 700, w: 250, h: 10, eol: true });
  }
  const { blocks } = layoutPages(pages);
  const texts = blocks.map((b) => b.text);
  assert.ok(!texts.some((t) => t.includes('Ahenk Dergisi')), 'running header kept');
  assert.ok(!texts.some((t) => /^\d+$/.test(t)), 'page number kept');
  assert.equal(texts[0], 'Birinci satır burada uzunca bir cümleyle devam ediyor ve sonunda bitiyor.');
  assert.equal(texts[1], 'Yeni paragraf boşluktan sonra başlıyor ve sayfanın sonunda yarım kalıyor ve yeni sayfada sürüyor.');
});

test('a larger font is a heading', () => {
  const { blocks } = layoutPages([page([
    ['Giriş', 50, 760, 60, 18],
    ['Metin burada başlıyor ve uzun bir satır olarak', 50, 730, 400],
    ['devam ediyor.', 50, 718, 100],
  ])]);
  assert.equal(blocks[0].text, 'Giriş');
  assert.equal(blocks[0].heading, true);
  assert.equal(blocks[1].heading, false);
});

test('scanned and garbled text layers are recognised', () => {
  assert.equal(quality('', 3).scanned, true);
  assert.equal(quality('Bu cümle düzgün bir Türkçe cümledir ve okunabilir. '.repeat(5), 1).suspect, false);
  assert.equal(quality('Xkzrt bvnmql qwrtz pkdfgh lkjhg xcvbn mnbvc. '.repeat(5), 1).suspect, true);
});

test('plain text: blank lines, hard wrap, mid-sentence breaks', () => {
  assert.deepEqual(plainBlocks('Bir.\n\nİki.').map((b) => b.text), ['Bir.', 'İki.']);
  assert.deepEqual(plainBlocks('Bu cümle bölünmüş\n\nve devam ediyor.').map((b) => b.text), ['Bu cümle bölünmüş ve devam ediyor.']);
  const wrapped = 'Bu satır sabit genişlikte kırılmış bir metnin ilk satırıdır ve\nbu da ikinci satırdır, cümle burada devam etmekte ve sürmektedir\nve burada bitiyor.\nYeni paragraf burada başlıyor ve yine uzun bir satırla devam\nedip bitiyor.';
  assert.equal(plainBlocks(wrapped).length, 2);
});

test('segments: short fragments join, pauses by place', () => {
  const segs = segment(parseEditor('Başlık\n\nDr. Ayşe geldi. Toplantı saat 09:30\'da başladı ve uzun sürdü. Bitti.'));
  assert.equal(segs[0].heading, true);
  assert.equal(segs[0].text, 'Başlık');
  assert.ok(segs[1].text.startsWith('Dr. Ayşe geldi.'), segs[1].text);
  assert.ok(segs.every((s) => s.pause > 0));
  assert.equal(segs.at(-1).text.endsWith('Bitti.'), true);
});

test('long sentences are cut at a comma', () => {
  const long = `${'kelime '.repeat(40)}virgül, ${'sözcük '.repeat(40)}son.`;
  const segs = segment([{ text: long, heading: false }]);
  assert.ok(segs.length >= 2);
  assert.ok(segs.every((s) => s.text.length <= 330));
});

test('links and citation numbers are not read', () => {
  assert.equal(speakable('Bkz. [12] ve [3–5], ayrıca https://ornek.com/a?b=1 adresi.'), 'Bkz. ve, ayrıca adresi.');
});

test('long documents split into parts between paragraphs, preferably at a heading', () => {
  const blocks = [];
  for (let c = 1; c <= 6; c++) {
    blocks.push({ text: `${c}. Bölüm`, heading: true, page: c * 10 });
    for (let k = 0; k < 10; k++) blocks.push({ text: 'Bu bir paragraf ve yüz karaktere yakın uzunlukta, sırf bölümleri sınamak için yazılmış bir cümle.', heading: false, page: c * 10 + k });
  }
  const parts = splitParts(blocks, 2500);
  assert.ok(parts.length >= 3);
  assert.deepEqual(parts.flatMap((p) => p.blocks), blocks, 'nothing lost or reordered');
  assert.ok(parts.every((p) => p.chars <= 2500 || p.blocks.length === 1));
  assert.ok(parts.slice(1).every((p) => p.blocks[0].heading), 'parts start at a chapter');
  assert.equal(parts[0].from, 10);
  assert.equal(splitParts([{ text: 'Kısa.', heading: false }], 2500).length, 1);
});

test('a book with single line breaks: linear, and its paragraphs are kept apart', () => {
  const line = 'Bu satır bir kitabın sayfasından alınmış, yetmiş karaktere yakın bir satır';
  const body = [];
  for (let p = 0; p < 1000; p++) {
    for (let k = 0; k < 15; k++) body.push(line);
    body.push('ve paragraf burada bitiyor.');
  }
  let t0 = performance.now();
  const pasted = parseEditor(body.join('\n'));
  assert.ok(performance.now() - t0 < 1500, 'parseEditor is linear');
  assert.equal(pasted.length, 1, 'the editor joins single line breaks');
  t0 = performance.now();
  const txt = plainBlocks(`Kitabın Adı\n\n${body.join('\n')}`);
  assert.ok(performance.now() - t0 < 1500, 'plainBlocks is linear');
  assert.equal(txt.length, 1001, 'title + one block per paragraph');
  assert.ok(txt[1].text.endsWith('bitiyor.'));
  const parts = splitParts(pasted, 20000);
  assert.ok(parts.length > 50 && parts.every((p) => p.chars <= 20000), 'a paragraph longer than a part is cut');
  assert.equal(parts.map((p) => p.blocks.map((b) => b.text).join(' ')).join(' '), pasted[0].text, 'between sentences, nothing lost');
});
