#!/usr/bin/env python3
"""Adversarial parity corpora, beside corpus.py: inputs built to break a translation rather than to look like text.

    python3 tools/parity/adversarial.py --out DIR --kind KIND [--n N] [--seed S]

DIR/corpus.jsonl in corpus.py's format ({"id", "text", "speed"}, id "adv.<kind>:<seed>:<i>"), for reference.py
(or pyodide_ref.mjs) and check.mjs as usual. Kinds:
  chars       short strings (1-30 pieces) of the characters and fragments the normalizer's regexes care about,
              packed without spaces so that word bounds, lookbehinds and context windows collide
  long        the same, 40-300 pieces, at speeds from 1/180 up (chunk limits from 1 to 250)
  surrogates  lone surrogates around characters normalize() deletes (ZWSP, ZWJ, BOM, U+E000...): Python keeps two
              such surrogates as two code points where a JS string would join them into one character
  speeds      speed given as a string, as float() reads it (Unicode digits and spaces, underscores, inf, nan)
  big         a few inputs of N characters (default 30000; the Python is quadratic on some, so keep N modest)
Speeds under 1/180 are never generated: Python's chunk() never returns there (the JS port throws).
"""

from __future__ import annotations

import argparse
import json
import os
import random

DIGITS = list('0123456789') * 4 + ['٣', '۴', '०', '５', '\U0001d7d7', '¹', '½', 'Ⅻ', '٠', '૦']
SEPARATORS = ['.', ',', ':', '/', '-', '–', '—', "'", '’', ' ', ' ', ' ', '\t', '\n', '\xa0', '\x1c', '\x85',
              '\u2028', '\u3000', '\u202f', '\r', '\x0b']
SYMBOLS = list('%‰₺$€£¥₽°²³x×*+=&#@§№~≈±()"!?;…[]\\|•_<>^{}')
LETTERS = list('aeiıoöuükmnrsştdcçgğyzbphvfjlâîû') + list('AEIİOÖUÜKLMNRSŞTDCÇGĞYZBPHVFXWQ') + [
    'ſ', '\u212a', 'ß', 'Σ', 'ʰ', '\u0307', '\u0301', 'ﬁ', 'ǅ', 'Ω', 'я', 'Ж', '\u0345', 'ª', 'ı\u0307', 'i\u0307']
FRAGMENTS = [
    'TL', 'TRY', 'USD', 'km', 'kg', 'km/s', 'km/sa', 'm²', 'cm³', 'mi', 'mı', 'da', 'de', 'misiniz', 'müdür', 'No',
    'NO', 'Nu', 'Dr', 'Prof', 'Sn', 'sayın', 'www', '.com', '.tr', '.com.tr', 'saat', 'bin', 'milyon', 'milyar',
    'yüzde', 'arası', 'arasında', 'ila', 'nolu', "no'lu", 'Mah', 'Mah.', 'Sok', 'Cad.', 'IV', 'XII', 'MCM', 'TR',
    'ABD', 'NATO', 'SGK', 'vs', 'vb', 'vb.', 'http://', 'https://', 'e-posta', '@x.com', 'Kat', 'Daire', 'D', 'Tel',
    'GSM', 's.', 'c.', 'Google', 'iPhone', 'COVID', 'GPT', 'MP3', 'H2O', "'te", "'de", "'DA", "'üncü", "'nci",
    "'si", "'nın", "'ye", 'lar', 'larda', 'lik', 'Kasım', 'Ocak', 'maç', 'skor', 'yendi', 'kodu', 'numara', 'hesap',
    'kart', 'sayısı', 'kişi', 'Lig', 'Murat', 'yüzyıl', 'Madde', 'Louis', 'kontrol', 'dakika', 'derece', 'metre',
    'lira', 'kuruş', 'sent', 'oran', 'faiz', 'puan', '444', '0532', '+90', '(212)', 'TR33', '34 ABC', '06', '1923',
    '2026', '19.05.1919', '14:30', '09.30', '%15', '1.250,75', '3,5', '1.5', '10²', '0x1F', '24/7', '3/4', '12/4',
    '1,2,3', '1.2.3', '3.x', '-5', '−5', '5-10', '2023-24']
POOLS = ((DIGITS, 30), (SEPARATORS, 22), (SYMBOLS, 10), (LETTERS, 18), (FRAGMENTS, 20))
LONG_SPEEDS = (1.0, 0.8, 1.3, 1.4, 0.5, 0.75, 1.1, 1.25, 1.5, 2.0, 0.3, 0.0123, 1 / 180, 0.00556, 0.1, 3.7)

HIGH = ['\ud800', '\ud83d', '\udbff', '\ud835', '\ud801']
LOW = ['\udc00', '\ude00', '\udfff', '\udc37', '\udd1e']
DELETED = ['\u200b', '\u200c', '\u200d', '\ufeff', '\ue000', '#', ' ', '\t', '\xa0', '\u202f', '…', '’', '–', '—', '\n',
           '!!', '??', ' ,', ' .']
TOKENS = ['a', 'B', 'ş', 'İ', 'I', '5', '12', '3,5', '1.500', 'TL', '%', '₺', 'km', "'de", "'DA", 'mi', 'da', 'ABD',
          'NATO', 'x', '²', '°C', '/', '-', '.', ',', ':', '😀', '🇹🇷', '\U0001d400', '\U00010000', '٣', '०', 'Σ',
          'ς', 'σ', 'ǅ', 'ß', 'www', '.com', '@', 'Dr.', 'I.', 'V.', 'XIV.', '2.', 'Mah.', '34728', 'Kadıköy',
          'saat', '14.30', '10:00']

