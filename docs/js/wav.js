// Audio files. 16-bit mono PCM WAV, scaled like ema_lightning.audio.write_wav, with a RIFF INFO chunk that says the
// speech is synthetic (ISFT: software, ICMT: comment), so the label travels with the file; and the ID3 tag that does
// the same for the MP3 (js/mp3.js makes its frames).
// Based on ozguradmin/ahenk-turkish-tts site/js/wav.js (Apache-2.0). A long document's audio is kept as many Int16
// Blobs (one per sentence group); wavBlob() puts a header in front of them without copying the samples into JS.

function infoChunk(fields) {
  const enc = new TextEncoder();
  const parts = [];
  for (const [id, text] of Object.entries(fields)) {
    let bytes = enc.encode(text + '\0');
    if (bytes.length % 2) bytes = Uint8Array.from([...bytes, 0]);
    parts.push({ id, bytes });
  }
  const size = 4 + parts.reduce((n, p) => n + 8 + p.bytes.length, 0);
  const out = new Uint8Array(8 + size);
  const v = new DataView(out.buffer);
  out.set(enc.encode('LIST'), 0);
  v.setUint32(4, size, true);
  out.set(enc.encode('INFO'), 8);
  let o = 12;
  for (const p of parts) {
    out.set(enc.encode(p.id), o);
    v.setUint32(o + 4, p.bytes.length, true);
    out.set(p.bytes, o + 8);
    o += 8 + p.bytes.length;
  }
  return out;
}

// float32 [-1, 1] -> Int16, the same rounding as write_wav
export function toInt16(audio) {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]));
    out[i] = Math.round(s * 32767);
  }
  return out;
}

// The bytes before the samples: RIFF, fmt, LIST INFO, data header.
export function wavHeader(dataBytes, sampleRate, info = {}) {
  const list = Object.keys(info).length ? infoChunk(info) : new Uint8Array(0);
  const buf = new ArrayBuffer(44 + list.length);
  const v = new DataView(buf);
  const enc = new TextEncoder();
  const str = (o, s) => new Uint8Array(buf, o, s.length).set(enc.encode(s));
  str(0, 'RIFF');
  v.setUint32(4, 36 + list.length + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  new Uint8Array(buf, 36, list.length).set(list);
  const d = 36 + list.length;
  str(d, 'data');
  v.setUint32(d + 4, dataBytes, true);
  return new Uint8Array(buf);
}

// parts: Blobs (or typed arrays) of little-endian Int16 samples, in order.
export function wavBlob(parts, sampleRate, info = {}) {
  const dataBytes = parts.reduce((n, p) => n + (p.size ?? p.byteLength), 0);
  return new Blob([wavHeader(dataBytes, sampleRate, info), ...parts], { type: 'audio/wav' });
}

// ID3v2.3 tag for a download: title, artist, album and a comment that says the speech is synthetic.
export function id3(tags) {
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
  if (tags.track) frames.push(text('TRCK', tags.track));
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
  return new Blob([head, ...frames]);
}
