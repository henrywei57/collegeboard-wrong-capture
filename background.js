// Service worker: screen capture + image stitching + downloads.
// The content script drives the walk; this file only does the things a page
// cannot do for itself.

const MAX_CANVAS_PX = 32000; // Chrome refuses canvases taller than ~32767px.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'CAPTURE') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, dataUrl });
      }
    });
    return true;
  }

  if (msg.type === 'SAVE') {
    saveShot(msg).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.type === 'STATUS') {
    chrome.storage.local.set({ cbwcStatus: msg.status });
    return;
  }
});

async function saveShot({ segments, dpr, filename, format, quality }) {
  if (!segments || !segments.length) throw new Error('no segments to save');

  const parts = [];
  for (const seg of segments) {
    const blob = await (await fetch(seg.dataUrl)).blob();
    parts.push({ bitmap: await createImageBitmap(blob), y: Math.round(seg.y * dpr) });
  }

  const width = parts[0].bitmap.width;
  const last = parts[parts.length - 1];
  let height = last.y + last.bitmap.height;
  if (height > MAX_CANVAS_PX) height = MAX_CANVAS_PX;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  for (const part of parts) {
    ctx.drawImage(part.bitmap, 0, part.y);
    part.bitmap.close();
  }

  const blob = format === 'jpeg'
    ? await canvas.convertToBlob({ type: 'image/jpeg', quality: Math.max(1, Math.min(100, quality || 92)) / 100 })
    : await canvas.convertToBlob({ type: 'image/png' });

  const url = await blobToDataUrl(blob);
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false
  });
  return { ok: true, downloadId, width, height, bytes: blob.size };
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
