import type { JourneyStep, JourneySession, UploadResponse } from './types.js';

const BRIDGE_URL = 'http://localhost:3456';

let panelWindowId: number | null = null;
let autoCaptureEnabled = false;
let crossTabCapture = false;
let fullPageCapture = false;
let pinnedTabId: number | null = null;
// --- Auto-branching state ---
const MAX_BRANCH_DEPTH = 50;
let branchingEnabled = false;
let urlToStepId = new Map<string, string>();
let depthOf = new Map<string, number>();
let currentParentId: string | null = null;

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

function onBranchNavigation(details: { url: string; frameId: number }) {
  if (details.frameId !== 0) return;
  if (!branchingEnabled) return;
  const norm = normalizeUrl(details.url);
  const existingStepId = urlToStepId.get(norm);
  if (existingStepId) {
    currentParentId = existingStepId;
  }
}

function onBranchTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
  if (!branchingEnabled) return;
  chrome.tabs.get(activeInfo.tabId).then((tab) => {
    if (!tab.url) return;
    const norm = normalizeUrl(tab.url);
    const existingStepId = urlToStepId.get(norm);
    if (existingStepId) {
      currentParentId = existingStepId;
    }
  }).catch(() => {});
}

function registerBranchTracking() {
  chrome.webNavigation.onCompleted.addListener(onBranchNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onBranchNavigation);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onBranchNavigation);
  chrome.tabs.onActivated.addListener(onBranchTabActivated);
}

function unregisterBranchTracking() {
  chrome.webNavigation.onCompleted.removeListener(onBranchNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onBranchNavigation);
  chrome.webNavigation.onHistoryStateUpdated.removeListener(onBranchNavigation);
  chrome.tabs.onActivated.removeListener(onBranchTabActivated);
}

function rebuildBranchMaps(steps: JourneyStep[]) {
  urlToStepId.clear();
  depthOf.clear();
  for (const step of steps) {
    const norm = normalizeUrl(step.pageUrl);
    urlToStepId.set(norm, step.id);
    if (step.parentId) {
      const parentDepth = depthOf.get(step.parentId) ?? 0;
      depthOf.set(step.id, parentDepth + 1);
    } else {
      depthOf.set(step.id, 0);
    }
  }
}

const MAX_TILES = 20; // Cap to avoid memory issues on very tall pages

// Side panel feature detection (mutable so we can disable after failed verification)
let useSidePanel = typeof chrome.sidePanel !== 'undefined'
  && typeof chrome.sidePanel.open === 'function';
let sidePanelVerified: boolean | null = null; // cached sidePanelWorks flag (null = unknown)
let sidePanelOpen = false;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

function generateId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function getSession(): Promise<JourneySession> {
  const result = await chrome.storage.local.get('session');
  return result.session ?? { steps: [], createdAt: Date.now() };
}

async function saveSession(session: JourneySession): Promise<void> {
  await chrome.storage.local.set({ session });
}

async function findExistingPanel(): Promise<chrome.windows.Window | null> {
  const panelUrl = chrome.runtime.getURL('sidepanel.html');

  // Try cached ID first
  if (panelWindowId !== null) {
    try {
      const win = await chrome.windows.get(panelWindowId, { populate: true });
      if (win.tabs?.some((t) => t.url?.startsWith(panelUrl))) return win;
    } catch { /* window gone */ }
    panelWindowId = null;
  }

  // Service worker may have restarted. Search all popup windows.
  const allWindows = await chrome.windows.getAll({ populate: true });
  return allWindows.find((w) =>
    w.tabs?.some((t) => t.url?.startsWith(panelUrl))
  ) ?? null;
}

