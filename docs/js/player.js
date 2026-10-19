// The document's audio and its player.
//
// Track: the audio of a document, segment by segment, as it arrives: its length, waveform peaks (one per 50 ms) and
// its MP3 bytes, encoded on the way by js/mp3.js (about 29 MB an hour). The 48 kHz PCM, 345 MB an hour, is kept too
// while the audio is short enough for a WAV download (`keepPcm` seconds); past that it is let go. Everything is
// held in Blobs, outside the JS heap. If the MP3 encoder cannot run, the track falls back to PCM and WAV only, as
// long as all the PCM is still there. The MP3 of a long document is played as one Blob made of groups of GROUP
// segments, each put together once, so that taking the longer file is not slower at the end of a book.
//
// Player: one <audio> element playing the segments ready so far. While the document is still being made, it plays
// what is there; when it reaches the end and more has arrived, it takes the longer file and goes on from the same
// place (when nothing new is there yet it waits, and starts again by itself). Lock-screen controls through the
// Media Session API.

import { wavBlob } from './wav.js';

const PEAK_S = 0.05;
const GROUP = 256;
// When the listener has caught up with a making slower than speech, playback goes on once this much more is ready
// (seconds), not after every sentence: a sentence, a pause, a sentence, a pause... is hard to listen to.
const AHEAD = 20;

export class Track {
  constructor(sampleRate, { keepPcm = 1800 } = {}) {
    this.sr = sampleRate;
    this.mode = 'mp3'; // 'wav' when the MP3 encoder failed
    this.keepPcm = keepPcm;
    this.wavOk = true; // all the PCM is still here
    this.pcm = [];
    this.mp3 = [];
    this.tail = null; // the encoder's last bytes, after the job
    this.offsets = [0];
    this.peaks = new Uint8Array(4096); // 0-255, one per PEAK_S; this.npeaks used
    this.npeaks = 0;
    this.peakAt = [0]; // npeaks after each segment
    this.made = 0; // segments whose samples have arrived
    this.count = 0; // segments that can be played, from the start
    this.bytes = 0; // MP3 bytes of those
    this.fin = 0; // segments [0, fin) hold their final Blob (on disk, or in memory when nothing is stored)
    this.keepsMp3 = false; // nothing is stored: every MP3 Blob is final as it comes
    this.groups = []; // Blobs of GROUP final segments each
  }

  pushPeaks(p) {
    if (this.npeaks + p.length > this.peaks.length) {
      const grown = new Uint8Array(Math.max(this.peaks.length * 2, this.npeaks + p.length));
      grown.set(this.peaks.subarray(0, this.npeaks));
      this.peaks = grown;
    }
    this.peaks.set(p, this.npeaks);
    this.npeaks += p.length;
  }

  // a segment's samples, in order -> its waveform peaks (kept with the segment on disk)
  addPcm(index, pcm) {
    if (index !== this.made) throw new Error(`segment ${index} out of order (have ${this.made})`);
    this.offsets.push(this.offsets[this.made] + pcm.length);
    const step = Math.round(this.sr * PEAK_S);
    const peaks = new Uint8Array(Math.ceil(pcm.length / step));
    for (let i = 0, j = 0; i < pcm.length; i += step, j++) {
      let m = 0;
      const e = Math.min(pcm.length, i + step);
      for (let k = i; k < e; k += 4) {
        const v = pcm[k] < 0 ? -pcm[k] : pcm[k];
        if (v > m) m = v;
      }
      peaks[j] = Math.round((m / 32768) * 255);
    }
    this.pushPeaks(peaks);
    this.peakAt.push(this.npeaks);
    this.made += 1;
    if (this.wavOk && this.offsets[this.made] / this.sr > this.keepPcm && this.mode === 'mp3') {
      this.wavOk = false;
      this.pcm = [];
    }
    if (this.wavOk) this.pcm.push(new Blob([pcm]));
    if (this.mode === 'wav') this.count = this.made;
    return peaks;
  }

  // A job read back from disk: rows {mp3, samples, peaks} in order. Its PCM is gone, so no WAV.
  static restore(sampleRate, rows) {
    const t = new Track(sampleRate, { keepPcm: 0 });
    t.wavOk = false;
    t.restored = true;
    for (const r of rows) {
      t.offsets.push(t.offsets[t.made] + r.samples);
      if (r.peaks) t.pushPeaks(r.peaks);
      t.peakAt.push(t.npeaks);
      t.mp3.push(r.mp3);
      t.bytes += r.mp3.size;
      t.made += 1;
    }
    t.count = t.made;
    t.fin = t.made;
    return t;
  }

