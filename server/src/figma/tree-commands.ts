import type { FramePosition } from './layout.js';
import type { TreeNode } from './tree-layout.js';
import {
  TREE_FRAME_WIDTH,
  TREE_FRAME_HEIGHT,
  TREE_H_GAP,
  TREE_LABEL_SPACE,
} from './tree-layout.js';

/**
 * Generate Figma Plugin API code to place a colored placeholder frame with a text label.
 * Used for the tree-test POC (no real screenshots).
 */
export function generatePlacePlaceholderFrame(
  id: string,
  label: string,
  position: FramePosition,
  color: { r: number; g: number; b: number },
): string {
  return `
(async () => {
  var frameWidth = ${TREE_FRAME_WIDTH};
  var frameHeight = ${TREE_FRAME_HEIGHT};

  var frame = figma.createFrame();
  frame.name = ${JSON.stringify(label)};
  frame.resize(frameWidth, frameHeight);
  frame.x = ${position.x};
  frame.y = ${position.y};
  frame.fills = [{ type: 'SOLID', color: { r: ${color.r}, g: ${color.g}, b: ${color.b} } }];
  frame.clipsContent = false;

  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  var textNode = figma.createText();
  textNode.fontName = { family: 'Inter', style: 'Regular' };
  textNode.characters = ${JSON.stringify(label)};
  textNode.fontSize = 18;
  textNode.x = 16;
  textNode.y = 16;
  textNode.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  frame.appendChild(textNode);

  return frame.id;
})()
`.trim();
}

/**
 * Generate Figma Plugin API code to draw tree connectors.
 *
 * Uses a **fork pattern** per parent: one horizontal stub from the parent's
 * right edge, a shared vertical spine, and individual horizontal branches
 * with arrow caps into each child. This avoids overlapping arrows when a
 * parent has multiple children.
 *
 * Single-child-same-Y degenerates to a straight horizontal arrow.
 */
