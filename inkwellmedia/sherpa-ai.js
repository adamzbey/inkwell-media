// Sherpa AI: the optional "use your own key" helper shared by Inkwell Data and Inkwell Media.
// The key is kept only in this browser (localStorage). Requests go straight from the browser to
// the provider the visitor picked. Nothing passes through Inkwell, and Inkwell pays nothing.

const STORE = 'inkwell.sherpa.v1';

export const PROVIDERS = {
  gemini: {
    label: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyHint: 'Free key from Google AI Studio. Starts with "AIza".',
    note: 'Google offers a free tier. On the free tier, Google may use what you send to improve its products.',
    fallback: 'gemini-2.5-flash',
  },
  anthropic: {
    label: 'Anthropic Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyHint: 'Key from the Anthropic Console. Starts with "sk-ant-". Paid per use.',
    note: 'Billed to your Anthropic account, usually a fraction of a cent per question.',
    fallback: 'claude-haiku-4-5',
  },
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'Key from the OpenAI platform. Starts with "sk-". Paid per use.',
    note: 'Billed to your OpenAI account, usually a fraction of a cent per question.',
    fallback: 'gpt-4o-mini',
  },
};

export function getSettings() {
  try { return JSON.parse(localStorage.getItem(STORE) || 'null') || { provider: 'gemini', keys: {}, models: {} }; }
  catch { return { provider: 'gemini', keys: {}, models: {} }; }
}
export function saveSettings(s) { try { localStorage.setItem(STORE, JSON.stringify(s)); return true; } catch { return false; } }
export function hasKey() { const s = getSettings(); return !!(s.keys && s.keys[s.provider]); }
export function forgetKeys() { try { localStorage.removeItem(STORE); } catch {} }

class SherpaError extends Error { constructor(msg, kind) { super(msg); this.kind = kind; } }

function friendly(status, provider, body) {
  const who = PROVIDERS[provider]?.label || 'The AI provider';
  if (status === 400 && /api[_ ]?key|API_KEY_INVALID/i.test(body)) return new SherpaError(`${who} didn't accept that key. Check you copied all of it.`, 'key');
  if (status === 401 || status === 403) return new SherpaError(`${who} didn't accept that key. Check you copied all of it, and that it's switched on.`, 'key');
  if (status === 429) return new SherpaError(`${who} says you've hit your limit for now. On a free key, wait a minute and try again.`, 'limit');
  if (status === 402 || /credit|billing|quota/i.test(body)) return new SherpaError(`${who} says the account behind this key has no credit or quota left.`, 'limit');
  if (status >= 500) return new SherpaError(`${who} is having trouble right now. Try again in a moment.`, 'server');
  return new SherpaError(`${who} couldn't answer (error ${status}). ${body.slice(0, 160)}`, 'other');
}

async function call(url, opts, provider) {
  let r;
  try { r = await fetch(url, opts); }
  catch { throw new SherpaError(`Couldn't reach ${PROVIDERS[provider].label}. Check your internet connection.`, 'network'); }
  const text = await r.text();
  if (!r.ok) throw friendly(r.status, provider, text);
  try { return JSON.parse(text); } catch { throw new SherpaError('The answer came back in a form Sherpa could not read. Try again.', 'parse'); }
}

const verNum = (s) => { const m = /(\d+(?:\.\d+)?)/.exec(s); return m ? Number(m[1]) : 0; };

// Pick a quick, low-cost model the key can use, so we never hard-code a model that has been retired.
async function pickModel(provider, key) {
  const s = getSettings();
  const cached = s.models?.[provider];
  if (cached && cached.key === key.slice(-6) && Date.now() - cached.at < 7 * 864e5) return cached.id;
  let id = PROVIDERS[provider].fallback;
  try {
    if (provider === 'gemini') {
      const j = await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { headers: { 'x-goog-api-key': key } }, provider);
      const ok = (j.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''))
        .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|audio|live|thinking|exp|embed|8b|native|latest/.test(n));
      ok.sort((a, b) => verNum(b) - verNum(a) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0) || a.length - b.length);
      if (ok[0]) id = ok[0];
    } else if (provider === 'anthropic') {
      const j = await call('https://api.anthropic.com/v1/models?limit=100', { headers: anthropicHeaders(key) }, provider);
      const ids = (j.data || []).map((m) => m.id);
      id = ids.find((x) => /haiku/.test(x)) || ids.find((x) => /sonnet/.test(x)) || ids[0] || id;
    } else if (provider === 'openai') {
      const j = await call('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } }, provider);
      const ids = (j.data || []).map((m) => m.id).filter((x) => /^gpt-[\d.]+o?-mini$/.test(x));
      ids.sort((a, b) => verNum(b) - verNum(a));
      if (ids[0]) id = ids[0];
    }
  } catch (e) { if (e.kind === 'key' || e.kind === 'network') throw e; }
  s.models = { ...(s.models || {}), [provider]: { id, at: Date.now(), key: key.slice(-6) } };
  saveSettings(s);
  return id;
}

