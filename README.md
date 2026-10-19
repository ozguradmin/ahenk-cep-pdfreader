# Ahenk Okur

**English** · [Türkçe](README.tr.md)

A website that turns PDF, Word, EPUB and text documents into Turkish speech, **in the browser**. The voice is made by
the [Ahenk Cep](https://huggingface.co/ozgurguler/ahenk-cep-tr) model (8.6 M parameters, 48 kHz) on the visitor's own
device; neither the file nor its text is sent to any server.

**Site:** https://ozguradmin.github.io/ahenk-cep-pdfreader/

## What it does

1. **Document.** Upload a PDF, DOCX, ODT, EPUB, TXT, Markdown or HTML file, or a photo of a page (drag and drop, or
   pick one); pasting text works too.
   - In PDFs, lines, columns and paragraphs are rebuilt; words broken at the end of a line are joined; repeated
     headers, footers and page numbers are dropped; the ý/þ/ð of old fonts is mapped back to ı/ş/ğ.
   - Scanned PDFs, PDFs with a broken text layer, and images are read with Turkish OCR (Tesseract): two-column pages
     in reading order, without the letters it reads from pictures or the repeated headers and footers.
   - Long PDFs can be limited to a page range; password-protected PDFs ask for the password.
2. **Text.** The extracted text can be edited and copied. Choose the speaking rate (0.8×–1.4×) and the quality (4 / 8
   / 16 steps; the best, 16, by default); the page estimates the length of the audio and how long this device will
   take to make it.
3. **Audio.** The text is spoken sentence by sentence, with the percentage, the sentence count and the time left
   shown live. What is ready can be played right away; the sentence being read is highlighted, and tapping a
   sentence plays from there. Generation can be stopped and resumed. The audio is encoded to MP3 (64 kbit/s, ~29 MB
   an hour) as it is made, so the **MP3** downloads as soon as it is done; short audio (up to 30 minutes on a
   computer, 10 on a phone) is also offered as **WAV** (48 kHz, lossless). The files are tagged as AI-generated speech.
4. **Long documents, and picking up where you left off.** The audio is written piece by piece to the browser's storage
   on the device (IndexedDB): closing the tab, reloading or a browser crash loses nothing; "Kaydedilen
   dönüştürmeler" (saved conversions) continues where it stopped and remembers the listening position (the last 3
   conversions are kept). Since the audio lives on disk, a whole book can be converted in one go; the reader shows
   the text a page (~120 sentences) at a time, so a book-length text stays smooth. In browsers without storage the
   audio is kept in memory and very long documents are split into parts (~6 hours on a computer, ~2 on a phone).
   After OCR, the OCR engine and the PDF are released from memory. If a long document would take hours at the best
   quality, the page says how much "Dengeli" (balanced, 8 steps) would save, and that it sounds a little brighter.

The model starts loading as soon as the page opens (~17 MB on the first visit, from the cache afterwards), with its
progress shown in percent. On phones the screen stays on while audio is being made (Wake Lock), and the player can be
controlled from the lock screen (Media Session).

## How it works

| Part | Files |
|---|---|
| Page, steps, progress, downloads | `docs/index.html`, `docs/css/style.css`, `docs/js/app.js` |
| Reading documents (pdf.js, DOCX/ODT/EPUB XML, text encodings) | `docs/js/extract.js` |
| PDF layout, text cleanup, splitting into sentences (no DOM, tested in Node) | `docs/js/text.js` |
| OCR (tesseract.js, loaded only when needed) | `docs/js/ocr.js` |
| Model: download + sha256 + cache, threads, segment-by-segment synthesis, cancel | `docs/js/worker.js` |
| Ahenk Cep's sampling loop, backend choice, torch.randn | `docs/js/engine.js`, `backend.js`, `randn.js` |
| Text front-end (reading form: trnorm; EMA's alphabet, chunking and word boundaries): the JavaScript port ([trnorm-js](https://github.com/ozguradmin/trnorm-js)) by default, the Python (Pyodide) only as a fallback | `docs/js/front-native.js`, `docs/js/trnorm/`; fallback: `docs/js/front.js`, `docs/py/` |
| Exact parity tests against the Python (104,274 inputs, generated hostile inputs, Safari/Firefox/Chrome engines) | `tools/parity/` |
| Audio storage (MP3 pieces, PCM for short audio) and the player (listening while it is made, waveform, lock screen) | `docs/js/player.js` |
| Keeping jobs on the device (IndexedDB) and resuming | `docs/js/storage.js` |
| MP3 (lamejs, in its own worker while the audio is made), WAV and ID3 tags | `docs/js/mp3.js`, `docs/js/wav.js` |
| Cross-origin isolation on GitHub Pages (for multithreaded WebAssembly) | `docs/coi-serviceworker.js` |

The engine comes from the browser demo in [ahenk-turkish-tts](https://github.com/ozguradmin/ahenk-turkish-tts)
(`docs/js/engine.js` and others, Apache-2.0), where it was checked against PyTorch output. Added here: segment-by-segment
synthesis for long documents, cancel and resume, listening while the audio is made, document reading and OCR.

The model files are not in this repository: the page downloads them from the Hugging Face model repository (`onnx/`,
f16, sha256-checked) and keeps them in Cache Storage. The Ahenk Cep demo on the same origin (`ozguradmin.github.io`)
uses the same cache name, so a model downloaded by one is not downloaded again by the other. Neither site touches the
other's settings or service worker.

Libraries come from jsdelivr at pinned versions (`docs/js/config.js`): onnxruntime-web 1.30.0, Pyodide 0.27.7
(fallback only), pdf.js 5.7.284 (legacy build), fflate 0.8.2, lamejs 1.2.7, tesseract.js 7.0.0.

URL options: `?variant=fp32|f16|int8`, `?ep=wasm|webgpu`, `?front=js|py` (text front-end).

## Running it locally

```bash
python3 tools/serve.py --isolate     # http://127.0.0.1:8000/  (multithreaded)
python3 tools/serve.py               # as GitHub Pages serves it, without the headers
npm test                             # text processing tests (node --test)
```

## Publishing

The site is published from the `docs/` folder with GitHub Pages, with no build step and no GitHub Actions
(`docs/.nojekyll` serves the files as they are). One-time setup: **Settings → Pages → Build and deployment → Source:
Deploy from a branch → Branch: `main`, folder `/docs` → Save**. Every push then goes live by itself.

The same folder can also be put on Cloudflare Pages as it is (`wrangler pages deploy docs --project-name ahenk-okur`);
but some Turkish internet providers block `*.pages.dev` addresses, so the main address is GitHub Pages.

## License and credit

Code: Apache-2.0 (`LICENSE`); third-party parts and credits are in `NOTICE`. The voice model Ahenk Cep is CC BY 4.0:
"Ahenk Cep, Ahenk (https://github.com/ozguradmin/ahenk-turkish-tts), CC BY 4.0". It is not required, but if you use
this in your project we would be glad of a link back or a note (destek@ozgurguler.tech).

**This voice is synthetic.** Ahenk Cep's voice (f022) was designed from a text description; it is not a real person.
When you share audio made with it, say that it is AI-generated; do not use it to imitate or mislead anyone.
