// The page: a document in, Turkish speech out.
//   1. Belge: a file (js/extract.js; OCR in js/ocr.js), pasted text or the sample
//   2. Metin: the extracted text, editable, with speed and quality
//   3. Ses: the job in js/worker.js, segment by segment, with its progress; js/player.js plays what is ready while
//      the rest is made, the text follows the voice, and the result downloads as WAV or MP3 (js/mp3.js)
// The model starts loading as soon as the page opens; the worker part (loading, watchdog, retries) follows
// ozguradmin/ahenk-turkish-tts site/js/app.js.

import { deviceInfo, shortError } from './backend.js';
import { LINKS, pageOptions } from './config.js';
import { ExtractError, extractFile } from './extract.js';
import { Player, Track, fmtTime } from './player.js';
import { holdJob, openStore, storageUse } from './storage.js';
import { blocksToText, countWords, parseEditor, segment, speechSeconds, splitParts, spokenChars } from './text.js';
import { id3 } from './wav.js';

const $ = (id) => document.getElementById(id);
const nf = (x, d = 0) => Number(x).toLocaleString('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const mb = (bytes) => `${nf(bytes / 1e6, bytes < 1e7 ? 1 : 0)} MB`;
const store = (key, value) => {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage blocked: the page still works */ }
  return null;
};

// "≈ 24 dk", "1 sa 5 dk", "40 sn"
function dur(s, { approx = false } = {}) {
  s = Math.max(0, Math.round(s));
  let out;
  if (s < 60) out = `${Math.max(1, s)} sn`;
  else if (s < 600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    out = approx ? `${Math.round(s / 60)} dk` : r ? `${m} dk ${r} sn` : `${m} dk`;
  } else if (s < 3600) out = `${Math.round(s / 60)} dk`;
  else {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    out = m ? `${h} sa ${m} dk` : `${h} sa`;
  }
  return approx ? `≈ ${out}` : out;
}

const SAMPLE = {
  name: 'Örnek metin',
  text: `Sesli Okumanın Kısa Tarihi

Yüzyıllar boyunca okumak, sesli yapılan bir işti. Kütüphanelerde, kahvehanelerde ve evlerde biri okur, diğerleri dinlerdi. Sessiz okuma ancak matbaanın yaygınlaşmasıyla gündelik bir alışkanlığa dönüştü.

Bugün sesli kitaplar yeniden bu eski geleneği hatırlatıyor. Yolda, mutfakta ya da yürürken dinlemek, okumaya ayrılamayan zamanı değerli kılıyor. Türkiye'de 2025 yılında sesli kitap dinleyenlerin sayısı bir önceki yıla göre %38 arttı.

Ahenk Okur bu sayfada, belgelerinizi tamamen tarayıcınızda seslendirir. Dosyanız hiçbir sunucuya gitmez; ilk açılışta yaklaşık 17 MB'lık model iner ve sonraki ziyaretlerde önbellekten açılır. Peki, siz en son ne zaman birine sesli kitap okudunuz?`,
};

const KIND_LABEL = { pdf: 'PDF', docx: 'DOCX', odt: 'ODT', epub: 'EPUB', html: 'HTML', md: 'MD', txt: 'TXT', image: 'GÖRSEL', zip: 'ZIP' };

const opts = pageOptions(window.location);
const device = deviceInfo(navigator, matchMedia('(pointer: coarse)').matches);

const state = {
  // model
  ready: false, info: null, loadStage: 'start', loaded: 0, total: 0, fromCache: false, loadError: null, openT0: 0,
  opening: false, openMs: 0, threads: 0, heard: 0,
  // document
  doc: null, edited: false, steps: 16, speed: 1,
  // last measured speed of this device: {rtf, steps}
  measured: null,
  downloaded: false,
  store: null, // js/storage.js, when this browser keeps data (IndexedDB)
  extracting: null, // a token while a file or an OCR is being read
};
let job = null;
let track = null;
let nextId = 1;

// How much one job may hold. With storage on the device the MP3 goes to disk as it is made, so a whole book is one
// job (60 hours is only a sanity limit). Without it the MP3 stays in memory (about 29 MB an hour), and a long
// document is made in parts of at most 6 hours (2 on a phone). The WAV is offered while the speech is at most WAV_S
// seconds (345 MB an hour of PCM, kept in memory).
const MEM_S = (device.mobile ? 2 : 6) * 3600;
const partLimit = () => (state.store ? 60 * 3600 : MEM_S);
const ACTIVE = ['running', 'waiting', 'resuming', 'stopping'];
const isActive = (j) => !!j && ACTIVE.includes(j.state);
const WAV_S = device.mobile ? 10 * 60 : 30 * 60;

// ---- theme ------------------------------------------------------------------------------------------------------------
function effectiveTheme() {
  const th = document.documentElement.dataset.theme;
  if (th === 'light' || th === 'dark') return th;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function renderTheme() {
  $('theme').setAttribute('aria-label', effectiveTheme() === 'dark' ? 'Açık temaya geç' : 'Koyu temaya geç');
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of meta) m.content = effectiveTheme() === 'dark' ? '#121110' : '#f4efe6';
  player.draw();
}
$('theme').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store('ahenk-okur-theme', next);
  renderTheme();
});

