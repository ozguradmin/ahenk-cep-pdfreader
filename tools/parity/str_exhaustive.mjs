// Compares docs/js/trnorm/py.js's str methods and casing.js with str_exhaustive.py's results, code point by code point.
//   node --max-old-space-size=8000 tools/parity/str_exhaustive.mjs DIR       (exit 1 on any difference)
import { readFileSync } from 'node:fs';
import { tr_lower, tr_upper } from '../../docs/js/trnorm/casing.js';
import { isalnum, isalpha, isdecimal, isdigit, islower, isupper, lower, strip, upper } from '../../docs/js/trnorm/py.js';

const { python, unicode, rows } = JSON.parse(readFileSync(`${process.argv[2]}/str.json`, 'utf8'));
const isspace = (ch) => strip(ch) === ''; // one character: py.js's strip() takes it away when it is a space
const FIELDS = ['lower', 'upper', 'sigma_after', 'sigma_alone', 'sigma_before', 'flags', 'tr_lower', 'tr_upper'];
const differ = Object.fromEntries(FIELDS.map((f) => [f, []]));
let i = 0;
for (let c = 0; c < 0x110000; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCodePoint(c);
  const flags = [isupper, islower, isalpha, isdecimal, isdigit, isalnum, isspace].map((f) => (f(ch) ? '1' : '0')).join('');
  const got = [lower(ch), upper(ch), lower(`Α${ch}Σ`), lower(`${ch}Σ`), lower(`ΑΣ${ch}`), flags, tr_lower(ch), tr_upper(ch)];
  got.forEach((g, k) => {
    if (g !== rows[i][k]) differ[FIELDS[k]].push(`U+${c.toString(16).toUpperCase()} py=${JSON.stringify(rows[i][k])} js=${JSON.stringify(g)}`);
  });
  i++;
}
const bad = Object.values(differ).reduce((a, d) => a + d.length, 0);
console.log(JSON.stringify({ python, python_unicode: unicode, engine_unicode: process.versions.unicode, code_points: i,
  differ: Object.fromEntries(Object.entries(differ).map(([k, d]) => [k, d.length])),
  examples: Object.values(differ).flat().slice(0, 12) }));
process.exitCode = bad ? 1 : 0;
