// Inkwell Media service worker — makes the Media tools work offline after a first visit.
// Scope is "/" (tool pages live at the site root), so it ONLY handles Media URLs and leaves
// everything else on inkwelltools.com (hub, /data, /VINLookup, guides) alone.
const VERSION = 'v4-2026-11-16';
const SHELL = 'inkwell-media-shell-' + VERSION;
const ENGINE = 'inkwell-media-engine-v2';
const RUNTIME = 'inkwell-media-runtime-v1';

const TOOL_PAGES = ['/compress-image/','/convert-image/','/resize-image/','/remove-background/','/crop-image/','/rotate-image/','/watermark-image/','/heic-to-jpg/','/remove-photo-location/','/compress-video/','/convert-to-mp4/','/video-to-gif/','/extract-audio/','/trim-video/','/resize-image-for-instagram/','/resize-image-for-linkedin/','/resize-youtube-thumbnail/','/resize-image-for-etsy/','/resize-image-for-shopify/','/compress-video-for-discord/','/compress-video-for-email/','/blur-faces/','/compress-image-to-size/','/compress-image-to-100kb/','/compress-image-to-200kb/','/compress-image-to-50kb/','/passport-photo/','/auto-captions/','/join-videos/','/mute-video/','/change-video-speed/','/even-out-audio-volume/','/resize-video-for-reels/','/add-subtitles-to-video/','/remove-background-noise/','/screen-recorder/','/photo-collage/'];
const SHELL_URLS = ['/inkwellmedia/','/inkwellmedia/media.css','/inkwellmedia/media.js','/inkwellmedia/media-shell.js','/inkwellmedia/ffmpeg/ffmpeg.js','/inkwellmedia/ffmpeg/814.ffmpeg.js','/inkwellmedia/captions-worker.js','/favicon.svg','/favicon-32.png', ...TOOL_PAGES];
const MEDIA_PREFIXES = ['/inkwellmedia/', ...TOOL_PAGES];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => {})));
    const engine = await caches.open(ENGINE);
    await Promise.all(['/inkwellmedia/vendor/heic-to-1.6.7.js','/inkwellmedia/vendor/fflate-0.8.2.js'].map((url) => engine.add(url).catch(() => {})));
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
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
