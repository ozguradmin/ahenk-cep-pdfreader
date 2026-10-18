#!/usr/bin/env python3
"""Parity corpus for docs/js/front-native.js (the JavaScript port of docs/py/ahenk_front.py and trnorm).

    python3 tools/parity/corpus.py --out DIR [--fuzz N] [--seed S] [--fuzz-only]

DIR/corpus.jsonl: one case per line, {"id", "text", "speed"}. The id names its source before the first ':'
(test, bench, textbank, fixture, extra, fuzz.<generator>), so check.mjs can tell where mismatches come from.
Sources: every string of the upstream normalizer tests, the TTS benchmark sets and the VoxCPM text bank, the
fixture documents (paragraphs, sentences, multi-paragraph windows), tools/parity/extra_cases.txt (one case per
line, \\n \\t \\uXXXX escapes allowed; see extra_case below for "py:" and "speed=" lines), and with --fuzz N, N
generated cases (seeded, reproducible: the same arguments give the same file). Texts are unique (a text with a speed of
its own from extra_cases.txt: the pair); the speed is 1.0 for most cases and 0.8 / 1.3 / 1.4 for ~15%.
"""

from __future__ import annotations

import argparse
import ast
import glob
import hashlib
import html
import html.parser
import json
import os
import random
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
UPSTREAM = os.environ.get('AHENK_UPSTREAM', '/home/user/ozguradmin/ahenk-turkish-tts')
FIXTURES = os.environ.get(
    'AHENK_FIXTURES',
    '/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad/fixtures'
)
EXTRA = os.path.join(HERE, 'extra_cases.txt')

sys.dont_write_bytecode = True  # never leave __pycache__ in docs/py
sys.path.insert(0, os.path.join(REPO, 'docs', 'py'))
from trnorm import lexicon as L  # noqa: E402  (the fuzz draws on the lexicon the normalizer uses)
from trnorm import normalizer as N  # noqa: E402
from trnorm import numbers as NUM  # noqa: E402
from trnorm.casing import tr_lower, tr_upper  # noqa: E402

SPEEDS = (0.8, 1.3, 1.4)


# ---------------------------------------------------------------------------------------------------- base sources


def _fold(node):
    """Value of a string expression in a test: a literal, or literals joined by + and repeated by *."""
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, int)):
        return node.value
    if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Mult)):
        a, b = _fold(node.left), _fold(node.right)
        if a is None or b is None:
            return None
        try:
            v = a + b if isinstance(node.op, ast.Add) else a * b
        except TypeError:
            return None
        return v if not isinstance(v, str) or len(v) < 100_000 else None
    return None


def test_strings(path):
    """Every string in a test file: inputs, expected outputs, parametrize rows (not the parametrize arg names)."""
    tree = ast.parse(open(path, encoding='utf-8').read())
    skip = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, 'attr', None) == 'parametrize' and node.args:
            skip.add(id(node.args[0]))
    out = []
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        if isinstance(node, ast.BinOp):
            v = _fold(node)
            if isinstance(v, str):
                out.append((node.lineno, node.col_offset, v))
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            out.append((node.lineno, node.col_offset, node.value))
    out.sort(key=lambda t: (t[0], t[1]))  # source order (ast.walk is breadth-first)
    return [s for _, _, s in out]


def jsonl_texts(path, keys=('text', 'spoken', 'refs', 'alts', 'render_texts')):
    rows = []
    with open(path, encoding='utf-8') as f:
        for n, line in enumerate(f):
            if not line.strip():
                continue
            r = json.loads(line)
            rid = str(r.get('id', n))
            for k in keys:
                v = r.get(k)
                vals = v if isinstance(v, list) else [v]
                for j, s in enumerate(vals):
                    if isinstance(s, str):
                        rows.append((f'{rid}:{k}' + (f'{j}' if isinstance(v, list) else ''), s))
    return rows


