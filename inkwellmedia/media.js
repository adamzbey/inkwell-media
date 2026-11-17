import { DESTS as SHERPA_DESTS, planFor as sherpaPlanFor, mountMediaAsk } from './sherpa.js';
  // Fully self-hosted engine (same origin) — no esm.sh/unpkg, no cross-origin worker issues.
  const FFmpeg = (window.FFmpegWASM || {}).FFmpeg;
  const fetchFile = async (f) => new Uint8Array(await f.arrayBuffer());

  const CORE_BASE = '/inkwellmedia/ffmpeg';
  const $ = (id) => document.getElementById(id);
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(0) + ' KB' : (b/1048576).toFixed(1) + ' MB';
  const offlineCacheReady = 'serviceWorker' in navigator
    ? navigator.serviceWorker.register('/inkwellmedia/sw.js', { scope:'/' }).then(() => navigator.serviceWorker.ready).catch(() => null)
    : Promise.resolve(null);

  /* ---------- shared ffmpeg engine (downloads once, then cached on disk permanently) ---------- */
  // Store engine files in the browser's Cache Storage so they're fetched once EVER and
  // load from disk on every future visit. Falls back to a plain fetch if unavailable.
  async function cachedBlobURL(url, mime) {
    try {
      if ('caches' in window) {
        const cache = await caches.open('inkwell-media-engine-v1');
        let res = await cache.match(url);
        if (!res) {
          const net = await fetch(url);
          if (!net.ok) throw new Error('fetch ' + net.status);
          await cache.put(url, net.clone());
          res = net;
        }
        const buf = await res.arrayBuffer();
        return URL.createObjectURL(new Blob([buf], { type: mime }));
      }
    } catch (_) { /* fall through to a normal fetch */ }
    const buf = await (await fetch(url)).arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type: mime }));
  }

  let ffmpeg = null, ffmpegLoading = null;
  async function ensureFfmpeg(onFirstLoad) {
    if (ffmpeg) return ffmpeg;
    if (ffmpegLoading) return ffmpegLoading;
    if (onFirstLoad) onFirstLoad();
    ffmpegLoading = (async () => {
      const f = new FFmpeg();
      f.on('progress', ({ progress }) => setProgress(Math.round((progress||0)*100)));
      // Pass same-origin ABSOLUTE URLs (not blob: URLs). The site's CSP allows scripts from
      // 'self' but NOT blob:, so blob-based loading is blocked by the browser. Absolute
      // same-origin URLs satisfy 'self' and resolve correctly inside the worker's importScripts.
      const abs = (p) => new URL(p, location.href).href;
      await f.load({
        coreURL: abs(`${CORE_BASE}/ffmpeg-core.js`),
        wasmURL: abs(`${CORE_BASE}/ffmpeg-core.wasm`),
        // classWorkerURL omitted on purpose: the UMD build auto-loads its matched classic
        // worker (814.ffmpeg.js) from ./ffmpeg/ as a same-origin ('self') worker.
      });
      ffmpeg = f;
      return f;
    })();
    try { return await ffmpegLoading; }
    catch (e) { ffmpegLoading = null; throw e; }
  }
  async function runFfmpeg(file, args, outName, mime, preArgs = []) {
    const f = await ensureFfmpeg(() => { $('w-label').textContent='Loading the engine…'; $('w-note').textContent='Downloading the media engine for the first time (~30 MB). This only happens once.'; });
    $('w-label').textContent='Reading your file…';
    const ext = (file.name.split('.').pop()||'dat').toLowerCase().replace(/[^a-z0-9]/g,'') || 'dat';
    const inName = 'in.' + ext;
    await f.writeFile(inName, await fetchFile(file));
    $('w-label').textContent='Processing…';
    $('w-note').textContent='Working on your device. Larger or longer files take more time — the timer below shows it is still going.';
    // Never carry hidden tags (location, device, dates) into the output.
    const cleanArgs = args.includes('-map_metadata') ? args : ['-map_metadata', '-1', ...args];
    const code = await f.exec([...preArgs, '-i', inName, ...cleanArgs, outName]);
    const data = await f.readFile(outName);
    try { await f.deleteFile(inName); await f.deleteFile(outName); } catch(_) {}
    if (!(data && (data.length || data.byteLength))) throw new Error('empty-output');
    if (code && code !== 0 && !(data.length > 1024)) throw new Error('empty-output');
    return new Blob([data.buffer], { type: mime });
  }

  /* ---------- Canvas image engine ---------- */
  const isHeicFile = (file) => /\.(heic|heif)$/i.test(file.name || '') || /image\/hei[cf]/i.test(file.type || '');
  async function loadImage(file) {
    if (isHeicFile(file)) {
      try { if ('createImageBitmap' in window) return await createImageBitmap(file); } catch(_) {}
      const { heicTo } = await ensureHeic();
      return await heicTo({ blob:file, type:'bitmap' });
    }
    if ('createImageBitmap' in window) { try { return await createImageBitmap(file); } catch(_) {} }
    return await new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
      img.src = url;
    });
  }
  async function canvasProcess(file, { type, quality, maxW }) {
    const img = await loadImage(file);
    let w = img.width, h = img.height;
    if (maxW && w > maxW) { h = Math.round(h * (maxW / w)); w = maxW; }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    if (typeof img.close === 'function') img.close();
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    if (!blob) throw new Error('encode');
    return blob;
  }


  const imageOutput = (file) => {
    const alpha = /png|webp/i.test(file.type);
    return { type: alpha ? 'image/png' : 'image/jpeg', ext: alpha ? 'png' : 'jpg', quality: alpha ? undefined : 0.92 };
  };
  const canvasBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('encode')), type, quality);
  });

  let cropState = null;
  async function setupCropEditor(host, file) {
    const shapes = [['free','Free'],['1','Square 1:1'],['0.8','Portrait 4:5'],['1.7778','Wide 16:9'],['0.5625','Tall 9:16'],['1.3333','Photo 4:3']];
    host.innerHTML = `<div class="transform-controls crop-shapes" role="group" aria-label="Crop shape">${shapes.map(([v,n],i)=>`<button type="button" class="transform-btn" data-ratio="${v}" aria-pressed="${i===0}">${n}</button>`).join('')}</div><div class="crop-editor"><canvas id="crop-canvas" aria-label="Drag to choose the crop area"></canvas></div><p class="note-soft crop-help">Drag across the image to choose what to keep. You can redraw the selection as often as you like.</p><div class="crop-size" id="crop-size"></div>`;
    const image = await loadImage(file);
    const canvas = $('crop-canvas');
    const maxWidth = 560, maxHeight = 380;
    const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    cropState = {
      image, canvas,
      x: Math.round(canvas.width * .1), y: Math.round(canvas.height * .1),
      w: Math.round(canvas.width * .8), h: Math.round(canvas.height * .8),
      startX: 0, startY: 0, dragging: false, ratio: null
    };
    const point = (event) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
        y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height))
      };
    };
    const draw = () => {
      const { x, y, w, h } = cropState;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(20,16,25,.58)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const sourceX = x * image.width / canvas.width;
      const sourceY = y * image.height / canvas.height;
      const sourceW = w * image.width / canvas.width;
      const sourceH = h * image.height / canvas.height;
      ctx.drawImage(image, sourceX, sourceY, sourceW, sourceH, x, y, w, h);
      ctx.strokeStyle = '#cca24e'; ctx.lineWidth = 2; ctx.setLineDash([7,5]);
      ctx.strokeRect(x + 1, y + 1, Math.max(0,w - 2), Math.max(0,h - 2));
      ctx.setLineDash([]);
      $('crop-size').textContent = `${Math.max(1, Math.round(sourceW))} × ${Math.max(1, Math.round(sourceH))} px`;
    };
    canvas.addEventListener('pointerdown', (event) => {
      const p = point(event); cropState.startX = p.x; cropState.startY = p.y; cropState.dragging = true;
      cropState.x = p.x; cropState.y = p.y; cropState.w = 1; cropState.h = 1;
      canvas.setPointerCapture(event.pointerId); draw();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!cropState.dragging) return;
      const p = point(event);
      let dx = p.x - cropState.startX, dy = p.y - cropState.startY;
      if (cropState.ratio) {
        let w = Math.abs(dx), h = Math.abs(dy);
        if (w / cropState.ratio > h) h = w / cropState.ratio; else w = h * cropState.ratio;
        const maxW = dx >= 0 ? canvas.width - cropState.startX : cropState.startX;
        const maxH = dy >= 0 ? canvas.height - cropState.startY : cropState.startY;
        const k = Math.min(1, (maxW / w) || 1, (maxH / h) || 1); w *= k; h *= k;
        dx = dx >= 0 ? w : -w; dy = dy >= 0 ? h : -h;
      }
      cropState.x = Math.min(cropState.startX, cropState.startX + dx); cropState.y = Math.min(cropState.startY, cropState.startY + dy);
      cropState.w = Math.max(1, Math.abs(dx)); cropState.h = Math.max(1, Math.abs(dy));
      draw();
    });
    const finish = () => { if (cropState) cropState.dragging = false; };
    canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
    host.querySelectorAll('[data-ratio]').forEach((button) => button.addEventListener('click', () => {
      host.querySelectorAll('[data-ratio]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      const r = button.dataset.ratio === 'free' ? null : parseFloat(button.dataset.ratio);
      cropState.ratio = r;
      if (r) {
        let w = canvas.width * 0.9, h = w / r;
        if (h > canvas.height * 0.9) { h = canvas.height * 0.9; w = h * r; }
        cropState.w = w; cropState.h = h; cropState.x = (canvas.width - w) / 2; cropState.y = (canvas.height - h) / 2;
      }
      draw();
    }));
    draw();
  }

  async function cropImage(file) {
    if (!cropState || cropState.w < 2 || cropState.h < 2) throw new Error('crop-empty');
    const image = await loadImage(file);
    const sourceX = Math.round(cropState.x * image.width / cropState.canvas.width);
    const sourceY = Math.round(cropState.y * image.height / cropState.canvas.height);
    const sourceW = Math.max(1, Math.round(cropState.w * image.width / cropState.canvas.width));
    let sourceH = Math.max(1, Math.round(cropState.h * image.height / cropState.canvas.height));
    if (cropState.ratio) sourceH = Math.max(1, Math.min(image.height - sourceY, Math.round(sourceW / cropState.ratio)));
    const canvas = document.createElement('canvas'); canvas.width = sourceW; canvas.height = sourceH;
    canvas.getContext('2d').drawImage(image, sourceX, sourceY, sourceW, sourceH, 0, 0, sourceW, sourceH);
    if (typeof image.close === 'function') image.close();
    const output = imageOutput(file);
    return { blob: await canvasBlob(canvas, output.type, output.quality), ...output };
  }

  async function rotateImage(file) {
    const image = await loadImage(file);
    const angle = parseInt($('rotate-angle').value || '90', 10);
    const radians = angle * Math.PI / 180;
    const swap = Math.abs(angle) % 180 === 90;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? image.height : image.width; canvas.height = swap ? image.width : image.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(radians);
    ctx.scale($('flip-h').checked ? -1 : 1, $('flip-v').checked ? -1 : 1);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    if (typeof image.close === 'function') image.close();
    const output = imageOutput(file);
    return { blob: await canvasBlob(canvas, output.type, output.quality), ...output };
  }

  function setupRotateControls(host) {
    host.innerHTML = `<div class="transform-controls">
      <button class="transform-btn" type="button" data-turn="-90">Rotate left 90°</button>
      <button class="transform-btn" type="button" data-turn="90">Rotate right 90°</button>
      <button class="transform-btn" type="button" data-flip="flip-h" aria-pressed="false">Flip horizontal</button>
      <button class="transform-btn" type="button" data-flip="flip-v" aria-pressed="false">Flip vertical</button>
    </div>
    <input type="hidden" id="rotate-angle" value="0" />
    <input type="checkbox" id="flip-h" class="hidden" />
    <input type="checkbox" id="flip-v" class="hidden" />
    <p class="transform-summary" id="transform-summary">No rotation or flips applied</p>`;
    const updateSummary = () => {
      const angle = parseInt($('rotate-angle').value, 10) || 0;
      const changes = [];
      if (angle) changes.push(`${angle}° clockwise`);
      if ($('flip-h').checked) changes.push('flipped horizontally');
      if ($('flip-v').checked) changes.push('flipped vertically');
      $('transform-summary').textContent = changes.length ? changes.join(' · ') : 'No rotation or flips applied';
    };
    host.querySelectorAll('[data-turn]').forEach((button) => button.addEventListener('click', () => {
      const angle = parseInt($('rotate-angle').value, 10) || 0;
      $('rotate-angle').value = String((angle + parseInt(button.dataset.turn, 10) + 360) % 360);
      updateSummary();
    }));
    host.querySelectorAll('[data-flip]').forEach((button) => button.addEventListener('click', () => {
      const input = $(button.dataset.flip);
      input.checked = !input.checked;
      button.setAttribute('aria-pressed', String(input.checked));
      updateSummary();
    }));
  }

  const watermarkPosition = (position, canvasW, canvasH, markW, markH, pad) => {
    const x = position.includes('left') ? pad : position.includes('right') ? canvasW - markW - pad : (canvasW - markW) / 2;
    const y = position.includes('top') ? pad : position.includes('bottom') ? canvasH - markH - pad : (canvasH - markH) / 2;
    return { x, y };
  };
  async function watermarkImage(file) {
    const image = await loadImage(file);
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const opacity = Math.max(.05, Math.min(1, parseInt($('wm-opacity').value || '65', 10) / 100));
    const scale = Math.max(.05, Math.min(.6, parseInt($('wm-size').value || '18', 10) / 100));
    const position = $('wm-position').value || 'bottom-right';
    const pad = Math.max(12, Math.round(Math.min(image.width, image.height) * .035));
    const logoFile = $('wm-image').files[0];
    ctx.globalAlpha = opacity;
    if (logoFile) {
      const logo = await loadImage(logoFile);
      const markW = Math.max(1, Math.round(image.width * scale));
      const markH = Math.max(1, Math.round(logo.height * markW / logo.width));
      const pos = watermarkPosition(position, image.width, image.height, markW, markH, pad);
      ctx.drawImage(logo, pos.x, pos.y, markW, markH);
      if (typeof logo.close === 'function') logo.close();
    } else {
      const text = $('wm-text').value.trim();
      if (!text) throw new Error('watermark-empty');
      const fontSize = Math.max(14, Math.round(image.width * scale * .42));
      ctx.font = `600 ${fontSize}px Fraunces, Georgia, serif`; ctx.textBaseline = 'top';
      const metrics = ctx.measureText(text); const markW = metrics.width; const markH = fontSize * 1.18;
      const pos = watermarkPosition(position, image.width, image.height, markW, markH, pad);
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fontSize * .08); ctx.strokeStyle = 'rgba(20,16,25,.72)';
      ctx.fillStyle = $('wm-color').value || '#ffffff'; ctx.strokeText(text, pos.x, pos.y); ctx.fillText(text, pos.x, pos.y);
    }
    ctx.globalAlpha = 1;
    if (typeof image.close === 'function') image.close();
    const output = imageOutput(file);
    return { blob: await canvasBlob(canvas, output.type, output.quality), ...output };
  }

  let backgroundRemovalModule = null;
  async function ensureBackgroundRemoval() {
    await offlineCacheReady;
    if (!backgroundRemovalModule) backgroundRemovalModule = import('https://esm.sh/@imgly/background-removal@1.7.0?bundle');
    return backgroundRemovalModule;
  }
  async function removeImageBackground(file) {
    $('w-label').textContent = 'Loading the background model…';
    $('w-note').textContent = 'One-time model download on first use; after it is cached, this tool runs offline.';
    const module = await ensureBackgroundRemoval();
    const removeBackground = module.default || module.removeBackground;
    const blob = await removeBackground(file, {
      model: 'isnet_quint8',
      output: { format: 'image/png', quality: 1 },
      progress: (key, currentBytes, totalBytes) => {
        const percent = totalBytes ? Math.round(currentBytes / totalBytes * 100) : 0;
        const isCompute = key.startsWith('compute:');
        $('w-label').textContent = isCompute ? 'Removing the background…' : 'Downloading the model…';
        $('w-note').textContent = isCompute ? 'The model is working entirely on your device.' : `${key.split('/').pop()} · ${fmtSize(currentBytes)} of ${fmtSize(totalBytes)}`;
        setProgress(percent);
      }
    });
    return blob;
  }

  let zipLibrary = null;
  async function createZip(entries) {
    await offlineCacheReady;
    if (!zipLibrary) zipLibrary = import('/inkwellmedia/vendor/fflate-0.8.2.js').catch((e) => { zipLibrary = null; throw e; });
    const { zipSync } = await zipLibrary;
    const files = {};
    for (const entry of entries) {
      let name = entry.name, copy = 2;
      while (files[name]) {
        const dot = entry.name.lastIndexOf('.');
        name = dot > 0 ? `${entry.name.slice(0,dot)}-${copy}${entry.name.slice(dot)}` : `${entry.name}-${copy}`;
        copy += 1;
      }
      files[name] = new Uint8Array(await entry.blob.arrayBuffer());
    }
    return new Blob([zipSync(files, { level:6 })], { type:'application/zip' });
  }


  /* ---------- HEIC decoder (lazy, self-hosted: heic-to 1.6.7 / libheif, LGPL-3.0) ---------- */
  let heicLib = null;
  function ensureHeic() {
    if (!heicLib) heicLib = import('/inkwellmedia/vendor/heic-to-1.6.7.js').catch(() => { heicLib = null; throw new Error('heic-load'); });
    return heicLib;
  }

  /* ---------- reading what a file gives away (EXIF / video location) ---------- */
  const fmtCoord = (v) => (Math.round(v * 100) / 100).toFixed(2);
  const indexOfBytes = (b, pat, from = 0, to = b.length) => {
    outer: for (let i = from; i <= to - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  };
  function parseTiff(b, t) {
    const meta = {};
    if (t < 0 || t + 8 > b.length) return meta;
    const le = b[t] === 0x49 && b[t + 1] === 0x49;
    const be = b[t] === 0x4d && b[t + 1] === 0x4d;
    if (!le && !be) return meta;
    const ok = (o, n) => t + o >= 0 && t + o + n <= b.length;
    const u16 = (o) => ok(o, 2) ? (le ? b[t+o] | (b[t+o+1] << 8) : (b[t+o] << 8) | b[t+o+1]) : 0;
    const u32 = (o) => ok(o, 4) ? (le ? (b[t+o] | (b[t+o+1] << 8) | (b[t+o+2] << 16)) + b[t+o+3] * 16777216
                                       : b[t+o] * 16777216 + ((b[t+o+1] << 16) | (b[t+o+2] << 8) | b[t+o+3])) : 0;
    const SIZES = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 10:8 };
    const readIFD = (off) => {
      const tags = {};
      if (!ok(off, 2)) return tags;
      const n = Math.min(u16(off), 400);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (!ok(e, 12)) break;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const size = (SIZES[type] || 1) * count;
        tags[tag] = { type, count, vo: size <= 4 ? e + 8 : u32(e + 8) };
      }
      return tags;
    };
    const str = (tg) => { if (!tg) return ''; let out = ''; for (let i = 0; i < Math.min(tg.count, 120); i++) { if (!ok(tg.vo + i, 1)) break; const c = b[t + tg.vo + i]; if (!c) break; out += String.fromCharCode(c); } return out.trim(); };
    const rat = (o) => { const d = u32(o + 4); return d ? u32(o) / d : 0; };
    const dms = (tg) => (tg && tg.count >= 3) ? rat(tg.vo) + rat(tg.vo + 8) / 60 + rat(tg.vo + 16) / 3600 : 0;
    const ifd0 = readIFD(u32(4));
    meta.make = str(ifd0[0x010f]); meta.model = str(ifd0[0x0110]); meta.software = str(ifd0[0x0131]);
    if (ifd0[0x8769]) { const ex = readIFD(u32(ifd0[0x8769].vo)); meta.date = str(ex[0x9003]) || str(ifd0[0x0132]); }
    else meta.date = str(ifd0[0x0132]);
    if (ifd0[0x8825]) {
      const g = readIFD(u32(ifd0[0x8825].vo));
      let lat = dms(g[2]), lon = dms(g[4]);
      if (str(g[1]).toUpperCase() === 'S') lat = -lat;
      if (str(g[3]).toUpperCase() === 'W') lon = -lon;
      if ((lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) meta.gps = { lat, lon };
    }
    meta.hasExif = true;
    return meta;
  }
  function findTiff(b) {
    const EXIF = [0x45,0x78,0x69,0x66,0,0];
    let i = indexOfBytes(b, EXIF);
    while (i >= 0) {
      const t = i + 6;
      if ((b[t] === 0x49 && b[t+1] === 0x49 && b[t+2] === 0x2a) || (b[t] === 0x4d && b[t+1] === 0x4d && b[t+3] === 0x2a)) return t;
      i = indexOfBytes(b, EXIF, i + 1);
    }
    const png = indexOfBytes(b, [0x65,0x58,0x49,0x66]); // PNG "eXIf" chunk holds a bare TIFF block
    if (png >= 0) return png + 4;
    const webp = indexOfBytes(b, [0x45,0x58,0x49,0x46]); // WebP "EXIF" chunk
    if (webp >= 0 && b[webp + 8] !== 0x45) return webp + 8;
    return -1;
  }
  function sniffFormat(b, file) {
    const ascii = (o, n) => String.fromCharCode(...b.slice(o, o + n));
    if (b[0] === 0xff && b[1] === 0xd8) return 'JPG';
    if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'PNG';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'WebP';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') return 'AVI';
    if (ascii(0, 3) === 'GIF') return 'GIF';
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return /webm/i.test(file.type) || /\.webm$/i.test(file.name) ? 'WebM' : 'MKV';
    if (ascii(4, 4) === 'ftyp') {
      const brand = ascii(8, 4);
      if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return 'HEIC';
      if (/^avi[fs]$/.test(brand)) return 'AVIF';
      if (brand === 'qt  ') return 'MOV';
      return 'MP4';
    }
    const ext = (file.name.split('.').pop() || '').toUpperCase();
    return ext || 'Unknown';
  }
  async function headTail(file, chunk) {
    if (file.size <= chunk * 2) return [new Uint8Array(await file.arrayBuffer())];
    return [new Uint8Array(await file.slice(0, chunk).arrayBuffer()), new Uint8Array(await file.slice(file.size - chunk).arrayBuffer())];
  }
  async function readImageMeta(file) {
    const parts = await headTail(file, 8 * 1048576);
    const format = sniffFormat(parts[0], file);
    let meta = {};
    for (const part of parts) { const t = findTiff(part); if (t >= 0) { meta = parseTiff(part, t); if (meta.hasExif) break; } }
    return { format, ...meta };
  }
  const ISO6709 = /([+-]\d{1,2}\.\d{2,8})([+-]\d{1,3}\.\d{2,8})(?:[+-][\d.]+)?(?:CRS[^/]*)?\//;
  function mvhdDuration(b) {
    const i = indexOfBytes(b, [0x6d,0x76,0x68,0x64]);
    if (i < 0 || i + 32 > b.length) return 0;
    const v = b[i + 4], u32 = (o) => b[o] * 16777216 + ((b[o+1] << 16) | (b[o+2] << 8) | b[o+3]);
    if (v === 1) { const scale = u32(i + 24); return scale ? (u32(i + 28) * 4294967296 + u32(i + 32)) / scale : 0; }
    const scale = u32(i + 16); return scale ? u32(i + 20) / scale : 0;
  }
  function probeElement(file, kind) {
    return new Promise((resolve) => {
      const el = document.createElement(kind); const url = URL.createObjectURL(file);
      let done = false;
      const finish = (r) => { if (done) return; done = true; clearTimeout(timer); el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); resolve(r); };
      const timer = setTimeout(() => finish({ playable:false, timedOut:true }), 6000);
      el.preload = 'metadata'; el.muted = true;
      el.onloadedmetadata = () => finish({ playable: kind === 'audio' || el.videoWidth > 0, duration: isFinite(el.duration) ? el.duration : 0, width: el.videoWidth || 0, height: el.videoHeight || 0 });
      el.onerror = () => finish({ playable:false });
      el.src = url;
    });
  }
  async function readVideoMeta(file) {
    const parts = await headTail(file, 8 * 1048576);
    const format = sniffFormat(parts[0], file);
    let codec = '', location = null, duration = 0;
    const has = (pat) => parts.some((p) => indexOfBytes(p, pat) >= 0);
    if (has([0x68,0x76,0x63,0x31]) || has([0x68,0x65,0x76,0x31])) codec = 'HEVC';
    else if (has([0x61,0x76,0x30,0x31])) codec = 'AV1';
    else if (has([0x61,0x76,0x63,0x31])) codec = 'H.264';
    else if (has([0x76,0x70,0x30,0x39])) codec = 'VP9';
    for (const p of parts) {
      if (!duration) duration = mvhdDuration(p);
      if (!location) {
        let text = ''; for (let i = 0; i < p.length; i += 65536) text += String.fromCharCode.apply(null, p.subarray(i, Math.min(p.length, i + 65536)));
        const m = text.match(ISO6709);
        if (m) location = { lat: parseFloat(m[1]), lon: parseFloat(m[2]) };
      }
    }
    const probe = await probeElement(file, 'video');
    return { format, codec, location, duration: probe.duration || duration, width: probe.width, height: probe.height, playable: probe.playable };
  }
  async function videoDuration(file) {
    const probe = await probeElement(file, 'video');
    if (probe.duration) return probe.duration;
    const parts = await headTail(file, 8 * 1048576);
    for (const p of parts) { const d = mvhdDuration(p); if (d) return d; }
    return 0;
  }
  function describeRemoved(meta) {
    const bits = [];
    if (meta.gps || meta.location) bits.push('GPS location');
    const cam = [meta.make, meta.model].filter(Boolean).join(' ').replace(/^(\w+) \1 /i, '$1 ');
    if (cam) bits.push(`camera (${cam})`);
    if (meta.date) bits.push('date taken');
    if (meta.software) bits.push('software');
    return bits;
  }

  /* ---------- encoding helpers ---------- */
  async function encodeCanvas(canvas, type, quality, maxBytes) {
    let blob = await canvasBlob(canvas, type, quality);
    if (maxBytes && type !== 'image/png') {
      let q = quality || 0.92;
      while (blob.size > maxBytes && q > 0.45) { q -= 0.07; blob = await canvasBlob(canvas, type, q); }
    }
    return blob;
  }
  const extFor = (type) => ({ 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' }[type] || 'jpg');
  const sameTypeOutput = (file) => {
    if (/png/i.test(file.type) || /\.png$/i.test(file.name)) return { type:'image/png', quality:undefined };
    if (/webp/i.test(file.type) || /\.webp$/i.test(file.name)) return { type:'image/webp', quality:0.95 };
    return { type:'image/jpeg', quality:0.95 };
  };
  function drawToCanvas(img, w, h, { fit = 'stretch', bg = null } = {}) {
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
    if (fit === 'stretch') ctx.drawImage(img, 0, 0, c.width, c.height);
    else {
      const scale = fit === 'fill' ? Math.max(c.width / img.width, c.height / img.height) : Math.min(c.width / img.width, c.height / img.height);
      const dw = img.width * scale, dh = img.height * scale;
      ctx.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    }
    return c;
  }

  /* ---------- sizes for popular sites (checked Nov 2026) ---------- */
  const RESIZE_PRESETS = [
    { id:'ig-portrait', g:'Instagram', n:'Instagram post — portrait 4:5', w:1080, h:1350, tip:'Instagram’s tallest feed post, which takes up the most room in the feed.' },
    { id:'ig-square', g:'Instagram', n:'Instagram post — square', w:1080, h:1080 },
    { id:'ig-landscape', g:'Instagram', n:'Instagram post — landscape', w:1080, h:566 },
    { id:'ig-story', g:'Instagram', n:'Instagram story or reel cover', w:1080, h:1920, tip:'Full-screen 9:16. Keep text away from the top and bottom edges.' },
    { id:'li-post', g:'LinkedIn', n:'LinkedIn post or link image', w:1200, h:627 },
    { id:'li-square', g:'LinkedIn', n:'LinkedIn post — square', w:1200, h:1200 },
    { id:'li-banner', g:'LinkedIn', n:'LinkedIn profile banner', w:1584, h:396, tip:'Your profile photo covers part of the left side, so keep important details centred or to the right.' },
    { id:'li-photo', g:'LinkedIn', n:'LinkedIn profile photo', w:400, h:400 },
    { id:'yt-thumb', g:'YouTube', n:'YouTube thumbnail', w:1280, h:720, maxBytes:2000000, tip:'We keep the file under 2 MB, YouTube’s limit for thumbnails uploaded from a phone.' },
    { id:'etsy-square', g:'Etsy', n:'Etsy listing photo — square', w:2000, h:2000, tip:'Etsy recommends listing photos at least 2000 px on each side.' },
    { id:'etsy-43', g:'Etsy', n:'Etsy listing photo — 4:3 landscape', w:2667, h:2000, tip:'Etsy suggests a landscape or square first photo; 4:3 is the usual landscape shape.' },
    { id:'shopify', g:'Shopify', n:'Shopify product image', w:2048, h:2048, tip:'Shopify’s recommended size for square product images.' },
    { id:'email', g:'Email & web', n:'Email or web — longest side 1600 px', long:1600, tip:'Small enough to email or post quickly, still sharp on most screens.' },
  ];
  const presetById = (id) => RESIZE_PRESETS.find((p) => p.id === id);

  /* ---------- clip picker for trim and GIF ---------- */
  let clipUrl = null;
  function setupClipPicker(host, file, { defaultLength = 0, extraHtml = '' } = {}) {
    if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null; }
    host.innerHTML = `<div class="clip"><video id="clip-video" class="clip-video" controls playsinline preload="metadata"></video><p class="note-soft clip-note" id="clip-note">Play or drag to the moment you want, then tap “Start here” or “End here”.</p></div>
      <div class="field"><label>Start and end (seconds)</label><div class="row">
        <div><input type="number" id="t-start" value="0" min="0" step="0.1" aria-label="Start time in seconds"/><button type="button" class="transform-btn clip-set" id="set-start">Start here</button></div>
        <div><input type="number" id="t-end" value="${defaultLength || 10}" min="0" step="0.1" aria-label="End time in seconds"/><button type="button" class="transform-btn clip-set" id="set-end">End here</button></div>
      </div><p class="transform-summary" id="clip-len"></p></div>${extraHtml}`;
    const video = $('clip-video'), start = $('t-start'), end = $('t-end');
    const update = () => {
      const s = parseFloat(start.value) || 0, e = parseFloat(end.value) || 0;
      $('clip-len').textContent = e > s ? `Keeping ${(e - s).toFixed(1)} seconds (${s.toFixed(1)}s → ${e.toFixed(1)}s)` : 'The end needs to be after the start';
    };
    clipUrl = URL.createObjectURL(file);
    video.addEventListener('loadedmetadata', () => {
      const d = isFinite(video.duration) ? video.duration : 0;
      if (d) {
        start.max = end.max = d.toFixed(1); host.dataset.duration = String(d);
        end.value = (defaultLength ? Math.min(defaultLength, d) : d).toFixed(1);
      }
      update();
    });
    video.addEventListener('error', () => {
      video.classList.add('hidden');
      $('clip-note').textContent = 'Your browser can’t preview this video format, but this still works. Type the start and end times in seconds.';
    });
    video.src = clipUrl;
    $('set-start').addEventListener('click', () => { start.value = video.currentTime.toFixed(1); update(); });
    $('set-end').addEventListener('click', () => { end.value = video.currentTime.toFixed(1); update(); });
    start.addEventListener('input', update); end.addEventListener('input', update);
    update();
  }
  function readClip(host) {
    const duration = parseFloat(host.dataset.duration || '0');
    let s = Math.max(0, parseFloat($('t-start').value || '0'));
    let e = parseFloat($('t-end').value || '0');
    if (duration) { s = Math.min(s, duration); e = Math.min(e, duration); }
    if (!(e > s + 0.05)) throw new Error('clip-range');
    return { s, e, len: e - s };
  }

  /* ---------- hand files to the next tool (kept on this device, in IndexedDB) ---------- */
  const HANDOFF_DB = 'inkwell-media', HANDOFF_STORE = 'handoff';
  function handoffDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(HANDOFF_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(HANDOFF_STORE);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }
  async function putHandoff(files) {
    const db = await handoffDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(HANDOFF_STORE, 'readwrite');
      tx.objectStore(HANDOFF_STORE).put({ at: Date.now(), files: files.map((f) => ({ name: f.name, type: f.type, blob: f.blob || f })) }, 'files');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }
  async function takeHandoff() {
    try {
      const db = await handoffDb();
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction(HANDOFF_STORE, 'readwrite'); const store = tx.objectStore(HANDOFF_STORE);
        const get = store.get('files'); get.onsuccess = () => { store.delete('files'); resolve(get.result); }; get.onerror = () => reject(get.error);
      });
      db.close();
      if (!record || Date.now() - record.at > 15 * 60 * 1000) return [];
      return record.files.map((f) => new File([f.blob], f.name, { type: f.type || f.blob.type }));
    } catch (_) { return []; }
  }

  const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const isVideoFile = (file) => /^video\//.test(file.type || '') || /\.(mov|mp4|m4v|webm|mkv|avi)$/i.test(file.name || '');
  function sameVideoContainer(file) {
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase();
    const outExt = /^(mov|mp4|m4v|webm|mkv)$/.test(ext) ? ext : 'mp4';
    const mime = outExt === 'mov' ? 'video/quicktime' : outExt === 'webm' ? 'video/webm' : outExt === 'mkv' ? 'video/x-matroska' : 'video/mp4';
    return { outExt, mime };
  }
  // Re-encode to H.264 at a bitrate worked out from the clip length so the file lands under limitBytes.
  async function fitVideoUnder(file, limitBytes, extraArgs) {
    const duration = await videoDuration(file);
    if (!duration) throw new Error('no-duration');
    const audio = 96000;
    let videoBits = Math.floor(limitBytes * 8 * 0.9 / duration) - audio;
    if (videoBits < 120000) throw new Error('too-long:' + Math.floor(limitBytes * 8 * 0.9 / (audio + 120000)));
    let blob = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const width = videoBits < 500000 ? 640 : videoBits < 1000000 ? 854 : videoBits < 2500000 ? 1280 : 1920;
      const kb = Math.floor(videoBits / 1000);
      blob = await runFfmpeg(file, [...extraArgs, '-vf', `scale='min(${width},iw)':-2`, '-c:v','libx264','-preset','veryfast','-b:v',kb+'k','-maxrate',Math.floor(kb*1.25)+'k','-bufsize',(kb*2)+'k','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-movflags','+faststart'], 'out.mp4', 'video/mp4');
      if (blob.size <= limitBytes) return blob;
      videoBits = Math.floor(videoBits * 0.85 * limitBytes / blob.size);
    }
    return blob;
  }
  /* ======================= round 2 helpers ======================= */

  /* ---------- face finder (face-api 1.7.15, MIT, self-hosted; tfjs Apache-2.0) ---------- */
  const FACE_BASE = '/inkwellmedia/vendor/face-api-1.7.15/';
  let faceLib = null;
  function ensureFaceApi() {
    if (!faceLib) faceLib = (async () => {
      await offlineCacheReady;
      const faceapi = await import(FACE_BASE + 'face-api.esm.js');
      try { await faceapi.tf.setBackend('webgl'); await faceapi.tf.ready(); }
      catch (_) { await faceapi.tf.setBackend('cpu'); await faceapi.tf.ready(); }
      await faceapi.nets.ssdMobilenetv1.loadFromUri(FACE_BASE);
      return faceapi;
    })().catch((e) => { faceLib = null; throw new Error('face-load: ' + (e && e.message || e)); });
    return faceLib;
  }
  // Returns boxes in the image's own pixels. Works on a downscaled copy for speed.
  async function findFaces(img, minConfidence = 0.35) {
    const faceapi = await ensureFaceApi();
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const found = await faceapi.detectAllFaces(c, new faceapi.SsdMobilenetv1Options({ minConfidence, maxResults: 100 }));
    return found.map((d) => { const b = d.box; return { x: b.x / scale, y: b.y / scale, w: b.width / scale, h: b.height / scale, auto: true, score: d.score }; });
  }

  /* ---------- blur / pixelate / block out areas ---------- */
  function redact(ctx, source, boxes, style, strength, k = 1) {
    // k = output pixels per source pixel (1 for the final image, <1 for the preview)
    for (const b0 of boxes) {
      const pad = b0.auto ? 0.18 : 0;
      const b = { x: (b0.x - b0.w * pad) * k, y: (b0.y - b0.h * pad * 1.2) * k, w: b0.w * (1 + pad * 2) * k, h: b0.h * (1 + pad * 2.2) * k };
      const x = Math.max(0, Math.floor(b.x)), y = Math.max(0, Math.floor(b.y));
      const w = Math.min(ctx.canvas.width - x, Math.ceil(b.w + (b.x - x))), h = Math.min(ctx.canvas.height - y, Math.ceil(b.h + (b.y - y)));
      if (w < 2 || h < 2) continue;
      ctx.save();
      ctx.beginPath();
      if (b0.auto) ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); else ctx.rect(x, y, w, h);
      ctx.clip();
      if (style === 'block') { ctx.fillStyle = '#111'; ctx.fillRect(x, y, w, h); }
      else if (style === 'pixel') {
        const cells = Math.max(3, Math.round(14 - strength)); // strength 1..10 → 13..4 cells across
        const t = document.createElement('canvas'); t.width = cells; t.height = Math.max(2, Math.round(cells * h / w));
        const tc = t.getContext('2d'); tc.drawImage(ctx.canvas, x, y, w, h, 0, 0, t.width, t.height);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(t, 0, 0, t.width, t.height, x, y, w, h); ctx.imageSmoothingEnabled = true;
      } else {
        const r = Math.max(4, Math.round(Math.max(w, h) * (0.04 + strength * 0.016)));
        const m = r * 2; // draw a wider patch so the blur has real pixels at its edges
        const sx = Math.max(0, x - m), sy = Math.max(0, y - m), sw = Math.min(ctx.canvas.width - sx, w + m * 2), sh = Math.min(ctx.canvas.height - sy, h + m * 2);
        const t = document.createElement('canvas'); t.width = sw; t.height = sh;
        const tc = t.getContext('2d'); tc.filter = `blur(${r}px)`; tc.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
        tc.filter = `blur(${r}px)`; tc.drawImage(t, 0, 0); // second pass: much harder to undo
        ctx.drawImage(t, sx, sy);
      }
      ctx.restore();
    }
  }

  let blurState = null;
  async function setupBlurEditor(host, file) {
    host.innerHTML = `<p class="note-soft blur-status" id="blur-status" style="text-align:left">Looking for faces…</p>
      <div class="crop-editor"><canvas id="blur-canvas" aria-label="Photo preview. Drag to add an area to cover; tap a box to remove it."></canvas></div>
      <p class="note-soft crop-help">Drag across anything else you want hidden, like a license plate, a house number or a name tag. Tap a box to remove it.</p>
      <div class="transform-controls" role="group" aria-label="How to hide">
        <button type="button" class="transform-btn" data-style="blur" aria-pressed="true">Blur</button>
        <button type="button" class="transform-btn" data-style="pixel" aria-pressed="false">Pixelate</button>
        <button type="button" class="transform-btn" data-style="block" aria-pressed="false">Solid block</button>
        <button type="button" class="transform-btn" id="blur-clear">Clear all boxes</button>
      </div>
      <div class="field" id="blur-strength-field"><label for="blur-strength">Strength <span id="blur-strength-value">7</span></label><input type="range" id="blur-strength" min="1" max="10" value="7" /></div>`;
    const image = await loadImage(file);
    const canvas = $('blur-canvas');
    const scale = Math.min(1, 560 / image.width, 420 / image.height);
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
    blurState = { image, canvas, scale, boxes: [], style: 'blur', strength: 7, drag: null };
    const draw = () => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      redact(ctx, image, blurState.boxes, blurState.style, blurState.strength, scale);
      ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeStyle = '#cca24e';
      for (const b of blurState.boxes) ctx.strokeRect(b.x * scale, b.y * scale, b.w * scale, b.h * scale);
      if (blurState.drag && blurState.drag.w) { ctx.strokeStyle = '#ffffff'; const d = blurState.drag; ctx.strokeRect(d.x, d.y, d.w, d.h); }
      ctx.setLineDash([]);
      const n = blurState.boxes.length;
      $('go').disabled = !n;
    };
    const status = (t) => { $('blur-status').textContent = t; };
    const point = (ev) => { const r = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width, (ev.clientX - r.left) * canvas.width / r.width)), y: Math.max(0, Math.min(canvas.height, (ev.clientY - r.top) * canvas.height / r.height)) }; };
    canvas.addEventListener('pointerdown', (ev) => { const p = point(ev); blurState.drag = { sx: p.x, sy: p.y, x: p.x, y: p.y, w: 0, h: 0 }; canvas.setPointerCapture(ev.pointerId); });
    canvas.addEventListener('pointermove', (ev) => {
      const d = blurState.drag; if (!d) return; const p = point(ev);
      d.x = Math.min(d.sx, p.x); d.y = Math.min(d.sy, p.y); d.w = Math.abs(p.x - d.sx); d.h = Math.abs(p.y - d.sy); draw();
    });
    const end = (ev) => {
      const d = blurState.drag; blurState.drag = null; if (!d) return;
      if (d.w < 6 && d.h < 6) {
        // a tap: remove the box under it
        const x = d.sx / scale, y = d.sy / scale;
        const i = blurState.boxes.findIndex((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
        if (i >= 0) blurState.boxes.splice(i, 1);
      } else blurState.boxes.push({ x: d.x / scale, y: d.y / scale, w: d.w / scale, h: d.h / scale, auto: false });
      status(blurState.boxes.length ? `${blurState.boxes.length} area${blurState.boxes.length === 1 ? '' : 's'} will be hidden.` : 'Nothing marked yet. Drag across what you want hidden.');
      draw();
    };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', () => { blurState.drag = null; draw(); });
    host.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => {
      host.querySelectorAll('[data-style]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      blurState.style = b.dataset.style; $('blur-strength-field').classList.toggle('hidden', b.dataset.style === 'block'); draw();
    }));
    $('blur-strength').addEventListener('input', () => { blurState.strength = +$('blur-strength').value; $('blur-strength-value').textContent = $('blur-strength').value; draw(); });
    $('blur-clear').addEventListener('click', () => { blurState.boxes = []; status('Cleared. Drag across what you want hidden.'); draw(); });
    draw();
    try {
      const faces = await findFaces(image);
      if (blurState && blurState.image === image) {
        blurState.boxes.push(...faces);
        status(faces.length ? `Found ${faces.length} face${faces.length === 1 ? '' : 's'}. Check none were missed, especially small or turned-away ones.` : 'No faces found. Drag across anything you want hidden.');
        draw();
      }
    } catch (e) {
      console.error(e);
      status('Couldn’t load the face finder, so mark areas by hand: drag across each face or plate.');
    }
    setTimeout(() => { $('go').disabled = !blurState.boxes.length; }, 0);
  }
  async function blurImage(file) {
    if (!blurState || !blurState.boxes.length) throw new Error('blur-empty');
    const image = await loadImage(file);
    const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
    const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0);
    redact(ctx, image, blurState.boxes, blurState.style, blurState.strength, 1);
    if (typeof image.close === 'function') image.close();
    const out = isHeicFile(file) ? { type: 'image/jpeg', quality: 0.92 } : sameTypeOutput(file);
    return { blob: await encodeCanvas(c, out.type, out.quality), type: out.type, count: blurState.boxes.length };
  }

  /* ---------- compress to a target file size ---------- */
  async function compressToSize(file, maxBytes, keepType) {
    const img = await loadImage(file);
    const alpha = keepType && /png|webp/i.test(file.type);
    const type = alpha ? 'image/webp' : 'image/jpeg';
    let w = img.width, h = img.height, best = null, tries = 0;
    while (tries++ < 8) {
      const c = drawToCanvas(img, w, h, { bg: type === 'image/jpeg' ? '#ffffff' : null });
      // binary search the highest quality that fits
      let lo = 0.3, hi = 0.95, fit = null;
      for (let i = 0; i < 7; i++) {
        const q = (lo + hi) / 2;
        const b = await canvasBlob(c, type, q);
        if (b.size <= maxBytes) { fit = { blob: b, q }; lo = q; } else hi = q;
      }
      if (fit) { best = { ...fit, w: c.width, h: c.height }; break; }
      const low = await canvasBlob(c, type, 0.3);
      const k = Math.max(0.5, Math.min(0.9, Math.sqrt(maxBytes / low.size) * 0.95));
      w *= k; h *= k;
      if (w < 64 || h < 64) break;
    }
    const ow = img.width, oh = img.height;
    if (typeof img.close === 'function') img.close();
    if (!best) throw new Error('size-impossible');
    return { ...best, type, resized: Math.round(best.w) < ow, ow, oh };
  }

  /* ---------- passport & ID photos ---------- */
  // Sizes in millimetres; head = chin-to-crown as a share of the photo height (official ranges, Nov 2026).
  const ID_PRESETS = [
    { id: 'us', n: 'U.S. passport or visa — 2 × 2 in', wmm: 50.8, hmm: 50.8, head: [0.50, 0.69], px: [600, 600], tip: 'Head 1 to 1⅜ in (25–35 mm) from chin to top of hair. Plain white or off-white background.' },
    { id: 'uk', n: 'UK passport — 35 × 45 mm', wmm: 35, hmm: 45, head: [0.64, 0.76], px: [900, 1200], tip: 'Head 29–34 mm from chin to crown. Plain cream or light grey background.' },
    { id: 'eu', n: 'Schengen / EU visa — 35 × 45 mm', wmm: 35, hmm: 45, head: [0.71, 0.80], px: [827, 1063], tip: 'Head 32–36 mm from chin to crown. Plain light background.' },
    { id: 'ca', n: 'Canada passport — 50 × 70 mm', wmm: 50, hmm: 70, head: [0.44, 0.51], px: [827, 1158], tip: 'Head 31–36 mm from chin to crown. Plain white or light background.' },
    { id: 'au', n: 'Australia passport — 35 × 45 mm', wmm: 35, hmm: 45, head: [0.71, 0.80], px: [827, 1063], tip: 'Head 32–36 mm from chin to crown. Plain light grey or white background.' },
  ];
  let idState = null;
  async function setupIdEditor(host, file) {
    host.innerHTML = `<div class="field"><label for="id-preset">Photo type</label><select id="id-preset">${ID_PRESETS.map((p) => `<option value="${p.id}">${p.n}</option>`).join('')}</select><p class="note-soft rs-tip" id="id-tip"></p></div>
      <p class="note-soft" id="id-status" style="text-align:left">Finding your face…</p>
      <div class="crop-editor id-editor"><canvas id="id-canvas" aria-label="Drag to move the photo inside the frame"></canvas></div>
      <p class="note-soft crop-help">Drag to move the photo. The top of the head should touch the upper gold line and the chin the lower one.</p>
      <p class="note-soft" id="id-warn" style="text-align:left;color:var(--brass)" aria-live="polite"></p>
      <div class="field"><label for="id-zoom">Zoom</label><input type="range" id="id-zoom" min="20" max="400" value="100" /></div>
      ${radios('idout', [
        { v: 'single', n: 'Single photo', d: 'For online applications and digital uploads', def: true },
        { v: 'sheet', n: '4 × 6 in print sheet', d: 'Several copies to print at a photo counter and cut out' },
      ])}
      <p class="note-soft" style="text-align:left">Rules also cover glasses (usually off), expression (neutral), lighting and background. Check your country’s official guidance before you submit.</p>`;
    const image = await loadImage(file);
    const canvas = $('id-canvas');
    idState = { image, canvas, ox: 0, oy: 0, zoom: 1, face: null, preset: ID_PRESETS[0] };
    const frame = () => {
      const p = idState.preset; const H = 400, W = Math.round(H * p.wmm / p.hmm);
      canvas.width = W; canvas.height = H; return { W, H };
    };
    // image placement: rendered at scale s (canvas px per image px), offset ox/oy (canvas px)
    const autoPlace = () => {
      const { W, H } = frame(); const p = idState.preset; const f = idState.face;
      if (f) {
        const headPx = f.h * 1.45; // face box (brows to chin) → whole head incl. hair
        const target = H * (p.head[0] + p.head[1]) / 2;
        idState.s = target / headPx;
        const crownY = f.y - f.h * 0.42;
        const topGap = (H - target) * 0.45;
        idState.ox = W / 2 - (f.x + f.w / 2) * idState.s;
        idState.oy = topGap - crownY * idState.s;
      } else {
        idState.s = Math.max(W / image.width, H / image.height);
        idState.ox = (W - image.width * idState.s) / 2; idState.oy = (H - image.height * idState.s) / 2;
      }
      idState.base = idState.s; $('id-zoom').value = 100;
    };
    const draw = () => {
      const { width: W, height: H } = canvas; const p = idState.preset;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(image, idState.ox, idState.oy, image.width * idState.s, image.height * idState.s);
      const headMid = (p.head[0] + p.head[1]) / 2;
      const top = (H - H * headMid) * 0.45, chin = top + H * headMid;
      ctx.strokeStyle = '#cca24e'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
      [top, chin].forEach((y) => { ctx.beginPath(); ctx.moveTo(W * 0.2, y); ctx.lineTo(W * 0.8, y); ctx.stroke(); });
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(204,162,78,.55)';
      ctx.beginPath(); ctx.ellipse(W / 2, (top + chin) / 2, H * headMid * 0.36, H * headMid / 2, 0, 0, Math.PI * 2); ctx.stroke();
      $('id-tip').textContent = p.tip;
      const gap = idState.ox > 1 || idState.oy > 1 || idState.ox + image.width * idState.s < W - 1 || idState.oy + image.height * idState.s < H - 1;
      $('id-warn').textContent = gap ? 'The photo doesn’t fill the frame, so a white edge shows. Zoom in, or use a photo with more space around your head.' : '';
    };
    const point = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) * canvas.width / r.width, y: (ev.clientY - r.top) * canvas.height / r.height }; };
    let drag = null;
    canvas.addEventListener('pointerdown', (ev) => { drag = { p: point(ev), ox: idState.ox, oy: idState.oy }; canvas.setPointerCapture(ev.pointerId); });
    canvas.addEventListener('pointermove', (ev) => { if (!drag) return; const p = point(ev); idState.ox = drag.ox + p.x - drag.p.x; idState.oy = drag.oy + p.y - drag.p.y; draw(); });
    canvas.addEventListener('pointerup', () => { drag = null; }); canvas.addEventListener('pointercancel', () => { drag = null; });
    $('id-zoom').addEventListener('input', () => {
      const old = idState.s; const s = idState.base * (+$('id-zoom').value / 100);
      const cx = canvas.width / 2, cy = canvas.height / 2;
      idState.ox = cx - (cx - idState.ox) * s / old; idState.oy = cy - (cy - idState.oy) * s / old; idState.s = s; draw();
    });
    $('id-preset').addEventListener('change', () => { idState.preset = ID_PRESETS.find((x) => x.id === $('id-preset').value); autoPlace(); draw(); });
    autoPlace(); draw();
    try {
      const faces = await findFaces(image, 0.5);
      if (idState && idState.image === image) {
        faces.sort((a, b) => b.w * b.h - a.w * a.h);
        idState.face = faces[0] || null;
        $('id-status').textContent = faces.length ? 'Face found and lined up. Fine-tune by dragging or zooming if needed.' : 'We couldn’t find a face. Drag and zoom to line up the head with the guides.';
        if (faces.length > 1) $('id-status').textContent += ' (More than one face found: we used the biggest.)';
        autoPlace(); draw();
      }
    } catch (e) { console.error(e); $('id-status').textContent = 'Drag and zoom to line up the head with the guides.'; }
  }
  async function renderIdPhoto() {
    if (!idState) throw new Error('decode');
    const p = idState.preset; const [PW, PH] = p.px;
    const k = PW / idState.canvas.width;
    const photo = document.createElement('canvas'); photo.width = PW; photo.height = PH;
    const ctx = photo.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, PW, PH);
    ctx.drawImage(idState.image, idState.ox * k, idState.oy * k, idState.image.width * idState.s * k, idState.image.height * idState.s * k);
    if ((getRadio('idout') || 'single') === 'single') return { canvas: photo, label: `${p.id}-photo-${PW}x${PH}` };
    // 4 × 6 in sheet at 300 dpi, landscape, as many copies as fit, with thin cut guides
    const dpi = 300, SW = 1800, SH = 1200, gap = 24;
    const pw = Math.round(p.wmm / 25.4 * dpi), ph = Math.round(p.hmm / 25.4 * dpi);
    const cols = Math.max(1, Math.floor((SW - gap) / (pw + gap))), rows = Math.max(1, Math.floor((SH - gap) / (ph + gap)));
    const sheet = document.createElement('canvas'); sheet.width = SW; sheet.height = SH;
    const sc = sheet.getContext('2d'); sc.fillStyle = '#ffffff'; sc.fillRect(0, 0, SW, SH);
    const x0 = (SW - cols * pw - (cols - 1) * gap) / 2, y0 = (SH - rows * ph - (rows - 1) * gap) / 2;
    sc.strokeStyle = '#bbbbbb'; sc.lineWidth = 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = x0 + c * (pw + gap), y = y0 + r * (ph + gap);
      sc.drawImage(photo, x, y, pw, ph); sc.strokeRect(x - 0.5, y - 0.5, pw + 1, ph + 1);
    }
    return { canvas: sheet, label: `${p.id}-print-sheet-4x6`, copies: cols * rows };
  }

  /* ---------- ffmpeg with several inputs (join clips) ---------- */
  async function probeHasAudio(f, name) {
    let log = '';
    const onLog = ({ message }) => { log += message + '\n'; };
    f.on('log', onLog);
    try { await f.exec(['-hide_banner', '-i', name]); } catch (_) {}
    f.off('log', onLog);
    const dims = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(log);
    const rot = /rotate\s*:\s*(-?\d+)|rotation of (-?\d+)/.exec(log);
    let w = dims ? +dims[1] : 0, h = dims ? +dims[2] : 0;
    if (rot && Math.abs(+(rot[1] || rot[2])) % 180 === 90) [w, h] = [h, w];
    return { audio: /Audio:/.test(log), w, h };
  }
  async function joinClips(files) {
    if (files.length < 2) throw new Error('join-one');
    const f = await ensureFfmpeg(() => { $('w-label').textContent = 'Loading the engine…'; $('w-note').textContent = 'Downloading the media engine for the first time (~30 MB). This only happens once.'; });
    $('w-label').textContent = 'Reading your clips…';
    const names = [];
    for (let i = 0; i < files.length; i++) {
      const ext = (files[i].name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
      const name = `in${i}.${ext}`; await f.writeFile(name, await fetchFile(files[i])); names.push(name);
    }
    const info = [];
    for (const n of names) info.push(await probeHasAudio(f, n));
    // Output size: the first clip's, capped at 1920 on the long side, even numbers.
    let W = info[0].w || 1280, H = info[0].h || 720;
    const cap = Math.min(1, 1920 / Math.max(W, H)); W = Math.round(W * cap / 2) * 2; H = Math.round(H * cap / 2) * 2;
    const durs = info.some((x) => !x.audio) ? await Promise.all(files.map((file) => videoDuration(file).catch(() => 0))) : [];
    const inputs = [], filters = [], concat = [];
    names.forEach((n) => { inputs.push('-i', n); });
    let extra = names.length;
    names.forEach((n, i) => {
      filters.push(`[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
      if (info[i].audio) filters.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
      else {
        // a clip with no sound gets silence of the same length, so the joined audio stays in sync
        inputs.push('-f', 'lavfi', '-t', String(Math.max(0.1, durs[i] || 1)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
        filters.push(`[${extra}:a]anull[a${i}]`); extra++;
      }
      concat.push(`[v${i}][a${i}]`);
    });
    const graph = filters.join(';') + ';' + concat.join('') + `concat=n=${names.length}:v=1:a=1[v][a]`;
    $('w-label').textContent = 'Joining…'; $('w-note').textContent = 'Working on your device. Every clip is re-encoded to match, so this takes a while for long videos.';
    const args = [...inputs, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-map_metadata', '-1', '-c:v', 'libx264', '-crf', '22', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4'];
    await f.exec(args);
    const data = await f.readFile('out.mp4');
    for (const n of names) { try { await f.deleteFile(n); } catch (_) {} }
    try { await f.deleteFile('out.mp4'); } catch (_) {}
    if (!(data && data.length > 1024)) throw new Error('empty-output');
    return new Blob([data.buffer], { type: 'video/mp4' });
  }

  /* ---------- captions (speech to text, on this device) ---------- */
  let captionWorker = null;
  function transcribe(audio, model, language) {
    if (!captionWorker) captionWorker = new Worker('/inkwellmedia/captions-worker.js', { type: 'module' });
    return new Promise((resolve, reject) => {
      captionWorker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'download') { $('w-label').textContent = 'Downloading the speech model…'; $('w-note').textContent = `One-time download, then it’s cached: ${fmtSize(m.loaded)} of ${fmtSize(m.total)}`; setProgress(Math.round(m.loaded / m.total * 100)); }
        else if (m.type === 'transcribing') { $('w-label').textContent = 'Listening and writing captions…'; $('w-note').textContent = 'Running on your device. Roughly a minute of work per few minutes of audio; a computer is faster than a phone.'; $('w-track').classList.add('indet'); $('w-pct').textContent = ''; }
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') { captionWorker.terminate(); captionWorker = null; reject(new Error('speech: ' + m.message)); }
      };
      captionWorker.onerror = (e) => { captionWorker.terminate(); captionWorker = null; reject(new Error('speech-load: ' + (e.message || 'worker'))); };
      captionWorker.postMessage({ audio, model, language }, [audio.buffer]);
    });
  }
  const tc = (sec, sep) => { sec = Math.max(0, sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60), ms = Math.round((sec - Math.floor(sec)) * 1000); return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(ms === 1000 ? 999 : ms).padStart(3, '0')}`; };
  // Split long chunks into caption-sized lines (≤ 42 chars, ≤ ~6 s).
  function captionCues(chunks, total) {
    const cues = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const text = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const start = c.start || 0;
      const end = c.end != null ? c.end : (chunks[i + 1] && chunks[i + 1].start) || total || start + 3;
      const words = text.split(' ');
      const lines = []; let cur = '';
      for (const w of words) { if ((cur + ' ' + w).trim().length > 42 && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
      if (cur) lines.push(cur);
      const per = (end - start) / lines.length;
      lines.forEach((ln, k) => cues.push({ start: start + per * k, end: start + per * (k + 1), text: ln }));
    }
    return cues;
  }
  const toSrt = (cues) => cues.map((c, i) => `${i + 1}\n${tc(c.start, ',')} --> ${tc(c.end, ',')}\n${c.text}\n`).join('\n');
  const toVtt = (cues) => 'WEBVTT\n\n' + cues.map((c) => `${tc(c.start, '.')} --> ${tc(c.end, '.')}\n${c.text}\n`).join('\n');

  /* ---------- subtitles: read SRT / VTT, draw and burn them into a video ---------- */
  function parseSubs(text) {
    const cues = [];
    const t2s = (t) => { const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(t); if (!m) return null; return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000; };
    const blocks = String(text).replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
    for (const b of blocks) {
      const lines = b.split('\n').filter((l) => l.trim() !== '');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, z] = lines[i].split('-->');
      const start = t2s(a), end = t2s(z);
      const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').trim();
      if (start == null || end == null || !body || end <= start) continue;
      cues.push({ start, end, text: body });
    }
    return cues.sort((x, y) => x.start - y.start);
  }
  function wrapLines(ctx, text, maxW) {
    const out = [];
    for (const para of String(text).split('\n')) {
      let cur = '';
      for (const w of para.split(/\s+/).filter(Boolean)) {
        const t = cur ? cur + ' ' + w : w;
        if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t;
      }
      if (cur) out.push(cur);
    }
    return out.slice(0, 3);
  }
  async function captionPng(text, W, H, style) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const fs = Math.round(Math.max(18, (W < H ? W * 0.058 : H * 0.052)));
    ctx.font = `700 ${fs}px Inter, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapLines(ctx, text, W * 0.86);
    const lh = Math.round(fs * 1.28);
    const block = lh * lines.length;
    const cy = style.pos === 'middle' ? H * 0.66 : H - Math.round(H * 0.07) - block / 2;
    lines.forEach((ln, i) => {
      const y = cy - block / 2 + lh * i + lh / 2;
      if (style.look === 'box') {
        const tw = ctx.measureText(ln).width, pad = Math.round(fs * 0.32);
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillRect(W / 2 - tw / 2 - pad, y - lh / 2, tw + pad * 2, lh);
        ctx.fillStyle = '#fff'; ctx.fillText(ln, W / 2, y);
      } else {
        ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(3, fs * 0.16); ctx.strokeStyle = '#000';
        ctx.strokeText(ln, W / 2, y);
        ctx.fillStyle = style.look === 'yellow' ? '#ffd23f' : '#fff'; ctx.fillText(ln, W / 2, y);
      }
    });
    return new Uint8Array(await (await canvasBlob(c, 'image/png')).arrayBuffer());
  }
  // Draw each caption as a transparent picture and lay it over the video at its time.
  async function burnCaptions(file, cues, style) {
    if (!cues.length) throw new Error('no-subs');
    const f = await ensureFfmpeg(() => { $('w-label').textContent = 'Loading the engine…'; $('w-note').textContent = 'Downloading the media engine for the first time (~30 MB). This only happens once.'; });
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    const inName = 'burn-in.' + ext;
    await f.writeFile(inName, await fetchFile(file));
    const info = await probeHasAudio(f, inName);
    let W = info.w || 1280, H = info.h || 720;
    const cap = Math.min(1, 1920 / Math.max(W, H)); W = Math.round(W * cap / 2) * 2; H = Math.round(H * cap / 2) * 2;
    $('w-label').textContent = 'Drawing the captions…';
    const list = cues.slice(0, 600);
    const names = [];
    for (let i = 0; i < list.length; i++) { const n = `cap${i}.png`; await f.writeFile(n, await captionPng(list[i].text, W, H, style)); names.push(n); }
    const inputs = ['-i', inName]; names.forEach((n) => inputs.push('-i', n));
    const parts = [`[0:v]scale=${W}:${H},setsar=1,format=yuv420p[b0]`];
    list.forEach((c, i) => parts.push(`[b${i}][${i + 1}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'${i === list.length - 1 ? ',format=yuv420p[vout]' : `[b${i + 1}]`}`));
    $('w-label').textContent = 'Adding captions to the video…'; $('w-note').textContent = 'Working on your device. The whole video is re-encoded, so long videos take a while.';
    await f.exec([...inputs, '-filter_complex', parts.join(';'), '-map', '[vout]', '-map', '0:a?', '-map_metadata', '-1', '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'burn-out.mp4']);
    const data = await f.readFile('burn-out.mp4');
    for (const n of [inName, ...names, 'burn-out.mp4']) { try { await f.deleteFile(n); } catch (_) {} }
    if (!(data && data.length > 1024)) throw new Error('empty-output');
    return { blob: new Blob([data.buffer], { type: 'video/mp4' }), count: list.length, skipped: cues.length - list.length };
  }
  const CAPTION_STYLE_HTML = (p) => `<div class="field"><label for="${p}-look">Caption look</label><select id="${p}-look"><option value="box">White text on a dark box (easiest to read)</option><option value="outline">White text with a black outline</option><option value="yellow">Yellow text with a black outline</option></select></div>`
    + `<div class="field"><label for="${p}-pos">Position</label><select id="${p}-pos"><option value="bottom">Bottom</option><option value="middle">Lower middle (for Reels, TikTok and Shorts, clear of the app's buttons)</option></select></div>`;
  const readCaptionStyle = (p) => ({ look: $(p + '-look').value, pos: $(p + '-pos').value });

  /* ---------- vertical video for Reels, TikTok and Shorts ---------- */
  const SHAPES = { '9x16': [1080, 1920, '9:16 (Reels, TikTok, Shorts, Stories)'], '4x5': [1080, 1350, '4:5 (Instagram and Facebook feed)'], '1x1': [1080, 1080, '1:1 square'], '16x9': [1920, 1080, '16:9 (YouTube, landscape)'] };
  function reframeGraph(W, H, fill) {
    if (fill === 'crop') return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1,format=yuv420p[v]`;
    if (fill === 'black' || fill === 'white') return `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${fill},setsar=1,format=yuv420p[v]`;
    const sw = Math.round(W / 4 / 2) * 2, sh = Math.round(H / 4 / 2) * 2;
    return `[0:v]split[a][b];[a]scale=${sw}:${sh}:force_original_aspect_ratio=increase,crop=${sw}:${sh},boxblur=12:2,scale=${W}:${H},eq=brightness=-0.08[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`;
  }

  /* ---------- screen recorder (browser screen capture + MediaRecorder) ---------- */
  const canRecordScreen = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  function recorderType() {
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,opus', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return types.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch (_) { return false; } }) || '';
  }
  async function recordScreen({ mic, systemAudio, fps }) {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: !!systemAudio, selfBrowserSurface: 'exclude', systemAudio: systemAudio ? 'include' : 'exclude' });
    let micStream = null;
    if (mic) { try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (_) { micStream = null; } }
    const tracks = [...display.getVideoTracks()];
    const audioIn = [display, micStream].filter((s) => s && s.getAudioTracks().length);
    let actx = null;
    if (audioIn.length === 1) tracks.push(audioIn[0].getAudioTracks()[0]);
    else if (audioIn.length > 1) {
      actx = new AudioContext(); const dest = actx.createMediaStreamDestination();
      audioIn.forEach((s) => actx.createMediaStreamSource(s).connect(dest));
      tracks.push(dest.stream.getAudioTracks()[0]);
    }
    const stream = new MediaStream(tracks);
    const type = recorderType();
    const rec = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6000000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { rec.onstop = resolve; });
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    display.getVideoTracks()[0].addEventListener('ended', stop);
    rec.start(1000);
    $('w-label').textContent = 'Recording…';
    $('w-note').innerHTML = `Recording ${audioIn.length ? 'with sound' : 'without sound'}. Click <b>Stop recording</b> here, or “Stop sharing” in your browser’s bar, when you’re done. <button type="button" class="btn" id="rec-stop" style="margin-left:8px">Stop recording</button>`;
    $('rec-stop').addEventListener('click', stop);
    await done;
    [display, micStream].forEach((s) => s && s.getTracks().forEach((t) => t.stop()));
    if (actx) actx.close();
    const mime = (rec.mimeType || type || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type: mime });
    if (!blob.size) throw new Error('empty-output');
    return { blob, mime, ext: mime.includes('mp4') ? 'mp4' : 'webm', withSound: audioIn.length > 0 };
  }

  /* ---------- photo collage / grid ---------- */
  const COLLAGE_SIZES = { square: [2048, 2048, 'Square 2048 × 2048'], portrait: [1080, 1350, 'Instagram portrait 1080 × 1350'], story: [1080, 1920, 'Story 1080 × 1920'], wide: [1920, 1080, 'Wide 1920 × 1080'], print: [1800, 1200, '6 × 4 in print (300 dpi)'] };
  function collageLayout(n, W, H, colsWanted) {
    let cols = colsWanted || Math.max(1, Math.round(Math.sqrt(n * W / H)));
    cols = Math.min(cols, n); const rows = Math.ceil(n / cols);
    const cells = []; let k = 0;
    for (let r = 0; r < rows; r++) {
      const inRow = Math.min(cols, n - k);
      for (let c = 0; c < inRow; c++) cells.push({ r, c, inRow, rows });
      k += inRow;
    }
    return cells;
  }
  async function makeCollage(files, { size, cols, gap, bg, round }) {
    const [W, H] = COLLAGE_SIZES[size] || COLLAGE_SIZES.square;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const cells = collageLayout(files.length, W, H, cols);
    const rows = cells[0].rows;
    const g = Math.round(Math.min(W, H) * gap / 100);
    const ch = (H - g * (rows + 1)) / rows;
    for (let i = 0; i < files.length; i++) {
      $('w-label').textContent = `Placing photo ${i + 1} of ${files.length}…`;
      const { r, c, inRow } = cells[i];
      const cw = (W - g * (inRow + 1)) / inRow;
      const x = g + c * (cw + g), y = g + r * (ch + g);
      const img = await loadImage(files[i]);
      const s = Math.max(cw / img.width, ch / img.height);
      const sw = cw / s, sh = ch / s, sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
      ctx.save();
      const rad = round ? Math.min(cw, ch) * 0.04 : 0;
      if (rad) { ctx.beginPath(); ctx.roundRect(x, y, cw, ch, rad); ctx.clip(); }
      ctx.drawImage(img, sx, sy, sw, sh, x, y, cw, ch);
      ctx.restore();
      if (typeof img.close === 'function') img.close();
    }
    return { canvas, W, H };
  }
  function orderList(host, label, extra) {
    const draw = () => {
      host.querySelector('[data-order]').innerHTML = `<p class="plabel">${label}</p><ol class="join-list">${selectedFiles.map((f, i) => `<li><span>${escapeHtml(f.name)}</span><span class="join-btns"><button type="button" class="transform-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(f.name)} up">↑</button><button type="button" class="transform-btn" data-down="${i}" ${i === selectedFiles.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(f.name)} down">↓</button></span></li>`).join('')}</ol>`;
      host.querySelectorAll('[data-up],[data-down]').forEach((b) => b.addEventListener('click', () => {
        const i = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up !== undefined ? i - 1 : i + 1;
        [selectedFiles[i], selectedFiles[j]] = [selectedFiles[j], selectedFiles[i]]; draw();
      }));
    };
    host.innerHTML = `<div data-order></div>` + extra;
    draw();
  }

  /* ---------- add text to an image ---------- */
  const TEXT_FONTS = { sans: '800 {s}px Inter, "Segoe UI", Roboto, Arial, sans-serif', serif: '700 {s}px Fraunces, Georgia, "Times New Roman", serif', impact: '900 {s}px Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif', hand: '700 {s}px "Comic Sans MS", "Segoe Print", "Bradley Hand", cursive' };
  let textState = null;
  function drawTextOn(ctx, W, H, o) {
    const lines = String(o.text || '').split('\n');
    const fs = Math.max(8, Math.round(Math.min(W, H) * o.size / 100));
    ctx.font = TEXT_FONTS[o.font].replace('{s}', fs);
    ctx.textAlign = o.align; ctx.textBaseline = 'middle';
    const lh = fs * 1.18, block = lh * lines.length, pad = Math.round(Math.min(W, H) * 0.04);
    const cy = o.pos === 'top' ? pad + block / 2 : o.pos === 'middle' ? H / 2 : H - pad - block / 2;
    const x = o.align === 'left' ? pad : o.align === 'right' ? W - pad : W / 2;
    lines.forEach((ln, i) => {
      const y = cy - block / 2 + lh * i + lh / 2;
      if (o.style === 'box' && ln.trim()) {
        const tw = ctx.measureText(ln).width, bp = fs * 0.3;
        const bx = o.align === 'left' ? x - bp : o.align === 'right' ? x - tw - bp : x - tw / 2 - bp;
        ctx.fillStyle = o.box; ctx.fillRect(bx, y - lh / 2, tw + bp * 2, lh);
      }
      if (o.style === 'outline' || o.style === 'meme') { ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fs * (o.style === 'meme' ? 0.14 : 0.09)); ctx.strokeStyle = o.style === 'meme' ? '#000' : o.stroke; ctx.strokeText(ln, x, y); }
      if (o.style === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = fs * 0.15; ctx.shadowOffsetY = fs * 0.05; }
      ctx.fillStyle = o.style === 'meme' ? '#fff' : o.color; ctx.fillText(o.style === 'meme' ? ln.toUpperCase() : ln, x, y);
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    });
  }
  const readTextOpts = () => ({ text: $('tx-text').value, pos: $('tx-pos').value, align: $('tx-align').value, size: +$('tx-size').value, font: $('tx-font').value, style: $('tx-style').value, color: $('tx-color').value, stroke: '#000000', box: 'rgba(0,0,0,0.65)' });
  async function setupTextEditor(host, file) {
    host.innerHTML = `<div class="field"><label for="tx-text">Text</label><textarea id="tx-text" rows="2" placeholder="Type your text">SOLD</textarea></div>
      <div class="field-row">
        <div class="field"><label for="tx-pos">Position</label><select id="tx-pos"><option value="top">Top</option><option value="middle">Middle</option><option value="bottom" selected>Bottom</option></select></div>
        <div class="field"><label for="tx-align">Line up</label><select id="tx-align"><option value="center">Centre</option><option value="left">Left</option><option value="right">Right</option></select></div>
        <div class="field"><label for="tx-font">Font</label><select id="tx-font"><option value="sans">Clean</option><option value="impact">Bold poster (meme)</option><option value="serif">Classic serif</option><option value="hand">Handwritten</option></select></div>
      </div>
      <div class="field-row">
        <div class="field"><label for="tx-style">Style</label><select id="tx-style"><option value="outline">Outline</option><option value="meme">Meme (white, black outline, capitals)</option><option value="box">On a dark box</option><option value="shadow">Soft shadow</option><option value="plain">Plain</option></select></div>
        <div class="field"><label for="tx-color">Colour</label><input type="color" id="tx-color" value="#ffffff"/></div>
        <div class="field"><label for="tx-size">Size</label><input type="range" id="tx-size" min="3" max="25" value="10"/></div>
      </div>
      <div class="crop-editor"><canvas id="tx-canvas" aria-label="Preview with your text"></canvas></div>`;
    const image = await loadImage(file);
    const canvas = $('tx-canvas'); const sc = Math.min(1, 900 / Math.max(image.width, image.height));
    canvas.width = Math.round(image.width * sc); canvas.height = Math.round(image.height * sc);
    textState = { image };
    const draw = () => { const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); drawTextOn(ctx, canvas.width, canvas.height, readTextOpts()); };
    host.querySelectorAll('input,select,textarea').forEach((el) => el.addEventListener('input', draw));
    host.querySelectorAll('select').forEach((el) => el.addEventListener('change', draw));
    $('tx-style').addEventListener('change', () => { if ($('tx-style').value === 'meme') { $('tx-font').value = 'impact'; $('tx-pos').value = $('tx-pos').value === 'middle' ? 'top' : $('tx-pos').value; } draw(); });
    if (document.body.dataset.textstyle === 'meme') { $('tx-style').value = 'meme'; $('tx-font').value = 'impact'; $('tx-pos').value = 'top'; $('tx-text').value = 'TOP TEXT'; $('tx-size').value = 12; }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(draw);
    draw();
  }

  /* ---------- round profile picture ---------- */
  let pfState = null;
  async function setupProfileEditor(host, file) {
    host.innerHTML = `<p class="note-soft" id="pf-status" style="text-align:left">Finding your face…</p>
      <div class="crop-editor id-editor"><canvas id="pf-canvas" width="400" height="400" aria-label="Drag to move the photo inside the circle"></canvas></div>
      <p class="note-soft crop-help">Drag to move the photo; use Zoom to fit your face in the circle.</p>
      <div class="field"><label for="pf-zoom">Zoom</label><input type="range" id="pf-zoom" min="100" max="400" value="100"/></div>
      <div class="field-row">
        <div class="field"><label for="pf-size">Size</label><select id="pf-size"><option value="400">400 × 400 (LinkedIn, Slack, email)</option><option value="800" selected>800 × 800</option><option value="1080">1080 × 1080 (Instagram, Facebook)</option></select></div>
        <div class="field"><label for="pf-bg">Outside the circle</label><select id="pf-bg"><option value="clear">Transparent (PNG)</option><option value="white">White</option><option value="square">Keep it square (no circle)</option></select></div>
      </div>
      <label class="opt-check"><input type="checkbox" id="pf-ring"/> Add a ring <input type="color" id="pf-ringc" value="#cca24e" aria-label="Ring colour" style="margin-left:8px;vertical-align:middle"/></label>`;
    const image = await loadImage(file);
    const canvas = $('pf-canvas'); const S = 400;
    pfState = { image, s: Math.max(S / image.width, S / image.height), ox: 0, oy: 0 };
    pfState.base = pfState.s; pfState.ox = (S - image.width * pfState.s) / 2; pfState.oy = (S - image.height * pfState.s) / 2;
    const cover = Math.max(S / image.width, S / image.height);
    const clamp = () => { if (pfState.s < cover) pfState.s = cover; pfState.ox = Math.min(0, Math.max(S - image.width * pfState.s, pfState.ox)); pfState.oy = Math.min(0, Math.max(S - image.height * pfState.s, pfState.oy)); };
    const draw = () => {
      clamp();
      const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, S, S);
      ctx.fillStyle = '#e9e4da'; ctx.fillRect(0, 0, S, S);
      ctx.drawImage(image, pfState.ox, pfState.oy, image.width * pfState.s, image.height * pfState.s);
      if ($('pf-bg').value !== 'square') {
        ctx.save(); ctx.fillStyle = 'rgba(20,16,25,.55)'; ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2, true); ctx.fill('evenodd'); ctx.restore();
      }
      if ($('pf-ring').checked) { ctx.strokeStyle = $('pf-ringc').value; ctx.lineWidth = S * 0.035; ctx.beginPath(); ctx.arc(S / 2, S / 2, S / 2 - S * 0.0175, 0, Math.PI * 2); ctx.stroke(); }
    };
    const point = (ev) => { const r = canvas.getBoundingClientRect(); return { x: (ev.clientX - r.left) * S / r.width, y: (ev.clientY - r.top) * S / r.height }; };
    let drag = null;
    canvas.addEventListener('pointerdown', (ev) => { drag = { p: point(ev), ox: pfState.ox, oy: pfState.oy }; canvas.setPointerCapture(ev.pointerId); });
    canvas.addEventListener('pointermove', (ev) => { if (!drag) return; const p = point(ev); pfState.ox = drag.ox + p.x - drag.p.x; pfState.oy = drag.oy + p.y - drag.p.y; draw(); });
    canvas.addEventListener('pointerup', () => { drag = null; }); canvas.addEventListener('pointercancel', () => { drag = null; });
    $('pf-zoom').addEventListener('input', () => { const old = pfState.s, s = Math.max(cover, pfState.base * (+$('pf-zoom').value / 100)), c = S / 2; pfState.ox = c - (c - pfState.ox) * s / old; pfState.oy = c - (c - pfState.oy) * s / old; pfState.s = s; draw(); });
    ['pf-bg', 'pf-ring', 'pf-ringc'].forEach((id) => $(id).addEventListener('input', draw));
    draw();
    try {
      const faces = await findFaces(image, 0.5);
      if (faces.length) {
        const f = faces.sort((a, b) => b.w * b.h - a.w * a.h)[0];
        const want = S * 0.42; pfState.s = Math.max(cover, want / (f.h * 1.45)); pfState.base = pfState.s;
        pfState.ox = S / 2 - (f.x + f.w / 2) * pfState.s; pfState.oy = S / 2 - (f.y + f.h * 0.42) * pfState.s;
        $('pf-zoom').value = 100; $('pf-status').textContent = 'Face found and centred. Drag or zoom to adjust.';
      } else $('pf-status').textContent = 'No face found; drag and zoom to place the photo.';
    } catch (_) { $('pf-status').textContent = 'Drag and zoom to place the photo in the circle.'; }
    draw();
  }
  function renderProfile() {
    const N = +$('pf-size').value, S = 400, k = N / S, { image } = pfState;
    const c = document.createElement('canvas'); c.width = N; c.height = N; const ctx = c.getContext('2d');
    const bg = $('pf-bg').value;
    if (bg === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, N, N); }
    ctx.save();
    if (bg !== 'square') { ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2, 0, Math.PI * 2); ctx.clip(); }
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, N, N);
    ctx.drawImage(image, pfState.ox * k, pfState.oy * k, image.width * pfState.s * k, image.height * pfState.s * k);
    ctx.restore();
    if ($('pf-ring').checked) { ctx.strokeStyle = $('pf-ringc').value; ctx.lineWidth = N * 0.035; ctx.beginPath(); ctx.arc(N / 2, N / 2, N / 2 - N * 0.0175, 0, Math.PI * 2); ctx.stroke(); }
    return { canvas: c, png: bg === 'clear' };
  }

  /* ---------- favicon & app icons ---------- */
  function icoFromPngs(pngs) { // [{ size, bytes:Uint8Array }]
    const head = 6 + 16 * pngs.length; let off = head; const total = head + pngs.reduce((a, p) => a + p.bytes.length, 0);
    const out = new Uint8Array(total); const dv = new DataView(out.buffer);
    dv.setUint16(0, 0, true); dv.setUint16(2, 1, true); dv.setUint16(4, pngs.length, true);
    pngs.forEach((p, i) => {
      const e = 6 + 16 * i;
      out[e] = p.size >= 256 ? 0 : p.size; out[e + 1] = p.size >= 256 ? 0 : p.size; out[e + 2] = 0; out[e + 3] = 0;
      dv.setUint16(e + 4, 1, true); dv.setUint16(e + 6, 32, true); dv.setUint32(e + 8, p.bytes.length, true); dv.setUint32(e + 12, off, true);
      out.set(p.bytes, off); off += p.bytes.length;
    });
    return out;
  }
  async function iconCanvas(img, size, { pad, bg, round }) {
    const c = document.createElement('canvas'); c.width = size; c.height = size; const ctx = c.getContext('2d');
    if (bg) { ctx.fillStyle = bg; if (round) { ctx.beginPath(); ctx.roundRect(0, 0, size, size, size * 0.18); ctx.fill(); } else ctx.fillRect(0, 0, size, size); }
    const inner = size * (1 - 2 * pad), s = Math.min(inner / img.width, inner / img.height);
    const w = img.width * s, h = img.height * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c;
  }
  async function makeIcons(file, { pad, bg, round, name }) {
    const img = await loadImage(file);
    const png = async (size, o) => new Uint8Array(await (await canvasBlob(await iconCanvas(img, size, o), 'image/png')).arrayBuffer());
    const base = { pad, bg, round };
    const files = [];
    const add = (n, bytes, type = 'image/png') => files.push({ name: n, blob: new Blob([bytes], { type }) });
    const ico = icoFromPngs(await Promise.all([16, 32, 48].map(async (s) => ({ size: s, bytes: await png(s, base) }))));
    add('favicon.ico', ico, 'image/x-icon');
    add('favicon-16x16.png', await png(16, base)); add('favicon-32x32.png', await png(32, base));
    add('apple-touch-icon.png', await png(180, { pad: Math.max(pad, 0.08), bg: bg || '#ffffff', round: false }));
    add('icon-192.png', await png(192, base)); add('icon-512.png', await png(512, base));
    add('icon-maskable-512.png', await png(512, { pad: Math.max(pad, 0.2), bg: bg || '#ffffff', round: false }));
    const svgMarkup = await (async () => { const c = await iconCanvas(img, 512, base); return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><image width="512" height="512" href="${c.toDataURL('image/png')}"/></svg>`; })();
    add('favicon.svg', new TextEncoder().encode(svgMarkup), 'image/svg+xml');
    const manifest = { name: name || 'My site', short_name: (name || 'My site').slice(0, 12), icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }], theme_color: bg || '#ffffff', background_color: bg || '#ffffff', display: 'standalone' };
    add('site.webmanifest', new TextEncoder().encode(JSON.stringify(manifest, null, 2)), 'application/manifest+json');
    add('paste-into-head.html', new TextEncoder().encode(`<!-- Upload the icon files to the top folder of your website, then paste these lines inside <head> -->\n<link rel="icon" href="/favicon.ico" sizes="48x48">\n<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<link rel="manifest" href="/site.webmanifest">\n`), 'text/html');
    return files;
  }

  /* ---------- before & after picture ---------- */
  async function beforeAfter(files, { layout, labels, size, gap }) {
    const [a, b] = await Promise.all(files.slice(0, 2).map(loadImage));
    const [W, H] = size === 'square' ? [2048, 2048] : size === 'portrait' ? [1080, 1350] : size === 'wide' ? [1920, 1080] : layout === 'stack' ? [1600, 2000] : [2400, 1200];
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    const g = gap ? Math.round(Math.min(W, H) * 0.012) : 0;
    const cells = layout === 'stack' ? [[0, 0, W, (H - g) / 2], [0, (H + g) / 2, W, (H - g) / 2]] : [[0, 0, (W - g) / 2, H], [(W + g) / 2, 0, (W - g) / 2, H]];
    [a, b].forEach((img, i) => {
      const [x, y, w, h] = cells[i]; const s = Math.max(w / img.width, h / img.height);
      const sw = w / s, sh = h / s; ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
      if (labels) {
        const fs = Math.round(Math.min(W, H) * 0.045), t = i ? labels[1] : labels[0];
        ctx.font = `800 ${fs}px Inter, "Segoe UI", Arial, sans-serif`; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(t).width, p = fs * 0.45, bx = x + fs * 0.6, by = y + fs * 0.6;
        ctx.fillStyle = 'rgba(0,0,0,.62)'; ctx.beginPath(); ctx.roundRect(bx, by, tw + p * 2, fs * 1.5, fs * 0.3); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(t, bx + p, by + fs * 0.76);
      }
      if (typeof img.close === 'function') img.close();
    });
    return { canvas: c, W, H };
  }

  const checkupFixes = new Map();
  const FIX_LABELS = { clean:'remove location & camera data', jpg:'save as JPG', shrink:'make it smaller', mp4:'convert to MP4 (H.264)' };

  /* ---------- tool registry ---------- */
  const ICONS = {
    img: '<path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    vid: '<rect x="2" y="5" width="14" height="14" rx="2"/><path d="m16 9 6-3v12l-6-3"/>',
    audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    resize: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3 14 10"/><path d="M3 21l7-7"/>',
    convert: '<path d="M4 12a8 8 0 0 1 8-8 8 8 0 0 1 8 8"/><path d="m16 4 4 0 0 4"/><path d="M20 12a8 8 0 0 1-8 8 8 8 0 0 1-8-8"/><path d="m8 20-4 0 0-4"/>',
    gif: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M8 10a2 2 0 1 0 0 4h1v-2"/><path d="M13 10v4"/><path d="M17 10h-2v4m0-2h2"/>',
    scissor: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M8.1 8.1 20 20M8.1 15.9 20 4"/>',
    crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M2 6h14a2 2 0 0 1 2 2v14"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    watermark: '<path d="M4 4h16v16H4z"/><path d="m7 15 3-3 2 2 3-4 2 5"/><path d="M8 8h.01"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
    check: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    blur: '<circle cx="12" cy="10" r="4"/><path d="M5 21a7 7 0 0 1 14 0"/><path d="M3 3l18 18" stroke-dasharray="2 2"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    idcard: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="11" r="2.5"/><path d="M5.5 17a3.5 3.5 0 0 1 7 0"/><path d="M15 9h3M15 13h3"/>',
    vertical: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="m10 9 4 3-4 3z"/>',
    subs: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 15h5M13 15h5M6 11h12"/>',
    denoise: '<path d="M2 12h2l2-6 3 12 3-9 2 5h2"/><path d="M19 8l3 8M22 8l-3 8"/>',
    screenshot: '<rect x="2" y="3" width="20" height="18" rx="3"/><rect x="5" y="8" width="14" height="10" rx="1.5"/><circle cx="5" cy="5.5" r=".6" fill="currentColor"/><circle cx="7.2" cy="5.5" r=".6" fill="currentColor"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.2-4-7.6-9-7.6z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM18 18h3v3h-3zM14 20h2M20 14v2"/>',
    ringtone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/><path d="M15 3a6 6 0 0 1 6 6M15 7a2 2 0 0 1 2 2"/>',
    audiogram: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 12v0M8.5 9.5v5M11 8v8M13.5 10v4M16 9v6M18.5 11.5v1"/>',
    record: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4" fill="currentColor"/>',
    collage: '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="6" rx="1"/><rect x="13" y="11" width="8" height="10" rx="1"/><rect x="3" y="15" width="8" height="6" rx="1"/>',
    text: '<path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>',
    profile: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.2 18.5a7 7 0 0 1 11.6 0"/>',
    favicon: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M8 16V8h7M8 12h5"/>',
    beforeafter: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M12 5v14"/><path d="m6 12 2-2v4zM18 12l-2-2v4z"/>',
    captions: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 12h4M13 12h4M7 15h8"/>',
    join: '<rect x="2" y="7" width="8" height="10" rx="1.5"/><rect x="14" y="7" width="8" height="10" rx="1.5"/><path d="M10 12h4"/>',
    mute: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m23 9-6 6M17 9l6 6"/>',
    speed: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>',
    level: '<path d="M4 10v4M8 6v12M12 9v6M16 4v16M20 8v8"/>',
    sparkle: '<path d="m12 3-1.4 3.6L7 8l3.6 1.4L12 13l1.4-3.6L17 8l-3.6-1.4z"/><path d="m5 14-.8 2.2L2 17l2.2.8L5 20l.8-2.2L8 17l-2.2-.8z"/><path d="m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8z"/>',
  };
  const svg = (p, stroke='#cca24e') => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const bigsvg = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="#cca24e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

  // preset radio helper
  function radios(name, items) {
    return `<p class="plabel">Choose an option</p><div class="presets">` + items.map((it,i) =>
      `<label class="opt"><input type="radio" name="${name}" value="${it.v}" ${i===(items.find(x=>x.def)?items.findIndex(x=>x.def):0)?'checked':''}/>
        <span class="box"><span class="dot"></span><span><span class="pname">${it.n}</span><span class="pdesc">${it.d}</span></span>${it.tag?`<span class="ptag">${it.tag}</span>`:''}</span></label>`
    ).join('') + `</div>`;
  }
  const getRadio = (name) => (document.querySelector(`input[name="${name}"]:checked`)||{}).value;

  /* ---------- capacity limits (everything runs in-browser, so real memory limits apply) ---------- */
  const mbLabel = (mb) => mb >= 1024 ? (mb % 1024 === 0 ? (mb/1024)+' GB' : (mb/1024).toFixed(1)+' GB') : mb+' MB';
  const LIMITS_BY_ID = {
    'video-gif': { note:'Keep clips to a few seconds — GIFs grow fast. A desktop is recommended.', softMB:60, hardMB:250 },
    'video-join': { note:'All the clips are held in memory at once, so keep the total under a few hundred MB. A desktop is recommended.', softMB:100, hardMB:300 },
    'image-collage': { note:'All the photos are held in memory together, so very large photos may need a computer.', softMB:40, hardMB:150 },
    'video-subtitles': { note:'Short clips work best. The whole video is re-encoded with the words drawn in; a desktop is recommended.', softMB:100, hardMB:350 },
    'video-mute': { note:'The picture is copied without re-encoding, so even large clips are quick.', softMB:200, hardMB:1024 },
    'ringtone': { note:'Only the part you pick is kept, so long songs are fine.', softMB:150, hardMB:600 },
    'audiogram': { note:'Only the clip you pick is used. Each second of video is drawn on your device, so keep it short.', softMB:150, hardMB:600 },
    'screenshot': { note:'Very large screenshots are fine on a computer.', softMB:40, hardMB:200 },
    'palette': { note:'The picture is shrunk before the colours are worked out, so any size is quick.', softMB:40, hardMB:200 },
  };
  function limitsFor(id){
    if (LIMITS_BY_ID[id]) return LIMITS_BY_ID[id];
    const eng = (TOOLS[id]||{}).engine;
    if (eng === 'ffmpeg') return { note:'Short clips work best. Large or high-resolution videos need more memory; a desktop is recommended.', softMB:100, hardMB:350 };
    if (eng === 'mixed') return { note:'Photos are quick. Videos take longer and need more memory; a desktop is recommended for them.', softMB:100, hardMB:350 };
    if (id === 'strip-metadata') return { note:'Photos are quick. Videos are copied without re-encoding, so even large clips are fast.', softMB:200, hardMB:1024 };
    if (eng === 'heic') return { note:'Large, high-resolution photos need more memory.', softMB:40, hardMB:100 };
    if (eng === 'face') return { note:'First use downloads a small face-finding model (~6 MB), cached for later and offline use.', softMB:40, hardMB:150 };
    if (eng === 'speech') return { note:'First use downloads a speech model (40–80 MB), cached afterwards. Longer recordings take longer; a computer is faster than a phone.', softMB:100, hardMB:500 };
    if (eng === 'background') return { note:'First use downloads a background model (~40 MB), cached for later and offline use.', softMB:20, hardMB:60 };
    return { note:'Large, high-resolution photos need more memory.', softMB:40, hardMB:150 };
  }

  /* ---------- round 15: screenshot beautifier ---------- */
  const SHOT_BGS = {
    sunset: ['Sunset', ['#ff9a8b', '#ff6a88', '#ff99ac']],
    ocean: ['Ocean', ['#2b5876', '#4e4376']],
    ink: ['Ink & gold', ['#141019', '#3a2c55', '#cca24e']],
    mint: ['Mint', ['#a8edea', '#7ed6c4']],
    peach: ['Peach', ['#ffecd2', '#fcb69f']],
    sky: ['Sky', ['#89f7fe', '#66a6ff']],
    white: ['Plain white', ['#ffffff']],
    custom: ['My colour', null],
  };
  const SHOT_SIZES = { auto: ['Fit the screenshot', 0, 0], x: ['X / Twitter post 1600 × 900', 1600, 900], li: ['LinkedIn post 1200 × 627', 1200, 627], sq: ['Square 1080 × 1080', 1080, 1080], ig: ['Instagram portrait 1080 × 1350', 1080, 1350] };
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function paintBackground(ctx, W, H, key, custom) {
    const stops = key === 'custom' ? [custom || '#cca24e'] : SHOT_BGS[key][1];
    if (stops.length === 1) { ctx.fillStyle = stops[0]; ctx.fillRect(0, 0, W, H); return; }
    const g = ctx.createLinearGradient(0, 0, W, H);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  // Draws the screenshot (with an optional window or phone frame) on a background. scale < 1 is used for the live preview.
  function drawShot(img, o, scale = 1) {
    const iw = img.width, ih = img.height;
    const radius = { none: 0, small: 0.012, large: 0.03 }[o.radius] ?? 0.012;
    let fw = iw, fh = ih, top = 0, side = 0;
    if (o.frame === 'light' || o.frame === 'dark') { top = Math.max(26, Math.round(iw * 0.032)); fh = ih + top; }
    if (o.frame === 'phone') { side = Math.round(Math.max(iw, ih) * 0.035); fw = iw + side * 2; fh = ih + side * 2; }
    const padF = { s: 0.05, m: 0.09, l: 0.15 }[o.pad] ?? 0.09;
    const size = SHOT_SIZES[o.size] || SHOT_SIZES.auto;
    let W, H, k;
    if (!size[1]) { const p = Math.round(Math.max(fw, fh) * padF); W = fw + p * 2; H = fh + p * 2; k = 1; }
    else { W = size[1]; H = size[2]; const p = Math.round(Math.min(W, H) * padF); k = Math.min((W - p * 2) / fw, (H - p * 2) / fh); }
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(W * scale)); c.height = Math.max(1, Math.round(H * scale));
    const ctx = c.getContext('2d'); ctx.scale(scale, scale);
    paintBackground(ctx, W, H, o.bg, o.color);
    const dw = fw * k, dh = fh * k, x = (W - dw) / 2, y = (H - dh) / 2;
    const r = (o.frame === 'phone' ? 0.08 : radius) * Math.max(dw, dh) * (o.frame === 'phone' ? 0.6 : 1);
    if (o.shadow) {
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = Math.max(dw, dh) * 0.04; ctx.shadowOffsetY = Math.max(dw, dh) * 0.015;
      roundRectPath(ctx, x, y, dw, dh, r); ctx.fillStyle = o.frame === 'dark' || o.frame === 'phone' ? '#1c1c1e' : '#ffffff'; ctx.fill(); ctx.restore();
    }
    ctx.save(); roundRectPath(ctx, x, y, dw, dh, r); ctx.clip();
    if (o.frame === 'light' || o.frame === 'dark') {
      const th = top * k;
      ctx.fillStyle = o.frame === 'dark' ? '#2b2b2f' : '#ececef'; ctx.fillRect(x, y, dw, th);
      ['#ff5f57', '#febc2e', '#28c840'].forEach((col, i) => { ctx.beginPath(); ctx.arc(x + th * (0.62 + i * 0.62), y + th / 2, th * 0.17, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); });
      ctx.fillStyle = o.frame === 'dark' ? '#3a3a40' : '#ffffff';
      roundRectPath(ctx, x + dw * 0.3, y + th * 0.22, dw * 0.4, th * 0.56, th * 0.2); ctx.fill();
      ctx.drawImage(img, x, y + th, dw, dh - th);
    } else if (o.frame === 'phone') {
      ctx.fillStyle = '#111114'; ctx.fillRect(x, y, dw, dh);
      const s = side * k, ir = r * 0.7;
      ctx.save(); roundRectPath(ctx, x + s, y + s, dw - s * 2, dh - s * 2, ir); ctx.clip(); ctx.drawImage(img, x + s, y + s, dw - s * 2, dh - s * 2); ctx.restore();
    } else {
      ctx.drawImage(img, x, y, dw, dh);
    }
    ctx.restore();
    return { canvas: c, W, H };
  }
  let shotState = null;
  async function setupShot(host, file) {
    if (shotState && shotState.image && shotState.image.close) shotState.image.close();
    const image = await loadImage(file);
    shotState = { image };
    const sel = (id, label, entries, def) => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${entries.map(([v, n]) => `<option value="${v}"${v === def ? ' selected' : ''}>${n}</option>`).join('')}</select></div>`;
    host.innerHTML = `<canvas class="live-preview" id="sh-prev" aria-label="Preview"></canvas>
      <div class="field-row">${sel('sh-bg', 'Background', Object.entries(SHOT_BGS).map(([k, v]) => [k, v[0]]), 'ink')}<div class="field"><label for="sh-color">My colour</label><input type="color" id="sh-color" value="#cca24e"/></div></div>
      <div class="field-row">${sel('sh-frame', 'Frame', [['none', 'No frame'], ['light', 'Browser window (light)'], ['dark', 'Browser window (dark)'], ['phone', 'Phone']], 'light')}${sel('sh-size', 'Size', Object.entries(SHOT_SIZES).map(([k, v]) => [k, v[0]]), 'auto')}</div>
      <div class="field-row">${sel('sh-pad', 'Space around it', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], 'm')}${sel('sh-radius', 'Corners', [['none', 'Square'], ['small', 'Slightly rounded'], ['large', 'Rounded']], 'small')}</div>
      <label class="opt-check"><input type="checkbox" id="sh-shadow" checked/> Soft shadow</label>`;
    const draw = () => {
      if (!shotState) return;
      const prev = $('sh-prev'); if (!prev) return;
      const o = readShotOpts();
      const full = drawShot(shotState.image, o, 1e-6); // size only
      const scale = Math.min(1, 560 / full.W);
      const out = drawShot(shotState.image, o, scale);
      prev.width = out.canvas.width; prev.height = out.canvas.height; prev.getContext('2d').drawImage(out.canvas, 0, 0);
    };
    host.querySelectorAll('select,input').forEach((el) => el.addEventListener('input', draw));
    host.querySelectorAll('select,input').forEach((el) => el.addEventListener('change', draw));
    draw();
  }
  const readShotOpts = () => ({ bg: $('sh-bg').value, color: $('sh-color').value, frame: $('sh-frame').value, size: $('sh-size').value, pad: $('sh-pad').value, radius: $('sh-radius').value, shadow: $('sh-shadow').checked });

  /* ---------- round 15: colour palette from a photo (median cut) ---------- */
  function medianCut(pixels, n) {
    let boxes = [pixels];
    const range = (box, ch) => { let lo = 255, hi = 0; for (const p of box) { if (p[ch] < lo) lo = p[ch]; if (p[ch] > hi) hi = p[ch]; } return hi - lo; };
    while (boxes.length < n) {
      let bi = -1, best = -1, bch = 0;
      boxes.forEach((b, i) => { if (b.length < 2) return; for (let ch = 0; ch < 3; ch++) { const r = range(b, ch) * Math.sqrt(b.length); if (r > best) { best = r; bi = i; bch = ch; } } });
      if (bi < 0 || best <= 0) break;
      const b = boxes[bi].slice().sort((p, q) => p[bch] - q[bch]); const mid = b.length >> 1;
      boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
    }
    const total = pixels.length || 1;
    return boxes.filter((b) => b.length).map((b) => {
      let r = 0, g = 0, bl = 0; for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
      return { rgb: [Math.round(r / b.length), Math.round(g / b.length), Math.round(bl / b.length)], share: b.length / total };
    });
  }
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const rgbHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  async function extractPalette(file, n, order) {
    const img = await loadImage(file);
    const s = Math.min(1, 160 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height); if (img.close) img.close();
    const d = ctx.getImageData(0, 0, c.width, c.height).data; const px = [];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 128) px.push([d[i], d[i + 1], d[i + 2]]);
    let cols = medianCut(px, n * 2);
    // merge colours that look the same, keep the n most used
    const merged = [];
    for (const col of cols.sort((a, b) => b.share - a.share)) {
      const near = merged.find((m) => Math.hypot(m.rgb[0] - col.rgb[0], m.rgb[1] - col.rgb[1], m.rgb[2] - col.rgb[2]) < 26);
      if (near) near.share += col.share; else merged.push({ ...col });
    }
    cols = merged.slice(0, n);
    if (order === 'light') cols.sort((a, b) => lum(b.rgb) - lum(a.rgb));
    else cols.sort((a, b) => b.share - a.share);
    return cols.map((c) => ({ hex: rgbHex(c.rgb), rgb: c.rgb, pct: Math.round(c.share * 100) }));
  }
  async function paletteCard(file, cols) {
    const img = await loadImage(file);
    const W = 1200, thumbH = Math.round(Math.min(700, W * img.height / img.width)), sw = 220;
    const c = document.createElement('canvas'); c.width = W; c.height = thumbH + sw + 60;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    const k = Math.max(W / img.width, thumbH / img.height); const dw = img.width * k, dh = img.height * k;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, thumbH); ctx.clip(); ctx.drawImage(img, (W - dw) / 2, (thumbH - dh) / 2, dw, dh); ctx.restore(); if (img.close) img.close();
    const cw = W / cols.length;
    cols.forEach((col, i) => {
      ctx.fillStyle = col.hex; ctx.fillRect(i * cw, thumbH, Math.ceil(cw), sw);
      ctx.fillStyle = '#141019'; ctx.font = '600 26px Inter, system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(col.hex.toUpperCase(), i * cw + cw / 2, thumbH + sw + 40);
    });
    return c;
  }
  let paletteCols = [];

  /* ---------- round 15: QR codes (qrcode-generator, MIT) ---------- */
  let qrLib = null;
  function ensureQr() {
    if (window.qrcode) return Promise.resolve(window.qrcode);
    if (!qrLib) qrLib = new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/inkwellmedia/vendor/qrcode-generator-1.4.4.js'; s.onload = () => res(window.qrcode); s.onerror = () => { qrLib = null; rej(new Error('qr-load')); }; document.head.append(s); });
    return qrLib;
  }
  const qrEsc = (v) => String(v).replace(/([\\;,:"])/g, '\\$1');
  function qrPayload() {
    const kind = $('qr-kind').value, v = (id) => ($(id) ? $(id).value.trim() : '');
    if (kind === 'wifi') { const ssid = v('qr-ssid'); if (!ssid) return ''; const sec = $('qr-sec').value; return `WIFI:T:${sec};S:${qrEsc(ssid)};${sec === 'nopass' ? '' : `P:${qrEsc(v('qr-pass'))};`}${$('qr-hidden').checked ? 'H:true;' : ''};`; }
    if (kind === 'email') { const to = v('qr-to'); if (!to) return ''; const q = new URLSearchParams(); if (v('qr-subj')) q.set('subject', v('qr-subj')); if (v('qr-body')) q.set('body', v('qr-body')); const qs = q.toString().replace(/\+/g, '%20'); return `mailto:${to}${qs ? '?' + qs : ''}`; }
    if (kind === 'phone') { const n = v('qr-num').replace(/[^\d+]/g, ''); if (!n) return ''; return $('qr-sms').checked ? `SMSTO:${n}:${v('qr-msg')}` : `tel:${n}`; }
    let t = v('qr-text'); if (kind === 'link' && t && !/^[a-z][a-z0-9+.-]*:/i.test(t)) t = 'https://' + t;
    return t;
  }
  let qrLogo = null;
  async function drawQr(px) {
    const lib = await ensureQr();
    const text = qrPayload(); if (!text) return null;
    const ecc = qrLogo ? 'H' : 'M';
    const qr = lib(0, ecc); qr.addData(unescape(encodeURIComponent(text)), 'Byte'); qr.make();
    const n = qr.getModuleCount(), margin = +$('qr-margin').value;
    const c = document.createElement('canvas'); c.width = c.height = px;
    const ctx = c.getContext('2d'); const cell = px / (n + margin * 2);
    ctx.fillStyle = $('qr-bgc').value; ctx.fillRect(0, 0, px, px); ctx.fillStyle = $('qr-fg').value;
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qr.isDark(r, col)) ctx.fillRect(Math.floor((col + margin) * cell), Math.floor((r + margin) * cell), Math.ceil(cell), Math.ceil(cell));
    if (qrLogo) {
      const box = px * 0.22, x = (px - box) / 2;
      ctx.fillStyle = $('qr-bgc').value; roundRectPath(ctx, x - box * 0.08, x - box * 0.08, box * 1.16, box * 1.16, box * 0.16); ctx.fill();
      const k = Math.min(box / qrLogo.width, box / qrLogo.height); const w = qrLogo.width * k, h = qrLogo.height * k;
      ctx.drawImage(qrLogo, (px - w) / 2, (px - h) / 2, w, h);
    }
    return { canvas: c, qr, n, margin, text };
  }
  function qrSvg(qr, n, margin, fg, bg) {
    const size = n + margin * 2; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
  }
  function contrastOk(a, b) {
    const L = (h) => { const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    const [x, y] = [L(a), L(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) >= 3 && x < y;
  }
  function setupQr(host) {
    qrLogo = null;
    host.innerHTML = `<canvas class="live-preview" id="qr-prev" width="280" height="280" style="max-width:280px;margin:6px auto 14px"></canvas>
      <div class="field"><label for="qr-kind">What should it open?</label><select id="qr-kind"><option value="link">A website link</option><option value="text">Plain text</option><option value="wifi">Join a Wi-Fi network</option><option value="email">Write an email</option><option value="phone">Call or text a number</option></select></div>
      <div id="qr-fields"></div>
      <div class="field-row"><div class="field"><label for="qr-fg">Code colour</label><input type="color" id="qr-fg" value="#000000"/></div><div class="field"><label for="qr-bgc">Background</label><input type="color" id="qr-bgc" value="#ffffff"/></div></div>
      <div class="field-row"><div class="field"><label for="qr-size">Size</label><select id="qr-size"><option value="512">512 px (screens)</option><option value="1024" selected>1024 px (most uses)</option><option value="2048">2048 px (print)</option></select></div><div class="field"><label for="qr-fmt">File type</label><select id="qr-fmt"><option value="png">PNG picture</option><option value="svg">SVG (sharp at any size, for print)</option></select></div></div>
      <div class="field-row"><div class="field"><label for="qr-margin">White border</label><select id="qr-margin"><option value="1">Thin</option><option value="4" selected>Standard</option><option value="6">Wide</option></select></div><div class="field"><label for="qr-logo">Logo in the middle (optional)</label><input type="file" id="qr-logo" accept="image/*"/></div></div>
      <p class="note-soft" id="qr-warn" style="text-align:left;margin:0 0 12px"></p>
      <p class="suite-link" style="text-align:left">Need to change where the code points after it’s printed, or count scans? <a href="https://blot.inkwelltools.com/?utm_source=inkwelltools&amp;utm_medium=media&amp;utm_campaign=qr" target="_blank" rel="noopener">Inkwell Blot</a> makes editable QR codes with scan counts.</p>`;
    const fields = () => {
      const k = $('qr-kind').value, f = $('qr-fields');
      const inp = (id, label, type = 'text', ph = '') => `<div class="field"><label for="${id}">${label}</label><input type="${type}" id="${id}" placeholder="${ph}" autocomplete="off"/></div>`;
      if (k === 'wifi') f.innerHTML = inp('qr-ssid', 'Network name') + `<div class="field-row">${inp('qr-pass', 'Password')}<div class="field"><label for="qr-sec">Security</label><select id="qr-sec"><option value="WPA">WPA / WPA2 / WPA3</option><option value="WEP">WEP (old)</option><option value="nopass">No password</option></select></div></div><label class="opt-check"><input type="checkbox" id="qr-hidden"/> Hidden network</label>`;
      else if (k === 'email') f.innerHTML = inp('qr-to', 'Email address', 'email', 'you@example.com') + inp('qr-subj', 'Subject (optional)') + inp('qr-body', 'Message (optional)');
      else if (k === 'phone') f.innerHTML = inp('qr-num', 'Phone number', 'tel', '+1 603 555 0123') + `<label class="opt-check"><input type="checkbox" id="qr-sms"/> Start a text message instead of a call</label>` + inp('qr-msg', 'Text message (optional)');
      else f.innerHTML = k === 'link' ? inp('qr-text', 'Link', 'url', 'https://example.com') : `<div class="field"><label for="qr-text">Text</label><textarea id="qr-text" rows="3"></textarea></div>`;
      f.querySelectorAll('input,select,textarea').forEach((el) => { el.addEventListener('input', draw); el.addEventListener('change', draw); });
      draw();
    };
    let pending = 0;
    const draw = async () => {
      const ticket = ++pending;
      const prev = $('qr-prev'); if (!prev) return;
      const ctx = prev.getContext('2d');
      let out = null; try { out = await drawQr(560); } catch (_) {}
      if (ticket !== pending || !$('qr-prev')) return;
      prev.width = prev.height = 560; prev.style.width = '280px';
      if (!out) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 560, 560); ctx.fillStyle = '#9a90ad'; ctx.font = '500 26px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Your code appears here', 280, 286); $('go').disabled = true; $('qr-warn').textContent = ''; return; }
      ctx.drawImage(out.canvas, 0, 0);
      $('go').disabled = false;
      const warn = [];
      if (!contrastOk($('qr-fg').value, $('qr-bgc').value)) warn.push('Some phones can’t read light codes on dark backgrounds or low-contrast colours. Scan it before you print.');
      if (out.text.length > 300) warn.push('That’s a lot of text, so the code is dense. Shorter text scans more easily.');
      if (qrLogo) warn.push('With a logo, the code uses extra error correction so it still scans. Test it with your phone.');
      $('qr-warn').textContent = warn.join(' ');
    };
    if (document.body.dataset.qrkind) $('qr-kind').value = document.body.dataset.qrkind;
    $('qr-kind').addEventListener('change', fields);
    ['qr-fg', 'qr-bgc', 'qr-margin'].forEach((id) => { $(id).addEventListener('input', draw); $(id).addEventListener('change', draw); });
    $('qr-logo').addEventListener('change', async (e) => { const f = e.target.files[0]; qrLogo = null; if (f) { try { qrLogo = await loadImage(f); } catch (_) { qrLogo = null; } } draw(); });
    fields();
  }

  /* ---------- round 15: audiogram background card ---------- */
  const AG_SHAPES = { sq: [1080, 1080, 'Square 1080 × 1080 (Instagram, LinkedIn, X)'], v: [1080, 1920, 'Vertical 1080 × 1920 (Reels, TikTok, Stories)'], w: [1920, 1080, 'Wide 1920 × 1080 (YouTube)'] };
  async function audiogramCard({ W, H, bg, accent, title, sub, art }) {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const pad = Math.round(Math.min(W, H) * 0.08); const wide = W > H;
    let textTop = pad, textLeft = pad, textW = W - pad * 2;
    if (art) {
      const size = wide ? H - pad * 2 : Math.round(Math.min(W - pad * 2, H * 0.42));
      const k = Math.max(size / art.width, size / art.height); const dw = art.width * k, dh = art.height * k;
      ctx.save(); roundRectPath(ctx, pad, pad, size, size, size * 0.05); ctx.clip(); ctx.drawImage(art, pad + (size - dw) / 2, pad + (size - dh) / 2, dw, dh); ctx.restore();
      if (wide) { textLeft = pad * 2 + size; textW = W - textLeft - pad; } else textTop = pad * 1.5 + size;
    }
    const big = Math.round(Math.min(W, H) * 0.062);
    ctx.fillStyle = '#ffffff'; ctx.font = `600 ${big}px Fraunces, Georgia, serif`; ctx.textBaseline = 'top';
    const tl = wrapLines(ctx, title, textW).slice(0, 3);
    tl.forEach((ln, i) => ctx.fillText(ln, textLeft, textTop + i * big * 1.18));
    let y = textTop + tl.length * big * 1.18 + (tl.length ? big * 0.4 : 0);
    if (sub) { const s = Math.round(big * 0.55); ctx.font = `500 ${s}px Inter, system-ui, sans-serif`; ctx.fillStyle = accent; wrapLines(ctx, sub, textW).slice(0, 2).forEach((ln, i) => ctx.fillText(ln, textLeft, y + i * s * 1.3)); y += s * 2.8; }
    // the moving wave goes in a band across the lower part of the card
    const waveH = Math.round(H * (wide ? 0.26 : 0.18)); const waveY = Math.round(H - pad - waveH);
    const waveX = wide && art ? textLeft : pad, waveW = (wide && art ? textW : W - pad * 2);
    return { png: await canvasBlob(c, 'image/png'), wave: { x: waveX, y: waveY, w: Math.round(waveW / 2) * 2, h: Math.round(waveH / 2) * 2 } };
  }
  const parseTime = (v) => { const s = String(v || '').trim(); if (!s) return 0; const p = s.split(':').map(Number); if (p.some(isNaN)) return NaN; return p.reduce((a, b) => a * 60 + b, 0); };
  const fmtClock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  function startPicker(host, file, inputId) {
    const url = URL.createObjectURL(file); if (clipUrl) URL.revokeObjectURL(clipUrl); clipUrl = url;
    const tag = isVideoFile(file) ? 'video' : 'audio';
    host.insertAdjacentHTML('afterbegin', `<${tag} id="sp-media" src="${url}" controls preload="metadata" style="width:100%;${tag === 'video' ? 'max-height:220px;border-radius:10px;' : ''}margin:4px 0 6px"></${tag}><button type="button" class="linkbtn" id="sp-set" style="margin:0 0 12px">Start from where it’s playing now</button>`);
    $('sp-set').addEventListener('click', () => { const t = $('sp-media').currentTime || 0; $(inputId).value = fmtClock(t); $(inputId).dispatchEvent(new Event('input', { bubbles: true })); });
  }

  const TOOLS = {
    'image-compress': {
      group:'Images', engine:'canvas', batch:true, name:'Compress image', blurb:'Shrink a JPG or PNG for email & web', icon:ICONS.img,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'JPG, PNG, WebP or HEIC · select several for a ZIP',
      options(host){ host.innerHTML = radios('q',[
        {v:'small',n:'Smaller file',d:'Best for email and quick sharing'},
        {v:'balanced',n:'Balanced',d:'A good mix of size and quality',tag:'Recommended',def:true},
        {v:'best',n:'Best quality',d:'Keeps it crisp, shrinks a little less'},
      ]); },
      async run(file){
        const q = {small:0.5,balanced:0.72,best:0.88}[getRadio('q')||'balanced'];
        const alpha = /png|webp/i.test(file.type);
        const type = alpha ? 'image/webp' : 'image/jpeg';
        const ext = alpha ? 'webp' : 'jpg';
        const blob = await canvasProcess(file,{type,quality:q});
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-compressed.'+ext, mime:type, compare:true };
      },
    },
    'image-convert': {
      group:'Images', engine:'canvas', batch:true, name:'Convert image', blurb:'JPG ↔ PNG ↔ WebP', icon:ICONS.convert,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'JPG, PNG, WebP or HEIC · select several for a ZIP',
      options(host){ const want = document.body.dataset.format || 'jpg'; host.innerHTML = radios('fmt',[
        {v:'jpg',n:'JPG',d:'Small and universal (no transparency)',def: want === 'jpg'},
        {v:'png',n:'PNG',d:'Lossless, keeps transparency',def: want === 'png'},
        {v:'webp',n:'WebP',d:'Small and keeps transparency',def: want === 'webp'},
      ]); },
      async run(file){
        const f = getRadio('fmt')||'jpg';
        const type = {jpg:'image/jpeg',png:'image/png',webp:'image/webp'}[f];
        const blob = await canvasProcess(file,{type,quality:0.92});
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.'+(f==='jpg'?'jpg':f), mime:type, compare:true };
      },
    },
    'image-resize': {
      group:'Images', engine:'canvas', batch:true, name:'Resize image', blurb:'Exact sizes for Instagram, Etsy, YouTube & more', icon:ICONS.resize,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'JPG, PNG, WebP or HEIC · select several for a ZIP',
      options(host){
        const wanted = document.body.dataset.preset || '';
        const groups = [...new Set(RESIZE_PRESETS.map(p => p.g))];
        const presetOptions = groups.map(g => `<optgroup label="${g}">` + RESIZE_PRESETS.filter(p => p.g === g).map(p => `<option value="${p.id}" ${p.id === (wanted || 'ig-portrait') ? 'selected' : ''}>${p.n}${p.w ? ` — ${p.w} × ${p.h}` : ''}</option>`).join('') + `</optgroup>`).join('');
        host.innerHTML = radios('rmode',[
          {v:'preset',n:'Size for a website or app',d:'Instagram, LinkedIn, YouTube, Etsy, Shopify, email',tag:'Easiest',def:true},
          {v:'width',n:'Fit within a width',d:'Set a maximum width and keep the shape'},
          {v:'exact',n:'Exact width and height',d:'Crop to fill, or fit inside with a border'},
          {v:'percent',n:'Scale by percentage',d:'For example, 50% of the original size'},
        ]) + `<div class="rs-panel" data-for="preset"><div class="field"><label for="rs-preset">Where is it going?</label><select id="rs-preset">${presetOptions}</select></div><p class="note-soft rs-tip" id="rs-tip"></p></div>
        <div class="rs-panel hidden" data-for="width"><div class="field"><label for="maxw">Maximum width (pixels)</label><input type="number" id="maxw" value="1280" min="16" max="10000" /></div></div>
        <div class="rs-panel hidden" data-for="exact"><div class="field"><label>Width and height (pixels)</label><div class="row"><div><input type="number" id="rs-w" value="1200" min="16" max="10000" aria-label="Width in pixels"/></div><div><input type="number" id="rs-h" value="1200" min="16" max="10000" aria-label="Height in pixels"/></div></div></div></div>
        <div class="rs-panel hidden" data-for="percent"><div class="field"><label for="rs-pct">Percentage of the original size</label><input type="number" id="rs-pct" value="50" min="1" max="400" /></div></div>
        <div class="rs-panel" data-for="preset exact" id="rs-fitbox"><div class="field"><label for="rs-fit">If the shape is different</label><select id="rs-fit"><option value="fill">Crop to fill (centred)</option><option value="fit">Fit inside and add a border</option><option value="stretch">Stretch to fit</option></select></div>
        <div class="field rs-bg-field hidden"><label for="rs-bg">Border colour</label><input type="color" id="rs-bg" value="#ffffff" /></div></div>
        <div class="field"><label for="rs-fmt">Save as</label><select id="rs-fmt"><option value="auto">Same kind as the original (JPG for HEIC)</option><option value="jpg">JPG</option><option value="png">PNG</option><option value="webp">WebP</option></select></div>`;
        const sync = () => {
          const mode = getRadio('rmode') || 'preset';
          const preset = presetById($('rs-preset').value);
          host.querySelectorAll('.rs-panel').forEach(el => el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(mode)));
          if (mode === 'preset' && preset && preset.long) $('rs-fitbox').classList.add('hidden');
          $('rs-tip').textContent = preset ? [preset.tip || '', preset.w ? `Output: ${preset.w} × ${preset.h} px.` : ''].filter(Boolean).join(' ') : '';
          host.querySelector('.rs-bg-field').classList.toggle('hidden', $('rs-fit').value !== 'fit');
        };
        host.addEventListener('change', sync); sync();
      },
      async run(file){
        const img = await loadImage(file);
        const mode = getRadio('rmode') || 'preset';
        let w = img.width, h = img.height, fit = 'stretch', bg = null, maxBytes = 0, note = '';
        const clampDim = (v) => Math.max(16, Math.min(10000, Math.round(v)));
        if (mode === 'width') { const maxW = clampDim(parseInt($('maxw').value || '1280', 10)); if (w > maxW) { h = h * maxW / w; w = maxW; } }
        else if (mode === 'percent') { const pct = Math.max(1, Math.min(400, parseFloat($('rs-pct').value || '50'))) / 100; w = Math.max(1, w * pct); h = Math.max(1, h * pct); }
        else if (mode === 'exact') { w = clampDim(parseInt($('rs-w').value || '1200', 10)); h = clampDim(parseInt($('rs-h').value || '1200', 10)); fit = $('rs-fit').value; }
        else {
          const preset = presetById($('rs-preset').value) || RESIZE_PRESETS[0];
          maxBytes = preset.maxBytes || 0;
          if (preset.long) { const scale = Math.min(1, preset.long / Math.max(w, h)); w = w * scale; h = h * scale; }
          else {
            fit = $('rs-fit').value; w = preset.w; h = preset.h;
            if (img.width < preset.w * 0.9 && img.height < preset.h * 0.9) note = `${file.name} was smaller than ${preset.w} × ${preset.h}, so it was enlarged and may look soft. Start from a bigger photo if you can.`;
          }
        }
        if (fit === 'fit') bg = $('rs-bg').value || '#ffffff';
        const fmt = $('rs-fmt').value;
        const alphaIn = /png|webp/i.test(file.type);
        const type = fmt === 'jpg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : (alphaIn ? (/webp/i.test(file.type) ? 'image/webp' : 'image/png') : 'image/jpeg');
        if (type === 'image/jpeg' && !bg) bg = '#ffffff';
        const canvas = drawToCanvas(img, w, h, { fit, bg });
        if (typeof img.close === 'function') img.close();
        let blob = await encodeCanvas(canvas, type, type === 'image/png' ? undefined : 0.9, maxBytes);
        if (maxBytes && blob.size > maxBytes && type === 'image/png') { blob = await encodeCanvas(canvas, 'image/jpeg', 0.9, maxBytes); note = (note ? note + ' ' : '') + 'Saved as JPG to stay under 2 MB.'; return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-${canvas.width}x${canvas.height}.jpg`, mime:'image/jpeg', compare:false, note }; }
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-${canvas.width}x${canvas.height}.`+extFor(type), mime:type, compare:false, note };
      },
    },
    'remove-background': {
      group:'Images', engine:'background', name:'Remove background', blurb:'Cut out a subject with private browser AI', icon:ICONS.sparkle,
      accept:'image/*', dropText:'Drop an image, or click to choose', dropSub:'JPG, PNG, or WebP',
      options(host){ host.innerHTML = `<div class="model-note"><b>One-time model download on first use</b><span>After the model is cached, background removal runs offline. The image itself always stays on your device.</span></div>`; },
      async run(file){
        const blob = await removeImageBackground(file);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-no-background.png', mime:'image/png', compare:false };
      },
    },
    'image-crop': {
      group:'Images', engine:'canvas', name:'Crop image', blurb:'Drag to keep exactly what you need', icon:ICONS.crop,
      accept:'image/*,.heic,.heif', dropText:'Drop an image, or click to choose', dropSub:'Pick a shape, then drag to choose what to keep',
      async options(host, file){ await setupCropEditor(host, file); },
      async run(file){ const out = await cropImage(file); return { blob:out.blob, name:file.name.replace(/\.[^.]+$/,'')+'-cropped.'+out.ext, mime:out.type, compare:false }; },
    },
    'image-rotate': {
      group:'Images', engine:'canvas', batch:true, name:'Rotate & flip', blurb:'Turn or mirror an image instantly', icon:ICONS.rotate,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'Rotate or flip · select several to do them all the same way',
      options(host){ setupRotateControls(host); },
      async run(file){ const out = await rotateImage(file); return { blob:out.blob, name:file.name.replace(/\.[^.]+$/,'')+'-rotated.'+out.ext, mime:out.type, compare:false }; },
    },
    'image-watermark': {
      group:'Images', engine:'canvas', batch:true, name:'Add watermark', blurb:'Add text or a logo before sharing', icon:ICONS.watermark,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'Text or logo · select several to watermark them all at once',
      options(host){ host.innerHTML = `<div class="field"><label for="wm-text">Watermark text</label><input type="text" id="wm-text" value="© Inkwell" maxlength="120" /></div><div class="field"><label for="wm-image">Or use a logo/image</label><input type="file" id="wm-image" accept="image/*" /></div><div class="field"><div class="row"><div><label for="wm-position">Position</label><select id="wm-position"><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option value="top-right">Top right</option><option value="top-left">Top left</option><option value="center">Center</option></select></div><div><label for="wm-color">Text color</label><input type="color" id="wm-color" value="#ffffff" /></div></div></div><div class="field"><label for="wm-opacity">Opacity <span id="wm-opacity-value">65%</span></label><input type="range" id="wm-opacity" min="5" max="100" value="65" /></div><div class="field"><label for="wm-size">Size <span id="wm-size-value">18%</span></label><input type="range" id="wm-size" min="5" max="50" value="18" /></div>`; $('wm-opacity').addEventListener('input',()=>{$('wm-opacity-value').textContent=$('wm-opacity').value+'%';}); $('wm-size').addEventListener('input',()=>{$('wm-size-value').textContent=$('wm-size').value+'%';}); },
      async run(file){ const out = await watermarkImage(file); return { blob:out.blob, name:file.name.replace(/\.[^.]+$/,'')+'-watermarked.'+out.ext, mime:out.type, compare:false }; },
    },
    'heic-jpg': {
      group:'Images', engine:'heic', batch:true, name:'HEIC → JPG', blurb:'Turn iPhone photos into JPGs', icon:ICONS.convert,
      accept:'.heic,.heif,image/heic,image/heif', dropText:'Drop HEIC photos, or click to choose', dropSub:'iPhone .heic / .heif files · select several for a ZIP',
      options(host){ host.innerHTML=''; },
      async run(file){
        const { heicTo } = await ensureHeic();
        const blob = await heicTo({ blob:file, type:'image/jpeg', quality:0.9 });
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.jpg', mime:'image/jpeg', compare:true };
      },
    },

    'strip-metadata': {
      group:'Images', engine:'canvas', batch:true, name:'Remove location & camera data', blurb:'Strip GPS, camera and date before sharing', icon:ICONS.shield,
      accept:'image/*,.heic,.heif,video/*', dropText:'Drop photos or videos, or click to choose', dropSub:'JPG, PNG, WebP, HEIC, MP4 or MOV · several at once for a ZIP',
      async options(host, file){
        host.innerHTML = `<div class="meta-found" id="meta-found"><p class="note-soft">Checking what this file gives away…</p></div>`;
        if (selectedFiles.length > 1) { $('meta-found').innerHTML = `<p class="note-soft" style="text-align:left">We’ll remove the location, camera details and dates from all ${selectedFiles.length} files, then tell you what was found.</p>`; return; }
        try {
          const meta = isVideoFile(file) ? await readVideoMeta(file) : await readImageMeta(file);
          const found = describeRemoved(meta);
          const where = meta.gps || meta.location;
          $('meta-found').innerHTML = found.length
            ? `<div class="meta-alert"><b>This file includes: ${escapeHtml(found.join(', '))}.</b>${where ? `<span>The location points near ${fmtCoord(where.lat)}, ${fmtCoord(where.lon)}. Anyone you send the original to can see it.</span>` : ''}</div>`
            : `<p class="note-soft" style="text-align:left">We didn’t find location or camera details in this file. Saving a clean copy is still a safe habit before you share it.</p>`;
        } catch (_) { $('meta-found').innerHTML = ''; }
      },
      async run(file){
        const base = file.name.replace(/\.[^.]+$/,'');
        if (isVideoFile(file)) {
          const before = await readVideoMeta(file).catch(() => ({}));
          const { outExt, mime } = sameVideoContainer(file);
          const blob = await runFfmpeg(file, ['-map_metadata','-1','-map_chapters','-1','-c','copy', ...(/^(mp4|mov|m4v)$/.test(outExt) ? ['-movflags','+faststart'] : [])], 'out.'+outExt, mime);
          const found = describeRemoved(before);
          return { blob, name:`${base}-clean.${outExt}`, mime, compare:false, note: found.length ? `Removed from ${file.name}: ${found.join(', ')}.` : `${file.name}: no location found; saved a clean copy.` };
        }
        const before = await readImageMeta(file).catch(() => ({}));
        const img = await loadImage(file);
        const out = isHeicFile(file) ? { type:'image/jpeg', quality:0.92 } : sameTypeOutput(file);
        const canvas = drawToCanvas(img, img.width, img.height);
        if (typeof img.close === 'function') img.close();
        const blob = await encodeCanvas(canvas, out.type, out.quality);
        const after = await readImageMeta(blob).catch(() => ({}));
        if (after.gps) throw new Error('strip-failed');
        const found = describeRemoved(before);
        return { blob, name:`${base}-clean.${extFor(out.type)}`, mime:out.type, compare:false, note: found.length ? `Removed from ${file.name}: ${found.join(', ')}.` : `${file.name}: nothing to remove — saved a clean copy anyway.` };
      },
    },

    'video-compress': {
      group:'Video & audio', engine:'ffmpeg', name:'Compress video', blurb:'Shrink a clip for email, Discord or upload', icon:ICONS.vid,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'MP4, MOV, WebM · short clips work best',
      options(host){
        const wanted = document.body.dataset.vpreset || '26';
        host.innerHTML = radios('vq',[
          {v:'d20',n:'Under 20 MB — for Discord',d:'Fits Discord’s free upload limit',def: wanted === 'd20'},
          {v:'e25',n:'Under 18 MB — for email',d:'Fits a 25 MB email limit once it’s attached',def: wanted === 'e25'},
          {v:'w16',n:'Under 16 MB — for WhatsApp',d:'Sends quickly on any connection and fits WhatsApp’s long-standing 16 MB video limit',def: wanted === 'w16'},
          {v:'30',n:'Smaller file',d:'Best for quick sharing'},
          {v:'26',n:'Balanced',d:'A good mix of size and quality',tag:'Recommended',def: wanted === '26'},
          {v:'22',n:'Best quality',d:'Keeps it crisp, shrinks a little less'},
        ]) + `<p class="note-soft" style="text-align:left;margin:-4px 0 16px">The size targets lower the quality and, for longer clips, the resolution, so the file fits. Very long videos may need trimming first.</p>`;
      },
      async run(file){
        const choice = getRadio('vq')||'26';
        const base = file.name.replace(/\.[^.]+$/,'');
        if (choice === 'd20' || choice === 'e25' || choice === 'w16') {
          const limitBytes = choice === 'd20' ? 20 * 1048576 : choice === 'w16' ? 15.5 * 1000000 : 18 * 1000000;
          const blob = await fitVideoUnder(file, limitBytes, []);
          const label = { d20:'20 MB Discord', e25:'email', w16:'16 MB WhatsApp' }[choice];
          const note = blob.size <= limitBytes ? `${fmtSize(blob.size)} — under the ${label} limit.` : `Got it down to ${fmtSize(blob.size)}, still a little over. Try trimming the clip first.`;
          return { blob, name:`${base}-${({ d20:'discord', e25:'email', w16:'whatsapp' })[choice]}.mp4`, mime:'video/mp4', compare:true, note };
        }
        const blob = await runFfmpeg(file, ['-c:v','libx264','-crf',choice,'-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart'], 'out.mp4','video/mp4');
        return { blob, name:base+'-compressed.mp4', mime:'video/mp4', compare:true };
      },
    },
    'video-mp4': {
      group:'Video & audio', engine:'ffmpeg', name:'Convert to MP4', blurb:'MOV & others → universal MP4', icon:ICONS.convert,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'MOV, WebM, MKV, AVI · short clips work best',
      options(host){ host.innerHTML = `<p class="note-soft" style="text-align:left;margin:0 0 16px">Converts to an MP4 that plays just about everywhere.</p>`; },
      async run(file){
        const blob = await runFfmpeg(file, ['-c:v','libx264','-crf','23','-preset','veryfast','-c:a','aac','-b:a','128k','-movflags','+faststart'], 'out.mp4','video/mp4');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.mp4', mime:'video/mp4', compare:false };
      },
    },
    'video-gif': {
      group:'Video & audio', engine:'ffmpeg', name:'Video → GIF', blurb:'Make a sharp, looping GIF from a clip', icon:ICONS.gif,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'Pick a few seconds — GIFs get big fast',
      options(host, file){
        setupClipPicker(host, file, { defaultLength: 5, extraHtml: radios('gs',[
          {v:'320',n:'Small',d:'320 px wide — smallest file',def:true},
          {v:'480',n:'Medium',d:'480 px wide'},
          {v:'640',n:'Large',d:'640 px wide — sharpest, biggest'},
        ]) + `<div class="field" style="margin-top:12px"><label for="gif-fps">Smoothness</label><select id="gif-fps"><option value="10">10 frames a second — smaller file</option><option value="15" selected>15 frames a second — smoother</option><option value="20">20 frames a second — smoothest, biggest</option></select></div>` });
      },
      async run(file){
        const { s, len } = readClip($('opts'));
        const w = getRadio('gs')||'320', fps = $('gif-fps').value || '15';
        const blob = await runFfmpeg(file, ['-t', len.toFixed(2), '-vf', `fps=${fps},scale=${w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, '-loop','0'], 'out.gif','image/gif', ['-ss', s.toFixed(2)]);
        const note = len > 15 ? 'That’s a long GIF. If it’s too big to share, pick a shorter stretch or the Small size.' : '';
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.gif', mime:'image/gif', compare:false, note };
      },
    },
    'extract-audio': {
      group:'Video & audio', engine:'ffmpeg', name:'Extract audio', blurb:'Pull the sound out as an MP3', icon:ICONS.audio,
      accept:'video/*,audio/*', dropText:'Drop a video, or click to choose', dropSub:'Gets the audio track as an MP3',
      options(host){ host.innerHTML = `<p class="note-soft" style="text-align:left;margin:0 0 16px">Saves the audio track as an MP3 file.</p>`; },
      async run(file){
        const blob = await runFfmpeg(file, ['-vn','-c:a','libmp3lame','-q:a','2'], 'out.mp3','audio/mpeg');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.mp3', mime:'audio/mpeg', compare:false };
      },
    },
    'video-trim': {
      group:'Video & audio', engine:'ffmpeg', name:'Trim video', blurb:'Keep just the part you want, to the frame', icon:ICONS.scissor,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'Preview it, then set a start and end',
      options(host, file){
        setupClipPicker(host, file, { extraHtml: radios('tm',[
          {v:'exact',n:'Exact cut',d:'Starts and ends on the frames you chose (slower)',tag:'Recommended',def:true},
          {v:'fast',n:'Fast cut',d:'No re-encoding, but cuts snap to the nearest keyframe'},
        ]) });
      },
      async run(file){
        const { s, len } = readClip($('opts'));
        const base = file.name.replace(/\.[^.]+$/,'');
        if ((getRadio('tm') || 'exact') === 'fast') {
          const { outExt, mime } = sameVideoContainer(file);
          const blob = await runFfmpeg(file, ['-t', len.toFixed(3), '-c','copy','-avoid_negative_ts','make_zero'], 'out.'+outExt, mime, ['-ss', s.toFixed(3)]);
          return { blob, name:`${base}-trimmed.${outExt}`, mime, compare:false };
        }
        const blob = await runFfmpeg(file, ['-t', len.toFixed(3), '-c:v','libx264','-crf','20','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart'], 'out.mp4','video/mp4', ['-ss', s.toFixed(3)]);
        return { blob, name:`${base}-trimmed.mp4`, mime:'video/mp4', compare:false };
      },
    },

    'blur-faces': {
      group:'Images', engine:'face', name:'Blur faces & plates', blurb:'Hide faces, license plates and names before posting', icon:ICONS.blur,
      accept:'image/*,.heic,.heif', dropText:'Drop a photo, or click to choose', dropSub:'Faces are found for you · drag to cover anything else',
      async options(host, file){ await setupBlurEditor(host, file); },
      async run(file){
        const out = await blurImage(file);
        return { blob:out.blob, name:file.name.replace(/\.[^.]+$/,'')+'-blurred.'+extFor(out.type), mime:out.type, compare:false, note:`${out.count} area${out.count === 1 ? '' : 's'} hidden. Location and camera details were removed too.` };
      },
    },
    'image-to-size': {
      group:'Images', engine:'canvas', batch:true, name:'Compress to a size', blurb:'Get a photo under 100 KB, 200 KB, 1 MB or any limit', icon:ICONS.target,
      accept:'image/*,.heic,.heif', dropText:'Drop images, or click to choose', dropSub:'For upload forms with a size limit · select several for a ZIP',
      options(host){
        const wanted = document.body.dataset.target || '200';
        const sizes = [['50','50 KB'],['100','100 KB'],['200','200 KB'],['500','500 KB'],['1024','1 MB'],['2048','2 MB']];
        host.innerHTML = `<p class="plabel">Keep each file under</p><div class="transform-controls" role="group" aria-label="Size limit">${sizes.map(([v,n]) => `<button type="button" class="transform-btn" data-kb="${v}" aria-pressed="${v === wanted}">${n}</button>`).join('')}</div>
          <div class="field"><label for="ts-kb">Or type a limit in KB</label><input type="number" id="ts-kb" min="10" max="51200" value="${wanted}" /></div>
          <label class="opt-check"><input type="checkbox" id="ts-alpha"/> Keep transparency (saves as WebP instead of JPG)</label>
          <p class="note-soft" style="text-align:left;margin:8px 0 16px">We keep the full size and lower the quality first. Only if that isn’t enough do we make the picture smaller.</p>`;
        host.querySelectorAll('[data-kb]').forEach((b) => b.addEventListener('click', () => { host.querySelectorAll('[data-kb]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); $('ts-kb').value = b.dataset.kb; }));
        $('ts-kb').addEventListener('input', () => host.querySelectorAll('[data-kb]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.kb === $('ts-kb').value))));
      },
      async run(file){
        const kb = Math.max(10, Math.min(51200, parseInt($('ts-kb').value || '200', 10)));
        const limit = kb * 1024;
        const base = file.name.replace(/\.[^.]+$/,'');
        if (file.size <= limit && /jpe?g/i.test(file.type)) {
          return { blob:file, name:`${base}-under-${kb}kb.jpg`, mime:file.type, compare:true, note:`${file.name} was already under ${kb} KB, so it’s unchanged.` };
        }
        try {
          const out = await compressToSize(file, limit, $('ts-alpha').checked);
          const note = `${file.name}: ${fmtSize(out.blob.size)}, under ${kb} KB${out.resized ? ` (made smaller: ${Math.round(out.w)} × ${Math.round(out.h)} px, from ${out.ow} × ${out.oh})` : ' at full size'}.`;
          return { blob:out.blob, name:`${base}-under-${kb}kb.${extFor(out.type)}`, mime:out.type, compare:true, note };
        } catch (e) {
          if (/size-impossible/.test(e.message)) throw new Error('size-impossible');
          throw e;
        }
      },
    },
    'id-photo': {
      group:'Images', engine:'face', name:'Passport & ID photo', blurb:'U.S., UK, EU, Canada & Australia sizes, plus a print sheet', icon:ICONS.idcard,
      accept:'image/*,.heic,.heif', dropText:'Drop a photo of your face, or click to choose', dropSub:'Facing the camera, against a plain light wall',
      async options(host, file){ await setupIdEditor(host, file); },
      async run(file){
        const out = await renderIdPhoto();
        const blob = await encodeCanvas(out.canvas, 'image/jpeg', 0.95);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-${out.label}.jpg`, mime:'image/jpeg', compare:false, note: out.copies ? `${out.copies} copies on a 4 × 6 in sheet at 300 dpi. Print at actual size (no “fit to page”), then cut along the grey lines.` : 'Saved at print quality. Check it against your country’s official rules before submitting.' };
      },
    },
    'video-captions': {
      group:'Video & audio', engine:'speech', name:'Auto captions', blurb:'Turn speech into subtitles (SRT, VTT) on your device', icon:ICONS.captions,
      accept:'video/*,audio/*', dropText:'Drop a video or audio file, or click to choose', dropSub:'MP4, MOV, WebM, MP3, WAV, M4A',
      options(host){
        host.innerHTML = `<div class="model-note"><b>One-time speech model download on first use</b><span>About 40 MB (Fast) or 80 MB (Accurate), then cached. Your video and its audio never leave your device.</span></div>`
          + `<div class="field"><label for="cap-lang">Spoken language</label><select id="cap-lang"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="pt">Portuguese</option><option value="it">Italian</option><option value="nl">Dutch</option><option value="">Other (detect it)</option></select></div>`
          + radios('capm',[
            {v:'tiny',n:'Fast',d:'Smaller download, quicker; good for clear speech',def:true},
            {v:'base',n:'Accurate',d:'Bigger download, slower; better with accents and noise'},
          ])
          + `<div class="field"><label for="cap-out">Download as</label><select id="cap-out"><option value="srt">SRT subtitles (YouTube, Facebook, LinkedIn, Premiere)</option><option value="vtt">VTT subtitles (web players, Vimeo)</option><option value="txt">Plain transcript (.txt)</option><option value="mp4">MP4 with captions viewers can turn on</option><option value="burn">MP4 with captions always shown (burned in)</option></select></div><div id="cap-style" class="hidden">${CAPTION_STYLE_HTML('cb')}</div>`
          + `<p class="note-soft" style="text-align:left;margin:0 0 16px">Machine captions get most words right but not all. Read them through before you publish; an SRT opens in any text editor.</p>`;
        $('cap-out').addEventListener('change', () => $('cap-style').classList.toggle('hidden', $('cap-out').value !== 'burn'));
        if (document.body.dataset.capout === 'burn') { $('cap-out').value = 'burn'; $('cap-style').classList.remove('hidden'); $('cb-pos').value = 'middle'; $('cb-look').value = 'box'; }
      },
      async run(file){
        const base = file.name.replace(/\.[^.]+$/,'');
        const lang = $('cap-lang').value; const size = getRadio('capm') || 'tiny'; const outFmt = $('cap-out').value;
        const model = `Xenova/whisper-${size}${lang === 'en' ? '.en' : ''}`;
        $('w-label').textContent = 'Getting the audio ready…';
        const raw = await runFfmpeg(file, ['-vn','-ac','1','-ar','16000','-f','f32le'], 'out.raw', 'application/octet-stream');
        const audio = new Float32Array(await raw.arrayBuffer());
        if (audio.length < 16000 * 0.5) throw new Error('no-speech');
        const total = audio.length / 16000;
        const res = await transcribe(audio, model, lang || null);
        const cues = captionCues(res.chunks, total);
        if (!cues.length) throw new Error('no-speech');
        const preview = cues.slice(0, 3).map((c) => c.text).join(' ');
        const note = `${cues.length} captions over ${Math.round(total)} seconds. Starts: “${preview.slice(0, 140)}${preview.length > 140 ? '…' : ''}”`;
        if (outFmt === 'txt') return { blob:new Blob([res.text.trim() + '\n'], { type:'text/plain' }), name:`${base}-transcript.txt`, mime:'text/plain', compare:false, note };
        if (outFmt === 'vtt') return { blob:new Blob([toVtt(cues)], { type:'text/vtt' }), name:`${base}.vtt`, mime:'text/vtt', compare:false, note };
        if (outFmt === 'burn' && isVideoFile(file)) {
          const out = await burnCaptions(file, cues, readCaptionStyle('cb'));
          return { blob:out.blob, name:`${base}-captioned.mp4`, mime:'video/mp4', compare:false, note: note + ' The captions are part of the picture. Tip: also download the SRT so you can fix a word later and burn it again with Add subtitles to video.' };
        }
        if (outFmt === 'mp4' && isVideoFile(file)) {
          const f = await ensureFfmpeg();
          await f.writeFile('subs.srt', new TextEncoder().encode(toSrt(cues)));
          const blob = await runFfmpeg(file, ['-i','subs.srt','-map','0:v?','-map','0:a?','-map','1:0','-c:v','copy','-c:a','copy','-c:s','mov_text','-metadata:s:s:0',`language=${({en:'eng',es:'spa',fr:'fra',de:'deu',pt:'por',it:'ita',nl:'nld'})[lang] || 'und'}`,'-movflags','+faststart','-map_metadata','-1'], 'out.mp4', 'video/mp4');
          try { await f.deleteFile('subs.srt'); } catch (_) {}
          return { blob, name:`${base}-captioned.mp4`, mime:'video/mp4', compare:false, note: note + ' Turn captions on with the CC button in your player.' };
        }
        return { blob:new Blob([toSrt(cues)], { type:'application/x-subrip' }), name:`${base}.srt`, mime:'application/x-subrip', compare:false, note };
      },
    },
    'video-join': {
      group:'Video & audio', engine:'ffmpeg', combine:true, canGo:(fs) => fs.length >= 2,  name:'Join videos', blurb:'Put clips together into one MP4', icon:ICONS.join,
      accept:'video/*', dropText:'Drop two or more videos, or click to choose', dropSub:'Pick them all at once; you can change the order next',
      options(host){
        const draw = () => {
          host.innerHTML = `<p class="plabel">Order</p><ol class="join-list">${selectedFiles.map((f, i) => `<li><span>${escapeHtml(f.name)}</span><span class="join-btns"><button type="button" class="transform-btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${escapeHtml(f.name)} up">↑</button><button type="button" class="transform-btn" data-down="${i}" ${i === selectedFiles.length - 1 ? 'disabled' : ''} aria-label="Move ${escapeHtml(f.name)} down">↓</button></span></li>`).join('')}</ol>`
            + (selectedFiles.length < 2 ? `<p class="err" style="margin:8px 0">Choose at least two videos. Click “Change file” and pick them together.</p>` : `<p class="note-soft" style="text-align:left;margin:0 0 16px">The joined video takes the size of the first clip; others are fitted inside it with a border if their shape differs.</p>`);
          host.querySelectorAll('[data-up],[data-down]').forEach((b) => b.addEventListener('click', () => {
            const i = +(b.dataset.up ?? b.dataset.down), j = b.dataset.up !== undefined ? i - 1 : i + 1;
            [selectedFiles[i], selectedFiles[j]] = [selectedFiles[j], selectedFiles[i]]; draw();
          }));
          setTimeout(() => { $('go').disabled = selectedFiles.length < 2; }, 0);
        };
        draw();
      },
      async runAll(files){
        const blob = await joinClips(files);
        return { blob, name:`joined-${files.length}-clips.mp4`, mime:'video/mp4', compare:false, note:`Joined ${files.length} clips in this order: ${files.map((f) => f.name).join(', ')}.` };
      },
    },
    'video-mute': {
      group:'Video & audio', engine:'ffmpeg', name:'Remove sound', blurb:'Mute a video without re-encoding it', icon:ICONS.mute,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'MP4, MOV, WebM · quick, no quality loss',
      options(host){ host.innerHTML = `<p class="note-soft" style="text-align:left;margin:0 0 16px">Removes the audio track and keeps the picture exactly as it is.</p>`; },
      async run(file){
        const { outExt, mime } = sameVideoContainer(file);
        const blob = await runFfmpeg(file, ['-an','-c:v','copy', ...(/^(mp4|mov|m4v)$/.test(outExt) ? ['-movflags','+faststart'] : [])], 'out.'+outExt, mime);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-muted.'+outExt, mime, compare:false };
      },
    },
    'video-speed': {
      group:'Video & audio', engine:'ffmpeg', name:'Change speed', blurb:'Slow motion or sped up, with matching sound', icon:ICONS.speed,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'MP4, MOV, WebM · short clips work best',
      options(host){ host.innerHTML = radios('spd',[
        {v:'0.5',n:'0.5× — half speed',d:'Slow motion, twice as long'},
        {v:'0.75',n:'0.75×',d:'A little slower'},
        {v:'1.25',n:'1.25×',d:'A little faster'},
        {v:'1.5',n:'1.5×',d:'Faster',def:true},
        {v:'2',n:'2× — double speed',d:'Half as long'},
        {v:'4',n:'4× — time-lapse',d:'Sound is removed at this speed'},
      ]) + `<label class="opt-check"><input type="checkbox" id="spd-mute"/> Remove the sound</label>`; },
      async run(file){
        const k = parseFloat(getRadio('spd') || '1.5');
        const mute = $('spd-mute').checked || k > 2;
        const args = ['-filter:v', `setpts=PTS/${k}`];
        if (mute) args.push('-an'); else args.push('-filter:a', `atempo=${k}`);
        const blob = await runFfmpeg(file, [...args, '-c:v','libx264','-crf','21','-preset','veryfast','-pix_fmt','yuv420p', ...(mute ? [] : ['-c:a','aac','-b:a','160k']), '-movflags','+faststart'], 'out.mp4', 'video/mp4');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-${String(k).replace('.','_')}x.mp4`, mime:'video/mp4', compare:false };
      },
    },
    'audio-level': {
      group:'Video & audio', engine:'ffmpeg', name:'Even out volume', blurb:'Fix audio that’s too quiet or uneven', icon:ICONS.level,
      accept:'video/*,audio/*', dropText:'Drop a video or audio file, or click to choose', dropSub:'MP4, MOV, MP3, WAV, M4A',
      options(host){ host.innerHTML = radios('lv',[
        {v:'-16',n:'Standard',d:'For podcasts, YouTube and most social video',def:true,tag:'Recommended'},
        {v:'-14',n:'Louder',d:'Matches Spotify and other music apps'},
        {v:'-23',n:'Broadcast',d:'The quieter TV standard (EBU R128)'},
      ]) + `<p class="note-soft" style="text-align:left;margin:0 0 16px">Raises quiet parts and tames loud ones so the whole file plays at a steady level. Video is copied as it is.</p>`; },
      async run(file){
        const target = getRadio('lv') || '-16';
        const af = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
        const base = file.name.replace(/\.[^.]+$/,'');
        if (isVideoFile(file)) {
          const blob = await runFfmpeg(file, ['-c:v','copy','-af',af,'-ar','48000','-c:a','aac','-b:a','192k','-movflags','+faststart'], 'out.mp4', 'video/mp4');
          return { blob, name:`${base}-levelled.mp4`, mime:'video/mp4', compare:false };
        }
        const blob = await runFfmpeg(file, ['-vn','-af',af,'-ar','44100','-c:a','libmp3lame','-q:a','2'], 'out.mp3', 'audio/mpeg');
        return { blob, name:`${base}-levelled.mp3`, mime:'audio/mpeg', compare:false };
      },
    },

    'video-vertical': {
      group:'Video & audio', engine:'ffmpeg', name:'Resize video for Reels & TikTok', blurb:'Make a video 9:16, 4:5 or square without cutting it off', icon:ICONS.vertical,
      accept:'video/*', dropText:'Drop a video, or click to choose', dropSub:'MP4, MOV, WebM · short clips work best',
      options(host){
        const want = document.body.dataset.shape || '9x16';
        host.innerHTML = `<div class="field"><label for="vv-shape">Shape</label><select id="vv-shape">${Object.entries(SHAPES).map(([k, v]) => `<option value="${k}" ${k === want ? 'selected' : ''}>${v[2]}</option>`).join('')}</select></div>`
          + radios('vvfill', [
            { v:'blur', n:'Blurred background', d:'Keeps the whole picture; fills the space with a soft blurred copy', def:true, tag:'Popular' },
            { v:'crop', n:'Crop to fill', d:'Fills the frame by trimming the sides (or top and bottom)' },
            { v:'black', n:'Black bars', d:'Keeps the whole picture with plain black around it' },
            { v:'white', n:'White bars', d:'Keeps the whole picture with plain white around it' },
          ])
          + `<label class="opt-check"><input type="checkbox" id="vv-hd" checked/> Full HD (1080 wide). Untick for a faster, smaller 720 version.</label>`;
      },
      async run(file){
        const shape = $('vv-shape').value; let [W, H] = SHAPES[shape] || SHAPES['9x16'];
        if (!$('vv-hd').checked) { W = Math.round(W * 2 / 3 / 2) * 2; H = Math.round(H * 2 / 3 / 2) * 2; }
        const fill = getRadio('vvfill') || 'blur';
        const blob = await runFfmpeg(file, ['-filter_complex', reframeGraph(W, H, fill), '-map', '[v]', '-map', '0:a?', '-c:v','libx264','-crf','21','-preset','veryfast','-c:a','aac','-b:a','160k','-movflags','+faststart'], 'out.mp4', 'video/mp4');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-${shape.replace('x','x')}.mp4`, mime:'video/mp4', compare:false, note:`${W} × ${H} MP4, ready to upload.` };
      },
    },
    'video-subtitles': {
      group:'Video & audio', engine:'ffmpeg', combine:true, canGo:(fs) => fs.filter(isVideoFile).length === 1 && fs.filter((f) => /\.(srt|vtt)$/i.test(f.name)).length === 1,  name:'Add subtitles to video', blurb:'Burn an SRT or VTT file into the picture', icon:ICONS.subs,
      accept:'video/*,.srt,.vtt,text/vtt,application/x-subrip', dropText:'Drop a video and its subtitle file, or click to choose', dropSub:'Pick both at once: MP4, MOV or WebM + .srt or .vtt',
      options(host){
        const v = selectedFiles.filter(isVideoFile), s = selectedFiles.filter((f) => /\.(srt|vtt)$/i.test(f.name));
        const ok = v.length === 1 && s.length === 1;
        host.innerHTML = (ok ? `<p class="note-soft" style="text-align:left;margin:0 0 12px">Video: <b>${escapeHtml(v[0].name)}</b><br>Subtitles: <b>${escapeHtml(s[0].name)}</b></p>` : `<p class="err" style="margin:8px 0">Choose one video and one .srt or .vtt file together. Click “Change file” and pick both. Don’t have subtitles yet? Make them with <a href="/auto-captions/">Auto captions</a>.</p>`)
          + CAPTION_STYLE_HTML('bs') + `<p class="note-soft" style="text-align:left;margin:0 0 16px">The words become part of the picture, so they show everywhere, even where viewers can’t turn captions on.</p>`;
        setTimeout(() => { $('go').disabled = !ok; }, 0);
      },
      async runAll(files){
        const video = files.find(isVideoFile), sub = files.find((f) => /\.(srt|vtt)$/i.test(f.name));
        if (!video || !sub) throw new Error('need-video-subs');
        const cues = parseSubs(await sub.text());
        if (!cues.length) throw new Error('no-subs');
        const out = await burnCaptions(video, cues, readCaptionStyle('bs'));
        return { blob:out.blob, name:video.name.replace(/\.[^.]+$/,'')+'-subtitled.mp4', mime:'video/mp4', compare:false, note:`${out.count} subtitles added to the picture.${out.skipped ? ` The last ${out.skipped} were left out (600 is the most at once).` : ''}` };
      },
    },
    'audio-denoise': {
      group:'Video & audio', engine:'ffmpeg', name:'Reduce background noise', blurb:'Cut hiss, hum and fan noise from voice recordings', icon:ICONS.denoise,
      accept:'video/*,audio/*', dropText:'Drop a video or audio file, or click to choose', dropSub:'MP4, MOV, MP3, WAV, M4A',
      options(host){ host.innerHTML = radios('dn',[
        { v:'light', n:'Light', d:'Gentle clean-up; voices stay natural', def:true },
        { v:'medium', n:'Medium', d:'For noticeable hiss, hum or fan noise', tag:'Most recordings' },
        { v:'strong', n:'Strong', d:'For noisy rooms; voices can sound a little thin' },
      ]) + `<label class="opt-check"><input type="checkbox" id="dn-level" checked/> Also even out the volume</label>`
        + `<p class="note-soft" style="text-align:left;margin:0 0 16px">Works best on steady noise (hiss, hum, air conditioning, computer fans). It can’t remove other people talking or music. Video is copied as it is.</p>`; },
      async run(file){
        const lvl = getRadio('dn') || 'light';
        const nr = { light: 10, medium: 18, strong: 28 }[lvl];
        let af = `highpass=f=70,lowpass=f=12000,afftdn=nr=${nr}:nf=-40:tn=1`;
        if (lvl === 'strong') af += ',anlmdn=s=0.0008';
        if ($('dn-level').checked) af += ',loudnorm=I=-16:TP=-1.5:LRA=11';
        const base = file.name.replace(/\.[^.]+$/,'');
        if (isVideoFile(file)) {
          const blob = await runFfmpeg(file, ['-c:v','copy','-af',af,'-ar','48000','-c:a','aac','-b:a','192k','-movflags','+faststart'], 'out.mp4', 'video/mp4');
          return { blob, name:`${base}-clean-audio.mp4`, mime:'video/mp4', compare:false };
        }
        const blob = await runFfmpeg(file, ['-vn','-af',af,'-ar','44100','-c:a','libmp3lame','-q:a','2'], 'out.mp3', 'audio/mpeg');
        return { blob, name:`${base}-clean.mp3`, mime:'audio/mpeg', compare:false };
      },
    },
    'screen-record': {
      group:'Video & audio', engine:'none', noFile:true, name:'Screen recorder', blurb:'Record your screen, a window or a tab, with sound', icon:ICONS.record,
      accept:'', dropText:'', dropSub:'',
      options(host){
        if (!canRecordScreen()) {
          host.innerHTML = `<p class="err" style="margin:8px 0">This browser can’t record the screen. Use Chrome, Edge, Firefox or Safari on a computer; phones and tablets don’t allow it.</p>`;
          setTimeout(() => { $('go').disabled = true; }, 0); return;
        }
        host.innerHTML = `<label class="opt-check"><input type="checkbox" id="sr-mic" checked/> Record my microphone</label>`
          + `<label class="opt-check"><input type="checkbox" id="sr-sys"/> Record sound from the tab or screen (Chrome and Edge)</label>`
          + `<div class="field"><label for="sr-fps">Smoothness</label><select id="sr-fps"><option value="30">30 frames a second (recommended)</option><option value="15">15 frames a second (smaller file, for slides and documents)</option><option value="60">60 frames a second (games and fast motion)</option></select></div>`
          + `<p class="note-soft" style="text-align:left;margin:0 0 16px">Click Start, then choose what to share: your whole screen, a window or a browser tab. The recording stays on this device until you download it. ${/mp4/.test(recorderType()) ? 'It’s saved as an MP4.' : 'It’s saved as a WebM; use Convert to MP4 afterwards if you need one.'}</p>`;
      },
      async run(){
        const out = await recordScreen({ mic: $('sr-mic').checked, systemAudio: $('sr-sys').checked, fps: +$('sr-fps').value });
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{4})$/, '$1-$2');
        return { blob:out.blob, name:`screen-recording-${stamp}.${out.ext}`, mime:out.mime, compare:false, note: out.withSound ? 'Recorded with sound.' : 'Recorded without sound.' };
      },
    },
    'image-collage': {
      group:'Images', engine:'canvas', combine:true, canGo:(fs) => fs.length >= 2,  name:'Photo collage', blurb:'Put several photos into one grid image', icon:ICONS.collage,
      accept:'image/*,.heic,.heif', dropText:'Drop 2 to 24 photos, or click to choose', dropSub:'Pick them all at once; you can change the order next',
      options(host){
        orderList(host, 'Order (left to right, top to bottom)', `<div class="field"><label for="cl-size">Size</label><select id="cl-size">${Object.entries(COLLAGE_SIZES).map(([k, v]) => `<option value="${k}">${v[2]}</option>`).join('')}</select></div>`
          + `<div class="field"><label for="cl-cols">Photos per row</label><select id="cl-cols"><option value="0">Automatic</option>${[1,2,3,4,5,6].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></div>`
          + `<div class="field"><label for="cl-gap">Space between photos</label><select id="cl-gap"><option value="0">None</option><option value="1">Thin</option><option value="2" selected>Medium</option><option value="4">Wide</option></select></div>`
          + `<div class="field"><label for="cl-bg">Background colour</label><input type="color" id="cl-bg" value="#ffffff"/></div>`
          + `<label class="opt-check"><input type="checkbox" id="cl-round"/> Rounded corners</label>`
          + (selectedFiles.length < 2 ? `<p class="err" style="margin:8px 0">Choose at least two photos. Click “Change file” and pick them together.</p>` : selectedFiles.length > 24 ? `<p class="err" style="margin:8px 0">That’s more than 24 photos; only the first 24 are used.</p>` : ''));
        setTimeout(() => { $('go').disabled = selectedFiles.length < 2; }, 0);
      },
      async runAll(files){
        const use = files.slice(0, 24);
        const out = await makeCollage(use, { size: $('cl-size').value, cols: +$('cl-cols').value, gap: +$('cl-gap').value, bg: $('cl-bg').value, round: $('cl-round').checked });
        const blob = await encodeCanvas(out.canvas, 'image/jpeg', 0.92);
        return { blob, name:`collage-${use.length}-photos.jpg`, mime:'image/jpeg', compare:false, note:`${use.length} photos, ${out.W} × ${out.H} px. Each photo is trimmed evenly to fill its space.` };
      },
    },
    'image-text': {
      group:'Images', engine:'canvas', name:'Add text to image', blurb:'Captions, memes, “SOLD” stamps and titles', icon:ICONS.text,
      accept:'image/*,.heic,.heif', dropText:'Drop a photo, or click to choose', dropSub:'JPG, PNG, WebP or HEIC',
      async options(host, file){ await setupTextEditor(host, file); },
      async run(file){
        const { image } = textState;
        const c = document.createElement('canvas'); c.width = image.width; c.height = image.height;
        const ctx = c.getContext('2d'); ctx.drawImage(image, 0, 0); drawTextOn(ctx, c.width, c.height, readTextOpts());
        const out = imageOutput(file); const blob = await canvasBlob(c, out.type, out.quality);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-text.'+out.ext, mime:out.type, compare:false, note:'Saved at full size. Location and camera details are left out of the new copy.' };
      },
    },
    'profile-picture': {
      group:'Images', engine:'canvas', name:'Profile picture maker', blurb:'Round profile photo for LinkedIn, Slack and more', icon:ICONS.profile,
      accept:'image/*,.heic,.heif', dropText:'Drop a photo of you, or click to choose', dropSub:'Your face is found and centred for you',
      async options(host, file){ await setupProfileEditor(host, file); },
      async run(file){
        const out = renderProfile();
        const blob = await canvasBlob(out.canvas, out.png ? 'image/png' : 'image/jpeg', out.png ? undefined : 0.94);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+`-profile-${out.canvas.width}.${out.png ? 'png' : 'jpg'}`, mime: out.png ? 'image/png' : 'image/jpeg', compare:false, note:`${out.canvas.width} × ${out.canvas.width} px. Most sites crop to a circle themselves, so the square option works everywhere too.` };
      },
    },
    'favicon': {
      group:'Images', engine:'canvas', name:'Favicon & app icon maker', blurb:'Every icon size for a website, from your logo', icon:ICONS.favicon,
      accept:'image/*,.svg', dropText:'Drop your logo, or click to choose', dropSub:'A square PNG or SVG works best',
      options(host){
        host.innerHTML = `<div class="field"><label for="fv-name">Website or app name</label><input type="text" id="fv-name" placeholder="My site" maxlength="40"/></div>
          <div class="field-row"><div class="field"><label for="fv-bg">Background</label><select id="fv-bg"><option value="">Transparent</option><option value="#ffffff">White</option><option value="custom">A colour…</option></select></div>
          <div class="field"><label for="fv-color">Colour</label><input type="color" id="fv-color" value="#141019"/></div>
          <div class="field"><label for="fv-pad">Space around the logo</label><select id="fv-pad"><option value="0">None</option><option value="0.06" selected>A little</option><option value="0.14">More</option></select></div></div>
          <label class="opt-check"><input type="checkbox" id="fv-round"/> Rounded square background</label>
          <p class="note-soft" style="text-align:left;margin:0 0 16px">You get a ZIP with favicon.ico (16, 32 and 48 px inside), PNG and SVG icons, Apple touch and Android icons (including a “maskable” one), a site.webmanifest and the lines to paste into your page’s &lt;head&gt;.</p>`;
      },
      async run(file){
        const bgSel = $('fv-bg').value; const bg = bgSel === 'custom' ? $('fv-color').value : bgSel;
        const files = await makeIcons(file, { pad: +$('fv-pad').value, bg, round: $('fv-round').checked, name: $('fv-name').value.trim() });
        const blob = await createZip(files);
        return { blob, name:'favicons.zip', mime:'application/zip', compare:false, note:`${files.length} files: favicon.ico, PNG icons from 16 to 512 px, favicon.svg, site.webmanifest and paste-into-head.html with the HTML to add.` };
      },
    },
    'gif-mp4': {
      group:'Video & audio', engine:'ffmpeg', name:'GIF to MP4', blurb:'Turn a GIF into a small MP4 that plays everywhere', icon:ICONS.gif,
      accept:'image/gif,.gif', dropText:'Drop a GIF, or click to choose', dropSub:'Animated GIFs of any size',
      options(host){ host.innerHTML = radios('gl',[
        { v:'1', n:'Play once', d:'Same length as the GIF', def:true },
        { v:'3', n:'Repeat 3 times', d:'Handy for short loops on Instagram or X' },
        { v:'5', n:'Repeat 5 times', d:'For very short loops' },
      ]) + `<p class="note-soft" style="text-align:left;margin:0 0 16px">MP4s are usually 5–20× smaller than the same GIF and upload anywhere a video does.</p>`; },
      async run(file){
        const loops = +(getRadio('gl') || '1');
        const blob = await runFfmpeg(file, ['-movflags','+faststart','-pix_fmt','yuv420p','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2','-c:v','libx264','-crf','22','-preset','veryfast','-an'], 'out.mp4', 'video/mp4', loops > 1 ? ['-stream_loop', String(loops - 1)] : []);
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'.mp4', mime:'video/mp4', compare:true };
      },
    },
    'before-after': {
      group:'Images', engine:'canvas', combine:true, canGo:(fs) => fs.length === 2,  name:'Before & after picture', blurb:'Two photos side by side with labels', icon:ICONS.beforeafter,
      accept:'image/*,.heic,.heif', dropText:'Drop the before and after photos, or click to choose', dropSub:'Pick both at once; you can swap them next',
      options(host){
        orderList(host, 'Order (first is “before”)', `<div class="field-row"><div class="field"><label for="ba-layout">Layout</label><select id="ba-layout"><option value="side">Side by side</option><option value="stack">One above the other</option></select></div>
          <div class="field"><label for="ba-size">Size</label><select id="ba-size"><option value="auto">Fit the layout</option><option value="square">Square 2048 × 2048</option><option value="portrait">Instagram portrait 1080 × 1350</option><option value="wide">Wide 1920 × 1080</option></select></div></div>
          <div class="field-row"><div class="field"><label for="ba-l1">First label</label><input type="text" id="ba-l1" value="Before" maxlength="24"/></div><div class="field"><label for="ba-l2">Second label</label><input type="text" id="ba-l2" value="After" maxlength="24"/></div></div>
          <label class="opt-check"><input type="checkbox" id="ba-labels" checked/> Show the labels</label>
          <label class="opt-check"><input type="checkbox" id="ba-gap" checked/> White line between the photos</label>`
          + (selectedFiles.length !== 2 ? `<p class="err" style="margin:8px 0">Choose exactly two photos. Click “Change file” and pick both together.</p>` : ''));
        setTimeout(() => { $('go').disabled = selectedFiles.length !== 2; }, 0);
      },
      async runAll(files){
        const out = await beforeAfter(files, { layout:$('ba-layout').value, size:$('ba-size').value, gap:$('ba-gap').checked, labels: $('ba-labels').checked ? [$('ba-l1').value || 'Before', $('ba-l2').value || 'After'] : null });
        const blob = await encodeCanvas(out.canvas, 'image/jpeg', 0.92);
        return { blob, name:'before-and-after.jpg', mime:'image/jpeg', compare:false, note:`${out.W} × ${out.H} px. Each photo is trimmed evenly to fill its half.` };
      },
    },
    'screenshot': {
      group:'Images', engine:'canvas', name:'Screenshot beautifier', blurb:'Put a screenshot on a background, with a window or phone frame', icon:ICONS.screenshot,
      accept:'image/*,.heic,.heif', dropText:'Drop a screenshot, paste one, or click to choose', dropSub:'PNG, JPG or WebP · press Ctrl+V (⌘V on a Mac) to paste',
      async options(host, file){ await setupShot(host, file); },
      async run(file){
        const o = readShotOpts();
        const out = drawShot(shotState.image, o, 1);
        const blob = await encodeCanvas(out.canvas, 'image/png');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-framed.png', mime:'image/png', compare:false, note:`${out.canvas.width} × ${out.canvas.height} px PNG.` };
      },
    },
    'palette': {
      group:'Images', engine:'canvas', name:'Colour palette from a photo', blurb:'Pull the main colours out of any picture, with hex codes', icon:ICONS.palette,
      accept:'image/*,.heic,.heif', dropText:'Drop a photo or logo, or click to choose', dropSub:'JPG, PNG, WebP or HEIC',
      async options(host, file){
        host.innerHTML = `<div class="field-row"><div class="field"><label for="pl-n">How many colours</label><select id="pl-n"><option value="5">5</option><option value="6" selected>6</option><option value="8">8</option><option value="10">10</option></select></div>
          <div class="field"><label for="pl-order">Order</label><select id="pl-order"><option value="share">Most used first</option><option value="light">Lightest to darkest</option></select></div></div>
          <p class="plabel">Click a colour to copy its code</p><div class="palette-swatches" id="pl-sw"></div>
          <div class="settings-row" style="justify-content:flex-start"><button type="button" class="linkbtn" id="pl-css">Copy as CSS</button><span aria-hidden="true">·</span><button type="button" class="linkbtn" id="pl-list">Copy all hex codes</button><span class="set-msg" id="pl-msg" aria-live="polite"></span></div>`;
        const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); $('pl-msg').textContent = msg; setTimeout(() => { if ($('pl-msg')) $('pl-msg').textContent = ''; }, 1800); } catch (_) { $('pl-msg').textContent = text; } };
        const draw = async () => {
          paletteCols = await extractPalette(file, +$('pl-n').value, $('pl-order').value);
          $('pl-sw').innerHTML = paletteCols.map((c) => `<button type="button" data-hex="${c.hex}" title="Copy ${c.hex}"><span style="background:${c.hex}"></span><b>${c.hex.toUpperCase()}</b></button>`).join('');
          $('pl-sw').querySelectorAll('[data-hex]').forEach((b) => b.addEventListener('click', () => copy(b.dataset.hex, `Copied ${b.dataset.hex}`)));
        };
        $('pl-css').addEventListener('click', () => copy(':root {\n' + paletteCols.map((c, i) => `  --color-${i + 1}: ${c.hex};`).join('\n') + '\n}', 'CSS copied'));
        $('pl-list').addEventListener('click', () => copy(paletteCols.map((c) => c.hex).join(', '), 'Copied'));
        $('pl-n').addEventListener('change', draw); $('pl-order').addEventListener('change', draw);
        await draw();
      },
      async run(file){
        if (!paletteCols.length) paletteCols = await extractPalette(file, 6, 'share');
        const canvas = await paletteCard(file, paletteCols);
        const blob = await encodeCanvas(canvas, 'image/png');
        return { blob, name:file.name.replace(/\.[^.]+$/,'')+'-palette.png', mime:'image/png', compare:false, note:`Colours: ${paletteCols.map((c) => c.hex.toUpperCase()).join(', ')}` };
      },
    },
    'qr-code': {
      group:'Images', engine:'canvas', noFile:true, goText:'Download the QR code', noFileNote:'Made on this device; nothing is sent anywhere.', name:'QR code generator', blurb:'Links, Wi-Fi, email or phone, with your colours and logo', icon:ICONS.qr,
      accept:'', dropText:'', dropSub:'',
      options(host){ setupQr(host); },
      async run(){
        const px = +$('qr-size').value;
        const out = await drawQr(px);
        if (!out) throw new Error('qr-empty');
        const base = 'qr-code-' + ($('qr-kind').value);
        if ($('qr-fmt').value === 'svg' && !qrLogo) {
          const svgText = qrSvg(out.qr, out.n, out.margin, $('qr-fg').value, $('qr-bgc').value);
          return { blob:new Blob([svgText], { type:'image/svg+xml' }), name:base + '.svg', mime:'image/svg+xml', compare:false, note:'SVG stays sharp at any size, so it’s best for print.' };
        }
        const blob = await encodeCanvas(out.canvas, 'image/png');
        return { blob, name:base + '.png', mime:'image/png', compare:false, note:`${px} × ${px} px PNG.${$('qr-fmt').value === 'svg' && qrLogo ? ' Saved as PNG because the logo is a picture.' : ''} Scan it with your phone before printing.` };
      },
    },
    'ringtone': {
      group:'Video & audio', engine:'ffmpeg', name:'Ringtone maker', blurb:'Cut a song or clip into an iPhone or Android ringtone', icon:ICONS.ringtone,
      accept:'audio/*,video/*', dropText:'Drop a song or video, or click to choose', dropSub:'MP3, M4A, WAV, MP4 or MOV',
      options(host, file){
        host.innerHTML = `<div class="field-row"><div class="field"><label for="rt-start">Start at (minutes:seconds)</label><input type="text" id="rt-start" value="0:00" inputmode="numeric"/></div>
          <div class="field"><label for="rt-len">Length</label><select id="rt-len"><option value="15">15 seconds</option><option value="20">20 seconds</option><option value="30" selected>30 seconds</option><option value="40">40 seconds (iPhone’s longest)</option></select></div></div>
          <div class="field"><label for="rt-fmt">For</label><select id="rt-fmt"><option value="m4r">iPhone (.m4r)</option><option value="mp3">Android (.mp3)</option></select></div>
          <label class="opt-check"><input type="checkbox" id="rt-fade" checked/> Fade in and out</label>
          <label class="opt-check"><input type="checkbox" id="rt-loud" checked/> Make it loud enough to hear</label>`;
        if (document.body.dataset.rtfmt) $('rt-fmt').value = document.body.dataset.rtfmt;
        startPicker(host, file, 'rt-start');
      },
      async run(file){
        const start = parseTime($('rt-start').value); if (isNaN(start) || start < 0) throw new Error('clip-range');
        const len = +$('rt-len').value, fmt = $('rt-fmt').value;
        const af = [];
        if ($('rt-fade').checked) af.push('afade=t=in:d=0.8', `afade=t=out:st=${Math.max(0, len - 1.5)}:d=1.5`);
        if ($('rt-loud').checked) af.push('loudnorm=I=-14:TP=-1:LRA=11');
        const base = file.name.replace(/\.[^.]+$/,'');
        const common = ['-vn','-t',String(len), ...(af.length ? ['-af', af.join(',')] : []), '-ar','44100'];
        if (fmt === 'mp3') {
          const blob = await runFfmpeg(file, [...common,'-c:a','libmp3lame','-b:a','192k'], 'out.mp3', 'audio/mpeg', ['-ss', String(start)]);
          return { blob, name:`${base}-ringtone.mp3`, mime:'audio/mpeg', compare:false, note:'Android: copy it to the Ringtones folder (or open it on the phone), then pick it in Settings → Sound → Ringtone.' };
        }
        const blob = await runFfmpeg(file, [...common,'-c:a','aac','-b:a','192k','-f','ipod'], 'out.m4r', 'audio/x-m4r', ['-ss', String(start)]);
        return { blob:new Blob([blob], { type:'audio/mp4' }), name:`${base}.m4r`, mime:'audio/mp4', compare:false, note:'iPhone: connect it to a computer, open it in Finder (Mac) or iTunes/Apple Devices (Windows) and drag the .m4r onto the iPhone. Then pick it in Settings → Sounds & Haptics → Ringtone.' };
      },
    },
    'audiogram': {
      group:'Video & audio', engine:'ffmpeg', combine:true, canGo:(fs) => fs.filter((f) => /^audio\//.test(f.type) || isVideoFile(f) || /\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(f.name)).length === 1, name:'Audiogram maker', blurb:'Turn a podcast clip into a video with a moving sound wave', icon:ICONS.audiogram,
      accept:'audio/*,video/*,image/*', dropText:'Drop an audio clip (and a cover picture, if you like), or click to choose', dropSub:'MP3, M4A, WAV or MP4 · add a JPG or PNG for the cover',
      options(host){
        const audio = selectedFiles.find((f) => !/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic)$/i.test(f.name));
        host.innerHTML = `<div class="field"><label for="ag-shape">Shape</label><select id="ag-shape">${Object.entries(AG_SHAPES).map(([k, v]) => `<option value="${k}">${v[2]}</option>`).join('')}</select></div>
          <div class="field"><label for="ag-title">Title</label><input type="text" id="ag-title" maxlength="90" placeholder="Episode 12: Pricing your first product"/></div>
          <div class="field"><label for="ag-sub">Second line (optional)</label><input type="text" id="ag-sub" maxlength="80" placeholder="The Small Business Hour"/></div>
          <div class="field-row"><div class="field"><label for="ag-start">Start at (minutes:seconds)</label><input type="text" id="ag-start" value="0:00" inputmode="numeric"/></div>
          <div class="field"><label for="ag-len">Length</label><select id="ag-len"><option value="15">15 seconds</option><option value="30" selected>30 seconds</option><option value="45">45 seconds</option><option value="60">60 seconds</option><option value="90">90 seconds</option></select></div></div>
          <div class="field-row"><div class="field"><label for="ag-bg">Background</label><input type="color" id="ag-bg" value="#141019"/></div><div class="field"><label for="ag-wave">Wave colour</label><input type="color" id="ag-wave" value="#cca24e"/></div></div>
          <div class="field"><label for="ag-style">Wave style</label><select id="ag-style"><option value="cline">Filled</option><option value="line">Lines</option><option value="p2p">Thin line</option></select></div>
          <p class="note-soft" style="text-align:left;margin:0 0 16px">${selectedFiles.some((f) => /^image\//.test(f.type)) ? 'Your picture is used as the cover.' : 'Tip: choose a cover picture together with the audio to show it on the video.'} Short clips work best; a 30-second clip takes a minute or two.</p>`;
        if (audio) startPicker(host, audio, 'ag-start');
      },
      async runAll(files){
        const audio = files.find((f) => !/^image\//.test(f.type) && !/\.(jpe?g|png|webp|heic)$/i.test(f.name));
        const pic = files.find((f) => f !== audio && (/^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)));
        if (!audio) throw new Error('need-audio');
        const start = parseTime($('ag-start').value); if (isNaN(start) || start < 0) throw new Error('clip-range');
        const len = +$('ag-len').value;
        const [W, H] = AG_SHAPES[$('ag-shape').value];
        const art = pic ? await loadImage(pic) : null;
        const card = await audiogramCard({ W, H, bg: $('ag-bg').value, accent: $('ag-wave').value, title: $('ag-title').value.trim(), sub: $('ag-sub').value.trim(), art });
        if (art && art.close) art.close();
        const f = await ensureFfmpeg(() => { $('w-label').textContent = 'Loading the engine…'; $('w-note').textContent = 'Downloading the media engine for the first time (~30 MB). This only happens once.'; });
        const ext = (audio.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
        await f.writeFile('ag-in.' + ext, await fetchFile(audio));
        await f.writeFile('ag-bg.png', new Uint8Array(await card.png.arrayBuffer()));
        const wv = card.wave, col = $('ag-wave').value.replace('#', '0x');
        $('w-label').textContent = 'Making the video…'; $('w-note').textContent = 'Working on your device. The picture is drawn frame by frame, so this takes a little while.';
        const graph = `[1:a]showwaves=s=${wv.w}x${wv.h}:mode=${$('ag-style').value}:colors=${col}:rate=25:scale=sqrt,format=rgba[w];[0:v][w]overlay=${wv.x}:${wv.y}:shortest=1,format=yuv420p[v]`;
        await f.exec(['-loop','1','-framerate','25','-i','ag-bg.png','-ss',String(start),'-t',String(len),'-i','ag-in.' + ext,'-filter_complex',graph,'-map','[v]','-map','1:a','-map_metadata','-1','-c:v','libx264','-preset','ultrafast','-crf','24','-r','25','-c:a','aac','-b:a','160k','-t',String(len),'-shortest','-movflags','+faststart','ag-out.mp4']);
        const data = await f.readFile('ag-out.mp4');
        for (const n of ['ag-in.' + ext, 'ag-bg.png', 'ag-out.mp4']) { try { await f.deleteFile(n); } catch (_) {} }
        if (!(data && data.length > 1024)) throw new Error('empty-output');
        return { blob:new Blob([data.buffer], { type:'video/mp4' }), name:audio.name.replace(/\.[^.]+$/,'') + '-audiogram.mp4', mime:'video/mp4', compare:false, note:`${W} × ${H}, ${len} seconds. Add captions with Auto captions if you want the words on screen too.` };
      },
    },
    'checkup-fix': {
      group:'Hidden', hidden:true, engine:'mixed', batch:true, name:'Fix my files', blurb:'', icon:ICONS.check,
      accept:'image/*,.heic,.heif,video/*', dropText:'Drop files', dropSub:'',
      options(host){
        const lines = selectedFiles.map(f => { const fx = checkupFixes.get(f) || new Set(); return `<li><b>${escapeHtml(f.name)}</b> — ${[...fx].map(k => FIX_LABELS[k]).join(', ') || 'save a clean copy'}</li>`; }).join('');
        host.innerHTML = `<p class="plabel">What we’ll do</p><ul class="fix-list">${lines}</ul>`;
      },
      async run(file){
        const fx = checkupFixes.get(file) || new Set(['clean']);
        const base = file.name.replace(/\.[^.]+$/,'');
        if (isVideoFile(file)) {
          const stripArgs = ['-map_metadata','-1','-map_chapters','-1'];
          if (fx.has('shrink')) { const blob = await fitVideoUnder(file, 18 * 1000000, stripArgs); return { blob, name:`${base}-fixed.mp4`, mime:'video/mp4', compare:true }; }
          if (fx.has('mp4')) {
            const blob = await runFfmpeg(file, [...stripArgs,'-c:v','libx264','-crf','23','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart'], 'out.mp4','video/mp4');
            return { blob, name:`${base}-fixed.mp4`, mime:'video/mp4', compare:true };
          }
          const { outExt, mime } = sameVideoContainer(file);
          const blob = await runFfmpeg(file, [...stripArgs,'-c','copy'], 'out.'+outExt, mime);
          return { blob, name:`${base}-clean.${outExt}`, mime, compare:false };
        }
        const img = await loadImage(file);
        let w = img.width, h = img.height;
        if (fx.has('shrink')) { const scale = Math.min(1, 2560 / Math.max(w, h)); w *= scale; h *= scale; }
        const keep = sameTypeOutput(file);
        const type = (fx.has('jpg') || isHeicFile(file)) ? 'image/jpeg' : keep.type;
        const canvas = drawToCanvas(img, w, h, { bg: type === 'image/jpeg' ? '#ffffff' : null });
        if (typeof img.close === 'function') img.close();
        const blob = await encodeCanvas(canvas, type, type === 'image/png' ? undefined : (fx.has('shrink') ? 0.82 : 0.92), fx.has('shrink') ? 3 * 1048576 : 0);
        return { blob, name:`${base}-fixed.${extFor(type)}`, mime:type, compare:true };
      },
    },
  };

  /* ---------- hub rendering ---------- */
  const TOOL_PATHS = {
    'image-compress':'/compress-image/',
    'image-convert':'/convert-image/',
    'image-resize':'/resize-image/',
    'remove-background':'/remove-background/',
    'image-crop':'/crop-image/',
    'image-rotate':'/rotate-image/',
    'image-watermark':'/watermark-image/',
    'heic-jpg':'/heic-to-jpg/',
    'strip-metadata':'/remove-photo-location/',
    'video-compress':'/compress-video/',
    'video-mp4':'/convert-to-mp4/',
    'video-gif':'/video-to-gif/',
    'extract-audio':'/extract-audio/',
    'video-trim':'/trim-video/',
    'blur-faces':'/blur-faces/',
    'image-to-size':'/compress-image-to-size/',
    'id-photo':'/passport-photo/',
    'video-captions':'/auto-captions/',
    'video-join':'/join-videos/',
    'video-mute':'/mute-video/',
    'video-speed':'/change-video-speed/',
    'audio-level':'/even-out-audio-volume/',
    'image-text':'/add-text-to-image/',
    'profile-picture':'/profile-picture-maker/',
    'favicon':'/favicon-generator/',
    'gif-mp4':'/gif-to-mp4/',
    'before-after':'/before-and-after-photo/',
    'video-vertical':'/resize-video-for-reels/',
    'video-subtitles':'/add-subtitles-to-video/',
    'audio-denoise':'/remove-background-noise/',
    'screen-record':'/screen-recorder/',
    'image-collage':'/photo-collage/',
    'screenshot':'/screenshot-beautifier/',
    'palette':'/color-palette-from-image/',
    'qr-code':'/qr-code-generator/',
    'ringtone':'/ringtone-maker/',
    'audiogram':'/audiogram-maker/'
  };

  function renderHub() {
    const groups = {};
    for (const id in TOOLS) { const t = TOOLS[id]; if (t.hidden) continue; (groups[t.group] = groups[t.group] || []).push([id,t]); }
    let html = '';
    for (const g in groups) {
      html += `<div class="grouphdr">${g}</div><div class="grid">`;
      for (const [id,t] of groups[g]) {
        html += `<a class="tool" href="${TOOL_PATHS[id]}"><span class="ic">${svg(t.icon)}</span><span><span class="tname">${t.name}</span><span class="tblurb">${t.blurb}</span></span></a>`;
      }
      html += `</div>`;
    }
    $('hub-groups').innerHTML = html;
  }

  /* ---------- tool flow ---------- */
  let current = null, currentId = null, selectedFiles = [], outUrl = null, outName = 'download', lastOutputs = [];
  const show = (which) => {
    ['s-pick','s-ready','s-working','s-done'].forEach(s => $(s).classList.toggle('hidden', s !== which));
    $('tool-capacity').classList.toggle('hidden', (which !== 's-pick' && which !== 's-ready') || !!(current && current.noFile));
  };
  const clearErr = () => $('err-slot').innerHTML = '';
  const showErr = (t,d) => $('err-slot').innerHTML = `<div class="err"><b>${t}</b><br>${d}</div>`;
  let elapsedTimer = null, startedAt = 0, gotRealProgress = false;
  function startWorking(){
    gotRealProgress = false; startedAt = Date.now();
    $('w-track').classList.add('indet'); $('w-pct').textContent = ''; $('w-fill').style.width='0%';
    const tick = () => { const sec = Math.round((Date.now()-startedAt)/1000);
      $('w-elapsed').textContent = (sec < 60 ? sec+'s' : Math.floor(sec/60)+'m '+String(sec%60).padStart(2,'0')+'s') + ' elapsed'; };
    tick(); clearInterval(elapsedTimer); elapsedTimer = setInterval(tick, 1000);
  }
  function stopWorking(){ clearInterval(elapsedTimer); elapsedTimer = null; }
  function setProgress(p){
    p = Math.max(0, Math.min(100, p));
    if (p > 0 && !gotRealProgress) { gotRealProgress = true; $('w-track').classList.remove('indet'); }
    if (gotRealProgress) {
      $('w-fill').style.width = p+'%';
      const sec = (Date.now() - startedAt) / 1000;
      let eta = '';
      if (p >= 3 && p < 99 && sec > 4) { const left = Math.round(sec * (100 - p) / p); eta = left < 60 ? ' · under a minute left' : ` · about ${Math.round(left / 60)} min left`; }
      $('w-pct').textContent = p+'%' + eta;
    }
  }
  function resetSelection(){
    selectedFiles=[]; fileInput.value='';
    if (cropState && cropState.image && typeof cropState.image.close === 'function') cropState.image.close();
    cropState=null; if (clipUrl) { URL.revokeObjectURL(clipUrl); clipUrl = null; } clearErr(); $('done-note').innerHTML=''; $('w-files').innerHTML=''; $('w-files').classList.add('hidden');
  }

  function openTool(id) {
    current = TOOLS[id]; currentId = id; resetSelection();
    $('hub').classList.add('hidden'); $('contact').classList.add('hidden'); $('tool').classList.remove('hidden');
    $('tool-title').textContent = current.name;
    $('file').setAttribute('accept', current.accept);
    if (current.batch || current.combine) $('file').setAttribute('multiple',''); else $('file').removeAttribute('multiple');
    $('drop-big').textContent = current.dropText;
    $('drop-small').textContent = current.dropSub;
    const limits = limitsFor(id);
    $('capacity-recommended').textContent = `Under ~${mbLabel(limits.softMB)} per file`;
    $('capacity-maximum').textContent = `${mbLabel(limits.hardMB)} per file`;
    $('capacity-note').textContent = `Files stay on your device. Available browser memory may limit processing below the maximum. ${limits.note}${current.batch ? ' Batches run one image at a time; the final ZIP also needs memory. Try fewer images if a batch fails.' : ' Choose one file at a time.'}`;
    $('ready-warn').innerHTML=''; $('done-note').innerHTML='';
    document.querySelector('.seo-intro')?.classList.remove('hidden');
    document.querySelector('.faq')?.classList.remove('hidden');
    if (current.engine === 'ffmpeg') ensureFfmpeg().catch(() => {});
    $('change').classList.toggle('hidden', !!current.noFile);
    if (current.noFile) {
      selectedFiles = [new File([], current.name)];
      $('r-name').textContent = current.name; $('r-size').textContent = current.noFileNote || 'Nothing is uploaded; the recording stays on this device.';
      $('go').textContent = current.goText || 'Start recording'; $('go').disabled = true; show('s-ready');
      Promise.resolve(current.options($('opts'))).then(() => { if (currentId !== 'screen-record' || canRecordScreen()) { if (currentId === 'screen-record') $('go').disabled = false; } afterOptions(); });
      window.scrollTo({top:0,behavior:'smooth'});
      return;
    }
    show('s-pick');
    const ph = $('paste-hint'); if (/image/.test(current.accept || '')) addPasteHint(); else if (ph) ph.remove();
    window.scrollTo({top:0,behavior:'smooth'});
  }
  function backToHub(){
    if (document.body.dataset.tool) { window.location.href = '/'; return; }
    $('tool').classList.add('hidden'); $('contact').classList.add('hidden'); $('hub').classList.remove('hidden'); resetSelection();
    document.querySelector('.seo-intro')?.classList.remove('hidden');
    document.querySelector('.faq')?.classList.remove('hidden');
  }

  $('home-btn').addEventListener('click', backToHub);
  $('tool-back').addEventListener('click', backToHub);

  const drop = $('drop'), fileInput = $('file');
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); });

  async function handleFiles(fileList){
    clearErr();
    const incoming = Array.from(fileList);
    const files = (current.batch || current.combine) ? incoming : incoming.slice(0,1);
    const lim = limitsFor(currentId);
    const tooLarge = files.find(file => file.size > lim.hardMB * 1048576);
    if (tooLarge) {
      showErr("That file is too large to process in the browser", `“${tooLarge.name}” is over this tool's ${mbLabel(lim.hardMB)} per-file limit. Nothing is uploaded, so your browser needs enough memory to hold the file while it works.`);
      return;
    }
    selectedFiles = files;
    const totalBytes = files.reduce((sum,file)=>sum+file.size,0);
    const noun = files.every(f => /^image\//.test(f.type) || /\.(heic|heif)$/i.test(f.name)) ? 'images' : 'files';
    $('r-name').textContent = files.length > 1 ? `${files.length} ${noun} selected` : files[0].name;
    $('r-size').textContent = files.length > 1 ? `${fmtSize(totalBytes)} total · processed one at a time` : fmtSize(files[0].size);
    $('go').textContent = current.combine ? `${current.name} (${files.length})` : files.length > 1 ? `${current.name} — ${files.length} ${noun}` : current.name;
    $('go').disabled = true; show('s-ready');
    try { await current.options($('opts'), files[0]); $('go').disabled = !!(current.canGo && !current.canGo(files)); afterOptions(); }
    catch (error) { showErr("Couldn't open this file", 'Try a standard JPG, PNG, WebP, HEIC, MP4 or MOV file.'); console.error(error); }
    const warn = $('ready-warn');
    warn.innerHTML = files.some(file => file.size > lim.softMB * 1048576)
      ? `<div class="err" style="border-color:var(--brass-line);background:var(--brass-soft);color:var(--muted)"><b style="color:var(--brass)">Above the recommended ~${mbLabel(lim.softMB)} per file.</b><br>You can continue, but larger files may be slow or run out of browser memory. Try a smaller file${current.batch ? ' or fewer images' : ''} if processing fails.</div>`
      : '';
    if (isSmallDevice() && current.engine === 'ffmpeg' && totalBytes > 80 * 1048576) warn.insertAdjacentHTML('beforeend', `<div class="err" style="border-color:var(--brass-line);background:var(--brass-soft);color:var(--muted)"><b style="color:var(--brass)">This is a big video for a phone.</b><br>Phones give a browser less memory than a computer, so it may stop part-way. Close other apps and tabs, keep the screen on, or use a computer for this one.</div>`);
  }

  $('change').addEventListener('click', () => { resetSelection(); show('s-pick'); });
  $('again').addEventListener('click', () => { if (currentId === 'checkup-fix') { backToHub(); return; } if (current && current.noFile) { openTool(currentId); return; } resetSelection(); show('s-pick'); });

  function renderResult({ blob, name, mime, compare, inputBytes, batchCount=0, batchOutputBytes=0, notes=[], outputs=[] }) {
    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob); outName = name;
    window.__inkwellMediaLast = { name, url: outUrl }; // read by the automated checks
    $('d-from').textContent = inputBytes ? fmtSize(inputBytes) : 'New'; $('d-to').textContent = fmtSize(blob.size);
    const noteSlot = $('done-note'); noteSlot.innerHTML=''; $('d-pct').style.fontSize='';
    if (batchCount) {
      $('d-pct').textContent = batchCount; $('d-word').textContent = batchCount === 1 ? 'file ready' : 'files ready in one ZIP';
      noteSlot.innerHTML = `<p class="note-soft">Processed locally, one file at a time. The ZIP was assembled in your browser.</p>`;
    } else if (compare) {
      const pct = Math.round((1 - blob.size/inputBytes) * 100);
      if (pct > 0) { $('d-pct').textContent = pct+'%'; $('d-word').textContent='smaller'; }
      else { $('d-pct').textContent='Done'; $('d-pct').style.fontSize='40px'; $('d-word').textContent='already optimized'; noteSlot.innerHTML = `<p class="note-soft">This file was already well-optimized, so it didn't get smaller. You may prefer your original.</p>`; }
    } else { $('d-pct').textContent='Done'; $('d-pct').style.fontSize='40px'; $('d-word').textContent='ready to download'; }
    const preview = $('d-preview-slot'); preview.innerHTML='';
    if (batchCount) {
      const delta = inputBytes ? Math.round((1 - batchOutputBytes / inputBytes) * 100) : 0;
      const change = delta > 0 ? `${delta}% smaller before ZIP packaging` : delta < 0 ? `${Math.abs(delta)}% larger before ZIP packaging` : 'about the same total size';
      preview.innerHTML = `<div class="zip-preview"><b>${batchCount} processed ${outputs.length && outputs.every(o => /^image\//.test(o.blob.type)) ? 'images' : 'files'}</b><span>${fmtSize(inputBytes)} input → ${fmtSize(batchOutputBytes)} processed · ${change}</span><span>Download one ZIP containing every result.</span></div>`;
    }
    else if (mime.startsWith('image/')) preview.innerHTML = `<img class="preview checkerboard" src="${outUrl}" alt="result preview"/>`;
    else if (mime.startsWith('video/')) preview.innerHTML = `<video class="preview" src="${outUrl}" controls></video>`;
    else if (mime.startsWith('audio/')) preview.innerHTML = `<audio style="width:100%;margin:16px 0" src="${outUrl}" controls></audio>`;
    if (notes.length) {
      const shown = notes.slice(0, 8).map(n => `<li>${escapeHtml(n)}</li>`).join('');
      noteSlot.insertAdjacentHTML('beforeend', `<ul class="result-notes">${shown}${notes.length > 8 ? `<li>…and ${notes.length - 8} more.</li>` : ''}</ul>`);
    }
    $('download').textContent = batchCount ? 'Download ZIP' : 'Download';
    lastOutputs = outputs.length ? outputs : [{ name, blob }];
    setupShare(lastOutputs);
    renderNextSteps(lastOutputs);
    show('s-done'); maybeShowCapture();
  }

  let cancelRequested = false;
  $('w-cancel').addEventListener('click', () => {
    cancelRequested = true;
    $('w-cancel').disabled = true; $('w-label').textContent = 'Stopping…';
    if (ffmpeg && currentEngineBusy()) { try { ffmpeg.terminate(); } catch (_) {} ffmpeg = null; ffmpegLoading = null; }
  });
  const currentEngineBusy = () => current && (current.engine === 'ffmpeg' || current.engine === 'mixed');
  const deliver = (args) => { if (cancelRequested) throw new Error('cancelled'); renderResult(args); };
  $('go').addEventListener('click', async () => {
    if (!selectedFiles.length) return;
    saveSettings();
    cancelRequested = false; $('w-cancel').disabled = false; $('w-cancel').classList.toggle('hidden', !!(current && current.noFile));
    clearErr(); show('s-working'); startWorking();
    $('w-label').textContent = 'Working…'; $('w-note').textContent = current.engine === 'canvas' ? 'Processing on your device — this is quick.' : 'Working on your device.';
    const inputBytes = selectedFiles.reduce((sum,file)=>sum+file.size,0);
    try {
      if (current.combine) {
        const result = await current.runAll(selectedFiles.slice()); setProgress(100);
        deliver({ ...result, inputBytes, notes: result.note ? [result.note] : [] });
      } else if (current.batch && selectedFiles.length > 1) {
        const entries = [], notes = [];
        $('w-files').innerHTML = selectedFiles.map((file,index) => `<div class="batch-file" data-file-index="${index}"><span class="batch-file-name">${file.name.replace(/[<>]/g,'')}</span><span class="batch-file-state">Waiting</span></div>`).join('');
        $('w-files').classList.remove('hidden');
        for (let index=0; index<selectedFiles.length; index++) {
          if (cancelRequested) throw new Error('cancelled');
          const file = selectedFiles[index];
          const row = $('w-files').querySelector(`[data-file-index="${index}"]`);
          row.classList.add('is-active'); row.querySelector('.batch-file-state').textContent = 'Processing';
          $('w-label').textContent = `Processing ${index+1} of ${selectedFiles.length}`; $('w-note').textContent = file.name;
          setProgress(Math.round(index / selectedFiles.length * 100));
          const result = await current.run(file); entries.push({ name:result.name, blob:result.blob, mime:result.mime });
          if (result.note) notes.push(result.note);
          row.classList.remove('is-active'); row.classList.add('is-done'); row.querySelector('.batch-file-state').textContent = 'Done';
          setProgress(Math.round((index+1) / selectedFiles.length * 100));
        }
        $('w-label').textContent = 'Building your ZIP…'; $('w-note').textContent = 'Everything stays on your device.';
        const blob = await createZip(entries);
        const batchOutputBytes = entries.reduce((sum,entry) => sum + entry.blob.size, 0);
        const zipLabel = currentId === 'checkup-fix' ? 'fixed' : currentId === 'strip-metadata' ? 'clean' : currentId.replace('image-','');
        if (currentId === 'strip-metadata') notes.unshift(`Found and removed location or camera details in ${notes.filter(n => n.startsWith('Removed from')).length} of ${entries.length} files.`);
        deliver({ blob, name:`inkwell-${zipLabel}-${entries.length}-files.zip`, mime:'application/zip', compare:false, inputBytes, batchCount:entries.length, batchOutputBytes, notes, outputs: entries.map(e => ({ name:e.name, blob:e.blob })) });
      } else {
        const result = await current.run(selectedFiles[0]); setProgress(100);
        deliver({ ...result, inputBytes, notes: result.note ? [result.note] : [] });
      }
    } catch (err) {
      if (cancelRequested) { show('s-ready'); $('ready-warn').innerHTML = '<p class="note-soft">Stopped. Nothing was saved; your file is still selected.</p>'; return; }
      console.error(err); const message = String(err && err.message || err);
      if (/qr-empty/.test(message)) { showErr('Add something to the code', 'Type a link, some text, or the Wi-Fi, email or phone details first.'); show('s-ready'); return; }
      if (/qr-load/.test(message)) { showErr("Couldn't load the QR maker", 'Reload the page and try again. After the first use it works offline.'); show('s-ready'); return; }
      if (/need-audio/.test(message)) { showErr('Choose an audio clip', 'Click “Change file” and pick one audio or video file (and a picture for the cover if you like).'); show('s-ready'); return; }
      if (/clip-range/.test(message)) showErr('Check the start and end', 'The end time needs to be after the start time, and inside the video.');
      else if (/too-long:/.test(message)) showErr('This video is too long for that size', `To fit at a watchable quality it needs to be under about ${Math.max(1, Math.floor(parseInt(message.split('too-long:')[1],10)/60))} minutes. Trim it first, then compress the shorter clip.`);
      else if (/no-duration/.test(message)) showErr("Couldn't read how long this video is", 'Try the Balanced setting instead, or convert it to MP4 first.');
      else if (/strip-failed/.test(message)) showErr("Couldn't remove the location safely", 'The cleaned copy still had location data, so we stopped. Try converting it to JPG first.');
      else if (/heic-load/.test(message)) showErr("Couldn't load the HEIC reader", 'Reload the page and try again. After the first use it works offline.');
      else if (/blur-empty/.test(message)) showErr('Mark something to hide', 'No faces were found and no areas are marked. Drag across each face, plate or name you want hidden.');
      else if (/size-impossible/.test(message)) showErr('Can’t get it that small', 'Even at the lowest quality and a much smaller size it’s still over the limit. Try a bigger limit, or crop the picture first.');
      else if (/join-one/.test(message)) showErr('Choose at least two videos', 'Click “Change file” and pick all the clips you want to join at once.');
      else if (/need-video-subs/.test(message)) showErr('Choose a video and a subtitle file', 'Click “Change file” and pick one video plus one .srt or .vtt file together.');
      else if (/no-subs/.test(message)) showErr('No subtitles found in that file', 'Check it’s an SRT or VTT file with times like 00:00:01,000 --> 00:00:03,000.');
      else if (/NotAllowedError|Permission denied|AbortError/.test(message) && currentId === 'screen-record') showErr('Recording didn’t start', 'Your browser asked what to share and nothing was chosen, or permission was turned off. Click Start recording and pick a screen, window or tab.');
      else if (/no-speech/.test(message)) showErr('No speech found', 'We couldn’t hear any words in this file. Check it has a sound track with talking in it.');
      else if (/speech-load|speech: .*(fetch|network|Failed|load)/i.test(message)) showErr("Couldn't load the speech model", 'The first run needs an internet connection to download it (40–80 MB). Check your connection and try again.');
      else if (/face-load/.test(message)) showErr("Couldn't load the face finder", 'Reload the page and try again. You can still mark areas by hand.');
      else if (/crop-empty/.test(message)) showErr('Choose a crop area', 'Drag across the preview to mark the part of the image you want to keep.');
      else if (/watermark-empty/.test(message)) showErr('Add a watermark', 'Enter watermark text or choose a logo image.');
      else if (/abort|memory|allocation|out of bounds|enlarge|rangeerror|oom/i.test(message)) showErr('This file was too large for your browser to handle', 'Everything runs on your device, so processing is limited by available browser memory. Try a smaller image or shorter video.');
      else if (/empty-output|encode|decode/.test(message)) showErr("Couldn't process this file", 'It may be in a format the browser cannot read. Try a standard JPG, PNG, WebP, MP4, or MOV.');
      else if (current.engine === 'background' || /load|core|fetch|network|import/i.test(message)) showErr("Couldn't load the processing engine", 'The first run needs an internet connection to download the engine or model. Check your connection and try again.');
      else showErr('Something went wrong', 'The file may be unsupported or too large for this browser. <span style="opacity:.65">(Detail: ' + message.slice(0,140).replace(/[<>]/g,'') + ')</span>');
      show('s-ready');
    } finally { stopWorking(); }
  });

  $('download').addEventListener('click', () => { if (!outUrl) return; const anchor=document.createElement('a'); anchor.href=outUrl; anchor.download=outName; anchor.click(); });

  /* ---------- optional email capture (Netlify Forms) ---------- */
  const SUB_KEY = 'inkwell_media_sub';
  const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const isSubbed = () => { try { return localStorage.getItem(SUB_KEY) === '1'; } catch(_) { return false; } };
  const markSubbed = () => { try { localStorage.setItem(SUB_KEY, '1'); } catch(_) {} };
  function maybeShowCapture(){
    if (isSubbed()) { $('capture').classList.add('hidden'); return; }
    $('capture').classList.remove('hidden');
    $('cap-form').classList.remove('hidden'); $('cap-thanks').classList.add('hidden');
    $('cap-email').value=''; $('cap-msg').textContent=''; $('cap-msg').className='cap-msg';
  }
  async function postForm(name, data){
    const body = new URLSearchParams(Object.assign({ 'form-name': name, 'bot-field': '' }, data));
    const r = await fetch('/', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: body.toString() });
    if (!r.ok) throw new Error('status ' + r.status);
  }
  async function submitEmail(){
    const email = $('cap-email').value.trim(), msg = $('cap-msg');
    if (!validEmail(email)) { msg.textContent='Please enter a valid email address.'; msg.className='cap-msg err'; return; }
    msg.textContent='Saving…'; msg.className='cap-msg';
    try { await postForm('updates', { email }); markSubbed(); $('cap-form').classList.add('hidden'); $('cap-thanks').classList.remove('hidden'); }
    catch(_) { msg.textContent="Could not save that just now — please try again."; msg.className='cap-msg err'; }
  }
  $('cap-btn').addEventListener('click', submitEmail);
  $('cap-email').addEventListener('keydown', e => { if (e.key === 'Enter') submitEmail(); });
  $('cap-dismiss').addEventListener('click', () => { markSubbed(); $('capture').classList.add('hidden'); });

  /* ---------- contact form (Netlify Forms; set the notification to info@inkwelltools.com) ---------- */
  function openContact(){
    $('hub').classList.add('hidden'); $('tool').classList.add('hidden'); $('contact').classList.remove('hidden');
    document.querySelector('.seo-intro')?.classList.add('hidden');
    document.querySelector('.faq')?.classList.add('hidden');
    $('ct-form').classList.remove('hidden'); $('ct-thanks').classList.add('hidden');
    $('ct-status').textContent=''; $('ct-status').className='cap-msg';
    window.scrollTo({top:0,behavior:'smooth'});
  }
  async function submitContact(){
    const name = $('ct-name').value.trim(), email = $('ct-email').value.trim(), message = $('ct-msg').value.trim(), st = $('ct-status');
    if (!name) { st.textContent='Please add your name.'; st.className='cap-msg err'; return; }
    if (!validEmail(email)) { st.textContent='Please enter a valid email address.'; st.className='cap-msg err'; return; }
    if (!message) { st.textContent='Please add a message.'; st.className='cap-msg err'; return; }
    st.textContent='Sending…'; st.className='cap-msg';
    try { await postForm('contact', { name, email, message }); $('ct-form').classList.add('hidden'); $('ct-thanks').classList.remove('hidden'); }
    catch(_) { st.textContent="Could not send just now — please try again."; st.className='cap-msg err'; }
  }
  $('contact-link').addEventListener('click', openContact);
  $('contact-back').addEventListener('click', backToHub);
  $('ct-send').addEventListener('click', submitContact);
  $('ct-again').addEventListener('click', () => { $('ct-name').value=''; $('ct-email').value=''; $('ct-msg').value=''; openContact(); });

  /* ---------- check-up (Media homepage): what a file gives away, and what might stop it opening or sending ---------- */
  const fmtDuration = (sec) => { sec = Math.round(sec); return sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m ${String(sec%60).padStart(2,'0')}s`; };
  async function hasTransparency(file) {
    try {
      const img = await loadImage(file); const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, 64, 64); if (img.close) img.close();
      const d = ctx.getImageData(0, 0, 64, 64).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
      return false;
    } catch (_) { return true; }
  }
  async function checkFile(file) {
    const findings = [];
    let info = '', meta = null;
    if (isVideoFile(file)) {
      const m = await readVideoMeta(file);
      meta = { kind: 'video', name: file.name, format: m.format, codec: m.codec, width: m.width || 0, height: m.height || 0, duration: m.duration || 0, size: file.size, gps: !!m.location };
      info = [m.format, m.codec, m.width ? `${m.width} × ${m.height}` : '', m.duration ? fmtDuration(m.duration) : '', fmtSize(file.size)].filter(Boolean).join(' · ');
      if (m.location) findings.push({ text:`Contains the location where it was filmed (near ${fmtCoord(m.location.lat)}, ${fmtCoord(m.location.lon)}). Anyone you send it to can see it.`, fix:'clean', on:true, warn:true });
      if (m.format === 'MOV') findings.push({ text:'Saved as MOV (Apple’s format). Some Windows PCs, Android phones and upload forms won’t take it.', fix:'mp4', on:true });
      if (m.codec === 'HEVC') findings.push({ text:'Uses HEVC (H.265). Older computers, some browsers and editing apps can’t play it.', fix:'mp4', on:true });
      else if (!m.playable && m.format !== 'MOV') findings.push({ text:'This browser can’t play it, so some people you send it to may not be able to either.', fix:'mp4', on:true });
      if (file.size > 25 * 1048576) findings.push({ text:`At ${fmtSize(file.size)} it’s too big to email (most email stops at 25 MB) or to post on Discord’s free plan (20 MB).`, fix:'shrink', on:false });
      else if (file.size > 20 * 1048576) findings.push({ text:`At ${fmtSize(file.size)} it’s over Discord’s 20 MB free limit and close to the usual 25 MB email limit.`, fix:'shrink', on:false });
      if (m.duration > 180) findings.push({ text:'It’s a long video, so fixing it in the browser can take a while. A computer is faster than a phone.', fix:null });
    } else {
      const m = await readImageMeta(file);
      let w = 0, h = 0;
      try { const img = await loadImage(file); w = img.width; h = img.height; if (img.close) img.close(); } catch (_) {}
      const dims = w ? `${w} × ${h}` : '';
      meta = { kind: 'image', name: file.name, format: m.format, width: w, height: h, size: file.size, gps: !!m.gps };
      info = [m.format, dims, fmtSize(file.size)].filter(Boolean).join(' · ');
      if (m.gps) findings.push({ text:`Contains your GPS location (near ${fmtCoord(m.gps.lat)}, ${fmtCoord(m.gps.lon)}). Anyone you send it to can see where it was taken.`, fix:'clean', on:true, warn:true });
      const cam = [m.make, m.model].filter(Boolean).join(' ').replace(/^(\w+) \1 /i, '$1 ');
      if (cam || m.date) findings.push({ text:`Shows ${[cam ? `the camera (${cam})` : '', m.date ? `when it was taken (${m.date.slice(0,10).replace(/:/g,'-')})` : ''].filter(Boolean).join(' and ')}.`, fix:'clean', on: !!m.gps });
      if (m.format === 'HEIC') findings.push({ text:'Saved as HEIC (the iPhone format). Windows, many websites and some apps can’t open it.', fix:'jpg', on:true });
      if (file.size > 25 * 1048576) findings.push({ text:`At ${fmtSize(file.size)} it’s too big to email.`, fix:'shrink', on:true });
      else if (file.size > 5 * 1048576 || Math.max(w, h) > 4000) findings.push({ text:`Bigger than most websites and apps need (${[dims, fmtSize(file.size)].filter(Boolean).join(', ')}). Some upload forms will turn it away.`, fix:'shrink', on: file.size > 10 * 1048576 });
      if (m.format === 'PNG' && file.size > 2 * 1048576 && !(await hasTransparency(file))) findings.push({ text:'Saved as PNG, which makes photos large. As a JPG it would be much smaller and look the same.', fix:'jpg', on:false });
    }
    return { file, findings, info, meta };
  }
  let ckEntries = [];
  function renderCheckup() {
    const box = $('ck-results'); box.classList.remove('hidden');
    let fixable = 0;
    box.innerHTML = ckEntries.map((e, ei) => {
      if (e.error) return `<div class="ck-file"><div class="ck-name">${escapeHtml(e.file.name)}</div><p class="ck-ok">Couldn’t read this file. It may be damaged or in a format the browser can’t open.</p></div>`;
      if (e.pending) return `<div class="ck-file"><div class="ck-name">${escapeHtml(e.file.name)}</div><p class="ck-ok">Checking…</p></div>`;
      const items = e.findings.map((f, fi) => {
        if (!f.fix) return `<div class="ck-item is-info"><span>${escapeHtml(f.text)}</span></div>`;
        fixable++;
        return `<label class="ck-item${f.warn ? ' is-warn' : ''}"><input type="checkbox" data-e="${ei}" data-f="${fi}" ${f.on ? 'checked' : ''}/><span>${escapeHtml(f.text)}<em>Fix: ${FIX_LABELS[f.fix]}</em></span></label>`;
      }).join('');
      return `<div class="ck-file"><div class="ck-name">${escapeHtml(e.file.name)}</div><div class="ck-info">${escapeHtml(e.info)}</div>${items || '<p class="ck-ok">✓ Looks good: no location data, a format that opens almost everywhere, and a sensible size.</p>'}</div>`;
    }).join('');
    const busy = ckEntries.some(e => e.pending);
    if (!busy && ckEntries.some(e => e.meta)) { box.insertAdjacentHTML('beforeend', sherpaHtml()); wireSherpa(); }
    if (!busy) box.insertAdjacentHTML('beforeend', (fixable ? `<button class="btn btn-primary" id="ck-fix" type="button">Fix the ticked items</button><p class="note-soft">Fixed copies download to your device. Your originals aren’t changed.</p><div id="ck-msg" class="cap-msg"></div>` : '') + `<button class="btn btn-ghost" id="ck-reset" type="button">Check other files</button>`);
    box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => { ckEntries[+cb.dataset.e].findings[+cb.dataset.f].on = cb.checked; }));
    if ($('ck-fix')) $('ck-fix').addEventListener('click', runCheckupFixes);
    if ($('ck-reset')) $('ck-reset').addEventListener('click', () => { ckEntries = []; box.innerHTML = ''; box.classList.add('hidden'); $('ck-file').value = ''; $('ck-drop').classList.remove('hidden'); });
  }
  /* ---------- Sherpa (round 16): where is it going? + optional AI with the visitor's own key ---------- */
  const SH_KEY = 'inkwellMedia.sherpaDest';
  let shDest = ''; try { shDest = localStorage.getItem(SH_KEY) || ''; } catch (_) {}
  function sherpaHtml() {
    return `<div class="sherpa-m" id="sh-m"><div class="sherpa-m-head"><span class="checkup-kicker">Sherpa</span><h3>Where is it going?</h3><p>Pick where you'll send or post it and Sherpa tells you what to change first.</p></div>
      <div class="sherpa-dests" role="group" aria-label="Where is it going">${SHERPA_DESTS.map(([id, label]) => `<button type="button" class="sherpa-dest" data-dest="${id}" aria-pressed="${id === shDest}">${label}</button>`).join('')}</div>
      <div id="sh-plan" aria-live="polite"></div><div id="sh-ask"></div></div>`;
  }
  function drawSherpaPlan() {
    const slot = $('sh-plan'); if (!slot) return;
    document.querySelectorAll('.sherpa-dest').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.dest === shDest)));
    if (!shDest) { slot.innerHTML = ''; return; }
    const entries = ckEntries.filter(e => e.meta);
    slot.innerHTML = entries.map((e, ei) => {
      const items = sherpaPlanFor(shDest, e.meta);
      return `<div class="sherpa-file">${entries.length > 1 ? `<div class="ck-name">${escapeHtml(e.file.name)}</div>` : ''}<ul class="sherpa-list">${items.map(it => `<li class="${it.warn ? 'is-warn' : it.ok ? 'is-ok' : ''}"><span>${escapeHtml(it.text)}</span>${it.path ? `<button type="button" class="next-btn" data-shopen="${it.path}" data-shfile="${ckEntries.indexOf(e)}">${escapeHtml(it.label)} →</button>` : ''}</li>`).join('')}</ul></div>`;
    }).join('');
    slot.querySelectorAll('[data-shopen]').forEach(b => b.addEventListener('click', () => sherpaOpen(b.dataset.shopen, [ckEntries[+b.dataset.shfile].file], b)));
  }
  async function sherpaOpen(path, files, btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try { await putHandoff(files); location.href = path + '?handoff=1'; }
    catch (_) { if (btn) { btn.disabled = false; btn.textContent = 'Couldn’t pass it along. Open the tool and add the file there.'; } }
  }
  function wireSherpa() {
    document.querySelectorAll('.sherpa-dest').forEach(b => b.addEventListener('click', () => {
      shDest = shDest === b.dataset.dest ? '' : b.dataset.dest;
      try { localStorage.setItem(SH_KEY, shDest); } catch (_) {}
      drawSherpaPlan();
    }));
    drawSherpaPlan();
    const files = () => ckEntries.filter(e => e.meta).map(e => e.file);
    mountMediaAsk($('sh-ask'), { getMetas: () => ckEntries.filter(e => e.meta).map(e => e.meta), open: (path) => sherpaOpen(path, files()) });
  }
  async function runCheckupFixes() {
    checkupFixes.clear();
    const files = [];
    for (const e of ckEntries) {
      if (!e.findings) continue;
      const fx = new Set(e.findings.filter(f => f.fix && f.on).map(f => f.fix));
      if (fx.size) { checkupFixes.set(e.file, fx); files.push(e.file); }
    }
    if (!files.length) { $('ck-msg').textContent = 'Tick at least one item to fix.'; $('ck-msg').className = 'cap-msg err'; return; }
    openTool('checkup-fix');
    await handleFiles(files);
    if (!$('go').disabled) $('go').click();
  }
  async function startCheckup(fileList) {
    const files = Array.from(fileList).slice(0, 30);
    if (!files.length) return;
    $('ck-drop').classList.add('hidden');
    ckEntries = files.map(file => ({ file, pending:true }));
    renderCheckup();
    for (let i = 0; i < ckEntries.length; i++) {
      try { ckEntries[i] = await checkFile(ckEntries[i].file); }
      catch (err) { console.error(err); ckEntries[i] = { file: ckEntries[i].file, error: true }; }
      renderCheckup();
    }
  }
  function setupCheckup() {
    const ckDrop = $('ck-drop'), ckFile = $('ck-file');
    if (!ckDrop) return;
    ckDrop.addEventListener('click', () => ckFile.click());
    ckDrop.addEventListener('dragover', e => { e.preventDefault(); ckDrop.classList.add('drag'); });
    ckDrop.addEventListener('dragleave', () => ckDrop.classList.remove('drag'));
    ckDrop.addEventListener('drop', e => { e.preventDefault(); ckDrop.classList.remove('drag'); if (e.dataTransfer.files.length) startCheckup(e.dataTransfer.files); });
    ckFile.addEventListener('change', e => { if (e.target.files.length) startCheckup(e.target.files); });
  }

  /* ---------- next steps after a result ---------- */
  const NEXT_STEPS = {
    audio: [['ringtone','Make a ringtone'],['audiogram','Make an audiogram video'],['audio-denoise','Reduce background noise'],['audio-level','Even out the volume']],
    image: [['blur-faces','Blur faces & plates'],['image-text','Add text'],['image-collage','Make a collage'],['strip-metadata','Remove location & camera data'],['image-to-size','Compress to a size'],['image-resize','Resize it for a site'],['image-watermark','Add a watermark'],['image-convert','Change the format'],['palette','Get its colour palette']],
    video: [['video-captions','Add captions'],['video-vertical','Make it 9:16 for Reels'],['audio-denoise','Reduce background noise'],['video-compress','Compress it'],['video-trim','Trim it'],['audio-level','Even out the volume'],['video-gif','Make a GIF'],['video-mute','Remove the sound'],['strip-metadata','Remove location data']],
  };
  function renderNextSteps(outputs) {
    const slot = $('d-next'); slot.innerHTML = '';
    if (!outputs.length) return;
    const kinds = new Set(outputs.map(o => (o.blob.type || '').split('/')[0]));
    if (kinds.size !== 1) return;
    const kind = [...kinds][0];
    const isGif = outputs.every(o => /gif/.test(o.blob.type));
    const list = isGif ? [] : (NEXT_STEPS[kind] || []).filter(([id]) => id !== currentId && TOOLS[id] && TOOL_PATHS[id] && (outputs.length === 1 || TOOLS[id].batch)).slice(0, 4);
    let html = list.length ? `<div class="next-steps"><p class="plabel">Keep going with ${outputs.length > 1 ? 'these files' : 'this file'}</p><div class="next-grid">${list.map(([id, label]) => `<button type="button" class="next-btn" data-next="${id}">${label} <span aria-hidden="true">→</span></button>`).join('')}</div></div>` : '';
    if (kind === 'image') html += `<p class="suite-link">Putting photos into a document? <a href="https://pdf.inkwelltools.com/?utm_source=inkwelltools&amp;utm_medium=media&amp;utm_campaign=next-step" target="_blank" rel="noopener">Inkwell PDF</a> turns images into a PDF, merges files and collects e-signatures.</p>`;
    if (kind === 'video') html += `<p class="suite-link">Posting it somewhere? <a href="https://blot.inkwelltools.com/?utm_source=inkwelltools&amp;utm_medium=media&amp;utm_campaign=next-step" target="_blank" rel="noopener">Inkwell Blot</a> makes a short link and QR code for wherever you share it, free.</p>`;
    slot.innerHTML = html;
    slot.querySelectorAll('[data-next]').forEach(button => button.addEventListener('click', async () => {
      const id = button.dataset.next;
      button.disabled = true; button.textContent = 'Opening…';
      try {
        await putHandoff(lastOutputs.map(o => new File([o.blob], o.name, { type: o.blob.type })));
        location.href = TOOL_PATHS[id] + '?handoff=1';
      } catch (_) { button.disabled = false; button.textContent = 'Couldn’t pass it along. Download it and open the tool instead.'; }
    }));
  }

  /* ---------- round 15: remembered settings and setting links ---------- */
  const SET_KEY = (id) => 'inkwellMedia.opts.' + id;
  const SKIP_INPUT = /^(text|search|email|url|tel|password|file|hidden|button|submit)$/i;
  function settingFields() {
    const host = $('opts'); if (!host) return [];
    return [...host.querySelectorAll('input,select')].filter((el) => {
      if (el.tagName === 'INPUT' && SKIP_INPUT.test(el.type)) return false;
      if (el.type === 'radio') return !!el.name;
      return !!el.id;
    });
  }
  function readSettings() {
    const out = {};
    for (const el of settingFields()) {
      if (el.type === 'radio') { if (el.checked) out['r:' + el.name] = el.value; }
      else if (el.type === 'checkbox') out[el.id] = el.checked ? '1' : '0';
      else out[el.id] = el.value;
    }
    return out;
  }
  function applySettings(obj) {
    let n = 0;
    for (const [k, v] of Object.entries(obj || {})) {
      let el = null;
      if (k.startsWith('r:')) { el = [...document.querySelectorAll(`#opts input[type=radio][name="${CSS.escape(k.slice(2))}"]`)].find((r) => r.value === v); if (el && !el.checked) { el.checked = true; n++; } else el = null; }
      else {
        el = document.getElementById(k);
        if (!el || !$('opts').contains(el) || (el.tagName === 'INPUT' && SKIP_INPUT.test(el.type))) continue;
        if (el.type === 'checkbox') { const want = v === '1' || v === 'true'; if (el.checked === want) continue; el.checked = want; }
        else if (el.tagName === 'SELECT') { if (![...el.options].some((o) => o.value === v) || el.value === v) continue; el.value = v; }
        else { if (el.value === v) continue; el.value = v; }
        n++;
      }
      if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    return n;
  }
  const hasPagePreset = () => Object.keys(document.body.dataset).some((k) => k !== 'tool');
  function urlSettings() {
    const out = {};
    for (const [k, v] of new URLSearchParams(location.search)) if (k.startsWith('o.')) out[k.slice(2)] = v;
    return out;
  }
  let settingsApplied = '';
  function afterOptions() {
    const row = $('settings-row'); if (!row) return;
    const fields = settingFields();
    row.classList.toggle('hidden', !fields.length || currentId === 'checkup-fix');
    $('set-msg').textContent = '';
    if (!fields.length || currentId === 'checkup-fix') return;
    const fromUrl = urlSettings();
    let applied = 0;
    // setting links win; otherwise the last settings used with this tool (not on one-job pages, which have their own preset)
    if (Object.keys(fromUrl).length) applied = applySettings(fromUrl);
    else if (!hasPagePreset()) { try { applied = applySettings(JSON.parse(localStorage.getItem(SET_KEY(currentId)) || 'null')); } catch (_) {} }
    if (applied && settingsApplied !== currentId) { settingsApplied = currentId; $('set-msg').textContent = Object.keys(fromUrl).length ? 'Settings from the link applied.' : 'Your last settings applied.'; }
  }
  function saveSettings() {
    if (!current || currentId === 'checkup-fix') return;
    const s = readSettings(); if (!Object.keys(s).length) return;
    try { localStorage.setItem(SET_KEY(currentId), JSON.stringify(s)); } catch (_) {}
  }
  $('set-link').addEventListener('click', async () => {
    const q = new URLSearchParams(); for (const [k, v] of Object.entries(readSettings())) q.set('o.' + k, v);
    const url = location.origin + (TOOL_PATHS[currentId] || location.pathname) + '?' + q.toString();
    try { await navigator.clipboard.writeText(url); $('set-msg').textContent = 'Link copied. Anyone who opens it gets these settings.'; }
    catch (_) { $('set-msg').textContent = url; }
  });
  $('set-reset').addEventListener('click', async () => {
    try { localStorage.removeItem(SET_KEY(currentId)); } catch (_) {}
    if (location.search) history.replaceState(null, '', location.pathname);
    settingsApplied = currentId;
    if (current.noFile) { openTool(currentId); return; }
    const files = selectedFiles.slice(); await handleFiles(files);
    $('set-msg').textContent = 'Back to the defaults.';
  });

  /* ---------- round 15: phone check, share sheet ---------- */
  function isSmallDevice() {
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    const lowMem = navigator.deviceMemory && navigator.deviceMemory <= 4;
    return !!(coarse && (lowMem || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)));
  }
  let shareFiles = [];
  function setupShare(outputs) {
    const btn = $('share-btn'); if (!btn) return;
    shareFiles = [];
    btn.classList.add('hidden');
    if (!navigator.share || !navigator.canShare) return;
    const total = outputs.reduce((n, o) => n + o.blob.size, 0);
    if (total > 250 * 1048576 || outputs.length > 10) return;
    const files = outputs.map((o) => new File([o.blob], o.name, { type: o.blob.type || 'application/octet-stream' }));
    try { if (!navigator.canShare({ files })) return; } catch (_) { return; }
    shareFiles = files;
    btn.textContent = files.length > 1 ? `Share ${files.length} files…` : 'Share…';
    btn.classList.remove('hidden');
  }
  $('share-btn').addEventListener('click', async () => {
    if (!shareFiles.length) return;
    try { await navigator.share({ files: shareFiles, title: shareFiles[0].name }); }
    catch (e) { if (!/AbortError/.test(String(e && e.name))) $('done-note').insertAdjacentHTML('beforeend', '<p class="note-soft">Sharing didn’t work here. Download it instead, then share it from your files.</p>'); }
  });

  /* ---------- round 15: paste a file, or drop it anywhere on the page ---------- */
  const visible = (id) => { const el = $(id); return el && !el.classList.contains('hidden'); };
  const canTakeFiles = () => visible('tool') && current && !current.noFile && (visible('s-pick') || visible('s-ready'));
  function acceptsFile(file) {
    const acc = (current && current.accept || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!acc.length) return true;
    return acc.some((a) => a.startsWith('.') ? file.name.toLowerCase().endsWith(a.toLowerCase()) : a.endsWith('/*') ? (file.type || '').startsWith(a.slice(0, -1)) : file.type === a);
  }
  function filesFromClipboard(e) {
    const out = [];
    for (const item of (e.clipboardData && e.clipboardData.items) || []) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile(); if (!f) continue;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '');
      out.push(f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.${ext}`, { type: f.type }));
    }
    return out;
  }
  document.addEventListener('paste', (e) => {
    const files = filesFromClipboard(e); if (!files.length) return;
    if (canTakeFiles()) { const ok = files.filter(acceptsFile); if (!ok.length) return; e.preventDefault(); handleFiles(ok); }
    else if (visible('hub') && $('ck-drop') && !$('ck-drop').classList.contains('hidden')) { e.preventDefault(); startCheckup(files); }
  });
  (function setupWindowDrop() {
    const ov = document.createElement('div'); ov.className = 'drop-overlay'; ov.textContent = 'Drop it to open it here';
    document.body.appendChild(ov);
    let depth = 0;
    const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    const target = () => canTakeFiles() ? 'tool' : (visible('hub') && $('ck-drop') && !$('ck-drop').classList.contains('hidden')) ? 'check' : '';
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || !target()) return; depth++; ov.classList.add('on'); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) ov.classList.remove('on'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e) && target()) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      depth = 0; ov.classList.remove('on');
      if (!hasFiles(e)) return;
      if ((e.target.closest && (e.target.closest('#drop') || e.target.closest('#ck-drop')))) return; // the drop zones handle their own
      const t = target(); if (!t) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      if (t === 'tool') handleFiles(files.filter(acceptsFile).length ? files.filter(acceptsFile) : files); else startCheckup(files);
    });
  })();
  function addPasteHint() {
    const pick = $('s-pick'); if (!pick || $('paste-hint')) return;
    const p = document.createElement('p'); p.className = 'paste-hint'; p.id = 'paste-hint';
    p.innerHTML = 'You can also paste a copied picture or screenshot with <kbd>Ctrl</kbd>+<kbd>V</kbd> (<kbd>⌘</kbd><kbd>V</kbd> on a Mac).';
    pick.appendChild(p);
  }

  /* ---------- round 15: files shared from the phone's share sheet ---------- */
  const SHARE_TOOLS = {
    image: [['image-compress','Compress'],['image-resize','Resize'],['image-text','Add text'],['remove-background','Remove the background'],['blur-faces','Blur faces & plates'],['strip-metadata','Remove location data'],['image-collage','Make a collage'],['image-convert','Change the format']],
    video: [['video-compress','Compress'],['video-trim','Trim'],['video-captions','Add captions'],['video-vertical','Make it 9:16 for Reels'],['video-gif','Make a GIF'],['extract-audio','Save the sound as MP3'],['video-mute','Remove the sound'],['strip-metadata','Remove location data']],
    audio: [['ringtone','Make a ringtone'],['audiogram','Make an audiogram video'],['audio-denoise','Reduce background noise'],['audio-level','Even out the volume']],
  };
  async function showSharedFiles() {
    const files = await takeHandoff();
    history.replaceState(null, '', location.pathname);
    if (!files.length) return;
    const kinds = new Set(files.map((f) => isVideoFile(f) ? 'video' : (f.type || '').split('/')[0]));
    const kind = kinds.size === 1 ? [...kinds][0] : '';
    const list = (SHARE_TOOLS[kind] || []).filter(([id]) => TOOLS[id] && TOOL_PATHS[id] && (files.length === 1 || TOOLS[id].batch || TOOLS[id].combine));
    const box = document.createElement('section'); box.className = 'shared-box'; box.setAttribute('aria-live', 'polite');
    box.innerHTML = `<h2>${files.length === 1 ? 'You shared 1 file' : `You shared ${files.length} files`}</h2><p>${files.slice(0, 4).map((f) => escapeHtml(f.name)).join(', ')}${files.length > 4 ? '…' : ''}. What would you like to do?</p>
      <div class="next-grid">${list.map(([id, label]) => `<button type="button" class="next-btn" data-share="${id}">${label} <span aria-hidden="true">→</span></button>`).join('')}${kind !== 'audio' ? `<button type="button" class="next-btn" data-share="check">Check what it gives away <span aria-hidden="true">→</span></button>` : ''}</div>`;
    const hub = $('hub'); hub.insertBefore(box, hub.firstChild);
    box.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.share;
      if (id === 'check') { box.remove(); startCheckup(files); $('checkup').scrollIntoView({ behavior: 'smooth' }); return; }
      b.disabled = true;
      try { await putHandoff(files); location.href = TOOL_PATHS[id] + '?handoff=1'; } catch (_) { b.disabled = false; }
    }));
  }


  /* ---------- round 15: "link to this tool" snippet (for bloggers and teachers) ---------- */
  function linkToThisTool() {
    const faq = document.querySelector('.faq'); if (!faq || !document.body.dataset.tool || $('link-tool')) return;
    const url = 'https://inkwelltools.com' + location.pathname;
    const name = (document.querySelector('h1') || {}).textContent || document.title;
    const plain = `<a href="${url}">${escapeHtml(name)}</a> (free, runs in your browser, by Inkwell Media)`;
    const card = `<a href="${url}" style="display:inline-block;padding:12px 16px;border:1px solid #cca24e;border-radius:10px;background:#141019;color:#f3eee6;font:500 15px/1.4 system-ui,sans-serif;text-decoration:none">${escapeHtml(name)} <span style="color:#cca24e">→</span><br><span style="font-size:12.5px;color:#9a90ad">Free · nothing uploaded · Inkwell Media</span></a>`;
    const d = document.createElement('details'); d.id = 'link-tool';
    d.innerHTML = `<summary>Link to this tool from your site or class page</summary><p>Copy one of these into your web page, blog post or newsletter. Thank you for sharing it.</p>
      <div class="field"><label for="lt-plain">A plain link</label><textarea id="lt-plain" rows="2" readonly>${escapeHtml(plain)}</textarea></div>
      <div class="field"><label for="lt-card">A small button</label><textarea id="lt-card" rows="4" readonly>${escapeHtml(card)}</textarea></div>
      <p class="note-soft" style="text-align:left">Preview: ${card}</p>
      <button type="button" class="btn btn-ghost" id="lt-copy" style="width:auto">Copy the button</button>`;
    faq.appendChild(d);
    $('lt-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(card); $('lt-copy').textContent = 'Copied'; } catch (_) { $('lt-card').select(); } });
    d.querySelectorAll('textarea').forEach((t) => t.addEventListener('focus', () => t.select()));
  }
  linkToThisTool();
  renderHub();
  const initialTool = document.body.dataset.tool;
  if (initialTool && TOOLS[initialTool]) {
    openTool(initialTool);
    if (new URLSearchParams(location.search).has('handoff')) {
      history.replaceState(null, '', location.pathname);
      takeHandoff().then(files => { if (files.length) handleFiles(files); });
    }
  } else { $('tool').classList.add('hidden'); $('hub').classList.remove('hidden'); setupCheckup(); if (new URLSearchParams(location.search).has('shared')) showSharedFiles(); }

