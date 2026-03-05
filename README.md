# Journey Mapper

Screenshot-to-Figma user journey mapping tool. Capture screenshots as you navigate a product, then export them to a Figma canvas with arrows and annotations.

## Architecture

```
Chrome Extension  -->  Local Bridge Server  -->  figma-console-mcp  -->  Figma
   (capture)         (Express on :3456)        (MCP over stdio)       (Desktop app)
```

Three components:

1. **Chrome Extension** (Manifest V3) - captures screenshots via hotkey, auto-capture, or button. Shows a side panel (or popup fallback) for managing steps.
2. **Bridge Server** (Node.js/Express) - receives screenshots, serves them as URLs, orchestrates Figma placement via MCP.
3. **figma-console-mcp** (pinned @1.11.2, fetched via npx) - executes Figma Plugin API code on the desktop app through the Desktop Bridge plugin.

## Prerequisites

- **macOS or Linux** (the server uses `pkill` for process cleanup, which is not available on Windows)
- **Node.js 20+** and npm
- **Figma Desktop** app running (the browser version of Figma will not work)
- **Figma Console MCP Desktop Bridge** plugin installed (see setup below)
- Chrome or Chromium-based browser (for the extension)

## Setup

### 1. Install dependencies and build

```bash
# From the journey-mapper directory
npm install

# Build the Chrome extension
npm run build:ext

# Start the bridge server
npm run server
```

### 2. Install the Figma Desktop Bridge plugin

