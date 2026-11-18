// Inkwell Media service worker — makes the Media tools work offline after a first visit.
// Scope is "/" (tool pages live at the site root), so it ONLY handles Media URLs and leaves
// everything else on inkwelltools.com (hub, /data, /VINLookup, guides) alone.
const VERSION = 'v7c-2026-11-17';
const SHELL = 'inkwell-media-shell-' + VERSION;
const ENGINE = 'inkwell-media-engine-v2';
const RUNTIME = 'inkwell-media-runtime-v1';

const TOOL_PAGES = ['/compress-image/','/convert-image/','/resize-image/','/remove-background/','/crop-image/','/rotate-image/','/watermark-image/','/heic-to-jpg/','/remove-photo-location/','/compress-video/','/convert-to-mp4/','/video-to-gif/','/extract-audio/','/trim-video/','/resize-image-for-instagram/','/resize-image-for-linkedin/','/resize-youtube-thumbnail/','/resize-image-for-etsy/','/resize-image-for-shopify/','/compress-video-for-discord/','/compress-video-for-email/','/blur-faces/','/compress-image-to-size/','/compress-image-to-100kb/','/compress-image-to-200kb/','/compress-image-to-50kb/','/passport-photo/','/auto-captions/','/join-videos/','/mute-video/','/change-video-speed/','/even-out-audio-volume/','/resize-video-for-reels/','/add-subtitles-to-video/','/remove-background-noise/','/screen-recorder/','/photo-collage/','/add-text-to-image/','/profile-picture-maker/','/favicon-generator/','/gif-to-mp4/','/before-and-after-photo/','/meme-generator/','/resize-image-to-1080x1080/','/mp4-to-mp3/','/convert-image-to-webp/','/compress-video-for-whatsapp/','/tiktok-captions/','/screenshot-beautifier/','/color-palette-from-image/','/qr-code-generator/','/ringtone-maker/','/audiogram-maker/','/iphone-ringtone-maker/','/wifi-qr-code-generator/'];
const SHELL_URLS = ['/inkwellmedia/','/inkwellmedia/media.css','/inkwellmedia/media.js','/inkwellmedia/media-shell.js','/inkwellmedia/sherpa.js','/inkwellmedia/sherpa-ai.js','/inkwellmedia/ffmpeg/ffmpeg.js','/inkwellmedia/ffmpeg/814.ffmpeg.js','/inkwellmedia/captions-worker.js','/favicon.svg','/favicon-32.png', ...TOOL_PAGES];
const MEDIA_PREFIXES = ['/inkwellmedia/', ...TOOL_PAGES];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    const engine = await caches.open(ENGINE);
    await Promise.all(['/inkwellmedia/vendor/heic-to-1.6.7.js','/inkwellmedia/vendor/fflate-0.8.2.js','/inkwellmedia/vendor/qrcode-generator-1.4.4.js'].map((url) => engine.add(url).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL, ENGINE, RUNTIME];
    for (const key of await caches.keys()) if (key.startsWith('inkwell-media-') && !keep.includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok || response.type === 'opaque') { try { await cache.put(request, response.clone()); } catch (_) {} }
  return response;
}
async function networkFirst(request) {
  const cache = await caches.open(SHELL);
  try {
    const response = await fetch(request);
    if (response.ok) { try { await cache.put(request, response.clone()); } catch (_) {} }
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

// Files shared to the installed app from the phone's share sheet (Web Share Target).
// They're kept in the same IndexedDB slot the tools use to pass files along, then the Media home asks what to do.
function putShared(files) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('inkwell-media', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handoff');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result; const tx = db.transaction('handoff', 'readwrite');
      tx.objectStore('handoff').put({ at: Date.now(), files: files.map((f) => ({ name: f.name || 'shared-file', type: f.type, blob: f })) }, 'files');
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    };
  });
}
async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('media').filter((f) => f && typeof f === 'object' && f.size);
    if (files.length) await putShared(files.slice(0, 30));
  } catch (_) {}
  return Response.redirect('/inkwellmedia/?shared=1', 303);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method === 'POST' && new URL(request.url).pathname === '/inkwellmedia/share/') { event.respondWith(receiveShare(request)); return; }
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);

  // Background-removal model and runtime (IMG.LY CDN / esm.sh): download once, then offline.
  const isBackgroundAsset = url.hostname === 'staticimgly.com' && url.pathname.includes('/@imgly/background-removal-data/');
  const isRuntimeModule = url.hostname === 'esm.sh' && /(?:@imgly\/background-removal|onnxruntime-web)/.test(url.pathname);
  if (isBackgroundAsset || isRuntimeModule) { event.respondWith(cacheFirst(request, RUNTIME)); return; }

  // Fonts used by the Media pages.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { event.respondWith(cacheFirst(request, RUNTIME)); return; }

  if (url.origin !== self.location.origin) return;
  // Versioned engine files never change at the same address: cache-first.
  if (url.pathname.startsWith('/inkwellmedia/ffmpeg/') || url.pathname.startsWith('/inkwellmedia/vendor/')) { event.respondWith(cacheFirst(request, ENGINE)); return; }
  if (MEDIA_PREFIXES.some((p) => url.pathname === p || url.pathname === p.replace(/\/$/, '') || (p === '/inkwellmedia/' && url.pathname.startsWith(p)))) {
    event.respondWith(networkFirst(request));
  }
});
