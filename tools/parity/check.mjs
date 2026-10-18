// Parity check of docs/js/front-native.js (the JavaScript port) against the Python reference made by
// pyodide_ref.mjs or reference.py: prepare(text, speed, vocab) on every case of DIR/corpus.jsonl.
//   node tools/parity/check.mjs DIR [--max-examples K] [--ref ref.jsonl] [--vocab MODEL.json] [--only REGEX]
//        [--twice] [--module PATH]
// Compares the spoken form, every piece field (text, pause, ids, cw, wstart), key order, and throw vs raise; a
// mismatch is filed under the first component that differs (spoken, piece_text, pause, ids, cw, wstart,
// piece_count, shape, js_threw, js_missing_throw, error_type: both raise, but the JS error's name is not the Python
// exception's type, or not RuntimeError where the reference says NeverReturns; unstable with --twice: a second call
// gave another result). A corpus whose ids repeat is refused (exit 2): cases and references are paired by id.
// Writes DIR/report.json (K examples per category, per-source counts, slowest cases), prints a one-line JSON
// summary and exits 1 when anything differs (2 when the check itself cannot run).
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRATCH = '/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad';
const PIECE_KEYS = ['text', 'pause', 'ids', 'cw', 'wstart'];
const CATEGORIES = ['spoken', 'piece_text', 'pause', 'ids', 'cw', 'wstart', 'piece_count', 'shape', 'js_threw',
  'js_missing_throw', 'error_type', 'unstable'];
const ERROR_CATEGORIES = new Set(['js_threw', 'js_missing_throw', 'error_type']);

function parseArgs(argv) {
  const a = { dir: null, ref: 'ref.jsonl', k: 5, only: null, twice: false,
    vocab: process.env.AHENK_VOCAB || `${SCRATCH}/hf/ahenk-cep.json`,
    module: resolve(HERE, '../../docs/js/front-native.js') };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--max-examples') a.k = Number(argv[++i]);
    else if (k === '--ref') a.ref = argv[++i];
    else if (k === '--vocab') a.vocab = argv[++i];
    else if (k === '--only') a.only = new RegExp(argv[++i]);
    else if (k === '--twice') a.twice = true;
    else if (k === '--module') a.module = resolve(argv[++i]);
    else if (!a.dir) a.dir = k;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.dir || !Number.isInteger(a.k) || a.k < 0) {
    throw new Error('usage: check.mjs DIR [--max-examples K] [--ref FILE] [--vocab FILE] [--only REGEX] [--twice]');
  }
  return a;
}

async function* lines(path) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v, keys) => isObject(v) && Object.keys(v).join('\0') === keys.join('\0');

