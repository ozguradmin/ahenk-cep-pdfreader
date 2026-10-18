// Compares docs/js/front-native.js with front_exhaustive.py's per-code-point results.
//   node --max-old-space-size=8000 tools/parity/front_exhaustive.mjs DIR [--vocab MODEL.json]
// Prints a JSON summary per test; any difference exits 1, also on a code point that Python's Unicode leaves unassigned
// (newer_unicode_only: the engine knows it; the port reads it as Python does all the same).
import { readFileSync } from 'node:fs';
import { alphabet, blocks, chunk, frontend, piece } from '../../docs/js/front-native.js';

const args = process.argv.slice(2);
const dir = args[0];
const vocabPath = args.includes('--vocab') ? args[args.indexOf('--vocab') + 1]
  : '/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad/hf/ahenk-cep.json';
const letters = new Set(JSON.parse(readFileSync(vocabPath, 'utf8')).vocab);
const universal = { has: () => true };
const PROBE_A = 'a'.repeat(170) + ' ' + 'b'.repeat(5);
const PROBE_B = ' ' + 'c'.repeat(100);
const load = (name) => JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
const meta = load('meta');
const unassigned = new Set(meta.unassigned);

const every = [];
for (let c = 0; c < 0x110000; c++) every.push(c);
const nosur = every.filter((c) => c < 0xd800 || c > 0xdfff);

const TESTS = {
  blocks: [nosur, (c) => [blocks(c), blocks('a' + c + 'a')]],
  alphabet_model: [nosur, (c) => alphabet(c, letters)],
  alphabet_universal: [nosur, (c) => alphabet('a' + c + 'b', universal)],
  frontend: [every, (c) => frontend('x' + c + 'a', letters)],
  chunk: [nosur, (c) => chunk(c, 1.0)],
  cut: [nosur, (c) => chunk(PROBE_A + c + PROBE_B, 1.0).slice(0, 1).map(([t, p]) => [[...t].length, p])],
  piece: [nosur, (c) => piece('a ' + c + ' b' + c, new Map([['a', 5], [' ', 2], [c, 9]]))],
};

const hex = (c) => 'U+' + c.toString(16).toUpperCase().padStart(4, '0');
let failed = false;
console.log(JSON.stringify({ python: meta.python, python_unicode: meta.unidata_version, engine_unicode: process.versions.unicode }));
for (const [name, [cps, fn]] of Object.entries(TESTS)) {
  const want = load(name);
  const newer = [];
  const real = [];
  cps.forEach((c, i) => {
    let got;
    try {
      got = fn(String.fromCodePoint(c));
    } catch (e) {
      got = { error: e.name };
    }
    const g = JSON.stringify(got);
    const w = JSON.stringify(want[i]);
    if (g !== w) (unassigned.has(c) ? newer : real).push(`${hex(c)} py=${w.slice(0, 80)} js=${g.slice(0, 80)}`);
  });
  if (real.length || newer.length) failed = true;
  console.log(JSON.stringify({ test: name, code_points: cps.length, differ: real.length, newer_unicode_only: newer.length,
    examples: [...real, ...newer].slice(0, 10) }));
}
const [texts, lowered] = load('sigma');
const sigma = texts.filter((t, i) => alphabet(t, universal) !== lowered[i]);
if (sigma.length) failed = true;
console.log(JSON.stringify({ test: 'sigma', strings: texts.length, differ: sigma.length, examples: sigma.slice(0, 10) }));
process.exit(failed ? 1 : 0);
