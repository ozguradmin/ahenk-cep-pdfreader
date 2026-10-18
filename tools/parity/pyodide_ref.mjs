// Pyodide reference for the parity check: the docs/py Python the site runs today, in Pyodide 0.27.7 (Python 3.12,
// Unicode 15.0), loaded the way the site loads it (docs/js/front.js's setupFront). Same output as reference.py.
//   node tools/parity/pyodide_ref.mjs DIR [--out ref_pyodide.jsonl] [--compare FILE] [--vocab MODEL.json]
//        [--pyodide DIR] [--max-examples K]
// DIR/corpus.jsonl -> DIR/<out> ({"id", "spoken", "pieces"} or {"id", "error": "<ExceptionType>"} per case;
// "NeverReturns" where prepare() would loop forever, see never_returns.py) and DIR/<out>.meta.json. --compare FILE (e.g. reference.py's CPython output) counts the cases whose result differs and
// writes DIR/<out>.diff.json with examples. Pyodide comes from PYODIDE_DIR (npm i pyodide@0.27.7 outside the repo).
import { createReadStream, existsSync, readFileSync, renameSync, writeFileSync, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setupFront } from '../../docs/js/front.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PY_DIR = resolve(HERE, '../../docs/py');
const SCRATCH = '/tmp/claude-0/-home-user-ahenk-cep-pdfreader/9d20a4c9-d948-50ce-a350-236eed51946b/scratchpad';

function parseArgs(argv) {
  const a = { dir: null, out: 'ref_pyodide.jsonl', compare: null, examples: 25,
    vocab: process.env.AHENK_VOCAB || `${SCRATCH}/hf/ahenk-cep.json`,
    pyodide: process.env.PYODIDE_DIR || `${SCRATCH}/parity/node_modules/pyodide` };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--compare') a.compare = argv[++i];
    else if (k === '--vocab') a.vocab = argv[++i];
    else if (k === '--pyodide') a.pyodide = argv[++i];
    else if (k === '--max-examples') a.examples = Number(argv[++i]);
    else if (!a.dir) a.dir = k;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.dir) throw new Error('usage: pyodide_ref.mjs DIR [--out FILE] [--compare FILE] [--vocab FILE] [--pyodide DIR]'
    + ' [--max-examples K]');
  return a;
}

async function* lines(path) {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) yield line;
}

// A fresh interpreter each time: after a fatal error (not a Python exception) Pyodide cannot be used again.
async function start(pyodideDir, vocab) {
  const { loadPyodide } = await import(pathToFileURL(join(pyodideDir, 'pyodide.mjs')).href);
  const pyodide = await loadPyodide({ indexURL: `${pyodideDir}/` });
  const front = await setupFront(pyodide, async (p) => readFileSync(join(PY_DIR, p), 'utf8'), vocab);
  // never_returns.py: chunk() raises NeverReturns where it would loop forever (a speed under 1/180)
  pyodide.runPython(`${readFileSync(join(HERE, 'never_returns.py'), 'utf8')}\nimport ahenk_front\nguard(ahenk_front)`);
  const info = 'import sys, unicodedata\n[sys.version.split()[0], unicodedata.unidata_version]';
  const [python, unicode] = pyodide.runPython(info).toJs();
  return { pyodide, front, python, unicode, version: pyodide.version };
}

const isPythonError = (e) => e && e.constructor && e.constructor.name === 'PythonError' && typeof e.type === 'string';

// where two results first differ: "spoken", "pieces[3].ids", "error"
function where(a, b) {
  if ('error' in a || 'error' in b) return 'error';
  if (a.spoken !== b.spoken) return 'spoken';
  const n = Math.max(a.pieces.length, b.pieces.length);
  for (let i = 0; i < n; i++) {
    const p = a.pieces[i], q = b.pieces[i];
    if (!p || !q) return 'piece_count';
    for (const f of ['text', 'pause', 'ids', 'cw', 'wstart']) {
      if (JSON.stringify(p[f]) !== JSON.stringify(q[f])) return `pieces[${i}].${f}`;
    }
  }
  return 'keys';
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const raw = JSON.parse(readFileSync(a.vocab, 'utf8'));
  const vocab = Array.isArray(raw) ? raw : raw.vocab;
  let py = await start(a.pyodide, vocab);
  const dst = join(a.dir, a.out);
  const tmp = `${dst}.tmp`;
  const out = createWriteStream(tmp, { encoding: 'utf8' });
  const cmp = a.compare ? lines(resolve(a.dir, a.compare))[Symbol.asyncIterator]() : null;
  const diff = { file: a.compare, cases: 0, differ: 0, by_source: {}, by_where: {}, examples: [] };
  let cases = 0, errors = 0, fatal = 0;
  const t0 = performance.now();
  for await (const line of lines(join(a.dir, 'corpus.jsonl'))) {
    const c = JSON.parse(line);
    let res;
    try {
      res = { id: c.id, ...py.front.prepare(c.text, c.speed) };
    } catch (e) {
      if (!isPythonError(e)) { // the interpreter died (not a Python exception): note it and start a new one
        fatal++;
        process.stderr.write(`pyodide_ref: ${c.id}: ${e && e.message ? e.message.split('\n')[0] : e} (restarting)\n`);
        py = await start(a.pyodide, vocab);
      }
      res = { id: c.id, error: isPythonError(e) ? e.type : `JS:${(e && e.name) || 'Error'}` };
      errors++;
    }
    const json = JSON.stringify(res);
    if (!out.write(`${json}\n`)) await new Promise((r) => out.once('drain', r));
    cases++;
    if (cmp) {
      const { value, done } = await cmp.next();
      const other = done ? null : JSON.parse(value);
      if (other && other.id !== c.id) throw new Error(`--compare file is out of order at ${c.id} (got ${other.id})`);
      diff.cases++;
      if (!other || JSON.stringify(other) !== json) {
        const src = c.id.split(':')[0];
        const w = other ? where(other, res) : 'missing';
        diff.differ++;
        diff.by_source[src] = (diff.by_source[src] || 0) + 1;
        diff.by_where[w] = (diff.by_where[w] || 0) + 1;
        if (diff.examples.length < a.examples) {
          diff.examples.push({ id: c.id, speed: c.speed, text: c.text, where: w, compare: other, pyodide: res });
        }
      }
    }
    if (cases % 5000 === 0) {
      process.stderr.write(`pyodide_ref: ${cases} cases, ${((performance.now() - t0) / 1000).toFixed(1)} s\n`);
    }
  }
  await new Promise((r) => out.end(r));
  renameSync(tmp, dst);
  const meta = {
    engine: 'pyodide', pyodide: py.version, python: py.python, unicode: py.unicode,
    vocab_sha256: createHash('sha256').update(JSON.stringify(vocab)).digest('hex'),
    cases, errors, fatal, seconds: Math.round((performance.now() - t0) / 10) / 100,
  };
  writeFileSync(`${dst}.meta.json`, JSON.stringify(meta, null, 1));
  const summary = { ref: dst, ...meta };
  if (cmp) {
    const otherMeta = resolve(a.dir, `${a.compare}.meta.json`);
    if (existsSync(otherMeta)) diff.compare_meta = JSON.parse(readFileSync(otherMeta, 'utf8'));
    writeFileSync(`${dst}.diff.json`, JSON.stringify(diff, null, 1));
    const { file, cases: n, differ, by_source: bySource, by_where: byWhere } = diff;
    summary.compare = { file, cases: n, differ, by_source: bySource, by_where: byWhere };
  }
  console.log(JSON.stringify(summary));
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
