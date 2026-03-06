const PANEL_HOST_ID = 'jm-control-panel-host';

let panelHost: HTMLDivElement | null = null;
let shadowRoot: ShadowRoot | null = null;
let healthPollInterval: ReturnType<typeof setInterval> | null = null;
let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

// --- Toggle state cache ---
let autoCaptureOn = false;
let crossTabOn = false;
let fullPageOn = false;
let serverOnline = false;
let figmaConnected = false;

// --- Shadow DOM refs ---
let autoCaptureToggleEl: HTMLInputElement | null = null;
let crossTabToggleEl: HTMLInputElement | null = null;
let crossTabRowEl: HTMLDivElement | null = null;
let fullPageToggleEl: HTMLInputElement | null = null;
let branchToggleEl: HTMLInputElement | null = null;
let statusDotEl: HTMLSpanElement | null = null;
let statusTextEl: HTMLSpanElement | null = null;
let saveBtn: HTMLButtonElement | null = null;
let exportBtn: HTMLButtonElement | null = null;

function createControlPanel(): void {
  if (document.getElementById(PANEL_HOST_ID)) return;

  // Host element
  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText = `
    position: fixed;
    z-index: 2147483647;
    width: 280px;
    pointer-events: auto;
  `;
  panelHost = host;

  // Shadow root (closed to isolate fully)
  const shadow = host.attachShadow({ mode: 'closed' });
  shadowRoot = shadow;

  // --- Styles ---
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .panel {
      background: #1e1e1e;
      color: #e0e0e0;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      overflow: hidden;
      user-select: none;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      padding: 10px 12px;
      cursor: grab;
      border-bottom: 1px solid #333;
    }
    .header:active { cursor: grabbing; }
    .header__grip {
      display: grid;
      grid-template-columns: repeat(3, 4px);
      grid-template-rows: repeat(2, 4px);
      gap: 2px;
      margin-right: 8px;
      flex-shrink: 0;
    }
    .header__grip span {
      width: 4px; height: 4px;
      border-radius: 50%;
      background: #666;
    }
    .header__title {
      flex: 1;
      font-weight: 600;
      font-size: 13px;
      color: #fff;
    }
    .header__close {
      background: none;
      border: none;
      color: #888;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      padding: 0 2px;
      display: flex;
      align-items: center;
    }
    .header__close:hover { color: #fff; }

    /* Body */
    .body { padding: 12px; }

    /* Capture button */
    .capture-btn {
      width: 100%;
      background: #5626D4;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      line-height: 1;
      transition: background 0.15s;
    }
    .capture-btn:hover { background: #4520B0; }
    .capture-btn:active { background: #3a1a99; }
    .capture-btn__shortcut {
      font-size: 11px;
      opacity: 0.7;
      font-weight: 400;
    }

    /* Toggle section */
    .toggles { margin-top: 12px; }
    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
    }
    .toggle-row--indent {
      padding-left: 16px;
    }
    .toggle-row.hidden { display: none; }
    .toggle-label {
      font-size: 12px;
      color: #ccc;
    }

    /* Toggle switch */
    .toggle-switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
      position: absolute;
    }
    .toggle-switch .slider {
      position: absolute;
      inset: 0;
      background: #444;
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .toggle-switch .slider::after {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      left: 2px;
      top: 2px;
      background: #fff;
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle-switch input:checked + .slider {
      background: #5626D4;
    }
    .toggle-switch input:checked + .slider::after {
      transform: translateX(16px);
    }

    /* Divider */
    .divider {
      height: 1px;
      background: #333;
      margin: 12px 0;
    }

    /* Action buttons */
    .actions {
      display: flex;
      gap: 6px;
    }
    .action-btn {
      flex: 1;
      background: #2a2a2a;
      color: #ccc;
      border: 1px solid #444;
      border-radius: 6px;
      padding: 7px 4px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      line-height: 1;
      transition: background 0.15s, border-color 0.15s;
      white-space: nowrap;
    }
    .action-btn:hover { background: #333; border-color: #555; }
    .action-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .action-btn:disabled:hover { background: #2a2a2a; border-color: #444; }

    /* Status line */
    .status-line {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      font-size: 11px;
      color: #888;
    }
    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot--offline { background: #e53e3e; }
    .status-dot--partial { background: #ecc94b; }
    .status-dot--online { background: #48bb78; }
  `;
  shadow.appendChild(style);

  // --- Panel container ---
  const panel = document.createElement('div');
  panel.className = 'panel';

  // --- Header ---
  const header = document.createElement('div');
  header.className = 'header';

  const grip = document.createElement('div');
  grip.className = 'header__grip';
  for (let i = 0; i < 6; i++) {
    grip.appendChild(document.createElement('span'));
  }

  const title = document.createElement('span');
  title.className = 'header__title';
  title.textContent = 'Journey Mapper';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'header__close';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close panel';
  closeBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'closePanel' });
  });

  header.appendChild(grip);
  header.appendChild(title);
  header.appendChild(closeBtn);

  // --- Drag ---
  header.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.header__close')) return;
    isDragging = true;
    const rect = host.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    e.preventDefault();
  });

  // --- Body ---
  const body = document.createElement('div');
  body.className = 'body';

  // Capture button
  const captureBtn = document.createElement('button');
  captureBtn.className = 'capture-btn';

  const cameraSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  cameraSvg.setAttribute('width', '16');
  cameraSvg.setAttribute('height', '16');
  cameraSvg.setAttribute('viewBox', '0 0 24 24');
  cameraSvg.setAttribute('fill', 'none');
  cameraSvg.setAttribute('stroke', 'currentColor');
  cameraSvg.setAttribute('stroke-width', '2');
  cameraSvg.setAttribute('stroke-linecap', 'round');
  cameraSvg.setAttribute('stroke-linejoin', 'round');
  const camPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  camPath1.setAttribute('d', 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z');
  const camCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  camCircle.setAttribute('cx', '12');
  camCircle.setAttribute('cy', '13');
  camCircle.setAttribute('r', '4');
  cameraSvg.appendChild(camPath1);
  cameraSvg.appendChild(camCircle);

  const captureLabel = document.createElement('span');
  captureLabel.textContent = 'Capture';

  const shortcutHint = document.createElement('span');
  shortcutHint.className = 'capture-btn__shortcut';
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  shortcutHint.textContent = isMac ? '(Option+Shift+S)' : '(Alt+Shift+S)';

  captureBtn.appendChild(cameraSvg);
  captureBtn.appendChild(captureLabel);
  captureBtn.appendChild(shortcutHint);

  captureBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'capture' });
  });

  body.appendChild(captureBtn);

  // --- Toggles ---
  const toggles = document.createElement('div');
  toggles.className = 'toggles';

  // Auto-capture toggle
  const { row: autoRow, input: autoInput } = createToggleRow('Auto-capture on navigation', false);
  autoCaptureToggleEl = autoInput;
  autoInput.addEventListener('change', () => {
    autoCaptureOn = autoInput.checked;
    chrome.runtime.sendMessage({ type: 'setAutoCapture', enabled: autoCaptureOn });
    if (crossTabRowEl) {
      crossTabRowEl.classList.toggle('hidden', !autoCaptureOn);
    }
  });
  toggles.appendChild(autoRow);

  // Cross-tab toggle (indented, conditionally shown)
  const { row: ctRow, input: ctInput } = createToggleRow('Across tabs', false, true);
  crossTabToggleEl = ctInput;
  crossTabRowEl = ctRow;
  ctRow.classList.add('hidden');
  ctInput.addEventListener('change', () => {
    crossTabOn = ctInput.checked;
    chrome.runtime.sendMessage({ type: 'setCrossTabCapture', enabled: crossTabOn });
  });
  toggles.appendChild(ctRow);

  // Full page toggle
  const { row: fpRow, input: fpInput } = createToggleRow('Full page', false);
  fullPageToggleEl = fpInput;
  fpInput.addEventListener('change', () => {
    fullPageOn = fpInput.checked;
    chrome.runtime.sendMessage({ type: 'setFullPageCapture', enabled: fullPageOn });
  });
  toggles.appendChild(fpRow);

  // Map branches toggle
  const { row: brRow, input: brInput } = createToggleRow('Map branches', false);
  branchToggleEl = brInput;
  brInput.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'setBranching', enabled: brInput.checked });
  });
  toggles.appendChild(brRow);

  body.appendChild(toggles);

  // --- Divider ---
  const divider = document.createElement('div');
  divider.className = 'divider';
  body.appendChild(divider);

  // --- Action buttons row ---
  const actions = document.createElement('div');
  actions.className = 'actions';

  const clearBtn = createActionButton('\ud83d\uddd1', 'Clear all');
  clearBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'clearSession' });
  });

  saveBtn = createActionButton('\ud83d\udcbe', 'Save all');
  saveBtn.addEventListener('click', () => {
    if (saveBtn!.disabled) return;
    saveBtn!.disabled = true;
    saveBtn!.textContent = 'Saving...';
    chrome.runtime.sendMessage({ type: 'saveAll' }, (response) => {
      saveBtn!.disabled = false;
      saveBtn!.textContent = '\ud83d\udcbe Save all';
      if (response?.error) {
        console.error('[JM] Save failed:', response.error);
      }
    });
  });

  exportBtn = createActionButton('\u25b8', 'Export to Figma');
  exportBtn.addEventListener('click', () => {
    if (exportBtn!.disabled) return;
    exportBtn!.disabled = true;
    exportBtn!.textContent = 'Exporting...';
    chrome.runtime.sendMessage({ type: 'exportToFigma' }, (response) => {
      exportBtn!.disabled = false;
      exportBtn!.textContent = '\u25b8 Export to Figma';
      if (response?.error) {
        console.error('[JM] Export failed:', response.error);
      }
    });
  });

  actions.appendChild(clearBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(exportBtn);
  body.appendChild(actions);

  // --- Status line ---
  const statusLine = document.createElement('div');
  statusLine.className = 'status-line';

  statusDotEl = document.createElement('span');
  statusDotEl.className = 'status-dot status-dot--offline';

  statusTextEl = document.createElement('span');
  statusTextEl.textContent = 'Server offline';

  statusLine.appendChild(statusDotEl);
  statusLine.appendChild(statusTextEl);
  body.appendChild(statusLine);

  // Assemble
  panel.appendChild(header);
  panel.appendChild(body);
  shadow.appendChild(panel);
  // Stop interaction events from propagating to the page.
  // Without this, clicks inside the JM panel bubble up to the document
  // and trigger "click outside" handlers on the page (e.g. modal dismiss).
  for (const eventType of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    host.addEventListener(eventType, (e) => e.stopPropagation());
  }

  document.body.appendChild(host);

  // --- Position: load saved or default to bottom-right ---
  chrome.storage.local.get('overlayPosition', (result) => {
    if (result.overlayPosition) {
      host.style.left = `${result.overlayPosition.x}px`;
      host.style.top = `${result.overlayPosition.y}px`;
      clampToViewport();
    } else {
      host.style.right = '24px';
      host.style.bottom = '24px';
    }
  });

  // --- Load toggle states ---
  chrome.runtime.sendMessage({ type: 'getAutoCapture' }, (response) => {
    if (!response) return;
    autoCaptureOn = response.enabled ?? false;
    crossTabOn = response.crossTab ?? false;
    fullPageOn = response.fullPage ?? false;
    if (autoCaptureToggleEl) autoCaptureToggleEl.checked = autoCaptureOn;
    if (crossTabToggleEl) crossTabToggleEl.checked = crossTabOn;
    if (crossTabRowEl) crossTabRowEl.classList.toggle('hidden', !autoCaptureOn);
    if (fullPageToggleEl) fullPageToggleEl.checked = fullPageOn;
  });

  chrome.runtime.sendMessage({ type: 'getBranching' }, (response) => {
    if (!response) return;
    if (branchToggleEl) branchToggleEl.checked = response.enabled ?? false;
  });

  // --- Health check ---
  checkHealth();
  healthPollInterval = setInterval(checkHealth, 10_000);
}

function removeControlPanel(): void {
  if (healthPollInterval) {
    clearInterval(healthPollInterval);
    healthPollInterval = null;
  }
  document.getElementById(PANEL_HOST_ID)?.remove();
  panelHost = null;
  shadowRoot = null;
  autoCaptureToggleEl = null;
  crossTabToggleEl = null;
  crossTabRowEl = null;
  fullPageToggleEl = null;
  branchToggleEl = null;
  statusDotEl = null;
  statusTextEl = null;
  saveBtn = null;
  exportBtn = null;
}

// --- Helpers ---

function createToggleRow(
  label: string,
  checked: boolean,
  indent = false,
): { row: HTMLDivElement; input: HTMLInputElement } {
  const row = document.createElement('div');
  row.className = `toggle-row${indent ? ' toggle-row--indent' : ''}`;

  const labelEl = document.createElement('span');
  labelEl.className = 'toggle-label';
  labelEl.textContent = label;

  const switchEl = document.createElement('label');
  switchEl.className = 'toggle-switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;

  const slider = document.createElement('span');
  slider.className = 'slider';

  switchEl.appendChild(input);
  switchEl.appendChild(slider);
  row.appendChild(labelEl);
  row.appendChild(switchEl);

  return { row, input };
}

function createActionButton(icon: string, label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'action-btn';
  btn.textContent = `${icon} ${label}`;
  return btn;
}

function checkHealth(): void {
  try {
    if (!chrome.runtime?.id) {
      console.log('[JM-content] Extension context invalidated, removing controls');
      removeControlPanel();
      return;
    }
    chrome.runtime.sendMessage({ type: 'checkHealth' }, (response) => {
      if (chrome.runtime.lastError) return;
      serverOnline = response?.serverOnline ?? false;
      figmaConnected = response?.figmaConnected ?? false;
      updateStatusUI();
    });
  } catch {
    console.log('[JM-content] Extension context invalidated (caught), removing controls');
    removeControlPanel();
  }
}

function updateStatusUI(): void {
  if (!statusDotEl || !statusTextEl) return;

  if (serverOnline && figmaConnected) {
    statusDotEl.className = 'status-dot status-dot--online';
    statusTextEl.textContent = 'Connected';
  } else if (serverOnline) {
    statusDotEl.className = 'status-dot status-dot--partial';
    statusTextEl.textContent = 'Server OK, Figma disconnected';
  } else {
    statusDotEl.className = 'status-dot status-dot--offline';
    statusTextEl.textContent = 'Server offline';
  }

  // Update export button state
  if (exportBtn) {
    exportBtn.disabled = !(serverOnline && figmaConnected);
    if (!serverOnline) {
      exportBtn.title = 'Bridge server is offline';
    } else if (!figmaConnected) {
      exportBtn.title = 'Figma not connected';
    } else {
      exportBtn.title = '';
    }
  }

  // Update save button state
  if (saveBtn) {
    saveBtn.disabled = !serverOnline;
    saveBtn.title = serverOnline ? '' : 'Bridge server is offline';
  }
}

function clampToViewport(): void {
  if (!panelHost) return;
  const rect = panelHost.getBoundingClientRect();
  let x = rect.left;
  let y = rect.top;

  x = Math.max(0, Math.min(x, window.innerWidth - rect.width));
  y = Math.max(0, Math.min(y, window.innerHeight - rect.height));

  // Switch from right/bottom to left/top positioning
  panelHost.style.right = '';
  panelHost.style.bottom = '';
  panelHost.style.left = `${x}px`;
  panelHost.style.top = `${y}px`;
}

// --- Global drag listeners ---

document.addEventListener('mousemove', (e: MouseEvent) => {
  if (!isDragging || !panelHost) return;
  e.preventDefault();

  // Switch to left/top positioning
  panelHost.style.right = '';
  panelHost.style.bottom = '';
  panelHost.style.left = `${e.clientX - dragOffsetX}px`;
  panelHost.style.top = `${e.clientY - dragOffsetY}px`;
});

document.addEventListener('mouseup', () => {
  if (!isDragging || !panelHost) return;
  isDragging = false;
  clampToViewport();

  // Save position
  const rect = panelHost.getBoundingClientRect();
  chrome.storage.local.set({
    overlayPosition: { x: rect.left, y: rect.top },
  });
});

window.addEventListener('resize', () => {
  if (panelHost) clampToViewport();
});

// --- Message listener ---

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ping') sendResponse({ ok: true });
  if (msg.type === 'getPageDimensions') {
    sendResponse({
      scrollHeight: document.documentElement.scrollHeight,
      viewportHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
    });
    return false;
  }
  if (msg.type === 'scrollTo') {
    window.scrollTo(0, msg.y);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  if (msg.type === 'getScrollPosition') {
    sendResponse({ scrollY: window.scrollY });
    return false;
  }
  if (msg.type === 'captureFlash') {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      border: 3px solid #5626D4;
      pointer-events: none;
      animation: jm-flash 0.4s ease-out forwards;
    `;
    const flashStyle = document.createElement('style');
    flashStyle.textContent = '@keyframes jm-flash { to { opacity: 0; } }';
    overlay.appendChild(flashStyle);
    document.body.appendChild(overlay);
    setTimeout(() => overlay.remove(), 500);
  }
  if (msg.type === 'setOverlayVisible') {
    if (panelHost) {
      panelHost.style.display = msg.visible ? '' : 'none';
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sendResponse({ ok: true });
      });
    });
    return true;
  }
  if (msg.type === 'panelState') {
    if (msg.visible) {
      createControlPanel();
    } else {
      removeControlPanel();
    }
  }
});

// --- Keyboard shortcut ---

document.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && e.code === 'KeyS') {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: 'capture' });
  }
});

// --- Init: query panel state ---

chrome.runtime.sendMessage({ type: 'getPanelState' }, (response) => {
  console.log(`[JM-content] getPanelState response: visible=${response?.visible}`);
  if (response?.visible) createControlPanel();
});

// Safety net: listen for panelVisible storage changes (catches tabs that miss the message broadcast)
chrome.storage.onChanged.addListener((changes) => {
  if ('branchingEnabled' in changes) {
    if (branchToggleEl) branchToggleEl.checked = changes.branchingEnabled.newValue ?? false;
  }
  if ('panelVisible' in changes) {
    const newValue = changes.panelVisible.newValue;
    console.log(`[JM-content] storage panelVisible changed to ${newValue}`);
    if (newValue) {
      createControlPanel();
    } else {
      removeControlPanel();
    }
  }
});
