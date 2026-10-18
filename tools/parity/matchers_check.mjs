// The port's linear matchers (normalizer.js: _URL_RE, _EMAIL_RE, _ALNUM_RE's finditer, the anchored leftover-digit
// and cleanup patterns, _letters_at_end) against the patterns they stand for, the plain translation of Python's, on
// random strings made of the pieces those patterns care about. Every match (start, text, groups) must be the same.
//   node tools/parity/matchers_check.mjs [N] [SEED]      (default 200000 strings per matcher, seed 1)
import { _testing } from '../../docs/js/trnorm/normalizer.js';

const N = Number(process.argv[2] || 200000);
let seed = Number(process.argv[3] || 1) >>> 0;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

const POOLS = {
  web: ['a', 'b', 'x', 'o', 'm', 'c', 'com', 'co', 'COM', 'net', 'tr', 'io', 'ai', 'info', 'me', 'dev', 'app', 'org',
    'İo', 'ıo', 'ſ', 'K', 'K', 'www', 'WWW', 'www.', 'http://', 'https://', 'HTTPS://', 'httpſ://', '.', '.', '.',
    '-', '-', '_', '/', '//', ':', '@', '@', '+', ' ', ' ', '\n', '1', '12', '٣', '𝐀', '𝟏', 'é', 'ş', 'Ş', 'ğ', '?', ',',
    "'", 'q=1', 'uk', 'Tr', '\u{1171e}', 'Σ'],
  alnum: ['A', 'B', 'Ş', 'İ', 'Ö', 'a', 'b', 'ş', 'ı', 'x', '1', '2', '0', '٣', '𝟏', '-', '-', '-', '.', ',', "'", "'de",
    "'DA", 'é', '_', ' ', '𝐀', 'GPT', 'COVID', '19', '3.5', 'mp3', 'ab'],
  mail: ['a', 'b', 'x1', 'ş', 'İ', '𝐀', '٣', '_', '-', '-', '.', '.', '.', '+', '@', '@', '@', 'com', 'tr', ' ', ',', "'",
    '\u{1171e}', 'é', '(', '..'],
  letters: ['a', 'b', 'ş', 'İ', 'Z', 'x', '.', '.', '1', '5', '٣', ' ', '\n', '\n', 'é', '𝐀', ',', 'ab', 'Ab'],
  space: [' ', ' ', '\n', '\t', '\r\n', '\x1c', ' ', ' ', ',', '.', ';', ':', '!', '?', ')', 'a', 'ş', '(', '1'],
};

function sample(pool, maxLen) {
  const n = 1 + Math.floor(rand() * maxLen);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(pool);
  return s;
}

const key = (m) => JSON.stringify([m.index, ...m]);
function plain(source, text) { // finditer of the plain global pattern (none of these matches the empty string)
  const rx = new RegExp(source, 'gu');
  return [...text.matchAll(rx)].map(key);
}

const checks = {
  url: ['web', 40],
  email: ['web', 40],
  email_dense: ['mail', 30],
  alnum: ['alnum', 30],
  leftover: ['letters', 30],
  cleanup: ['space', 30],
};
let bad = 0;
const t0 = performance.now();
for (const [name, [pool, len]] of Object.entries(checks)) {
  const [matcher, source] = _testing[name.replace('_dense', '')];
  let differ = 0;
  let matched = 0; // strings with at least one match: the check is not vacuous
  for (let i = 0; i < N; i++) {
    const text = sample(POOLS[pool], len);
    const got = [...matcher.finditer(text)].map(key);
    const want = plain(source, text);
    if (want.length) matched++;
    if (got.join('\n') !== want.join('\n')) {
      if (differ++ < 5) console.log(JSON.stringify({ name, text, got, want }));
    }
  }
  bad += differ;
  console.log(JSON.stringify({ matcher: name, cases: N, matched, differ }));
}
{ // _letters_at_end(head) against re.search(([LET]+)\.?$, head)
  const [fn, source] = _testing.letters_at_end;
  const rx = new RegExp(source, 'u');
  let differ = 0;
  for (let i = 0; i < N; i++) {
    const head = sample(POOLS.letters, 12);
    const m = rx.exec(head);
    if (fn(head) !== (m ? m[1] : '')) if (differ++ < 5) console.log(JSON.stringify({ head, got: fn(head), want: m && m[1] }));
  }
  bad += differ;
  console.log(JSON.stringify({ matcher: 'letters_at_end', cases: N, differ }));
}
console.log(JSON.stringify({ differ: bad, seconds: Math.round((performance.now() - t0) / 100) / 10 }));
process.exitCode = bad ? 1 : 0;