async function openPanelPopup(): Promise<void> {
  const existing = await findExistingPanel();

  if (existing?.id) {
    const { left, top, width, height } = existing;
    await chrome.windows.remove(existing.id).catch(() => {});
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('sidepanel.html'),
      type: 'popup',
      width: width ?? 400,
      height: height ?? 600,
      left: left ?? undefined,
      top: top ?? undefined,
      focused: true,
    });
    panelWindowId = win.id ?? null;
    broadcastPanelState(true);
    return;
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('sidepanel.html'),
    type: 'popup',
    width: 400,
    height: 600,
    focused: true,
  });
  panelWindowId = win.id ?? null;
  broadcastPanelState(true);
}

async function openPanelSide(windowId: number): Promise<void> {
  // Must call sidePanel.open() in the user gesture context (before any async boundary)
  const openPromise = chrome.sidePanel.open({ windowId });

  // Use navigator.locks to keep service worker alive during the timeout wait
  await navigator.locks.request('panel-open', async () => {
    try {
      const loaded = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(listener);
          resolve(false);
        }, 2000);

        function listener(msg: { type: string }) {
          if (msg.type === 'sidePanelOpened') {
            clearTimeout(timeout);
            chrome.runtime.onMessage.removeListener(listener);
            resolve(true);
          }
        }
        chrome.runtime.onMessage.addListener(listener);

        // If sidePanel.open() rejects, resolve false immediately
        openPromise.catch(() => {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve(false);
        });
      });

      if (!loaded) {
        console.warn('Side panel did not confirm visibility, falling back to popup');
        useSidePanel = false;
        sidePanelVerified = false;
        await chrome.storage.local.set({ sidePanelWorks: false });
        await openPanelPopup();
      }
    } catch (err) {
      console.error('Failed to open side panel, falling back to popup:', err);
      useSidePanel = false;
      sidePanelVerified = false;
      await chrome.storage.local.set({ sidePanelWorks: false });
      await openPanelPopup();
    }
  });
}

async function openPanel(windowId?: number): Promise<void> {
  if (useSidePanel && windowId && sidePanelVerified !== false) {
    await openPanelSide(windowId);
  } else {
    await openPanelPopup();
  }
}

// Heartbeat to detect side panel close (backup for beforeunload message)
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(async () => {
    try {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] });
      if (contexts.length === 0 && sidePanelOpen) {
        sidePanelOpen = false;
        broadcastPanelState(false);
        stopHeartbeat();
        if (autoCaptureEnabled) {
          autoCaptureEnabled = false;
          chrome.storage.local.set({ autoCaptureEnabled: false });
          unregisterAutoCapture();
          pinnedTabId = null;
        }
      }
    } catch { /* getContexts not available, rely on messages */ }
  }, 2000);
}

function stopHeartbeat() {
  if (heartbeatInterval !== null) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

async function broadcastPanelState(visible: boolean): Promise<void> {
  chrome.storage.local.set({ panelVisible: visible });
  const tabs = await chrome.tabs.query({});
  console.log(`[JM] broadcastPanelState(${visible}) to ${tabs.length} tabs`);
  for (const tab of tabs) {
    if (tab.id && tab.url && !tab.url.startsWith('chrome')) {
      chrome.tabs.sendMessage(tab.id, { type: 'panelState', visible }).catch(() => {});
    }
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) {
    panelWindowId = null;
    broadcastPanelState(false);
    if (autoCaptureEnabled) {
      autoCaptureEnabled = false;
      chrome.storage.local.set({ autoCaptureEnabled: false });
      unregisterAutoCapture();
      pinnedTabId = null;
    }
  }
});

// --- Offscreen document management ---

let offscreenCreated = false;

async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreated) return;

  // Check if already exists (e.g. after service worker restart)
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  }).catch(() => []);

  if (contexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  // Wait for the offscreen script to signal readiness
  const ready = new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn('[offscreen] Ready signal timed out after 3s, proceeding anyway');
      chrome.runtime.onMessage.removeListener(listener);
      resolve(); // proceed anyway after timeout
    }, 3000);
    function listener(msg: { type: string }) {
      if (msg.type === 'offscreenReady') {
        console.log('[offscreen] Ready signal received');
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS' as chrome.offscreen.Reason],
    justification: 'Stitching full-page screenshot tiles on a canvas',
  });

  await ready;
  offscreenCreated = true;
}