// index of the first difference between two int arrays (-1: same); a non-array or a non-number counts as a difference
function arrayDiff(a, b) {
  if (!Array.isArray(b)) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (typeof b[i] !== 'number' || a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// first differing component of a JS result against the reference line, or null when they are equal
function compare(py, js) {
  if ('error' in py) {
    if (!js.threw) return { cat: 'js_missing_throw' };
    // the port names its errors after the Python type (ValueError, TypeError, OverflowError); where the Python never
    // returns (NeverReturns, see never_returns.py) the port throws a RuntimeError by design
    const want = py.error === 'NeverReturns' ? 'RuntimeError' : py.error;
    return js.error && js.error.name === want ? null : { cat: 'error_type' };
  }
  if (js.threw) return { cat: 'js_threw' };
  const v = js.value;
  if (!isObject(v)) return { cat: 'shape', detail: `prepare returned ${Array.isArray(v) ? 'an array' : typeof v}` };
  if (v.spoken !== py.spoken) return { cat: 'spoken' };
  if (!Array.isArray(v.pieces)) return { cat: 'shape', detail: 'pieces is not an array' };
  const pp = py.pieces, jp = v.pieces;
  for (let i = 0; i < Math.min(pp.length, jp.length); i++) {
    const a = pp[i], b = jp[i];
    if (!isObject(b)) return { cat: 'shape', piece: i, detail: 'piece is not an object' };
    if (a.text !== b.text) return { cat: 'piece_text', piece: i };
    if (typeof b.pause !== 'number' || a.pause !== b.pause) return { cat: 'pause', piece: i };
    for (const f of ['ids', 'cw', 'wstart']) {
      const at = arrayDiff(a[f], b[f]);
      if (at >= 0) return { cat: f, piece: i, index: at };
    }
  }
  if (pp.length !== jp.length) return { cat: 'piece_count' };
  if (!sameKeys(v, ['spoken', 'pieces'])) return { cat: 'shape', detail: `keys ${Object.keys(v).join(',')}` };
  const bad = jp.findIndex((p) => !sameKeys(p, PIECE_KEYS));
  if (bad >= 0) return { cat: 'shape', piece: bad, detail: `piece keys ${Object.keys(jp[bad]).join(',')}` };
  return null;
}

// where two strings first differ, with some context on both sides
function stringDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  return { index: i, python: a.slice(from, i + 40), js: b.slice(from, i + 40) };
}

const errInfo = (e) => ({ name: e && e.name,
  message: String(e && e.message !== undefined ? e.message : e).slice(0, 500),
  stack: e && e.stack ? String(e.stack).split('\n').slice(0, 6).join('\n') : undefined });

function example(c, py, js, d) {
  const ex = { id: c.id, source: c.id.split(':')[0], speed: c.speed, text: c.text, category: d.cat };
  if (d.piece !== undefined) ex.piece = d.piece;
  if (d.index !== undefined) ex.index = d.index;
  if (d.detail) ex.detail = d.detail;
  const v = js.value;
  if (d.cat === 'error_type') {
    ex.python = { error: py.error };
    ex.js = { error: errInfo(js.error) };
  } else if (d.cat === 'js_threw') {
    ex.python = { spoken: py.spoken, pieces: py.pieces.length };
    ex.js = { error: errInfo(js.error) };
  } else if (d.cat === 'js_missing_throw') {
    ex.python = { error: py.error };
    const texts = isObject(v) && Array.isArray(v.pieces) ? v.pieces.map((p) => p && p.text) : undefined;
    ex.js = isObject(v) ? { spoken: v.spoken, pieces: texts || v.pieces } : v;
  } else if (d.cat === 'spoken') {
    ex.python = py.spoken;
    ex.js = v.spoken;
    ex.first_diff = typeof v.spoken === 'string' ? stringDiff(py.spoken, v.spoken) : null;
  } else if (d.cat === 'unstable') {
    ex.python = { spoken: py.spoken };
    ex.js = { first: isObject(v) ? v.spoken : v };
  } else if (d.cat === 'piece_count') {
    ex.python = py.pieces.map((p) => [p.text, p.pause]);
    ex.js = v.pieces.map((p) => (isObject(p) ? [p.text, p.pause] : p));
  } else if (d.piece !== undefined) {
    ex.spoken = py.spoken;
    ex.python = py.pieces[d.piece];
    ex.js = v.pieces[d.piece];
    if (d.cat === 'piece_text' && typeof ex.js.text === 'string') {
      ex.first_diff = stringDiff(ex.python.text, ex.js.text);
    }
  } else {
    ex.python = { keys: ['spoken', 'pieces'] };
    ex.js = isObject(v) ? { keys: Object.keys(v) } : v;
  }
  return ex;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(a.vocab, 'utf8'));
  const vocab = Array.isArray(raw) ? raw : raw.vocab;
  const refPath = resolve(a.dir, a.ref);
  const corpusPath = join(a.dir, 'corpus.jsonl');
  for (const p of [corpusPath, refPath]) if (!existsSync(p)) throw new Error(`${p} does not exist`);
  const refMeta = existsSync(`${refPath}.meta.json`) ? JSON.parse(readFileSync(`${refPath}.meta.json`, 'utf8')) : null;
  const vocabSha = createHash('sha256').update(JSON.stringify(vocab)).digest('hex');
  const vocabOk = !refMeta || !refMeta.vocab_sha256 || refMeta.vocab_sha256 === vocabSha;
  if (!vocabOk) process.stderr.write('check: the reference was made with another vocabulary\n');

  let prepare;
  try {
    ({ prepare } = await import(pathToFileURL(a.module).href));
    if (typeof prepare !== 'function') throw new Error(`${a.module} exports no prepare()`);
  } catch (e) {
    console.log(JSON.stringify({ error: `cannot load ${a.module}: ${e && e.message}` }));
    process.exit(2);
  }

  // references are paired with cases by id: a repeated id would compare against the wrong case
  const corpus = new Map();
  for await (const line of lines(corpusPath)) {
    const c = JSON.parse(line);
    if (corpus.has(c.id)) {
      console.log(JSON.stringify({ error: `${corpusPath}: the id ${JSON.stringify(c.id)} appears more than once` }));
      process.exit(2);
    }
    corpus.set(c.id, c);
  }

  const counts = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  const examples = Object.fromEntries(CATEGORIES.map((k) => [k, []]));
  const bySource = {};
  const slowest = [];
  const seen = new Set();
  let total = 0, match = 0, mismatch = 0, errorMismatch = 0, jsMs = 0, unknown = 0;
  const t0 = performance.now();
  for await (const line of lines(refPath)) {
    const py = JSON.parse(line);
    const c = corpus.get(py.id);
    if (!c) { unknown++; continue; }
    seen.add(py.id);
    if (a.only && !a.only.test(c.id)) continue;
    const js = {};
    const s = performance.now();
    try {
      js.value = prepare(c.text, c.speed, vocab);
    } catch (e) {
      js.threw = true;
      js.error = e;
    }
    const ms = performance.now() - s;
    jsMs += ms;
    let d = compare(py, js);
    if (!d && a.twice) {
      let again;
      try { again = { value: prepare(c.text, c.speed, vocab) }; } catch (e) { again = { threw: true, error: e }; }
      if (!!again.threw !== !!js.threw || (!js.threw && JSON.stringify(again.value) !== JSON.stringify(js.value))) {
        d = { cat: 'unstable', detail: 'a second call on the same input gave another result' };
      }
    }
    total++;
    const src = c.id.split(':')[0];
    const bs = (bySource[src] ||= { total: 0, match: 0, mismatch: 0, error_mismatch: 0 });
    bs.total++;
    if (!d) {
      match++;
      bs.match++;
    } else {
      const errorCase = ERROR_CATEGORIES.has(d.cat);
      if (errorCase) { errorMismatch++; bs.error_mismatch++; } else { mismatch++; bs.mismatch++; }
      counts[d.cat]++;
      if (examples[d.cat].length < a.k) examples[d.cat].push(example(c, py, js, d));
    }
    if (slowest.length < 20 || ms > slowest[slowest.length - 1].ms) {
      slowest.push({ id: c.id, ms: Math.round(ms * 100) / 100, chars: c.text.length });
      slowest.sort((x, y) => y.ms - x.ms);
      if (slowest.length > 20) slowest.pop();
    }
  }
  const noRef = [...corpus.keys()].filter((id) => !seen.has(id) && (!a.only || a.only.test(id)));
  const categories = Object.fromEntries(Object.entries(counts).filter(([, n]) => n));
  const summary = {
    total, match, mismatch, error_mismatch: errorMismatch, js_ms: Math.round(jsMs), categories,
    no_ref: noRef.length, ref: refMeta ? `${refMeta.engine} ${refMeta.python} (Unicode ${refMeta.unicode})` : a.ref,
  };
  if (!vocabOk) summary.vocab_mismatch = true;
  if (unknown) summary.ref_not_in_corpus = unknown;
  const report = {
    summary, corpus: corpusPath, reference: refPath, reference_meta: refMeta, module: a.module,
    node: process.versions.node, engine_unicode: process.versions.unicode, wall_ms: Math.round(performance.now() - t0),
    by_source: bySource, examples: Object.fromEntries(Object.entries(examples).filter(([, v]) => v.length)),
    no_ref: noRef.slice(0, 50), slowest,
  };
  writeFileSync(join(a.dir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(summary));
  process.exitCode = mismatch || errorMismatch || noRef.length || unknown || !vocabOk ? 1 : 0;
}

main().catch((e) => {
  console.log(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  process.exit(2);
});
