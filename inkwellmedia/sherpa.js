// Sherpa for Inkwell Media: "where is it going?" advice for each file, plus optional
// Sherpa AI with the visitor's own key (sends file details only, never the file).
import { askJSON, hasKey, mountKeyBox, getSettings, PROVIDERS, esc } from './sherpa-ai.js';

const MB = 1048576;
const fmtSize = (b) => (b >= MB ? `${(b / MB).toFixed(b >= 10 * MB ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export const DESTS = [
  ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['discord', 'Discord'],
  ['ig-post', 'Instagram post'], ['reels', 'Reels, TikTok or Shorts'], ['youtube', 'YouTube'],
  ['linkedin', 'LinkedIn'], ['x', 'X (Twitter)'], ['etsy', 'Etsy'], ['shopify', 'Shopify'],
  ['website', 'My website or blog'], ['print', 'Printing'], ['profile', 'A profile picture'], ['id', 'A passport or ID'],
];

// Every Media page Sherpa can send a file to.
export const CATALOG = {
  '/compress-image/': 'Compress an image (smaller file, same size on screen)',
  '/compress-image-to-size/': 'Compress a photo to an exact size limit, e.g. under 500 KB',
  '/compress-image-to-100kb/': 'Compress a photo to under 100 KB',
  '/convert-image/': 'Convert images between JPG, PNG and WebP',
  '/convert-image-to-webp/': 'Convert images to WebP for websites',
  '/heic-to-jpg/': 'Convert iPhone HEIC photos to JPG',
  '/resize-image/': 'Resize an image to any size or a preset',
  '/resize-image-for-instagram/': 'Resize a photo for an Instagram post (1080 × 1350)',
  '/resize-image-to-1080x1080/': 'Resize to a 1080 × 1080 square',
  '/resize-image-for-linkedin/': 'Resize an image for a LinkedIn post',
  '/resize-image-for-etsy/': 'Resize product photos for Etsy',
  '/resize-image-for-shopify/': 'Resize product images for Shopify (2048 × 2048)',
  '/resize-youtube-thumbnail/': 'Make a YouTube thumbnail 1280 × 720',
  '/crop-image/': 'Crop an image', '/rotate-image/': 'Rotate or flip an image',
  '/remove-background/': 'Remove the background from a photo',
  '/remove-photo-location/': 'Remove location and camera details from photos and videos',
  '/blur-faces/': 'Blur faces and license plates',
  '/watermark-image/': 'Add a text or logo watermark', '/add-text-to-image/': 'Add text to a photo',
  '/meme-generator/': 'Make a meme', '/photo-collage/': 'Make a photo collage or grid',
  '/before-and-after-photo/': 'Make a before and after photo', '/profile-picture-maker/': 'Make a round profile picture',
  '/passport-photo/': 'Make a passport or ID photo', '/screenshot-beautifier/': 'Make a screenshot look good for social posts',
  '/color-palette-from-image/': 'Get the colour palette from a picture', '/favicon-generator/': 'Make a favicon and app icons from a logo',
  '/compress-video/': 'Compress a video', '/compress-video-for-email/': 'Compress a video to under 25 MB for email',
  '/compress-video-for-discord/': 'Compress a video to under 20 MB for Discord', '/compress-video-for-whatsapp/': 'Compress a video to under 16 MB for WhatsApp',
  '/convert-to-mp4/': 'Convert MOV, HEVC or other video to MP4 that plays everywhere',
  '/trim-video/': 'Trim a video to a shorter clip', '/join-videos/': 'Join several videos into one',
  '/resize-video-for-reels/': 'Make a video vertical 9:16 for Reels, TikTok and Shorts',
  '/auto-captions/': 'Auto captions as an SRT file or burned in', '/tiktok-captions/': 'Burn big bold captions into a vertical video',
  '/add-subtitles-to-video/': 'Burn an existing SRT subtitle file into a video', '/mute-video/': 'Remove the sound from a video',
  '/change-video-speed/': 'Speed up or slow down a video', '/video-to-gif/': 'Turn a short video into a GIF', '/gif-to-mp4/': 'Convert a GIF to MP4',
  '/extract-audio/': 'Save the sound of a video as MP3', '/even-out-audio-volume/': 'Even out the volume of a recording',
  '/remove-background-noise/': 'Remove background noise from a recording', '/ringtone-maker/': 'Make a ringtone from audio',
  '/audiogram-maker/': 'Turn audio into a waveform video for social posts',
};

const vertical = (m) => m.width && m.height && m.height / m.width > 1.6;
const ratio = (m) => (m.width && m.height ? m.width / m.height : 0);

// Advice for one file going to one place. [{ text, path, label, warn }]
export function planFor(dest, m) {
  const out = [];
  const add = (text, path, label, warn) => out.push({ text, path, label, warn: !!warn });
  const img = m.kind === 'image', vid = m.kind === 'video';
  if (m.gps && !['print', 'id'].includes(dest)) add('It still has the GPS location where it was taken. Remove it before it goes anywhere public.', '/remove-photo-location/', 'Remove location', true);
  if (img && m.format === 'HEIC' && dest !== 'print') add('It\'s an iPhone HEIC file. Most sites and Windows PCs want JPG.', '/heic-to-jpg/', 'Convert to JPG', true);
  if (vid && (m.format === 'MOV' || m.codec === 'HEVC') && !['email', 'whatsapp', 'discord'].includes(dest)) add(`It's ${m.codec === 'HEVC' ? 'HEVC (H.265)' : 'a MOV file'}, which some sites and players reject. MP4 (H.264) is the safe choice.`, '/convert-to-mp4/', 'Convert to MP4');
  switch (dest) {
    case 'email':
      if (vid && m.size > 25 * MB) add(`At ${fmtSize(m.size)} it's over the usual 25 MB email limit.`, '/compress-video-for-email/', 'Shrink for email', true);
      if (img && m.size > 5 * MB) add(`At ${fmtSize(m.size)} it will fill inboxes. Under 1 MB looks the same on screen.`, '/compress-image-to-size/', 'Shrink it');
      break;
    case 'whatsapp':
      if (vid && m.size > 16 * MB) add(`At ${fmtSize(m.size)}, WhatsApp will squash it heavily or send it as a document. Under 16 MB keeps it looking good.`, '/compress-video-for-whatsapp/', 'Shrink for WhatsApp', true);
      break;
    case 'discord':
      if (m.size > 20 * MB) add(`At ${fmtSize(m.size)} it's over Discord's 20 MB free upload limit.`, vid ? '/compress-video-for-discord/' : '/compress-image-to-size/', 'Shrink for Discord', true);
      break;
    case 'ig-post':
      if (img && !(Math.abs(ratio(m) - 0.8) < 0.02 || Math.abs(ratio(m) - 1) < 0.02)) add('Instagram crops anything that isn\'t square or 4:5. Resize it to 1080 × 1350 so nothing important is cut off.', '/resize-image-for-instagram/', 'Resize for Instagram');
      if (vid && !vertical(m)) add('Instagram shows videos as Reels in 9:16. A wide video gets small with black bars.', '/resize-video-for-reels/', 'Make it 9:16');
      break;
    case 'reels':
      if (img) add('Reels, TikTok and Shorts need a video. Try a waveform video from audio, or post photos as a carousel instead.', null, null);
      if (vid && !vertical(m)) add(`It's ${m.width && m.width > m.height ? 'landscape' : 'not 9:16'}. Vertical 9:16 fills the screen.`, '/resize-video-for-reels/', 'Make it 9:16', true);
      if (vid && m.duration > 180) add(`It's ${Math.floor(m.duration / 60)} min ${Math.round(m.duration % 60)} s long. Shorts stop at 3 minutes, and short clips do best everywhere.`, '/trim-video/', 'Trim it');
      if (vid) add('Most people watch with the sound off. Big burned-in captions keep them watching.', '/tiktok-captions/', 'Add captions');
      break;
    case 'youtube':
      if (img) add('Using it as a thumbnail? YouTube wants 1280 × 720, under 2 MB.', '/resize-youtube-thumbnail/', 'Make a thumbnail');
      if (vid) add('Captions help viewers and search. Make an SRT file and upload it with the video.', '/auto-captions/', 'Make captions');
      if (vid && vertical(m) && m.duration <= 180) add('It\'s vertical and short, so YouTube will treat it as a Short.', null, null);
      break;
    case 'linkedin':
      if (img) add('LinkedIn posts look best at 1200 × 1200 or 1200 × 627.', '/resize-image-for-linkedin/', 'Resize for LinkedIn');
      if (vid) add('Most LinkedIn videos are watched muted. Burn in captions.', '/tiktok-captions/', 'Add captions');
      break;
    case 'x':
      if (vid && m.duration > 140) add(`It's ${Math.round(m.duration)} seconds. Free X accounts can post up to 2 minutes 20 seconds.`, '/trim-video/', 'Trim it', true);
      if (img && m.size > 5 * MB) add(`X limits photos to 5 MB, and this one is ${fmtSize(m.size)}.`, '/compress-image-to-size/', 'Shrink it', true);
      break;
    case 'etsy':
      if (img) add('Etsy thumbnails are square-ish and zoom needs at least 2000 px. Resize for Etsy keeps it sharp.', '/resize-image-for-etsy/', 'Resize for Etsy');
      if (vid && m.duration > 15) add(`Etsy listing videos must be 5 to 15 seconds, and this is ${Math.round(m.duration)} seconds.`, '/trim-video/', 'Trim to 15 s', true);
      if (vid) add('Etsy plays listing videos without sound.', '/mute-video/', 'Remove the sound');
      if (img) add('A clean white background often looks more professional.', '/remove-background/', 'Remove background');
      break;
    case 'shopify':
      if (img) add('Shopify works best with square 2048 × 2048 product images.', '/resize-image-for-shopify/', 'Resize for Shopify');
      if (img) add('A clean, see-through background makes product photos match.', '/remove-background/', 'Remove background');
      break;
    case 'website':
      if (img && !/webp/i.test(m.format || '')) add('WebP is usually much smaller than JPG or PNG with the same look, so pages load faster.', '/convert-image-to-webp/', 'Convert to WebP');
      if (img && (Math.max(m.width || 0, m.height || 0) > 2400 || m.size > MB)) add(`At ${[m.width ? `${m.width} × ${m.height}` : '', fmtSize(m.size)].filter(Boolean).join(', ')} it's bigger than a web page needs. About 1600 px wide is plenty.`, '/resize-image/', 'Resize it');
      if (vid && m.size > 10 * MB) add(`At ${fmtSize(m.size)} it will load slowly on phones.`, '/compress-video/', 'Compress it');
      if (vid) add('Using it as a background video? Remove the sound so it can autoplay.', '/mute-video/', 'Remove the sound');
      break;
    case 'print':
      if (img && m.width) {
        const inch = (px) => (px / 300).toFixed(1);
        const lo = Math.min(m.width, m.height), hi = Math.max(m.width, m.height);
        add(lo < 1200 ? `At ${m.width} × ${m.height} pixels it prints sharply only up to about ${inch(hi)} × ${inch(lo)} inches. Larger prints will look soft.` : `At ${m.width} × ${m.height} pixels it prints sharply up to about ${inch(hi)} × ${inch(lo)} inches.`, null, null, lo < 1200);
      }
      if (img && m.format === 'HEIC') add('Many print shops can\'t open HEIC.', '/heic-to-jpg/', 'Convert to JPG', true);
      if (vid) add('That\'s a video. To print a frame, pause it and take a screenshot.', null, null);
      break;
    case 'profile':
      if (img) add('Profile pictures are shown as a circle. Centre the face and crop it square.', '/profile-picture-maker/', 'Make a profile picture');
      break;
    case 'id':
      if (img) add('Passport and ID photos have exact sizes and a plain background.', '/passport-photo/', 'Make an ID photo');
      break;
  }
  if (!out.length) out.push({ text: `✓ Ready for ${(DESTS.find((d) => d[0] === dest) || [, 'that'])[1]} as it is.`, path: null, label: null, ok: true });
  return out;
}

