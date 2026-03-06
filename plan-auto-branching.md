# Auto-branching: Replace manual "branch from" with navigation-aware hierarchy

## Context

We just built a manual "branch from" button that requires the user to explicitly select a parent step, then capture children. The user finds this cumbersome. The desired experience: the user enables branching mode, browses naturally, captures whenever they want, and the product automatically figures out the tree structure to any depth.

**Core insight:** If the product passively tracks every navigation (not just captures), it can detect when the user returns to a previously-captured page. That return signals a branch point. All subsequent captures chain from that branch point until the user revisits another captured page.

## How it works

**State (in background.ts when branching is on):**
- `urlToStepId: Map<string, string>` -- maps normalized URLs to the step ID that captured them
- `depthOf: Map<string, number>` -- maps step IDs to their tree depth (0 = root)
- `currentParentId: string | null` -- the step that the next capture will be a child of

**Depth limit:** `MAX_BRANCH_DEPTH = 50`. If a capture would exceed this depth, it becomes a root instead. Tracked via `depthOf` map (O(1) per capture, no chain traversal needed).

**On every navigation (all page loads, not just captures):**
1. Normalize the URL (strip trailing slash only; keep hash and query params since SPAs use them for state/routing)
2. If the URL exists in `urlToStepId`, the user returned to a captured page. Set `currentParentId = urlToStepId[url]`.
3. If the URL is unknown, `currentParentId` stays unchanged (chain continues).

**On capture:**
1. Compute depth: if `currentParentId` is set, `depth = depthOf.get(currentParentId) + 1`; else `depth = 0`
2. If `depth > MAX_BRANCH_DEPTH`, force `parentId = null` and `depth = 0` (new root)
3. New step gets `parentId = branchingEnabled ? currentParentId : null`
4. Register `urlToStepId[normalizedUrl] = newStep.id` and `depthOf[newStep.id] = depth`
5. Set `currentParentId = newStep.id` (next capture chains from this one)

**Walkthrough of user's example:**
```
Browse: A -> B -> C -> back to A -> D -> E -> F
Capture all pages. Result:

1. Capture A. parentId=null, depth=0. currentParentId=A. urlMap={A}
2. Navigate to B. B not in map. currentParentId stays A.
3. Capture B. parentId=A, depth=1.  currentParentId=B. urlMap={A,B}
4. Navigate to C. Not in map. currentParentId stays B.
5. Capture C. parentId=B, depth=2.  currentParentId=C. urlMap={A,B,C}
6. Navigate back to A. A IS in map! currentParentId=A. <-- branch detected
7. Navigate to D. Not in map. currentParentId stays A.
8. Capture D. parentId=A, depth=1.  currentParentId=D. <-- D branches from A
9-11. E (depth=2), F (depth=3) chain from D.

Tree:  A -- B -- C
       └-- D -- E -- F
```

---

## Unit A: Clean up manual branch UI

**Goal:** Remove all Chunk 2B manual branching code (branch button, banner, branchParentId). After this unit, branching reverts to always-null parentId, but the data model (parentId on types, export passthrough) from Chunk 2A stays.

### Changes

**`extension/src/background.ts`**
- Remove `let branchParentId: string | null = null` (line ~10)
- Change `parentId: branchParentId` back to `parentId: null` in `captureScreenshot()`
- Remove `setBranchParent` and `getBranchParent` message handlers
- Remove `branchParentId = null` from `clearSession` handler

**`extension/src/sidepanel.ts`**
- Remove `let branchParentId: string | null = null`
- In `render()`: remove branch banner creation/insertion, remove `branchBtnClass` variable, remove `step-card--branch-active` class logic, remove branch button from card innerHTML, remove branch button click handler
- Keep `step-card--child` class logic (still needed for Unit B)
- Keep `parentId` passthrough in export
- In `deleteStep()`: remove `branchParentId` clearing logic
- In clear-all handler: remove `branchParentId = null`
- In `init()`: remove `getBranchParent` call

**`extension/sidepanel.css`**
- Remove: `.step-card--branch-active`, `.step-card__branch`, `.step-card__branch:hover`, `.step-card__branch--active`, `.branch-banner`, `.branch-banner__cancel`, `.branch-banner__cancel:hover`
- Keep: `.step-card--child .step-card__number::before`

### Test (Unit A)
1. Build and reload extension
2. Capture 2-3 steps -- no fork button should appear on cards, no banner anywhere
3. Export to Figma -- server logs `mode=grid`, same as V1
4. Cards render normally with step numbers, no indicators (all parentId null)

---

## Unit B: Navigation tracking + auto parentId in background.ts

**Goal:** Add the core auto-branching logic. When `branchingEnabled` is true, background.ts passively tracks navigations and auto-computes parentId on capture. No UI toggle yet -- enable via a message for testing.

### Changes

**`extension/src/background.ts`**