// ---- toast ---------------------------------------------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, ms = 3600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---- player ---------------------------------------------------------------------------------------------------------------
const WAV_INFO = { ISFT: 'Ahenk Okur (Ahenk Cep)', ICMT: 'Yapay zeka ile üretilmiş ses (Ahenk Cep, tasarlanmış ses f022; gerçek bir kişi değildir).' };
const player = new Player({
  root: $('player'), play: $('p-play'), back: $('p-back'), fwd: $('p-fwd'), rate: $('p-rate'), wave: $('p-wave'), time: $('p-time'), title: $('p-title'),
}, {
  info: WAV_INFO,
  artwork: [{ src: new URL('icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' }],
  onSegment: (i) => highlight(i),
  onToast: (m, ms) => toast(m, ms),
});

function showPlayer(on) {
  $('player').hidden = !on;
  requestAnimationFrame(() => {
    const h = on ? $('player').getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--player-h', `${Math.round(h)}px`);
    player.draw();
  });
}
window.addEventListener('resize', () => { if (!$('player').hidden) showPlayer(true); });

// ---- model worker ----------------------------------------------------------------------------------------------------------
// "Tekrar dene" starts a new worker instead of reloading the page: on phones a reload costs more memory than it frees.
// A watchdog turns silence into an error: no word from the worker for STALL_MS while the model loads or while it
// speaks means something is stuck. While the model opens the worker sends a beat every 10 s; that stage gets
// OPEN_MS in all (onnxruntime's and Pyodide's files download then).
const STALL_MS = 120000;
const STOP_MS = 30000;
const OPEN_MS = 600000;
const ERRORS = {
  network: 'Model indirilemedi. Bağlantınızı kontrol edip tekrar deneyin.',
  engine: 'Model bu tarayıcıda çalıştırılamadı. Güncel bir Chrome, Edge, Firefox ya da Safari ile deneyin.',
  engineIos: "Model bu tarayıcıda çalıştırılamadı. Sayfayı bir uygulamanın içinden açtıysanız Safari'de açmayı deneyin.",
  memory: 'Cihazın belleği modeli açmaya yetmedi. Diğer sekmeleri kapatıp tekrar deneyin.',
  timeout: 'Model hazırlığı çok uzun sürdüğü için durduruldu. Tekrar deneyin; olmazsa bağlantınızı kontrol edin.',
  worker: 'Sayfanın bir parçası yüklenemedi. Tekrar deneyin, olmazsa sayfayı yenileyin.',
};
let worker = null;

// What this tab has learned to avoid (sessionStorage, so "Tekrar dene" and a reload remember it).
const avoid = (() => {
  try {
    return JSON.parse(sessionStorage.getItem('ahenk-okur-avoid')) || {};
  } catch {
    return {};
  }
})();
function remember(what) {
  avoid[what] = true;
  try {
    sessionStorage.setItem('ahenk-okur-avoid', JSON.stringify(avoid));
  } catch { /* storage blocked */ }
}

function onWorkerMessage(data) {
  state.heard = performance.now();
  switch (data.type) {
    case 'status':
      if (data.stage === 'download') {
        state.loadStage = 'download';
        state.loaded = data.loaded;
        state.total = data.total;
        if (data.fromCache !== undefined) state.fromCache = data.fromCache && data.loaded > 0;
      } else if (data.stage === 'sessions') {
        Object.assign(state, { loadStage: 'sessions', opening: true, threads: data.threads || 1, openT0: performance.now(), fromCache: !!data.fromCache });
      } else if (data.stage === 'front-ready') state.loadStage = 'warm';
      renderModel();
      break;
    case 'ready':
    case 'backend':
      if (data.info.gpuError) remember('webgpu');
      state.info = data.info;
      $('tech').textContent = techLine(data.info);
      window.__ahenk = { ...window.__ahenk, info: data.info };
      if (data.type === 'backend') break;
      state.ready = true;
      state.opening = false;
      renderModel();
      renderEstimate();
      if (job && (job.state === 'waiting' || job.state === 'resuming')) sendJob();
      break;
    case 'calibrated':
      // this device's measured speed, for this backend and thread count (js/worker.js calibrate)
      state.calib = { base: data.base, per: data.per };
      renderEstimate();
      break;
    case 'seg-progress':
      if (!job || data.id !== job.id) break;
      job.cur = data.index;
      job.curFrac = data.frac;
      markGenerating(data.index);
      scheduleProgress();
      break;
    case 'segment':
      if (!job || data.id !== job.id) break;
      onSegment(data);
      break;
    case 'done':
      if (job && data.id === job.id) finishJob('done');
      break;
    case 'cancelled':
      if (job && data.id === job.id && job.state === 'stopping') finishJob('stopped');
      break;
    case 'error':
      if (data.stage === 'init') loadFailed(data.kind, data.message, data.threads);
      else if (job && data.id === job.id) jobFailed(data);
      break;
    default:
  }
}

function startWorker() {
  if (worker) worker.terminate();
  worker = null;
  Object.assign(state, {
    ready: false, info: null, loadStage: 'start', loaded: 0, total: 0, fromCache: false, loadError: null,
    opening: false, openMs: 0, threads: 0,
  });
  state.heard = performance.now();
  renderModel();
  let w;
  try {
    w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    loadFailed('worker', String((e && e.message) || e));
    return;
  }
  worker = w;
  let started = false;
  w.onmessage = ({ data }) => {
    started = true;
    if (w === worker) onWorkerMessage(data);
  };
  w.onerror = (e) => {
    if (w !== worker) return;
    const message = (e && e.message) || 'js/worker.js did not start';
    if (!started) loadFailed('worker', message);
    else console.warn('Ahenk Okur: uncaught error in the worker:', message);
  };
  w.postMessage({
    type: 'init', modelBase: opts.modelBase, pyBase: new URL('py/', document.baseURI).href, variant: opts.variant,
    ep: avoid.webgpu ? 'wasm' : opts.ep, device, maxThreads: avoid.threads ? 1 : 0, front: opts.front,
    calibrate: !(job && (job.state === 'waiting' || job.state === 'resuming')), // a job waiting goes first
  });
}

function restartWorker() {
  if (state.info && state.info.backend === 'webgpu') remember('webgpu');
  startWorker();
}

function loadFailed(kind, message, threads = 0) {
  if (worker) worker.terminate();
  worker = null;
  if (threads > 1 && !avoid.threads) {
    console.warn(`Ahenk Okur: the model did not open on ${threads} threads (${message || kind}); trying one.`);
    remember('threads');
    startWorker();
    return;
  }
  state.ready = false;
  state.loadStage = 'error';
  state.loadError = { kind, message: message || '' };
  renderModel();
  if (job && (job.state === 'waiting' || job.state === 'resuming')) {
    job.state = 'error';
    job.error = 'Model yüklenemediği için ses üretilemedi.';
    keepAwake(false);
    if (track.count === track.made) player.finished();
    saveProgress(job, true);
    renderJob();
  }
}

setInterval(() => {
  if (!worker || document.hidden) return;
  const silent = performance.now() - state.heard >= STALL_MS;
  if (!state.ready) {
    if (state.opening) state.openMs += 5000;
    if (!silent && state.openMs < OPEN_MS) return;
    const why = silent ? `no word from the worker in ${STALL_MS / 1000} s` : `not ready ${OPEN_MS / 60000} min after the download`;
    loadFailed('timeout', why, state.opening ? state.threads : 0);
  } else if (job && job.state === 'running' && silent) {
    console.warn('Ahenk Okur: synthesis stalled; restarting the worker.');
    resumeAfterCrash();
  } else if (job && job.state === 'stopping' && performance.now() - state.heard >= STOP_MS) {
    // asked to stop, and no answer: the worker is stuck; the job is stopped where it is, on a new worker
    console.warn('Ahenk Okur: the worker did not stop; restarting it.');
    finishJob('stopped');
    restartWorker();
  }
}, 5000);
document.addEventListener('visibilitychange', () => {
  state.heard = performance.now();
  if (!document.hidden && job && job.state === 'running') keepAwake(true);
});

// coi-serviceworker.js reloads the page once on a first visit (see index.html); starting the model before that
// reload would download and allocate it twice, so wait for it (15 s at most).
function afterCoiReload() {
  const sw = navigator.serviceWorker;
  const coi = window.coiState || {};
  if (window.crossOriginIsolated !== false || !window.isSecureContext || !sw || sw.controller || coi.reloaded) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = 0;
    const iv = setInterval(() => {
      const now = performance.now();
      const go = coi.reloading ? now - coi.reloading > 10000 : sw.controller || (settled && now - settled > 250) || now - t0 > 15000;
      if (go) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
    const done = () => { settled = performance.now(); };
    sw.register(new URL('coi-serviceworker.js', document.baseURI).href).then(done, done);
  });
}

// ---- model card -------------------------------------------------------------------------------------------------------------
function techLine(i) {
  const be = i.backend === 'webgpu' ? 'WebGPU' : `WebAssembly · ${i.threads} iş parçacığı`;
  return `${be} · ${i.variant} · ${mb(i.bytes)}`;
}

// The ring: the download is the first 85 %, opening the model (onnxruntime, Pyodide, warm-up) creeps to 99 %.
function modelPct() {
  if (state.ready) return 100;
  if (state.loadStage === 'download' && state.total) return 85 * Math.min(1, state.loaded / state.total);
  if (state.loadStage === 'sessions' || state.loadStage === 'warm') {
    const t = (performance.now() - state.openT0) / 1000;
    const floor = state.loadStage === 'warm' ? 93 : 85;
    return Math.min(99, Math.max(floor, 85 + 14 * (1 - Math.exp(-t / 9))));
  }
  return 0;
}

let creep = 0;
function renderModel() {
  const card = $('model');
  const chip = $('chip');
  const pct = Math.floor(modelPct());
  const err = state.loadStage === 'error';
  card.classList.toggle('is-ready', state.ready);
  card.classList.toggle('is-error', err);
  chip.classList.toggle('is-ready', state.ready);
  chip.classList.toggle('is-error', err);
  $('ring-fg').style.strokeDasharray = `${err ? 100 : pct} 100`;
  $('ring-pct').textContent = String(pct);
  $('model-fill').style.width = `${pct}%`;
  $('model-bar').setAttribute('aria-valuenow', String(pct));
  $('model-bar').classList.toggle('is-busy', !state.ready && !err);
  const steps = { download: $('ms-download'), open: $('ms-open'), ready: $('ms-ready') };
  for (const s of Object.values(steps)) s.className = '';
  $('retry').hidden = !err;
  $('model-err').hidden = !err;
  let title;
  let sub;
  if (state.ready) {
    title = 'Model hazır';
    sub = `${state.info && state.info.fromCache ? 'Önbellekten açıldı' : 'İndirildi ve açıldı'} · ${state.info ? techLine(state.info) : ''}`;
    steps.download.className = 'is-done';
    steps.open.className = 'is-done';
    steps.ready.className = 'is-done';
    $('chip-text').textContent = 'Model hazır';
  } else if (err) {
    title = 'Model yüklenemedi';
    sub = 'Belgenizi yine de açıp metnini düzenleyebilirsiniz.';
    const { kind, message } = state.loadError;
    const msg = kind === 'engine' && device.ios ? ERRORS.engineIos : ERRORS[kind] || ERRORS.engine;
    $('model-err').innerHTML = '';
    $('model-err').append(msg);
    if (message) {
      const code = document.createElement('code');
      code.textContent = shortError(message);
      $('model-err').append(code);
    }
    $('chip-text').textContent = 'Model yüklenemedi';
  } else if (state.loadStage === 'download') {
    title = state.fromCache ? 'Model önbellekten açılıyor' : 'Model indiriliyor';
    sub = state.total ? `${nf(state.loaded / 1e6, 1)} / ${nf(state.total / 1e6, 1)} MB${state.fromCache ? '' : ' · yalnızca ilk ziyarette'}` : 'Bağlanılıyor…';
    steps.download.className = 'is-on';
    $('chip-text').textContent = `Model %${pct}`;
  } else if (state.loadStage === 'sessions' || state.loadStage === 'warm') {
    title = 'Model hazırlanıyor';
    sub = state.loadStage === 'warm' ? 'Son hazırlık: model ilk kez çalıştırılıyor' : 'Türkçe metin işleyici ve çalışma ortamı yükleniyor';
    steps.download.className = 'is-done';
    steps.open.className = 'is-on';
    $('chip-text').textContent = `Model %${pct}`;
  } else {
    title = 'Model hazırlanıyor';
    sub = 'Sayfa açılınca kendiliğinden yüklenir.';
    steps.download.className = 'is-on';
    $('chip-text').textContent = 'Model yükleniyor';
  }
  $('model-title').textContent = title;
  $('model-sub').textContent = sub;
  const creeping = !state.ready && !err && (state.loadStage === 'sessions' || state.loadStage === 'warm');
  if (creeping && !creep) creep = setInterval(renderModel, 500);
  if (!creeping && creep) {
    clearInterval(creep);
    creep = 0;
  }
  if (job && (job.state === 'waiting' || job.state === 'resuming')) renderJob();
}
$('retry').addEventListener('click', () => startWorker());

// ---- steps -------------------------------------------------------------------------------------------------------------------
function show(step) {
  if (step === 1 && $('panel-upload').hidden) renderSaved(); // it may have changed since (a new job, a prune)
  $('panel-upload').hidden = step !== 1;
  $('panel-text').hidden = step !== 2;
  $('panel-audio').hidden = step !== 3;
  for (const li of $('stepper').children) {
    const n = Number(li.dataset.step);
    li.classList.toggle('is-active', n === step);
    li.classList.toggle('is-done', n < step);
    if (n === step) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function scrollToStudio() {
  const r = $('studio').getBoundingClientRect();
  if (r.top < 0 || r.top > window.innerHeight * 0.5) $('studio').scrollIntoView({ block: 'start' });
}

// ---- documents ------------------------------------------------------------------------------------------------------------------
const fileInput = $('file');
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (f) openFile(f);
});

const drop = $('drop');
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth += 1;
  drop.classList.add('is-over');
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.classList.remove('is-over');
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('is-over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openFile(f);
});

