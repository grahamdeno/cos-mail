// Swipe logic without the DOM, so the threshold rules can be tested.
// Past `threshold` px either way decides. A small movement is a tap. Anything between cancels.
import { CONFIG } from "./config.js";

/** @param {{threshold?: number, tapSlop?: number, onMove?: (dx: number) => void, onDecide?: (dir: "left" | "right") => void, onCancel?: () => void, onTap?: () => void}} [opts] */
export function createSwipe(opts = {}) {
  const { threshold = CONFIG.swipePx, tapSlop = CONFIG.tapSlopPx, onMove, onDecide, onCancel, onTap } = opts;
  let x0 = null;
  let dx = 0;
  return {
    get active() { return x0 !== null; },
    down(x) { x0 = x; dx = 0; },
    move(x) {
      if (x0 === null) return;
      dx = x - x0;
      onMove?.(dx);
    },
    up() {
      if (x0 === null) return;
      const d = dx;
      x0 = null; dx = 0;
      if (Math.abs(d) > threshold) onDecide?.(d > 0 ? "right" : "left");
      else if (Math.abs(d) <= tapSlop) onTap?.();
      else onCancel?.();
    },
    cancel() {
      if (x0 === null) return;
      x0 = null; dx = 0;
      onCancel?.();
    },
  };
}

/** Pull gestures (strip up, sheet down): true once the drag passes `distance` in the wanted direction. */
export function passedPull(startY, endY, direction, distance = 60) {
  const d = endY - startY;
  return direction === "up" ? d <= -distance : d >= distance;
}