Add module-level state (after existing module vars):
```typescript
const MAX_BRANCH_DEPTH = 50;
let branchingEnabled = false;
let urlToStepId = new Map<string, string>();
let depthOf = new Map<string, number>();
let currentParentId: string | null = null;
```

Add URL normalizer:
```typescript
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
```

Add navigation tracking handler:
```typescript
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
```

Modify `captureScreenshot()` -- replace `parentId: null` with:
```typescript
let stepParentId: string | null = null;
let stepDepth = 0;
if (branchingEnabled && currentParentId) {
  const parentDepth = depthOf.get(currentParentId) ?? 0;
  if (parentDepth + 1 <= MAX_BRANCH_DEPTH) {
    stepParentId = currentParentId;
    stepDepth = parentDepth + 1;
  }
}
// ... use stepParentId in step literal ...

// After session.steps.push(step):
if (branchingEnabled) {
  const norm = normalizeUrl(step.pageUrl);
  urlToStepId.set(norm, step.id);
  depthOf.set(step.id, stepDepth);
  currentParentId = step.id;
}
```

Add message handlers (alongside existing handlers):
```typescript
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
```

Modify `clearSession` handler -- add:
```typescript
urlToStepId.clear();
depthOf.clear();
currentParentId = null;
```

Modify storage load block -- add `branchingEnabled` to the `get()` keys list:
```typescript
branchingEnabled = result.branchingEnabled ?? false;
if (branchingEnabled) registerBranchTracking();
```

Handle step deletion -- add `updateSession` handler logic:
When session is saved with fewer steps, rebuild `urlToStepId` and `depthOf` from the remaining steps.

### Test (Unit B)
Testing via DevTools console (no UI toggle yet):

1. Build and reload extension
2. Open background service worker console (`chrome://extensions` > Inspect views > service worker)
3. Enable branching manually: `chrome.runtime.sendMessage({ type: 'setBranching', enabled: true })`
4. **Linear chain:** Capture A, navigate to new page, capture B, navigate to new page, capture C. In sidepanel: B and C should show indicator. Export should log `mode=tree`.
5. **Branch point:** Navigate back to A's URL. Navigate to new page, capture D. D should show indicator. Export: A has two children (B and D).
6. **Deep chain:** Capture 5+ steps in sequence. Each chains from the previous. All show indicators with increasing depth in export.
7. **Branching off:** `chrome.runtime.sendMessage({ type: 'setBranching', enabled: false })`. Capture a step. It should have no indicator (parentId null).
8. **Clear session:** While branching is on, clear all. Capture a fresh step -- it should be a root (no indicator).

---

## Unit C: Branching toggle in content overlay

**Goal:** Add a user-facing toggle in the floating overlay panel so users can enable/disable branching without DevTools.

### Changes

**`extension/src/content.ts`**

In `createControlPanel()`, add a new toggle row following the same pattern as existing toggles (auto-capture, cross-tab, full-page). Place it after the "Full page" toggle:

- Label: "Map branches"
- On toggle: send `{ type: 'setBranching', enabled: boolean }` to background
- On init: send `{ type: 'getBranching' }` to load current state
- Listen for storage changes on `branchingEnabled` to stay in sync

### Test (Unit C)
1. Build and reload extension
2. Navigate to any page, open the floating overlay
3. Verify "Map branches" toggle is visible
4. Toggle it on -- enable branching
5. Browse A -> B -> C, capturing each. B and C show indicator in sidepanel.
6. Toggle it off. Capture D. D has no indicator.
7. Close and reopen the overlay -- toggle state persists.
8. Full end-to-end: toggle on, do a branching flow (A -> B -> C -> back to A -> D), export to Figma, verify tree layout.

---

## Files summary

| File | Unit | What changes |
|------|------|-------------|
| `extension/src/background.ts` | A | Remove `branchParentId`, manual branch handlers |
| `extension/src/sidepanel.ts` | A | Remove branch button, banner, manual branch state |
| `extension/sidepanel.css` | A | Remove branch-active, branch button, banner styles |
| `extension/src/background.ts` | B | Add navigation tracking, auto parentId, depth limit |
| `extension/src/content.ts` | C | Add "Map branches" toggle |

**No changes:** `types.ts` (parentId stays), server code (tree-layout handles everything).

## Failure isolation

| Symptom | Likely cause | How to isolate |
|---------|-------------|---------------|
| All captures still parentId=null with branching on | `setBranching` not reaching background, or tracking not registered | Log `branchingEnabled` in `captureScreenshot()` |
| Wrong parent assigned after navigating back | URL normalization mismatch (captured URL vs navigation URL) | Log both `normalizeUrl(step.pageUrl)` at capture and `normalizeUrl(details.url)` at navigation |
| SPA hash navigation not detected | `onReferenceFragmentUpdated` listener missing | Verify `registerBranchTracking` includes this listener |
| Depth limit hit unexpectedly | `depthOf` not updated or wrong parent depth | Log depth computation in `captureScreenshot()` |
| Child indicator shows on wrong steps | Old session data with stale parentIds | Clear session and start fresh |