const EXTRACT_ERRORS = {
  doc: "Eski Word biçimi (.doc) okunamıyor. Dosyayı Word'de “Farklı kaydet → .docx” ile kaydedip tekrar deneyin.",
  rtf: 'RTF dosyaları desteklenmiyor. Belgeyi PDF, DOCX ya da TXT olarak kaydedip deneyin.',
  pages: 'Pages dosyaları desteklenmiyor. Belgeyi PDF ya da DOCX olarak dışa aktarıp deneyin.',
  password: 'Bu PDF parolayla korunuyor ve parola girilmedi.',
  broken: 'Dosya açılamadı; bozuk ya da desteklenmeyen bir biçimde olabilir.',
  unknown: 'Bu dosyanın türü tanınamadı. PDF, DOCX, ODT, EPUB, TXT ya da bir görsel deneyin.',
};

function confirmDiscard() {
  if (state.extracting) {
    if (!window.confirm('Belge hâlâ okunuyor. Bırakılıp devam edilsin mi?')) return false;
    state.extracting = null; // what it gives is left (js: openFile, the OCR button)
    setExtracting(false);
  }
  if (isActive(job)) {
    if (!window.confirm('Ses üretimi sürüyor. Durdurup devam edilsin mi?')) return false;
    stopJob(true);
  }
  return true;
}

function setExtracting(on, title = 'Belge okunuyor', sub = 'Hazırlanıyor…', frac = null) {
  $('drop').hidden = on;
  $('extracting').hidden = !on;
  $('ex-title').textContent = title;
  $('ex-sub').textContent = sub;
  const bar = $('ex-bar');
  bar.classList.toggle('is-indeterminate', frac === null);
  $('ex-fill').style.width = `${Math.round((frac || 0) * 100)}%`;
}

async function openFile(file) {
  if (!confirmDiscard()) return;
  show(1);
  scrollToStudio();
  if (file.size > 300e6) {
    toast('Bu dosya çok büyük (300 MB üstü).');
    return;
  }
  setExtracting(true, file.name, 'Dosya açılıyor…');
  const token = {};
  state.extracting = token;
  const left = () => state.extracting !== token; // the visitor went on to something else meanwhile
  try {
    const doc = await extractFile(file, {
      onProgress: (p) => {
        if (p.stage === 'pdf') setExtracting(true, file.name, `Sayfa ${nf(p.done)} / ${nf(p.total)} okunuyor`, p.done / p.total);
        else if (p.stage === 'epub') setExtracting(true, file.name, `Bölüm ${nf(p.done)} / ${nf(p.total)}`, p.done / p.total);
        else if (p.stage === 'ocr-load') setExtracting(true, file.name, 'Görüntüden okuma (OCR) hazırlanıyor…', null);
        else if (p.stage === 'ocr') setExtracting(true, file.name, 'Görüntüdeki yazı okunuyor', p.frac);
      },
      askPassword: async (wrong) => {
        const pw = window.prompt(wrong ? 'Parola yanlış. PDF parolasını yeniden girin:' : 'Bu PDF parolayla korunuyor. Parolayı girin:');
        return pw === null ? null : pw;
      },
    });
    if (left()) {
      releasePdf(doc);
      return;
    }
    doc.name = file.name;
    state.extracting = null;
    setExtracting(false);
    openDoc(doc);
  } catch (e) {
    if (left()) return;
    state.extracting = null;
    setExtracting(false);
    console.error(e);
    let msg;
    if (e instanceof ExtractError) msg = EXTRACT_ERRORS[e.code] || EXTRACT_ERRORS.broken;
    else if (/fetch|import|network|load failed/i.test(String(e && e.message))) msg = 'Belge okuyucu indirilemedi. Bağlantınızı kontrol edip tekrar deneyin.';
    else msg = EXTRACT_ERRORS.broken;
    toast(msg, 6000);
  }
}

// pdf.js keeps the whole file (and decoded pages) in its worker: let it go once it is not needed any more.
function releasePdf(doc) {
  if (!doc || !doc.pdf) return;
  const pdf = doc.pdf;
  doc.pdf = null;
  Promise.resolve().then(() => pdf.destroy()).catch(() => {});
}

function docHeader(doc) {
  $('doc-name').textContent = doc.name;
  $('doc-name').title = doc.name;
  const icon = $('doc-icon');
  icon.dataset.kind = doc.kind;
  icon.textContent = KIND_LABEL[doc.kind] || 'TXT';
}

function openDoc(doc) {
  if (state.doc && state.doc !== doc && state.doc.pdf !== doc.pdf) releasePdf(state.doc);
  state.doc = doc;
  state.edited = false;
  state.part = 0;
  const pages = doc.pages || 0;
  const hasPages = pages > 1 && doc.blocks.some((b) => b.page);
  $('range').hidden = !hasPages;
  if (hasPages) {
    $('range-from').max = String(pages);
    $('range-to').max = String(pages);
    $('range-from').value = '1';
    $('range-to').value = String(pages);
    $('range-total').textContent = `/ ${nf(pages)} sayfa`;
  }
  docHeader(doc);
  fillEditor();
  const empty = !doc.blocks.length;
  const offer = doc.kind === 'pdf' && doc.pdf && (doc.scanned || doc.suspect || empty);
  $('ocr-offer').hidden = !offer;
  if (offer) {
    $('ocr-text').textContent = doc.scanned || empty
      ? 'Bu PDF taranmış görünüyor: sayfalarında okunabilir metin yok. Yazıyı sayfa görüntülerinden okuyabiliriz.'
      : 'Ayıklanan metin bozuk görünüyor (yazı tipi kodlaması hatalı olabilir). Sayfa görüntülerinden okumayı deneyebilirsiniz.';
  }
  if (empty && !offer && doc.kind !== 'txt') toast('Bu dosyada okunacak metin bulunamadı.', 5000);
  show(2);
  scrollToStudio();
}

function rangeBlocks() {
  const doc = state.doc;
  if (!doc) return [];
  if ($('range').hidden) return doc.blocks;
  const a = Math.max(1, Number($('range-from').value) || 1);
  const b = Math.max(a, Number($('range-to').value) || doc.pages);
  return doc.blocks.filter((x) => !x.page || (x.page >= a && x.page <= b));
}

// A document longer than PART_S seconds of speech is made part by part: the editor holds the chosen part.
function fillEditor() {
  const parts = splitParts(rangeBlocks(), partLimit() * 14);
  state.parts = parts;
  state.part = Math.min(state.part || 0, Math.max(0, parts.length - 1));
  renderParts();
  $('editor').value = blocksToText(parts.length ? parts[state.part].blocks : []);
  state.edited = false;
  updateCounts();
}

function renderParts() {
  const parts = state.parts || [];
  const sel = $('part');
  $('parts').hidden = parts.length < 2;
  if (parts.length > 1) {
    sel.textContent = '';
    parts.forEach((p, k) => {
      const o = document.createElement('option');
      o.value = String(k);
      const pages = p.from ? (p.from === p.to ? ` · s. ${p.from}` : ` · s. ${p.from}–${p.to}`) : '';
      o.textContent = `Bölüm ${k + 1}${pages} · ${dur(speechSeconds(p.chars, state.speed), { approx: true })}`;
      sel.appendChild(o);
    });
    sel.value = String(state.part);
    const all = parts.reduce((n, p) => n + p.chars, 0);
    $('parts-note').textContent = `Belge uzun (${dur(speechSeconds(all, state.speed), { approx: true })} ses). Bu cihazda bir seferde en çok ${partLimit() / 3600} saatlik bir bölüm dönüştürülür; bölümleri sırayla dönüştürüp ayrı ayrı indirebilirsiniz.`;
  }
}

$('part').addEventListener('change', () => {
  const k = Number($('part').value) || 0;
  if (state.edited && !window.confirm('Başka bölüme geçmek bu bölümde yaptığınız düzenlemeleri silecek. Devam edilsin mi?')) {
    $('part').value = String(state.part);
    return;
  }
  state.part = k;
  fillEditor();
});

for (const id of ['range-from', 'range-to']) {
  $(id).addEventListener('change', () => {
    const doc = state.doc;
    if (!doc) return;
    const clamp = (v) => Math.min(doc.pages, Math.max(1, Math.round(Number(v) || 1)));
    $('range-from').value = String(clamp($('range-from').value));
    $('range-to').value = String(Math.max(clamp($('range-from').value), clamp($('range-to').value)));
    if (state.edited && !window.confirm('Sayfa aralığını değiştirmek metinde yaptığınız düzenlemeleri silecek. Devam edilsin mi?')) return;
    state.part = 0;
    fillEditor();
  });
}

