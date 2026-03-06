import { getFramePosition, FRAME_WIDTH, FRAME_HEIGHT, H_GAP, V_GAP, COLS_PER_ROW } from './layout.js';
import type { FramePosition } from './layout.js';
import { TREE_FRAME_WIDTH, TREE_FRAME_HEIGHT } from './tree-layout.js';

export interface StepData {
  id: string;
  stepNumber: number;
  imageUrl: string;
  pageUrl: string;
  pageTitle: string;
  label: string;
  parentId?: string | null;
}

/**
 * Generate Figma Plugin API code to check we're in a Figma file.
 */
export function generateEditorCheck(): string {
  return `figma.editorType`;
}

/**
 * Generate Plugin API code that places a single frame with its screenshot.
 * Called once per step to keep message sizes small.
 * Returns the frame node ID for connector wiring.
 */
export function generatePlaceSingleFrame(
  step: StepData,
  index: number,
  imageBase64: string | null,
): string {
  const pos = getFramePosition(index);
  const stepJson = JSON.stringify({
    stepNumber: step.stepNumber,
    pageUrl: step.pageUrl,
    pageTitle: step.pageTitle,
    label: step.label,
    imageUrl: step.imageUrl,
  });

  const imageLoadCode = imageBase64
    ? `
    var b64 = ${JSON.stringify(imageBase64)};
    var lookup = new Uint8Array(256);
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var ci = 0; ci < chars.length; ci++) lookup[chars.charCodeAt(ci)] = ci;
    var len = b64.length;
    var pad = (b64[len - 1] === '=' ? 1 : 0) + (b64[len - 2] === '=' ? 1 : 0);
    var byteLen = (len * 3 / 4) - pad;
    var bytes = new Uint8Array(byteLen);
    var p = 0;
    for (var bi = 0; bi < len; bi += 4) {
      var a = lookup[b64.charCodeAt(bi)];
      var b = lookup[b64.charCodeAt(bi + 1)];
      var c = lookup[b64.charCodeAt(bi + 2)];
      var d = lookup[b64.charCodeAt(bi + 3)];
      bytes[p++] = (a << 2) | (b >> 4);
      if (p < byteLen) bytes[p++] = ((b & 15) << 4) | (c >> 2);
      if (p < byteLen) bytes[p++] = ((c & 3) << 6) | d;
    }
    var image = figma.createImage(bytes);`
    : `var image = await figma.createImageAsync(${JSON.stringify(step.imageUrl)});`;

  return `
(async () => {
  var step = ${stepJson};
  var frameWidth = ${FRAME_WIDTH};
  var frameHeight = ${FRAME_HEIGHT};
  var posX = ${pos.x};
  var posY = ${pos.y};

  var imageFill;
  var imageError = null;
  try {
    ${imageLoadCode}
    imageFill = { type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash };
  } catch (e) {
    imageError = (e && e.message) ? e.message : String(e);
    if (typeof b64 !== 'undefined') imageError += ' (base64 size: ' + b64.length + ' chars, ~' + Math.round(b64.length * 3/4/1024) + 'KB decoded)';
    console.log('[journey-mapper] Image fill error:', imageError);
    imageFill = { type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } };
  }

  var frame = figma.createFrame();
  var frameName = 'Step ' + step.stepNumber + (step.label ? ' | ' + step.label : '') + (step.pageTitle ? ' | ' + step.pageTitle : '');
  if (imageError) frameName += ' | ERROR: ' + imageError;
  frame.name = frameName;
  frame.resize(frameWidth, frameHeight);
  frame.x = posX;
  frame.y = posY;
  frame.fills = [imageFill];

  frame.clipsContent = false;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  var urlLabel = figma.createText();
  urlLabel.fontName = { family: 'Inter', style: 'Regular' };
  urlLabel.characters = step.pageUrl;
  urlLabel.fontSize = 11;
  urlLabel.x = 8;
  urlLabel.y = frameHeight - 20;
  urlLabel.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
  frame.appendChild(urlLabel);

  return imageError ? ('ERROR:' + imageError + '|' + frame.id) : frame.id;
})()
`.trim();
}