// --- Overlay visibility helper ---

async function setOverlayVisible(tabId: number, visible: boolean): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'setOverlayVisible', visible });
  } catch {
    // Content script not injected -- nothing to hide
  }
}

// --- Full-page capture ---

async function captureFullPage(
  targetWindowId: number,
  targetTab: chrome.tabs.Tab,
): Promise<string> {
  const tabId = targetTab.id!;
  console.log('[fullPage] Starting full-page capture for tab', tabId);

  // Ensure content script is injected before querying page dimensions
  await ensureContentScript(tabId);

  // Get page dimensions from content script
  const dims = await chrome.tabs.sendMessage(tabId, { type: 'getPageDimensions' }) as {
    scrollHeight: number;
    viewportHeight: number;
    viewportWidth: number;
    devicePixelRatio: number;
  };
  console.log('[fullPage] Page dimensions:', dims);

  // If page fits in viewport, just do a single capture
  if (dims.scrollHeight <= dims.viewportHeight) {
    await setOverlayVisible(tabId, false);
    try {
      return await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'jpeg', quality: 80 });
    } finally {
      await setOverlayVisible(tabId, true);
    }
  }

  // Save original scroll position
  const origScroll = await chrome.tabs.sendMessage(tabId, { type: 'getScrollPosition' }) as {
    scrollY: number;
  };

  const tileCount = Math.min(
    Math.ceil(dims.scrollHeight / dims.viewportHeight),
    MAX_TILES,
  );
  const effectiveTotalHeight = Math.min(dims.scrollHeight, dims.viewportHeight * MAX_TILES);

  const tiles: string[] = [];

  await setOverlayVisible(tabId, false);
  try {
    for (let i = 0; i < tileCount; i++) {
      const scrollY = i * dims.viewportHeight;
      await chrome.tabs.sendMessage(tabId, { type: 'scrollTo', y: scrollY });
      // Chrome limits captureVisibleTab to ~2 calls/sec; 600ms keeps us safely under
      await new Promise((r) => setTimeout(r, 600));

      const tile = await chrome.tabs.captureVisibleTab(targetWindowId, {
        format: 'jpeg',
        quality: 80,
      });
      tiles.push(tile);
    }

    console.log(`[fullPage] Captured ${tiles.length} tiles, total data size: ${tiles.reduce((s, t) => s + t.length, 0)} chars`);

    // Stitch tiles using offscreen document
    await ensureOffscreenDocument();
    console.log('[fullPage] Offscreen document ready');

    const result = await chrome.runtime.sendMessage({
      type: 'stitchTiles',
      tiles,
      viewportWidth: dims.viewportWidth,
      viewportHeight: dims.viewportHeight,
      totalHeight: effectiveTotalHeight,
      devicePixelRatio: dims.devicePixelRatio,
    }) as { dataUrl?: string; error?: string };

    console.log('[fullPage] Stitch result:', result ? `dataUrl length=${result.dataUrl?.length}, error=${result.error}` : 'null/undefined');

    if (!result || result.error) throw new Error(result?.error ?? 'Stitching returned no result');
    return result.dataUrl!;
  } finally {
    await setOverlayVisible(tabId, true);
    // Restore original scroll position
    await chrome.tabs.sendMessage(tabId, { type: 'scrollTo', y: origScroll.scrollY }).catch(() => {});
  }
}

let captureInProgress = false;

