// MP3 as the speech is made, in a worker of its own (lamejs, LGPL-3.0, @breezystack/lamejs from jsdelivr): one
// encoder for the whole job, fed segment by segment, so the page keeps about 29 MB an hour instead of the 345 MB of
// 48 kHz PCM. Mono, the model's 48 kHz, 64 kbit/s CBR (exact seeking without a Xing header): plenty for speech.
// Every segment ends in a pause, so bytes the encoder still holds back before 'finish' are silence.
//
// In:  {type: 'start', sampleRate, kbps} {type: 'pcm', index, pcm (Int16Array)} {type: 'finish'}
// Out: {type: 'chunk', index, bytes (Uint8Array)} {type: 'finished', bytes} {type: 'error', message}

import { CDN } from './config.js';

let enc = null;
let ready = null;
let queue = Promise.resolve();
const FRAME = 1152 * 32;

async function start(sampleRate, kbps) {
  const { Mp3Encoder } = await import(CDN.lame);
  enc = new Mp3Encoder(1, sampleRate, kbps);
}

function encode(pcm) {
  const out = [];
  let n = 0;
  for (let i = 0; i < pcm.length; i += FRAME) {
    const mp3 = enc.encodeBuffer(pcm.subarray(i, i + FRAME));
    if (mp3.length) {
      out.push(new Uint8Array(mp3)); // a copy: the encoder may reuse its buffer
      n += mp3.length;
    }
  }
  const bytes = new Uint8Array(n);
  let o = 0;
  for (const c of out) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    if (data.type === 'start') {
      ready = start(data.sampleRate, data.kbps || 64);
      await ready;
    } else if (data.type === 'pcm') {
      await ready;
      const bytes = encode(data.pcm);
      self.postMessage({ type: 'chunk', index: data.index, bytes }, [bytes.buffer]);
    } else if (data.type === 'finish') {
      await ready;
      const tail = new Uint8Array(enc.flush());
      self.postMessage({ type: 'finished', bytes: tail }, [tail.buffer]);
    }
  }).catch((e) => self.postMessage({ type: 'error', message: String((e && e.message) || e) }));
};
