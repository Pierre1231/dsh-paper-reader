/**
 * Memory budget for rendered pages, replacing "free everything 5 s after it
 * leaves the preload band". Pages outside the band keep their sharp bitmap
 * until the budget is exceeded; then the farthest page is shrunk to a
 * low-resolution placeholder, and only the farthest placeholders are cleared.
 * Scrolling back therefore shows content immediately (placeholder) and
 * re-renders sharp in the background instead of showing an empty page.
 */
export interface ResidentPage {
  readonly number: number;
  /** CSS px between the page and the visible viewport; 0 when visible. */
  distance(): number;
  /** Inside the render band: never shrunk or cleared. */
  near(): boolean;
  /** Covered by the user's selection: keep text and bitmap. */
  pinned(): boolean;
  fullBytes(): number;
  placeholderBytes(): number;
  hasText(): boolean;
  demote(): void;
  evict(): void;
  dropText(): void;
}

export interface ResidencyLimits {
  fullBytes: number;
  fullPages: number;
  placeholderBytes: number;
  textPages: number;
}

export const DEFAULT_RESIDENCY_LIMITS: ResidencyLimits = {
  fullBytes: 128 * 1024 * 1024,
  fullPages: 8,
  placeholderBytes: 24 * 1024 * 1024,
  textPages: 12,
};

export interface Residency {
  register(page: ResidentPage): () => void;
  /** Request a budget check soon (coalesced). */
  touch(): void;
  /** Run the budget check now. */
  enforce(): void;
  dispose(): void;
}

export function createResidency(limits: ResidencyLimits = DEFAULT_RESIDENCY_LIMITS, defer: (callback: () => void) => () => void = callback => {
  const timer = setTimeout(callback, 250);
  return () => clearTimeout(timer);
}): Residency {
  const pages = new Set<ResidentPage>();
  let cancel: (() => void) | undefined;
  const farthestFirst = (list: ResidentPage[]) => list
    .filter(page => !page.near() && !page.pinned())
    .map(page => ({ page, distance: page.distance() }))
    .sort((a, b) => b.distance - a.distance)
    .map(entry => entry.page);
  const enforce = () => {
    cancel?.(); cancel = undefined;
    const all = [...pages];
    // 1. Sharp bitmaps.
    let full = all.filter(page => page.fullBytes() > 0);
    let bytes = full.reduce((sum, page) => sum + page.fullBytes(), 0);
    for (const page of farthestFirst(full)) {
      if (bytes <= limits.fullBytes && full.length <= limits.fullPages) break;
      bytes -= page.fullBytes();
      page.demote();
      full = full.filter(item => item !== page);
    }
    // 2. Placeholders (including the ones just created).
    const placeholders = all.filter(page => page.placeholderBytes() > 0);
    let placeholderBytes = placeholders.reduce((sum, page) => sum + page.placeholderBytes(), 0);
    for (const page of farthestFirst(placeholders)) {
      if (placeholderBytes <= limits.placeholderBytes) break;
      placeholderBytes -= page.placeholderBytes();
      page.evict();
    }
    // 3. Text layers (DOM size matters to the whole host page).
    let texts = all.filter(page => page.hasText());
    for (const page of farthestFirst(texts)) {
      if (texts.length <= limits.textPages) break;
      page.dropText();
      texts = texts.filter(item => item !== page);
    }
  };
  return {
    register(page) {
      pages.add(page);
      return () => { pages.delete(page); };
    },
    touch() {
      if (cancel) return;
      cancel = defer(enforce);
    },
    enforce,
    dispose() { cancel?.(); cancel = undefined; pages.clear(); },
  };
}
