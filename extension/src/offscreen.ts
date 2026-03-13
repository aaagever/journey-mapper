// Offscreen document for stitching full-page screenshot tiles on a canvas.
// MV3 service workers cannot use Canvas directly, so this runs in an offscreen context.

interface StitchRequest {
  type: 'stitchTiles';
  tiles: string[];          // data URLs for each viewport tile
  viewportWidth: number;    // CSS pixels
  viewportHeight: number;   // CSS pixels
  totalHeight: number;      // full page scrollHeight in CSS pixels
  devicePixelRatio: number;
}

chrome.runtime.onMessage.addListener((msg: StitchRequest, _sender, sendResponse) => {
  if (msg.type !== 'stitchTiles') return false;

  console.log(`[offscreen] stitchTiles received: ${msg.tiles.length} tiles, ${msg.viewportWidth}x${msg.viewportHeight}, totalHeight=${msg.totalHeight}`);

  stitchTiles(msg)
    .then((dataUrl) => {
      console.log(`[offscreen] Stitch complete, dataUrl length: ${dataUrl.length}`);
      sendResponse({ dataUrl });
    })
    .catch((err) => {
      console.error('[offscreen] Stitch error:', err);
      sendResponse({ error: (err as Error).message });
    });

  return true; // async
});

const MAX_OUTPUT_WIDTH = 1200; // Cap stitched image width for Figma plugin compatibility
const MAX_OUTPUT_DIM = 4096;   // Figma createImage() hard limit per dimension
const STITCH_JPEG_QUALITY = 0.6; // Lower quality to keep base64 payload manageable

async function stitchTiles(req: StitchRequest): Promise<string> {
  const { tiles, viewportWidth, viewportHeight, totalHeight, devicePixelRatio } = req;

  // Scale down if the output would exceed MAX_OUTPUT_WIDTH
  const rawWidth = viewportWidth * devicePixelRatio;
  let dpr = rawWidth > MAX_OUTPUT_WIDTH
    ? MAX_OUTPUT_WIDTH / viewportWidth
    : devicePixelRatio;

  // Also cap height at MAX_OUTPUT_DIM for Figma compatibility
  const rawHeight = totalHeight * dpr;
  if (rawHeight > MAX_OUTPUT_DIM) {
    dpr = MAX_OUTPUT_DIM / totalHeight;
  }

  const canvasWidth = Math.round(viewportWidth * dpr);
  const canvasHeight = Math.round(totalHeight * dpr);
  const destTileHeight = Math.round(viewportHeight * dpr);

  console.log(`[offscreen] Canvas: ${canvasWidth}x${canvasHeight} (dpr=${dpr.toFixed(2)}, limit=${MAX_OUTPUT_DIM})`);

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d')!;

  for (let i = 0; i < tiles.length; i++) {
    const img = await loadImage(tiles[i]);

    // Tiles may be captured at a higher DPR than the output canvas.
    // Detect the actual tile DPR from the image dimensions.
    const tileDpr = img.width / viewportWidth;
    const srcTileHeight = Math.round(viewportHeight * tileDpr);

    const destY = i * destTileHeight;
    const destRemaining = canvasHeight - destY;
    const destHeight = Math.min(destTileHeight, destRemaining);

    // Proportional source height based on scaling ratio
    const srcHeight = Math.round(destHeight * (srcTileHeight / destTileHeight));

    // For the last tile, crop from the bottom of the tile (show page bottom)
    const sourceY = (i === tiles.length - 1 && destHeight < destTileHeight)
      ? img.height - srcHeight
      : 0;

    ctx.drawImage(
      img,
      0, sourceY, img.width, srcHeight,        // source rect (full tile resolution)
      0, destY,   canvasWidth, destHeight        // dest rect (scaled to canvas)
    );
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: STITCH_JPEG_QUALITY });
  return blobToDataUrl(blob);
}

function loadImage(dataUrl: string): Promise<ImageBitmap> {
  return fetch(dataUrl)
    .then((r) => r.blob())
    .then((b) => createImageBitmap(b));
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

// Signal to background that the listener is registered and ready
chrome.runtime.sendMessage({ type: 'offscreenReady' })
  .then(() => console.log('[offscreen] Ready signal sent successfully'))
  .catch((err) => console.warn('[offscreen] Ready signal failed:', err));
