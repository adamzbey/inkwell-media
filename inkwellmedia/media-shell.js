const mediaShell = document.getElementById('media-shell');
mediaShell.innerHTML = `
  <div id="hub" class="hidden">
    <section class="checkup" id="checkup" aria-labelledby="checkup-title">
      <div class="checkup-head">
        <span class="checkup-kicker">Free check-up</span>
        <h2 id="checkup-title">What's hiding in your photo or video?</h2>
        <p>Drop a photo or video to see what it gives away and what might stop it opening or sending: your location, the camera, an awkward format, or a size that's too big to email. Nothing is uploaded.</p>
      </div>
      <button type="button" class="drop drop-compact" id="ck-drop">
        <svg viewBox="0 0 24 24" fill="none" stroke="#cca24e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
        <div class="big">Drop photos or videos to check them</div>
        <div class="small">JPG, PNG, WebP, HEIC, MP4, MOV · several at once is fine</div>
      </button>
      <input type="file" id="ck-file" class="hidden" multiple accept="image/*,.heic,.heif,video/*" />
      <div id="ck-results" class="hidden" aria-live="polite"></div>
    </section>
    <div id="hub-groups"></div>
  </div>

  <div id="tool" class="hidden">
    <div class="toolbar">
      <button class="back" id="tool-back" aria-label="Back to all tools">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <div class="tt" id="tool-title">Tool</div>
    </div>
    <div class="card">
      <div id="s-pick">
        <button type="button" class="drop" id="drop" aria-describedby="tool-capacity">
          <svg id="drop-icon" viewBox="0 0 24 24" fill="none" stroke="#cca24e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
          <div class="big" id="drop-big">Drop a file here, or click to choose</div>
          <div class="small" id="drop-small">Works best on a computer</div>
        </button>
        <input type="file" id="file" class="hidden" aria-describedby="tool-capacity" />
      </div>

      <div id="s-ready" class="hidden">
        <div class="filerow">
          <div class="fic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#cca24e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg></div>
          <div style="min-width:0"><div class="fname" id="r-name">file</div><div class="fsize" id="r-size">—</div></div>
        </div>
        <div id="opts"></div>
        <button class="btn btn-primary" id="go" aria-describedby="tool-capacity">Go</button>
        <button class="btn btn-ghost" id="change">Choose a different file</button>
        <div class="settings-row hidden" id="settings-row"><button type="button" class="linkbtn" id="set-link">Copy a link with these settings</button><span aria-hidden="true">·</span><button type="button" class="linkbtn" id="set-reset">Reset to defaults</button><span class="set-msg" id="set-msg" aria-live="polite"></span></div>
        <div id="ready-warn"></div>
      </div>

      <aside class="capacity" id="tool-capacity" aria-label="File size and processing limits">
        <dl class="capacity-sizes">
          <div><dt>Recommended size</dt><dd id="capacity-recommended"></dd></div>
          <div><dt>Maximum file size</dt><dd id="capacity-maximum"></dd></div>
        </dl>
        <p id="capacity-note"></p>
      </aside>

      <div id="s-working" class="hidden">
        <div class="prog-head"><span id="w-label">Working…</span><span class="pct" id="w-pct">0%</span></div>
        <div class="track" id="w-track"><div class="fill" id="w-fill"></div></div>
        <p class="prog-note" id="w-note">Working on your device.</p>
        <div class="batch-progress hidden" id="w-files" aria-live="polite"></div>
        <div class="elapsed" id="w-elapsed"></div>
        <button class="btn btn-ghost" id="w-cancel" type="button">Stop</button>
      </div>

      <div id="s-done" class="hidden">
        <div class="result">
          <div class="headline"><span id="d-pct">Done</span><span class="word" id="d-word">smaller</span></div>
          <div id="d-preview-slot"></div>
          <div class="sizes"><span class="from" id="d-from">—</span><span class="arrow">→</span><span class="to" id="d-to">—</span></div>
        </div>
        <button class="btn btn-primary" id="download">Download</button>
        <button class="btn btn-ghost hidden" id="share-btn" type="button">Share…</button>
        <button class="btn btn-ghost" id="again">Do another</button>
        <div id="done-note"></div>
        <div id="d-next"></div>
        <div id="capture" class="capture hidden">
          <button class="cap-x" id="cap-dismiss" aria-label="Dismiss">&times;</button>
          <div id="cap-form">
            <div class="cap-title">Hear about new tools</div>
            <div class="cap-sub">Occasional updates — no spam, unsubscribe anytime.</div>
            <div class="cap-row">
              <input type="email" id="cap-email" placeholder="you@example.com" autocomplete="email" />
              <button class="btn-cap" id="cap-btn">Notify me</button>
            </div>
            <div class="cap-msg" id="cap-msg"></div>
          </div>
          <div id="cap-thanks" class="hidden">
            <div class="cap-title">Thanks — you are on the list.</div>
            <div class="cap-sub">We will send the occasional update.</div>
          </div>
        </div>
      </div>

      <div id="err-slot"></div>
    </div>
  </div>

  <div id="contact" class="hidden">
    <div class="toolbar">
      <button class="back" id="contact-back" aria-label="Back to all tools">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <div class="tt">Contact us</div>
    </div>
    <div class="card">
      <div id="ct-form">
        <p class="sub" style="margin:0 0 18px">Questions, feedback, or a tool you wish existed? Send us a note and we will get back to you.</p>
        <div class="field"><label for="ct-name">Your name</label><input type="text" id="ct-name" autocomplete="name" /></div>
        <div class="field"><label for="ct-email">Your email</label><input type="email" id="ct-email" autocomplete="email" /></div>
        <div class="field"><label for="ct-msg">Message</label><textarea id="ct-msg" rows="5"></textarea></div>
        <button class="btn btn-primary" id="ct-send">Send message</button>
        <div class="cap-msg" id="ct-status"></div>
      </div>
      <div id="ct-thanks" class="hidden result">
        <div class="cap-title" style="font-size:18px">Thanks — your message is on its way.</div>
        <div class="cap-sub" style="margin-top:6px">We will reply to the email you provided.</div>
        <button class="btn btn-ghost" id="ct-again" style="margin-top:16px">Send another</button>
      </div>
    </div>
  </div>

  <div class="foot">
    <span class="privacy">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Everything runs in your browser. Your files never leave your device.
    </span>
  </div>`;
// Show the right panel straight away (the tool on tool pages, the list on the home page), so nothing jumps when media.js starts.
document.getElementById(document.body.dataset.tool ? 'tool' : 'hub')?.classList.remove('hidden');
