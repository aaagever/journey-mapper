import type { JourneyStep, JourneySession, ServerStatus, UploadResponse } from './types.js';

const BRIDGE_URL = 'http://localhost:3456';

// DOM elements
const stepsContainer = document.getElementById('steps-container')!;
const emptyState = document.getElementById('empty-state')!;
const statusEl = document.getElementById('status')!;
const statusText = statusEl.querySelector('.status__text')!;
const btnCapture = document.getElementById('btn-capture') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;
const btnSaveAll = document.getElementById('btn-save-all') as HTMLButtonElement;
const btnExport = document.getElementById('btn-export') as HTMLButtonElement;
const toastEl = document.getElementById('toast')!;

let session: JourneySession = { steps: [], createdAt: Date.now() };
let serverOnline = false;
let figmaConnected = false;
let draggedId: string | null = null;

// --- Toast ---

let toastTimeout: ReturnType<typeof setTimeout>;

function showToast(msg: string, type: 'info' | 'error' | 'success' = 'info') {
  clearTimeout(toastTimeout);
  toastEl.innerHTML = '';
  const text = document.createElement('span');
  text.textContent = msg;
  toastEl.appendChild(text);

  if (type === 'error') {
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast__close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => toastEl.classList.add('hidden'));
    toastEl.appendChild(closeBtn);
  }

  toastEl.className = `toast toast--${type}`;

  if (type !== 'error') {
    toastTimeout = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 3000);
  }
}

// --- Server health check ---

async function checkServerHealth(): Promise<void> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
    const data: ServerStatus = await res.json();
    serverOnline = data.online;
    figmaConnected = data.figmaConnected;
  } catch {
    serverOnline = false;
    figmaConnected = false;
  }
  updateStatusIndicator();
  updateExportButton();
}

function updateStatusIndicator() {
  if (serverOnline && figmaConnected) {
    statusEl.className = 'status status--online';
    statusText.textContent = 'Connected';
  } else if (serverOnline) {
    statusEl.className = 'status status--partial';
    statusText.textContent = 'Server OK, Figma disconnected';
  } else {
    statusEl.className = 'status status--offline';
    statusText.textContent = 'Server offline';
  }
}

function updateExportButton() {
  const canExport = serverOnline && figmaConnected && session.steps.length > 0;
  btnExport.disabled = !canExport;
  if (!serverOnline) {
    btnExport.title = 'Bridge server is offline';
  } else if (!figmaConnected) {
    btnExport.title = 'Figma desktop bridge is not connected';
  } else if (session.steps.length === 0) {
    btnExport.title = 'Capture screenshots first';
  } else {
    btnExport.title = '';
  }
}

// --- Render steps ---

function render() {
  // Remove old cards (keep empty state)
  stepsContainer.querySelectorAll('.step-card').forEach((el) => el.remove());

  if (session.steps.length === 0) {
    emptyState.style.display = '';
    updateExportButton();
    return;
  }

  emptyState.style.display = 'none';

  session.steps.forEach((step, index) => {
    const card = document.createElement('div');
    card.className = 'step-card';
    card.draggable = true;
    card.dataset.id = step.id;

    const domain = getDomain(step.pageUrl);

    card.innerHTML = `
      <img class="step-card__thumb" src="${step.imageDataUrl}" alt="Step ${index + 1}">
      <div class="step-card__body">
        <div class="step-card__header">
          <span class="step-card__number">Step ${index + 1}</span>
          <div class="step-card__actions">
            <button class="step-card__download" data-id="${step.id}" title="Download"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8.67M4.67 8l3.33 3.33L11.33 8M2.67 13.33h10.66"/></svg></button>
            <button class="step-card__delete" data-id="${step.id}" title="Remove"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M5.33 4V2.67a1.33 1.33 0 011.34-1.34h2.66a1.33 1.33 0 011.34 1.34V4M6.67 7.33v4M9.33 7.33v4"/><path d="M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4"/></svg></button>
          </div>
        </div>
        <div class="step-card__title">${escapeHtml(step.pageTitle)}</div>
        <div class="step-card__url">${escapeHtml(domain)}</div>
        <div class="step-card__label">
          <input type="text" placeholder="Add label..." value="${escapeHtml(step.label)}" data-id="${step.id}">
        </div>
      </div>
    `;

    // Drag events
    card.addEventListener('dragstart', (e) => {
      draggedId = step.id;
      card.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedId = null;
      stepsContainer.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      card.classList.add('drag-over');
    });

    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!draggedId || draggedId === step.id) return;
      reorderSteps(draggedId, step.id);
    });

    // Download button
    card.querySelector('.step-card__download')!.addEventListener('click', () => {
      downloadStep(step, index);
    });

    // Delete button
    card.querySelector('.step-card__delete')!.addEventListener('click', () => {
      deleteStep(step.id);
    });

    // Label input
    const input = card.querySelector('input')! as HTMLInputElement;
    input.addEventListener('change', () => {
      updateLabel(step.id, input.value);
    });

    stepsContainer.appendChild(card);
  });

  updateExportButton();
}