$('ocr-btn').addEventListener('click', async () => {
  const doc = state.doc;
  if (!doc || !doc.pdf) return;
  const a = $('range').hidden ? 1 : Number($('range-from').value) || 1;
  const b = $('range').hidden ? doc.pages : Number($('range-to').value) || doc.pages;
  const list = [];
  for (let p = a; p <= b; p++) list.push(p);
  const all = a <= 1 && b >= doc.pages;
  show(1);
  setExtracting(true, doc.name, 'Görüntüden okuma (OCR) hazırlanıyor…', null);
  const token = {};
  state.extracting = token;
  const left = () => state.extracting !== token || state.doc !== doc; // the visitor went on to something else
  let ocr = null;
  try {
    ocr = await import('./ocr.js');
    const blocks = await ocr.ocrPdf(doc.pdf, (p) => {
      if (left()) return;
      if (p.stage === 'ocr-load') setExtracting(true, doc.name, `Türkçe OCR indiriliyor… %${Math.round((p.frac || 0) * 100)}`, p.frac || 0);
      else setExtracting(true, doc.name, `Sayfa ${nf(list[Math.min(p.done, list.length - 1)])} görüntüden okunuyor (${nf(p.done + 1)} / ${nf(list.length)})`, p.frac);
    }, list);
    if (left()) return;
    state.extracting = null;
    setExtracting(false);
    // pdf.js with the whole file is let go once every page is read; after a range, the rest can still be read
    if (all) releasePdf(doc);
    const kept = doc.blocks.filter((x) => x.page && (x.page < a || x.page > b));
    openDoc({
      ...doc, blocks: [...kept, ...blocks].sort((x, y) => (x.page || 0) - (y.page || 0)), ocr: true,
      scanned: all ? false : doc.scanned, suspect: all ? false : doc.suspect, pdf: all ? null : doc.pdf,
    });
  } catch (e) {
    if (left()) return;
    console.error(e);
    state.extracting = null;
    setExtracting(false);
    show(2);
    toast('Görüntüden okuma başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin.', 6000);
  } finally {
    if (ocr) ocr.ocrDone(); // the OCR engine (a few hundred MB), however it ended
  }
});

$('paste-btn').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  openDoc({ name: 'Yapıştırılan metin', kind: 'txt', blocks: [], pages: null });
  $('editor').focus();
});
$('sample-btn').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  openDoc({ name: SAMPLE.name, kind: 'txt', blocks: parseEditor(SAMPLE.text), pages: null });
});
$('change-doc').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  show(1);
  fileInput.click();
});

// ---- text step ----------------------------------------------------------------------------------------------------------------------
const editor = $('editor');
editor.addEventListener('input', () => {
  state.edited = true;
  $('text-msg').hidden = true;
  updateCountsSoon();
});

let countTimer = 0;
function updateCountsSoon() {
  clearTimeout(countTimer);
  countTimer = setTimeout(updateCounts, 150);
}

function updateCounts() {
  const text = editor.value;
  const chars = text.replace(/\s+/g, ' ').trim().length;
  const words = countWords(text);
  const doc = state.doc;
  const parts = [];
  if (doc && doc.pages) parts.push(`${nf(doc.pages)} sayfa`);
  const inPart = state.parts && state.parts.length > 1 ? 'bu bölümde ' : '';
  parts.push(`${inPart}${nf(words)} kelime`, `${nf(chars)} karakter`);
  if (doc && doc.ocr) parts.push('OCR ile okundu');
  $('doc-stats').textContent = parts.join(' · ');
  state.chars = chars;
  renderEstimate();
}

// Real-time factor (seconds of work per second of audio) on this device: measured on the last job if there was one,
// else a guess from the backend (WebAssembly threads or WebGPU) and the steps.
function rtf(steps) {
  const cost = (b, p) => b + p * steps;
  const i = state.info;
  let est;
  if (i && i.backend === 'webgpu') est = cost(0.06, 0.008);
  else {
    const th = i ? i.threads : device.mobile ? 2 : 4;
    if (th >= 6) est = cost(0.04, 0.008);
    else if (th >= 4) est = cost(0.07, 0.011);
    else if (th >= 2) est = cost(0.12, 0.016);
    else est = cost(0.2, 0.028);
  }
  if (device.mobile) est *= 2;
  // Better than the guess: this device measured right after the model opened (js/worker.js calibrate), and better
  // still a whole job it made, scaled to these steps by the measured shape (the decoder and the text stage cost
  // the same at any number of steps).
  const c = state.calib;
  const shape = c ? (s) => c.base + c.per * s : (s) => 0.08 + 0.01 * s;
  if (c) est = shape(steps);
  if (state.measured) est = state.measured.rtf * (shape(steps) / shape(state.measured.steps));
  return est;
}

function renderEstimate() {
  const chars = state.chars || 0;
  // numbers are read out in words: "52.000" is "elli iki bin"
  const digits = (editor.value.match(/\d/g) || []).length;
  const audio = speechSeconds(chars + 2.5 * digits, state.speed);
  $('est-audio').textContent = chars ? dur(audio, { approx: true }) : '–';
  $('est-make').textContent = chars ? dur(audio * rtf(state.steps), { approx: true }) : '–';
  // A long job at the best quality: say what "Dengeli" (8 steps) would save, and what it costs. The choice stays the
  // visitor's: the model card measures UTMOS 3.44 at 16 steps and 3.30 at 8, and fewer steps sound brighter (the
  // sample's spectral centroid: 736 Hz at 16, 805 Hz at 8, 918 Hz at 4).
  const saved = audio * (rtf(16) - rtf(8));
  const tip = state.steps === 16 && saved > 10 * 60;
  $('est-tip').hidden = !tip;
  if (tip) $('est-tip-text').textContent = `“Dengeli” kalite bu belgeyi ${dur(saved, { approx: true }).replace('≈ ', 'yaklaşık ')} daha kısa sürede hazırlar, ama ses biraz daha tiz ve daha az doğal olur.`;
}
$('est-tip-btn').addEventListener('click', () => {
  setSteps(8);
  store('ahenk-okur-quality', '8');
});

const speed = $('speed');
function setSpeed(v) {
  state.speed = Math.min(1.4, Math.max(0.8, Number(v) || 1));
  speed.value = String(state.speed);
  $('speed-val').textContent = `${nf(state.speed, 2)}×`;
  speed.style.setProperty('--fill', `${((state.speed - 0.8) / 0.6) * 100}%`);
  renderEstimate();
}
speed.addEventListener('input', () => {
  setSpeed(speed.value);
  store('ahenk-okur-speed', String(state.speed));
});

const Q_HINT = { 4: 'en hızlı; ses belirgin biçimde tiz', 8: 'yaklaşık iki kat hızlı; ses biraz daha tiz', 16: 'en doğal ses' };
function setSteps(n) {
  state.steps = [4, 8, 16].includes(n) ? n : 16;
  for (const b of $('quality').children) b.setAttribute('aria-checked', String(Number(b.dataset.steps) === state.steps));
  $('q-hint').textContent = Q_HINT[state.steps];
  renderEstimate();
}
$('quality').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  setSteps(Number(b.dataset.steps));
  store('ahenk-okur-quality', String(state.steps));
});
$('quality').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const order = [4, 8, 16];
  const i = order.indexOf(state.steps) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
  setSteps(order[(i + 3) % 3]);
  store('ahenk-okur-quality', String(state.steps));
  $('quality').querySelector('[aria-checked="true"]').focus();
});

$('go').addEventListener('click', () => startJob());
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    startJob();
  }
});

// ---- the job ---------------------------------------------------------------------------------------------------------------------------
// A book-length text is cut into segments a slice at a time, so the page stays responsive while it is prepared.
async function segmentAll(blocks) {
  const SLICE = 300;
  if (blocks.length <= SLICE) return segment(blocks);
  const out = [];
  for (let i = 0; i < blocks.length; i += SLICE) {
    const part = segment(blocks.slice(i, i + SLICE), 40, i, i + SLICE >= blocks.length);
    for (const x of part) out.push(x);
    $('go-label').textContent = `Metin hazırlanıyor… %${Math.floor((100 * Math.min(blocks.length, i + SLICE)) / blocks.length)}`;
    await new Promise((r) => { setTimeout(r, 0); });
  }
  return out;
}

let preparing = false;
async function startJob(opts = {}) {
  if (preparing) return;
  preparing = true;
  $('go').disabled = true;
  try {
    await startJobNow(opts);
  } finally {
    preparing = false;
    $('go').disabled = false;
    $('go-label').textContent = 'Sese dönüştür';
  }
}