const SYSTEM = `You are Sherpa, the guide inside Inkwell Media, free photo, video and audio tools that run in the browser.
The user says what they want to do with their file(s). You get each file's details (type, format, size, pixel size, length) but never the file itself.
Answer ONLY with one JSON object, no markdown:
{"reply": "plain-English advice, at most 70 words, no markdown",
 "steps": [ {"path": "/tool-path/", "why": "one short line"} , ... at most 4, in the order to do them ] }
Use only these tool paths (path: what it does):
{catalog}
If no tool fits, say so in "reply" and return no steps. Don't invent paths. Be practical: mention platform limits only if you are sure of them.`;

export function buildRequest(metas, ask) {
  const catalog = Object.entries(CATALOG).map(([p, d]) => `${p}: ${d}`).join('\n');
  const files = metas.map((m) => ({ name: m.name, kind: m.kind, format: m.format, codec: m.codec || undefined, size: fmtSize(m.size), pixels: m.width ? `${m.width}x${m.height}` : undefined, seconds: m.duration ? Math.round(m.duration) : undefined, has_location: !!m.gps }));
  return { system: SYSTEM.replace('{catalog}', catalog), user: JSON.stringify({ request: ask, files }, null, 1) };
}

// Sherpa AI box for the Media check-up. opts: getMetas() -> [meta]; open(path) hands the files to that tool.
export function mountMediaAsk(el, { getMetas, open }) {
  el.innerHTML = `
    <div class="sherpa-ask">
      <form class="sherpa-bar" autocomplete="off">
        <input type="text" class="sherpa-q" aria-label="What are you trying to do?" placeholder="e.g. Post this on my Etsy listing and Instagram">
        <button type="submit" class="sherpa-btn sherpa-btn-primary" data-a="ask">Ask</button>
      </form>
      <div class="sherpa-out" aria-live="polite"></div>
      <p class="sherpa-small sherpa-muted"><span class="sherpa-mode"></span> <button type="button" class="sherpa-link" data-a="settings"></button> · <button type="button" class="sherpa-link" data-a="peek">What's sent?</button></p>
      <pre class="sherpa-peek hidden"></pre>
      <div class="sherpa-settings hidden"><div class="sherpa-keyhost"></div></div>
    </div>`;
  const q = el.querySelector('.sherpa-q'), out = el.querySelector('.sherpa-out'), settings = el.querySelector('.sherpa-settings');
  const mode = () => {
    el.querySelector('.sherpa-mode').textContent = hasKey() ? `Uses your ${PROVIDERS[getSettings().provider]?.label || ''} key.` : 'Needs your own AI key (Google\'s is free).';
    el.querySelector('[data-a=settings]').textContent = hasKey() ? 'AI settings' : 'Add a key';
  };
  mode();
  mountKeyBox(el.querySelector('.sherpa-keyhost'), { onChange: () => { mode(); if (hasKey()) settings.classList.add('hidden'); } });
  el.querySelector('[data-a=settings]').addEventListener('click', () => settings.classList.toggle('hidden'));
  el.querySelector('[data-a=peek]').addEventListener('click', () => { const pre = el.querySelector('.sherpa-peek'); pre.textContent = `Only file details are sent, never the file:\n\n${buildRequest(getMetas(), q.value.trim() || '(your request)').user}`; pre.classList.toggle('hidden'); });
  el.querySelector('.sherpa-bar').addEventListener('submit', (e) => { e.preventDefault(); ask(); });
  async function ask() {
    const text = q.value.trim();
    if (!text) { q.focus(); return; }
    if (!hasKey()) { settings.classList.remove('hidden'); out.innerHTML = '<p class="sherpa-small">Add your AI key first. A Google Gemini key is free.</p>'; return; }
    const btn = el.querySelector('[data-a=ask]'); btn.disabled = true;
    out.innerHTML = '<p class="sherpa-small sherpa-muted">Sherpa is thinking…</p>';
    try {
      const { data, model } = await askJSON(buildRequest(getMetas(), text));
      const steps = (Array.isArray(data.steps) ? data.steps : []).filter((s) => s && CATALOG[s.path]).slice(0, 4);
      out.innerHTML = `<div class="sherpa-answer"><p class="sherpa-reply">${esc(String(data.reply || 'Here is a plan.').slice(0, 600))}</p>
        ${steps.length ? `<ol class="sherpa-plan">${steps.map((s, k) => `<li><span>${esc(String(s.why || CATALOG[s.path]).slice(0, 160))}</span><button type="button" class="next-btn" data-open="${esc(s.path)}">${k === 0 ? 'Start here' : 'Then'}: ${esc(CATALOG[s.path].split(' (')[0])} →</button></li>`).join('')}</ol>` : ''}
        <p class="sherpa-small sherpa-muted">By ${esc(model)} with your key. AI can be wrong.</p></div>`;
      out.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => { b.disabled = true; open(b.dataset.open); }));
    } catch (e) {
      out.innerHTML = `<p class="sherpa-err">${esc(e.message || String(e))}</p>`;
      if (e.kind === 'key') settings.classList.remove('hidden');
    } finally { btn.disabled = false; }
  }
}
