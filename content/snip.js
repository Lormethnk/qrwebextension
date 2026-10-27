// Snipping overlay: shows the frozen screenshot, lets the user drag a region,
// decodes the QR code inside it and shows the text with copy/open actions.
// Runs both as an injected content script and inside snip.html (fallback).
// Exposes window.__qrSnip = { start(dataUrl, options), close(), isOpen() }.

(() => {
  if (window.__qrSnip) return;

  const MIN_SELECTION = 6; // px; smaller drags count as a click
  const MAX_DECODE_SIDE = 1600; // larger crops are scaled down for jsQR
  const UPSCALE_STEPS = [2, 3, 4, 6]; // retried for small or blurry codes
  const MAX_UPSCALED_SIDE = 2000;
  const QUIET_ZONE = 0.12; // white padding added for tightly cropped codes

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .stage {
      --surface: #ffffff;
      --text: #111827;
      --muted: #6b7280;
      --border: #e5e7eb;
      --field: #f9fafb;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --accent-text: #ffffff;
      --danger: #dc2626;
      --success: #16a34a;
      --shade: rgba(15, 23, 42, 0.5);

      position: fixed;
      inset: 0;
      overflow: hidden;
      cursor: crosshair;
      user-select: none;
      touch-action: none;
      outline: none;
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
    }
    @media (prefers-color-scheme: dark) {
      .stage {
        --surface: #1f2937;
        --text: #f3f4f6;
        --muted: #9ca3af;
        --border: #374151;
        --field: #111827;
        --accent: #3b82f6;
        --accent-hover: #60a5fa;
        --accent-text: #0b1220;
        --danger: #f87171;
        --success: #4ade80;
      }
    }

    /* 100vw/100vh include the scrollbar, matching captureVisibleTab. */
    .shot { position: absolute; left: 0; top: 0; width: 100vw; height: 100vh; display: block; }
    .dim { position: absolute; inset: 0; background: var(--shade); }
    .sel {
      position: absolute;
      outline: 2px solid #3b82f6;
      outline-offset: 0;
      box-shadow: 0 0 0 200vmax var(--shade);
    }
    .sel.busy { outline-style: dashed; }

    .hint {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      max-width: calc(100vw - 32px);
      padding: 8px 16px;
      border-radius: 999px;
      background: rgba(17, 24, 39, 0.92);
      color: #f9fafb;
      font-size: 13px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
    }
    kbd {
      font: inherit;
      font-size: 12px;
      padding: 1px 6px;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 4px;
    }

    .panel {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      width: min(460px, calc(100vw - 32px));
      max-height: calc(100vh - 32px);
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      color: var(--text);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
      cursor: default;
      user-select: text;
    }
    .head { display: flex; align-items: center; gap: 12px; }
    .thumb {
      flex: none;
      width: 56px;
      height: 56px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #fff;
      object-fit: contain;
    }
    .titles { flex: 1; min-width: 0; }
    .title { margin: 0; font-size: 15px; font-weight: 600; }
    .title.error { color: var(--danger); }
    .sub { margin: 2px 0 0; color: var(--muted); font-size: 12.5px; }
    .x {
      flex: none;
      align-self: flex-start;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 20px;
      line-height: 1;
      cursor: pointer;
    }
    .x:hover { background: var(--field); color: var(--text); }

    textarea {
      width: 100%;
      min-height: 72px;
      max-height: 40vh;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--field);
      color: var(--text);
      font: 13px/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
      resize: vertical;
      white-space: pre-wrap;
      word-break: break-all;
    }
    textarea:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .spacer { flex: 1; }
    button.btn {
      padding: 7px 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      font: inherit;
      font-weight: 500;
      cursor: pointer;
    }
    button.btn:hover { background: var(--field); }
    button.btn:focus-visible, .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button.primary { border-color: var(--accent); background: var(--accent); color: var(--accent-text); }
    button.primary:hover { border-color: var(--accent-hover); background: var(--accent-hover); }
    button.done { border-color: var(--success); background: var(--success); color: #fff; }
  `;

  let session = null;
  let sheet = null;
  let nativeDetector; // undefined = not checked yet, null = unavailable

  function isOpen() {
    return session !== null;
  }

  function close() {
    if (!session) return;
    const { host, bitmap, cleanup, onClose } = session;
    session = null;
    cleanup();
    host.remove();
    bitmap.close();
    onClose?.();
  }

  async function start(dataUrl, options = {}) {
    close();
    // Decoding the data URL by hand (instead of <img src>) keeps the page's
    // CSP img-src rules out of the picture.
    const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
    mount(bitmap, options);
  }

  function dataUrlToBlob(dataUrl) {
    const [meta, base64] = dataUrl.split(',', 2);
    const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'image/png';
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key in el) el[key] = value;
      else el.setAttribute(key, value);
    }
    el.append(...children);
    return el;
  }

  function mount(bitmap, { onClose } = {}) {
    const host = document.createElement('qr-snip-overlay');
    host.style.cssText =
      'all: initial !important; position: fixed !important; inset: 0 !important;' +
      'z-index: 2147483647 !important; display: block !important;';
    const root = host.attachShadow({ mode: 'closed' });
    if (!sheet) {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(STYLE);
    }
    root.adoptedStyleSheets = [sheet];

    const shot = h('canvas', { class: 'shot', width: bitmap.width, height: bitmap.height });
    shot.getContext('2d').drawImage(bitmap, 0, 0);

    const dim = h('div', { class: 'dim' });
    const sel = h('div', { class: 'sel', hidden: true });
    const hint = h(
      'div',
      { class: 'hint' },
      'Drag to select the area containing the QR code · ',
      h('kbd', { text: 'Esc' }),
      ' to cancel',
    );

    const thumb = h('canvas', { class: 'thumb' });
    const title = h('p', { class: 'title' });
    const sub = h('p', { class: 'sub' });
    const closeX = h('button', { class: 'x', type: 'button', title: 'Close (Esc)', text: '×' });
    const output = h('textarea', { readOnly: true, spellcheck: false, rows: 3 });
    const copyBtn = h('button', { class: 'btn primary', type: 'button', text: 'Copy' });
    const openBtn = h('button', { class: 'btn', type: 'button', text: 'Open link' });
    const retryBtn = h('button', { class: 'btn', type: 'button', text: 'Select again' });
    const closeBtn = h('button', { class: 'btn', type: 'button', text: 'Close' });
    const panel = h(
      'div',
      { class: 'panel', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'QR result' },
      h('div', { class: 'head' }, thumb, h('div', { class: 'titles' }, title, sub), closeX),
      output,
      h('div', { class: 'actions' }, copyBtn, openBtn, h('span', { class: 'spacer' }), retryBtn, closeBtn),
    );

    const stage = h('div', { class: 'stage', tabIndex: -1 }, shot, dim, sel, hint, panel);
    root.append(stage);
    document.documentElement.append(host);

    let drag = null;
    let rect = null;
    let resultText = '';
    let copyTimer = 0;
    let runId = 0;

    function showIdle() {
      runId++;
      drag = null;
      rect = null;
      sel.hidden = true;
      sel.classList.remove('busy');
      panel.hidden = true;
      dim.hidden = false;
      hint.hidden = false;
      stage.focus({ preventScroll: true });
    }

    function drawSelection() {
      Object.assign(sel.style, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.w}px`,
        height: `${rect.h}px`,
      });
    }

    function onPointerDown(e) {
      if (e.button !== 0 || panel.contains(e.target)) return;
      e.preventDefault();
      runId++; // abandon any decode still in flight
      stage.setPointerCapture(e.pointerId);
      drag = { x0: e.clientX, y0: e.clientY };
      rect = { x: e.clientX, y: e.clientY, w: 0, h: 0 };
      drawSelection();
      sel.classList.remove('busy');
      sel.hidden = false;
      dim.hidden = true;
      hint.hidden = true;
      panel.hidden = true;
    }

    function onPointerMove(e) {
      if (!drag) return;
      const box = stage.getBoundingClientRect();
      const x = clamp(e.clientX, 0, box.width);
      const y = clamp(e.clientY, 0, box.height);
      rect = {
        x: Math.min(drag.x0, x),
        y: Math.min(drag.y0, y),
        w: Math.abs(x - drag.x0),
        h: Math.abs(y - drag.y0),
      };
      drawSelection();
    }

    async function onPointerUp(e) {
      if (!drag) return;
      drag = null;
      if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
      if (rect.w < MIN_SELECTION || rect.h < MIN_SELECTION) {
        showIdle();
        return;
      }

      const id = ++runId;
      sel.classList.add('busy');
      const crop = cropRegion(bitmap, shot, rect);
      const text = await decodeQR(crop);
      if (id !== runId || !session) return;
      sel.classList.remove('busy');
      showResult(text, crop);
    }

    function showResult(text, crop) {
      // Many generators end the payload with a line break; drop it so a
      // copied URL pastes cleanly.
      resultText = (text ?? '').replace(/[\r\n]+$/, '');
      const found = text !== null;

      drawThumb(thumb, crop);
      title.textContent = found ? 'QR code read' : 'No QR code found';
      title.classList.toggle('error', !found);
      sub.textContent = found
        ? `${pluralize([...resultText].length, 'character')}${isHttpUrl(resultText) ? ' · link' : ''}`
        : 'Make sure the selection covers the whole QR code. If the code looks small, ' +
          'zoom in (Ctrl +) and try again.';

      output.hidden = !found;
      output.value = resultText;
      copyBtn.hidden = !found;
      openBtn.hidden = !found || !isHttpUrl(resultText);
      resetCopyButton();
      panel.hidden = false;

      if (found) {
        output.style.height = 'auto';
        output.style.height = `${Math.min(output.scrollHeight + 2, window.innerHeight * 0.4)}px`;
      }
      placePanel();

      if (found) {
        output.focus({ preventScroll: true });
        output.select();
      } else {
        retryBtn.focus({ preventScroll: true });
      }
    }

    // Puts the panel next to the selection so the code stays visible:
    // below, above, right, left; otherwise the roomier of below/above,
    // clamped into the viewport.
    function placePanel() {
      const gap = 12;
      const edge = 16;
      const vw = stage.clientWidth;
      const vh = stage.clientHeight;
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      const centerX = clamp(rect.x + rect.w / 2 - pw / 2, edge, vw - pw - edge);
      const centerY = clamp(rect.y + rect.h / 2 - ph / 2, edge, vh - ph - edge);

      const spots = [
        [centerX, rect.y + rect.h + gap, rect.y + rect.h + gap + ph <= vh - edge],
        [centerX, rect.y - gap - ph, rect.y - gap - ph >= edge],
        [rect.x + rect.w + gap, centerY, rect.x + rect.w + gap + pw <= vw - edge],
        [rect.x - gap - pw, centerY, rect.x - gap - pw >= edge],
      ];
      let [left, top] = spots.find(([, , fits]) => fits) ?? [];
      if (left === undefined) {
        const roomBelow = vh - (rect.y + rect.h);
        left = centerX;
        top = clamp(roomBelow >= rect.y ? vh - ph - edge : edge, edge, vh - ph - edge);
      }
      Object.assign(panel.style, { left: `${left}px`, top: `${top}px`, transform: 'none' });
    }

    function resetCopyButton() {
      clearTimeout(copyTimer);
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('done');
    }

    async function onCopy() {
      const ok = await copyText(resultText, output);
      copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      copyBtn.classList.toggle('done', ok);
      clearTimeout(copyTimer);
      copyTimer = setTimeout(resetCopyButton, 1800);
    }

    function onOpen() {
      if (!isHttpUrl(resultText)) return;
      chrome.runtime.sendMessage({ type: 'qr:open-url', url: resultText.trim() });
      close();
    }

    function onKeyDown(e) {
      // Keep page shortcuts (and typing into a focused page input) away while open.
      if (!e.composedPath().includes(host)) e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    }

    const stopEvent = (e) => e.stopPropagation();
    const preventDefault = (e) => e.preventDefault();

    stage.addEventListener('pointerdown', onPointerDown);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerup', onPointerUp);
    stage.addEventListener('pointercancel', showIdle);
    stage.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      close();
    });
    copyBtn.addEventListener('click', onCopy);
    openBtn.addEventListener('click', onOpen);
    retryBtn.addEventListener('click', showIdle);
    closeBtn.addEventListener('click', close);
    closeX.addEventListener('click', close);

    host.addEventListener('wheel', preventDefault, { passive: false });
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      host.addEventListener(type, stopEvent);
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyDown, true);

    session = {
      host,
      bitmap,
      onClose,
      cleanup: () => {
        clearTimeout(copyTimer);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyDown, true);
      },
    };

    document.activeElement?.blur?.();
    showIdle();
  }

  // Maps a selection in CSS pixels onto the screenshot's device pixels.
  function cropRegion(bitmap, shot, rect) {
    const box = shot.getBoundingClientRect();
    const sx = bitmap.width / box.width;
    const sy = bitmap.height / box.height;
    const x = Math.round((rect.x - box.left) * sx);
    const y = Math.round((rect.y - box.top) * sy);
    const w = Math.max(1, Math.min(bitmap.width - x, Math.round(rect.w * sx)));
    const hgt = Math.max(1, Math.min(bitmap.height - y, Math.round(rect.h * sy)));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = hgt;
    canvas.getContext('2d').drawImage(bitmap, x, y, w, hgt, 0, 0, w, hgt);
    return canvas;
  }

  async function decodeQR(canvas) {
    const native = await decodeNative(canvas);
    if (native !== null) return native;

    // jsQR is picky about module size and the quiet zone, so try a few
    // rescaled / padded variants before giving up. Codes only 2-3 px per
    // module (e.g. a QR in Chrome's PDF viewer) usually decode only after
    // upscaling, and which factor works varies with the crop.
    const longest = Math.max(canvas.width, canvas.height);
    const scales =
      longest > MAX_DECODE_SIDE
        ? [MAX_DECODE_SIDE / longest]
        : [1, ...UPSCALE_STEPS.filter((s) => longest * s <= MAX_UPSCALED_SIDE)];

    for (const scale of scales) {
      for (const pad of [0, QUIET_ZONE]) {
        const variant = renderVariant(canvas, scale, pad);
        const ctx = variant.getContext('2d', { willReadFrequently: true });
        const { data, width, height } = ctx.getImageData(0, 0, variant.width, variant.height);
        const result = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' });
        if (result) return result.data;
        // Yield so the "busy" outline can paint on slow attempts.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    return null;
  }

  // Chrome exposes BarcodeDetector on macOS, ChromeOS and Android; Windows
  // and Linux builds fall through to jsQR.
  async function decodeNative(canvas) {
    if (nativeDetector === undefined) {
      nativeDetector = null;
      try {
        if ('BarcodeDetector' in window) {
          const formats = await BarcodeDetector.getSupportedFormats();
          if (formats.includes('qr_code')) {
            nativeDetector = new BarcodeDetector({ formats: ['qr_code'] });
          }
        }
      } catch {
        // Unsupported; jsQR handles it.
      }
    }
    if (!nativeDetector) return null;
    try {
      const [code] = await nativeDetector.detect(canvas);
      return code ? code.rawValue : null;
    } catch {
      return null;
    }
  }

  function renderVariant(src, scale, pad) {
    const w = Math.max(1, Math.round(src.width * scale));
    const hgt = Math.max(1, Math.round(src.height * scale));
    const p = Math.round(Math.max(w, hgt) * pad);
    const canvas = document.createElement('canvas');
    canvas.width = w + p * 2;
    canvas.height = hgt + p * 2;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Smooth upscaling matters: nearest-neighbour keeps the anti-aliased gray
    // module edges as blocks, which jsQR's binarizer misreads.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, p, p, w, hgt);
    return canvas;
  }

  function drawThumb(thumb, crop) {
    const size = 112; // 2x the CSS size for crisp hi-DPI rendering
    const ratio = Math.min(size / crop.width, size / crop.height);
    const w = Math.max(1, Math.round(crop.width * ratio));
    const hgt = Math.max(1, Math.round(crop.height * ratio));
    thumb.width = size;
    thumb.height = size;
    const ctx = thumb.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(crop, (size - w) / 2, (size - hgt) / 2, w, hgt);
  }

  async function copyText(text, textarea) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Insecure page, missing focus or a Permissions-Policy block.
    }
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }

  function isHttpUrl(text) {
    try {
      const url = new URL(text.trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  function pluralize(count, noun) {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  window.__qrSnip = { start, close, isOpen };
})();
