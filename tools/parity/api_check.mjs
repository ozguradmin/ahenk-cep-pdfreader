// trnorm's exported number readers against the Python's, for the argument types a caller can pass:
// number_to_words / ordinal_to_words (docs/js/trnorm/index.js) with JS values, CPython 3.12's trnorm with the Python
// value each stands for (numbers.js _py_number): a BigInt or a safe integer is an int, any other number a float,
// true / false a bool, a string a str, null None. Same reading, or the same exception type.
//   node tools/parity/api_check.mjs [N] [SEED]        (N random values on top of the fixed ones; needs python3.12)
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { number_to_words, ordinal_to_words } from '../../docs/js/trnorm/index.js';

const PY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/py');
const N = Number(process.argv[2] || 20000);
let seed = Number(process.argv[3] || 1) >>> 0;
const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

// [JS value, its Python value as JSON: {int: "digits"} | {float: "repr"} | {bool} | {str} | {none: true}]
function py_of(v) {
  if (typeof v === 'bigint') return { int: v.toString() };
  if (typeof v === 'boolean') return { bool: v };
  if (typeof v === 'string') return { str: v };
  if (v === null) return { none: true };
  if (Number.isSafeInteger(v)) return { int: String(v) };
  return { float: Number.isNaN(v) ? 'nan' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : String(v) };
}

const values = [0, -0, 1, 5, 10, 11, 100, 101, 999, 1000, 1001, 2026, 1e6, 123456789, 2 ** 53 - 1, -(2 ** 53 - 1),
  2 ** 53, 2 ** 53 + 2, 2 ** 60, 1e18, 1e20, 1e21, 1e22, 1.2345e22, 1e100, 1.7976931348623157e308, 5e-324, 0.5, 1.5,
  -1.5, 100.5, 1e20 + 65536, 999999999999999868928, NaN, Infinity, -Infinity, true, false, '5', '', null,
  10n ** 21n - 1n, 10n ** 21n, -(10n ** 21n), 2n ** 64n, 12345678901234567890n, 10n ** 4299n, -7n];
for (let i = 0; i < N; i++) {
  const k = rand();
  if (k < 0.3) values.push(Math.floor(rand() * 2 ** 53) * (rand() < 0.1 ? -1 : 1));
  else if (k < 0.5) values.push(Math.floor(rand() * 1e6));
  else if (k < 0.7) values.push(BigInt(Math.floor(rand() * 1e15)) * BigInt(Math.floor(rand() * 1e9)));
  else if (k < 0.85) values.push(Math.round(rand() * 10 ** Math.floor(rand() * 25)) * 100); // big floats, some exact
  else values.push((rand() - 0.5) * 10 ** Math.floor(rand() * 30));
}

const run = (fn, v) => {
  try { return { ok: fn(v) }; } catch (e) { return { error: e.name }; }
};
const js = values.map((v) => [run(number_to_words, v), run(ordinal_to_words, v)]);

const script = `
import json, sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(PY_DIR)})
from trnorm import number_to_words, ordinal_to_words
def val(d):
    if 'int' in d: return int(d['int'])
    if 'float' in d: return float(d['float'])
    if 'bool' in d: return d['bool']
    if 'str' in d: return d['str']
    return None
def run(f, v):
    try: return {'ok': f(v)}
    except Exception as e: return {'error': type(e).__name__}
out = [[run(number_to_words, val(d)), run(ordinal_to_words, val(d))] for d in json.load(sys.stdin)]
json.dump(out, sys.stdout, ensure_ascii=False)
`;
const py = spawnSync(process.env.PYTHON || 'python3.12', ['-c', script], {
  input: JSON.stringify(values.map(py_of)), encoding: 'utf8', maxBuffer: 1 << 30,
});
if (py.status !== 0) {
  console.log(JSON.stringify({ error: py.stderr.slice(0, 2000) }));
  process.exit(2);
}
const want = JSON.parse(py.stdout);
let differ = 0;
values.forEach((v, i) => {
  if (JSON.stringify(js[i]) !== JSON.stringify(want[i])) {
    if (differ++ < 10) console.log(JSON.stringify({ value: typeof v === 'bigint' ? `${v}n` : String(v), js: js[i], python: want[i] }).slice(0, 600));
  }
});
console.log(JSON.stringify({ values: values.length, differ }));
process.exitCode = differ ? 1 : 0;
