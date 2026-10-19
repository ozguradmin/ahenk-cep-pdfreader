// Everything heavy runs here, off the page's main thread: Pyodide with trnorm (text to spoken form), the four ONNX
// graphs on onnxruntime-web (WebAssembly; WebGPU only on desktops without threads, see js/backend.js), the model
// download with a sha256 check and a Cache Storage copy for the next visit.
//
// The loading half (init) is ozguradmin/ahenk-turkish-tts site/js/worker.js (Apache-2.0) as it is. The synthesis half
// is new: a document is a list of segments (a sentence or a few), spoken one after the other as one job that reports
// its progress, sends each segment's audio as soon as it is ready, and can be cancelled between two Euler steps.
//
// Messages in:  {type: 'init', modelBase, pyBase, variant, ep, device, maxThreads, front: 'js' | 'py', calibrate}
//               {type: 'synth', id, segments: [{text, pause}], from, steps, speed, seed}
//               {type: 'cancel', id}
// Messages out: {type: 'status', stage, ...} {type: 'alive'} {type: 'ready', info} {type: 'backend', info}
//               {type: 'seg-progress', id, index, frac}
//               {type: 'segment', id, index, pcm (Int16Array, the pause after it included), spoken, ms, failed}
//               {type: 'done', id} {type: 'cancelled', id} {type: 'calibrated', base, per, backend, threads}
//               {type: 'error', stage?, id?, index?, kind, message, threads, broken}

import { engineBroken, errorKind, openWithFallback, pickBackend, shortError, tag, timed } from './backend.js';
import { CDN } from './config.js';
import { CepEngine, variantFiles } from './engine.js';
import { setupFront } from './front.js';

// The same name and keys as the Ahenk Cep demo on this origin: a model either page downloaded serves both.
const CACHE = 'ahenk-cep-models-v1';
const GPU_MS = 40000; // the longest WebGPU may take to create one session or to run the warm-up
const THREADS_MS = 30000; // the longest threaded WebAssembly may take to start once its .wasm has arrived
const BEAT_MS = 10000;
let engine = null;
let ready = null;
let info = null;
let toWasm = null; // while on WebGPU: () => the same model opened on WebAssembly
let job = null; // the running synthesis: {id, signal}
let queue = Promise.resolve();
let asked = false; // a synthesis was asked for: the calibration is not worth delaying it

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// A macrotask boundary: onnxruntime's runs resolve without ever giving the worker's message queue a turn, so a
// 'cancel' would wait for the whole job. One of these after every Euler step lets it in.
const breathe = () => new Promise((resolve) => { setTimeout(resolve, 0); });

