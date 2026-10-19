// The trnorm port's API against Python (trnorm_reference.py): normalize, normalize_for_eval and inverse_normalize on
// every case of a corpus, and inverse_normalize on the spoken and eval forms Python made of it.
//   node tools/parity/trnorm_check.mjs DIR [--ref trnorm_ref.jsonl] [--max-examples K]
// A difference is a different string, or one side throwing where the other does not, or a different exception type
// (the JS error's name). Exit 1 if anything differs.
import fs from 'node:fs';
import path from 'node:path';
import * as T from '../../docs/js/trnorm/index.js';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const refFile = path.join(dir, opt('--ref', 'trnorm_ref.jsonl'));
const maxEx = Number(opt('--max-examples', 5));

const read = (f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const cases = new Map(read(path.join(dir, 'corpus.jsonl')).map((c) => [c.id, c]));
const refs = read(refFile);

const call = (fn, x) => {
  try {
    return fn(x);
  } catch (e) {
    return { error: e.name === 'Error' ? e.constructor.name : e.name };
  }
};
const same = (a, b) => (typeof a === 'string' || typeof b === 'string' ? a === b : a && b && a.error === b.error);
const kinds = {};
const examples = {};
let n = 0;
let engine = 0;
for (const r of refs) {
  const c = cases.get(r.id);
  // each call only where Python answered (null: it took too long, see trnorm_reference.py)
  const run = {
    normalize: () => call(T.normalize, c.text),
    eval: () => call(T.normalize_for_eval, c.text),
    itn: () => call(T.inverse_normalize, c.text),
    itn_spoken: () => call(T.inverse_normalize, r.normalize),
    itn_eval: () => call(T.inverse_normalize, r.eval),
  };
  const js = {};
  for (const k of Object.keys(run)) {
    if (r[k] === null || r[k] === undefined) continue;
    js[k] = run[k]();
    n++;
    if (js[k] && js[k].error === 'EngineError') { engine++; continue; } // this engine hands such a text to the Python
    if (same(js[k], r[k])) continue;
    kinds[k] = (kinds[k] || 0) + 1;
    (examples[k] ||= []).length < maxEx && examples[k].push({ id: r.id, text: k === 'itn_spoken' ? r.normalize : k === 'itn_eval' ? r.eval : c.text, py: r[k], js: js[k] });
  }
}
const bad = Object.values(kinds).reduce((a, b) => a + b, 0);
fs.writeFileSync(path.join(dir, 'trnorm_report.json'), JSON.stringify({ checked: n, engine, kinds, examples }, null, 1));
console.log(`${refs.length} cases, ${n} results: ${bad ? `${bad} differ ${JSON.stringify(kinds)}` : 'all equal'}${engine ? ` (${engine} EngineError)` : ''}`);
if (bad) console.log(JSON.stringify(examples, null, 1).slice(0, 4000));
process.exit(bad ? 1 : 0);
