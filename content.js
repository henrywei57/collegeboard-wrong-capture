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
    captureTarget: 'page',   // page | element
    elementSelector: '',     // used when captureTarget === 'element'
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
    let fallback = null;
    for (const sel of SCOPE_CANDIDATES) {
      const el = document.querySelector(sel);
      if (!el || !el.innerText || el.innerText.trim().length <= 40) continue;
      if (!fallback) fallback = el;
      // A container too narrow to hold the score badge can't tell us the
      // verdict, so keep looking for one that does.
      if (performanceIcons(el).length) return el;
    }
    return fallback || document.body;
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

  // The slice of the tab viewport that actually shows the scroll container.
  function visibleBand(scroller) {
    if (scroller.isWindow) return { top: 0, bottom: window.innerHeight };
    const r = scroller.el.getBoundingClientRect();
    return { top: Math.max(0, r.top), bottom: Math.min(window.innerHeight, r.bottom) };
  }

  // Screenshot one element rather than the page: scroll it to the top of the
  // visible area, capture, and send a crop rectangle along with each slice so
  // the background only keeps the element's own pixels. An element taller than
  // the viewport is walked down in bands and stacked.
  async function captureElement(opts, el) {
    const scroller = findScroller();
    const dpr = window.devicePixelRatio || 1;
    const startAt = getScroll(scroller);
    const segments = [];
    let hidden = [];

    if (opts.hideFixed) {
      hidden = stickyElements(el).map((node) => ({ el: node, prev: node.style.visibility }));
      hidden.forEach((h) => { h.el.style.visibility = 'hidden'; });
    }

    try {
      el.scrollIntoView({ block: 'start' });
      await sleep(280);

      const totalHeight = el.getBoundingClientRect().height;
      let captured = 0;

      for (let i = 0; i < 40; i++) {
        const band = visibleBand(scroller);
        const before = el.getBoundingClientRect();
        const delta = (before.top + captured) - band.top;
        if (Math.abs(delta) > 1) {
          setScroll(scroller, getScroll(scroller) + delta);
          await sleep(260);
        }

        const rect = el.getBoundingClientRect();
        const now = visibleBand(scroller);
        // Start below anything already captured, so a page that cannot scroll
        // any further doesn't repeat rows into the next slice.
        const top = Math.max(rect.top + captured, now.top, 0);
        const bottom = Math.min(rect.bottom, now.bottom, window.innerHeight);
        const left = Math.max(rect.left, 0);
        const right = Math.min(rect.right, window.innerWidth);
        const h = bottom - top;
        const w = right - left;
        if (h < 2 || w < 2) break;

        segments.push({
          dataUrl: await captureOnce(),
          crop: { x: left, y: top, w: w, h: h }
        });
        captured += h;
        if (captured >= totalHeight - 2) break;
        await sleep(opts.captureGapMs);
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

  // ---------- picking an element ----------

  const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');

  // Framework-generated names (css-1x2y3z, sc-AbCdEf, hashes) change between
  // page loads, so they make a useless selector.
  function stableName(name) {
    if (!name || name.length > 40) return false;
    if (/^(css|sc|jsx|emotion)-/i.test(name)) return false;
    if (/\d{3,}/.test(name)) return false;
    if (/^[a-f0-9]{8,}$/i.test(name)) return false;
    return /^[A-Za-z][\w-]*$/.test(name);
  }

  function partFor(node) {
    let sel = node.tagName.toLowerCase();
    const attrs = Array.from(node.attributes || []);
    const test = attrs.find((a) => a.name.indexOf('data-test') === 0);
    if (test) {
      return sel + '[' + test.name + (test.value ? '=' + JSON.stringify(test.value) : '') + ']';
    }
    const cls = Array.from(node.classList || []).filter(stableName)[0];
    if (cls) sel += '.' + esc(cls);
    return sel;
  }

  // Walk up until the selector matches exactly one element on the page.
  function uniqueSelector(el) {
    if (el.id && stableName(el.id)) {
      const byId = '#' + esc(el.id);
      if (document.querySelectorAll(byId).length === 1) return byId;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 8) {
      parts.unshift(partFor(node));
      const sel = parts.join(' > ');
      if (document.querySelectorAll(sel).length === 1) return sel;
      node = node.parentElement;
    }
    const sel = parts.join(' > ');
    if (document.querySelectorAll(sel).length > 1 && el.parentElement) {
      const siblings = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName);
      const nth = siblings.indexOf(el) + 1;
      if (nth > 0) parts[parts.length - 1] += ':nth-of-type(' + nth + ')';
    }
    return parts.join(' > ');
  }

  const picker = { active: false };

  function stopPicker() {
    if (!picker.active) return;
    picker.active = false;
    document.removeEventListener('mousemove', picker.onMove, true);
    document.removeEventListener('click', picker.onClick, true);
    document.removeEventListener('keydown', picker.onKey, true);
    if (picker.box) picker.box.remove();
    if (picker.tip) picker.tip.remove();
  }

  function banner(text, ms) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;' +
      'background:#1f6feb;color:#fff;font:13px/1.4 system-ui,sans-serif;padding:8px 14px;border-radius:6px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.3);max-width:80vw;text-align:center;pointer-events:none;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 4000);
  }

  function startPicker() {
    if (picker.active) return;
    picker.active = true;

    picker.box = document.createElement('div');
    picker.box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;' +
      'border:2px solid #1f6feb;background:rgba(31,111,235,.12);border-radius:3px;';
    picker.tip = document.createElement('div');
    picker.tip.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:#1f6feb;' +
      'color:#fff;font:11px/1.4 ui-monospace,Consolas,monospace;padding:3px 6px;border-radius:4px;' +
      'max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    document.body.appendChild(picker.box);
    document.body.appendChild(picker.tip);

    picker.onMove = (e) => {
      const target = document.elementFromPoint(e.clientX, e.clientY);
      if (!target || target === picker.box || target === picker.tip) return;
      picker.target = target;
      const r = target.getBoundingClientRect();
      picker.box.style.left = r.left + 'px';
      picker.box.style.top = r.top + 'px';
      picker.box.style.width = r.width + 'px';
      picker.box.style.height = r.height + 'px';
      picker.tip.textContent = Math.round(r.width) + '×' + Math.round(r.height) + '  ' + partFor(target);
      picker.tip.style.left = Math.max(4, r.left) + 'px';
      picker.tip.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px';
    };

    picker.onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = picker.target || document.elementFromPoint(e.clientX, e.clientY);
      stopPicker();
      if (!target) return;
      const selector = uniqueSelector(target);
      chrome.storage.local.get(['cbwcOptions'], (data) => {
        const saved = Object.assign({}, data.cbwcOptions || {}, {
          captureTarget: 'element',
          elementSelector: selector
        });
        chrome.storage.local.set({ cbwcOptions: saved, cbwcPicked: selector });
      });
      banner('Capture area set: ' + selector + ' — reopen the extension and press Start.', 6000);
    };

    picker.onKey = (e) => {
      if (e.key === 'Escape') {
        stopPicker();
        banner('Element picking cancelled.', 2000);
      }
    };

    document.addEventListener('mousemove', picker.onMove, true);
    document.addEventListener('click', picker.onClick, true);
    document.addEventListener('keydown', picker.onKey, true);
    banner('Click the part of the question you want screenshotted. Esc to cancel.', 6000);
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
            let shot;
            if (opts.captureTarget === 'element' && opts.elementSelector) {
              const target = document.querySelector(opts.elementSelector);
              if (target) {
                shot = await captureElement(opts, target);
              } else {
                report(label + ': "' + opts.elementSelector + '" not on this question - using full page');
                shot = await captureQuestion(opts, scope);
              }
            } else {
              shot = await captureQuestion(opts, scope);
            }
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
      stopPicker();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'PICK') {
      startPicker();
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
      let area = 'whole page';
      if (opts.captureTarget === 'element' && opts.elementSelector) {
        const matches = document.querySelectorAll(opts.elementSelector);
        if (!matches.length) {
          area = 'NOT FOUND on this question';
        } else {
          const r = matches[0].getBoundingClientRect();
          area = Math.round(r.width) + '×' + Math.round(r.height) + ' px' +
            (matches.length > 1 ? ' (' + matches.length + ' matches, using the first)' : '');
        }
      }
      sendResponse({
        ok: true,
        area: area,
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