The bridge server communicates with Figma through the Desktop Bridge plugin from [figma-console-mcp](https://github.com/southleft/figma-console-mcp). To install it:

1. Open **Figma Desktop** (the desktop app, not the browser version)
2. Go to **Plugins > Development > Import plugin from manifest...**
3. Navigate to `figma-console-mcp/figma-desktop-bridge/manifest.json` inside this repo and select it
4. Open a Figma file, then run the plugin: **Plugins > Development > Figma Console MCP Desktop Bridge**

The plugin auto-connects via WebSocket (scanning ports 9223-9232). You only need to import it once; it persists in your Development plugins list across sessions. Just run it each time you open a Figma file.

### 3. Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder (it uses `dist/` for built JS plus root for HTML/CSS/manifest)

## Usage

1. Start the bridge server: `npm run server`
2. Open Figma Desktop with a file and the Desktop Bridge plugin active
3. Click the Journey Mapper extension icon - on Chrome this opens a **side panel**, on browsers that don't support side panels (e.g., Arc) it opens a **popup window** instead
4. Navigate to the product you want to map in Chrome
5. Press **Alt+Shift+S** to capture a screenshot (or click "Capture" in the side panel)
6. Repeat for each step in the journey
7. Add labels and reorder steps via drag-and-drop in the side panel
8. Click **Export to Figma** to place all screenshots on the Figma canvas with arrows

### Capture Modes

| Mode | Description |
|------|-------------|
| **Manual** (default) | Press Alt+Shift+S or click Capture for each step |
| **Auto-capture** | Automatically captures on page navigation (toggle in side panel). Pins to the active tab when enabled and skips duplicate URLs. There is a 500ms delay after navigation to let the page render before capturing. |
| **Cross-tab** | When combined with auto-capture, captures across all tabs instead of only the pinned one. Tab switches have a 300ms delay before capture. |
| **Full-page** | Scrolls the page and stitches tiles into a single tall screenshot. Restores the original scroll position when done. |

### Saving Screenshots

- **Individual download** - click the download icon on any step card
- **Save All** - downloads all screenshots as a `journey-screenshots.zip` (requires bridge server)

## Development

```bash
# Watch mode for extension (rebuilds on file changes)
cd extension && npm run watch

# Dev mode for server (restarts on file changes)
npm run dev:server
```

## How It Works

### Capture Flow

- Chrome extension captures the visible tab via `chrome.tabs.captureVisibleTab()`
- Chrome throttles `captureVisibleTab()` to roughly 2 calls per second, so full-page capture inserts a 600ms delay between each tile
- For full-page capture, tile stitching happens in an offscreen document because Manifest V3 service workers cannot use Canvas directly
- Screenshots are stored as base64 data URLs in `chrome.storage.local` (10MB quota; a warning appears at 8MB)
- Side panel shows thumbnails with editable labels and drag-and-drop reorder
- A content script provides visual capture-flash feedback on the page
- Content scripts are injected lazily (on tab activation or page load), not at extension install time. A ping/response check avoids duplicate injection.

### Image Size Constraints

Full-page screenshots and high-DPI displays can produce very large images. Several constraints keep things working end to end:

- **20-tile cap** - full-page capture stops scrolling after 20 viewport-height tiles to avoid memory exhaustion in the browser
- **1200px max width** - stitched images are downscaled so the output width never exceeds 1200px, regardless of Retina/HiDPI device pixel ratio
- **4096px max dimension** - Figma's `createImage()` API has a hard limit of 4096px per dimension, so the stitcher further scales down tall pages to fit within this
- **0.6 JPEG quality** - stitched images use reduced JPEG quality to keep the base64 payload small enough for MCP transport
- **One frame per MCP call** - during export, each frame is placed in a separate `figma_execute` call rather than all at once, because the base64 image data is inlined directly in the Plugin API code (the Figma plugin sandbox cannot reliably fetch from localhost)

### Export Flow

1. Extension uploads each screenshot (base64) to the bridge server
2. Server saves images to a temp directory and returns localhost URLs
3. For each step, the server generates Figma Plugin API code that:
   - Decodes the base64 image directly via `figma.createImage(bytes)` (falls back to URL-based `figma.createImageAsync()` if needed)
   - Creates a frame at the correct grid position
   - Adds the page URL as a text annotation
4. After all frames are placed, the server generates vector arrows between consecutive frames
5. All code is executed via the `figma_execute` MCP tool through figma-console-mcp

### Layout

- Frames: 400x300px
- Horizontal gap: 200px, vertical gap: 200px
- 5 frames per row, then wraps to the next row
- Vector arrows link consecutive frames (horizontal within a row, L-shaped across rows)
- Rearrange manually in Figma for branching flows

## Known Limitations

- **Port 3456 is hardcoded** in both the server and the extension. Changing it requires editing `server/src/index.ts` and the `BRIDGE_URL` constant in the extension source files, then rebuilding.
- **Server uses the system temp directory** (`os.tmpdir()`) for screenshot files. These are cleaned up automatically on server startup and after each export.
- **Express accepts up to 50MB request bodies** for screenshot uploads. Extremely large full-page captures may need the JPEG quality or tile count reduced.
- **Reconnection is debounced** -- when Figma disconnects, the server waits for 2 consecutive health check failures before reporting "disconnected" (to avoid UI flicker from transient issues). Reconnection attempts are throttled to once every 15 seconds.
- **MCP process cleanup** -- the server force-kills the `npx figma-console-mcp` process tree on disconnect using `pkill`, because the MCP SDK's built-in close does not reliably terminate the child process tree spawned by npx.
- **Service worker lifecycle** -- Chrome can terminate the extension's service worker at any time. Auto-capture state, side panel preference, and panel visibility are persisted in `chrome.storage.local` so the extension can recover after a restart.
- **Extension permissions** -- the extension requests `<all_urls>` host permission because the content script (capture flash, floating control panel, scroll measurement) needs to run on any site the user is mapping.

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Export button disabled | Three possible causes: bridge server is offline (`npm run server`), Figma is not connected, or no screenshots captured yet |
| "Figma disconnected" | Open Figma Desktop and enable the Desktop Bridge plugin. The status may take up to 15 seconds to update due to reconnection throttling. |
| Arrows not appearing | Check the Figma console for errors (the plugin window) |
| Images show gray boxes | Image encoding failed; the error details are in the Figma frame name, and also in the bridge server logs |
| Storage warning | Clear old screenshots before capturing more (10MB Chrome storage limit) |
| Side panel doesn't open | Some browsers (e.g., Arc) don't support side panels; the extension falls back to a popup window automatically |
| Full-page capture incomplete | Very tall pages are capped at 20 tiles to avoid memory issues |

## License

[MIT](LICENSE)
