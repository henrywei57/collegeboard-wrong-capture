// Walks a College Board MCQ review one question at a time, decides whether the
// question was marked incorrect, and screenshots the ones that were.
(() => {
  if (window.__cbwcLoaded) return;
  window.__cbwcLoaded = true;

  const DEFAULTS = {
    folder: 'collegeboard-wrong',
    mode: 'auto',            // auto | next | nav
    format: 'png',           // png | jpeg
    quality: 92,
    fullPage: true,
    hideFixed: true,
    settleMs: 900,           // wait after moving to a new question
    captureGapMs: 700,       // captureVisibleTab is rate limited (~2/sec)
    maxQuestions: 250,
    captureAll: false,       // true = save every question, not just wrong ones
    nextSelector: '',
    scopeSelector: ''
  };

  // Containers whose performance icons belong to *other* questions.
  const SIDEBAR = [
    'nav', 'aside', '[role="navigation"]', '[role="tablist"]',
    '[class*="sidebar" i]', '[id*="sidebar" i]',
    '[class*="navigator" i]', '[class*="question-list" i]',
    '[class*="questionList" i]', '[class*="quiz-nav" i]'
  ].join(', ');

  const SCOPE_CANDIDATES = [
    '[data-test*="question-container" i]',
    '[data-test*="question" i]',
    '[class*="question-container" i]',
    '[id*="question-container" i]',
    'main', '[role="main"]', '#main-content', '#main', 'article'
  ];

  const NEXT_SELECTORS = [
    'button[aria-label*="next question" i]',
    'a[aria-label*="next question" i]',
    '[data-test*="next-question" i]',
    '[data-testid*="next-question" i]',
    '[data-test*="next" i]',
    '[data-testid*="next" i]',
    'button[aria-label*="next" i]',
    'a[aria-label*="next" i]',
    '#next-question', '.next-question', 'button.next', 'a.next'
  ];

  const NAV_ITEM_SELECTORS = [
    '[class*="navigator" i] button',
    '[class*="question-list" i] button',
    '[class*="questionList" i] button',
    'nav button[aria-label*="question" i]',
    'button[aria-label^="Question" i]',
    'a[aria-label^="Question" i]',
    '[role="tablist"] [role="tab"]'
  ];

  const state = { running: false, cancel: false, log: [] };
  let currentOpts = Object.assign({}, DEFAULTS);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, error: 'no response from background' });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });

  function visible(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }

  function labelOf(el) {
    const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
    return aria + ' ' + (el.innerText || el.textContent || '');
  }

  // ---------- where the current question lives ----------

  function getScope(opts) {
    if (opts.scopeSelector) {
      const el = document.querySelector(opts.scopeSelector);
      if (el) return el;
    }
    for (const sel of SCOPE_CANDIDATES) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 40) return el;
    }
    return document.body;
  }

  // ---------- right / wrong ----------

  function performanceIcons(scope) {
    return Array.from(scope.querySelectorAll('.performance_icon'))
      .filter((el) => !el.closest(SIDEBAR));
  }

  // The markup this keys off:
  //   <span class="performance_icon">
  //     <i class="x-mark-big"></i>
  //     <span data-test-performance-icon-score class="label">0/1</span>
  //     <span class="label"> MC point</span>
  //     <span class="sr-only">Incorrect answer</span>
  //   </span>
  function iconVerdict(el) {
    const srEl = el.querySelector('.sr-only');
    const sr = srEl ? srEl.textContent : '';
    if (/\bincorrect\b/i.test(sr)) return 'incorrect';
    if (/\bcorrect\b/i.test(sr)) return 'correct';

    if (el.querySelector('.x-mark-big, [class*="x-mark" i], [class*="xmark" i]')) return 'incorrect';
    if (el.querySelector('[class*="check" i], [class*="tick" i]')) return 'correct';

    const scoreEl = el.querySelector('[data-test-performance-icon-score]') || el.querySelector('.label');
    const text = scoreEl ? scoreEl.textContent : '';
    const m = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) < Number(m[2]) ? 'incorrect' : 'correct';

    return 'unknown';
  }

  function verdictFor(scope) {
    const icons = performanceIcons(scope);
    if (!icons.length) return { verdict: 'none', icons: 0 };
    const verdicts = icons.map(iconVerdict);
    if (verdicts.indexOf('incorrect') !== -1) return { verdict: 'incorrect', icons: icons.length };
    if (verdicts.indexOf('correct') !== -1) return { verdict: 'correct', icons: icons.length };
    return { verdict: 'unknown', icons: icons.length };
  }

  // ---------- identifying the question ----------

  function questionInfo(scope) {
    const text = (scope.innerText || '').slice(0, 5000);
    let num = null;
    let total = null;
    let m = text.match(/Question\s+(\d+)\s*(?:of|\/)\s*(\d+)/i);
    if (m) { num = Number(m[1]); total = Number(m[2]); }
    if (num === null) {
      m = text.match(/(?:^|\n)\s*Question\s+(\d+)/i);
      if (m) num = Number(m[1]);
    }
    const fingerprint = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    return { num: num, total: total, fingerprint: fingerprint };
  }

  // ---------- navigation ----------

  function findNext(opts) {
    if (opts.nextSelector) {
      const el = document.querySelector(opts.nextSelector);
      return visible(el) ? el : null;
    }
    for (const sel of NEXT_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (visible(el) && !/previous|prev|back/i.test(labelOf(el))) return el;
      }
    }
    for (const el of document.querySelectorAll('button, a[href], [role="button"]')) {
      const label = labelOf(el).replace(/\s+/g, ' ').trim();
      if (/^(next|next question|next\s*[>›])$/i.test(label) && visible(el)) return el;
    }
    return null;
  }

  function findNavItems() {
    for (const sel of NAV_ITEM_SELECTORS) {
      const items = Array.from(document.querySelectorAll(sel)).filter(visible);
      if (items.length >= 2) return items;
    }
    return [];
  }

  async function waitForChange(prevFingerprint, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(150);
      const info = questionInfo(getScope(currentOpts));
      if (info.fingerprint && info.fingerprint !== prevFingerprint) return true;
    }
    return false;
  }

  // ---------- capture ----------

  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > doc.clientHeight + 40) return { el: doc, isWindow: true };
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, section, main, article')) {
      const st = getComputedStyle(el);
      if (!/(auto|scroll)/.test(st.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { bestArea = area; best = el; }
    }
    return best ? { el: best, isWindow: false } : { el: doc, isWindow: true };
  }

  function getScroll(s) { return s.isWindow ? window.scrollY : s.el.scrollTop; }

  function setScroll(s, y) {
    if (s.isWindow) window.scrollTo(0, y);
    else s.el.scrollTop = y;
  }

  // Sticky/fixed chrome repeats in every slice of a stitched shot, so hide it
  // while capturing — but never anything that contains the question itself.
  function stickyElements(scope) {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'sticky') continue;
      if (el.contains(scope) || scope.contains(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push(el);
    }
    return out;
  }

  function isPermissionError(msg) {
    return /permission/i.test(msg || '');
  }

  // captureVisibleTab is rate limited to roughly two calls a second, so a lone
  // failure is usually worth one retry. A permission failure never is.
  async function captureOnce() {
    let res = await send({ type: 'CAPTURE' });
    if (!res.ok && !isPermissionError(res.error)) {
      await sleep(1200);
      res = await send({ type: 'CAPTURE' });
    }
    if (!res.ok) throw new Error(res.error);
    return res.dataUrl;
  }

  async function captureQuestion(opts, scope) {
    const scroller = findScroller();
    const view = scroller.isWindow ? window.innerHeight : scroller.el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const startAt = getScroll(scroller);
    const segments = [];
    let hidden = [];

    if (opts.fullPage && opts.hideFixed) {
      hidden = stickyElements(scope).map((el) => ({ el: el, prev: el.style.visibility }));
      hidden.forEach((h) => { h.el.style.visibility = 'hidden'; });
    }

    try {
      if (!opts.fullPage) {
        setScroll(scroller, 0);
        await sleep(300);
        segments.push({ dataUrl: await captureOnce(), y: 0 });
      } else {
        const total = scroller.isWindow
          ? Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          : scroller.el.scrollHeight;
        let target = 0;
        for (let i = 0; i < 40; i++) {
          setScroll(scroller, target);
          await sleep(280);
          const actual = getScroll(scroller);
          if (segments.length && actual <= segments[segments.length - 1].y) break;
          segments.push({ dataUrl: await captureOnce(), y: actual });
          if (actual + view >= total - 2) break;
          target = actual + view;
          await sleep(opts.captureGapMs);
        }
      }
    } finally {
      hidden.forEach((h) => { h.el.style.visibility = h.prev; });
      setScroll(scroller, startAt);
    }

    return { segments: segments, dpr: dpr };
  }

  function sanitize(s) {
    return String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // ---------- the walk ----------

  function report(line, extra) {
    state.log.push(line);
    if (state.log.length > 300) state.log.shift();
    const status = Object.assign({
      running: state.running,
      line: line,
      log: state.log.slice(-60)
    }, extra || {});
    chrome.storage.local.set({ cbwcStatus: status });
    try { chrome.runtime.sendMessage({ type: 'PROGRESS', status: status }); } catch (e) { /* popup closed */ }
  }

  async function run(options) {
    currentOpts = Object.assign({}, DEFAULTS, options || {});
    const opts = currentOpts;
    state.running = true;
    state.cancel = false;
    state.log = [];

    const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const folder = sanitize(opts.folder) || 'collegeboard-wrong';
    const ext = opts.format === 'jpeg' ? 'jpg' : 'png';
    const dest = folder + '/' + runId;

    let mode = opts.mode;
    let navItems = [];
    if (mode === 'auto' || mode === 'nav') {
      navItems = findNavItems();
      if (mode === 'auto') mode = (navItems.length >= 2 && !findNext(opts)) ? 'nav' : 'next';
    }
    report('Starting in "' + mode + '" mode. Saving to Downloads/' + dest + '/');

    let seen = 0;
    let saved = 0;
    let index = 0;
    let lastFingerprint = '';

    try {
      while (!state.cancel && seen < opts.maxQuestions) {
        const scope = getScope(opts);
        const info = questionInfo(scope);
        if (seen > 0 && info.fingerprint && info.fingerprint === lastFingerprint) {
          report('Page stopped changing — finishing here.');
          break;
        }
        lastFingerprint = info.fingerprint;
        seen++;
        index = info.num || index + 1;

        const v = verdictFor(scope);
        const label = info.num ? ('Q' + info.num + (info.total ? '/' + info.total : '')) : ('#' + seen);

        if (v.verdict === 'incorrect' || opts.captureAll) {
          report(label + ': ' + v.verdict + (v.icons ? '' : ' (no score icon found)') + ' - capturing...');
          try {
            const shot = await captureQuestion(opts, scope);
            const name = 'q' + String(index).padStart(3, '0') + '-' + v.verdict + '.' + ext;
            const res = await send({
              type: 'SAVE',
              segments: shot.segments,
              dpr: shot.dpr,
              format: opts.format,
              quality: opts.quality,
              filename: dest + '/' + name
            });
            if (res.ok) {
              saved++;
              report(label + ': saved ' + name + ' (' + shot.segments.length + ' slice' +
                (shot.segments.length > 1 ? 's' : '') + ', ' + Math.round(res.bytes / 1024) + ' KB)',
                { saved: saved, seen: seen });
            } else {
              report(label + ': save failed - ' + res.error, { saved: saved, seen: seen });
            }
          } catch (err) {
            const m = err && err.message ? err.message : String(err);
            if (isPermissionError(m)) {
              throw new Error('Chrome blocked the screenshot (' + m + '). Reload the extension ' +
                'at chrome://extensions, then reopen this popup and press Start again.');
            }
            // A one-off capture glitch shouldn't cost you the rest of the test.
            report(label + ': capture failed - ' + m + ' (moving on)', { saved: saved, seen: seen });
          }
        } else {
          report(label + ': ' + v.verdict + ' - skipped', { saved: saved, seen: seen });
        }

        if (state.cancel) break;

        let moved = false;
        if (mode === 'nav') {
          const fresh = findNavItems();
          if (fresh.length >= navItems.length) navItems = fresh;
          const target = navItems[seen];
          if (target) {
            target.scrollIntoView({ block: 'center' });
            target.click();
            await waitForChange(lastFingerprint, 8000);
            moved = true;
          }
        } else {
          const btn = findNext(opts);
          if (btn) {
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            moved = await waitForChange(lastFingerprint, 8000);
          }
        }

        if (!moved) {
          report('No further question found.');
          break;
        }
        await sleep(opts.settleMs);
      }
    } catch (err) {
      report('Stopped on error: ' + (err && err.message ? err.message : String(err)));
    }

    state.running = false;
    report('Done. Checked ' + seen + ' question' + (seen === 1 ? '' : 's') + ', saved ' + saved +
      ' image' + (saved === 1 ? '' : 's') + ' to Downloads/' + dest + '/',
      { saved: saved, seen: seen, finished: true });
  }

  // ---------- messaging ----------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'PING') {
      sendResponse({ ok: true, running: state.running });
      return;
    }

    if (msg.type === 'START') {
      if (state.running) { sendResponse({ ok: false, error: 'already running' }); return; }
      run(msg.options);
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'STOP') {
      state.cancel = true;
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'TEST') {
      const opts = Object.assign({}, DEFAULTS, msg.options || {});
      currentOpts = opts;
      const scope = getScope(opts);
      const info = questionInfo(scope);
      const v = verdictFor(scope);
      const nextBtn = findNext(opts);
      const cls = scope.className ? '.' + String(scope.className).split(/\s+/)[0] : '';
      sendResponse({
        ok: true,
        scope: scope.tagName.toLowerCase() + cls,
        question: info.num ? ('Question ' + info.num + (info.total ? ' of ' + info.total : '')) : '(number not found)',
        verdict: v.verdict,
        icons: v.icons,
        next: nextBtn ? (labelOf(nextBtn).replace(/\s+/g, ' ').trim().slice(0, 40) || nextBtn.tagName.toLowerCase()) : null,
        navItems: findNavItems().length
      });
      return;
    }
  });
})();
