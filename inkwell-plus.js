/* Inkwell Plus (round 17): shared extras for the free tools on inkwelltools.com.
 *  - Ctrl+K / ⌘K "jump to any tool" palette (uses /tool-search-index.js)
 *  - "Pick up where you left off": recent results kept in this browser (IndexedDB) for 24 hours
 *  - "Files uploaded: none" meter: counts what the page actually sends out
 * Plain script, no dependencies. Load it before the page's own scripts so the meter sees every request.
 * Options: set window.INKWELL_PLUS = { hotkey:false, indexUrl:'/tool-search-index.js' } before loading. */
(function () {
  'use strict';
  if (window.InkwellPlus) return;
  const me = document.currentScript;
  const cfg = Object.assign({ hotkey: true, indexUrl: '/tool-search-index.js?v=r17' }, window.INKWELL_PLUS || {});
  if (me && me.dataset.hotkey === 'off') cfg.hotkey = false; // pages with their own Ctrl+K (Inkwell Data) keep it
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
  const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- styles ---------------- */
  const css = `
.ikp-overlay{position:fixed;inset:0;z-index:2147483000;background:rgba(8,6,12,.62);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;padding:10vh 14px 14px}
.ikp-overlay[hidden]{display:none}
.ikp-dialog{width:min(640px,100%);background:#1a1524;color:#f3eee6;border:1px solid rgba(204,162,78,.4);border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;font:15px/1.45 Inter,system-ui,sans-serif}
.ikp-dialog:not(.ikp-still){animation:ikp-in .16s ease-out}
@keyframes ikp-in{from{transform:translateY(-8px) scale(.985);opacity:0}to{transform:none;opacity:1}}
.ikp-top{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid rgba(243,238,230,.1)}
.ikp-top svg{flex:none;color:#cca24e}
.ikp-input{flex:1;min-width:0;background:none;border:0;color:#f3eee6;font:inherit;font-size:17px;outline:none}
.ikp-input::placeholder{color:#9a90ad}
.ikp-esc{font-size:11px;color:#9a90ad;border:1px solid rgba(243,238,230,.18);border-radius:6px;padding:2px 6px;background:none;cursor:pointer}
.ikp-list{list-style:none;margin:0;padding:6px;max-height:min(56vh,460px);overflow:auto}
.ikp-sec{padding:10px 10px 4px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#9a90ad}
.ikp-opt{display:flex;gap:10px;align-items:baseline;padding:9px 10px;border-radius:10px;cursor:pointer;color:inherit;text-decoration:none}
.ikp-opt[aria-selected=true]{background:rgba(204,162,78,.16);outline:1px solid rgba(204,162,78,.5)}
.ikp-opt b{font-weight:600}
.ikp-opt .ikp-d{display:block;font-size:13px;color:#b5abc6;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ikp-opt .ikp-g{margin-left:auto;flex:none;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:#cca24e}
.ikp-opt>span:first-child{min-width:0;flex:1}
.ikp-empty{padding:18px 12px;color:#b5abc6}
.ikp-foot{display:flex;gap:14px;justify-content:space-between;padding:9px 16px;border-top:1px solid rgba(243,238,230,.1);font-size:12px;color:#9a90ad}
.ikp-foot kbd,.ikp-kbd{font:inherit;font-size:11px;border:1px solid rgba(243,238,230,.22);border-radius:5px;padding:0 5px;margin:0 1px}
.ikp-skel{height:44px;margin:6px 4px;border-radius:10px;background:linear-gradient(90deg,rgba(243,238,230,.05),rgba(243,238,230,.11),rgba(243,238,230,.05));background-size:200% 100%;animation:ikp-sh 1.1s linear infinite}
@keyframes ikp-sh{to{background-position:-200% 0}}
.ikp-trigger{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:14px;color:inherit;background:rgba(243,238,230,.06);border:1px solid rgba(243,238,230,.18);border-radius:999px;padding:6px 12px;cursor:pointer}
.ikp-trigger:hover,.ikp-trigger:focus-visible{border-color:#cca24e;outline:none}
.ikp-trigger .ikp-kbd{opacity:.75}
@media (max-width:560px){.ikp-trigger .ikp-kbd{display:none}}
.ikp-meter{position:relative;display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:12.5px;color:inherit;background:rgba(123,185,138,.1);border:1px solid rgba(123,185,138,.4);border-radius:999px;padding:4px 11px;cursor:pointer}
.ikp-meter:focus-visible{outline:2px solid #cca24e;outline-offset:2px}
.ikp-meter .ikp-dot{width:7px;height:7px;border-radius:50%;background:#7bb98a;box-shadow:0 0 0 3px rgba(123,185,138,.2)}
.ikp-meter.is-sent{background:rgba(204,162,78,.1);border-color:rgba(204,162,78,.45)}
.ikp-meter.is-sent .ikp-dot{background:#cca24e;box-shadow:0 0 0 3px rgba(204,162,78,.2)}
.ikp-pop{position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);width:min(340px,86vw);text-align:left;background:#1a1524;color:#f3eee6;border:1px solid rgba(204,162,78,.4);border-radius:12px;padding:12px 14px;font-size:13px;line-height:1.45;box-shadow:0 14px 40px rgba(0,0,0,.45);z-index:50;cursor:default}
.ikp-pop[hidden]{display:none}
.ikp-pop ul{margin:6px 0 0;padding-left:18px}
.ikp-pop p{margin:0 0 6px}
.ikp-recent{margin:0 0 22px;border:1px solid rgba(204,162,78,.3);border-radius:14px;padding:14px 16px;background:rgba(204,162,78,.05);text-align:left}
.ikp-recent[hidden]{display:none}
.ikp-recent h2,.ikp-recent h3{font-family:Fraunces,Georgia,serif;font-weight:500;font-size:18px;margin:0 0 4px}
.ikp-recent .ikp-sub{font-size:13px;opacity:.75;margin:0 0 10px}
.ikp-rows{display:grid;gap:8px}
.ikp-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:9px 12px;border-radius:10px;background:rgba(127,127,127,.08)}
.ikp-row .ikp-what{flex:1 1 220px;min-width:0}
.ikp-row .ikp-what b{font-weight:600}
.ikp-app{opacity:.6}
.ikp-row .ikp-what span{display:block;font-size:12.5px;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ikp-row button,.ikp-row a{font:inherit;font-size:13px;color:inherit;background:none;border:1px solid rgba(204,162,78,.5);border-radius:8px;padding:5px 10px;cursor:pointer;text-decoration:none}
.ikp-row button:hover,.ikp-row a:hover,.ikp-row button:focus-visible,.ikp-row a:focus-visible{background:rgba(204,162,78,.14);outline:none}
.ikp-recent-foot{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin-top:10px;font-size:12.5px;opacity:.85}
.ikp-recent-foot button{font:inherit;color:inherit;background:none;border:0;text-decoration:underline;cursor:pointer;padding:0}
.ikp-recent-foot label{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.ikp-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
  function injectCss() { if (document.getElementById('ikp-css') || document.querySelector('link[href*="inkwell-plus.css"]')) return; /* strict-CSP pages link the .css file instead */ const s = document.createElement('style'); s.id = 'ikp-css'; s.textContent = css; (document.head || document.documentElement).appendChild(s); }
  injectCss();

  /* ---------------- 1. what this page sends out ---------------- */
  const sent = { fileBytes: 0, items: [] };
  const listeners = new Set();
  const AI_HOSTS = /(^|\.)(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com)$/;
  function describeHost(url) {
    let u; try { u = new URL(url, location.href); } catch (_) { return 'another site'; }
    if (AI_HOSTS.test(u.hostname)) return 'A question to Sherpa AI (with your own key; no files)';
    if (/cloudflareinsights\.com$/.test(u.hostname)) return 'An anonymous page-view count';
    if (u.origin === location.origin) return 'A form you sent us (like your email or a message)';
    return 'A request to ' + u.hostname;
  }
  function bodyInfo(body) {
    try {
      if (body == null) return { bytes: 0, file: false };
      if (typeof Blob !== 'undefined' && body instanceof Blob) return { bytes: body.size, file: true };
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return { bytes: body.byteLength, file: true };
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        let bytes = 0, file = false;
        for (const [k, v] of body.entries()) { if (typeof Blob !== 'undefined' && v instanceof Blob) { bytes += v.size; file = true; } else bytes += k.length + String(v).length + 2; }
        return { bytes, file };
      }
      if (body instanceof URLSearchParams) return { bytes: body.toString().length, file: false };
      if (typeof body === 'string') return { bytes: new Blob([body]).size, file: false };
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return { bytes: 0, file: true, unknown: true };
    } catch (_) {}
    return { bytes: 0, file: false };
  }
  function record(url, info) {
    if (info.file) sent.fileBytes += info.bytes;
    const label = info.file ? 'File data to ' + (function () { try { return new URL(url, location.href).hostname; } catch (_) { return 'another site'; } })() : describeHost(url);
    const prev = sent.items.find((i) => i.label === label);
    if (prev) { prev.count++; prev.bytes += info.bytes; } else sent.items.push({ label, bytes: info.bytes, count: 1 });
    listeners.forEach((fn) => { try { fn(); } catch (_) {} });
  }
  const isWrite = (m) => !/^(GET|HEAD|OPTIONS)$/i.test(m || 'GET');
  if (window.fetch) {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const method = (init && init.method) || (input && input.method) || 'GET';
        if (isWrite(method)) record(url, bodyInfo(init && init.body));
      } catch (_) {}
      return origFetch.apply(this, arguments);
    };
  }
  if (window.XMLHttpRequest) {
    const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) { this.__ikp = { method, url }; return XO.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) { try { if (this.__ikp && isWrite(this.__ikp.method)) record(this.__ikp.url, bodyInfo(body)); } catch (_) {} return XS.apply(this, arguments); };
  }
  if (navigator.sendBeacon) {
    const SB = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { try { record(url, bodyInfo(data)); } catch (_) {} return SB(url, data); };
  }

  function mountMeter(el, opts) {
    if (!el) return;
    opts = opts || {};
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ikp-meter'; btn.setAttribute('aria-expanded', 'false');
    const pop = document.createElement('div'); pop.className = 'ikp-pop'; pop.hidden = true; pop.setAttribute('role', 'status');
    const draw = () => {
      const other = sent.items.filter((i) => !i.label.startsWith('File data'));
      btn.classList.toggle('is-sent', sent.fileBytes > 0);
      btn.innerHTML = `<span class="ikp-dot" aria-hidden="true"></span><span>Files uploaded: <b>${sent.fileBytes ? fmtSize(sent.fileBytes) : 'none'}</b>${other.length ? ` · ${other.reduce((n, i) => n + i.count, 0)} other` : ''}</span>`;
      btn.setAttribute('aria-label', `Files uploaded from this page: ${sent.fileBytes ? fmtSize(sent.fileBytes) : 'none'}. Show details.`);
      pop.innerHTML = `<p><b>${sent.fileBytes ? fmtSize(sent.fileBytes) + ' of file data was sent from this page.' : 'Nothing you opened here has been uploaded.'}</b></p>
        <p>${esc(opts.what || 'Your files are processed by your own browser.')} This counter watches everything the page sends out, live.</p>
        ${sent.items.length ? `<p>Sent so far:</p><ul>${sent.items.map((i) => `<li>${esc(i.label)}${i.count > 1 ? ` (×${i.count})` : ''}${i.bytes ? `, ${fmtSize(i.bytes)}` : ''}</li>`).join('')}</ul>` : '<p>Sent so far: nothing.</p>'}`;
    };
    draw(); listeners.add(draw);
    btn.addEventListener('click', (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden)); });
    document.addEventListener('click', (e) => { if (!pop.hidden && !btn.contains(e.target)) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); btn.focus(); } });
    btn.appendChild(pop);
    el.appendChild(btn);
    return btn;
  }

  /* ---------------- 2. recent results (this browser only) ---------------- */
  const KEEP_KEY = 'inkwell.recent.keep';
  const DAY = 86400000, RECORD_DAYS = 14, MAX_JOBS = 10, MAX_JOB_BYTES = 25 * 1048576, MAX_TOTAL = 80 * 1048576;
  const keepOn = () => { try { return localStorage.getItem(KEEP_KEY) !== 'off'; } catch (_) { return false; } };
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no idb'));
      const r = indexedDB.open('inkwell-plus', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('jobs', { keyPath: 'id' });
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  async function tx(mode, fn) { const d = await db(); return new Promise((res, rej) => { const t = d.transaction('jobs', mode); const s = t.objectStore('jobs'); const out = fn(s); t.oncomplete = () => res(out && out.result !== undefined ? out.result : out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); }
  async function listJobs() {
    try {
      const all = await tx('readonly', (s) => s.getAll());
      const now = Date.now();
      const stale = [];
      for (const j of all) {
        if (now - j.at > RECORD_DAYS * DAY) stale.push({ del: j.id });
        else if (j.blobs && now - j.at > DAY) { j.blobs = null; stale.push({ put: j }); }
      }
      if (stale.length) await tx('readwrite', (s) => stale.forEach((x) => x.del ? s.delete(x.del) : s.put(x.put)));
      return all.filter((j) => now - j.at <= RECORD_DAYS * DAY).sort((a, b) => b.at - a.at);
    } catch (_) { return []; }
  }
  async function recordJob(job) {
    if (!keepOn()) return;
    try {
      const outputs = (job.outputs || []).filter((o) => o && o.blob);
      const total = outputs.reduce((n, o) => n + o.blob.size, 0);
      const entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), at: Date.now(),
        app: job.app || 'Inkwell', tool: job.tool || 'Tool', url: job.url || location.pathname, summary: job.summary || '',
        files: outputs.map((o) => ({ name: o.name, size: o.blob.size, type: o.blob.type || '' })),
        blobs: total && total <= MAX_JOB_BYTES ? outputs.map((o) => o.blob) : null,
        tooBig: total > MAX_JOB_BYTES,
      };
      const all = await listJobs();
      const keep = [entry, ...all].slice(0, MAX_JOBS);
      let bytes = 0;
      for (const j of keep) { const b = j.blobs ? j.files.reduce((n, f) => n + f.size, 0) : 0; if (bytes + b > MAX_TOTAL) j.blobs = null; else bytes += b; }
      const drop = all.filter((j) => !keep.includes(j));
      await tx('readwrite', (s) => { drop.forEach((j) => s.delete(j.id)); keep.forEach((j) => s.put(j)); });
      listeners.forEach((fn) => { try { fn(); } catch (_) {} });
      recentMounts.forEach((m) => m());
    } catch (_) {}
  }
  async function clearJobs() { try { await tx('readwrite', (s) => s.clear()); } catch (_) {} recentMounts.forEach((m) => m()); }
  function downloadBlob(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
  async function makeZip(files) {
    // tiny "store" ZIP (no compression) so several results come down as one file
    const enc = new TextEncoder(); const parts = []; const central = []; let offset = 0;
    const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    const crc32 = (u8) => { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
    const used = new Set();
    for (const f of files) {
      let name = f.name; let i = 2; while (used.has(name)) name = f.name.replace(/(\.[^.]+)?$/, `-${i++}$1`); used.add(name);
      const data = new Uint8Array(await f.blob.arrayBuffer()); const nm = enc.encode(name); const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30)); lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
      parts.push(lh.buffer, nm, data);
      const ch = new DataView(new ArrayBuffer(46)); ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, offset, true);
      central.push(ch.buffer, nm); offset += 30 + nm.length + data.length;
    }
    const csize = central.reduce((n, p) => n + (p.byteLength || p.length), 0);
    const end = new DataView(new ArrayBuffer(22)); end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }
  const recentMounts = new Set();
  function mountRecent(el, opts) {
    if (!el) return;
    opts = opts || {};
    const Tag = opts.headingLevel === 3 ? 'h3' : 'h2';
    el.classList.add('ikp-recent'); el.hidden = true;
    el.setAttribute('aria-label', 'Pick up where you left off');
    const draw = async () => {
      const jobs = (await listJobs()).filter((j) => !opts.app || j.app === opts.app).slice(0, opts.limit || 4);
      if (!jobs.length) { el.hidden = true; el.innerHTML = ''; return; }
      el.hidden = false;
      el.innerHTML = `<${Tag}>Pick up where you left off</${Tag}><p class="ikp-sub">Your recent results, kept only in this browser${keepOn() ? ' for 24 hours' : ''}. Nothing is stored online.</p>
        <div class="ikp-rows">${jobs.map((j) => {
          const names = j.files.map((f) => f.name);
          const what = names.length > 1 ? `${names.length} files: ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}` : (names[0] || j.summary || '');
          return `<div class="ikp-row" data-id="${esc(j.id)}"><div class="ikp-what"><b>${esc(j.tool)}</b>${opts.app ? '' : ` <small class="ikp-app">· ${esc(j.app)}</small>`}<span>${esc(what)} · ${ago(j.at)}</span></div>${j.blobs ? `<button type="button" data-act="dl">Download${j.files.length > 1 ? ' all' : ''}</button>` : ''}<a href="${esc(j.url)}">${j.blobs ? 'Open tool' : 'Use it again'}</a></div>`;
        }).join('')}</div>
        <div class="ikp-recent-foot"><label><input type="checkbox" data-act="keep" ${keepOn() ? 'checked' : ''}/> Keep copies of my results here for 24 hours</label><button type="button" data-act="clear">Clear this list</button></div>`;
      el.querySelectorAll('[data-act=dl]').forEach((b) => b.addEventListener('click', async () => {
        const j = jobs.find((x) => x.id === b.closest('.ikp-row').dataset.id); if (!j || !j.blobs) return;
        if (j.blobs.length === 1) downloadBlob(j.blobs[0], j.files[0].name);
        else { b.disabled = true; b.textContent = 'Zipping…'; downloadBlob(await makeZip(j.blobs.map((blob, i) => ({ blob, name: j.files[i].name }))), `inkwell-results-${new Date(j.at).toISOString().slice(0, 10)}.zip`); b.disabled = false; b.textContent = 'Download all'; }
      }));
      el.querySelector('[data-act=clear]').addEventListener('click', clearJobs);
      el.querySelector('[data-act=keep]').addEventListener('change', async (e) => {
        try { localStorage.setItem(KEEP_KEY, e.target.checked ? 'on' : 'off'); } catch (_) {}
        if (!e.target.checked) { const all = await listJobs(); await tx('readwrite', (s) => all.forEach((j) => { j.blobs = null; s.put(j); })).catch(() => {}); }
        draw();
      });
    };
    recentMounts.add(draw); draw();
  }

  /* ---------------- 3. the Ctrl+K palette ---------------- */
  let tools = null, loading = null;
  function loadIndex() {
    if (tools) return Promise.resolve(tools);
    if (window.INKWELL_TOOLS) { tools = window.INKWELL_TOOLS; return Promise.resolve(tools); }
    if (!loading) loading = new Promise((res) => { const sc = document.createElement('script'); sc.src = cfg.indexUrl; sc.onload = () => { tools = window.INKWELL_TOOLS || []; res(tools); }; sc.onerror = () => { loading = null; res([]); }; document.head.appendChild(sc); });
    return loading;
  }
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ');
  const SYN = { shrink: 'compress', smaller: 'compress', reduce: 'compress', excel: 'xlsx excel', spreadsheet: 'excel csv', photo: 'image photo', picture: 'image photo', pic: 'image photo', car: 'vin car vehicle', mp3: 'mp3 audio', sound: 'audio sound', clean: 'clean tidy', merge: 'merge combine join', join: 'join combine merge', gps: 'location gps' };
  function search(q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const scored = [];
    for (const t of tools || []) {
      const title = norm(t.t), hay = title + ' ' + norm(t.d) + ' ' + norm(t.u) + ' ' + norm(t.g);
      let score = 0, ok = true;
      for (const w of words) {
        const alts = (SYN[w] || w).split(' ').concat(w);
        const hitT = alts.some((a) => title.includes(a)), hitH = hitT || alts.some((a) => hay.includes(a));
        if (!hitH) { ok = false; break; }
        score += hitT ? 3 : 1;
        if (alts.some((a) => title.startsWith(a))) score += 2;
      }
      if (ok) scored.push([score - title.length / 200, t]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 12).map((x) => x[1]);
  }
  let overlay, input, list, items = [], sel = 0, lastFocus = null;
  function buildPalette() {
    if (overlay) return;
    overlay = document.createElement('div'); overlay.className = 'ikp-overlay'; overlay.hidden = true;
    overlay.innerHTML = `<div class="ikp-dialog${reduceMotion() ? ' ikp-still' : ''}" role="dialog" aria-modal="true" aria-label="Jump to a free tool">
      <div class="ikp-top"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input class="ikp-input" type="text" role="combobox" aria-expanded="true" aria-controls="ikp-list" aria-autocomplete="list" placeholder="Jump to a tool… try “compress video” or “csv to excel”" autocomplete="off" spellcheck="false" aria-label="Search all free tools" />
      <button type="button" class="ikp-esc" aria-label="Close">Esc</button></div>
      <ul class="ikp-list" id="ikp-list" role="listbox" aria-label="Tools"></ul>
      <div class="ikp-foot"><span><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to open</span><span>Media · Data · VIN Lookup</span></div></div>`;
    document.body.appendChild(overlay);
    input = overlay.querySelector('.ikp-input'); list = overlay.querySelector('.ikp-list');
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closePalette(); });
    overlay.querySelector('.ikp-esc').addEventListener('click', closePalette);
    input.addEventListener('input', () => { sel = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paintSel(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'Tab') { e.preventDefault(); overlay.querySelector('.ikp-esc').focus(); }
    });
    overlay.querySelector('.ikp-esc').addEventListener('keydown', (e) => { if (e.key === 'Tab') { e.preventDefault(); input.focus(); } });
  }
  function go(it) { if (!it) return; if (it.act) { closePalette(); it.act(); return; } location.href = it.u; }
  function paintSel() {
    list.querySelectorAll('.ikp-opt').forEach((el, i) => { el.setAttribute('aria-selected', String(i === sel)); if (i === sel) { input.setAttribute('aria-activedescendant', el.id); el.scrollIntoView({ block: 'nearest' }); } });
  }
  async function draw() {
    const q = input.value.trim();
    if (!tools) { list.innerHTML = '<li class="ikp-skel" aria-hidden="true"></li><li class="ikp-skel" aria-hidden="true"></li><li class="ikp-skel" aria-hidden="true"></li>'; await loadIndex(); if (!overlay || overlay.hidden) return; }
    let html = ''; items = [];
    const add = (sec, arr) => { if (!arr.length) return; html += `<li class="ikp-sec" role="presentation">${esc(sec)}</li>`; for (const it of arr) { const i = items.length; items.push(it); html += `<li class="ikp-opt" role="option" id="ikp-o${i}" data-i="${i}" aria-selected="false"><span><b>${esc(it.t)}</b><span class="ikp-d">${esc(it.d || '')}</span></span><span class="ikp-g">${esc(it.g || '')}</span></li>`; } };
    if (!q) {
      const jobs = (await listJobs()).slice(0, 3);
      add('Recent', jobs.map((j) => ({ t: j.tool, d: (j.files[0] ? j.files[0].name + (j.files.length > 1 ? ` +${j.files.length - 1} more` : '') : '') + ' · ' + ago(j.at), g: j.app, u: j.url })));
      const pick = ['/inkwellmedia/?recipe=etsy', '/compress-image/', '/compress-video/', '/data/workbench/', '/data/csv-to-excel/', '/VINLookup/'];
      add('Popular', pick.map((u) => (tools || []).find((t) => t.u === u)).filter(Boolean));
    } else add('Tools', search(q));
    list.innerHTML = html || `<li class="ikp-empty">No tool matches “${esc(q)}”. Try fewer words, like “video” or “csv”.</li>`;
    list.querySelectorAll('.ikp-opt').forEach((el) => {
      el.addEventListener('mousemove', () => { const i = +el.dataset.i; if (i !== sel) { sel = i; paintSel(); } });
      el.addEventListener('click', () => go(items[+el.dataset.i]));
    });
    sel = Math.min(sel, Math.max(0, items.length - 1)); paintSel();
  }
  function openPalette() {
    buildPalette(); lastFocus = document.activeElement;
    overlay.hidden = false; input.value = ''; sel = 0; draw(); input.focus();
    document.documentElement.style.overflow = 'hidden';
  }
  function closePalette() { if (!overlay || overlay.hidden) return; overlay.hidden = true; document.documentElement.style.overflow = ''; if (lastFocus && lastFocus.focus) lastFocus.focus(); }
  if (cfg.hotkey) document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); overlay && !overlay.hidden ? closePalette() : openPalette(); }
  });
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  function mountTrigger(el, label) {
    if (!el) return;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ikp-trigger';
    b.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span>${esc(label || 'Find a tool')}</span>${cfg.hotkey ? `<span class="ikp-kbd" aria-hidden="true">${isMac ? '⌘' : 'Ctrl'} K</span>` : ''}`;
    b.setAttribute('aria-keyshortcuts', cfg.hotkey ? (isMac ? 'Meta+K' : 'Control+K') : '');
    b.addEventListener('click', openPalette);
    el.appendChild(b); return b;
  }
  document.addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('[data-ik-palette]'); if (t) { e.preventDefault(); openPalette(); } });

  // Pages can ask for pieces with attributes (no page script needed): data-ikp="trigger" | "meter" | "recent"
  function autoMount() {
    document.querySelectorAll('[data-ikp]').forEach((el) => {
      if (el.dataset.ikpDone) return; el.dataset.ikpDone = '1';
      const kind = el.dataset.ikp;
      if (kind === 'trigger') mountTrigger(el, el.dataset.label);
      else if (kind === 'meter') mountMeter(el, { what: el.dataset.what });
      else if (kind === 'recent') mountRecent(el, { app: el.dataset.app || '', limit: +el.dataset.limit || 4, headingLevel: +el.dataset.level || 2 });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount); else autoMount();

  window.InkwellPlus = { recordJob, listJobs, clearJobs, mountRecent, mountMeter, mountTrigger, openPalette, closePalette, sent, _search: (q) => loadIndex().then(() => search(q)) };
})();
