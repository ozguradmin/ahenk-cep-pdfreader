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
import { blocksToText, countWords, parseEditor, segment, speechSeconds } from './text.js';

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
};
let job = null;
let track = null;
let spans = [];
let mp3Cache = null;
let nextId = 1;

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
  onToast: (m) => toast(m),
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
    ep: avoid.webgpu ? 'wasm' : opts.ep, device, maxThreads: avoid.threads ? 1 : 0,
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
  if (job && (job.state === 'running' || job.state === 'waiting' || job.state === 'stopping')) {
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
    doc.name = file.name;
    setExtracting(false);
    openDoc(doc);
  } catch (e) {
    setExtracting(false);
    console.error(e);
    let msg;
    if (e instanceof ExtractError) msg = EXTRACT_ERRORS[e.code] || EXTRACT_ERRORS.broken;
    else if (/fetch|import|network|load failed/i.test(String(e && e.message))) msg = 'Belge okuyucu indirilemedi. Bağlantınızı kontrol edip tekrar deneyin.';
    else msg = EXTRACT_ERRORS.broken;
    toast(msg, 6000);
  }
}

function openDoc(doc) {
  state.doc = doc;
  state.edited = false;
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
  $('doc-name').textContent = doc.name;
  $('doc-name').title = doc.name;
  const icon = $('doc-icon');
  icon.dataset.kind = doc.kind;
  icon.textContent = KIND_LABEL[doc.kind] || 'TXT';
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

function fillEditor() {
  $('editor').value = blocksToText(rangeBlocks());
  state.edited = false;
  updateCounts();
}

for (const id of ['range-from', 'range-to']) {
  $(id).addEventListener('change', () => {
    const doc = state.doc;
    if (!doc) return;
    const clamp = (v) => Math.min(doc.pages, Math.max(1, Math.round(Number(v) || 1)));
    $('range-from').value = String(clamp($('range-from').value));
    $('range-to').value = String(Math.max(clamp($('range-from').value), clamp($('range-to').value)));
    if (state.edited && !window.confirm('Sayfa aralığını değiştirmek metinde yaptığınız düzenlemeleri silecek. Devam edilsin mi?')) return;
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
  show(1);
  setExtracting(true, doc.name, 'Görüntüden okuma (OCR) hazırlanıyor…', null);
  try {
    const { ocrPdf } = await import('./ocr.js');
    const blocks = await ocrPdf(doc.pdf, (p) => {
      if (p.stage === 'ocr-load') setExtracting(true, doc.name, `Türkçe OCR indiriliyor… %${Math.round((p.frac || 0) * 100)}`, p.frac || 0);
      else setExtracting(true, doc.name, `Sayfa ${nf(list[Math.min(p.done, list.length - 1)])} görüntüden okunuyor (${nf(p.done + 1)} / ${nf(list.length)})`, p.frac);
    }, list);
    setExtracting(false);
    const kept = doc.blocks.filter((x) => x.page && (x.page < a || x.page > b));
    openDoc({ ...doc, blocks: [...kept, ...blocks].sort((x, y) => (x.page || 0) - (y.page || 0)), scanned: false, suspect: false, ocr: true, pdf: null });
    $('ocr-offer').hidden = true;
  } catch (e) {
    console.error(e);
    setExtracting(false);
    show(2);
    toast('Görüntüden okuma başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin.', 6000);
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
  parts.push(`${nf(words)} kelime`, `${nf(chars)} karakter`);
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
  if (state.measured) {
    // the decoder and the text stage cost the same at any number of steps
    const m = state.measured;
    const same = (s) => 0.08 + 0.01 * s;
    est = m.rtf * (same(steps) / same(m.steps));
  }
  return est;
}

function renderEstimate() {
  const chars = state.chars || 0;
  // numbers are read out in words: "52.000" is "elli iki bin"
  const digits = (editor.value.match(/\d/g) || []).length;
  const audio = speechSeconds(chars + 2.5 * digits, state.speed);
  $('est-audio').textContent = chars ? dur(audio, { approx: true }) : '–';
  $('est-make').textContent = chars ? dur(audio * rtf(state.steps), { approx: true }) : '–';
}

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

const Q_HINT = { 4: 'en hızlı, biraz daha az doğal', 8: 'hızlı ve doğal', 16: 'en doğal ses' };
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
  store('ahenk-okur-steps', String(state.steps));
});
$('quality').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const order = [4, 8, 16];
  const i = order.indexOf(state.steps) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1);
  setSteps(order[(i + 3) % 3]);
  store('ahenk-okur-steps', String(state.steps));
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
function startJob() {
  const blocks = parseEditor(editor.value);
  const segs = segment(blocks);
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
  if (track && track.count && !state.downloaded && job && job.state === 'done'
    && !window.confirm('Önceki ses henüz indirilmedi. Yeni dönüştürme onun yerini alacak. Devam edilsin mi?')) return;
  if (job && job.state === 'running') stopJob(true);

  // a segment's share of the work: its characters, numbers counted as the words they become
  const weights = segs.map((s) => s.speak.length + 2.5 * (s.speak.match(/\d/g) || []).length + 4);
  const chars = weights.reduce((a, b) => a + b, 0) - 4 * weights.length;
  job = {
    id: nextId++, segs, blocks, weights, total: weights.reduce((a, b) => a + b, 0), doneW: 0, ready: 0, cur: 0, curFrac: 0,
    steps: state.steps, speed: state.speed, state: 'waiting', retries: 0, runT0: 0, runW0: 0, synthMs: 0, error: '',
    expected: speechSeconds(chars, state.speed), name: state.doc ? state.doc.name : 'Metin', t0: performance.now(),
  };
  mp3Cache = null;
  state.downloaded = false;
  track = new Track((state.info && state.info.sampleRate) || 48000);
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

function sendJob() {
  if (!job || !worker) return;
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

function onSegment(data) {
  const i = data.index;
  if (i !== track.count) return; // a late message from before a restart
  track.add(i, data.pcm);
  job.ready = i + 1;
  job.doneW += job.weights[i];
  job.synthMs += data.ms;
  job.curFrac = 0;
  job.retries = 0; // progress again: a later crash gets its own retries
  const span = spans[i];
  if (span) {
    span.classList.remove('p', 'g');
    if (data.failed) {
      span.classList.add('x');
      span.title = 'Bu cümle okunamadı';
    }
  }
  // the waveform's scale: the expected length, from how long the speech so far is per unit of text
  if (job.doneW > 0 && job.ready < job.segs.length) player.expected = Math.max(track.duration, (track.duration / job.doneW) * job.total);
  if (track.count === 1) {
    showPlayer(true);
    $('listen-now').hidden = false;
  }
  player.grew();
  scheduleProgress();
}

function finishJob(how) {
  if (!job) return;
  job.state = how;
  keepAwake(false);
  if (how === 'done' && track.duration > 1) {
    state.measured = { rtf: job.synthMs / 1000 / track.duration, steps: job.steps };
    store('ahenk-okur-rtf', JSON.stringify(state.measured));
  }
  for (const s of spans) s.classList.remove('g');
  if (how === 'done') player.expected = track.duration;
  player.finished();
  renderJob();
  if (how === 'done' && document.hidden) document.title = '✓ Ses hazır · Ahenk Okur';
}

function stopJob(silent = false) {
  if (!job) return;
  if (job.state === 'waiting' || job.state === 'resuming') {
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
  if (data.broken || data.kind === 'memory') {
    resumeAfterCrash();
    return;
  }
  job.state = 'error';
  job.error = data.kind === 'memory' ? 'Cihazın belleği yetmedi.' : `Ses üretilemedi: ${data.message || 'bilinmeyen hata'}`;
  keepAwake(false);
  player.finished();
  renderJob();
}

$('stop').addEventListener('click', () => stopJob());
$('resume').addEventListener('click', () => {
  if (!job || job.ready >= job.segs.length) return;
  job.retries = 0;
  job.error = '';
  keepAwake(true);
  player.making = true;
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
      sub = `${dur(track.duration)} ses · ${dur(job.synthMs / 1000)} sürede üretildi`;
      break;
    case 'stopped':
      title = 'Durduruldu';
      sub = `${nf(job.ready)} / ${nf(n)} cümle hazır${track.count ? ` · ${dur(track.duration)} ses` : ''}`;
      break;
    case 'error':
      title = 'Ses üretimi durdu';
      sub = job.error || 'Bir hata oluştu.';
      break;
    default:
  }
  $('gen-title').textContent = title;
  $('gen-sub').textContent = sub;
  const active = ['waiting', 'running', 'stopping', 'resuming'].includes(job.state);
  $('stop').hidden = !active;
  $('stop').disabled = job.state === 'stopping';
  $('resume').hidden = !(job.state === 'stopped' || job.state === 'error') || job.ready >= n;
  if (!track.count) $('listen-now').hidden = true;
  $('downloads').hidden = !track.count || active;
  if (track.count) {
    const partial = job.state !== 'done';
    $('dl-wav-size').textContent = `${mb(track.bytes + 44)} · kayıpsız, 48 kHz${partial ? ' · kısmi' : ''}`;
    $('dl-mp3-size').textContent = `${mb(track.duration * 8000)} · her cihazda çalar${partial ? ' · kısmi' : ''}`;
    $('pm-wav').textContent = mb(track.bytes + 44);
    $('pm-mp3').textContent = `≈ ${mb(track.duration * 8000)}`;
  }
  document.title = active ? `%${pct} · Ahenk Okur` : job.state === 'done' && document.hidden ? document.title : 'Ahenk Okur — Belgelerinizi Türkçe sesle dinleyin';
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && document.title.startsWith('✓')) document.title = 'Ahenk Okur — Belgelerinizi Türkçe sesle dinleyin';
});

// ---- reader --------------------------------------------------------------------------------------------------------------------------------
const reader = $('reader');
let userScrolled = 0;
let nowSpan = null;
let genSpan = null;
reader.addEventListener('wheel', () => { userScrolled = performance.now(); }, { passive: true });
reader.addEventListener('touchmove', () => { userScrolled = performance.now(); }, { passive: true });

function renderReader(blocks, segs) {
  reader.textContent = '';
  const frag = document.createDocumentFragment();
  let el = null;
  let last = -1;
  segs.forEach((s, i) => {
    if (s.block !== last) {
      el = document.createElement(s.heading ? 'h3' : 'p');
      frag.appendChild(el);
      last = s.block;
    } else el.appendChild(document.createTextNode(' '));
    const span = document.createElement('span');
    span.className = 's p';
    span.dataset.i = String(i);
    span.textContent = s.text;
    el.appendChild(span);
  });
  reader.appendChild(frag);
  spans = Array.from(reader.querySelectorAll('.s'));
  nowSpan = null;
  genSpan = null;
  reader.scrollTop = 0;
}

reader.addEventListener('click', (e) => {
  const s = e.target.closest('.s');
  if (!s || !track) return;
  const i = Number(s.dataset.i);
  if (i < track.count) {
    $('listen-now').hidden = true;
    player.playSegment(i);
  } else toast('Bu cümle henüz hazır değil.');
});

function follow(span) {
  if (!span || performance.now() - userScrolled < 6000) return;
  const top = span.offsetTop - reader.clientHeight * 0.3;
  const vis = span.offsetTop - reader.scrollTop;
  if (vis < reader.clientHeight * 0.12 || vis > reader.clientHeight * 0.75) reader.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

let listened = false; // the playing sentence is marked once the visitor has started listening
function highlight(i) {
  if (!listened) return;
  const s = spans[i];
  if (s === nowSpan) return;
  if (nowSpan) nowSpan.classList.remove('now');
  nowSpan = s || null;
  if (nowSpan) {
    nowSpan.classList.add('now');
    if (!player.audio.paused) follow(nowSpan);
  }
}

function markGenerating(i) {
  const s = spans[i];
  if (s === genSpan) return;
  if (genSpan) genSpan.classList.remove('g');
  genSpan = s || null;
  if (genSpan) {
    genSpan.classList.add('g');
    if (player.audio.paused) follow(genSpan);
  }
}

// ---- downloads ----------------------------------------------------------------------------------------------------------------------------
function baseName() {
  const raw = (job && job.name) || 'ahenk-okur';
  const base = raw.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'ahenk-okur';
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
}

function downloadWav() {
  if (!track || !track.count) return;
  save(track.wav(WAV_INFO), `${baseName()}.wav`);
}

let mp3Worker = null;
function downloadMp3() {
  if (!track || !track.count) return;
  if (mp3Cache && mp3Cache.count === track.count) {
    save(mp3Cache.blob, `${baseName()}.mp3`);
    return;
  }
  const count = track.count;
  $('modal').hidden = false;
  $('modal-title').textContent = 'MP3 hazırlanıyor';
  $('modal-sub').textContent = '%0';
  $('modal-fill').style.width = '0%';
  mp3Worker = new Worker(new URL('./mp3.js', import.meta.url), { type: 'module' });
  mp3Worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      $('modal-sub').textContent = `%${Math.floor(data.frac * 100)}`;
      $('modal-fill').style.width = `${data.frac * 100}%`;
    } else if (data.type === 'done') {
      closeMp3();
      mp3Cache = { count, blob: data.blob };
      save(data.blob, `${baseName()}.mp3`);
    } else if (data.type === 'error') {
      closeMp3();
      console.error('Ahenk Okur: MP3', data.message);
      toast('MP3 hazırlanamadı. WAV olarak indirebilirsiniz.', 5000);
    }
  };
  mp3Worker.onerror = () => {
    closeMp3();
    toast('MP3 hazırlanamadı. WAV olarak indirebilirsiniz.', 5000);
  };
  mp3Worker.postMessage({
    parts: track.parts.slice(0, count), sampleRate: track.sr, kbps: 64,
    tags: { title: baseName(), artist: 'Ahenk Okur (yapay ses)', album: 'Ahenk Cep', comment: WAV_INFO.ICMT },
  });
}
function closeMp3() {
  if (mp3Worker) mp3Worker.terminate();
  mp3Worker = null;
  $('modal').hidden = true;
}
$('modal-cancel').addEventListener('click', closeMp3);
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
  if (e.key === 'Escape') {
    menu.hidden = true;
    if (!$('modal').hidden) closeMp3();
  }
});

// ---- back and forth ----------------------------------------------------------------------------------------------------------------------
$('edit-again').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  show(2);
  scrollToStudio();
});
$('new-doc').addEventListener('click', () => {
  if (!confirmDiscard()) return;
  show(1);
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
  const busy = job && ['running', 'waiting', 'resuming', 'stopping'].includes(job.state);
  if (busy || (track && track.count && !state.downloaded)) {
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
const savedSteps = Number(store('ahenk-okur-steps'));
setSteps([4, 8, 16].includes(savedSteps) ? savedSteps : device.mobile ? 8 : 16);
setSpeed(Number(store('ahenk-okur-speed')) || 1);
show(1);
renderModel();
renderTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', renderTheme);
afterCoiReload().then(startWorker);
window.ahenkStarted = true; // index.html says the page did not load if this never runs
window.__ahenkOkur = { state, get job() { return job; }, get track() { return track; }, player, fmtTime };