class _Blocks(html.parser.HTMLParser):
    """Text of each block element, whitespace collapsed as a browser shows it; <br> is a line break."""

    BLOCK = {'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'div', 'td', 'th', 'blockquote', 'pre', 'dt', 'dd',
             'caption', 'figcaption', 'section', 'article', 'header', 'footer', 'tr', 'ul', 'ol', 'table', 'body'}
    SKIP = {'style', 'script', 'head', 'title', 'template', 'noscript'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.blocks, self.buf, self.skip = [], [], 0

    def flush(self):
        text = '\n'.join(re.sub(r'[ \t\r\n\f]+', ' ', part).strip() for part in ''.join(self.buf).split('\x00'))
        text = text.strip()
        if text:
            self.blocks.append(text)
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.flush()
        elif tag == 'br':
            self.buf.append('\x00')

    def handle_startendtag(self, tag, attrs):
        if tag == 'br':
            self.buf.append('\x00')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.flush()

    def handle_data(self, data):
        if not self.skip:
            self.buf.append(data)


_SENTENCE_END = re.compile(r'(?<=[.!?…])["\'’”»)\]]*\s+(?=\S)')


def sentences(par):
    out, pos = [], 0
    for m in _SENTENCE_END.finditer(par):
        out.append(par[pos : m.end()].strip())
        pos = m.end()
    out.append(par[pos:].strip())
    return [s for s in out if s]


def fixture_cases(path):
    p = _Blocks()
    p.feed(open(path, encoding='utf-8', errors='replace').read())
    p.close()
    p.flush()
    name = os.path.basename(path)
    out = []
    for i, par in enumerate(p.blocks):
        out.append((f'{name}:p{i}', par))
        sents = sentences(par)
        if len(sents) > 1:
            out += [(f'{name}:p{i}:s{j}', s) for j, s in enumerate(sents)]
    # multi-paragraph windows (a pasted page) and, for documents up to 64 KB, the whole text
    for w in range(0, len(p.blocks), 12):
        out.append((f'{name}:w{w}', '\n\n'.join(p.blocks[w : w + 12])))
    whole = '\n\n'.join(p.blocks)
    if len(whole.encode('utf-8')) <= 64 * 1024:
        out.append((f'{name}:all', whole))
    return out


_ESCAPE = re.compile(r'\\(n|t|r|\\|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})')


def unescape_line(s):
    def rep(m):
        e = m.group(1)
        return {'n': '\n', 't': '\t', 'r': '\r', '\\': '\\'}.get(e) or chr(int(e[1:], 16))

    return _ESCAPE.sub(rep, s)


_PY_EXPR_NODES = (ast.Expression, ast.BinOp, ast.Add, ast.Mult, ast.Constant)


def _py_expr(src):
    """The value of a str expression made of literals, + and * only ('a' + '\\n' * 40000 + 'b'): no names, no calls."""
    tree = ast.parse(src.strip(), mode='eval')
    for node in ast.walk(tree):
        if not isinstance(node, _PY_EXPR_NODES) or (isinstance(node, ast.Constant) and type(node.value) not in (str, int)):
            raise ValueError(f'extra_cases.txt: not a plain str expression: {src!r}')
    value = eval(compile(tree, '<extra_cases>', 'eval'), {'__builtins__': {}})
    if not isinstance(value, str):
        raise ValueError(f'extra_cases.txt: {src!r} is not a str')
    return value


_SPEED_LINE = re.compile(r'speed=(.*?): ?')


def extra_case(line):
    """(text, speed or None) of one extra_cases.txt line.

    "py: EXPR" is the value of a Python str expression of literals, + and * (for inputs too long to write out:
    py: '-' * 40000); "speed=JSON: TEXT" gives the case a speed of its own (a JSON number, string or false: what the
    page could pass to prepare()), TEXT being an ordinary line or a "py:" one; any other line is the text itself, with
    \\n \\t \\r \\\\ \\xNN \\uXXXX \\UXXXXXXXX escapes.
    """
    speed = None
    m = _SPEED_LINE.match(line)
    if m:
        speed = json.loads(m.group(1))
        line = line[m.end():]
    if line.startswith('py:'):
        return _py_expr(line[3:]), speed
    return unescape_line(line), speed


def base_cases():
    """(id, text, speed or None) of every non-fuzz source, in a fixed order (None: the speed base_speed() gives)."""
    out = []
    for name in ('test_normalizer.py', 'test_web_demo.py'):
        path = os.path.join(UPSTREAM, 'tests', name)
        if os.path.exists(path):
            stem = name[5:-3]
            out += [(f'test:{stem}:{i}', s) for i, s in enumerate(test_strings(path))]
    for path in sorted(glob.glob(os.path.join(UPSTREAM, 'benchmarks/tts/sets/*.jsonl'))):
        out += [(f'bench:{os.path.basename(path)[:-6]}:{k}', s) for k, s in jsonl_texts(path)]
    for path in sorted(glob.glob(os.path.join(UPSTREAM, 'tts/voxcpm/textbank/*.jsonl'))):
        out += [(f'textbank:{os.path.basename(path)[:-6]}:{k}', s) for k, s in jsonl_texts(path)]
    for path in sorted(glob.glob(os.path.join(FIXTURES, '*.html'))):
        out += [(f'fixture:{k}', s) for k, s in fixture_cases(path)]
    out = [(cid, text, None) for cid, text in out]
    if os.path.exists(EXTRA):
        with open(EXTRA, encoding='utf-8') as f:
            for n, line in enumerate(f, 1):
                line = line.rstrip('\r\n')
                if line:
                    out.append((f'extra:{n}', *extra_case(line)))
    return out


def base_speed(case_id):
    h = int(hashlib.sha1(case_id.encode('utf-8')).hexdigest()[:12], 16)
    return SPEEDS[(h // 1000) % 3] if h % 1000 < 150 else 1.0


# ---------------------------------------------------------------------------------------------------- fuzz pools

# lexicon tables as lists in a fixed order (several are sets, whose order follows PYTHONHASHSEED)
ORD_NOUNS = sorted(L.ORDINAL_CAP_NOUNS)
CAPS_WORDS = sorted(L.CAPS_WORDS)
EVAL_ACRONYMS = sorted(L.EVAL_ACRONYMS)
ABBREVIATIONS = list(L.ABBREVIATIONS)
ACRONYMS = list(L.ACRONYMS)
QUANTITY_BEFORE = sorted(L.QUANTITY_BEFORE)
BARE_SUFFIXES = sorted(L.BARE_NUMBER_SUFFIXES)
ADDRESS_NUMBER_CONTEXT = sorted(L.ADDRESS_NUMBER_CONTEXT)
ADDRESS_CONTEXT = sorted(L.ADDRESS_CONTEXT)
NAMES_FORMS = sorted(N._NAMES)  # every written form the names pass matches ("YOUTUBE", "youtube", "Youtube"...)

ND_SETS = [  # decimal digit sets (Nd): Python's \d and int() read them all
    ''.join(chr(b + i) for i in range(10))
    for b in (
        0x30, 0x660, 0x6F0, 0x7C0, 0x966, 0x9E6, 0xE50, 0xF20, 0x1040, 0x17E0, 0x1810, 0xFF10,
        0x104A0, 0x11066, 0x1D7CE, 0x1D7D8, 0x1D7F6, 0x1E950, 0x1FBF0,
        0x11F50, 0x1E4F0,  # Unicode 15.0 (Kawi, Nag Mundari)
        # Unicode 16.0 (Garay, Sunuwar, Kirat Rai, outlined, Gurung Khema, Ol Onal, Myanmar Pao): digits to a
        # browser that knows Unicode 16, unassigned to Python 3.12 / 3.13; keep them last (g_newuni takes the last 7)
        0x10D40, 0x11BF0, 0x16D70, 0x1CCF0, 0x16130, 0x1E5F1, 0x116DA,
    )
]
# code points assigned in Unicode 15.1 or 16.0, unassigned (Cn) in Pyodide's Python 3.12 (Unicode 15.0)
NEW_RANGES = [
    (0x2EBF0, 0x2EE5D), (0x2FFC, 0x2FFF), (0x31EF, 0x31EF),  # 15.1: CJK Extension I, ideographic description
    (0x10D40, 0x10D8F), (0x105C0, 0x105F3), (0x11380, 0x113E2), (0x11BC0, 0x11BF9), (0x16100, 0x16139),
    (0x16D40, 0x16D79), (0x1E5D0, 0x1E5FF), (0x13460, 0x143FA), (0x116D0, 0x116E3), (0x1CC00, 0x1CEB3),
    (0x1C89, 0x1C8A), (0xA7CB, 0xA7CD), (0xA7DA, 0xA7DC), (0x1FBCB, 0x1FBEF), (0x10EC2, 0x10EC4),
    (0x11F5A, 0x11F5A), (0x1FAE9, 0x1FAE9), (0x1FA89, 0x1FA89), (0x1FA8F, 0x1FA8F),
]
# Unicode 16.0 case pairs: Garay capital / small letters, Cyrillic tje, Latin Extended-D
NEW_CASED = [chr(c) for c in [*range(0x10D50, 0x10D66), *range(0x10D70, 0x10D86), 0x1C89, 0x1C8A, 0xA7CB, 0xA7CC,
                              0xA7CD, 0xA7DA, 0xA7DB, 0xA7DC]]
# Unicode 16.0 canonical compositions (Kirat Rai, Tulu-Tigalari, Gurung Khema) and their composed forms
NEW_COMPOSE = ['\U00016D67\U00016D67', '\U00016D63\U00016D67', '\U00016D69\U00016D67', '\U00011382\U000113C9',
               '\U00011384\U000113BB', '\U0001138B\U000113C2', '\U00011390\U000113C9', '\U000113C2\U000113C2',
               '\U000113C2\U000113B8', '\U000113C2\U000113C9', '\U0001611E\U0001611E', '\U0001611E\U00016129',
               '\U0001611E\U0001611F', '\U00016129\U0001611F', '\U0001611E\U00016120', '\U00016121\U0001611F',
               '\U00016122\U0001611F', '\U00016121\U00016120', '\U00016D68', '\U00016D6A', '\U00011383',
               '\U000113C5', '\U00016121', '\U00016128', 'a\U00016D67', '\U00016D67\u0301']
OTHER_NUMERIC = list('²³¹⁰⁴⁵⁶⁷⁸⁹₀₁₂₃½¼¾⅓⅔⅛①②③⑩⑳⑴⒈ⅠⅡⅢⅣⅫⅯⅰⅱⅲ〇一二三四五六七八九十百千万፩௰𐄇')
OTHER_NUMERIC += ['\U00010107', '\U0001D360']
WHITESPACE = [' ', ' ', ' ', '  ', '\t', '\n', '\n\n', '\r\n', '\r', '\x0b', '\x0c', '\x1c', '\x1d', '\x1e', '\x1f',
              '\x85', '\xa0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
              '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\u180e', '\ufeff',
              '\u200b', ' \t ', '\t\t', ' \n ']
INVISIBLE = ['\u200b', '\u200c', '\u200d', '\ufeff', '\u2060', '\u00ad', '\u200e', '\u200f', '\u202a', '\u202b',
             '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u061c', '\x00', '\x01', '\x07',
             '\x08', '\x1b', '\x7f', '\x80', '\x9f', '\ue000', '\ue001', '\uf8ff', '\ufffd', '\ufffe', '\uffff',
             '\U000e0001', '\U000e0041', '\U000f0000', '\u034f', '\ufe0f', '\ufe0e', '\u180b', '\u2061', '\u2062',
             '\u2063', '\u2064', '\u206a', '\u206f', '\u17b4', '\u115f', '\u3164', '\uffa0']
APOSTROPHES = ["'", "'", "'", '’', '‘', '`', '´', 'ʼ', '′', '＇', 'ʹ', '"']
DASHES = ['-', '-', '–', '—', '−', '‐', '‑', '‒', '⁃', '﹣', '－', '―']
QUOTES = [('"', '"'), ('“', '”'), ('„', '“'), ('«', '»'), ('»', '«'), ('‹', '›'), ("'", "'"), ('‘', '’'), ('(', ')'),
          ('[', ']'), ('{', '}'), ('「', '」'), ('<', '>'), ('*', '*'), ('_', '_'), ('“', '"')]
BULLETS = ['• ', '- ', '* ', '· ', '▪ ', '► ', '→ ', '✓ ', '✔ ', '1) ', 'a) ', '(i) ', '1. ', '2.1. ', '— ', '– ', '○ ',
           '■ ', '➤ ', '§ 3 ', '№ 5 ', '# ', '## ', '> ', '| ']
EMOJI = ['😀', '👍', '👍🏽', '🇹🇷', '❤\ufe0f', '❤', '✔\ufe0f', '✅', '#\ufe0f\u20e3', '1\ufe0f\u20e3',
         '5\ufe0f\u20e3', '☎', '☎\ufe0f', '⌚', '⭐', '🧑\u200d💻', '👨\u200d👩\u200d👧', '🏳\ufe0f\u200d🌈',
         '🤔', '🔥', '💯', '📞', '✈', '☀', '⚽', '🎉', '🙂', '🫠', '🪿', '🩷', '\U0001FAE8', '\U0001FC00',
         '\U0001F7F0', '🀄', '🃏', '©', '®', '™', '↗', '⬆', '⏰', '⌛', '‼', '⁉', '〰', '〽', '🅰', '🆗',
         '🈚']
SCRIPTS = ['Москва', 'Привет мир', 'ОАО «Газпром»', 'Αθήνα', 'ΟΔΟΣ', 'σοφός', 'ΣΟΦΟΣ', 'مرحبا',
           'القاهرة ١٢٣', 'سلام ۱۲۳', 'שלום', 'नमस्ते ०१२', 'สวัสดี', '안녕하세요', 'こんにちは', 'カタカナ',
           '北京', '東京都', 'Երևան', 'თბილისი', 'ᲗᲑᲘᲚᲘᲡᲘ', 'ᏣᎳᎩ', 'ꮳꮃꭹ', '𐐔𐐯𐑅𐐨𐑉𐐯𐐻', '𐌲𐌿𐍄𐌹𐍃𐌺', '𠀀𠜎𡃁',
           '\U0002EBF0\U0002EBF1\U0002EE5D', '\u2FFC\u2FFF\u31EF', '\U00010D50\U00010D51',
           '\U000105C0\U000105C1', '\U00011380\U00011381', '\U00016D40\U00016D41',
           '\U00011F04\U00011F05', '\U0001E4D0\U0001E4D1', 'Tiếng Việt', 'Ŋŋ Ɛɛ Ʃ', 'Ǆǅǆ', 'ǇǈǉǊǋǌ',
           'ǱǲǳĲĳ', 'Æsir Þór Ørsted', 'Straße STRASSE ẞ', 'Łódź', 'Dvořák', 'Gödel', 'Schrödinger',
           'François', 'José', 'Nguyễn', 'Søren', 'Đorđe', 'Zoë', 'Chloé', 'Björk', 'Ángel',
           'İbn Sînâ', 'Kâzım', 'hâlâ', 'kâr', 'Ilgaz', 'Ivan', 'Igor', 'Iris', 'India', 'IKEA',
           'Ilona', 'Isaac Newton', 'Iowa', '𞤀𞤢𞤤', '𐒰𐓘', '𐲀𐳀', '𑢠𑣀', '𖹀𖹠', 'ꙮ', 'ↅ', 'Ⓐⓑ', '🄰🄱',
           'ʰʲ ª º', 'ᵃᵇ', 'ⅰⅱ Ⅰ Ⅱ', 'ᾼᾳῼ', 'ΐΰ', 'ŉ ǰ ẖ ẗ ẘ ẙ ẚ', 'ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ', 'ﬓﬔ և',
           '\u212a \u212b \u2126 \u037e \u0387 \u0374 \u1fef \uf900 \U0002f800',
           'ſ ẛ ϐ ϑ ϕ ϖ ϰ ϱ ϵ', 'ᲀᲁ', 'Ꭰ ꭰ', 'ɐɑɒ', 'ɪ ʏ', 'Ϲ ϲ Ϳ ϳ', 'Ꞵ ꞵ', 'Ꟑ ꟑ', 'Ꟁꟁ', 'Ỻ ỻ',
           'ⴀ Ⴀ', 'ꭓ', '\U0001E900\U0001E922', '\U00016E40\U00016E60']
COMBINING = ['\u0300', '\u0301', '\u0302', '\u0303', '\u0306', '\u0307', '\u0308', '\u030c', '\u0327', '\u0328',
             '\u0323', '\u0331', '\u0336', '\u20dd', '\u20e3', '\u0345', '\u034f', '\u0610', '\u064b', '\u0670',
             '\u093c', '\u094d', '\u0e31', '\u0e48', '\u0f71', '\u0f7f', '\u1ab0', '\u1dc0', '\u302a', '\u3099',
             '\ufe20', '\U0001d165', '\U0001d167', '\U0001e8d0', '\U000e0100', '\u0903', '\u093f', '\u1b04',
             '\u0488', '\u1df9', '\u1dfa', '\u2cef', '\U00011c3f', '\U0001E4EF']
DOTTED_I = ['İ', 'ı', 'I', 'i', 'i\u0307', 'I\u0307', 'İ\u0307', 'ı\u0307', '\u0307', 'i\u0307\u0301', 'Ì', 'Í',
            'Î', 'Ï', 'ì', 'í', 'î', 'ï', 'ĩ', 'Ĩ', 'ǐ', 'Ǐ', 'ȉ', 'ɨ', 'ɩ', 'ᵻ', 'ﬁ', 'Ⅰ', 'ⅰ', 'Ι', 'ι', 'І', 'і',
            'Ї', 'ї', '𝐢', '𝐈', 'ｉ', 'Ｉ', 'ⓘ', 'Ⓘ', 'ı\u0307']
LETTERS_ODD = ['ß', 'ẞ', 'Ǆ', 'ǅ', 'ǆ', 'ǈ', 'ǋ', 'ǲ', 'ŉ', 'ǰ', 'ﬀ', 'ﬁ', 'ﬂ', 'ﬃ', 'ﬆ', 'ﬓ', 'ᾼ', 'ᾳ', 'Σ', 'ς',
               '\u03c3', '\u212a', '\u212b', '\u2126', 'ſ', 'Ⓐ', 'ⓐ', '🄰', 'ʰ', 'ª', 'º', 'Ⅰ', 'ⅰ', '𐐀', '𐐨', '𞤀', '𞤢',
               'Ა', 'ა', 'Ꭰ', 'ꭰ', 'µ', 'μ', 'Ϊ', 'ΐ', 'ǅ', 'Ŀ', 'ŀ', 'Ĳ', 'ĳ', 'Œ', 'œ', 'Æ', 'æ', 'Ø', 'ø', 'Þ', 'þ',
               'Ð', 'ð', 'ý', 'Ý', 'þ', 'Ł', 'ł', 'Đ', 'đ', 'Ħ', 'ħ', 'ı', 'ȷ', 'ꞵ', 'Ꞵ', 'ꟑ', 'ↄ', 'Ↄ', 'ǝ', 'Ǝ',
               '\u1c89', '\u1c8a', '\ua7cb', '\ua7dc', '\U00010d50', '\U00010d70']

SUFFIXES = ['de', 'te', 'da', 'ta', 'DA', 'TE', 'ye', 'ya', 'e', 'a', 'nci', 'ncı', 'üncü', 'inci', 'ıncı', 'uncu',
            'ncü', 'ncu', 'lık', 'lik', 'luk', 'lük', 'li', 'lı', 'lu', 'lü', 'si', 'sı', 'su', 'nin', 'nın', 'ın',
            'in', 'un', 'ün', 'm', 'n', 'mda', 'nız', 'niz', 'teki', 'deki', 'daki', 'taki', 'dakidir', 'dakı', 'yle',
            'yla', 'le', 'la', 'larda', 'lerde', 'den', 'dan', 'ten', 'tan', 'ler', 'lar', 'yi', 'yı', 'ı', 'i', 'ü',
            'u', 'nün', 'ncisi', 'üncüsü', 'sinde', 'ken', 'yor', 'ki', 'mız', 'miz', 'ndan', 'nde', 'DEN', 'İNCİ',
            'IN', 'x', 's', 'er', 'ar', 'şer', 'şar', 'erden', 'lardakiler', 'lerdeki', 'ydi', 'ymış', 'yken', 'sa',
            'se', 'ce', 'ca', 'çe', 'ça', 'cı', 'ci', 'lı', 'sız', 'siz', 'dır', 'dir', 'tır', 'tir', 'dür', 'tür',
            'âr', 'ında', 'inde', 'unda', 'ünde', 'İN', 'Lİ', 'LIK', 'YE', 'YA', 'NİN', 'NIN', 'Dan', 'De', 'lİk', 'ğı',
            'şi']
CLITICS = ['mi', 'mı', 'mu', 'mü', 'MI', 'Mİ', 'MU', 'MÜ', 'Mi', 'mI', 'misiniz', 'mısınız', 'musunuz', 'müsünüz',
           'miydi', 'mıydı', 'muydu', 'müydü', 'miyim', 'mıyım', 'midir', 'mıdır', 'mudur', 'müdür', 'müdürler',
           'miymiş', 'mıymış', 'miyse', 'mıysa', 'misin', 'mısın', 'miydik', 'mıydınız', 'miydiler', 'mıymışsınız',
           'midirler', 'mıyız', 'miyiz', 'de', 'da', 'DE', 'DA', 'De', 'de mi', 'da mı', 'DA MI', 'de mi?', 'mi?',
           'müdür?', 'mı acaba', 'mu ki', 'mıydı?', 'dahi', 'bile', 'ki', 'ya', 'mis', 'mız', 'dah']
TR_WORDS = ['ev', 'okul', 'kitap', 'masa', 'kalem', 'araba', 'yol', 'şehir', 'insan', 'çocuk', 'gün', 'yıl', 'saat',
            'para', 'iş', 'su', 'göz', 'el', 'baş', 'kapı', 'oda', 'kat', 'daire', 'bina', 'sokak', 'cadde', 'mahalle',
            'telefon', 'numara', 'kod', 'şifre', 'hesap', 'fatura', 'ödeme', 'fiyat', 'indirim', 'kampanya', 'ürün',
            'sipariş', 'kargo', 'teslimat', 'randevu', 'toplantı', 'sınav', 'ders', 'öğrenci', 'öğretmen', 'doktor',
            'hasta', 'ilaç', 'doz', 'ağırlık', 'boy', 'hız', 'mesafe', 'sıcaklık', 'derece', 'oran', 'faiz', 'puan',
            'not', 'ortalama', 'yüzde', 'maç', 'skor', 'gol', 'takım', 'lig', 'sezon', 'hafta', 'bölüm', 'sayfa',
            'madde', 'fıkra', 'kanun', 'yönetmelik', 'karar', 'dava', 'mahkeme', 'savcı', 'avukat', 'banka', 'kredi',
            'kart', 'limit', 'borç', 'bakiye', 'tutar', 'miktar', 'adet', 'tane', 'kişi', 'kez', 'defa', 'kilo',
            'metre', 'litre', 'gram', 'ton', 'dakika', 'saniye', 'yüzyıl', 'dönem', 'çağ', 'ışık', 'ılık', 'iğne',
            'ığdır', 'ölçü', 'üzüm', 'şeker', 'çay', 'ağaç', 'dağ', 'göl', 'deniz', 'ırmak', 'kıyı', 'köy', 'ilçe',
            'il', 'ülke', 'dünya', 'gök', 'yer', 'hava', 'yağmur', 'kar', 'rüzgâr', 'kâğıt', 'hâl', 'hala', 'kâr',
            'müdür', 'müdürü', 'yardımcısı', 'başkan', 'üye', 'müşteri', 'abone', 'personel', 'çalışan', 'takipçi']
TR_VERBS = ['geldi', 'gitti', 'oldu', 'başladı', 'bitti', 'yapılacak', 'ertelendi', 'açıklandı', 'arttı', 'azaldı',
            'düştü', 'yükseldi', 'ödendi', 'gönderildi', 'teslim edildi', 'iptal edildi', 'kazandı', 'kaybetti',
            'yendi', 'berabere kaldı', 'sürecek', 'bekleniyor', 'var', 'yok', 'gerekiyor', 'yeterli', 'oldu mu',
            'geliyor musun', 'biliyor muydunuz', 'aradınız mı', 'gelecek misiniz', 'tamam mı', 'ne zaman', 'kaç para',
            'nerede', 'olur mu', 'değil mi', 'sanırım', 'belki', 'kesinlikle', 'hemen', 'şimdi', 'yarın', 'dün']
SUBJECTS = ['Toplantı', 'Ahmet Bey', 'Ayşe Hanım', 'Şirketimiz', 'Belediye', 'Öğrenciler', 'Müdürlük', 'Hastane',
            'Kargo', 'Banka', 'Maç', 'Konser', 'Fiyatı', 'Sıcaklık', 'Hızı', 'Nüfus', 'Bütçe', 'Fatura', 'Uçak', 'Tren',
            'Sınav', 'Kurs', 'Başvuru', 'Toplam', 'Kira', 'Maaş', 'Faiz', 'Enflasyon', 'Rakım', 'Mesafe', 'Ağırlığı',
            'Paket', 'Dosya', 'Rapor', 'Kitap', 'Bölüm', 'Proje', 'Sürüm', 'Uygulama', 'Telefon numaramız', 'Adresimiz',
            'Sipariş numaranız', 'Takip kodunuz', 'Onay kodu', 'Hesap numarası', 'Plakası', 'İletişim',
            'E-posta adresimiz', 'Web sitemiz', 'Iğdır', 'İstanbul', 'İzmir', 'Ankara', 'Eskişehir', 'Çanakkale',
            'Şanlıurfa', 'Ağrı', 'Ödemiş', 'Üsküdar', 'Kadıköy', 'Işıl', 'İpek', 'Ömer', 'Çağla', 'Gülşen', 'Uğur',
            'Fenerbahçe', 'Galatasaray', 'Beşiktaş', 'TBMM', 'SGK', 'Merkez Bankası', 'Hava durumu', 'Ilık hava', 'O',
            'Bu', 'Şu', 'Biz', 'Siz', 'Onlar', 'Herkes', 'Kimse', 'Hepimiz', 'Dr. Ayşe Yılmaz', 'Prof. Dr. Ali Can']
JOINERS = ['', '', 've', 'ile', 'ya da', 'veya', 'ama', 'ancak', 'çünkü', 'yani', 'yaklaşık', 'toplam', 'en az',
           'en fazla', 'saat', 'tarihinde', 'itibarıyla', 'sonra', 'önce', 'kadar', 'arasında', 'civarında', 'ila',
           'ile', 'ya', 'hem', 'de', 'bile', 'sadece', 'ayrıca', 'örneğin', 'yani', 'mesela', '—', '–', '-', ':', ';']
ENDINGS = ['.', '.', '.', '.', '?', '!', '...', '…', '?!', '!!', '??', '', ';', ':', ',', '."', '?"', '.)', '!)', '».',
           '.»', ' .', ' ?', '.\n', '\n', '. ', '?)', '.’', '.”']
ORD_TAILS = ['inci', 'ıncı', 'uncu', 'üncü', 'nci', 'ncı', 'ncu', 'ncü', 'üncüsü', 'ncisi', 'incide', 'üncüden',
             'ncilik', 'nciler', 'ncüsü', 'inciyi']
ROMANS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIV', 'XV', 'XIX', 'XX', 'XXI',
          'XL', 'L', 'LX', 'XC', 'C', 'CD', 'D', 'CM', 'M', 'MM', 'MCM', 'MCMXC', 'MMXXVI', 'IIII', 'VV', 'IC', 'XM',
          'IIV', 'MMMM', 'LL', 'DD', 'VX', 'Iİ', 'İV', 'XİV', 'ⅩⅣ', 'Ⅻ', 'iv', 'xiv', 'Xiv']
TLDS = ['com', 'net', 'org', 'gov', 'edu', 'io', 'ai', 'tr', 'co', 'info', 'biz', 'me', 'app', 'dev', 'COM', 'Com',
        'NET', 'IO', 'İO', 'ıo', 'Io', 'İo', 'AI', 'Aİ', 'aı', 'TR', 'Tr', 'İnfo', 'ınfo', 'BİZ', 'bız', 'ME', 'APP',
        'DEV', 'de', 'uk', 'xyz', 'museum', 'com.tr', 'gov.tr', 'edu.tr', 'org.tr', 'k12.tr', 'co.uk', 'com.ſK',
        'com.İt', 'com.ıt', 'net.\u212aZ', 'com.\u212az', 'com.\u212b', 'co.jp', 'xn--p1ai', 'рф', 'com.c', 'com.abc',
        'c', 'cOm', 'cöm']
NAME_POOL = ['Ali', 'Veli', 'Ayşe', 'Fatma', 'Mehmet', 'Mustafa', 'Zeynep', 'Elif', 'Emre', 'Burak', 'Can', 'Deniz',
             'Öztürk', 'Yılmaz', 'Kaya', 'Demir', 'Şahin', 'Çelik', 'Yıldız', 'Aydın', 'Özdemir', 'Arslan', 'Doğan',
             'Kılıç', 'Aslan', 'Çetin', 'Kara', 'Koç', 'Kurt', 'Özkan', 'Şimşek', 'Rowling', 'Smith', 'Kennedy',
             'Müller', "O'Brien", "D'Artagnan", 'McDonald', 'MacArthur', 'van der Waals', 'de la Cruz', 'Jean-Luc',
             'Anne-Marie', 'Ibn Battuta', 'Ivanov', 'Igor', 'Iris', 'Ingrid', 'Isabel', 'Ömer', 'Ünal', 'Işık', 'İnci',
             'Ilgın', 'Ilıca', 'İrem', 'İlker', 'Ozan', 'Uğur', 'Ece', 'Ebru', 'Gül', 'Şükrü', 'Hüsnü', 'Âşık Veysel']


def nominal_tails():
    return ['', '', '', 'ı', 'i', 'u', 'ü', 'sı', 'si', 'm', 'n', 'mız', 'niz', 'nız', 'ları', 'leri', 'larımız',
            'unuz', 'ünüz', 'ınız', 'iniz', 'na', 'ne', 'nda', 'nde', 'dan', 'den', 'tan', 'ten', 'la', 'le', 'yla',
            'yle', 'lu', 'lü', 'lı', 'li', 'suz', 'süz', 'ya', 'ye', 'a', 'e', 'nın', 'nin', 'unu', 'ünü', 'ını',
            'ini', 'umuz', 'ımız', 'sını', 'sinde', 'ları', 'çı', 'çi', 'lama', 'al', 'sal', 'ma', 'me']


class Fuzz:
    """Seeded generator of realistic and nasty inputs. Every pool is a list (never a set: its order would follow
    PYTHONHASHSEED), so a seed always gives the same corpus."""

    def __init__(self, seed, base_texts):
        self.r = random.Random(seed)
        self.base = [t for t in base_texts if 0 < len(t) <= 600]
        self.sweep = self._sweep_items()
        self.sweep_i = 0
        self.gens = [
            ('real', 12, self.g_real), ('sentence', 12, self.g_sentence), ('lexicon', 15, self.g_lexicon),
            ('mutate', 13, self.g_mutate), ('soup', 11, self.g_soup), ('headline', 6, self.g_headline),
            ('clitic', 5, self.g_clitic), ('chunker', 6, self.g_chunker), ('window', 4, self.g_window),
            ('noise', 4, self.g_noise), ('long', 3, self.g_long), ('tiny', 3, self.g_tiny), ('doc', 3, self.g_doc),
            ('unicode', 3, self.g_unicode), ('dollar', 2, self.g_dollar), ('newuni', 3, self.g_newuni),
        ]
        self.weights = [w for _, w, _ in self.gens]

    # ---- helpers
    def ch(self, xs):
        return self.r.choice(xs)

    def p(self, x):
        return self.r.random() < x

    def ws(self):
        return ' ' if self.p(0.85) else self.ch(WHITESPACE)

    def apos(self):
        return "'" if self.p(0.8) else self.ch(APOSTROPHES)

    def digits(self, n, lead=False):
        if n <= 0:
            return ''
        first = self.ch('0123456789' if lead else '123456789')
        return first + ''.join(self.ch('0123456789') for _ in range(n - 1))

    def translit(self, s, frac=1.0):
        nd = self.ch(ND_SETS[1:])
        return ''.join(nd[ord(c) - 48] if '0' <= c <= '9' and self.p(frac) else c for c in s)

    def maybe_uni(self, s, prob=0.05):
        return self.translit(s, self.ch([1.0, 1.0, 0.5])) if self.p(prob) else s

    def suffix(self):
        return self.apos() + self.ch(SUFFIXES)

    def word(self):
        return self.ch(TR_WORDS)

    # ---- number shapes
    def n_plain(self):
        n = self.ch([1] * 6 + [2] * 6 + [3] * 5 + [4] * 6 + [5] * 3 + [6, 7, 8, 9, 10, 11, 12] * 2 + list(range(13, 23))
                    + [25, 30, 31, 40, 64, 100])
        if self.p(0.12):
            return self.ch(['0', '00', '000']) + self.digits(max(0, n - 1), lead=True)
        return self.digits(n)

    def n_thousands(self):
        s = self.digits(self.r.randint(1, 3)) + ''.join('.' + self.digits(3, True) for _ in range(self.r.randint(1, 7)))
        if self.p(0.3):
            s += ',' + self.digits(self.r.randint(1, 3), True)
        if self.p(0.08):  # broken grouping: "1.25", "1.2345", "12.34.567"
            s = self.ch([self.digits(1) + '.' + self.digits(2, True), self.digits(1) + '.' + self.digits(4, True),
                         self.digits(2) + '.' + self.digits(2, True) + '.' + self.digits(3, True), '1.000.00', '.500'])
        return s

    def n_decimal(self):
        ip = self.ch(['0', self.digits(1), self.digits(2), self.digits(3), self.digits(4), ''])
        fp = self.ch(['5', '50', '05', '25', '75', '0', '00', '9', '99', '125', '333', '0005', self.digits(5, True)])
        return ip + self.ch([',', ',', '.']) + fp

    def n_signed(self):
        sign = self.ch(['-', '-', '+', '−', '–', '- ', '+ ', '±', '--'])
        return sign + self.ch([self.n_plain, self.n_decimal, self.n_thousands])()

    def n_sci(self):
        return self.ch(['1e5', '1E5', '2,5e-3', '1.2e10', '10^30', '10^-3', '6,02×10²³', '3x10^8', '1e100', '5E+3',
                        '10⁻⁹', '2^64', '1,5e6', f'{self.digits(1)}e{self.digits(2)}', '0x1F', '0X1f', '0b1010',
                        '0o17'])

    def n_huge(self):
        n = self.ch([21, 22, 23, 24, 30, 31, 50, 100, 1000, 4299, 4300, 4301, 4302, 4400, 5000])
        s = self.digits(n)
        k = self.r.random()
        if k < 0.25:  # a range: _int_value() calls int() on both ends
            return s + self.ch(['-', ' - ', '–']) + self.ch([self.digits(1), self.digits(n)])
        if k < 0.35:  # dot thousands past 10^21 and past int()'s 4300 digits (1433 groups)
            return self.digits(self.r.randint(1, 3)) + '.000' * self.ch([7, 8, 12, 1432, 1433, 1434, 1500])
        if k < 0.45:
            return s + ',' + self.digits(self.r.randint(1, 30), True)
        if k < 0.55:
            return s + self.suffix()
        if k < 0.62:
            return '-' + s
        if k < 0.7:
            return s + '.' + self.digits(self.r.randint(1, 5), True)
        return s

    def number(self):
        k = self.r.random()
        f = (self.n_plain if k < 0.38 else self.n_thousands if k < 0.55 else self.n_decimal if k < 0.72 else
             self.n_signed if k < 0.84 else self.n_sci if k < 0.9 else self.n_huge if k < 0.93 else self.n_plain)
        return self.maybe_uni(f())

    # ---- structured shapes
    def s_ordinal(self):
        k = self.r.random()
        nxt = self.ch([self.word(), self.ch(ORD_NOUNS), self.ch(SUBJECTS), self.ch(NAME_POOL), 'Dünya Savaşı',
                       'Yüzyılda', 'LİG', 'kat', 'sınıf', 'Ordu', 'Murat', 'yüzyıl', "Lig'de", 'Ligi', 'Öztürk'])
        if k < 0.4:
            return f'{self.digits(self.r.randint(1, 4))}.{self.ws()}{nxt}'
        if k < 0.65:
            return f'{self.digits(self.r.randint(1, 3))}{self.apos()}{self.ch(ORD_TAILS)}'
        if k < 0.85:
            return f'{self.ch(ROMANS)}.{self.ws()}{nxt}'
        return f'{self.ch(ROMANS)}{self.apos()}{self.ch(SUFFIXES)}'

    def s_date(self):
        d = self.ch([self.r.randint(1, 31), self.r.randint(1, 9), 0, 32, 99, self.r.randint(10, 31)])
        m = self.ch([self.r.randint(1, 12), self.r.randint(1, 9), 0, 13, 19])
        y = self.ch([str(self.r.randint(1900, 2100)), str(self.r.randint(0, 99)).zfill(2), '1453', '0000', '9999',
                     str(self.r.randint(1800, 2099))])
        dd = self.ch([str(d), str(d).zfill(2)])
        mm = self.ch([str(m), str(m).zfill(2)])
        sep = self.ch(['.', '.', '/', '-', '.', '/'])
        sep2 = sep if self.p(0.92) else self.ch(['.', '/', '-'])
        k = self.r.random()
        if k < 0.55:
            s = f'{dd}{sep}{mm}{sep2}{y}'
        elif k < 0.7:
            s = f'{y[:4].zfill(4)}-{mm.zfill(2)}-{dd.zfill(2)}'
        elif k < 0.8:
            s = f'{y[:4].zfill(4)}{self.ch(["/", "."])}{mm}{self.ch(["/", "."])}{dd}'
        elif k < 0.92:
            s = f'{mm}{self.ch([".", "/"])}{self.ch([y, str(self.r.randint(1900, 2099))])}'
        else:
            s = f'{dd}{sep}{mm}{sep}{y}{self.ch([".5", ",5", ".", "/1", "-"])}'
        if self.p(0.3):
            s += self.suffix()
        return self.maybe_uni(s)

    def s_time(self):
        h = self.ch([str(self.r.randint(0, 24)), str(self.r.randint(0, 23)).zfill(2), '25', '9', '09', '00', '24'])
        mi = self.ch([str(self.r.randint(0, 59)).zfill(2), '00', '30', '15', '45', '60', '61', '5'])
        sec = str(self.r.randint(0, 61)).zfill(2)
        sep = self.ch([':', ':', '.'])
        k = self.r.random()
        if k < 0.45:
            s = f'{h}{sep}{mi}' + (f':{sec}' if self.p(0.15) else '')
        elif k < 0.75:
            h2 = str(self.r.randint(0, 24)).zfill(self.ch([1, 2]))
            s = f'{h}{sep}{mi}{self.ch(["-", " - ", "–", "—", " – ", "-"])}{h2}{sep}{self.ch(["00", "30", mi])}'
        else:
            ctx = self.ch(L.TIME_CONTEXT)
            s = self.ch([f'{ctx} {h}{sep}{mi}', f'{h}{sep}{mi} {ctx}', f'{tr_upper(ctx)} {h}.{mi}'])
        if self.p(0.3):
            s += self.suffix()
        if self.p(0.05):
            s = self.ch(['%', '₺', '$', '€', '£']) + self.ch(['', ' ']) + s
        return self.maybe_uni(s)

    def s_money(self):
        amt = self.ch([self.n_plain(), self.n_thousands(), self.n_decimal(), self.digits(2) + ',' + self.digits(2,
                                                                                                                True),
                       self.digits(1) + '.' + self.digits(3, True) + ',' + self.ch(['00', '50', '05', '5', '500'])])
        sym = self.ch(['₺', '$', '€', '£', '¥', '₽'])
        code = self.ch(['TL', 'TRY', 'USD', 'EUR', 'GBP', 'JPY', 'RUB', 'CHF', 'tl', 'Tl', 'lira', 'dolar', 'avro',
                        'euro', 'Euro', 'sterlin', 'TLlik', 'TL\'lik', 'USDT', 'EURO'])
        sp = self.ch(['', ' ', ' ', '\xa0', '\u202f'])
        k = self.r.random()
        if k < 0.3:
            s = f'{sym}{sp}{amt}'
        elif k < 0.6:
            s = f'{amt}{sp}{self.ch([code, code, sym])}'
        elif k < 0.75:
            s = f'{amt}{self.ch(["-", " - ", "–"])}{self.n_plain()}{sp}{self.ch([code, sym])}'
        elif k < 0.88:
            s = f'{self.n_plain()} {self.ch(["bin", "milyon", "milyar", "trilyon", "Bin"])} {self.ch([code, sym])}'
        else:
            s = f'{sym}{amt}{self.ch(["", " "])}{code}'
        if self.p(0.3):
            s += self.suffix()
        return self.maybe_uni(s)

    def s_percent(self):
        a, b = self.ch([self.n_plain(), self.n_decimal()]), self.ch([self.n_plain(), self.n_decimal()])
        s = self.ch([f'%{a}', f'% {a}', f'%{a}-{b}', f'%{a} - %{b}', f'%{a}-%{b}', f'{a}%', f'{a} %', f'‰{a}',
                     f'‰ {a}', f'%{a}–{b}', f'%-{a}', f'%%{a}', f'{a}%{b}', f'%{self.digits(2)}'])
        if self.p(0.35):
            s += self.suffix()
        return self.maybe_uni(s)

    def s_degree(self):
        n = self.ch([self.n_plain(), self.n_decimal(), '-' + self.digits(self.r.randint(1, 2))])
        s = self.ch([f'{n}°C', f'{n} °C', f'{n}° C', f'{n}°', f'{n}°F', f'{n} ° F', f'{n}°c', f'{n}℃', f'{n}℉',
                     f'{n}°K', f'{n}º', f'{n}˚C', f'{n} derece', f'{n}°Cde', f'{n}°C\'de'])
        if self.p(0.25):
            s += self.suffix()
        return self.maybe_uni(s)

    def s_unit(self):
        u = self.ch(list(L.UNITS) + list(L.SPEED_UNITS))
        n = self.ch([self.n_plain(), self.n_decimal(), self.n_thousands(), self.digits(1) + '.' + self.digits(1)])
        s = self.ch([f'{n} {u}', f'{n}{u}', f'{n}-{self.n_plain()} {u}', f'{n} - {self.n_plain()}{u}', f'-{n} {u}',
                     f'{n} {u}/sa', f'{n} {u}²', f'{n}{u}2', f'{u} {n}', f'{n} {u}.', f'{n} {u}x'])
        if self.p(0.3):
            s += self.suffix()
        return self.maybe_uni(s)

    def s_phone(self):
        area = self.ch(['532', '212', '216', '312', '850', '444', '505', '542', '232', '800', '900', '612', '712',
                        '999'])
        a, b, c = self.digits(3, True), self.digits(2, True), self.digits(2, True)
        sp = self.ch([' ', ' ', '-', '.', '', ' '])
        s = self.ch([f'0{area}{sp}{a}{sp}{b}{sp}{c}', f'+90{sp}{area}{sp}{a}{sp}{b}{sp}{c}', f'0({area}){a}{b}{c}',
                     f'+90 ({area}) {a}-{b}-{c}', f'0 ({area}) {a} {b} {c}', f'({area}) {a} {b} {c}',
                     f'{area}{sp}{a}{sp}{b}{sp}{c}', f'0{area}{a}{b}{c}', f'444 {self.digits(1, True)} {a}',
                     f'444{self.digits(4, True)}', f'444-{self.digits(1, True)}-{a}', f'+90{area}{a}{b}{c}',
                     f'0090 {area} {a} {b} {c}', '+1 (555) 123-4567', '+44 20 7946 0958', '112', '155',
                     f'0{area} {a} {b}'])
        if self.p(0.25):
            s += self.suffix()
        return self.maybe_uni(s, 0.03)

    def s_iban(self):
        g = [self.digits(4, True) for _ in range(5)]
        sp = self.ch([' ', '', ' ', '  '])
        s = f'TR{self.digits(2, True)}{sp}{sp.join(g)}{sp}{self.digits(2, True)}'
        k = self.r.random()
        if k < 0.1:
            s = s.lower()
        elif k < 0.2:
            s = s[:-1]
        elif k < 0.3:
            s = s + self.digits(1, True)
        elif k < 0.4:
            s = 'IBAN: ' + s
        elif k < 0.5:
            s += self.suffix()
        elif k < 0.55:
            s = 'X' + s
        return s

    def s_plate(self):
        city = self.ch([str(self.r.randint(1, 81)).zfill(2), '00', '82', '99', '1', '34', '06', '35'])
        letters = ''.join(self.ch('ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZÂXQW') for _ in range(self.r.randint(1, 4)))
        s = f'{city} {letters} {self.digits(self.r.randint(1, 6), True)}'
        if self.p(0.25):
            s += self.suffix()
        return s

    def domain_label(self):
        return self.ch(['ornek', 'google', 'site', 'haber', 'e-devlet', 'turkiye', 'gov', 'my_site', 'a', 'x1',
                        'örnek', 'şirket', 'İstanbul', 'ISTANBUL', 'ıstanbul', 'mail', 'www2', 'cdn', 'api', 'tr',
                        'b2b', '123', 'ab-cd', 'Ünlü', 'xn--rnek-zoa', 'test', 'GitHub', 'youtube', 'Google', '_'])

    def s_url(self):
        scheme = self.ch(['', '', 'http://', 'https://', 'HTTPS://', 'Http://', 'ftp://', 'https://', '//'])
        www = self.ch(['', '', 'www.', 'WWW.', 'Www.'])
        labels = '.'.join(self.domain_label() for _ in range(self.r.randint(1, 3)))
        path = self.ch(['', '', '/', '/a/b', '/haber/2026/10/14/baslik-123', '?q=1&x=2', '/index.html#top',
                        '/İçerik', '/a_b-c.d', '/~user', '/%20', '/path/', '/12345', ':8080/x'])
        tail = self.ch(['', '', '.', ',', ')', "'da", "'ya", "'dan", '’ye', '!', '?', '/', '"', ';'])
        return f'{scheme}{www}{labels}.{self.ch(TLDS)}{path}{tail}'

    def s_email(self):
        local = self.ch(['ali', 'ali.veli', 'ALI', 'info', 'destek+tag', 'a_b', 'user99', 'ğüş.çö', 'x', 'first.last-2',
                         'İLETİŞİM', 'ılık', '.ali', 'ali.', 'a..b', '123'])
        dom = '.'.join(self.domain_label() for _ in range(self.r.randint(1, 2)))
        return self.ch([f'{local}@{dom}.{self.ch(TLDS)}', f'{local}@{dom}', f'@{local}', f'{local}@@{dom}.com',
                        f'{local} @ {dom}.com', f'{local}@{dom}.{self.ch(TLDS)}{self.apos()}{self.ch(SUFFIXES)}',
                        f'<{local}@{dom}.com>', f'mailto:{local}@{dom}.com.tr'])

    def s_lexword(self):
        k = self.r.random()
        if k < 0.25:
            w = self.ch(ABBREVIATIONS)
        elif k < 0.45:
            w = self.ch(ACRONYMS)
        elif k < 0.7:
            w = self.ch(NAMES_FORMS)
        elif k < 0.8:
            w = self.ch(CAPS_WORDS)
        elif k < 0.9:
            w = self.ch(EVAL_ACRONYMS)
        else:
            w = self.ch(ORD_NOUNS)
        if self.p(0.25):
            w += self.suffix()
        return w

    def s_caps(self):
        letters = ''.join(self.ch('ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ') for _ in range(self.r.randint(2, 6)))
        w = self.ch([tr_upper(self.word()), self.word().upper(), letters])
        if self.p(0.3):
            w += self.apos() + self.ch(SUFFIXES).upper()
        return w

    def s_named(self):
        nm = self.ch(NAME_POOL + SUBJECTS + NAMES_FORMS)
        return nm + (self.suffix() if self.p(0.6) else '')

    def s_alnum(self):
        return self.ch(['COVID-19', 'covid-19', 'Covid-19', 'F-16', 'MP3', 'mp3', 'H2O', 'A4', '5G', '4K', 'TR42648163',
                        'GPT-3.5', 'GPT-4o', 'ChatGPT-4o', 'Claude-3.5', 'klod-3.5', 'iPhone 15', 'iPhone15', 'PS5',
                        'Xbox360', 'B12', 'D3', 'Omega-3', 'A320neo', 'Boeing 737-800', 'USB-C', 'HDMI2.1', 'Wi-Fi 6',
                        'IPv4', 'IPv6', 'x86', 'x64', 'ARM64', 'R2-D2', 'C-3PO', '3D', '2B', 'B2B', 'A+', 'C++', 'C#',
                        'F#', '.NET', 'Node.js', 'Vue.js', 'ES2023', 'H.264', 'MPEG-4', 'ISO 9001', 'EN 1090-2',
                        'TS EN ISO', 'K2', 'E5', 'D-100', 'O-3', 'TEM', 'Ç4', 'Ş1', 'İ5', 'ÜÇ3', 'Aİ2', 'ABC1234',
                        'abc123', 'Abc123', '1A', '12B', 'A1B2C3', 'X-Men', 'Y-kuşağı', 'Z kuşağı', 'T-shirt'])

    def s_misc(self):
        return self.ch([
            f'{self.digits(1)} x {self.digits(2)}', f'{self.digits(1)}x{self.digits(1)}',
            f'{self.digits(1)}*{self.digits(1)}', f'{self.digits(1)}×{self.digits(1)}',
            f'{self.digits(1)}+{self.digits(1)}={self.digits(1)}', f'{self.digits(2)} + {self.digits(2)}',
            f'{self.digits(1)}/{self.digits(2)}', f'{self.digits(2)}/{self.digits(1)}',
            f'{self.digits(1)},{self.digits(1)}/{self.digits(1)}', '24/7', '3/4\'ü', '1/2', '0/0', '10/0', '12/4',
            '3/1', 'No: 12/4', 'Daire 3/1', '10/2 nolu', "15/3 no'lu", 'x²', 'a³', '(a+b)²', '10²', '5³', 'm²', 'km²',
            'cm³', 'x² + y² = z²', 'E=mc²', 'H₂O', 'CO₂', '±5', '~10', '≈ 3', '#etiket', '#1', '@kullanici', '§ 12',
            '№ 5', 'A & B', 'Ar&Ge', 'R&D', 'a|b', 'Kadıköy/İstanbul', 've/veya', 'km/sa', 'TL/ay', '1.2.3', '10.15.7',
            '192.168.1.1', '3.x', '2.7.x', 'v1.2', 'V2', 's. 45', 'c. 3', 's.45', 'ss. 12-15', 'bkz. s. 7', 'No.5',
            'No:5', 'NO.12', 'Nu. 7', 'Kat:3', 'Daire:5', 'D:3', 'Blok:A', 'Tel:0532', 'GSM:0532 123 45 67',
            'Tablo.3\'te', 'Fig.2\'de', 'md.5\'inci', 'Kat.3', 'on iki.31', 'yüz.5', '1975yılında', '6inçlik',
            '2x hızlı', '4o', '8.6.9..Dabul', ':¹3.5abc@1.2.3', 'abc@1.2.3', '1990larda', '90lar', '2000\'li', "80'ler",
            "'90'lar", "’80’lerde", 'Madde 5/a', 'a) b) c)', '(1)', '[12]', '[1-3]', '{5}', '<10>', '>5', '<5', '≥18',
            '≤3', '5+', '18+', '+18', '1-0', '2 - 2', '-10 - 5 derece', '-5 - -2 gün', '3-1 yendi', '2023-24 sezonu',
            '6-6', '2-3', '1914-1918', '13 ile 17 arasında', '4 ila 5', '%3,5-4', '0x1F', '0xFF', '#FF0000', 'U+0130',
        ])

    SHAPES = ('number', 'ordinal', 'date', 'time', 'money', 'percent', 'degree', 'unit', 'phone', 'iban', 'plate',
              'url', 'email', 'lexword', 'caps', 'named', 'alnum', 'misc')

    def shape(self, name=None):
        name = name or self.ch(self.SHAPES)
        return getattr(self, 's_' + name if name != 'number' else 'number')()

    # ---- generators
    REAL = (
        'Toplantı {date} tarihinde saat {time} başlayacak.', 'Ürünün fiyatı {money} oldu.',
        'Faiz oranı {percent} düştü.', 'Bugün hava {degree} olacak.', 'İki şehir arası {unit}.',
        'Bize {phone} numarasından ulaşabilirsiniz.', 'IBAN numaram {iban}, lütfen oraya gönderin.',
        'Aracın plakası {plate} idi.', 'Ayrıntılar için {url} adresine bakın.',
        'Sorularınızı {email} adresine yazabilirsiniz.', 'Yarışmada {ordinal} oldu.', '{number} kişi katıldı.',
        'Siparişiniz {date} günü {time} itibarıyla kargoda.', '{named} {money} ödedi mi?',
        'Sınavdan {number} puan aldım.', 'Bu yıl {percent} zam yapıldı.', 'Hasta günde {unit} ilaç alıyor.',
        'Maç {misc} bitti.', '{lexword} açıklama yaptı.', 'Kargo takip numaranız {number}.',
        'Doğrulama kodunuz {number}.', '{caps} {caps} {caps} {caps}!', 'Saat {time} ile {time} arasında açığız.',
        '{date} - {date} tarihleri arasında indirim var.', '{alnum} çıktı.', 'Toplam tutar {money}, KDV dahil.',
        'Rakım {unit}, sıcaklık {degree}.', '{named} {date} doğumlu.', 'Kampanya {date} tarihine kadar geçerli.',
        'Arayın: {phone}.', 'Adres: Atatürk Mah. Gül Sok. No: {misc} Kadıköy/İstanbul',
        '{ordinal} maddeye göre {money} ceza kesildi.', '"{named}" dedi ki: {number} kez söyledim!',
        'Fiyatlar {money} ile {money} arasında.', 'Ekonomi {percent} büyüdü, enflasyon {percent} oldu.',
        'Haber {url} sitesinde, {date} tarihli.', 'Hız sınırı {unit}.', 'Su {degree} kaynar.', 'Bilet {money} mı?',
        'Ofis {ordinal} katta.', '{number}. sırada {named} var.', 'Toplantı {time} mi, {time} mi?',
        '{named}, {date} tarihinde {named} ile evlendi.', 'Sonuç: {misc}.',
    )

    def g_real(self):
        t = self.ch(self.REAL)
        return re.sub(r'\{(\w+)\}', lambda m: self.shape(m.group(1)), t)

    def g_sentence(self):
        parts = []
        for _ in range(self.r.randint(1, 3)):
            subj = self.ch(SUBJECTS) if self.p(0.8) else self.s_named()
            ents = [self.shape() for _ in range(self.r.randint(1, 3))]
            mid = []
            for e in ents:
                if mid and self.p(0.5):
                    mid.append(self.ch(JOINERS))
                if self.p(0.4):
                    mid.append(self.word())
                mid.append(e)
            tail = self.ch(TR_VERBS)
            if self.p(0.12):
                tail += ' ' + self.ch(CLITICS)
            clause = ' '.join(x for x in [subj, *mid, tail] if x)
            if self.p(0.1):
                q = self.ch(QUOTES)
                clause = q[0] + clause + q[1]
            parts.append(clause + self.ch(ENDINGS))
        return self.ws().join(parts)

    def _sweep_items(self):
        items = []
        items += [('abbr', k) for k in L.ABBREVIATIONS]
        items += [('acronym', k) for k in L.ACRONYMS]
        items += [('name', k) for k in NAMES_FORMS]
        items += [('caps', k) for k in CAPS_WORDS]
        items += [('eval', k) for k in EVAL_ACRONYMS]
        items += [('unit', k) for k in L.UNITS]
        items += [('speed', k) for k in L.SPEED_UNITS]
        items += [('currency', k) for k in L.CURRENCY_WORDS]
        items += [('id', k) for k in L.ID_CONTEXT] + [('code', k) for k in L.CODE_CONTEXT]
        items += [('qbefore', k) for k in QUANTITY_BEFORE] + [('qafter', k) for k in L.QUANTITY_AFTER]
        items += [('ordnoun', k) for k in ORD_NOUNS] + [('ordprefix', k) for k in L.ORDINAL_CAP_PREFIXES]
        items += [('title', k) for k in L.INITIAL_TITLES]
        items += [('bare', k) for k in BARE_SUFFIXES]
        items += [('addrnum', k) for k in ADDRESS_NUMBER_CONTEXT] + [('addr', k) for k in ADDRESS_CONTEXT]
        items += [('score', k) for k in L.SCORE_CONTEXT] + [('timectx', k) for k in L.TIME_CONTEXT]
        items += [('month', k) for k in L.MONTHS if k]
        items += [('letter', k) for k in L.LETTER_NAMES]
        items += [('tld', k) for k in N._TLD]
        items += [('numword', k) for k in sorted(N._NUMBER_WORDS)]
        items += [('stem', k) for k in N._EXPANSION_STEMS]
        items += [('onset', k) for k in sorted(N._ONSETS)] + [('coda', k) for k in sorted(N._CODAS)]
        items += [('subunit', k) for k in L.CURRENCY_SUBUNIT]
        items += [('front', k) for k in sorted(NUM._FRONT_EXCEPTIONS)]
        return items

    def g_lexicon(self):
        kind, k = self.sweep[self.sweep_i % len(self.sweep)]
        self.sweep_i += 1
        r, n, cap = self.r, self.n_plain, cap_first
        U = tr_upper
        T = {
            'abbr': lambda: [
                f'{k} Ahmet Yılmaz geldi.', f'Elma, armut {k}', f'Elma, armut {k} Sonra geldik.', f'{k}', f'({k})',
                f'{k}, {k}', f'{k}{self.digits(1)}', f'Bunlar {k} ve diğerleri.', f'"{k}"', f'{k}:', f'{U(k)} test',
                f'{k}\n{k}', f'{k} {self.digits(2)}. madde', f'{k}{self.suffix()}'],
            'acronym': lambda: [
                f'{k}{self.suffix()} başvurdu.', f'{k} açıklama yaptı.', f'{k} mi?', f'{k} {self.ch(CLITICS)}?',
                f'{k}-{self.digits(1)}', f'{k} İLE GÖRÜŞME YAPILDI BUGÜN', f'{k.lower()} dedi', f'{k}{self.digits(2)}',
                f'{k}’{self.ch(SUFFIXES)}', f'Yeni {k} binası', f'{k}/{self.ch(ACRONYMS)}'],
            'name': lambda: [
                f'{k}{self.suffix()} gördüm.', f'{k} kullanıyorum.', f'#{k}', f'@{k}', f'{k}.com', f'{k}/{k}',
                f'{k} {self.ch(CLITICS)}?', f'Yeni {k}+ paketi', f'{k} {self.digits(2)} Pro', f'{k}-{self.digits(1)}',
                f'"{k}"', f'{k}\'{self.ch(SUFFIXES)}{self.ch(SUFFIXES)}', f'x{k}', f'{k}x', f'{k}’ın',
                f'{U(k)} HABER BÜLTENİ BAŞLADI', f'{k} ve {self.ch(NAMES_FORMS)}'],
            'caps': lambda: [
                f'{k} {U(self.word())} {U(self.word())} {U(self.ch(TR_VERBS))}',
                f'{U(self.word())} {k} {U(self.word())}LERİ {self.ch(EVAL_ACRONYMS)} AÇIKLADI',
                f'{k}', f'{k}{self.suffix()}', f'Bugün {k} dedi.'],
            'eval': lambda: [
                f'{k} açıklama yaptı.', f'{k}{self.suffix()} gitti',
                f'{U(self.word())} {k} {U(self.word())} TOPLANTISI YAPILDI',
                f'{tr_lower(k)} dedi', f'{k} mi'],
            'unit': lambda: [
                f'{n()} {k}', f'{n()}{k}', f'{n()},{self.digits(1, True)} {k}', f'{n()}.{self.digits(1, True)}{k}',
                f'{n()}-{n()} {k}', f'{n()} - {n()}{k}{self.suffix()}', f'{n()} {k}{self.suffix()}', f'-{n()} {k}',
                f'{n()} {k}/sa', f'{n()} {k}²', f'{n()} {k}x', f'{k} {n()}', f'{n()} {k}.', f'{n()}{k} mi?',
                f'{n()} ila {n()} {k} arası', f'{n()}-{n()} {k} arasında'],
            'speed': lambda: [
                f'{n()} {k}', f'{n()}{k}', f'{n()}-{n()} {k}', f'{n()},{self.digits(1)} {k}{self.suffix()}',
                f'{k} {n()}'],
            'currency': lambda: [
                f'{k}{n()}', f'{k} {n()}', f'{n()} {k}', f'{n()}{k}', f'{n()},{self.digits(2, True)} {k}',
                f'{n()}.{self.digits(3, True)},{self.digits(2, True)} {k}{self.suffix()}', f'{n()}-{n()} {k}',
                f'{n()} {self.ch(["bin", "milyon", "milyar", "trilyon"])} {k}', f'{k}{n()}{self.suffix()}',
                f'{n()} {k} mı?', f'{n()} {k} ile {n()} {k} arasında'],
            'id': lambda: [
                f'{cap(k)}{self.ch(nominal_tails())} {self.digits(r.randint(4, 12))}',
                f'{k}{self.ch(nominal_tails())}: {self.digits(r.randint(5, 11), True)}',
                f'{cap(k)} {self.word()} {self.digits(r.randint(5, 9))}', f'{U(k)} {self.digits(r.randint(5, 12))}',
                f'{k}{self.ch(nominal_tails())} {self.digits(r.randint(5, 8))} {self.ch(L.QUANTITY_AFTER)}',
                f'{cap(k)}{self.ch(nominal_tails())} {self.ch(["sayısı", "adedi", "toplamı"])} {self.digits(5)}',
                f'{k} {self.digits(r.randint(5, 9))} numara',
                f'{k}{self.ch(nominal_tails())}, {self.digits(2)} Kasım {self.digits(4)}'],
            'code': lambda: [
                f'{cap(k)}{self.ch(nominal_tails())} {self.digits(r.randint(3, 8))}', f'{k} {self.digits(4)}',
                f'{U(k)} {self.digits(4)}',
                f'{k}{self.ch(nominal_tails())} {self.digits(4)} {self.ch(L.QUANTITY_AFTER)}',
                f'{cap(k)} {self.word()} {self.word()} {self.digits(6)}'],
            'qbefore': lambda: [
                f'Müşteri {k} {self.digits(5)}', f'{cap(k)} {self.digits(r.randint(4, 7))}',
                f'Hesap {k} {self.digits(6)}'],
            'qafter': lambda: [
                f'Telefonla {self.digits(5)} {k}',
                f'Hesap {self.digits(r.randint(5, 8))} {k}{self.ch(nominal_tails())}',
                f'Kod {self.digits(4)} {k}', f'{self.digits(5)} {U(k)}'],
            'ordnoun': lambda: [
                f'{self.digits(r.randint(1, 2))}. {k}', f'{self.ch(ROMANS)}. {k}',
                f'{k} {self.ch(ROMANS)}{self.suffix()}',
                f'{self.ch(["I", "V", "X"])}. {k}', f'{U(k)} {self.ch(["I", "V", "X"])}\'{self.ch(SUFFIXES)}',
                f'{self.digits(1)}. {U(k)}', f'{self.ch(["I", "V", "X"])}. {U(k)}'],
            'ordprefix': lambda: [
                f'{self.digits(2)}. {k}{self.ch(nominal_tails())}',
                f'{self.ch(ROMANS)}. {k}{self.ch(nominal_tails())}'],
            'title': lambda: [
                f'{cap(k)}. {self.ch(["I", "X", "V"])}. Yılmaz', f'{k} {self.ch(["I", "X", "V"])}. Demir',
                f'{U(k)}. {self.ch(["I", "X", "V"])}. {self.ch(NAME_POOL)}',
                f'{cap(k)} J. {self.ch(["I", "X"])}. Smith',
                f'{cap(k)}. {self.ch(["I", "X", "V"])}. {self.word()}',
                f'{k.upper()} {self.ch(["I", "X", "V"])}. {self.ch(NAME_POOL)}',
                f'{k.title()}.{self.ch(["I", "X", "V"])}. Kaya', f'x{k} I. Kaya'],
            'bare': lambda: [
                f'{self.n_plain()}{k}', f'{self.digits(4)}{k}', f'{self.n_thousands()}{k}', f'{self.n_decimal()}{k}',
                f'{self.digits(1)}{U(k)}', f'-{self.digits(2)}{k}', f'{self.digits(2)}{k}x'],
            'addrnum': lambda: [
                f'{k} {self.digits(2)}/{self.digits(1)}', f'{cap(k)}: {self.digits(1)}/{self.digits(1)}',
                f'{k} {self.digits(3)}/{self.digits(2)}{self.suffix()}', f'{self.digits(2)}/{self.digits(1)} {k}'],
            'addr': lambda: [
                f'{cap(k)} Gül Sok. No:5 D:3 {self.digits(5)} Kadıköy', f'..., {k}, {self.digits(5)} KADIKÖY',
                f'{cap(k)} {self.digits(5)} {self.ch(SUBJECTS)}', f'{U(k)} {self.digits(5)} {U(self.ch(SUBJECTS))}',
                f'{k} {self.digits(1)}, {self.digits(5)} Ankara', f'{k}: {self.digits(5)} İzmir',
                f'{k} / {self.digits(5)} Bursa'],
            'score': lambda: [
                f'{self.digits(1)}-{self.digits(1)} {k}', f'{cap(k)} {self.digits(1)}-{self.digits(1)}',
                f'Takım {self.digits(2)}-{self.digits(2)} {k}', f'{self.digits(1)} - {self.digits(1)} {U(k)}'],
            'timectx': lambda: [
                f'{k} {self.digits(1)}.{self.digits(2, True)}', f'{self.digits(2)}.{self.digits(2, True)} {k}',
                f'{cap(k)} {r.randint(0, 24)}.{str(r.randint(0, 59)).zfill(2)}{self.suffix()}',
                f'{U(k)} {self.digits(2)}.{self.digits(2, True)}'],
            'month': lambda: [
                f'{r.randint(1, 31)} {k} {r.randint(1900, 2100)}',
                f'kodunu gir, {r.randint(1, 31)} {k} {self.digits(4)}{self.suffix()}',
                f'{k} {self.digits(4)}\'{self.ch(SUFFIXES)}', f'{U(k)} {self.digits(4)}',
                f'{tr_lower(k)} {self.digits(5)}',
                f'hesap {tr_lower(k)} {self.digits(6)}'],
            'letter': lambda: [
                f'{k}{self.suffix()}', f'{k} vitamini', f'{k}. Öztürk', f'{k}. {tr_lower(k)}', f'{k} planı',
                f'{k}’{self.ch(SUFFIXES).upper()}', f'{k}{self.ch(["²", "³"])}', f'{tr_lower(k)}{self.ch(["²", "³"])}',
                f'{k}. {k}. {self.ch(NAME_POOL)}', f'"{k}" harfi', f'{k}-{self.digits(1)}'],
            'tld': lambda: [
                f'ornek.{k}', f'ORNEK.{k.upper()}', f'www.ornek.{k}/a', f'ali@ornek.{k}', f'site.{k}\'da', f'x.{U(k)}'],
            'numword': lambda: [
                f'{k}.{self.digits(2)}', f'{k}.{self.digits(1)}{self.suffix()}', f'{U(k)}.{self.digits(1)}',
                f'{k} {self.digits(1)}'],
            'stem': lambda: [
                f'SAAT {self.digits(2)}:30\'DA {k} BAŞLAYACAK DÖRT ETKİNLİK',
                f'{U(self.word())} {k} {U(self.word())} {U(self.word())} OLDU'],
            'onset': lambda: [
                f'{U(k)}AK {U(self.word())} {U(self.word())} {U(self.word())}', f'{U(k)}EN {U(k)}İT HABERİ GELDİ'],
            'coda': lambda: [
                f'{U("a" + k)} {U(self.word())} {U(self.word())} {U(self.word())}', f'BÜYÜK {U("ü" + k)} OLDU BUGÜN'],
            'subunit': lambda: [f'{self.digits(2)},{self.digits(2, True)} {k}',
                                f'{self.digits(2)} {k} {self.digits(2)} kuruş'],
            'front': lambda: [
                f'{self.digits(1)} {k}{self.suffix()}', f'{k} {self.digits(2)}\'{self.ch(SUFFIXES)}',
                f'{self.digits(2)} {k} mi?'],
        }
        text = self.ch(T[kind]())  # only the chosen table's templates are built
        if self.p(0.3):  # in a sentence
            text = f'{self.ch(SUBJECTS)} {text} {self.ch(TR_VERBS)}{self.ch(ENDINGS)}'
        return text

    def mutate(self, t):
        r = self.r
        k = r.randrange(24)
        if k == 0:
            return t.upper()
        if k == 1:
            return tr_upper(t)
        if k == 2:
            return t.lower()
        if k == 3:
            return tr_lower(t)
        if k == 4:
            return t.title()
        if k == 5:
            return t.swapcase()
        if k == 6:
            return re.sub(' ', lambda m: self.ch(WHITESPACE) if self.p(0.4) else ' ', t)
        if k == 7:
            return re.sub("'", lambda m: self.ch(APOSTROPHES), t)
        if k == 8:
            pos = sorted(r.randrange(len(t) + 1) for _ in range(r.randint(1, 4)))
            out, last = [], 0
            for p_ in pos:
                out += [t[last:p_], self.ch(INVISIBLE + WHITESPACE)]
                last = p_
            return ''.join(out) + t[last:]
        if k == 9:
            return unicodedata.normalize(self.ch(['NFD', 'NFKD', 'NFKC', 'NFC']), t)
        if k == 10:
            return self.translit(t, self.ch([1.0, 0.5]))
        if k == 11:  # spaces and repeats around punctuation
            def punct(m):
                return self.ch(['', ' ', '  ']) + m.group(1) * self.ch([1, 1, 2, 3]) + self.ch(['', ' '])

            return re.sub(r'\s*([,.;:!?])\s*', punct, t)
        if k == 12:
            words = t.split(' ')
            i = r.randrange(len(words) + 1)
            return ' '.join(words[:i] + [self.shape()] + words[i:])
        if k == 13:
            words = t.split(' ')
            i = r.randrange(len(words))
            q = self.ch(QUOTES)
            words[i] = q[0] + words[i] + q[1]
            return ' '.join(words)
        if k == 14:
            return ''.join(c + (self.ch(COMBINING) if c.isalpha() and self.p(0.15) else '') for c in t)
        if k == 15:
            return re.sub('[iIıİ]', lambda m: self.ch(DOTTED_I) if self.p(0.5) else m.group(), t)
        if k == 16:
            return re.sub(r'(?<=\d) (?=\w)|(?<=\w) (?=\d)', lambda m: '' if self.p(0.6) else ' ', t)
        if k == 17:
            return re.sub(r'(?<=[.!?]) ', lambda m: self.ch(['\n', '\n\n', '\r\n', '\u2028', '\u2029', ' ']), t)
        if k == 18:
            words = t.split(' ')
            i = r.randrange(len(words) + 1)
            return ' '.join(words[:i] + [self.ch(EMOJI)] + words[i:])
        if k == 19:
            return re.sub('-', lambda m: self.ch(DASHES), t)
        if k == 20:
            return ''.join(chr(ord(c) + 0xFEE0) if '!' <= c <= '~' and self.p(0.5) else c for c in t)
        if k == 21:
            return re.sub(r'[a-zçğıöşü]', lambda m: self.ch(LETTERS_ODD) if self.p(0.04) else m.group(), t)
        if k == 22:
            cut = r.randrange(len(t) + 1)
            return t[:cut] + self.ws() + t[cut:] if self.p(0.5) else t[:cut]
        return self.ch(BULLETS) + t

    def g_mutate(self):
        t = self.ch(self.base) if self.base else self.g_sentence()
        for _ in range(self.ch([1, 1, 1, 2, 2, 3])):
            t = self.mutate(t) if t else t
        return t

    def g_soup(self):
        toks = []
        for _ in range(self.r.randint(2, 20)):
            k = self.r.random()
            if k < 0.45:
                toks.append(self.shape())
            elif k < 0.55:
                toks.append(self.ch(CLITICS))
            elif k < 0.7:
                toks.append(self.word() if self.p(0.7) else tr_upper(self.word()))
            elif k < 0.8:
                toks.append(self.ch(['.', ',', ';', ':', '!', '?', '(', ')', '"', "'", '-', '/', '&', '=', '+', '±',
                                     '~', '≈', '#', '@', '§', '№', '*', '_', '|', '•', '→', '%', '‰', '°', '$', '€',
                                     '£', '₺', '...', '…', '–', '—', '−', '×', '²', '³', '\\', '<', '>', '[', ']', '{',
                                     '}', '^', '¿', '¡', '·', '¶', '†', '‡']))
            elif k < 0.86:
                toks.append(self.ch(SCRIPTS))
            elif k < 0.9:
                toks.append(self.ch(EMOJI))
            elif k < 0.95:
                toks.append(self.ch(OTHER_NUMERIC) + self.ch(['', self.n_plain()]))
            else:
                toks.append(self.ch(INVISIBLE))
        return ''.join(t + (self.ws() if self.p(0.85) else '') for t in toks)

    def g_headline(self):
        k = self.r.random()
        if k < 0.5 and self.base:
            t = self.ch(self.base)
            t = tr_upper(t) if self.p(0.7) else t.upper()
        else:
            ws = [tr_upper(self.word()) for _ in range(self.r.randint(2, 6))]
            ws += [self.ch(CAPS_WORDS + EVAL_ACRONYMS + ACRONYMS) for _ in range(self.r.randint(0, 3))]
            ws += [self.shape() for _ in range(self.r.randint(0, 2))]
            self.r.shuffle(ws)
            t = ' '.join(ws) + self.ch(ENDINGS)
        if self.p(0.3):
            t = self.mutate(t)
        if self.p(0.2):
            t += ' ' + self.g_sentence()
        return t

    def g_clitic(self):
        ent = self.ch([self.shape(), self.shape(), self.s_money(), self.s_unit(), self.number(), self.s_lexword(),
                       self.s_named()])
        cl = self.ch(CLITICS)
        sep = self.ch([' ', ' ', '\t', '  ', ' '])
        if self.p(0.3):
            cl = cl.upper() if self.p(0.5) else tr_upper(cl)
        q = self.ch(['', '?', ' ?', '?"', '")?', ')?', '…?', '?!', '.', ',', ' de?', ' mi?'])
        t = f'{ent}{sep}{cl}{q}'
        if self.p(0.4):
            t = f'{self.ch(SUBJECTS)} {t}'
        if self.p(0.2):
            t += f' {self.ch(CLITICS)} {self.ch(CLITICS)}'
        return t

    def g_chunker(self):
        r = self.r
        target = self.ch([140, 143, 144, 145, 178, 179, 180, 181, 182, 230, 233, 234, 235, 248, 249, 250, 251, 252, 260,
                          300, 360, 500, 720, 1000])
        words, n = [], 0
        while n < target:
            w = self.ch(TR_WORDS + TR_VERBS)
            if self.p(0.08):
                w = self.ch(['a' * r.randint(1, 300), 'ş' * r.randint(100, 260), 'x' * 249, 'çok' * r.randint(30, 90)])
            words.append(w)
            n += len(w) + 1
        out = []
        for w in words:
            out.append(w)
            if self.p(0.12):
                out[-1] += self.ch(['.', ',', ';', ':', '!', '?', '...', '."', '!)', ".'", '?"\')', ',,', ' -', '-',
                                    ' .', ' ,', '…', ';;', '?!', '.)"'])
        sep = self.ch([' ', ' ', '  ', ' \n', '\t'])
        t = sep.join(out)
        if self.p(0.3):  # punctuation exactly around a cut point
            cut = self.ch([144, 180, 234, 250]) + r.randint(-3, 3)
            if cut < len(t):
                t = t[:cut] + self.ch(['. ', ', ', '! ', '?" ', '; ', ' ', '.', ',']) + t[cut:]
        if self.p(0.2):
            t = self.mutate(t)
        if self.p(0.1):
            t = self.ch(['', '"', '(', '...', '- ', '— ', '« ']) + t + self.ch(['', '"', ')', '...', ' -', ',', ':',
                                                                                ' »'])
        return t

    def g_window(self):
        r = self.r
        cue = self.ch(list(L.ID_CONTEXT) + list(L.CODE_CONTEXT) + list(L.TIME_CONTEXT) + list(L.SCORE_CONTEXT)
                      + ADDRESS_NUMBER_CONTEXT + ADDRESS_CONTEXT + QUANTITY_BEFORE
                      + ['yüzde', 'oran', 'faiz', 'puan', 'not', 'ortalama', 'Kasım', 'Dr', 'Sayın', 'Lig'])
        width = self.ch([20, 22, 23, 24, 25, 26, 30, 31, 32, 33, 34, 38, 39, 40, 41, 42, 46, 47, 48, 49, 50, 98, 99,
                         100, 101])
        fill_chars = self.ch([['𐐀', '𐐨', '𠀀', '𝐀'], ['a', 'b', 'ş'], ['𐐀', 'a'], ['😀'], ['ı', 'İ'], ['\U0002EBF0'],
                              ['\u0307'], ['é', 'e\u0301']])
        filler, n = [], 0
        while n < width - len(cue) - 2:
            w = ''.join(self.ch(fill_chars) for _ in range(r.randint(1, 6)))
            filler.append(w)
            n += len(w) + 1
        target = self.ch([self.digits(r.randint(4, 12)), f'{self.digits(2)}.{self.ch(["00", "30", "15", "45"])}',
                          f'{self.digits(1)}-{self.digits(1)}', f'{self.digits(2)}/{self.digits(1)}', self.digits(5),
                          f'{self.digits(2)} TL mi', f'V. {self.ch(NAME_POOL)}', f'I. {self.ch(NAME_POOL)}',
                          f'{self.digits(4)} {self.ch(["mi", "da", "mı"])}'])
        lead = cue if self.p(0.7) else cap_first(cue)
        return f'{lead} {" ".join(filler)} {target}' + self.ch(['', '.', ' Kadıköy', ' kişi', ' lira', '?'])

    def g_dollar(self):
        """Python's $ also matches before a final newline (JavaScript's does not): windows that end in "\\n" before
        a Roman numeral, an initial, a postcode or an abbreviation."""
        sp = self.ch(['', ' ', '\t', ' \t', '  '])
        nl = self.ch(['\n', '\n', '\r\n', '\n\n', '\r', '\u2028', '\x85'])
        roman, nm, ini = self.ch(['I', 'V', 'X', 'II', 'IV', 'XIV']), self.ch(NAME_POOL), self.ch(['I', 'X', 'V'])
        regnal = self.ch(['Louis', 'Madde', 'Ek', 'Murat', 'Henry'])
        addr = self.ch(['Mah.', 'Cad.', 'Sok.', 'No:5', 'Daire 3', 'Kat 2', 'sokak', 'adresi', 'beş', 'on'])
        place = self.ch(['Kadıköy', 'KADIKÖY', 'Ankara', 'İzmir'])
        t = self.ch([
            f'{self.ch(ORD_NOUNS)}{sp}{nl}{roman}{self.apos()}{self.ch(SUFFIXES)}',
            f'{regnal}{sp}{nl}{self.ch(["V", "X", "I"])}\'{self.ch(["e", "un", "te", "de", "ye", "in"])}',
            f'{cap_first(self.ch(L.INITIAL_TITLES))}.{sp}{nl}{ini}. {nm}',
            f'{self.ch(L.INITIAL_TITLES).upper()}{sp}{nl}{ini}. {nm}',
            f'{self.ch(["J.", "K.", "A.", "Ş."])}{sp}{nl}{ini}. {nm}',
            f'{addr}{sp}{nl}{self.digits(5)} {place}',
            f'{self.ch(ABBREVIATIONS)}{sp}{nl}{self.ch(["", "Sonra geldi.", "sonra geldi.", "Ali", "5"])}',
            f'{self.ch(SUBJECTS)} {self.number()}{sp}{nl}{self.ch(CLITICS)}?',
            f'{self.word()}{sp}{nl}{self.s_time()}', f'%{sp}{nl}{self.s_time()}', f'₺{nl}{self.s_time()}',
        ])
        return t + self.ch(['', '', '\n', ' ', '.'])

    def newchar(self):
        lo, hi = self.ch(NEW_RANGES)
        return chr(self.r.randint(lo, hi))

    def g_newuni(self):
        """Characters assigned after Unicode 15.0 (Pyodide's Python): unassigned there, letters, digits, case pairs
        and canonical compositions to a browser that knows Unicode 15.1 / 16.0."""
        k = self.r.random()
        if k < 0.25:  # where \w, isalpha, isupper or \d decide: next to numbers, names, suffixes, headlines
            c = ''.join(self.newchar() for _ in range(self.r.randint(1, 3)))
            return self.ch([f'{self.number()}{c}', f'{c}{self.number()}', f'{c}{self.suffix()}', f'{self.s_named()}{c}',
                            f'{c} {self.s_ordinal()}', f'{self.s_url()[:-1]}{c}.com', f'{c}@{c}.com',
                            f'{tr_upper(self.word())} {c} {tr_upper(self.word())} {tr_upper(self.word())} {c}',
                            f'{self.ch(SUBJECTS)} {c}{self.shape()}{c} {self.ch(TR_VERBS)}.'])
        if k < 0.45:  # case pairs (Garay, Cyrillic tje, Latin Extended-D)
            up = ''.join(self.ch(NEW_CASED) for _ in range(self.r.randint(2, 8)))
            return self.ch([f'{up} {tr_upper(self.word())} {tr_upper(self.word())} {tr_upper(self.word())}',
                            f'{up}\'{self.ch(SUFFIXES)}', f'{self.digits(2)}. {up}', f'{up} {self.ch(CLITICS)}?', up])
        if k < 0.6:  # canonical compositions (Kirat Rai, Tulu-Tigalari, Gurung Khema)
            seq = ''.join(self.ch(NEW_COMPOSE) for _ in range(self.r.randint(1, 4)))
            return f'{self.word()}{seq} {self.ch(TR_VERBS)} {seq}{self.word()}{self.ch(ENDINGS)}'
        if k < 0.8:  # new decimal digits in number shapes
            nd = self.ch(ND_SETS[-7:])
            s = self.shape(self.ch(['number', 'date', 'time', 'money', 'percent', 'unit', 'phone', 'ordinal']))
            return f'{self.ch(SUBJECTS)} ' + ''.join(nd[ord(c) - 48] if '0' <= c <= '9' else c for c in s)
        return ' '.join(self.newchar() + (self.word() if self.p(0.5) else '') for _ in range(self.r.randint(1, 12)))

    def g_noise(self):
        r = self.r
        out = []
        for _ in range(r.randint(1, 40)):
            k = r.random()
            if k < 0.3:
                c = r.randrange(0x20, 0x250)
            elif k < 0.55:
                c = r.randrange(0x250, 0x3000)
            elif k < 0.7:
                c = r.randrange(0x3000, 0x10000)
            elif k < 0.85:
                c = r.randrange(0x10000, 0x30000)
            elif k < 0.9:
                c = r.randrange(0x2EBF0, 0x2EE5E)  # assigned in Unicode 15.1 only
            elif k < 0.95:
                c = r.randrange(0x30000, 0x110000)
            else:
                c = r.randrange(0, 0x20)
            if 0xD800 <= c <= 0xDFFF and self.p(0.7):
                c = 0x41
            out.append(chr(c))
            if self.p(0.2):
                out.append(' ')
            if self.p(0.05):
                out.append(self.shape())
        s = ''.join(out)
        return s if self.p(0.6) else f'{self.word()} {s} {self.shape()} {self.word()}.'

    def g_long(self):
        r = self.r
        k = r.random()
        if k < 0.4:
            return ', '.join(self.g_sentence().rstrip('.!?') for _ in range(r.randint(5, 25))) + '.'
        if k < 0.55:
            return ' '.join(self.shape() for _ in range(r.randint(30, 120)))
        if k < 0.7:
            return self.ch(['a', 'ş', 'İ', 'ı', 'x', 'é', '𐐀', 'ab ']) * r.randint(200, 3000)
        if k < 0.8:
            return f'{self.ch(SUBJECTS)} {self.n_huge()} {self.ch(TR_VERBS)}.'
        if k < 0.9:
            return ' '.join(self.ch(TR_WORDS) for _ in range(r.randint(100, 1200)))
        return '\n'.join(self.g_sentence() for _ in range(r.randint(10, 40)))

    def g_tiny(self):
        return self.ch(['', ' ', '  ', '\n', '\t', '\r\n', '\u3000', '\xa0', '.', ',', '?', '!', '...', '…', "'",
                        '"', '-', '—', '(', ')', '()', '[]', '""', "''", '?!', '.?', '0', '1', '5', '9', '00', '٣',
                        '３', '𝟓', '²', '½', 'Ⅻ', 'a', 'A', 'İ', 'I', 'ı', 'i', 'i\u0307', 'I\u0307', '\u0307', 'ß',
                        'ẞ', 'ǅ', 'ﬁ', 'Σ', 'ς', 'x', 'X', 'V', 'V.', 'I.', 'X.', 'O', "O'nun", 'mi', 'mı?', 'de',
                        'TL', '₺', '$', '%', '%5', '5%', '°', '°C', '&', '@', '#', '*', '_', '|', '/', '\\', '=',
                        '+', '±', '~', '😀', '🇹🇷', '\ue000', '\ufeff', '\u200b', '\u200e', '\x00', '\x7f', '\ud800',
                        '\udfff', 'a\udc00b', '\ud83d', '5\udc00', '\U000e0041', ' . ', ' , ', '- -', 'a.', 'a,',
                        'A.', 'a b', 'ab.', 'Ab?', self.ch(SCRIPTS), self.ch(EMOJI), self.ch(INVISIBLE),
                        self.ch(COMBINING), self.ch(DOTTED_I), self.ch(LETTERS_ODD), self.ch(OTHER_NUMERIC),
                        self.ch(WHITESPACE), self.shape()])

    def g_doc(self):
        r = self.r
        lines = []
        for _ in range(r.randint(2, 12)):
            k = r.random()
            if k < 0.2:
                lines.append(self.ch(BULLETS) + self.g_sentence())
            elif k < 0.3:
                lines.append(tr_upper(self.ch(TR_WORDS)) + ' ' + tr_upper(self.ch(TR_WORDS)))
            elif k < 0.4:
                lines.append(f'{self.digits(1)}.{self.digits(1)} {cap_first(self.word())}')
            elif k < 0.5:
                lines.append('\t'.join(self.shape() for _ in range(r.randint(2, 5))))
            elif k < 0.55:
                lines.append('')
            elif k < 0.6:
                q = self.ch(QUOTES)
                lines.append(q[0] + self.g_sentence() + q[1])
            else:
                lines.append(self.g_sentence())
        return self.ch(['\n', '\n\n', '\r\n', '\n \n', '\u2029']).join(lines)

    def g_unicode(self):
        base = self.ch(self.base) if self.base and self.p(0.5) else self.g_sentence()
        pool = self.ch([SCRIPTS, LETTERS_ODD, COMBINING, DOTTED_I, OTHER_NUMERIC, INVISIBLE, EMOJI, WHITESPACE])
        words = base.split(' ')
        for _ in range(self.r.randint(1, 4)):
            i = self.r.randrange(len(words))
            j = self.r.randrange(len(words[i]) + 1)
            words[i] = words[i][:j] + self.ch(pool) + words[i][j:]
        return ' '.join(words)

    def case(self):
        gi = self.r.choices(range(len(self.gens)), weights=self.weights)[0]
        name, _, fn = self.gens[gi]
        return name, fn()


def cap_first(w):
    return tr_upper(w[:1]) + w[1:]


# ---------------------------------------------------------------------------------------------------- output


def dump(obj):
    """One JSON line, UTF-8 where it can be: a text with a lone surrogate is written with \\u escapes."""
    try:
        line = json.dumps(obj, ensure_ascii=False)
        line.encode('utf-8')
        return line
    except UnicodeEncodeError:
        return json.dumps(obj, ensure_ascii=True)


def canonical(text):
    """The text as both sides read it back from JSON (an escaped surrogate pair becomes one code point)."""
    return json.loads(json.dumps(text))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', required=True, help='directory for corpus.jsonl')
    ap.add_argument('--fuzz', type=int, default=0, help='number of generated cases to add')
    ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--fuzz-only', action='store_true', help='only the generated cases')
    a = ap.parse_args(argv)

    seen, rows, counts = set(), [], {}
    base = base_cases()
    if not a.fuzz_only:
        for cid, text, speed in base:
            text = canonical(text)
            key = text if speed is None else (text, json.dumps(speed))
            if key in seen:
                continue
            seen.add(key)
            rows.append({'id': cid, 'text': text, 'speed': base_speed(cid) if speed is None else speed})
            src = cid.split(':')[0]
            counts[src] = counts.get(src, 0) + 1
    if a.fuzz:
        fz = Fuzz(a.seed, [t for _, t, _ in base])
        fuzz_seen = {canonical(t) for _, t, _ in base}  # as without --fuzz-only: the fuzz part is the same either way
        made, tries = 0, 0
        while made < a.fuzz and tries < a.fuzz * 50:
            tries += 1
            name, text = fz.case()
            text = canonical(text)
            speed = fz.ch(SPEEDS) if fz.p(0.15) else 1.0
            if text in fuzz_seen:
                continue
            fuzz_seen.add(text)
            rows.append({'id': f'fuzz.{name}:{a.seed}:{made:06d}', 'text': text, 'speed': speed})
            counts['fuzz.' + name] = counts.get('fuzz.' + name, 0) + 1
            made += 1
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, 'corpus.jsonl')
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        for row in rows:
            f.write(dump(row) + '\n')
    print(json.dumps({'corpus': path, 'cases': len(rows), 'sources': counts}, ensure_ascii=False))


if __name__ == '__main__':
    main()
