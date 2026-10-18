// MP3 from the document's Int16 segments, in a worker (lamejs, LGPL-3.0, @breezystack/lamejs from jsdelivr).
// Mono, the model's 48 kHz, 64 kbit/s: plenty for speech, about a tenth of the WAV. An ID3v2.3 tag carries the title
// and says that the speech is synthetic.
//
// In:  {parts: Blob[], sampleRate, kbps, tags: {title, artist, album, comment}}
// Out: {type: 'progress', frac} ... {type: 'done', blob} | {type: 'error', message}

import { CDN } from './config.js';

const FRAME = 1152 * 32;

function id3(tags) {
  const enc16 = (s) => {
    const out = new Uint8Array(2 + s.length * 2);
    out[0] = 0xff;
    out[1] = 0xfe;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[2 + i * 2] = c & 0xff;
      out[3 + i * 2] = c >> 8;
    }
    return out;
  };
  const frame = (id, body) => {
    const f = new Uint8Array(10 + body.length);
    for (let i = 0; i < 4; i++) f[i] = id.charCodeAt(i);
    new DataView(f.buffer).setUint32(4, body.length);
    f.set(body, 10);
    return f;
  };
  const text = (id, s) => frame(id, Uint8Array.from([1, ...enc16(s)]));
  const frames = [];
  if (tags.title) frames.push(text('TIT2', tags.title));
  if (tags.artist) frames.push(text('TPE1', tags.artist));
  if (tags.album) frames.push(text('TALB', tags.album));
  if (tags.comment) {
    const body = [1, ...'tur'.split('').map((c) => c.charCodeAt(0)), ...enc16(''), 0, 0, ...enc16(tags.comment)];
    frames.push(frame('COMM', Uint8Array.from(body)));
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, 3, 0, 0]);
  head[6] = (size >> 21) & 0x7f;
  head[7] = (size >> 14) & 0x7f;
  head[8] = (size >> 7) & 0x7f;
  head[9] = size & 0x7f;
  return [head, ...frames];
}

self.onmessage = async ({ data }) => {
  try {
    const { Mp3Encoder } = await import(CDN.lame);
    const { parts, sampleRate, kbps = 64, tags = {} } = data;
    const enc = new Mp3Encoder(1, sampleRate, kbps);
    const out = id3(tags);
    const total = parts.reduce((n, p) => n + p.size / 2, 0);
    let done = 0;
    let last = 0;
    for (const part of parts) {
      const pcm = new Int16Array(await part.arrayBuffer());
      for (let i = 0; i < pcm.length; i += FRAME) {
        const mp3 = enc.encodeBuffer(pcm.subarray(i, i + FRAME));
        if (mp3.length) out.push(new Uint8Array(mp3)); // a copy: the encoder may reuse its buffer
        done += Math.min(FRAME, pcm.length - i);
        const now = performance.now();
        if (now - last > 100) {
          last = now;
          self.postMessage({ type: 'progress', frac: done / Math.max(1, total) });
        }
      }
    }
    const tail = enc.flush();
    if (tail.length) out.push(new Uint8Array(tail));
    self.postMessage({ type: 'done', blob: new Blob(out, { type: 'audio/mpeg' }) });
  } catch (e) {
    self.postMessage({ type: 'error', message: String((e && e.message) || e) });
  }
};
