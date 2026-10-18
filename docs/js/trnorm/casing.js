// trnorm/casing.py in JavaScript: Turkish-aware casing helpers.
//
// Python's str.lower()/upper() are locale-agnostic: "I".lower() == "i" and "İ".lower() == "i̇" (i + combining dot).
// Turkish needs I<->ı and İ<->i. JS's toLowerCase()/toUpperCase() (never the toLocale* forms) are the same full
// Unicode mappings, final sigma included: they agree with CPython 3.12 on every character Unicode 15.0 assigns, except
// that a newer engine uppercases ƛ and ɤ (capitals added in Unicode 16). normalize() only changes the case of
// Turkish letters and its own words, and hides characters newer than Unicode 15.0 from the engine (normalizer.js).

import { first_cp, isalpha, isupper } from './py.js';

const LOWER_MAP = { I: 'ı', İ: 'i' };
const UPPER_MAP = { i: 'İ', ı: 'I' };

// Lowercase with Turkish dotted/dotless i rules.
export function tr_lower(text) {
  return text.replace(/[Iİ]/gu, (c) => LOWER_MAP[c]).toLowerCase().replaceAll('i\u{307}', 'i');
}

// Uppercase with Turkish dotted/dotless i rules.
export function tr_upper(text) {
  return text.replace(/[iı]/gu, (c) => UPPER_MAP[c]).toUpperCase();
}

// Uppercase the first letter only (Turkish rules), keep the rest.
export function tr_capitalize(word) {
  if (!word) return word;
  const first = first_cp(word);
  return tr_upper(first) + word.slice(first.length);
}

// True when the word has at least two letters and every letter is uppercase.
export function is_all_caps(word) {
  const letters = [...word].filter(isalpha);
  return letters.length >= 2 && letters.every(isupper);
}
