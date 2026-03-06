import type { FramePosition } from './layout.js';

export const TREE_FRAME_WIDTH = 400;
export const TREE_FRAME_HEIGHT = 300;
export const TREE_H_GAP = 250;
export const TREE_V_GAP = 100;
export const TREE_LABEL_SPACE = 60;

export interface TreeNode {
  id: string;
  parentId: string | null;
}

/**
 * Compute left-to-right tree positions for a set of nodes with parent-child relationships.
 *
 * Algorithm:
 * 1. Build adjacency (parentId -> children[])
 * 2. Bottom-up: compute subtree heights (leaf = frame + label, branch = sum of children + gaps)
 * 3. Top-down: assign (x, y) positions. x = depth * stride, children stacked vertically,
 *    parent centered among children.
 */
export function computeTreeLayout(nodes: TreeNode[]): Map<string, FramePosition> {
  if (nodes.length === 0) return new Map();

  // Build adjacency map
  const childrenOf = new Map<string, string[]>();
  const nodeMap = new Map<string, TreeNode>();
  const roots: string[] = [];

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    if (!childrenOf.has(node.id)) childrenOf.set(node.id, []);
  }

  for (const node of nodes) {
    if (node.parentId == null || !nodeMap.has(node.parentId)) {
      roots.push(node.id);
    } else {
      childrenOf.get(node.parentId)!.push(node.id);
    }
  }

  const nodeHeight = TREE_FRAME_HEIGHT + TREE_LABEL_SPACE;
  const xStride = TREE_FRAME_WIDTH + TREE_H_GAP;

  // Bottom-up: compute subtree heights
  const subtreeHeight = new Map<string, number>();

  function computeHeight(id: string): number {
    const children = childrenOf.get(id) ?? [];
    if (children.length === 0) {
      subtreeHeight.set(id, nodeHeight);
      return nodeHeight;
    }
    let total = 0;
    for (let i = 0; i < children.length; i++) {
      if (i > 0) total += TREE_V_GAP;
      total += computeHeight(children[i]);
    }
    subtreeHeight.set(id, total);
    return total;
  }

  // Compute total height of all roots (stacked vertically with gaps)
  let totalRootHeight = 0;
  for (let i = 0; i < roots.length; i++) {
    if (i > 0) totalRootHeight += TREE_V_GAP;
    totalRootHeight += computeHeight(roots[i]);
  }

  // Top-down: assign positions
  const positions = new Map<string, FramePosition>();

  function assignPositions(id: string, depth: number, yStart: number): void {
    const children = childrenOf.get(id) ?? [];
    const x = depth * xStride;

    if (children.length === 0) {
      // Leaf: place at top of allocated band
      positions.set(id, { x, y: yStart });
      return;
    }

    // Place children within the subtree band
    let childY = yStart;
    for (let i = 0; i < children.length; i++) {
      assignPositions(children[i], depth + 1, childY);
      childY += subtreeHeight.get(children[i])! + TREE_V_GAP;
    }

    // Center parent among children's vertical span
    const firstChild = positions.get(children[0])!;
    const lastChild = positions.get(children[children.length - 1])!;
    const centerY = (firstChild.y + lastChild.y) / 2;
    positions.set(id, { x, y: centerY });
  }

  let yOffset = 0;
  for (let i = 0; i < roots.length; i++) {
    assignPositions(roots[i], 0, yOffset);
    yOffset += subtreeHeight.get(roots[i])! + TREE_V_GAP;
  }

  return positions;
}
