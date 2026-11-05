export type OverlayRect = { left: number; top: number; width: number; height: number };

type Point = { x: number; y: number };

const right = (rect: OverlayRect) => rect.left + Math.max(0, rect.width);
const bottom = (rect: OverlayRect) => rect.top + Math.max(0, rect.height);

/** Fit an axis to the actual boundary, relaxing padding when space is scarce. */
function clampAxis(value: number, start: number, extent: number, size: number, padding: number): number {
  const available = Math.max(0, extent - size);
  const inset = Math.min(padding, available / 2);
  return Math.min(start + available - inset, Math.max(start + inset, value));
}

/**
 * Return a client-space top-left position. Prefer above the anchor, then below;
 * clamp either placement to the supplied boundary (which need not start at 0).
 * Oversize menus align to the boundary's start; shrink the menu separately if
 * it must fit entirely within a narrower/shorter boundary.
 */
export function positionReaderOverlay(
  anchor: OverlayRect,
  boundary: OverlayRect,
  size: { width: number; height: number },
  padding = 8,
  gap = 8,
): { left: number; top: number; placement: 'top' | 'bottom' } {
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);
  const inset = Math.max(0, padding);
  const separation = Math.max(0, gap);
  const above = anchor.top - separation - height;
  const placement = above >= boundary.top + inset ? 'top' : 'bottom';
  const desiredTop = placement === 'top' ? above : bottom(anchor) + separation;
  return {
    left: clampAxis(anchor.left + Math.max(0, anchor.width) / 2 - width / 2,
      boundary.left, Math.max(0, boundary.width), width, inset),
    top: clampAxis(desiredTop, boundary.top, Math.max(0, boundary.height), height, inset),
    placement,
  };
}

function contains(point: Point, rect: OverlayRect): boolean {
  return point.x >= rect.left && point.x <= right(rect) &&
    point.y >= rect.top && point.y <= bottom(rect);
}

function inBufferedRect(point: Point, left: number, top: number, maxRight: number, maxBottom: number, buffer: number): boolean {
  return point.x >= left - buffer && point.x <= maxRight + buffer &&
    point.y >= top - buffer && point.y <= maxBottom + buffer;
}

/** A narrow rectangle along the closest corner-to-corner segment. */
function inDiagonalCorridor(point: Point, start: Point, end: Point, buffer: number): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const px = point.x - start.x;
  const py = point.y - start.y;
  const along = (px * dx + py * dy) / length;
  const across = Math.abs(px * dy - py * dx) / length;
  return along >= -buffer && along <= length + buffer && across <= buffer;
}

/**
 * Hit-test the anchor, menu, and only their shortest intervening gap. Overlap
 * on one axis produces a buffered gap rectangle. Diagonal separation produces
 * a narrow corridor between the nearest corners, never their large bounding
 * box or the convex hull of the complete anchor and menu. No DOM is needed.
 */
export function isPointInOverlayBridge(
  point: Point,
  anchor: OverlayRect,
  menu: OverlayRect,
  buffer = 8,
): boolean {
  if (contains(point, anchor) || contains(point, menu)) return true;
  const margin = Math.max(0, buffer);
  const overlapLeft = Math.max(anchor.left, menu.left);
  const overlapRight = Math.min(right(anchor), right(menu));
  const overlapTop = Math.max(anchor.top, menu.top);
  const overlapBottom = Math.min(bottom(anchor), bottom(menu));

  if (overlapLeft <= overlapRight) {
    if (overlapTop <= overlapBottom) return false; // They already touch/overlap.
    return inBufferedRect(point, overlapLeft, Math.min(bottom(anchor), bottom(menu)),
      overlapRight, Math.max(anchor.top, menu.top), margin);
  }
  if (overlapTop <= overlapBottom) {
    return inBufferedRect(point, Math.min(right(anchor), right(menu)), overlapTop,
      Math.max(anchor.left, menu.left), overlapBottom, margin);
  }

  const start = {
    x: right(anchor) < menu.left ? right(anchor) : anchor.left,
    y: bottom(anchor) < menu.top ? bottom(anchor) : anchor.top,
  };
  const end = {
    x: right(anchor) < menu.left ? menu.left : right(menu),
    y: bottom(anchor) < menu.top ? menu.top : bottom(menu),
  };
  return inDiagonalCorridor(point, start, end, margin);
}