async function startJobNow({ confirmed = false } = {}) {
  let blocks = parseEditor(editor.value);
  // pasted (or written) text longer than one job may be is made in parts, like a long document
  if (state.doc && !(state.parts && state.parts.length > 1) && splitParts(blocks, partLimit() * 14).length > 1) {
    state.doc.blocks = blocks;
    $('range').hidden = true;
    state.part = 0;
    fillEditor();
    blocks = state.parts[0].blocks;
    toast(`Metin bu cihazda tek seferde dönüştürülemeyecek kadar uzun: ${nf(state.parts.length)} bölüme ayrıldı, ilk bölüm dönüştürülüyor.`, 7000);
  }
  const segs = await segmentAll(blocks);
  if (!segs.length) {
    $('text-msg').textContent = 'Önce seslendirilecek bir metin yazın ya da bir belge yükleyin.';
    $('text-msg').hidden = false;
    editor.focus();
    return;
  }
  if (state.loadStage === 'error') {
    $('text-msg').textContent = 'Ses modeli yüklenemedi. Yukarıdan “Tekrar dene”ye basın.';
    $('text-msg').hidden = false;
    $('model').scrollIntoView({ block: 'center' });
    return;
  }
  if (!confirmed && !confirmReplace()) return;
  if (isActive(job)) stopJob(true);

  // a segment's share of the work: its characters, numbers counted as the words they become
  const weights = segs.map((s) => spokenChars(s.speak) + 4);
  const chars = weights.reduce((a, b) => a + b, 0) - 4 * weights.length;
  const docName = state.doc ? state.doc.name : 'Metin';
  const parts = state.parts || [];
  const partNo = parts.length > 1 ? state.part + 1 : 0;
  const base = docName.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ahenk-okur';
  const prev = job;
  job = {
    id: nextId++, segs, blocks, weights, total: weights.reduce((a, b) => a + b, 0), doneW: 0, ready: 0, cur: 0, curFrac: 0,
    steps: state.steps, speed: state.speed, state: 'waiting', retries: 0, runT0: 0, runW0: 0, synthMs: 0, error: '',
    expected: speechSeconds(chars, state.speed), t0: performance.now(), failed: new Set(), partNo, parts: parts.length,
    name: partNo ? `${docName} · Bölüm ${partNo}/${parts.length}` : docName,
    file: partNo ? `${base} - Bölüm ${String(partNo).padStart(2, '0')}` : base,
    pending: new Map(), sid: null, stored: 0, saving: Promise.resolve(), savedAt: 0,
  };
  if (prev && prev.unlock) prev.unlock();
  state.downloaded = false;
  // the PDF itself is not needed while speaking (the text is out): free what pdf.js holds
  if (state.doc && state.doc.pdf) {
    releasePdf(state.doc);
    $('ocr-offer').hidden = true;
  }
  track = new Track((state.info && state.info.sampleRate) || 48000, { keepPcm: WAV_S });
  job.track = track;
  if (!state.store) track.keepInMemory();
  persistNewJob(job);
  startEncoder(job.id, track);
  listened = false;
  renderReader(blocks, segs);
  $('reader-title').textContent = job.name;
  player.load(track, { title: job.name, expected: job.expected });
  showPlayer(false);
  $('downloads').hidden = true;
  show(3);
  scrollToStudio();
  keepAwake(true);
  if (state.ready) sendJob();
  renderJob();
}

// A job saved on the device stays in "Kaydedilen dönüştürmeler": nothing to lose then. Audio only in this tab
// (no storage, or it failed), finished or not, is lost when another job takes its place.
function confirmReplace() {
  return !(track && track.count && !state.downloaded && job && !job.sid)
    || window.confirm('Önceki ses henüz indirilmedi ve bu cihaza kaydedilmedi. Yeni dönüştürme onun yerini alacak. Devam edilsin mi?');
}

// the job on the page; the one it replaces is no longer held open against another tab's pruning
function setJob(j) {
  if (job && job !== j && job.unlock) job.unlock();
  job = j;
}

// the next part of a long document, straight from the result
$('next-part').addEventListener('click', () => {
  if (!job || !job.partNo || job.partNo >= job.parts || !confirmReplace()) return;
  state.part = job.partNo;
  fillEditor();
  startJob({ confirmed: true });
});

function sendJob() {
  if (!job || !worker) return;
  if (track.mode === 'mp3' && (!encoder || encoder.tr !== track)) startEncoder(job.id, track);
  job.state = 'running';
  job.runT0 = performance.now();
  job.runW0 = job.doneW;
  job.cur = job.ready;
  job.curFrac = 0;
  state.heard = performance.now();
  worker.postMessage({
    type: 'synth', id: job.id, from: job.ready, steps: job.steps, speed: job.speed, seed: 0,
    segments: job.segs.map((s) => ({ text: s.speak, pause: s.pause })),
  });
  renderJob();
}

// A segment's samples from the speech worker: into the track (peaks, PCM while a WAV is offered), on to the MP3
// encoder; it becomes playable when its MP3 bytes come back (onPlayable).
function onSegment(data) {
  const i = data.index;
  if (i !== track.made) return; // a late message from before a restart
  if (track.mode === 'mp3' && !encoder) return; // the encoder died (encoderFailed): its audio would go nowhere
  const peaks = track.addPcm(i, data.pcm);
  if (track.mode === 'mp3') job.pending.set(i, { samples: data.pcm.length, peaks, failed: !!data.failed });
  if (data.failed) job.failed.add(i);
  job.ready = i + 1;
  job.doneW += job.weights[i];
  job.synthMs += data.ms;
  job.curFrac = 0;
  job.retries = 0; // progress again: a later crash gets its own retries
  if (track.mode === 'mp3' && encoder) encoder.w.postMessage({ type: 'pcm', index: i, pcm: data.pcm }, [data.pcm.buffer]);
  else onPlayable();
  // the waveform's scale: the expected length, from how long the speech so far is per unit of text
  if (job.doneW > 0 && job.ready < job.segs.length) player.expected = Math.max(track.madeDuration, (track.madeDuration / job.doneW) * job.total);
  if (job.ready >= job.segs.length) finishEncoder();
  else if (job.state === 'running' && track.mode === 'wav' && track.madeDuration > WAV_S) {
    haltJob(`Ses MP3'e çevrilemediği için en çok ${WAV_S / 60} dakikalık WAV üretilebiliyor. Bu kısmı indirin; sonra sayfayı yenileyip yeniden deneyin.`, false);
  } else if (job.state === 'running' && state.store && !job.sid && track.madeDuration > MEM_S * 1.1) {
    // storage failed during a job longer than a part kept in memory may be
    haltJob('Ses cihaza kaydedilemediği için bellekte tutuluyor ve bu uzunluktan fazlası sığmıyor. Bu kısmı indirin.', false);
  }
  scheduleProgress();
}

// The job cannot go on as it is: it stops here with `msg` ("Devam et" offered if `resume`).
function haltJob(msg, resume = true) {
  if ((job.state === 'running' || job.state === 'stopping') && worker) worker.postMessage({ type: 'cancel', id: job.id });
  job.state = 'error';
  job.error = msg;
  job.noResume = !resume;
  keepAwake(false);
  markGenerating(-1);
  if (track.count === track.made) player.finished();
  saveProgress(job, true);
  renderJob();
}

// segments [from, track.count) can be played now
function onPlayable(from = track.count - 1) {
  for (let i = Math.max(0, from); i < track.count; i++) markReady(i);
  player.grew();
  if (!isActive(job) && track.count === track.made) {
    player.finished();
    saveProgress(job, true); // the last MP3 bytes came after the job ended: the saved length is now complete
  }
  if (track.count && $('player').hidden) {
    showPlayer(true);
    if (player.audio.paused) $('listen-now').hidden = false;
  }
  scheduleProgress();
}

// ---- the MP3 encoder (js/mp3.js), one per job ----
let encoder = null;
function startEncoder(id, tr) {
  if (encoder) encoder.w.terminate();
  encoder = null;
  let w;
  try {
    w = new Worker(new URL('./mp3.js', import.meta.url), { type: 'module' });
  } catch {
    encoderFailed(tr);
    return;
  }
  encoder = { w, id, tr };
  w.onmessage = ({ data }) => {
    if (!encoder || encoder.w !== w || tr !== track) return;
    if (data.type === 'chunk') {
      if (data.index !== tr.count) return;
      tr.addMp3(data.index, data.bytes);
      if (job && job.id === id) persistChunk(job, tr, data.index);
      onPlayable();
    } else if (data.type === 'finished') {
      tr.finish(data.bytes);
      w.terminate();
      if (encoder && encoder.w === w) encoder = null;
    } else if (data.type === 'error') {
      console.warn('Ahenk Okur: MP3 encoder', data.message);
      encoderFailed(tr);
    }
  };
  w.onerror = () => encoderFailed(tr);
  w.postMessage({ type: 'start', sampleRate: tr.sr, kbps: 64 });
}
function finishEncoder() {
  if (encoder) encoder.w.postMessage({ type: 'finish' });
}
// No MP3: lamejs did not load, or its worker died.
function encoderFailed(tr) {
  if (encoder) encoder.w.terminate();
  encoder = null;
  if (tr !== track || !job) return;
  const from = tr.count;
  if (tr.fallBack()) {
    // All the PCM is still here: it plays and downloads as WAV (up to WAV_S, see onSegment). None of it is stored on
    // the device, so the job is not counted as saved any more; its record keeps what was stored before.
    if (job.sid) storageFailed(job, null, 'MP3 dönüştürücü yüklenemedi: ses WAV olarak yalnızca bu sekmede tutuluyor. İşiniz bitince indirmeyi unutmayın.');
    onPlayable(from);
    return;
  }
  // The MP3 made so far stays; the segments on their way to the encoder are lost, so the job stops after the last
  // segment that has its MP3, and "Devam et" goes on from there with a new encoder.
  tr.truncate(tr.count);
  job.ready = tr.count;
  job.doneW = job.weights.slice(0, tr.count).reduce((x, y) => x + y, 0);
  job.pending.clear();
  for (const i of job.failed) if (i >= tr.count) job.failed.delete(i);
  if (isActive(job)) haltJob('MP3 dönüştürücü durdu. O ana kadarki ses duruyor; “Devam et” ile sürdürebilirsiniz.');
  else {
    if (job.state === 'done' && job.ready < job.segs.length) job.state = 'stopped'; // its last segments are gone
    player.finished();
    saveProgress(job, true);
    renderJob();
  }
}