function reorderSteps(fromId: string, toId: string) {
  const fromIndex = session.steps.findIndex((s) => s.id === fromId);
  const toIndex = session.steps.findIndex((s) => s.id === toId);
  if (fromIndex === -1 || toIndex === -1) return;

  const [moved] = session.steps.splice(fromIndex, 1);
  session.steps.splice(toIndex, 0, moved);

  // Renumber
  session.steps.forEach((s, i) => (s.stepNumber = i + 1));
  saveAndRender();
}

function deleteStep(id: string) {
  session.steps = session.steps.filter((s) => s.id !== id);
  session.steps.forEach((s, i) => (s.stepNumber = i + 1));
  saveAndRender();
}

function updateLabel(id: string, label: string) {
  const step = session.steps.find((s) => s.id === id);
  if (step) {
    step.label = label;
    saveSession();
  }
}

async function saveSession() {
  await chrome.runtime.sendMessage({ type: 'updateSession', session });
}

function saveAndRender() {
  saveSession();
  render();
}

// --- Export ---

async function exportToFigma() {
  if (!serverOnline || !figmaConnected || session.steps.length === 0) return;

  btnExport.disabled = true;
  btnExport.classList.add('btn--exporting');
  btnExport.textContent = 'Exporting...';

  try {
    // 1. Upload each screenshot to bridge server
    const uploadedSteps: Array<{
      id: string;
      stepNumber: number;
      imageUrl: string;
      pageUrl: string;
      pageTitle: string;
      label: string;
    }> = [];

    for (const step of session.steps) {
      const res = await fetch(`${BRIDGE_URL}/api/screenshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: step.id,
          imageDataUrl: step.imageDataUrl,
        }),
      });

      if (!res.ok) throw new Error(`Upload failed for step ${step.stepNumber}`);

      const data: UploadResponse = await res.json();
      uploadedSteps.push({
        id: data.id,
        stepNumber: step.stepNumber,
        imageUrl: data.url,
        pageUrl: step.pageUrl,
        pageTitle: step.pageTitle,
        label: step.label,
      });
    }

    // 2. Trigger export
    const exportRes = await fetch(`${BRIDGE_URL}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps: uploadedSteps }),
    });

    if (!exportRes.ok) {
      const err = await exportRes.json().catch(() => ({ error: 'Export failed' }));
      throw new Error(err.error || 'Export failed');
    }

    showToast(`Exported ${uploadedSteps.length} steps to Figma!`, 'success');
  } catch (err) {
    let errMsg = (err as Error).message;
    // Clean up JSON-like error strings from the server
    try {
      const parsed = JSON.parse(errMsg);
      errMsg = parsed.hint || parsed.message || parsed.error || errMsg;
    } catch { /* not JSON, use as-is */ }
    showToast(errMsg, 'error');
  } finally {
    btnExport.disabled = false;
    btnExport.classList.remove('btn--exporting');
    btnExport.textContent = 'Export to Figma';
    updateExportButton();
  }
}

// --- Download ---

function sanitizeFilename(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 50);
}

function downloadStep(step: JourneyStep, index: number) {
  const a = document.createElement('a');
  a.href = step.imageDataUrl;
  a.download = `step-${index + 1}-${sanitizeFilename(step.pageTitle)}.jpg`;
  a.click();
}