  // the same bytes, now held on disk (in order)
  swapMp3(index, blob) {
    if (!blob || index >= this.mp3.length) return;
    this.mp3[index] = blob;
    if (index === this.fin) this.fin += 1;
  }

  // nothing more will be swapped (storage failed): the Blobs there are are the final ones
  keepInMemory() {
    this.keepsMp3 = true;
    this.fin = this.count;
  }

  // a segment's MP3 bytes, in order
  addMp3(index, bytes) {
    if (this.mode !== 'mp3') return;
    if (index !== this.count) throw new Error(`mp3 ${index} out of order (have ${this.count})`);
    this.mp3.push(new Blob([bytes]));
    this.bytes += bytes.length;
    this.count += 1;
    if (this.keepsMp3) this.fin = this.count;
  }

  finish(bytes) { if (bytes && bytes.length) this.tail = new Blob([bytes]); }

  // Back to the first n segments: what the samples of the others were for is lost (an encoder that died with them).
  truncate(n) {
    if (n >= this.made) return;
    this.made = n;
    this.count = Math.min(this.count, n);
    this.offsets.length = n + 1;
    this.peakAt.length = n + 1;
    this.npeaks = this.peakAt[n];
    if (this.pcm.length > n) this.pcm.length = n;
  }

  // The MP3 encoder failed: PCM from now on, if all of it is still here (else nothing changes, and false).
  fallBack() {
    if (this.mode === 'wav' || !this.wavOk) return false;
    this.mode = 'wav';
    this.mp3 = [];
    this.bytes = 0;
    this.groups = [];
    this.fin = 0;
    this.keepPcm = Infinity;
    this.count = this.made;
    return true;
  }

  get duration() { return this.offsets[this.count] / this.sr; }
  get madeDuration() { return this.offsets[this.made] / this.sr; }
  get wavBytes() { return this.offsets[this.made] * 2 + 44; }
  get mp3Bytes() { return this.bytes; }
  start(i) { return this.offsets[Math.min(i, this.count)] / this.sr; }

  // the segment playing at time t (seconds), or -1
  at(t) {
    const s = t * this.sr;
    let lo = 0;
    let hi = this.count - 1;
    if (hi < 0) return -1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  wav(info) { return this.wavOk ? wavBlob(this.pcm.slice(0, this.made), this.sr, info) : null; }

  mp3Blob(head = null) {
    if (this.mode !== 'mp3' || !this.count) return null;
    const G = GROUP;
    while ((this.groups.length + 1) * G <= this.fin) {
      const k = this.groups.length * G;
      this.groups.push(new Blob(this.mp3.slice(k, k + G)));
    }
    const parts = [...this.groups, ...this.mp3.slice(this.groups.length * G, this.count)];
    if (this.tail && this.count === this.made) parts.push(this.tail);
    return new Blob(head ? [head, ...parts] : parts, { type: 'audio/mpeg' });
  }

  // what the player plays
  playable(info) { return this.mode === 'mp3' ? this.mp3Blob() : this.wav(info); }
}

const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export { fmtTime };

const RATES = [1, 1.25, 1.5, 1.75, 2, 0.75];

export class Player {
  // els: {root, play, back, fwd, rate, wave, time, title}; opts: {info, artwork, onSegment(i), onToast(msg)}
  constructor(els, opts) {
    this.els = els;
    this.opts = opts;
    this.track = null;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.url = null;
    this.urlCount = 0; // segments in the WAV the element has
    this.expected = 0; // the document's expected length in seconds, for the waveform's scale
    this.making = false; // more segments are coming
    this.waiting = false; // reached the end of what is ready while more is coming
    this.pendingT = null; // where a new source is going, until its metadata has loaded (it reads 0 till then)
    this.rate = 1;
    this.lastSeg = -1;
    this.raf = 0;
    this.bind();
  }