// ---- keeping the job on the device (js/storage.js) ----
// The text once, each segment's MP3 as it is encoded, the progress every few seconds. A tab that closes or crashes
// loses at most the segments being made; "Kaydedilen dönüştürmeler" opens the job again and goes on from there.
function persistNewJob(j) {
  const st = state.store;
  if (!st) return;
  j.sid = `j${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  j.unlock = holdJob(j.sid);
  const meta = jobMeta(j);
  j.saving = st.saveJob({ ...meta, created: Date.now() }, j.segs.map((x) => ({ text: x.text, speak: x.speak, pause: x.pause, block: x.block, heading: x.heading })))
    .then(() => st.prune(j.sid))
    .catch((e) => storageFailed(j, e));
}

// j.track, not the page's current track: a save still queued for an earlier job must describe that job. What is
// stored (j.stored segments, in order), not what is in the tab: the record says what opening it will give.
function jobMeta(j) {
  const t = j.track;
  const made = Math.min(j.stored, t ? t.count : 0);
  return {
    id: j.sid, name: j.name, file: j.file, steps: j.steps, speed: j.speed, n: j.segs.length, expected: j.expected,
    made, seconds: t ? t.offsets[made] / t.sr : 0,
    state: made >= j.segs.length ? 'done' : 'stopped', synthMs: j.synthMs, downloaded: state.downloaded,
  };
}

function persistChunk(j, tr, i) {
  const p = j.pending.get(i);
  j.pending.delete(i);
  if (!j.sid || !state.store || !p) return;
  const blob = tr.mp3[i];
  j.saving = j.saving.then(async () => {
    if (!j.sid) return;
    const stored = await state.store.putChunk(j.sid, i, { mp3: blob, samples: p.samples, peaks: p.peaks, failed: p.failed });
    j.stored = i + 1;
    tr.swapMp3(i, stored); // the in-memory copy can go
  }).catch((e) => storageFailed(j, e));
  saveProgress(j);
}

// the progress record: every 5 seconds while working, and at once when the job stops or ends
function saveProgress(j, now = false) {
  if (!j.sid || !state.store) return;
  if (!now && performance.now() - j.savedAt < 5000) return;
  j.savedAt = performance.now();
  j.saving = j.saving.then(() => (j.sid ? state.store.patchJob(j.sid, jobMeta(j), { must: true }) : null)).catch((e) => storageFailed(j, e));
}

// The job's audio is no longer kept on the device: from now on it is only in this tab (beforeunload and
// confirmReplace protect it then). Its record keeps what was stored.
function storageFailed(j, e, msg = '') {
  if (e) console.warn('Ahenk Okur: could not save to the device', e);
  if (!j.sid) return;
  const meta = jobMeta(j);
  j.sid = null;
  if (j.unlock) j.unlock();
  if (j.track) j.track.keepInMemory();
  if (!(e && e.name === 'JobGone')) state.store.patchJob(meta.id, meta).catch(() => {});
  const full = e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message)));
  toast(msg || (full ? 'Cihazda yer kalmadı: ses bundan sonra yalnızca bu sekmede tutuluyor. İşiniz bitince indirmeyi unutmayın.'
    : e && e.name === 'JobGone' ? 'Bu dönüştürme başka bir sekmede silindi; ses yalnızca bu sekmede tutuluyor.'
      : 'Ses bu cihaza kaydedilemiyor; yalnızca bu sekmede tutuluyor.'), 7000);
}

function finishJob(how) {
  if (!job) return;
  job.state = how;
  keepAwake(false);
  saveProgress(job, true);
  if (how === 'done' && track.madeDuration > 1) {
    state.measured = { rtf: job.synthMs / 1000 / track.madeDuration, steps: job.steps };
    store('ahenk-okur-rtf', JSON.stringify(state.measured));
  }
  markGenerating(-1);
  if (how === 'done') player.expected = track.madeDuration;
  if (track.count === track.made) player.finished(); // else when the last MP3 bytes arrive (onPlayable)
  renderJob();
  if (how === 'done' && document.hidden) document.title = '✓ Ses hazır · Ahenk Okur';
}

function stopJob(silent = false) {
  if (!job) return;
  if (job.state === 'waiting' || job.state === 'resuming' || (job.state === 'stopping' && silent)) {
    finishJob('stopped');
    return;
  }
  if (job.state !== 'running') return;
  job.state = 'stopping';
  if (worker) worker.postMessage({ type: 'cancel', id: job.id });
  renderJob();
  if (silent) finishJob('stopped');
}

// The engine broke (out of memory, an abort) or went silent: a new worker, and the job goes on from the segment it
// was on. Twice at most in a row; then the visitor decides.
function resumeAfterCrash() {
  if (!job) return;
  job.retries += 1;
  if (job.retries > 2) {
    job.state = 'error';
    job.error = 'Ses üretimi tekrar tekrar yarıda kaldı. Daha düşük kaliteyle ya da daha kısa bir metinle deneyin.';
    keepAwake(false);
    player.finished();
    renderJob();
    restartWorker();
    return;
  }
  job.state = 'resuming';
  restartWorker();
  renderJob();
}

function jobFailed(data) {
  console.warn('Ahenk Okur: synthesis failed', data);
  if (!isActive(job)) return; // already stopped or ended
  const broken = data.broken || data.kind === 'memory';
  if (job.state === 'stopping') {
    // the visitor asked to stop: it stays stopped, whatever broke on the way
    finishJob('stopped');
    if (broken) restartWorker();
    return;
  }
  if (broken) {
    resumeAfterCrash();
    return;
  }
  job.state = 'error';
  job.error = data.kind === 'network' ? 'Bağlantı koptu: gereken bir dosya indirilemedi. Bağlantınızı kontrol edip “Devam et”e basın.'
    : `Ses üretilemedi: ${data.message || 'bilinmeyen hata'}`;
  keepAwake(false);
  markGenerating(-1);
  if (track.count === track.made) player.finished();
  saveProgress(job, true);
  renderJob();
}

$('stop').addEventListener('click', () => stopJob());
$('resume').addEventListener('click', () => {
  if (!job || job.ready >= job.segs.length || job.noResume || isActive(job)) return;
  job.retries = 0;
  job.error = '';
  keepAwake(true);
  player.making = true;
  player.growth = []; // the making's pace is measured again
  if (state.ready) sendJob();
  else {
    job.state = 'waiting';
    if (state.loadStage === 'error') startWorker();
    renderJob();
  }
});
player.audio.addEventListener('play', () => {
  $('listen-now').hidden = true;
  if (!listened) {
    listened = true;
    highlight(track ? track.at(player.time()) : -1);
  }
});
$('listen-now').addEventListener('click', () => {
  player.play(0);
  $('listen-now').hidden = true;
});

let progressQueued = false;
function scheduleProgress() {
  if (progressQueued) return;
  progressQueued = true;
  requestAnimationFrame(() => {
    progressQueued = false;
    renderJob();
  });
}

// sentences the text front-end could not read: silence in the audio, marked in the text
const unread = () => (job.failed.size ? ` · ${nf(job.failed.size)} cümle okunamadı (metinde işaretli)` : '');

let lastEta = { at: 0, text: '' };
function renderJob() {
  if (!job) return;
  const n = job.segs.length;
  const cur = job.state === 'running' && job.cur === job.ready ? job.curFrac * job.weights[job.ready] : 0;
  const done = Math.min(job.total, job.doneW + cur);
  const frac = job.total ? done / job.total : 0;
  const pct = job.state === 'done' ? 100 : Math.min(99, Math.floor(frac * 100));
  const gen = $('gen');
  gen.dataset.state = job.state === 'stopping' ? 'running' : job.state === 'resuming' ? 'running' : job.state;
  $('gen-pct').textContent = String(pct);
  $('gen-fill').style.width = `${frac * 100}%`;
  $('gen-bar').setAttribute('aria-valuenow', String(pct));
  $('gen-bar').classList.toggle('is-busy', job.state === 'running');
  let title;
  let sub;
  switch (job.state) {
    case 'waiting':
      title = 'Model bekleniyor';
      sub = state.loadStage === 'error' ? 'Model yüklenemedi.' : `Model hazır olunca başlayacak (model %${Math.floor(modelPct())})`;
      break;
    case 'resuming':
      title = 'Yeniden başlatılıyor';
      sub = 'Model yeniden açılıyor; kaldığı yerden devam edecek.';
      break;
    case 'running':
    case 'stopping': {
      title = job.state === 'stopping' ? 'Durduruluyor…' : 'Ses üretiliyor';
      const now = performance.now();
      const elapsed = (now - job.runT0) / 1000;
      const work = done - job.runW0;
      let eta = 'kalan süre hesaplanıyor';
      if (elapsed > 4 && work > 0) {
        const left = ((job.total - done) / work) * elapsed;
        if (now - lastEta.at > 1000 || !lastEta.text) lastEta = { at: now, text: `kalan ${dur(left, { approx: true })}` };
        eta = lastEta.text;
      }
      sub = `Cümle ${nf(Math.min(n, job.ready + 1))} / ${nf(n)} · ${eta}`;
      break;
    }
    case 'done':
      title = 'Ses hazır';
      sub = `${dur(track.madeDuration)} ses · ${dur(job.synthMs / 1000)} sürede üretildi${unread()}`;
      break;
    case 'stopped':
      title = 'Durduruldu';
      sub = `${nf(job.ready)} / ${nf(n)} cümle hazır${track.made ? ` · ${dur(track.madeDuration)} ses` : ''}${unread()}`;
      break;
    case 'error':
      title = 'Ses üretimi durdu';
      sub = job.error || 'Bir hata oluştu.';
      break;
    default:
  }
  $('gen-title').textContent = title;
  $('gen-sub').textContent = sub;
  const active = isActive(job);
  $('stop').hidden = !active;
  $('stop').disabled = job.state === 'stopping';
  $('resume').hidden = !(job.state === 'stopped' || job.state === 'error') || job.ready >= n || !!job.noResume;
  if (!track.count) $('listen-now').hidden = true;
  // the last MP3 bytes come a moment after the last segment: no download until they are there
  $('downloads').hidden = !track.count || active || track.count < track.made;
  $('next-part').hidden = !(job.state === 'done' && job.partNo && job.partNo < job.parts);
  if (!$('next-part').hidden) $('next-part-label').textContent = `Sonraki bölüm (${job.partNo + 1}/${job.parts})`;
  if (track.count && (!active || !$('player').hidden)) {
    const partial = job.state !== 'done' ? ' · kısmi' : '';
    const mp3 = track.mode === 'mp3';
    $('dl-mp3').disabled = !mp3;
    $('dl-wav').disabled = !track.wavOk;
    $('dl-mp3-size').textContent = mp3 ? `${mb(track.mp3Bytes)} · her cihazda çalar${partial}` : 'hazırlanamadı';
    $('dl-wav-size').textContent = track.wavOk ? `${mb(track.wavBytes)} · kayıpsız, 48 kHz${partial}`
      : track.restored ? 'kayıttan açılan seste yok (yalnızca MP3 saklanır)' : `${WAV_S / 60} dakikadan uzun seslerde yok (çok büyük olurdu)`;
    $('pm-mp3').textContent = mp3 ? mb(track.mp3Bytes) : '–';
    $('pm-wav').textContent = track.wavOk ? mb(track.wavBytes) : 'çok uzun';
  }
  document.title = active ? `%${pct} · Ahenk Okur` : job.state === 'done' && document.hidden ? document.title : 'Ahenk Okur — Belgelerinizi Türkçe sesle dinleyin';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.title.startsWith('✓')) document.title = 'Ahenk Okur — Belgelerinizi Türkçe sesle dinleyin';
});

// ---- reader ----------------------------------------------------------------------------------------------------------------------------------
// The text, one page of about PAGE segments at a time: a whole book in the DOM makes every frame of the page slow
// (the browser hit-tests and repaints all of it while the progress moves). The page follows the voice; the visitor
// can leaf through with the pager, and "Çalan yere git" brings them back.
const reader = $('reader');
const PAGE = 120;
let rp = { starts: [0], page: 0, first: 0, last: 0 }; // segment index where each page starts; the page shown
let spans = []; // the spans of the page shown, segment first..last-1
let nowIdx = -1;
let genIdx = -1;
let browsing = false; // the visitor turned pages: stop following until they come back
let userScrolled = 0;
reader.addEventListener('wheel', () => { userScrolled = performance.now(); }, { passive: true });
reader.addEventListener('touchmove', () => { userScrolled = performance.now(); }, { passive: true });

function paginate(segs) {
  const starts = [0];
  let n = 0;
  for (let i = 1; i < segs.length; i++) {
    n += 1;
    // a new page at a paragraph, or inside one that goes on too long
    if ((n >= PAGE && segs[i].block !== segs[i - 1].block) || n >= PAGE * 1.5) {
      starts.push(i);
      n = 0;
    }
  }
  return starts;
}

const pageOf = (i) => {
  const st = rp.starts;
  let lo = 0;
  let hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};
const spanAt = (i) => (i >= rp.first && i < rp.last ? spans[i - rp.first] : null);

function renderReader(blocks, segs) {
  rp = { starts: paginate(segs), page: -1, first: 0, last: 0 };
  nowIdx = -1;
  genIdx = -1;
  browsing = false;
  showPage(0);
}

function showPage(k) {
  const segs = job ? job.segs : [];
  k = Math.max(0, Math.min(rp.starts.length - 1, k));
  rp.page = k;
  rp.first = rp.starts[k];
  rp.last = k + 1 < rp.starts.length ? rp.starts[k + 1] : segs.length;
  const frag = document.createDocumentFragment();
  let el = null;
  let last = -1;
  spans = [];
  for (let i = rp.first; i < rp.last; i++) {
    const s = segs[i];
    if (s.block !== last) {
      el = document.createElement(s.heading ? 'h3' : 'p');
      frag.appendChild(el);
      last = s.block;
    } else el.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    let cls = 's';
    if (!track || i >= track.count) cls += ' p';
    if (job && job.failed.has(i)) cls += ' x';
    if (i === genIdx) cls += ' g';
    if (listened && i === nowIdx) cls += ' now';
    span.className = cls;
    span.dataset.i = String(i);
    span.textContent = s.text;
    el.appendChild(span);
    spans.push(span);
  }
  reader.textContent = '';
  reader.appendChild(frag);
  reader.scrollTop = 0;
  const many = rp.starts.length > 1;
  $('pager').hidden = !many;
  if (many) {
    $('pg-num').textContent = `Sayfa ${nf(k + 1)} / ${nf(rp.starts.length)}`;
    $('pg-prev').disabled = k === 0;
    $('pg-next').disabled = k === rp.starts.length - 1;
    syncPager();
  }
}

// "Çalan yere git" when the voice (or, before listening, the making) is on another page
function syncPager() {
  const target = listened ? nowIdx : genIdx;
  const hide = !(rp.starts.length > 1 && target >= 0 && pageOf(target) !== rp.page);
  const label = listened ? 'Çalan yere git' : 'Üretilen yere git';
  const b = $('pg-here');
  if (b.hidden !== hide) b.hidden = hide;
  if (b.textContent !== label) b.textContent = label;
}

function turn(k) {
  browsing = true;
  showPage(k);
  reader.focus({ preventScroll: true });
}
$('pg-prev').addEventListener('click', () => turn(rp.page - 1));
$('pg-next').addEventListener('click', () => turn(rp.page + 1));
$('pg-here').addEventListener('click', () => {
  browsing = false;
  const target = listened ? nowIdx : genIdx;
  if (target >= 0) {
    showPage(pageOf(target));
    follow(spanAt(target), true);
  }
});

reader.addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s || !track) return;
  const i = Number(s.dataset.i);
  if (i < track.count) {
    $('listen-now').hidden = true;
    browsing = false;
    player.playSegment(i);
  } else toast('Bu cümle henüz hazır değil.');
});

function follow(span, force = false) {
  if (!span || (!force && performance.now() - userScrolled < 6000)) return;
  const top = span.offsetTop - reader.clientHeight * 0.3;
  const vis = span.offsetTop - reader.scrollTop;
  if (force || vis < reader.clientHeight * 0.12 || vis > reader.clientHeight * 0.75) reader.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

// A page change follows what the visitor is attending to: the voice once they listen, the making before that.
function bringIntoView(i) {
  if (i < 0 || browsing) return;
  if (i < rp.first || i >= rp.last) showPage(pageOf(i));
  follow(spanAt(i));
}

let listened = false; // the playing sentence is marked once the visitor has started listening
function highlight(i) {
  if (!listened || i === nowIdx) return;
  const old = spanAt(nowIdx);
  if (old) old.classList.remove('now');
  nowIdx = i;
  const s = spanAt(i);
  if (s) s.classList.add('now');
  if (!player.audio.paused) bringIntoView(i);
  syncPager();
}

function markGenerating(i) {
  if (i === genIdx) return;
  const old = spanAt(genIdx);
  if (old) old.classList.remove('g');
  genIdx = i;
  const s = spanAt(i);
  if (s) s.classList.add('g');
  if (!listened && player.audio.paused) bringIntoView(i);
  syncPager();
}

function markReady(i) {
  const s = spanAt(i);
  if (!s) return;
  s.classList.remove('p', 'g');
  if (job && job.failed.has(i)) {
    s.classList.add('x');
    s.title = 'Bu cümle okunamadı';
  }
}

// ---- downloads ----------------------------------------------------------------------------------------------------------------------------
function baseName() {
  const base = (job && job.file) || 'ahenk-okur';
  return job && job.state !== 'done' ? `${base} (kısmi)` : base;
}

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  state.downloaded = true;
  if (job && job.sid && state.store) state.store.patchJob(job.sid, { downloaded: true }).catch(() => {});
}

function downloadWav() {
  if (!track || !track.made) return;
  const blob = track.wav(WAV_INFO);
  if (!blob) {
    toast(track.restored ? 'Kayıttan açılan seste yalnızca MP3 var.'
      : `WAV yalnızca ${WAV_S / 60} dakikaya kadar olan seslerde sunulur (bu ses ${mb(track.wavBytes)} olurdu). MP3'ü indirin.`, 6000);
    return;
  }
  save(blob, `${baseName()}.wav`);
}

