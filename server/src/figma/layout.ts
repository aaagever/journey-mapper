export interface FramePosition {
  x: number;
  y: number;
}

const FRAME_WIDTH = 400;
const FRAME_HEIGHT = 300;
const H_GAP = 200;
const V_GAP = 200;
const COLS_PER_ROW = 5;

/**
 * Calculate x,y position for a frame given its index.
 * Layout: left-to-right grid, wrapping every COLS_PER_ROW items.
 */
export function getFramePosition(index: number): FramePosition {
  const col = index % COLS_PER_ROW;
  const row = Math.floor(index / COLS_PER_ROW);

  return {
    x: col * (FRAME_WIDTH + H_GAP),
    y: row * (FRAME_HEIGHT + V_GAP + 60), // +60 for label space below frame
  };
}

export { FRAME_WIDTH, FRAME_HEIGHT, H_GAP, V_GAP, COLS_PER_ROW };
