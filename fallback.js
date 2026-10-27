// Opened by background.js when the source tab cannot be scripted. Shows the
// same snipping overlay over the screenshot that was captured from that tab.

function closeTab() {
  chrome.tabs.getCurrent((tab) => {
    if (tab) chrome.tabs.remove(tab.id);
  });
}

chrome.runtime.sendMessage({ type: 'qr:take-capture' }, (dataUrl) => {
  if (!dataUrl) {
    const message = document.createElement('div');
    message.className = 'message';
    message.textContent =
      'No screenshot found. Close this tab and click the extension icon again.';
    document.body.append(message);
    return;
  }
  window.__qrSnip.start(dataUrl, { onClose: closeTab });
});