function anthropicHeaders(key) {
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json' };
}

function firstJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  throw new SherpaError('Sherpa got an answer it could not read. Try asking again, maybe in different words.', 'parse');
}

// Ask the visitor's chosen provider. Returns the parsed JSON object the model wrote.
export async function askJSON({ system, user, signal }) {
  const s = getSettings();
  const provider = s.provider || 'gemini';
  const key = (s.keys || {})[provider];
  if (!key) throw new SherpaError('Add your key first.', 'nokey');
  const model = s.modelOverride?.[provider] || (await pickModel(provider, key));
  if (provider === 'gemini') {
    const j = await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }),
    }, provider);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new SherpaError(j.promptFeedback?.blockReason ? 'Google declined to answer that request.' : 'Gemini sent back an empty answer. Try again.', 'empty');
    return { data: firstJson(text), model, provider };
  }
  if (provider === 'anthropic') {
    const j = await call('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal, headers: anthropicHeaders(key),
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
    }, provider);
    const text = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    return { data: firstJson(text), model, provider };
  }
  const j = await call('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, response_format: { type: 'json_object' }, max_completion_tokens: 8000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  }, provider);
  return { data: firstJson(j.choices?.[0]?.message?.content), model, provider };
}

// Quick check that a key works (lists models; costs nothing).
export async function testKey(provider, key) {
  const s = getSettings();
  if (s.models) delete s.models[provider];
  saveSettings(s);
  return pickModel(provider, key);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The "Your AI key" settings box. onChange is called after a key is saved or forgotten.
export function mountKeyBox(el, { onChange } = {}) {
  const draw = () => {
    const s = getSettings();
    const p = s.provider || 'gemini';
    const key = (s.keys || {})[p] || '';
    const P = PROVIDERS[p];
    el.innerHTML = `
      <div class="sherpa-keybox">
        <p class="sherpa-small">Sherpa's AI answers come from your own AI account, so Inkwell never sees your data and it stays free. Your key is saved only in this browser.</p>
        <label class="sherpa-field"><span>AI provider</span>
          <select data-k="provider">${Object.entries(PROVIDERS).map(([id, x]) => `<option value="${id}"${id === p ? ' selected' : ''}>${esc(x.label)}${id === 'gemini' ? ' (free key)' : ''}</option>`).join('')}</select></label>
        <label class="sherpa-field"><span>Your key</span>
          <input type="password" data-k="key" autocomplete="off" spellcheck="false" placeholder="Paste your key" value="${esc(key)}"></label>
        <p class="sherpa-small">${esc(P.keyHint)} <a href="${P.keyUrl}" target="_blank" rel="noopener">Get a key →</a></p>
        <p class="sherpa-small sherpa-muted">${esc(P.note)}</p>
        <div class="sherpa-row">
          <button type="button" class="sherpa-btn sherpa-btn-primary" data-k="save">Save and test</button>
          ${key ? '<button type="button" class="sherpa-btn" data-k="forget">Forget my key</button>' : ''}
          <span class="sherpa-status" data-k="status" aria-live="polite">${key ? `✓ Key saved${s.models?.[p]?.id ? ` · using ${esc(s.models[p].id)}` : ''}` : ''}</span>
        </div>
      </div>`;
    el.querySelector('[data-k=provider]').addEventListener('change', (e) => { const n = getSettings(); n.provider = e.target.value; saveSettings(n); draw(); onChange && onChange(); });
    el.querySelector('[data-k=save]').addEventListener('click', async (e) => {
      const st = el.querySelector('[data-k=status]');
      const k = el.querySelector('[data-k=key]').value.trim();
      if (!k) { st.textContent = 'Paste your key first.'; return; }
      const n = getSettings(); n.keys = { ...(n.keys || {}), [p]: k }; saveSettings(n);
      e.target.disabled = true; st.textContent = 'Testing…';
      try { const m = await testKey(p, k); st.textContent = `✓ Works · using ${m}`; setTimeout(() => { draw(); onChange && onChange(); }, 900); }
      catch (err) { st.textContent = err.message; const n2 = getSettings(); delete n2.keys[p]; saveSettings(n2); e.target.disabled = false; }
    });
    el.querySelector('[data-k=forget]')?.addEventListener('click', () => { const n = getSettings(); delete n.keys[p]; if (n.models) delete n.models[p]; saveSettings(n); draw(); onChange && onChange(); });
  };
  draw();
  return { redraw: draw };
}

export { SherpaError, esc };