/**
 * Generate Plugin API code that places a single tree-layout frame with its screenshot.
 * Like generatePlaceSingleFrame but takes an explicit FramePosition and uses tree dimensions.
 */
export function generatePlaceTreeFrame(
  step: StepData,
  position: FramePosition,
  imageBase64: string | null,
): string {
  const stepJson = JSON.stringify({
    stepNumber: step.stepNumber,
    pageUrl: step.pageUrl,
    pageTitle: step.pageTitle,
    label: step.label,
    imageUrl: step.imageUrl,
  });

  const imageLoadCode = imageBase64
    ? `
    var b64 = ${JSON.stringify(imageBase64)};
    var lookup = new Uint8Array(256);
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (var ci = 0; ci < chars.length; ci++) lookup[chars.charCodeAt(ci)] = ci;
    var len = b64.length;
    var pad = (b64[len - 1] === '=' ? 1 : 0) + (b64[len - 2] === '=' ? 1 : 0);
    var byteLen = (len * 3 / 4) - pad;
    var bytes = new Uint8Array(byteLen);
    var p = 0;
    for (var bi = 0; bi < len; bi += 4) {
      var a = lookup[b64.charCodeAt(bi)];
      var b = lookup[b64.charCodeAt(bi + 1)];
      var c = lookup[b64.charCodeAt(bi + 2)];
      var d = lookup[b64.charCodeAt(bi + 3)];
      bytes[p++] = (a << 2) | (b >> 4);
      if (p < byteLen) bytes[p++] = ((b & 15) << 4) | (c >> 2);
      if (p < byteLen) bytes[p++] = ((c & 3) << 6) | d;
    }
    var image = figma.createImage(bytes);`
    : `var image = await figma.createImageAsync(${JSON.stringify(step.imageUrl)});`;

  return `
(async () => {
  var step = ${stepJson};
  var frameWidth = ${TREE_FRAME_WIDTH};
  var frameHeight = ${TREE_FRAME_HEIGHT};
  var posX = ${position.x};
  var posY = ${position.y};

  var imageFill;
  var imageError = null;
  try {
    ${imageLoadCode}
    imageFill = { type: 'IMAGE', scaleMode: 'FIT', imageHash: image.hash };
  } catch (e) {
    imageError = (e && e.message) ? e.message : String(e);
    if (typeof b64 !== 'undefined') imageError += ' (base64 size: ' + b64.length + ' chars, ~' + Math.round(b64.length * 3/4/1024) + 'KB decoded)';
    console.log('[journey-mapper] Image fill error:', imageError);
    imageFill = { type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } };
  }

  var frame = figma.createFrame();
  var frameName = 'Step ' + step.stepNumber + (step.label ? ' | ' + step.label : '') + (step.pageTitle ? ' | ' + step.pageTitle : '');
  if (imageError) frameName += ' | ERROR: ' + imageError;
  frame.name = frameName;
  frame.resize(frameWidth, frameHeight);
  frame.x = posX;
  frame.y = posY;
  frame.fills = [imageFill];

  frame.clipsContent = false;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  var urlLabel = figma.createText();
  urlLabel.fontName = { family: 'Inter', style: 'Regular' };
  urlLabel.characters = step.pageUrl;
  urlLabel.fontSize = 11;
  urlLabel.x = 8;
  urlLabel.y = frameHeight - 20;
  urlLabel.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
  frame.appendChild(urlLabel);

  return imageError ? ('ERROR:' + imageError + '|' + frame.id) : frame.id;
})()
`.trim();
}

/**
 * Generate Plugin API code to draw arrows between consecutive frames.
 * Uses figma.createVector() with setVectorNetworkAsync for reliable
 * arrow rendering in Figma Design files.
 */