async function captureScreenshot(opts?: { refocusPanel?: boolean }): Promise<void> {
  if (captureInProgress) {
    console.warn('Capture already in progress, skipping');
    return;
  }
  captureInProgress = true;
  try {
    // Find a normal browser window (excludes our popup panel)
    const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
    const targetWindow = allWindows.find((w) => w.focused) ?? allWindows[0];

    if (!targetWindow?.id) {
      console.error('No browser window found to capture');
      return;
    }

    const targetWindowId = targetWindow.id;

    // Get the active tab in that window
    const tabs = await chrome.tabs.query({
      active: true,
      windowId: targetWindowId,
    });
    const targetTab = tabs.find(
      (t) => t.url && !t.url.startsWith('chrome')
    );

    if (!targetTab) {
      console.error('No suitable tab found to capture');
      return;
    }

    // Focus the target window so captureVisibleTab works
    await chrome.windows.update(targetWindowId, { focused: true });
    await new Promise((r) => setTimeout(r, 150));

    let dataUrl: string;
    if (fullPageCapture) {
      dataUrl = await captureFullPage(targetWindowId, targetTab);
    } else {
      const tabId = targetTab.id!;
      await setOverlayVisible(tabId, false);
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, {
          format: 'jpeg',
          quality: 80,
        });
      } finally {
        await setOverlayVisible(tabId, true);
      }
    }

    const session = await getSession();

    let stepParentId: string | null = null;
    let stepDepth = 0;
    if (branchingEnabled && currentParentId) {
      const parentDepth = depthOf.get(currentParentId) ?? 0;
      if (parentDepth + 1 <= MAX_BRANCH_DEPTH) {
        stepParentId = currentParentId;
        stepDepth = parentDepth + 1;
      }
    }

    const step: JourneyStep = {
      id: generateId(),
      stepNumber: session.steps.length + 1,
      imageDataUrl: dataUrl,
      pageUrl: targetTab.url!,
      pageTitle: targetTab.title ?? 'Untitled',
      timestamp: Date.now(),
      label: '',
      parentId: stepParentId,
    };

    session.steps.push(step);
    await saveSession(session);

    if (branchingEnabled) {
      const norm = normalizeUrl(step.pageUrl);
      urlToStepId.set(norm, step.id);
      depthOf.set(step.id, stepDepth);
      currentParentId = step.id;
    }

    // Re-focus the panel: skip in side panel mode (panel lives inside browser window)
    // and skip during auto-capture so browser keeps focus
    if (opts?.refocusPanel !== false && !useSidePanel && panelWindowId !== null) {
      await chrome.windows.update(panelWindowId, { focused: true }).catch(() => {});
    }
  } catch (err) {
    console.error('Capture failed:', err instanceof Error ? err.stack : err);
    // Surface error to the panel so the user gets feedback
    chrome.runtime.sendMessage({ type: 'captureError', error: String(err) }).catch(() => {});
  } finally {
    captureInProgress = false;
  }
}

// --- Auto-capture ---

function onNavigation(details: { tabId: number; url: string; frameId: number }) {
  if (details.frameId !== 0) return;
  if (details.url.startsWith('chrome') || details.url.startsWith('about')) return;

  console.log(`[autoCapture] onNavigation: tab=${details.tabId} url=${details.url}`);

  setTimeout(async () => {
    if (!autoCaptureEnabled) {
      console.log('[autoCapture] Skip: disabled');
      return;
    }

    if (!crossTabCapture) {
      if (pinnedTabId !== null && details.tabId !== pinnedTabId) {
        console.log(`[autoCapture] Skip: wrong tab (pinned=${pinnedTabId}, event=${details.tabId})`);
        return;
      }
    } else {
      const allWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const targetWindow = allWindows.find((w) => w.focused) ?? allWindows[0];
      if (!targetWindow?.id) {
        console.log('[autoCapture] Skip: no target window');
        return;
      }
      const tabs = await chrome.tabs.query({ active: true, windowId: targetWindow.id });
      const activeTab = tabs[0];
      if (!activeTab || activeTab.id !== details.tabId) {
        console.log(`[autoCapture] Skip: not active tab in cross-tab mode (active=${activeTab?.id}, event=${details.tabId})`);
        return;
      }
    }

    const session = await getSession();
    const lastStep = session.steps[session.steps.length - 1];
    if (lastStep && lastStep.pageUrl === details.url) {
      console.log(`[autoCapture] Skip: duplicate URL (${details.url})`);
      return;
    }

    console.log('[autoCapture] Capturing...');
    await captureScreenshot({ refocusPanel: false });
    chrome.tabs.sendMessage(details.tabId, { type: 'captureFlash' }).catch(() => {});
  }, 500);
}