  bind() {
    const a = this.audio;
    const { play, back, fwd, rate, wave } = this.els;
    play.addEventListener('click', () => this.toggle());
    back.addEventListener('click', () => this.seek(this.time() - 15));
    fwd.addEventListener('click', () => this.seek(this.time() + 15));
    rate.addEventListener('click', () => {
      this.rate = RATES[(RATES.indexOf(this.rate) + 1) % RATES.length];
      a.playbackRate = this.rate;
      rate.textContent = `${String(this.rate).replace('.', ',')}×`;
      rate.setAttribute('aria-label', `Dinleme hızı: ${rate.textContent}`);
    });
    a.addEventListener('play', () => this.sync());
    a.addEventListener('pause', () => this.sync());
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('timeupdate', () => this.tick());
    a.addEventListener('ratechange', () => { if (a.playbackRate !== this.rate) a.playbackRate = this.rate; });

    // seek on the waveform: pointer (mouse, finger) and keyboard (it is a slider)
    let dragging = false;
    const toTime = (e) => {
      const r = wave.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      return f * this.scale();
    };
    wave.addEventListener('pointerdown', (e) => {
      if (!this.track || !this.track.count) return;
      dragging = true;
      wave.setPointerCapture(e.pointerId);
      this.preview = toTime(e);
      this.draw();
    });
    wave.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.preview = toTime(e);
      this.draw();
    });
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      const t = toTime(e);
      this.preview = null;
      this.seek(t);
    };
    wave.addEventListener('pointerup', end);
    wave.addEventListener('pointercancel', () => { dragging = false; this.preview = null; this.draw(); });
    wave.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowDown') this.seek(this.time() - 5);
      else if (k === 'ArrowRight' || k === 'ArrowUp') this.seek(this.time() + 5);
      else if (k === 'Home') this.seek(0);
      else if (k === 'End') this.seek(this.track ? this.track.duration : 0);
      else if (k === ' ' || k === 'Enter') this.toggle();
      else return;
      e.preventDefault();
    });
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(wave);
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.draw());

    if ('mediaSession' in navigator) {
      const ms = navigator.mediaSession;
      const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* not supported here */ } };
      set('play', () => this.play());
      set('pause', () => this.audio.pause());
      set('seekbackward', (d) => this.seek(this.time() - (d.seekOffset || 15)));
      set('seekforward', (d) => this.seek(this.time() + (d.seekOffset || 15)));
      set('seekto', (d) => this.seek(d.seekTime));
      set('previoustrack', () => this.step(-1));
      set('nexttrack', () => this.step(1));
    }
  }

  // a new document
  load(track, { title, expected }) {
    this.stop();
    this.track = track;
    this.expected = expected || 0;
    this.making = true;
    this.toldWaiting = false;
    this.lastSeg = -1;
    this.els.title.textContent = title;
    this.title = title;
    if ('mediaSession' in navigator && window.MediaMetadata) {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'Ahenk Okur · yapay ses', album: 'Ahenk Cep', artwork: this.opts.artwork || [] });
    }
    this.draw();
    this.sync();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    try { this.audio.load(); } catch { /* nothing loaded */ }
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
    this.urlCount = 0;
    this.waiting = false;
    this.pendingT = null;
    clearInterval(this.settle);
    this.audio.muted = false;
    this.track = null;
  }

  time() {
    if (this.waiting) return this.track ? this.track.start(this.urlCount) : 0;
    if (this.pendingT !== null) return this.pendingT;
    return this.audio.currentTime || 0;
  }

  // to time t in the current source; before its metadata, the source goes there once it has loaded
  moveTo(t) {
    this.target = t;
    if (this.pendingT !== null) this.pendingT = t;
    else this.audio.currentTime = t;
  }

  // seconds ready after what the element has
  ahead() {
    const tr = this.track;
    return tr ? tr.duration - tr.start(this.urlCount) : 0;
  }

  scale() {
    const d = this.track ? this.track.duration : 0;
    return this.making ? Math.max(d, this.expected || 0, 1) : Math.max(d, 0.001);
  }

  // A WAV of every segment ready now, at time t (keeps playing if it was).
  refresh(t, play) {
    const tr = this.track;
    const blob = tr && tr.count ? tr.playable(this.opts.info || {}) : null;
    if (!blob) return Promise.resolve();
    const old = this.url;
    const url = URL.createObjectURL(blob);
    this.url = url;
    this.urlCount = tr.count;
    this.pendingT = t;
    this.target = t;
    const a = this.audio;
    clearInterval(this.settle);
    a.src = url;
    a.playbackRate = this.rate;
    // play() is called at once, still inside the tap that asked for it (iOS refuses a later one), so the element
    // starts at 0:00: muted until it is really at t (see below)
    const far = play && t > 0.05;
    a.muted = far;
    let started = null;
    if (play) {
      started = this.playEl().then((r) => {
        if (r !== 'playing') a.muted = false;
        return r;
      });
    }
    const ready = new Promise((resolve) => {
      const go = () => {
        a.removeEventListener('loadedmetadata', go);
        if (this.url !== url) return resolve(); // a newer source replaced this one
        // the latest target: a tap or a seek made while this loaded wins over the one it was made for
        const to = Math.min(this.pendingT !== null ? this.pendingT : t, tr.duration);
        this.pendingT = null;
        this.target = to;
        try { a.currentTime = to; } catch { /* the check below tries again */ }
        return resolve();
      };
      a.addEventListener('loadedmetadata', go);
    });
    if (far) {
      // The sound comes back only once the element is where it should be. Safari may ignore a seek made this early,
      // and a long file can take seconds to load on a phone: unmuting after a fixed time played the document from
      // its start, then jumped. So the seek is checked, and made again, until it holds (20 s at most).
      const t0 = performance.now();
      const done = () => {
        clearInterval(this.settle);
        if (this.url === url) a.muted = false;
      };
      this.settle = setInterval(() => {
        if (this.url !== url || performance.now() - t0 > 20000) return done();
        if (this.pendingT !== null) return undefined; // no metadata yet
        if (Math.abs(a.currentTime - this.target) < 1.5) return done();
        if (!a.seeking) {
          try { a.currentTime = this.target; } catch { /* again next time */ }
        }
        return undefined;
      }, 150);
    }
    a.addEventListener('error', () => {
      if (this.url !== url) return;
      this.pendingT = null;
      clearInterval(this.settle);
      a.muted = false;
    }, { once: true });
    if (old) setTimeout(() => URL.revokeObjectURL(old), 4000);
    return started ? Promise.all([ready, started]).then(([, r]) => r) : ready;
  }

  playEl() {
    return this.audio.play().then(() => 'playing', (e) => {
      this.sync();
      if (e && e.name === 'AbortError') return 'aborted'; // a newer source replaced this one
      if (e && e.name === 'NotAllowedError') {
        this.opts.onToast?.('Dinlemek için oynat düğmesine basın.');
        return 'blocked';
      }
      this.opts.onToast?.('Ses burada çalınamadı. Dosyayı indirip dinleyebilirsiniz.');
      return 'failed';
    });
  }

  play(from) {
    const tr = this.track;
    if (!tr || !tr.count) return Promise.resolve('empty');
    this.waiting = false;
    let t = from !== undefined ? from : this.time();
    if (from === undefined && this.audio.ended && this.url) {
      // at the end of what the element has: go on with what came since, wait for what is coming, or start over
      if (this.urlCount < tr.count) t = tr.start(this.urlCount);
      else if (this.making) {
        this.waiting = true;
        this.sync();
        return Promise.resolve('waiting');
      } else t = 0;
    }
    if (!this.url || this.urlCount < tr.count && (from !== undefined || this.audio.ended || t >= tr.start(this.urlCount) - 0.25)) {
      this.sync();
      return this.refresh(t, true).then(() => 'playing');
    }
    if (from !== undefined || this.audio.ended) this.moveTo(t);
    const p = this.playEl();
    this.sync();
    return p;
  }

  toggle() {
    if (this.waiting) {
      this.waiting = false;
      this.sync();
      return;
    }
    if (this.audio.paused) this.play();
    else this.audio.pause();
  }

  seek(t) {
    const tr = this.track;
    if (!tr || !tr.count) return;
    t = Math.max(0, t);
    if (t > tr.duration) {
      if (this.making) this.opts.onToast?.('Bu kısım henüz hazır değil; hazır olunca dinleyebilirsiniz.');
      t = Math.max(0, tr.duration - 0.05);
    }
    const playing = !this.audio.paused || this.waiting;
    this.waiting = false;
    if (t >= tr.start(this.urlCount) - 0.05 || !this.url) {
      this.refresh(t, playing);
    } else {
      this.moveTo(t);
      if (playing && this.audio.paused) this.playEl(); // it had ended, waiting for more
    }
    this.sync();
    this.tick(t);
  }

  // to the start of the previous / next segment
  step(dir) {
    const tr = this.track;
    if (!tr || !tr.count) return;
    let i = tr.at(this.time());
    if (dir < 0 && this.time() - tr.start(i) > 1.5) dir = 0;
    i = Math.min(tr.count - 1, Math.max(0, i + dir));
    this.seek(tr.start(i) + 0.01);
  }

  playSegment(i) {
    const tr = this.track;
    if (!tr) return;
    if (i >= tr.count) {
      this.opts.onToast?.('Bu cümle henüz hazır değil.');
      return;
    }
    this.play(tr.start(i) + 0.01);
  }

  onEnded() {
    const tr = this.track;
    if (!tr) return;
    if (tr.count > this.urlCount && (!this.making || this.ahead() >= AHEAD)) {
      this.refresh(tr.start(this.urlCount), true);
    } else if (this.making) {
      this.waiting = true; // grew() (or finished()) starts it again
      if (!this.toldWaiting) {
        this.toldWaiting = true;
        this.opts.onToast?.('Dinleme, sesin üretimine yetişti: biraz daha ses birikince kendiliğinden devam edecek.');
      }
    }
    this.sync();
  }

  // the worker sent another segment
  grew() {
    if (this.waiting && this.track && this.track.count > this.urlCount && this.ahead() >= AHEAD) {
      this.waiting = false;
      this.refresh(this.track.start(this.urlCount), true);
    }
    this.draw();
    this.sync();
  }

  // no more segments are coming (done, stopped or failed)
  finished() {
    this.making = false;
    if (this.waiting) {
      this.waiting = false;
      if (this.track && this.track.count > this.urlCount) this.refresh(this.track.start(this.urlCount), true); // the last of it
      else this.audio.pause();
    }
    this.draw();
    this.sync();
  }

  sync() {
    const root = this.els.root;
    const playing = !this.audio.paused && !this.audio.ended;
    root.classList.toggle('is-playing', playing || this.waiting);
    root.classList.toggle('is-waiting', this.waiting);
    this.els.play.setAttribute('aria-label', playing || this.waiting ? 'Duraklat' : 'Oynat');
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing || this.waiting ? 'playing' : 'paused';
    if (playing && !this.raf) {
      const loop = () => {
        this.tick();
        this.raf = !this.audio.paused ? requestAnimationFrame(loop) : 0;
      };
      this.raf = requestAnimationFrame(loop);
    }
    this.tick();
  }

  tick(at) {
    const tr = this.track;
    const t = at !== undefined ? at : this.time();
    const total = tr ? tr.duration : 0;
    this.els.time.textContent = `${fmtTime(t)} / ${fmtTime(Math.round(this.making ? Math.max(total, this.expected) : total))}${this.making ? '+' : ''}`;
    const w = this.els.wave;
    w.setAttribute('aria-valuemax', String(Math.round(total)));
    w.setAttribute('aria-valuenow', String(Math.round(t)));
    w.setAttribute('aria-valuetext', fmtTime(t));
    if (tr && tr.count) {
      const i = tr.at(t);
      if (i !== this.lastSeg) {
        this.lastSeg = i;
        this.opts.onSegment?.(i);
      }
    }
    const now = performance.now();
    if (!this.lastDraw || now - this.lastDraw > 60) this.draw(t);
    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && total > 0 && !this.making) {
      try { navigator.mediaSession.setPositionState({ duration: total, playbackRate: this.rate, position: Math.min(t, total) }); } catch { /* ignore */ }
    }
  }

  draw(at) {
    this.lastDraw = performance.now();
    const wave = this.els.wave;
    const c = wave.querySelector('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = wave.clientWidth;
    const H = wave.clientHeight;
    if (!W || !H) return;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#c4502b';
    const ink = css.getPropertyValue('--line-2').trim() || '#ccc';
    const muted = css.getPropertyValue('--muted').trim() || '#999';
    const tr = this.track;
    const scale = this.scale();
    const t = this.preview != null ? this.preview : at !== undefined ? at : this.time();
    const bar = 3;
    const gap = 2;
    const n = Math.floor(W / (bar + gap));
    const ready = tr ? tr.duration / scale : 0;
    const mid = H / 2;
    const peaks = tr ? tr.peaks : new Uint8Array(0);
    const np = tr ? tr.npeaks : 0;
    const perBar = (scale / PEAK_S) / n;
    for (let k = 0; k < n; k++) {
      const x = k * (bar + gap);
      const f0 = k / n;
      if (f0 >= ready) {
        g.fillStyle = ink;
        g.globalAlpha = 0.6;
        g.fillRect(x, mid - 1, bar, 2);
        g.globalAlpha = 1;
        continue;
      }
      const a = Math.floor(k * perBar);
      const b = Math.max(a + 1, Math.floor((k + 1) * perBar));
      let m = 0;
      for (let j = a; j < b && j < np; j += Math.max(1, Math.floor((b - a) / 8))) m = Math.max(m, peaks[j]);
      m /= 255;
      const h = Math.max(2, Math.min(H, Math.pow(m, 0.6) * H * 1.15));
      g.fillStyle = f0 <= t / scale ? accent : muted;
      g.globalAlpha = f0 <= t / scale ? 1 : 0.5;
      g.beginPath();
      if (g.roundRect) g.roundRect(x, mid - h / 2, bar, h, 1.5);
      else g.rect(x, mid - h / 2, bar, h);
      g.fill();
    }
    g.globalAlpha = 1;
    // playhead
    const px = Math.min(W - 1, (t / scale) * W);
    g.fillStyle = accent;
    g.fillRect(px - 1, 2, 2, H - 4);
  }
}
