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

- **Node.js 20+** and npm
- **Figma Desktop** app running
- **[Figma Console MCP Desktop Bridge](https://www.figma.com/community/plugin/figma-console-mcp)** plugin installed and active in your Figma file
- Chrome or Chromium-based browser (for the extension)

## Setup

```bash
# From the journey-mapper directory
npm install

# Build the Chrome extension
npm run build:ext

# Start the bridge server
npm run server
```

### Load the Chrome Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder (it uses `dist/` for built JS plus root for HTML/CSS/manifest)

## Usage

1. Start the bridge server: `npm run server`
2. Open Figma Desktop with a file and the Desktop Bridge plugin active
3. Click the Journey Mapper extension icon to open the side panel
4. Navigate to the product you want to map in Chrome
5. Press **Alt+Shift+S** to capture a screenshot (or click "Capture" in the side panel)
6. Repeat for each step in the journey
7. Add labels and reorder steps via drag-and-drop in the side panel
8. Click **Export to Figma** to place all screenshots on the Figma canvas with arrows

### Capture Modes

| Mode | Description |
|------|-------------|
| **Manual** (default) | Press Alt+Shift+S or click Capture for each step |
| **Auto-capture** | Automatically captures on page navigation (toggle in side panel) |
| **Cross-tab** | When combined with auto-capture, captures across all tabs, not just the pinned one |
| **Full-page** | Scrolls the page and stitches tiles into a single tall screenshot |

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
- For full-page capture, the extension scrolls the page, captures tiles, and stitches them using an offscreen document canvas
- Screenshots are stored as base64 data URLs in `chrome.storage.local`
- Side panel shows thumbnails with editable labels and drag-and-drop reorder
- A content script provides visual capture-flash feedback on the page

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

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Export button disabled | Start the bridge server (`npm run server`) and ensure Figma is connected |
| "Figma disconnected" | Open Figma Desktop, enable the Desktop Bridge plugin |
| Arrows not appearing | Check the Figma console for errors (the plugin window) |
| Images show gray boxes | Image encoding failed; check server logs for base64 decode errors |
| Storage warning | Clear old screenshots before capturing more (10MB Chrome storage limit) |
| Side panel doesn't open | Some browsers (e.g., Arc) don't support side panels; the extension falls back to a popup window automatically |
| Full-page capture incomplete | Very tall pages are capped at 20 tiles to avoid memory issues |

## License

[MIT](LICENSE)