function onTabActivated(activeInfo: chrome.tabs.TabActiveInfo) {
  if (!autoCaptureEnabled || !crossTabCapture) return;

  setTimeout(async () => {
    if (!autoCaptureEnabled || !crossTabCapture) return;

    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) return;

    const session = await getSession();
    const lastStep = session.steps[session.steps.length - 1];
    if (lastStep && lastStep.pageUrl === tab.url) return;

    await captureScreenshot({ refocusPanel: false });
    chrome.tabs.sendMessage(activeInfo.tabId, { type: 'captureFlash' }).catch(() => {});
  }, 300);
}

function registerAutoCapture() {
  chrome.webNavigation.onCompleted.addListener(onNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onNavigation);
  chrome.webNavigation.onHistoryStateUpdated.addListener(onNavigation);
  chrome.tabs.onActivated.addListener(onTabActivated);
}

function unregisterAutoCapture() {
  chrome.webNavigation.onCompleted.removeListener(onNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onNavigation);
  chrome.webNavigation.onHistoryStateUpdated.removeListener(onNavigation);
  chrome.tabs.onActivated.removeListener(onTabActivated);
}

// Load persisted state
chrome.storage.local.get(['autoCaptureEnabled', 'crossTabCapture', 'fullPageCapture', 'branchingEnabled', 'sidePanelWorks', 'panelVisible'], (result) => {
  autoCaptureEnabled = result.autoCaptureEnabled ?? false;
  crossTabCapture = result.crossTabCapture ?? false;
  fullPageCapture = result.fullPageCapture ?? false;
  branchingEnabled = result.branchingEnabled ?? false;
  if (autoCaptureEnabled) registerAutoCapture();
  if (branchingEnabled) registerBranchTracking();
  if (result.sidePanelWorks === false) {
    sidePanelVerified = false;
    useSidePanel = false;
  } else if (result.sidePanelWorks === true) {
    sidePanelVerified = true;
  }
  console.log(`[JM] Storage loaded: sidePanelWorks=${result.sidePanelWorks}, useSidePanel=${useSidePanel}`);
  console.log(`[autoCapture] Restored: enabled=${autoCaptureEnabled}, crossTab=${crossTabCapture}, pinnedTab=${pinnedTabId}`);

  // Service worker restart recovery (inside storage callback so sidePanelWorks is loaded first)
  console.log(`[JM] Recovery check: useSidePanel=${useSidePanel}, sidePanelVerified=${sidePanelVerified}, panelVisible=${result.panelVisible}`);
  if (useSidePanel && sidePanelVerified !== false && result.panelVisible === true) {
    try {
      chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] })
        .then((contexts) => {
          console.log(`[JM] Recovery: found ${contexts.length} side panel context(s)`);
          if (contexts.length > 0) {
            console.log('[JM] Service worker recovery: found side panel context, broadcasting true');
            sidePanelOpen = true;
            broadcastPanelState(true);
            startHeartbeat();
          }
        })
        .catch(() => {});
    } catch { /* getContexts not available */ }
  } else if (sidePanelVerified === false) {
    console.log('[JM] Skipping side panel recovery (sidePanelWorks=false)');
  }
});

// Open panel when extension icon clicked
chrome.action.onClicked.addListener((tab) => {
  openPanel(tab.windowId);
});

// Listen for keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-screenshot') {
    captureScreenshot();
  }
});

// Inject content script into a tab if it's not already present
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith('chrome') || tab.url.startsWith('about')) {
      console.log(`Skipping injection for tab ${tabId} (url: ${tab.url})`);
      return;
    }
    await chrome.tabs.sendMessage(tabId, { type: 'ping' }).catch(async () => {
      console.log(`Injecting content script into tab ${tabId} (${tab.url})`);
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['dist/content.js'],
      });
    });
  } catch (err) {
    console.error(`Failed to inject content script into tab ${tabId}:`, err);
  }
}

