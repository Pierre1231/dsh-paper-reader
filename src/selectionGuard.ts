/**
 * Geometry-based drag selection for the PDF text layer.
 *
 * A text layer is absolutely positioned spans over mostly empty space: gaps
 * between words, around fractions, sub/superscripts and before an equation
 * number. When a drag passes over such a gap, Chromium has no text under the
 * pointer and resolves the selection end on its own — typically to the end of
 * the layer (the rest of the page gets selected) or not at all (the selection
 * collapses or stops short of the formula). pdf.js' `endOfContent` cover
 * reduces this but still depends on the browser's resolution of a non-text
 * hit, and loses glyphs that the pointer skips between two events.
 *
 * For a plain single-button drag that starts inside a page, both ends of the
 * selection are computed here instead:
 *  - over a span: the browser's caret position for that exact point;
 *  - over a gap: the nearest text on the pointer's line (after the closest
 *    span to the left, or before the first span when left of the text);
 *  - between pages / above or below a page: the vertically nearest page.
 * Double/triple click (word/line), shift-click, keyboard and touch selection
 * stay native. Dragging near the top/bottom edge auto-scrolls the reader.
 */
type Box = { left: number; right: number; top: number; bottom: number };
type CachedSpan = Box & { span: HTMLElement };
type Caret = { node: Node; offset: number };

/** Pure placement rule, exported for tests. Coordinates share one origin. */
export function pickNearestText<T extends Box>(spans: T[], x: number, y: number): { after?: T; before?: T } | null {
  if (!spans.length) return null;
  // Spans on the pointer's line; otherwise the vertically nearest line.
  let best = Infinity;
  for (const item of spans) best = Math.min(best, Math.max(0, item.top - y, y - item.bottom));
  const line = spans.filter(item => Math.max(0, item.top - y, y - item.bottom) <= best + 1);
  let after: T | undefined;
  for (const item of line) if (item.right <= x + 0.5 && (!after || item.right > after.right)) after = item;
  if (after) return { after };
  let before: T | undefined;
  for (const item of line) if (!before || item.left < before.left) before = item;
  return before ? { before } : null;
}

const EDGE = 28;
const MAX_SCROLL_STEP = 24;

export function installSelectionGuard(root: HTMLElement): () => void {
  const doc = root.ownerDocument;
  const view = doc.defaultView || window;
  const geometry = new Map<HTMLElement, CachedSpan[]>();
  let anchor: Caret | null = null;
  let pointer = { x: 0, y: 0 };
  let frame: number | undefined;

  const spansOf = (layer: HTMLElement): CachedSpan[] => {
    let cached = geometry.get(layer);
    if (cached) return cached;
    // Layer-local, so auto-scrolling during the drag does not invalidate it.
    const origin = layer.getBoundingClientRect();
    cached = [];
    for (const span of layer.querySelectorAll<HTMLElement>('span')) {
      if (!span.firstChild || !span.textContent) continue;
      const rect = span.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      cached.push({ span, left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top });
    }
    geometry.set(layer, cached);
    return cached;
  };
  const textNode = (span: HTMLElement, last: boolean): Text | null => {
    const walker = doc.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode() as Text | null, result = node;
    while (last && node) { result = node; node = walker.nextNode() as Text | null; }
    return result;
  };
  const browserCaret = (x: number, y: number): Caret | null => {
    // caretRangeFromPoint first: in Chromium it rounds like native drag selection.
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) return { node: range.startContainer, offset: range.startOffset };
    const position = (doc as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint?.(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  };
  const pageNear = (x: number, y: number): HTMLElement | null => {
    for (const element of doc.elementsFromPoint(x, y)) {
      const page = element.closest<HTMLElement>('.pr-page');
      if (page && root.contains(page)) return page;
    }
    let best: HTMLElement | null = null, distance = Infinity;
    for (const page of root.querySelectorAll<HTMLElement>('.pr-page')) {
      const rect = page.getBoundingClientRect();
      const d = Math.max(0, rect.top - y, y - rect.bottom);
      if (d < distance) { distance = d; best = page; }
    }
    return best;
  };
  const caretAt = (x: number, y: number): Caret | null => {
    const top = doc.elementsFromPoint(x, y)[0];
    if (top?.matches('.pr-text-layer span') && root.contains(top)) {
      const caret = browserCaret(x, y);
      if (caret && top.contains(caret.node)) return caret;
    }
    const layer = pageNear(x, y)?.querySelector<HTMLElement>('.pr-text-layer');
    if (!layer) return null;
    const origin = layer.getBoundingClientRect();
    const localY = Math.max(0, Math.min(origin.height, y - origin.top));
    const placement = pickNearestText(spansOf(layer), x - origin.left, localY);
    if (!placement) return null;
    if (placement.after) {
      const node = textNode(placement.after.span, true);
      return node ? { node, offset: node.length } : null;
    }
    const node = textNode(placement.before!.span, false);
    return node ? { node, offset: 0 } : null;
  };

  const extend = () => {
    if (!anchor) return;
    const focus = caretAt(pointer.x, pointer.y);
    if (!focus) return;
    try { doc.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset); }
    catch { stop(); }
  };
  const scroller = () => root.querySelector<HTMLElement>('.pr-scroll');
  const autoScroll = () => {
    frame = undefined;
    const scroll = scroller();
    if (!anchor || !scroll) return;
    const rect = scroll.getBoundingClientRect();
    const delta = pointer.y < rect.top + EDGE ? -Math.min(MAX_SCROLL_STEP, rect.top + EDGE - pointer.y)
      : pointer.y > rect.bottom - EDGE ? Math.min(MAX_SCROLL_STEP, pointer.y - (rect.bottom - EDGE)) : 0;
    if (!delta) return;
    const before = scroll.scrollTop;
    scroll.scrollTop += delta;
    if (scroll.scrollTop !== before) extend();
    frame = view.requestAnimationFrame(autoScroll);
  };
  const stop = () => {
    anchor = null;
    geometry.clear();
    root.removeAttribute('data-text-dragging');
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    frame = undefined;
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail > 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if ((event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents) return;
    const target = event.target instanceof Element ? event.target : null;
    const layer = target?.closest<HTMLElement>('.pr-text-layer');
    if (!layer || !root.contains(layer) || !layer.querySelector('span')) return;
    pointer = { x: event.clientX, y: event.clientY };
    geometry.clear();
    const caret = caretAt(pointer.x, pointer.y);
    if (!caret) return;
    // Own the whole drag; keep focus behaviour (keyboard shortcuts) intact.
    event.preventDefault();
    scroller()?.focus({ preventScroll: true });
    anchor = caret;
    root.setAttribute('data-text-dragging', '');
    try { doc.getSelection()?.collapse(caret.node, caret.offset); } catch { stop(); }
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!anchor) return;
    if (!(event.buttons & 1)) { stop(); return; }
    pointer = { x: event.clientX, y: event.clientY };
    event.preventDefault();
    extend();
    if (frame === undefined) frame = view.requestAnimationFrame(autoScroll);
  };

  root.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('mousemove', onMouseMove, true);
  doc.addEventListener('mouseup', stop, true);
  view.addEventListener('blur', stop);
  return () => {
    root.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('mousemove', onMouseMove, true);
    doc.removeEventListener('mouseup', stop, true);
    view.removeEventListener('blur', stop);
    stop();
  };
}
