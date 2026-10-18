// Where the page gets its code and its model. Every third-party file has an exact version.
//
// The model comes from the Hugging Face model repo, as on https://ozguradmin.github.io/ahenk-turkish-tts/. Both pages
// live on the same origin (ozguradmin.github.io) and use the same Cache Storage name and keys, so a visitor who has
// opened one of them already has the model. URL switches: ?variant=fp32|f16|int8, ?ep=wasm|webgpu, ?models=<folder
// on this site> (local testing).

export const VERSIONS = {
  ort: '1.30.0',
  pyodide: '0.27.7',
  pdfjs: '5.7.284',
  fflate: '0.8.2',
  lame: '1.2.7',
  tesseract: '7.0.0',
};

const JSD = 'https://cdn.jsdelivr.net/npm/';

export const CDN = {
  ortDist: `${JSD}onnxruntime-web@${VERSIONS.ort}/dist/`,
  pyodide: `${JSD}pyodide@${VERSIONS.pyodide}/`,
  // The legacy build carries its own polyfills: the modern one needs very recent browsers.
  pdfjs: `${JSD}pdfjs-dist@${VERSIONS.pdfjs}/`,
  fflate: `${JSD}fflate@${VERSIONS.fflate}/esm/browser.js`,
  lame: `${JSD}@breezystack/lamejs@${VERSIONS.lame}/dist/lamejs.js`,
  tesseract: `${JSD}tesseract.js@${VERSIONS.tesseract}/dist/tesseract.esm.min.js`,
};

export const MODELS = {
  hf: 'https://huggingface.co/ozgurguler/ahenk-cep-tr/resolve/main/onnx/',
};

export const DEFAULT_VARIANT = 'f16';

// The text front-end: 'py' runs the Python (trnorm) in Pyodide; 'js' the JavaScript port in js/front-native.js,
// with the Python as its fallback. The port is switched on once tools/parity has proven it gives the same output.
// ?front=js|py overrides it for one visit.
export const FRONT = 'py';

export const LINKS = {
  github: 'https://github.com/ozguradmin/ahenk-cep-pdfreader',
  engine: 'https://github.com/ozguradmin/ahenk-turkish-tts',
  hfCep: 'https://huggingface.co/ozgurguler/ahenk-cep-tr',
  demo: 'https://ozguradmin.github.io/ahenk-turkish-tts/',
  ema: 'https://huggingface.co/canberkkkkkk/ema-lightning',
};

export function pageOptions(loc) {
  const q = new URLSearchParams(loc.search);
  const variant = ['fp32', 'f16', 'int8'].includes(q.get('variant')) ? q.get('variant') : DEFAULT_VARIANT;
  const ep = ['wasm', 'webgpu'].includes(q.get('ep')) ? q.get('ep') : 'auto';
  let modelBase = MODELS.hf;
  const m = q.get('models');
  if (m) {
    // only a folder on this same site (local testing), never another host
    try {
      const u = new URL(m.endsWith('/') ? m : `${m}/`, loc.href);
      if (u.origin === loc.origin) modelBase = u.href;
    } catch { /* keep the default */ }
  }
  const front = ['js', 'py'].includes(q.get('front')) ? q.get('front') : FRONT;
  return { variant, ep, modelBase, front };
}