async function sha256(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function openCache() {
  try {
    return await caches.open(CACHE);
  } catch {
    return null; // private mode or blocked storage: download every visit
  }
}

// One model file: from Cache Storage if a verified copy is there, else downloaded with progress and verified.
async function fetchModel(cache, url, file, onBytes) {
  const key = `${url}?sha256=${file.sha256}`;
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const buf = new Uint8Array(await hit.arrayBuffer());
        if ((await sha256(buf)) === file.sha256) {
          onBytes(buf.length, true);
          return buf;
        }
      }
    } catch { /* fall through to the network */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file.file}: HTTP ${res.status}`);
  const buf = new Uint8Array(file.bytes);
  let off = 0;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > buf.length) throw new Error(`${file.file}: larger than expected`);
      buf.set(value, off);
      off += value.length;
      onBytes(value.length, false);
    }
  } else {
    const all = new Uint8Array(await res.arrayBuffer());
    buf.set(all.subarray(0, buf.length));
    off = all.length;
    onBytes(off, false);
  }
  if (off !== file.bytes || (await sha256(buf)) !== file.sha256) throw new Error(`${file.file}: checksum mismatch`);
  if (cache) {
    try {
      await cache.put(key, new Response(buf, { headers: { 'content-type': 'application/octet-stream' } }));
    } catch { /* quota: fine, just not cached */ }
  }
  return buf;
}

async function webgpuAvailable() {
  try {
    return !!(self.navigator.gpu && (await timed(self.navigator.gpu.requestAdapter(), 5000, 'requestAdapter')));
  } catch {
    return false;
  }
}

// The WebGPU and the WebAssembly builds are separate modules, each with its own WebAssembly instance: switching
// means importing the other one and creating the sessions again.
async function importOrt(gpu, threads) {
  let ort;
  try {
    ort = await import(`${CDN.ortDist}${gpu ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`);
  } catch (e) {
    throw tag(e, { kind: 'network' });
  }
  ort.env.wasm.wasmPaths = CDN.ortDist;
  ort.env.wasm.numThreads = threads;
  return ort;
}

// The text front-end. By default the JavaScript port (js/front-native.js; tools/parity checks that it gives the
// Python's output, spoken form and pieces, on a large corpus and on fuzzed input). The Python itself, in Pyodide
// (js/front.js, 5.6 MB and tens of MB of memory), is loaded only if the port cannot run in this browser, or for a
// text the port fails on.
async function loadPyFront(pyBase, vocab) {
  const { loadPyodide } = await import(`${CDN.pyodide}pyodide.mjs`).catch((e) => { throw tag(e, { kind: 'network' }); });
  const pyodide = await loadPyodide({ indexURL: CDN.pyodide });
  return setupFront(pyodide, async (p) => {
    const r = await fetch(new URL(p, pyBase));
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.text();
  }, vocab);
}

let pyFrontP = null;
function pyFront(pyBase, vocab) {
  if (!pyFrontP) {
    pyFrontP = loadPyFront(pyBase, vocab);
    pyFrontP.catch(() => { pyFrontP = null; });
  }
  return pyFrontP;
}

async function loadFront(pyBase, vocab, want = 'js') {
  const t0 = performance.now();
  let front;
  try {
    if (want !== 'js') throw new Error('the Python front-end was asked for');
    const m = await import('./front-native.js');
    m.prepare('Merhaba, 14.10.2026 saat 09:30.', 1, vocab); // builds the regexes now: throws here if this browser cannot
    front = { kind: 'js', prepare: (text, speed) => m.prepare(text, speed, vocab) };
  } catch (e) {
    if (want === 'js') console.warn('Ahenk Okur: the JavaScript text front-end cannot run here; using the Python one (Pyodide).', e);
    const py = await pyFront(pyBase, vocab);
    front = { kind: 'py', prepare: py.prepare };
  }
  post({ type: 'status', stage: 'front-ready', ms: performance.now() - t0, front: front.kind });
  return front;
}

// When onnxruntime's .wasm, fetched from now on, has downloaded (resource timing), so that the time limits below do
// not count the download. A browser that cannot tell starts the clock at once.
function wasmArrived() {
  const since = performance.now();
  return new Promise((resolve) => {
    try {
      if (!(self.PerformanceObserver?.supportedEntryTypes || []).includes('resource')) return resolve();
      const obs = new PerformanceObserver((list) => {
        if (list.getEntries().some((x) => x.name.startsWith(CDN.ortDist) && x.name.endsWith('.wasm') && x.startTime >= since)) {
          obs.disconnect();
          resolve();
        }
      });
      obs.observe({ type: 'resource', buffered: true });
    } catch {
      resolve();
    }
  });
}

function releaseAll(sessions) {
  for (const s of Object.values(sessions)) Promise.resolve().then(() => s.release()).catch(() => {});
}

// The four sessions, then a short warm-up run (compiles kernels and allocates once, before the first real request).
// On WebGPU each step has a time limit. The first session also starts onnxruntime's WebAssembly: the .wasm and, with
// threads, the nested workers that run them; its limit starts once the .wasm has arrived, and with threads an
// uncaught error (a thread that could not start) fails it too. On failure whatever was created is released.
async function openEngine(ort, gpu, threads, buffers, files, manifest, frontP, pyBase) {
  // logSeverityLevel 3: errors only (WebGPU sessions otherwise print node-placement warnings as console errors)
  const opts = { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const sessions = {};
  try {
    for (let i = 0; i < files.length; i++) {
      const arrived = i === 0 ? wasmArrived() : null; // before create, which fetches the .wasm
      let create = ort.InferenceSession.create(buffers[i], opts);
      if (gpu) create = timed(create, GPU_MS, `WebGPU ${files[i].graph}`, { after: arrived });
      else if (arrived && threads > 1) create = timed(create, THREADS_MS, `${threads} WebAssembly threads`, { after: arrived, scope: self });
      sessions[files[i].graph] = await create;
    }
    const front = await frontP;
    const prepare = async (text, speed) => {
      try {
        return front.prepare(text, speed);
      } catch (e) {
        // e.python: the port throws exactly where the Python raises (or would never return), so asking the Python
        // could only repeat it, or hang. Anything else (an EngineError: this browser's RegExp misreads the text, as
        // Safari 26.0-26.5 does for a few rare character pairs) goes to the Python, which reads it right.
        if (front.kind === 'js' && !(e && e.python)) {
          console.warn('Ahenk Okur: the JavaScript front-end cannot read this text here; asking the Python one.', e);
          // Pyodide may download now, in the middle of a job, with nothing else to report: the beat keeps the
          // page's watchdog from taking a slow connection for a dead worker
          const beat = setInterval(() => post({ type: 'alive' }), BEAT_MS);
          let py;
          try {
            py = await pyFront(pyBase, manifest.vocab);
          } catch (e2) {
            // could not load (offline): the job stops here and can go on later, the sentence is not lost
            throw tag(e2, errorKind(e2) === 'network' ? { kind: 'network' } : { where: 'front' });
          } finally {
            clearInterval(beat);
          }
          try {
            return py.prepare(text, speed);
          } catch (e2) {
            throw tag(e2, { where: 'front' });
          }
        }
        throw tag(e, { where: 'front' }); // a Python exception: not the backend's fault
      }
    };
    const eng = new CepEngine(ort, sessions, manifest, prepare);
    const warm = eng.say('Merhaba.', { steps: 2 });
    await (gpu ? timed(warm, GPU_MS, 'WebGPU warm-up') : warm);
    return eng;
  } catch (e) {
    releaseAll(sessions);
    throw e;
  }
}

async function init({ modelBase, pyBase, variant, ep, device = {}, maxThreads = 0, front = 'js' }) {
  const t0 = performance.now();
  post({ type: 'status', stage: 'start' }); // this worker and its imports have loaded
  const cores = self.navigator.hardwareConcurrency || 2;
  const plan = pickBackend({ ep, isolated: !!self.crossOriginIsolated, cores, device, maxThreads });
  const { threads } = plan;
  const gpu = plan.gpu && (await webgpuAvailable());
  let ort = await importOrt(gpu, threads);
  const mres = await fetch(new URL('ahenk-cep.json', modelBase)).catch((e) => { throw tag(e, { kind: 'network' }); });
  if (!mres.ok) throw new Error(`ahenk-cep.json: HTTP ${mres.status}`);
  const manifest = await mres.json();
  const files = variantFiles(manifest, variant);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  post({ type: 'status', stage: 'download', loaded: 0, total });
  const frontP = loadFront(pyBase, manifest.vocab, front).catch((e) => { throw tag(e, { where: 'front' }); });
  frontP.catch(() => {}); // awaited in openEngine; if the download fails first, that is the error reported
  const cache = await openCache();
  let loaded = 0;
  let fromCache = true;
  const buffers = await Promise.all(files.map((f) => fetchModel(cache, new URL(f.file, modelBase).href, f, (n, cached) => {
    loaded += n;
    fromCache = fromCache && cached;
    post({ type: 'status', stage: 'download', loaded, total, fromCache });
  }).catch((e) => { throw tag(e, { kind: 'network' }); })));
  const tDownload = performance.now() - t0;
  post({ type: 'status', stage: 'sessions', threads, fromCache });
  // Opening says nothing for a while (onnxruntime's and Pyodide's own downloads, compiling, the warm-up): a beat
  // tells the page that this worker is still alive, so a slow connection is not taken for a dead worker.
  const beat = setInterval(() => post({ type: 'alive' }), BEAT_MS);
  const open = async (onGpu) => {
    try {
      if (gpu && !onGpu) ort = await importOrt(false, threads);
      return await openEngine(ort, onGpu, threads, buffers, files, manifest, frontP, pyBase);
    } catch (e) {
      // threads that failed to start or to run (not a download, not the text front-end): one thread may still work
      if (!onGpu && threads > 1 && e.where !== 'front' && errorKind(e) !== 'network') throw tag(e, { threads });
      throw e;
    }
  };
  let gpuError = null;
  let opened;
  try {
    opened = await openWithFallback(gpu, open, (e) => {
      gpuError = shortError(e);
      console.warn('Ahenk Okur: WebGPU failed, using WebAssembly instead.', e);
    });
  } finally {
    clearInterval(beat);
  }
  engine = opened.engine;
  toWasm = opened.backend === 'webgpu' ? () => open(false) : null;
  info = {
    backend: opened.backend, threads, variant, bytes: total, fromCache, gpuError, front: (await frontP).kind,
    isolated: !!self.crossOriginIsolated, ms: performance.now() - t0, downloadMs: tDownload,
    ort: ort.env.versions?.web || null, sampleRate: manifest.sample_rate,
  };
  post({ type: 'ready', info });
}

// One text through the engine. If WebGPU passed the warm-up but fails here, move to WebAssembly for good and try
// once more.
async function sayOnce(text, opts) {
  try {
    return await engine.say(text, opts);
  } catch (e) {
    if (!toWasm || e.where === 'front' || e.name === 'AbortError') throw e;
    console.warn('Ahenk Okur: WebGPU failed, using WebAssembly instead.', e);
    const old = engine;
    // a reopen that fails (offline) leaves this worker on a GPU engine that does not work: broken, so the page
    // starts a new worker, which goes to WebAssembly from the start
    engine = await toWasm().catch((e2) => { throw tag(e2, { broken: true }); });
    toWasm = null;
    releaseAll(old.s);
    info = { ...info, backend: 'wasm', gpuError: shortError(e) };
    post({ type: 'backend', info });
    return engine.say(text, opts);
  }
}

// A text the front-end cannot read (a Python exception) costs that segment only: it becomes its pause, marked
// failed, and the job goes on. Anything else stops the job; the page may start again from that segment.
async function synth({ id, segments, from = 0, steps = 16, speed = 1.0, seed = 0 }) {
  const signal = { aborted: false };
  job = { id, signal };
  try {
    await ready;
    const sr = info.sampleRate;
    for (let i = from; i < segments.length && !signal.aborted; i++) {
      const seg = segments[i];
      const t0 = performance.now();
      let out = null;
      let failed = '';
      try {
        out = await sayOnce(seg.text, {
          style: 'neutral', steps, cfg: 2.0, speed, seed, signal,
          onProgress: (p) => {
            const within = p.decoding ? 0.92 : (0.92 * p.step) / p.steps;
            post({ type: 'seg-progress', id, index: i, frac: (p.piece + within) / p.pieces });
            return breathe();
          },
        });
      } catch (e) {
        if (e.name === 'AbortError') break;
        if (e.where !== 'front') throw tag(e, { index: i });
        console.warn(`Ahenk Okur: segment ${i} could not be read`, e);
        failed = shortError(e);
      }
      const n = out ? out.audio.length : 0;
      const pcm = new Int16Array(n + Math.round((seg.pause || 0) * sr));
      for (let k = 0; k < n; k++) {
        const s = out.audio[k];
        pcm[k] = Math.round((s > 1 ? 1 : s < -1 ? -1 : s) * 32767);
      }
      post({ type: 'segment', id, index: i, pcm, spoken: out ? out.spoken : '', ms: performance.now() - t0, failed }, [pcm.buffer]);
    }
    post({ type: signal.aborted ? 'cancelled' : 'done', id });
  } finally {
    if (job && job.id === id) job = null;
  }
}

// How fast this device speaks, for the page's estimates before its first job: one sentence (about 3 s of audio)
// at 4 and at 8 steps, right after the warm-up, gives the real-time factor as base + per * steps. A short sentence
// carries more fixed cost than a document's pieces, so the estimate leans long, never far.
async function calibrate() {
  if (asked || !engine) return;
  try {
    const text = 'Bugün hava çok güzel; öğleden sonra biraz yürüyüş yapalım mı?';
    const rtfAt = async (steps) => {
      await breathe(); // a 'synth' already queued gets in here and sets `asked`
      if (asked) throw Object.assign(new Error('a job came first'), { skip: true });
      const t0 = performance.now();
      const out = await engine.say(text, { steps });
      return (performance.now() - t0) / 1000 / (out.audio.length / info.sampleRate);
    };
    await rtfAt(4); // the first full-length run still compiles and allocates
    const r4 = await rtfAt(4);
    const r8 = await rtfAt(8);
    const per = Math.max(0.0005, (r8 - r4) / 4);
    post({ type: 'calibrated', base: Math.max(0.005, r4 - 4 * per), per, backend: info.backend, threads: info.threads });
  } catch (e) {
    if (!e.skip) console.warn('Ahenk Okur: calibration skipped', e);
  }
}

// The page gets a kind (what to tell the visitor) and one short line; the whole error goes to the console. threads:
// the threads it failed on, when one thread may do better; broken: the engine is unusable, start a new worker.
function failure(e) {
  console.error(e);
  return {
    kind: errorKind(e), message: shortError(e), threads: (e && e.threads) || 0, broken: !!(e && e.broken) || engineBroken(e),
    index: e && Number.isInteger(e.index) ? e.index : undefined,
  };
}

self.onmessage = ({ data }) => {
  if (data.type === 'init') {
    ready = init(data);
    if (data.calibrate === false) asked = true; // the page has a job waiting for this worker
    ready.then(() => { queue = queue.then(calibrate); }, () => {});
    ready.catch((e) => post({ type: 'error', stage: 'init', ...failure(e) }));
  } else if (data.type === 'synth') {
    if (job) job.signal.aborted = true; // one job at a time: a new one replaces the old
    asked = true;
    queue = queue.then(() => synth(data)).catch((e) => post({ type: 'error', id: data.id, ...failure(e) }));
  } else if (data.type === 'cancel') {
    if (job && (data.id === undefined || job.id === data.id)) job.signal.aborted = true;
  }
};