async function saveAllScreenshots() {
  if (session.steps.length === 0) return;
  if (!serverOnline) {
    showToast('Bridge server is offline - needed for zip creation', 'error');
    return;
  }

  btnSaveAll.disabled = true;
  btnSaveAll.classList.add('btn--exporting');
  btnSaveAll.textContent = 'Saving...';

  try {
    // 1. Upload each screenshot to bridge server
    for (const step of session.steps) {
      const res = await fetch(`${BRIDGE_URL}/api/screenshots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: step.id, imageDataUrl: step.imageDataUrl }),
      });
      if (!res.ok) throw new Error(`Upload failed for step ${step.stepNumber}`);
    }

    // 2. Build metadata for human-readable filenames
    const stepsMeta = session.steps.map((s) => ({
      id: s.id,
      stepNumber: s.stepNumber,
      pageTitle: s.pageTitle,
    }));

    // 3. Fetch zip from server
    const zipRes = await fetch(
      `${BRIDGE_URL}/api/screenshots/zip?steps=${encodeURIComponent(JSON.stringify(stepsMeta))}`
    );
    if (!zipRes.ok) throw new Error('Failed to create zip archive');

    const blob = await zipRes.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'journey-screenshots.zip';
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Saved ${session.steps.length} screenshots as zip`, 'success');
  } catch (err) {
    showToast((err as Error).message, 'error');
  } finally {
    btnSaveAll.disabled = false;
    btnSaveAll.classList.remove('btn--exporting');
    btnSaveAll.textContent = 'Save All';
  }
}

// --- Utilities ---

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Storage size warning ---

async function checkStorageUsage() {
  const bytes = await chrome.storage.local.getBytesInUse();
  const mb = bytes / (1024 * 1024);
  if (mb > 8) {
    showToast(`Storage usage: ${mb.toFixed(1)}MB / 10MB - consider clearing old screenshots`, 'error');
  }
}

// --- Init ---

async function init() {
  // Load session
  const loaded = await chrome.runtime.sendMessage({ type: 'getSession' }) as JourneySession;
  if (loaded) session = loaded;

  render();
  checkServerHealth();
  checkStorageUsage();

  // Only confirm if panel is actually painted (Arc loads the HTML but never renders it).
  // requestAnimationFrame fires only when the browser paints; if Arc never paints the
  // panel, the callback won't run and the background's 2s timeout triggers popup fallback.
  requestAnimationFrame(() => {
    if (document.visibilityState === 'visible' && window.innerWidth > 0 && window.innerHeight > 0) {
      chrome.runtime.sendMessage({ type: 'sidePanelOpened' }).catch(() => {});
    }
  });

  window.addEventListener('beforeunload', () => {
    chrome.runtime.sendMessage({ type: 'sidePanelClosed' }).catch(() => {});
  });

  // Allow background to programmatically close the side panel (e.g. overlay X button)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'closeSidePanel') {
      console.log('[JM-sidepanel] Received closeSidePanel, calling window.close()');
      window.close();
    }
  });

  // Poll server health
  setInterval(checkServerHealth, 10_000);

  // Listen for storage changes (new captures from background)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.session?.newValue) {
      const hadMore = changes.session.newValue.steps.length > session.steps.length;
      session = changes.session.newValue;
      render();
      checkStorageUsage();
      if (hadMore) {
        const cards = stepsContainer.querySelectorAll('.step-card');
        const last = cards[cards.length - 1];
        if (last) last.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }
  });
}

// --- Event listeners ---

btnCapture.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'capture' });
});

btnClear.addEventListener('click', async () => {
  if (session.steps.length === 0) return;
  if (!confirm('Clear all captured screenshots?')) return;
  await chrome.runtime.sendMessage({ type: 'clearSession' });
  session = { steps: [], createdAt: Date.now() };
  render();
  showToast('All screenshots cleared', 'info');
});

btnSaveAll.addEventListener('click', () => {
  saveAllScreenshots();
});

btnExport.addEventListener('click', () => {
  exportToFigma();
});

init();
