const FIELDS = ['folder', 'mode', 'format', 'settleMs', 'maxQuestions', 'fullPage', 'captureAll',
  'captureTarget', 'elementSelector', 'scopeSelector', 'nextSelector'];
const logEl = document.getElementById('log');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const testBtn = document.getElementById('test');

function readOptions() {
  const o = {};
  for (const id of FIELDS) {
    const el = document.getElementById(id);
    if (el.type === 'checkbox') o[id] = el.checked;
    else if (el.type === 'number') o[id] = Number(el.value);
    else o[id] = el.value;
  }
  return o;
}

function applyOptions(o) {
  if (!o) return;
  for (const id of FIELDS) {
    if (!(id in o)) continue;
    const el = document.getElementById(id);
    if (el.type === 'checkbox') el.checked = !!o[id];
    else el.value = o[id];
  }
}

function setLog(lines) {
  logEl.textContent = Array.isArray(lines) ? lines.join('\n') : String(lines);
  logEl.scrollTop = logEl.scrollHeight;
}

function setRunning(running) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  testBtn.disabled = running;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// Talk to the content script, injecting it first if the page loaded before the
// extension did.
async function toContent(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return await chrome.tabs.sendMessage(tabId, msg);
  }
}

// "Just one element" hides the full-page toggle: an element capture already
// scrolls the element through the viewport when it is too tall to fit.
const targetSel = document.getElementById('captureTarget');
const elementRow = document.getElementById('elementRow');
const fullPageRow = document.getElementById('fullPage').closest('.check');

function syncTargetUI() {
  const element = targetSel.value === 'element';
  elementRow.hidden = !element;
  fullPageRow.hidden = element;
}
targetSel.addEventListener('change', syncTargetUI);

document.getElementById('pick').addEventListener('click', async () => {
  const tab = await activeTab();
  try {
    await toContent(tab.id, { type: 'PICK' });
    // The popup has to close for the page to receive the click.
    window.close();
  } catch (e) {
    setLog('Could not start picking: ' + e.message);
  }
});

startBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (!tab || !/^https:\/\/[^/]*collegeboard\.org\//.test(tab.url || '')) {
    setLog('Open a collegeboard.org review page in this tab first.');
    return;
  }
  const options = readOptions();
  await chrome.storage.local.set({ cbwcOptions: options });
  setRunning(true);
  setLog('Starting…');
  try {
    const res = await toContent(tab.id, { type: 'START', options });
    if (!res || !res.ok) {
      setRunning(false);
      setLog('Could not start: ' + ((res && res.error) || 'no response'));
    }
  } catch (e) {
    setRunning(false);
    setLog('Could not start: ' + e.message);
  }
});

stopBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  try { await toContent(tab.id, { type: 'STOP' }); } catch (e) { /* ignore */ }
  setRunning(false);
});

testBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  try {
    const r = await toContent(tab.id, { type: 'TEST', options: readOptions() });
    setLog([
      'Capture area:       ' + r.area,
      'Question container: ' + r.scope,
      'Question:           ' + r.question,
      'Score icons found:  ' + r.icons,
      'Verdict:            ' + r.verdict,
      'Next button:        ' + (r.next ? '"' + r.next + '"' : 'not found'),
      'Question list items:' + r.navItems,
      '',
      r.verdict === 'incorrect'
        ? 'This question would be captured.'
        : (r.verdict === 'none'
            ? 'No score icon in the container — try an Advanced selector.'
            : 'This question would be skipped.')
    ]);
  } catch (e) {
    setLog('Test failed: ' + e.message + '\nReload the College Board tab and try again.');
  }
});

// Opening this popup grants activeTab for the current tab, which is all
// captureVisibleTab needs — until the page does a full navigation and drops the
// grant mid-run. The optional all-sites permission survives that.
const permState = document.getElementById('permState');
const grantAll = document.getElementById('grantAll');

async function refreshPermission() {
  const always = await chrome.permissions.contains({ origins: ['<all_urls>'] });
  permState.textContent = always
    ? 'Screenshot access: always granted'
    : 'Screenshot access: per-click (granted when you open this popup)';
  grantAll.hidden = always;
}

grantAll.addEventListener('click', async () => {
  try {
    await chrome.permissions.request({ origins: ['<all_urls>'] });
  } catch (e) { /* user dismissed */ }
  refreshPermission();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'PROGRESS' && msg.status) {
    setLog(msg.status.log);
    setRunning(!!msg.status.running);
  }
});

(async () => {
  const { cbwcOptions, cbwcStatus, cbwcPicked } = await chrome.storage.local.get(
    ['cbwcOptions', 'cbwcStatus', 'cbwcPicked']);
  applyOptions(cbwcOptions);
  syncTargetUI();
  if (cbwcPicked) {
    await chrome.storage.local.remove('cbwcPicked');
    const count = cbwcPicked.split(/\s*,\s*/).filter(Boolean).length;
    setLog('Capture area' + (count === 1 ? '' : 's (' + count + ')') + ' set to:\n  ' +
      cbwcPicked.split(/\s*,\s*/).join('\n  ') +
      '\n\nThey stack into one image per question, in page order.' +
      '\nPress Test page to check, or Start to run.');
  }
  const tab = await activeTab();
  let running = false;
  try {
    const pong = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
    running = !!(pong && pong.running);
  } catch (e) { /* content script not loaded yet */ }
  setRunning(running);
  if (!cbwcPicked && cbwcStatus && cbwcStatus.log) setLog(cbwcStatus.log);
  refreshPermission();
})();
