// Inkwell Media — speech-to-text for captions, run in a worker so the page stays responsive.
// Uses Transformers.js (Apache-2.0, self-hosted) and an OpenAI Whisper model (MIT) downloaded once
// from Hugging Face and cached by the browser. The audio never leaves the device.
const LIB = '/inkwellmedia/vendor/transformers-3.8.1/';
let lib = null;
const pipes = new Map();

async function getPipe(model) {
  if (!lib) {
    lib = await import(LIB + 'transformers.min.js');
    lib.env.allowLocalModels = false;
    lib.env.useBrowserCache = true;
    lib.env.backends.onnx.wasm.wasmPaths = LIB;
    lib.env.backends.onnx.wasm.numThreads = 1;
  }
  if (!pipes.has(model)) {
    const files = new Map();
    pipes.set(model, lib.pipeline('automatic-speech-recognition', model, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          files.set(p.file, [p.loaded, p.total]);
          let loaded = 0, total = 0;
          for (const [l, t] of files.values()) { loaded += l; total += t; }
          postMessage({ type: 'download', loaded, total });
        }
      },
    }).catch((e) => { pipes.delete(model); throw e; }));
  }
  return pipes.get(model);
}

self.onmessage = async (e) => {
  const { audio, model, language } = e.data;
  try {
    const asr = await getPipe(model);
    postMessage({ type: 'transcribing' });
    const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
    if (language && !/\.en$/.test(model)) { opts.language = language; opts.task = 'transcribe'; }
    const out = await asr(audio, opts);
    postMessage({ type: 'done', text: out.text || '', chunks: (out.chunks || []).map((c) => ({ text: c.text, start: c.timestamp[0], end: c.timestamp[1] })) });
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