// Inject on tab switch (pre-existing tabs)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  ensureContentScript(tabId);
});

// Inject when a tab finishes loading (new navigations)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    ensureContentScript(tabId);
  }
});

// Listen for messages from panel
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Messages meant for the offscreen document -- don't handle here.
  // Returning false explicitly tells Chrome this listener won't respond,
  // allowing the offscreen document's listener to handle them.
  if (message.type === 'stitchTiles' || message.type === 'offscreenReady') return false;

  if (message.type === 'capture') {
    captureScreenshot().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'getSession') {
    getSession().then((session) => sendResponse(session));
    return true;
  }
  if (message.type === 'updateSession') {
    saveSession(message.session).then(() => {
      if (branchingEnabled) {
        rebuildBranchMaps(message.session.steps);
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === 'getAutoCapture') {
    sendResponse({ enabled: autoCaptureEnabled, crossTab: crossTabCapture, fullPage: fullPageCapture });
    return false;
  }
  if (message.type === 'setAutoCapture') {
    autoCaptureEnabled = message.enabled;
    chrome.storage.local.set({ autoCaptureEnabled });
    if (autoCaptureEnabled) {
      registerAutoCapture();
      // Find the correct browser window (not our popup panel) to pin the tab
      chrome.windows.getAll({ windowTypes: ['normal'] }).then(async (windows) => {
        const focusedWin = windows.find((w) => w.focused) ?? windows[0];
        if (focusedWin?.id) {
          const tabs = await chrome.tabs.query({ active: true, windowId: focusedWin.id });
          pinnedTabId = tabs[0]?.id ?? null;
        }
        console.log(`[autoCapture] Enabled: pinnedTabId=${pinnedTabId}`);
        sendResponse({ ok: true });
      }).catch(() => {
        sendResponse({ ok: true });
      });
      return true; // async sendResponse
    } else {
      unregisterAutoCapture();
      pinnedTabId = null;
      console.log('[autoCapture] Disabled');
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'setCrossTabCapture') {
    crossTabCapture = message.enabled;
    chrome.storage.local.set({ crossTabCapture });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'setFullPageCapture') {
    fullPageCapture = message.enabled;
    chrome.storage.local.set({ fullPageCapture });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'getPanelState') {
    console.log(`[JM] getPanelState: useSidePanel=${useSidePanel}, sidePanelOpen=${sidePanelOpen}, panelWindowId=${panelWindowId}`);
    if (useSidePanel) {
      sendResponse({ visible: sidePanelOpen });
      return false;
    }
    findExistingPanel().then((win) => {
      sendResponse({ visible: win !== null });
    });
    return true;
  }
  if (message.type === 'sidePanelOpened') {
    sidePanelOpen = true;
    sidePanelVerified = true;
    broadcastPanelState(true);
    startHeartbeat();
    chrome.storage.local.set({ sidePanelWorks: true });
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'sidePanelClosed') {
    if (sidePanelOpen) {
      sidePanelOpen = false;
      broadcastPanelState(false);
      stopHeartbeat();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'setBranching') {
    branchingEnabled = message.enabled;
    chrome.storage.local.set({ branchingEnabled });
    if (branchingEnabled) {
      registerBranchTracking();
    } else {
      unregisterBranchTracking();
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'getBranching') {
    sendResponse({ enabled: branchingEnabled });
    return false;
  }
  if (message.type === 'clearSession') {
    urlToStepId.clear();
    depthOf.clear();
    currentParentId = null;
    const fresh: JourneySession = { steps: [], createdAt: Date.now() };
    saveSession(fresh).then(() => {
      // Best-effort server cleanup (server may be offline; files will be cleaned on next startup)
      fetch(`${BRIDGE_URL}/api/screenshots`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }
  if (message.type === 'checkHealth') {
    fetch(`${BRIDGE_URL}/api/health`, { signal: AbortSignal.timeout(3000) })
      .then((res) => res.json())
      .then((data) => {
        sendResponse({ serverOnline: data.online ?? true, figmaConnected: data.figmaConnected ?? false });
      })
      .catch(() => {
        sendResponse({ serverOnline: false, figmaConnected: false });
      });
    return true;
  }
  if (message.type === 'saveAll') {
    (async () => {
      try {
        const session = await getSession();
        if (session.steps.length === 0) {
          sendResponse({ error: 'No screenshots to save' });
          return;
        }

        // Upload each screenshot
        for (const step of session.steps) {
          const res = await fetch(`${BRIDGE_URL}/api/screenshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: step.id, imageDataUrl: step.imageDataUrl }),
          });
          if (!res.ok) throw new Error(`Upload failed for step ${step.stepNumber}`);
        }

        // Build metadata for filenames
        const stepsMeta = session.steps.map((s) => ({
          id: s.id,
          stepNumber: s.stepNumber,
          pageTitle: s.pageTitle,
        }));

        // Fetch zip
        const zipRes = await fetch(
          `${BRIDGE_URL}/api/screenshots/zip?steps=${encodeURIComponent(JSON.stringify(stepsMeta))}`
        );
        if (!zipRes.ok) throw new Error('Failed to create zip archive');

        const blob = await zipRes.blob();
        // Convert blob to data URL for chrome.downloads
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(new Error('Failed to read blob'));
          reader.readAsDataURL(blob);
        });

        await chrome.downloads.download({
          url: dataUrl,
          filename: 'journey-screenshots.zip',
          saveAs: false,
        });

        sendResponse({ ok: true, count: session.steps.length });
      } catch (err) {
        sendResponse({ error: (err as Error).message });
      }
    })();
    return true;
  }
  if (message.type === 'exportToFigma') {
    (async () => {
      try {
        const session = await getSession();
        if (session.steps.length === 0) {
          sendResponse({ error: 'No screenshots to export' });
          return;
        }

        // Upload each screenshot
        const uploadedSteps: Array<{
          id: string;
          stepNumber: number;
          imageUrl: string;
          pageUrl: string;
          pageTitle: string;
          label: string;
          parentId: string | null;
        }> = [];

        for (const step of session.steps) {
          const res = await fetch(`${BRIDGE_URL}/api/screenshots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: step.id, imageDataUrl: step.imageDataUrl }),
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
            parentId: step.parentId ?? null,
          });
        }

        // Trigger export
        const exportRes = await fetch(`${BRIDGE_URL}/api/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ steps: uploadedSteps }),
        });

        if (!exportRes.ok) {
          const err = await exportRes.json().catch(() => ({ error: 'Export failed' }));
          throw new Error(err.error || 'Export failed');
        }

        sendResponse({ ok: true, count: uploadedSteps.length });
      } catch (err) {
        sendResponse({ error: (err as Error).message });
      }
    })();
    return true;
  }
  if (message.type === 'closePanel') {
    (async () => {
      try {
        // Disable auto-capture immediately
        if (autoCaptureEnabled) {
          autoCaptureEnabled = false;
          chrome.storage.local.set({ autoCaptureEnabled: false });
          unregisterAutoCapture();
          pinnedTabId = null;
        }
        // Set state to closed BEFORE attempting UI close
        sidePanelOpen = false;
        stopHeartbeat();
        console.log(`[JM] closePanel: broadcasting false, removing window=${panelWindowId}`);
        await broadcastPanelState(false);
        // Then close the actual panel UI (best-effort)
        if (panelWindowId !== null) {
          await chrome.windows.remove(panelWindowId).catch(() => {});
        } else {
          chrome.runtime.sendMessage({ type: 'closeSidePanel' }).catch(() => {});
        }
      } catch { /* state already cleaned up above */ }
      sendResponse({ ok: true });
    })();
    return true;
  }
});
