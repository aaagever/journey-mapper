# Journey Mapper

Screenshot-to-Figma user journey mapping tool. Capture screenshots as you navigate a product, then export them to a Figma canvas with connectors.

## Architecture

```
Chrome Extension  -->  Local Bridge Server  -->  figma-console-mcp  -->  Figma
   (capture)         (Express on :3456)        (MCP over stdio)       (Desktop Bridge)
```

Three components:
1. **Chrome Extension** (Manifest V3) - hotkey capture + side panel UI
2. **Bridge Server** (Node.js/Express) - receives screenshots, serves them as URLs, orchestrates Figma placement via MCP
3. **figma-console-mcp** (pinned @1.11.2) - executes Figma Plugin API code on the desktop app

## Prerequisites

- **Node.js 20+** and npm
- **Figma Desktop** app running
- **Desktop Bridge** plugin installed from Figma Community
- A **Figma** file open (connectors require Figma, not Figma Design)
- Chrome (for the extension)

## Setup

```bash
# From this directory
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
4. Select the `extension/` folder (it uses `dist/` for built JS + root for HTML/CSS/manifest)

## Usage

1. Start the bridge server: `npm run server`
2. Open Figma Desktop with a Figma file and the Desktop Bridge plugin active
3. Navigate to the product you want to audit in Chrome
4. Press **Alt+Shift+S** to capture a screenshot (or click "Capture" in the side panel)
5. Repeat for each step in the journey
6. Add labels and reorder steps via drag-and-drop in the side panel
7. Click **Export to Figma** to place all screenshots on the Figma canvas with connectors

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
- Screenshots stored as base64 data URLs in `chrome.storage.local`
- Side panel shows thumbnails with editable labels and drag-and-drop reorder

### Export Flow
1. Extension uploads each screenshot (base64) to bridge server
2. Server saves PNGs to `/tmp/journey-mapper/` and returns localhost URLs
3. Server generates Figma Plugin API code to:
   - Load each image via `figma.createImageAsync(url)`
   - Create frames in a left-to-right grid layout (5 per row)
   - Add step number, label, and URL text annotations
   - Draw connectors between consecutive frames
4. Code is executed via `figma_execute` tool through the MCP client

### Layout
- Frames: 400x300px
- Horizontal gap: 200px
- 5 frames per row, then wraps to next row
- Connectors link consecutive frames automatically
- Rearrange manually in Figma for branching flows

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Export button disabled | Start the bridge server (`npm run server`) |
| "Figma disconnected" | Open Figma Desktop, enable Desktop Bridge plugin |
| Connectors missing | Must use a Figma file, not Figma Design |
| Images show gray boxes | Figma can't reach localhost URLs - check server is running |
| Storage warning | Clear old screenshots before capturing more (10MB limit) |