// the MP3 is ready as the speech is made: only its tag is added here
function downloadMp3() {
  if (!track || !track.count) return;
  const tags = {
    title: job ? job.name.replace(/\.[a-z0-9]{1,5}(?= ·|$)/i, '') : 'Ahenk Okur', artist: 'Ahenk Okur (yapay ses)', album: 'Ahenk Cep',
    track: job && job.partNo ? `${job.partNo}/${job.parts}` : '', comment: WAV_INFO.ICMT,
  };
  const blob = track.mp3Blob(id3(tags));
  if (!blob) {
    toast('MP3 hazırlanamadı; WAV olarak indirebilirsiniz.', 5000);
    return;
  }
  save(blob, `${baseName()}.mp3`);
}
$('dl-wav').addEventListener('click', downloadWav);
$('dl-mp3').addEventListener('click', downloadMp3);

const menu = $('p-menu');
$('p-dl').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = menu.hidden;
  menu.hidden = !open;
  $('p-dl').setAttribute('aria-expanded', String(open));
});
menu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-dl]');
  if (!b) return;
  menu.hidden = true;
  $('p-dl').setAttribute('aria-expanded', 'false');
  if (b.dataset.dl === 'mp3') downloadMp3();
  else downloadWav();
});
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target)) {
    menu.hidden = true;
    $('p-dl').setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') menu.hidden = true;
});