SPEED_STRINGS = ['1', '1.0', '0.8', ' 1.4 ', '\u30001.5\u3000', '\xa01.5', '\x851.5', '\x1c1.5', '1.5\x1f',
                 '\x0b1.5\x0c', '١.٥', '١٫٥', '１.５', '１e１', '\U0001d7d7', '٣_٣', '١e2', '+١', '1_0.5', '1__0', '_1',
                 '1_', '1_e5', '1e_5', 'inf', '-inf', '+INFINITY', 'nan', '-nan', 'ＩＮＦ', 'nan\u3000', '1e400', '.5',
                 '5.', '1.e5', '0x10', '1 2', '- 1', '−1', '1²', 'ⅰ', '\x85', ' ', '', '1.5\x7f', '1\x00', '\ud800',
                 '\U0001ccf5', '\U00010d43', '٣.٣e-١', '\u2028 2 \u2029']
SPEED_TEXTS = ['a' * 300, 'Bugün hava çok güzel, yarın da 5 TL ile çarşıya gideceğiz. ' * 6]


def canonical(text):
    """The text as both sides read it back from JSON (an escaped surrogate pair becomes one code point)."""
    return json.loads(json.dumps(text))


def packed(rng, sizes):
    return ''.join(rng.choice(rng.choices([p for p, _ in POOLS], [w for _, w in POOLS])[0])
                   for _ in range(rng.choice(sizes)))


def gen_chars(rng):
    while True:
        yield packed(rng, (1, 2, 3, 4, 6, 8, 10, 14, 20, 30)) + ('\n' if rng.random() < 0.1 else ''), 1.0


def gen_long(rng):
    while True:
        yield packed(rng, (40, 60, 90, 130, 200, 300)), rng.choice(LONG_SPEEDS)


def gen_surrogates(rng):
    while True:
        parts = []
        for _ in range(rng.randint(1, 12)):
            r = rng.random()
            if r < 0.3:
                parts.append(rng.choice(HIGH) + ''.join(rng.choice(DELETED) for _ in range(rng.randint(1, 3)))
                             + rng.choice(LOW))
            elif r < 0.4:
                parts.append(rng.choice(HIGH + LOW))
            elif r < 0.5:
                parts.append(rng.choice(DELETED))
            else:
                parts.append(rng.choice(TOKENS))
        yield rng.choice(['', ' ']).join(parts), rng.choice([1.0, 1.0, 0.8, 1.4])


def gen_speeds(rng):
    for s in SPEED_STRINGS:
        for t in SPEED_TEXTS:
            yield t, s


def gen_big(n):
    yield from (('1.' * (n // 2) + '1', 1.0), ('a' * n, 1.0), ('ABC ' * (n // 4), 1.0), ('a.com/' + 'x' * n, 1.0),
                ('a' + '.b' * (n // 2) + '.com', 1.0), ('-' * n, 1.0), ('a' + ' ' * n + 'b', 1.0),
                ('1,' * (n // 2) + '1', 1.0), ('1 - ' * (n // 4) + '2', 1.0), ('Bugün 5 TL verdim. ' * (n // 19), 1.0),
                ("a'" * (n // 2), 1.0), ('a' * n + '@b.com', 1.0), ('a.' * (n // 2) + 'a@b.com', 1.0),
                ('1 ' * (n // 2), 1.0), ('\n' * n, 1.0), ('X1-' * (n // 3), 1.0), ('A1' * (n // 2), 1.0),
                ('I. ' * (n // 3) + 'Ali', 1.0), ('0532 123 45 67 ' * (n // 15), 1.0), ('%5 ' * (n // 3), 1.0),
                ('a – b ' * (n // 6), 1.0), ('x²' * (n // 2), 1.0))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', required=True, help='directory for corpus.jsonl')
    ap.add_argument('--kind', required=True, choices=('chars', 'long', 'surrogates', 'speeds', 'big'))
    ap.add_argument('--n', type=int, default=None, help='cases (big: characters per case)')
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args(argv)
    rng = random.Random(f'{a.kind}:{a.seed}')
    if a.kind == 'big':
        gen, n = gen_big(a.n or 30000), None
    elif a.kind == 'speeds':
        gen, n = gen_speeds(rng), None
    else:
        gen = {'chars': gen_chars, 'long': gen_long, 'surrogates': gen_surrogates}[a.kind](rng)
        n = a.n or {'chars': 100000, 'long': 30000, 'surrogates': 20000}[a.kind]
    os.makedirs(a.out, exist_ok=True)
    seen, rows = set(), []
    for text, speed in gen:
        text = canonical(text)
        if (text, speed) in seen:
            continue
        seen.add((text, speed))
        rows.append({'id': f'adv.{a.kind}:{a.seed}:{len(rows):06d}', 'text': text, 'speed': speed})
        if n is not None and len(rows) >= n:
            break
    path = os.path.join(a.out, 'corpus.jsonl')
    with open(path, 'w', encoding='utf-8') as f:
        for r in rows:
            try:
                line = json.dumps(r, ensure_ascii=False)
                line.encode('utf-8')
            except UnicodeEncodeError:  # a lone surrogate: \u escapes, which JSON.parse reads back
                line = json.dumps(r, ensure_ascii=True)
            f.write(line + '\n')
    print(json.dumps({'corpus': path, 'kind': a.kind, 'cases': len(rows)}))


if __name__ == '__main__':
    main()