export function generateConnectors(frameCount: number): string {
  if (frameCount < 2) return `"No connectors needed"`;

  const pairs: Array<{ fromIndex: number; toIndex: number }> = [];
  for (let i = 0; i < frameCount - 1; i++) {
    pairs.push({ fromIndex: i, toIndex: i + 1 });
  }

  const pairsJson = JSON.stringify(pairs);

  return `
(async () => {
  var pairs = ${pairsJson};
  var FRAME_W = ${FRAME_WIDTH};
  var FRAME_H = ${FRAME_HEIGHT};
  var H_GAP = ${H_GAP};
  var V_GAP = ${V_GAP};
  var COLS = ${COLS_PER_ROW};
  var LABEL_SPACE = 60;
  var ROW_H = FRAME_H + V_GAP + LABEL_SPACE;
  var COL_W = FRAME_W + H_GAP;
  var ARROW_COLOR = { r: 0.6, g: 0.6, b: 0.6 };
  var SW = 2;

  var count = 0;
  var errors = [];

  for (var p = 0; p < pairs.length; p++) {
    try {
      var pair = pairs[p];
      var fromCol = pair.fromIndex % COLS;
      var fromRow = Math.floor(pair.fromIndex / COLS);
      var toCol = pair.toIndex % COLS;
      var toRow = Math.floor(pair.toIndex / COLS);

      if (fromRow === toRow) {
        // Same-row: horizontal arrow using vector network
        var startX = fromCol * COL_W + FRAME_W;
        var y = fromRow * ROW_H + FRAME_H / 2;
        var endX = toCol * COL_W;

        var vec = figma.createVector();
        await vec.setVectorNetworkAsync({
          vertices: [
            { x: 0, y: 0, strokeCap: 'NONE', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' },
            { x: H_GAP, y: 0, strokeCap: 'ARROW_EQUILATERAL', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' }
          ],
          segments: [{
            start: 0, end: 1,
            tangentStart: { x: 0, y: 0 },
            tangentEnd: { x: 0, y: 0 }
          }],
          regions: []
        });
        vec.strokes = [{ type: 'SOLID', color: ARROW_COLOR }];
        vec.strokeWeight = SW;
        vec.x = startX;
        vec.y = y;
        vec.name = 'Arrow ' + (pair.fromIndex + 1) + ' > ' + (pair.toIndex + 1);

      } else {
        // Row-wrap: L-shaped path with downward arrow at end
        var sx = fromCol * COL_W + FRAME_W;
        var sy = fromRow * ROW_H + FRAME_H / 2;
        var ex = toCol * COL_W + FRAME_W / 2;
        var ey = toRow * ROW_H;
        var midY = fromRow * ROW_H + FRAME_H + (LABEL_SPACE + V_GAP) / 2;

        var vec2 = figma.createVector();
        await vec2.setVectorNetworkAsync({
          vertices: [
            { x: sx, y: sy, strokeCap: 'NONE', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' },
            { x: sx, y: midY, strokeCap: 'NONE', strokeJoin: 'ROUND', cornerRadius: 0, handleMirroring: 'NONE' },
            { x: ex, y: midY, strokeCap: 'NONE', strokeJoin: 'ROUND', cornerRadius: 0, handleMirroring: 'NONE' },
            { x: ex, y: ey, strokeCap: 'ARROW_EQUILATERAL', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' }
          ],
          segments: [
            { start: 0, end: 1, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
            { start: 1, end: 2, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } },
            { start: 2, end: 3, tangentStart: { x: 0, y: 0 }, tangentEnd: { x: 0, y: 0 } }
          ],
          regions: []
        });
        vec2.strokes = [{ type: 'SOLID', color: ARROW_COLOR }];
        vec2.strokeWeight = SW;
        vec2.fills = [];
        vec2.name = 'Arrow ' + (pair.fromIndex + 1) + ' > ' + (pair.toIndex + 1);
      }

      count++;
    } catch (e) {
      errors.push('Arrow ' + p + ': ' + (e.message || String(e)));
    }
  }

  if (errors.length > 0) {
    return 'Created ' + count + ' arrows. Errors: ' + errors.join('; ');
  }
  return 'Created ' + count + ' arrows';
})()
`.trim();
}
