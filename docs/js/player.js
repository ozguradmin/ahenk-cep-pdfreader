// The document's audio and its player.
//
// Track: the audio of a document, segment by segment, as it arrives: its length, waveform peaks (one per 50 ms) and
// its MP3 bytes, encoded on the way by js/mp3.js (about 29 MB an hour). The 48 kHz PCM, 345 MB an hour, is kept too
// while the audio is short enough for a WAV download (`keepPcm` seconds); past that it is let go. Everything is
// held in Blobs, outside the JS heap. If the MP3 encoder cannot run, the track falls back to PCM and WAV only.
//
// Player: one <audio> element playing the segments ready so far. While the document is still being made, it plays
// what is there; when it reaches the end and more has arrived, it takes the longer file and goes on from the same
// place (when nothing new is there yet it waits, and starts again by itself). Lock-screen controls through the
// Media Session API.

import { wavBlob } from './wav.js';

const PEAK_S = 0.05;

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
    this.made = 0; // segments whose samples have arrived
    this.count = 0; // segments that can be played, from the start
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
      t.mp3.push(r.mp3);
      t.made += 1;
    }
    t.count = t.made;
    return t;
  }

  // the same bytes, now held on disk
  swapMp3(index, blob) {
    if (blob && index < this.mp3.length) this.mp3[index] = blob;
  }

  // a segment's MP3 bytes, in order
  addMp3(index, bytes) {
    if (this.mode !== 'mp3') return;
    if (index !== this.count) throw new Error(`mp3 ${index} out of order (have ${this.count})`);
    this.mp3.push(new Blob([bytes]));
    this.count += 1;
  }

  finish(bytes) { if (bytes && bytes.length) this.tail = new Blob([bytes]); }

  // the MP3 encoder failed: PCM from now on, and only what is still kept can play
  fallBack() {
    if (this.mode === 'wav') return false;
    this.mode = 'wav';
    this.mp3 = [];
    this.keepPcm = Infinity;
    if (!this.wavOk) return false; // nothing to fall back on
    this.count = this.made;
    return true;
  }

  get duration() { return this.offsets[this.count] / this.sr; }
  get madeDuration() { return this.offsets[this.made] / this.sr; }
  get wavBytes() { return this.offsets[this.made] * 2 + 44; }
  get mp3Bytes() { return this.mp3.reduce((n, b) => n + b.size, 0); }
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
    if (this.mode !== 'mp3') return null;
    const parts = this.mp3.slice(0, this.count);
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
    this.track = null;
  }

  time() {
    if (this.waiting) return this.track ? this.track.start(this.urlCount) : 0;
    return this.audio.currentTime || 0;
  }

  scale() {
    const d = this.track ? this.track.duration : 0;
    return this.making ? Math.max(d, this.expected || 0, 1) : Math.max(d, 0.001);
  }

  // A WAV of every segment ready now, at time t (keeps playing if it was).
  refresh(t, play) {
    const tr = this.track;
    if (!tr || !tr.count) return Promise.resolve();
    const old = this.url;
    this.url = URL.createObjectURL(tr.playable(this.opts.info || {}));
    this.urlCount = tr.count;
    const a = this.audio;
    a.src = this.url;
    a.playbackRate = this.rate;
    // play() is called at once, still inside the tap that asked for it (iOS refuses a later one); muted until it
    // has moved to t, so the first moments of the WAV are not heard
    let started = null;
    if (play) {
      if (t > 0.05) {
        a.muted = true;
        setTimeout(() => { a.muted = false; }, 1500); // whatever happens, never stuck silent
      }
      started = this.playEl().then((r) => {
        if (r !== 'playing') a.muted = false;
        return r;
      });
    }
    const ready = new Promise((resolve) => {
      const go = () => {
        a.removeEventListener('loadedmetadata', go);
        if (a.muted) a.addEventListener('seeked', () => { a.muted = false; }, { once: true });
        try { a.currentTime = Math.min(t, tr.duration); } catch { a.muted = false; }
        if (a.currentTime === 0 && t <= 0.05) a.muted = false;
        resolve();
      };
      a.addEventListener('loadedmetadata', go);
    });
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
    const t = from !== undefined ? from : this.audio.ended ? 0 : this.time();
    if (!this.url || this.urlCount < tr.count && (from !== undefined || this.audio.ended || t >= tr.start(this.urlCount) - 0.25)) {
      this.sync();
      return this.refresh(t, true).then(() => 'playing');
    }
    if (from !== undefined) this.audio.currentTime = from;
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
      this.audio.currentTime = t;
    }
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
    if (tr.count > this.urlCount) {
      this.refresh(tr.start(this.urlCount), true);
    } else if (this.making) {
      this.waiting = true; // grew() starts it again
    }
    this.sync();
  }

  // the worker sent another segment
  grew() {
    if (this.waiting && this.track && this.track.count > this.urlCount) {
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
      this.audio.pause();
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
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
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
