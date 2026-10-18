// The Python semantics the trnorm port relies on, where JavaScript differs (no Python file of its own: str, re and
// int() as CPython 3.12 defines them, the Python Pyodide runs).
//  - re: \w \d \b are ASCII-only in JS even with the u flag; \s and trim() use another whitespace set; $ also matches
//    before a final newline in Python; pattern.match / fullmatch / search take pos and endpos.
//  - str: len() and indices count code points (JS counts UTF-16 units); split() and strip() use Python's
//    whitespace; split(sep, 1) splits once (JS's limit truncates); isupper(), isdecimal()... as Python defines them.
//  - int(): unbounded (BigInt), any Unicode decimal digits, and str <-> int conversion refuses more than 4300 digits
//    (ValueError): normalize() raises there in Python, so it throws here.

// ---- regex fragments --------------------------------------------------------------------------------------------------
// Every pattern is compiled with the u flag. Python's \w (str patterns) is str.isalnum() or "_", i.e. letters and
// everything with a numeric value: \p{L}\p{N}_. \d is str.isdecimal(): \p{Nd}. \s is str.isspace(): Zs and the bidi
// classes WS, B, S, so \x1c-\x1f and \x85 more than JS's \s, and \u{feff} not. Checked over every code point against
// CPython 3.12 (Unicode 15.0): they differ only on characters Unicode 15.0 does not assign, which normalize() hides
// from the engine (normalizer.js, unassigned.js).
export const WC = String.raw`\p{L}\p{N}_`; // \w inside a class
export const W = `[${WC}]`;
export const D = String.raw`\p{Nd}`; // also usable inside a class
export const SC = String.raw`\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}`;
export const S = `[${SC}]`;
export const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`; // \b
export const END = String.raw`(?=\n?$)`; // $ (no MULTILINE): the end, or before a newline that ends the text
export const ANY = String.raw`[^\n]`; // . (no DOTALL)

// Python's re.IGNORECASE matches a character whose simple lowercase is the pattern's, plus fixed equivalents (i ~ ı,
// s ~ ſ); JS's i flag folds case instead, so İ and ı would not match i. ci(word) spells a lowercase literal the way
// Python matches it under re.I; the classes for i, ı, k and s are Python's, checked over all code points.
const CI = { i: 'Iiİı', ı: 'Iiİı', k: 'Kk\u{212a}', s: 'Ssſ' };
export function ci(word) {
  let out = '';
  for (const c of word) {
    const up = c.toUpperCase();
    out += CI[c] ? `[${CI[c]}]` : up !== c ? `[${up}${c}]` : escape(c);
  }
  return out;
}
export const CI_A_Z = 'A-Za-zİıſ\u{212a}'; // [a-z] under re.I, inside a class

// re.escape for a literal: only what is special in a u-flag pattern (Python's re.escape also escapes "-", " ", "#",
// "&", "~", which a u-flag pattern rejects)
function escape(s) {
  return s.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
}

// A compiled pattern. Matches are JS exec arrays: m[0], m[n] (undefined where Python has None), m.index; positions are
// UTF-16 indices (cp_back / cp_fwd do Python's character arithmetic on them).
class Pattern {
  constructor(source) {
    this.source = source;
    this.rx = new RegExp(source, 'gu');
    this._y = null;
    this._full = null;
  }

  // pattern.match(text, pos): a match that starts at pos
  match(text, pos = 0) {
    const rx = this._y || (this._y = new RegExp(this.source, 'uy'));
    rx.lastIndex = pos;
    return rx.exec(text);
  }

  // pattern.fullmatch(text, pos): from pos to the end
  fullmatch(text, pos = 0) {
    const rx = this._full || (this._full = new RegExp(`(?:${this.source})$`, 'uy'));
    rx.lastIndex = pos;
    return rx.exec(text);
  }

  // pattern.search(text, pos, endpos): the text ends at endpos ($, lookaheads), lookbehinds still see before pos
  search(text, pos = 0, endpos = text.length) {
    const rx = this.rx;
    rx.lastIndex = pos;
    return rx.exec(endpos < text.length ? text.slice(0, endpos) : text);
  }

  // lastIndex is set before every exec, so a callback may use the same pattern in between. No pattern in trnorm
  // matches the empty string; one that did would step past an empty match the way Python did before 3.7.
  *finditer(text) {
    const rx = this.rx;
    let pos = 0;
    while (pos <= text.length) {
      rx.lastIndex = pos;
      const m = rx.exec(text);
      if (!m) return;
      yield m;
      pos = m.index + m[0].length;
      if (!m[0]) pos += cp_len_at(text, pos);
    }
  }

  // findall for a pattern without groups
  findall(text) {
    return text.match(this.rx) || [];
  }

  // sub with a function of the match, or a literal string (no backreferences)
  sub(repl, text) {
    let out = '';
    let pos = 0;
    for (const m of this.finditer(text)) {
      out += text.slice(pos, m.index) + (typeof repl === 'string' ? repl : repl(m));
      pos = m.index + m[0].length;
    }
    return pos ? out + text.slice(pos) : text;
  }

  split(text) {
    return text.split(this.rx);
  }
}

// The re module: re.compile(pattern), and re.sub / match / fullmatch / search / findall / split taking a pattern
// source, compiled once and cached (as Python's re caches), so the port can keep Python's inline calls.
const cache = new Map();
function compile(source) {
  let p = cache.get(source);
  if (!p) cache.set(source, (p = new Pattern(source)));
  return p;
}
export const re = {
  compile,
  escape,
  sub: (source, repl, text) => compile(source).sub(repl, text),
  match: (source, text) => compile(source).match(text),
  fullmatch: (source, text) => compile(source).fullmatch(text),
  search: (source, text) => compile(source).search(text),
  findall: (source, text) => compile(source).findall(text),
  split: (source, text) => compile(source).split(text),
};
// match.end()
export const end = (m) => m.index + m[0].length;

// ---- code points ------------------------------------------------------------------------------------------------------
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
const cp_len_at = (s, i) => (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)) ? 2 : 1);

// len(s)
export function plen(s) {
  let n = s.length;
  for (let i = 0; i < s.length - 1; i++) {
    if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1))) {
      n--;
      i++;
    }
  }
  return n;
}

// the index n code points before / after index i: Python's text[i - n:i] is s.slice(cp_back(s, i, n), i)
export function cp_back(s, i, n) {
  for (; n > 0 && i > 0; n--) i -= i >= 2 && isLow(s.charCodeAt(i - 1)) && isHigh(s.charCodeAt(i - 2)) ? 2 : 1;
  return i;
}
export function cp_fwd(s, i, n) {
  for (; n > 0 && i < s.length; n--) i += cp_len_at(s, i);
  return i;
}
// s[0] and s[-1] ('' for an empty string, where Python's s[:1] and s[-1:] are '')
export const first_cp = (s) => (s ? String.fromCodePoint(s.codePointAt(0)) : '');
export const last_cp = (s) => (s ? s.slice(cp_back(s, s.length, 1)) : '');
// the character that ends at index i (Python's text[i - 1])
export const char_before = (s, i) => s.slice(cp_back(s, i, 1), i);

// ---- str methods ------------------------------------------------------------------------------------------------------
const SPACE = new Set();
for (const [a, b] of [[0x09, 0x0d], [0x1c, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]) {
  for (let c = a; c <= b; c++) SPACE.add(c);
}
// Python's whitespace is all in the BMP, so a UTF-16 unit test is a code point test.
const isspace_unit = (s, i) => SPACE.has(s.charCodeAt(i));

// s.strip() / s.strip(chars) and the one-sided forms; chars: BMP characters
function stripper(s, chars, left, right) {
  const has = chars === undefined ? (i) => isspace_unit(s, i) : (i) => chars.includes(s[i]);
  let a = 0;
  let b = s.length;
  if (left) while (a < b && has(a)) a++;
  if (right) while (b > a && has(b - 1)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
export const strip = (s, chars) => stripper(s, chars, true, true);
export const lstrip = (s, chars) => stripper(s, chars, true, false);
export const rstrip = (s, chars) => stripper(s, chars, false, true);

// s.split() (no separator): runs of whitespace, no empty strings
export function split(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isspace_unit(s, i)) i++;
    if (i >= n) break;
    let j = i + 1;
    while (j < n && !isspace_unit(s, j)) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out;
}

// s.split(sep, 1)
export function split1(s, sep) {
  const i = s.indexOf(sep);
  return i < 0 ? [s] : [s.slice(0, i), s.slice(i + sep.length)];
}

const ALPHA = /^\p{L}+$/u;
const DECIMAL = /^\p{Nd}+$/u;
// str.isdigit(): decimals plus the other Numeric_Type=Digit characters (superscripts, circled digits...), from
// CPython 3.12's unicodedata (the same 128 in 3.13)
const DIGIT = new RegExp(String.raw`^[\p{Nd}\u{b2}-\u{b3}\u{b9}\u{1369}-\u{1371}\u{19da}\u{2070}\u{2074}-\u{2079}` +
  String.raw`\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247c}\u{2488}-\u{2490}\u{24ea}\u{24f5}-\u{24fd}\u{24ff}` +
  String.raw`\u{2776}-\u{277e}\u{2780}-\u{2788}\u{278a}-\u{2792}\u{10a40}-\u{10a43}\u{10e60}-\u{10e68}` +
  String.raw`\u{11052}-\u{1105a}\u{1f100}-\u{1f10a}]+$`, 'u');
const ALNUM = /^[\p{L}\p{N}]+$/u; // isalpha() or a numeric value
const UPPER = /\p{Uppercase}/u;
const LOWER = /\p{Lowercase}/u;
const TITLE = /\p{Lt}/u;

export const isalpha = (s) => ALPHA.test(s);
export const isdecimal = (s) => DECIMAL.test(s);
export const isdigit = (s) => DIGIT.test(s);
export const isalnum = (s) => ALNUM.test(s);
// at least one cased character, and no character of the other case (or titlecase)
export function isupper(s) {
  let cased = false;
  for (const c of s) {
    if (LOWER.test(c) || TITLE.test(c)) return false;
    if (!cased && UPPER.test(c)) cased = true;
  }
  return cased;
}
export function islower(s) {
  let cased = false;
  for (const c of s) {
    if (UPPER.test(c) || TITLE.test(c)) return false;
    if (!cased && LOWER.test(c)) cased = true;
  }
  return cased;
}

// ---- int() ------------------------------------------------------------------------------------------------------------
export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}
const MAX_STR_DIGITS = 4300; // sys.get_int_max_str_digits() default

// The value of a decimal digit (\p{Nd}): Unicode encodes them in runs of ten, zero to nine.
const ND = /^\p{Nd}$/u;
const digitCache = new Map();
export function digit_value(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let v = digitCache.get(cp);
  if (v === undefined) {
    let zero = cp;
    while (ND.test(String.fromCodePoint(zero - 1))) zero--;
    v = (cp - zero) % 10;
    digitCache.set(cp, v);
  }
  return v;
}

// int(s) -> BigInt: surrounding whitespace, a sign, decimal digits of any script, single underscores between digits
export function py_int(s) {
  const t = strip(s);
  let i = 0;
  let neg = false;
  if (t[0] === '+' || t[0] === '-') {
    neg = t[0] === '-';
    i = 1;
  }
  let ascii = '';
  let underscore = false;
  for (const c of t.slice(i)) {
    if (c === '_' && ascii && !underscore) {
      underscore = true;
      continue;
    }
    if (!ND.test(c)) throw new ValueError(`invalid literal for int() with base 10: '${s}'`);
    ascii += digit_value(c);
    underscore = false;
  }
  if (!ascii || underscore) throw new ValueError(`invalid literal for int() with base 10: '${s}'`);
  if (ascii.length > MAX_STR_DIGITS) {
    throw new ValueError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion: value has ` +
      `${ascii.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  const n = BigInt(ascii);
  return neg ? -n : n;
}

// str(n) for an int
export function int_str(n) {
  const s = BigInt(n).toString();
  if (s.replace('-', '').length > MAX_STR_DIGITS) {
    throw new ValueError(`Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion; use ` +
      'sys.set_int_max_str_digits() to increase the limit');
  }
  return s;
}
