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
    'video-mute': { note:'The picture is copied without re-encoding, so even large clips are quick.', softMB:200, hardMB:1024 },
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
      options(host){ host.innerHTML = radios('fmt',[
        {v:'jpg',n:'JPG',d:'Small and universal (no transparency)',def:true},
        {v:'png',n:'PNG',d:'Lossless, keeps transparency'},
        {v:'webp',n:'WebP',d:'Small and keeps transparency'},
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
          {v:'30',n:'Smaller file',d:'Best for quick sharing'},
          {v:'26',n:'Balanced',d:'A good mix of size and quality',tag:'Recommended',def: wanted === '26'},
          {v:'22',n:'Best quality',d:'Keeps it crisp, shrinks a little less'},
        ]) + `<p class="note-soft" style="text-align:left;margin:-4px 0 16px">The size targets lower the quality and, for longer clips, the resolution, so the file fits. Very long videos may need trimming first.</p>`;
      },
      async run(file){
        const choice = getRadio('vq')||'26';
        const base = file.name.replace(/\.[^.]+$/,'');
        if (choice === 'd20' || choice === 'e25') {
          const limitBytes = choice === 'd20' ? 20 * 1048576 : 18 * 1000000;
          const blob = await fitVideoUnder(file, limitBytes, []);
          const note = blob.size <= limitBytes ? `${fmtSize(blob.size)} — under the ${choice === 'd20' ? '20 MB Discord' : 'email'} limit.` : `Got it down to ${fmtSize(blob.size)}, still a little over. Try trimming the clip first.`;
          return { blob, name:`${base}-${choice === 'd20' ? 'discord' : 'email'}.mp4`, mime:'video/mp4', compare:true, note };
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
          + `<div class="field"><label for="cap-out">Download as</label><select id="cap-out"><option value="srt">SRT subtitles (YouTube, Facebook, LinkedIn, Premiere)</option><option value="vtt">VTT subtitles (web players, Vimeo)</option><option value="txt">Plain transcript (.txt)</option><option value="mp4">MP4 with captions viewers can turn on</option></select></div>`
          + `<p class="note-soft" style="text-align:left;margin:0 0 16px">Machine captions get most words right but not all. Read them through before you publish; an SRT opens in any text editor.</p>`;
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
      group:'Video & audio', engine:'ffmpeg', combine:true, name:'Join videos', blurb:'Put clips together into one MP4', icon:ICONS.join,
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
    'audio-level':'/even-out-audio-volume/'
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
    $('tool-capacity').classList.toggle('hidden', which !== 's-pick' && which !== 's-ready');
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
    if (gotRealProgress) { $('w-fill').style.width = p+'%'; $('w-pct').textContent = p+'%'; }
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
    show('s-pick');
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
    try { await current.options($('opts'), files[0]); $('go').disabled = false; }
    catch (error) { showErr("Couldn't open this file", 'Try a standard JPG, PNG, WebP, HEIC, MP4 or MOV file.'); console.error(error); }
    const warn = $('ready-warn');
    warn.innerHTML = files.some(file => file.size > lim.softMB * 1048576)
      ? `<div class="err" style="border-color:var(--brass-line);background:var(--brass-soft);color:var(--muted)"><b style="color:var(--brass)">Above the recommended ~${mbLabel(lim.softMB)} per file.</b><br>You can continue, but larger files may be slow or run out of browser memory. Try a smaller file${current.batch ? ' or fewer images' : ''} if processing fails.</div>`
      : '';
  }

  $('change').addEventListener('click', () => { resetSelection(); show('s-pick'); });
  $('again').addEventListener('click', () => { if (currentId === 'checkup-fix') { backToHub(); return; } resetSelection(); show('s-pick'); });

  function renderResult({ blob, name, mime, compare, inputBytes, batchCount=0, batchOutputBytes=0, notes=[], outputs=[] }) {
    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob); outName = name;
    $('d-from').textContent = fmtSize(inputBytes); $('d-to').textContent = fmtSize(blob.size);
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
    renderNextSteps(lastOutputs);
    show('s-done'); maybeShowCapture();
  }

  $('go').addEventListener('click', async () => {
    if (!selectedFiles.length) return;
    clearErr(); show('s-working'); startWorking();
    $('w-label').textContent = 'Working…'; $('w-note').textContent = current.engine === 'canvas' ? 'Processing on your device — this is quick.' : 'Working on your device.';
    const inputBytes = selectedFiles.reduce((sum,file)=>sum+file.size,0);
    try {
      if (current.combine) {
        const result = await current.runAll(selectedFiles.slice()); setProgress(100);
        renderResult({ ...result, inputBytes, notes: result.note ? [result.note] : [] });
      } else if (current.batch && selectedFiles.length > 1) {
        const entries = [], notes = [];
        $('w-files').innerHTML = selectedFiles.map((file,index) => `<div class="batch-file" data-file-index="${index}"><span class="batch-file-name">${file.name.replace(/[<>]/g,'')}</span><span class="batch-file-state">Waiting</span></div>`).join('');
        $('w-files').classList.remove('hidden');
        for (let index=0; index<selectedFiles.length; index++) {
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
        renderResult({ blob, name:`inkwell-${zipLabel}-${entries.length}-files.zip`, mime:'application/zip', compare:false, inputBytes, batchCount:entries.length, batchOutputBytes, notes, outputs: entries.map(e => ({ name:e.name, blob:e.blob })) });
      } else {
        const result = await current.run(selectedFiles[0]); setProgress(100);
        renderResult({ ...result, inputBytes, notes: result.note ? [result.note] : [] });
      }
    } catch (err) {
      console.error(err); const message = String(err && err.message || err);
      if (/clip-range/.test(message)) showErr('Check the start and end', 'The end time needs to be after the start time, and inside the video.');
      else if (/too-long:/.test(message)) showErr('This video is too long for that size', `To fit at a watchable quality it needs to be under about ${Math.max(1, Math.floor(parseInt(message.split('too-long:')[1],10)/60))} minutes. Trim it first, then compress the shorter clip.`);
      else if (/no-duration/.test(message)) showErr("Couldn't read how long this video is", 'Try the Balanced setting instead, or convert it to MP4 first.');
      else if (/strip-failed/.test(message)) showErr("Couldn't remove the location safely", 'The cleaned copy still had location data, so we stopped. Try converting it to JPG first.');
      else if (/heic-load/.test(message)) showErr("Couldn't load the HEIC reader", 'Reload the page and try again. After the first use it works offline.');
      else if (/blur-empty/.test(message)) showErr('Mark something to hide', 'No faces were found and no areas are marked. Drag across each face, plate or name you want hidden.');
      else if (/size-impossible/.test(message)) showErr('Can’t get it that small', 'Even at the lowest quality and a much smaller size it’s still over the limit. Try a bigger limit, or crop the picture first.');
      else if (/join-one/.test(message)) showErr('Choose at least two videos', 'Click “Change file” and pick all the clips you want to join at once.');
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
    let info = '';
    if (isVideoFile(file)) {
      const m = await readVideoMeta(file);
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
      info = [m.format, dims, fmtSize(file.size)].filter(Boolean).join(' · ');
      if (m.gps) findings.push({ text:`Contains your GPS location (near ${fmtCoord(m.gps.lat)}, ${fmtCoord(m.gps.lon)}). Anyone you send it to can see where it was taken.`, fix:'clean', on:true, warn:true });
      const cam = [m.make, m.model].filter(Boolean).join(' ').replace(/^(\w+) \1 /i, '$1 ');
      if (cam || m.date) findings.push({ text:`Shows ${[cam ? `the camera (${cam})` : '', m.date ? `when it was taken (${m.date.slice(0,10).replace(/:/g,'-')})` : ''].filter(Boolean).join(' and ')}.`, fix:'clean', on: !!m.gps });
      if (m.format === 'HEIC') findings.push({ text:'Saved as HEIC (the iPhone format). Windows, many websites and some apps can’t open it.', fix:'jpg', on:true });
      if (file.size > 25 * 1048576) findings.push({ text:`At ${fmtSize(file.size)} it’s too big to email.`, fix:'shrink', on:true });
      else if (file.size > 5 * 1048576 || Math.max(w, h) > 4000) findings.push({ text:`Bigger than most websites and apps need (${[dims, fmtSize(file.size)].filter(Boolean).join(', ')}). Some upload forms will turn it away.`, fix:'shrink', on: file.size > 10 * 1048576 });
      if (m.format === 'PNG' && file.size > 2 * 1048576 && !(await hasTransparency(file))) findings.push({ text:'Saved as PNG, which makes photos large. As a JPG it would be much smaller and look the same.', fix:'jpg', on:false });
    }
    return { file, findings, info };
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
    if (!busy) box.insertAdjacentHTML('beforeend', (fixable ? `<button class="btn btn-primary" id="ck-fix" type="button">Fix the ticked items</button><p class="note-soft">Fixed copies download to your device. Your originals aren’t changed.</p><div id="ck-msg" class="cap-msg"></div>` : '') + `<button class="btn btn-ghost" id="ck-reset" type="button">Check other files</button>`);
    box.querySelectorAll('input[type=checkbox]').forEach(cb => cb.addEventListener('change', () => { ckEntries[+cb.dataset.e].findings[+cb.dataset.f].on = cb.checked; }));
    if ($('ck-fix')) $('ck-fix').addEventListener('click', runCheckupFixes);
    if ($('ck-reset')) $('ck-reset').addEventListener('click', () => { ckEntries = []; box.innerHTML = ''; box.classList.add('hidden'); $('ck-file').value = ''; $('ck-drop').classList.remove('hidden'); });
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
    image: [['blur-faces','Blur faces & plates'],['strip-metadata','Remove location & camera data'],['image-to-size','Compress to a size'],['image-resize','Resize it for a site'],['image-watermark','Add a watermark'],['image-convert','Change the format']],
    video: [['video-captions','Add captions'],['video-compress','Compress it'],['video-trim','Trim it'],['audio-level','Even out the volume'],['video-gif','Make a GIF'],['video-mute','Remove the sound'],['strip-metadata','Remove location data']],
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

  renderHub();
  const initialTool = document.body.dataset.tool;
  if (initialTool && TOOLS[initialTool]) {
    openTool(initialTool);
    if (new URLSearchParams(location.search).has('handoff')) {
      history.replaceState(null, '', location.pathname);
      takeHandoff().then(files => { if (files.length) handleFiles(files); });
    }
  } else { $('tool').classList.add('hidden'); $('hub').classList.remove('hidden'); setupCheckup(); }