// ---- saved jobs ("Kaydedilen dönüştürmeler") -------------------------------------------------------------------------------------------
const relTime = (() => {
  try {
    return new Intl.RelativeTimeFormat('tr', { numeric: 'auto' });
  } catch {
    return null;
  }
})();
function ago(t) {
  const s = (t - Date.now()) / 1000;
  if (!relTime) return '';
  if (Math.abs(s) < 3600) return relTime.format(Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return relTime.format(Math.round(s / 3600), 'hour');
  return relTime.format(Math.round(s / 86400), 'day');
}

async function renderSaved() {
  const box = $('saved');
  if (!state.store) {
    box.hidden = true;
    return;
  }
  let jobs = [];
  try {
    jobs = await state.store.jobs();
  } catch { /* nothing to show */ }
  box.hidden = !jobs.length;
  const ul = $('saved-list');
  ul.textContent = '';
  for (const m of jobs) {
    const li = document.createElement('li');
    const done = m.state === 'done';
    const pct = m.n ? Math.floor((100 * m.made) / m.n) : 0;
    const main = document.createElement('div');
    main.className = 'sv-main';
    const name = document.createElement('strong');
    name.textContent = m.name;
    const sub = document.createElement('span');
    sub.className = 'num';
    sub.textContent = [done ? 'Hazır' : `%${pct} hazır`, m.seconds ? `${dur(m.seconds)} ses` : '', ago(m.updated)].filter(Boolean).join(' · ');
    main.append(name, sub);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'btn btn-sm ' + (done ? 'btn-ghost' : 'btn-primary');
    open.textContent = done ? 'Aç' : 'Devam et';
    open.addEventListener('click', () => openSaved(m.id, !done));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn sv-del';
    del.setAttribute('aria-label', `Sil: ${m.name}`);
    del.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-x"/></svg>';
    del.addEventListener('click', async () => {
      if (!window.confirm(`“${m.name}” bu cihazdan silinsin mi?`)) return;
      if (job && job.sid === m.id) job.sid = null;
      await state.store.deleteJob(m.id).catch(() => {});
      renderSaved();
    });
    li.append(main, open, del);
    ul.appendChild(li);
  }
  const use = await storageUse();
  $('saved-note').textContent = use && use.usage ? `Bu cihazda saklanır (${mb(use.usage)}). Son ${3} dönüştürme tutulur.` : 'Bu cihazda saklanır. Son 3 dönüştürme tutulur.';
}

// A saved job back on the page: its text, its audio (from disk) and where the listener was; `go` goes on making it.
async function openSaved(id, go) {
  if (!confirmDiscard()) return;
  if (job && job.sid === id && track) {
    show(3);
    scrollToStudio();
    if (go && job.state !== 'done') $('resume').click();
    return;
  }
  if (!confirmReplace()) return;
  let meta;
  let segs;
  let rows;
  try {
    meta = (await state.store.jobs()).find((x) => x.id === id);
    [segs, rows] = await Promise.all([state.store.text(id), state.store.chunks(id)]);
  } catch (e) {
    console.error(e);
  }
  if (!meta || !segs) {
    toast('Bu kayıt açılamadı.', 5000);
    return;
  }
  // rows are kept in order from 0; a gap (a write that did not land) ends what can be used
  let n = 0;
  while (n < rows.length && rows[n].index === n) n++;
  rows = rows.slice(0, n);
  if (encoder) encoder.w.terminate();
  encoder = null;
  const weights = segs.map((x) => spokenChars(x.speak) + 4);
  track = Track.restore((state.info && state.info.sampleRate) || 48000, rows);
  setJob({
    id: nextId++, segs, blocks: null, weights, total: weights.reduce((a, b) => a + b, 0),
    doneW: weights.slice(0, n).reduce((a, b) => a + b, 0), ready: n, cur: n, curFrac: 0,
    steps: meta.steps, speed: meta.speed, state: n >= segs.length ? 'done' : 'stopped', retries: 0, runT0: 0, runW0: 0,
    synthMs: meta.synthMs || 0, error: '', expected: meta.expected || track.duration, t0: performance.now(),
    failed: new Set(rows.filter((r) => r.failed).map((r) => r.index)), partNo: 0, parts: 0, name: meta.name, file: meta.file,
    pending: new Map(), sid: id, stored: n, saving: Promise.resolve(), savedAt: 0, track, unlock: holdJob(id),
  });
  state.downloaded = !!meta.downloaded;
  // the editor gets the text back, for "Metni düzenle"
  const blocks = [];
  for (const x of segs) {
    if (!blocks[x.block]) blocks[x.block] = { text: x.text, heading: x.heading };
    else blocks[x.block].text += ` ${x.text}`;
  }
  if (state.doc) releasePdf(state.doc);
  state.doc = { name: meta.name, kind: 'txt', blocks: blocks.filter(Boolean), pages: null };
  state.part = 0;
  state.edited = false;
  $('range').hidden = true;
  $('ocr-offer').hidden = true;
  docHeader(state.doc);
  fillEditor();
  renderReader(null, segs);
  // coming back to listen: the text stays where the listener was, not where the making goes on
  listened = (meta.position || 0) > 0;
  $('reader-title').textContent = job.name;
  player.load(track, { title: job.name, expected: job.state === 'done' ? track.duration : Math.max(track.duration, job.expected) });
  if (job.state === 'done') player.finished();
  show(3);
  scrollToStudio();
  if (track.count) {
    showPlayer(true);
    const at = Math.min(meta.position || 0, Math.max(0, track.duration - 1));
    player.seek(at);
    showPage(pageOf(Math.max(0, track.at(at))));
  }
  renderJob();
  if (go && job.state !== 'done') $('resume').click();
}

// where the listener is, so that opening the job again starts there
let posAt = 0;
function savePosition(force = false) {
  if (!job || !job.sid || !state.store || !track || !track.count) return;
  const now = performance.now();
  if (!force && now - posAt < 2000) return;
  posAt = now;
  state.store.patchJob(job.sid, { position: player.time() }).catch(() => {});
}
player.audio.addEventListener('timeupdate', () => savePosition());
player.audio.addEventListener('pause', () => savePosition(true));
// a tab that is hidden may never come back (phones discard it): save then
document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(true); });
window.addEventListener('pagehide', () => savePosition(true));

// ---- back and forth ----------------------------------------------------------------------------------------------------------------------
$('edit-again').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  show(2);
  scrollToStudio();
});
$('new-doc').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  show(1);
  renderSaved();
  scrollToStudio();
});

// ---- keeping the screen on while working, and not losing work --------------------------------------------------------------------------
let wake = null;
async function keepAwake(on) {
  try {
    if (on && !wake && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) {
      const w = wake;
      wake = null;
      await w.release();
    }
  } catch { /* not allowed here: fine */ }
}

window.addEventListener('beforeunload', (e) => {
  // with the job saved on the device, leaving only pauses it; without, the audio would be gone
  const busy = job && ['running', 'waiting', 'resuming', 'stopping'].includes(job.state);
  const saved = job && job.sid;
  if ((busy && !saved) || (track && track.count && !state.downloaded && !saved)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---- start ------------------------------------------------------------------------------------------------------------------------------------
$('link-github').href = LINKS.github;
$('link-cep').href = LINKS.hfCep;
try {
  const m = JSON.parse(store('ahenk-okur-rtf') || 'null');
  if (m && m.rtf > 0 && m.rtf < 20 && [4, 8, 16].includes(m.steps)) state.measured = m;
} catch { /* nothing saved */ }
// a new key: the earlier one may hold "Dengeli" from a tip that called its sound almost the same; everyone starts
// again from the best quality, and a choice made from now on is kept
const savedSteps = Number(store('ahenk-okur-quality'));
setSteps([4, 8, 16].includes(savedSteps) ? savedSteps : 16);
setSpeed(Number(store('ahenk-okur-speed')) || 1);
show(1);
renderModel();
renderTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderTheme);
afterCoiReload().then(startWorker);
openStore().then((st) => {
  state.store = st;
  renderSaved();
});
window.ahenkStarted = true; // index.html says the page did not load if this never runs
window.__ahenkOkur = { state, get job() { return job; }, get track() { return track; }, player, fmtTime };
