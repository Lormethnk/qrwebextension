// Toolbar button / keyboard shortcut entry point.
// Flow: freeze the visible tab as a screenshot, then let the user pick a region
// on top of it (content/snip.js). Pages that refuse script injection (Chrome
// Web Store, PDF viewer, ...) get the same UI in an extension tab instead.

const DEFAULT_TITLE = 'Select and read a QR code (Alt+Shift+Q)';
const SNIP_FILES = ['lib/jsQR.js', 'content/snip.js'];

// Screenshot handed to the fallback tab; kept in memory because a hi-DPI PNG
// can exceed chrome.storage.session quotas.
let pendingCapture = null;

chrome.action.onClicked.addListener(async (tab) => {
  const target = { tabId: tab.id };

  let state;
  try {
    state = await probe(target);
  } catch {
    state = 'blocked';
  }
  // A second click while the overlay is open acts as a toggle.
  if (state === 'closed') return;

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    console.warn('[QR Snip] captureVisibleTab failed:', err);
    flashError(tab.id, "This page can't be captured (internal Chrome pages are not supported).");
    return;
  }

  if (state === 'blocked') {
    openFallback(tab, dataUrl);
    return;
  }

  try {
    if (state === 'missing') {
      await chrome.scripting.executeScript({ target, files: SNIP_FILES });
    }
    await chrome.scripting.executeScript({
      target,
      func: (url) => window.__qrSnip.start(url),
      args: [dataUrl],
    });
  } catch (err) {
    console.warn('[QR Snip] injection failed, using fallback tab:', err);
    openFallback(tab, dataUrl);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'qr:open-url':
      if (/^https?:\/\//i.test(msg.url)) {
        chrome.tabs.create({
          url: msg.url,
          index: sender.tab ? sender.tab.index + 1 : undefined,
          openerTabId: sender.tab?.id,
        });
      }
      break;
    case 'qr:take-capture':
      sendResponse(pendingCapture);
      pendingCapture = null;
      break;
  }
});

// Returns 'missing' (script not injected yet), 'ready', or 'closed' (an open
// overlay was just dismissed). Throws when the page cannot be scripted.
async function probe(target) {
  const [res] = await chrome.scripting.executeScript({
    target,
    func: () => {
      const snip = window.__qrSnip;
      if (!snip) return 'missing';
      if (snip.isOpen()) {
        snip.close();
        return 'closed';
      }
      return 'ready';
    },
  });
  return res?.result ?? 'missing';
}

async function openFallback(tab, dataUrl) {
  pendingCapture = dataUrl;
  await chrome.tabs.create({
    url: chrome.runtime.getURL('snip.html'),
    index: tab.index + 1,
    openerTabId: tab.id,
  });
}

async function flashError(tabId, message) {
  await chrome.action.setBadgeBackgroundColor({ color: '#dc2626', tabId });
  await chrome.action.setBadgeText({ text: '!', tabId });
  await chrome.action.setTitle({ title: message, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: DEFAULT_TITLE, tabId }).catch(() => {});
  }, 4000);
}