export function generateTreeConnectors(
  nodes: TreeNode[],
  positionMap: Map<string, FramePosition>,
): string {
  // Group children by parent
  const childrenOf = new Map<string, string[]>();
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  for (const node of nodes) {
    if (node.parentId != null && nodeMap.has(node.parentId)) {
      if (!childrenOf.has(node.parentId)) childrenOf.set(node.parentId, []);
      childrenOf.get(node.parentId)!.push(node.id);
    }
  }

  const t = { x: 0, y: 0 }; // zero tangent shorthand

  interface VDef {
    x: number; y: number;
    strokeCap: string; strokeJoin: string;
    cornerRadius: number; handleMirroring: string;
  }
  interface SDef {
    start: number; end: number;
    tangentStart: { x: number; y: number };
    tangentEnd: { x: number; y: number };
  }

  const forks: Array<{
    vertices: VDef[];
    segments: SDef[];
    vecX: number;
    vecY: number;
    name: string;
  }> = [];

  for (const [parentId, childIds] of childrenOf) {
    const parentPos = positionMap.get(parentId);
    if (!parentPos) continue;

    const startX = parentPos.x + TREE_FRAME_WIDTH;
    const startY = parentPos.y + TREE_FRAME_HEIGHT / 2;
    const midRelX = TREE_H_GAP / 2; // junction X relative to startX

    const children = childIds
      .map((id) => ({
        id,
        pos: positionMap.get(id)!,
        centerY: positionMap.get(id)!.y + TREE_FRAME_HEIGHT / 2,
      }))
      .sort((a, b) => a.centerY - b.centerY);

    const vertices: VDef[] = [];
    const segments: SDef[] = [];

    // Single child at same Y: straight arrow
    if (children.length === 1 && Math.abs(children[0].centerY - startY) < 1) {
      const arrowLen = children[0].pos.x - startX;
      vertices.push(
        { x: 0, y: 0, strokeCap: 'NONE', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' },
        { x: arrowLen, y: 0, strokeCap: 'ARROW_EQUILATERAL', strokeJoin: 'MITER', cornerRadius: 0, handleMirroring: 'NONE' },
      );
      segments.push({ start: 0, end: 1, tangentStart: t, tangentEnd: t });
    } else {
      // Fork pattern: stub + vertical spine + horizontal branches

      // Vertex 0: parent exit point
      vertices.push({
        x: 0, y: 0,
        strokeCap: 'NONE', strokeJoin: 'MITER',
        cornerRadius: 0, handleMirroring: 'NONE',
      });

      // Spine points: junction at dy=0 (parent level) + one per child
      const spineDys = new Set<number>();
      spineDys.add(0);
      for (const child of children) {
        spineDys.add(child.centerY - startY);
      }
      const sortedDys = [...spineDys].sort((a, b) => a - b);

      const spineIdx = new Map<number, number>();
      for (const dy of sortedDys) {
        const idx = vertices.length;
        spineIdx.set(dy, idx);
        vertices.push({
          x: midRelX, y: dy,
          strokeCap: 'NONE', strokeJoin: 'ROUND',
          cornerRadius: 8, handleMirroring: 'NONE',
        });
      }

      // Stub: parent exit -> junction at dy=0
      segments.push({ start: 0, end: spineIdx.get(0)!, tangentStart: t, tangentEnd: t });

      // Spine: connect consecutive spine vertices vertically
      for (let i = 0; i < sortedDys.length - 1; i++) {
        segments.push({
          start: spineIdx.get(sortedDys[i])!,
          end: spineIdx.get(sortedDys[i + 1])!,
          tangentStart: t,
          tangentEnd: t,
        });
      }

      // Branches: spine vertex -> child entry with arrow cap
      for (const child of children) {
        const dy = child.centerY - startY;
        const sIdx = spineIdx.get(dy)!;
        const eIdx = vertices.length;
        vertices.push({
          x: child.pos.x - startX, y: dy,
          strokeCap: 'ARROW_EQUILATERAL', strokeJoin: 'MITER',
          cornerRadius: 0, handleMirroring: 'NONE',
        });
        segments.push({ start: sIdx, end: eIdx, tangentStart: t, tangentEnd: t });
      }
    }

    // Normalize vertices to non-negative coords (Figma auto-normalizes
    // bounding boxes, so negative coords cause position drift)
    const mnX = Math.min(...vertices.map(v => v.x));
    const mnY = Math.min(...vertices.map(v => v.y));
    for (const v of vertices) {
      v.x -= mnX;
      v.y -= mnY;
    }

    forks.push({
      vertices,
      segments,
      vecX: startX + mnX,
      vecY: startY + mnY,
      name: 'Tree Fork ' + parentId,
    });
  }

  if (forks.length === 0) return `"No tree connectors needed"`;

  const forksJson = JSON.stringify(forks);

  return `
(async () => {
  var forks = ${forksJson};
  var ARROW_COLOR = { r: 0.6, g: 0.6, b: 0.6 };
  var SW = 2;
  var count = 0;
  var errors = [];

  for (var f = 0; f < forks.length; f++) {
    try {
      var fork = forks[f];
      var vec = figma.createVector();
      await vec.setVectorNetworkAsync({
        vertices: fork.vertices,
        segments: fork.segments,
        regions: []
      });
      vec.strokes = [{ type: 'SOLID', color: ARROW_COLOR }];
      vec.strokeWeight = SW;
      vec.fills = [];
      vec.x = fork.vecX;
      vec.y = fork.vecY;
      vec.name = fork.name;
      count++;
    } catch (e) {
      errors.push('Fork ' + f + ': ' + (e.message || String(e)));
    }
  }

  if (errors.length > 0) {
    return 'Created ' + count + ' tree connectors. Errors: ' + errors.join('; ');
  }
  return 'Created ' + count + ' tree connectors';
})()
`.trim();
}
