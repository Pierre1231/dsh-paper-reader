/**
 * Reading position and display preferences that survive a restart.
 * Everything lives in localStorage and is wrapped in try/catch: a host may
 * block storage, and the reader must work identically without it.
 */
export interface SavedView {
  page: number;
  scale: number;
  /** Follow the panel width instead of a fixed zoom. */
  fit: boolean;
  /** Position inside the page, 0 = top edge, 1 = bottom edge. */
  offset?: number;
}

const VIEW_PREFIX = 'dsh-paper-reader:view:';
const VIEW_INDEX = 'dsh-paper-reader:views';
const MAX_VIEWS = 60;
const PREFS = 'dsh-paper-reader:prefs';

export interface ReaderPrefs {
  night: boolean;
  hoverMenu: boolean;
}
export const DEFAULT_PREFS: ReaderPrefs = { night: false, hoverMenu: true };

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function loadView(key: string): SavedView | null {
  try {
    const raw = storage()?.getItem(VIEW_PREFIX + key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SavedView>;
    if (!Number.isSafeInteger(value.page) || (value.page ?? 0) < 1 || typeof value.scale !== 'number' || !Number.isFinite(value.scale)) return null;
    return { page: value.page!, scale: value.scale, fit: value.fit === true, offset: typeof value.offset === 'number' && value.offset >= 0 && value.offset <= 1 ? value.offset : undefined };
  } catch { return null; }
}

/** Keep the most recent MAX_VIEWS documents; older positions are forgotten. */
export function saveView(key: string, view: SavedView): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(VIEW_PREFIX + key, JSON.stringify(view));
    const index = (JSON.parse(store.getItem(VIEW_INDEX) || '[]') as unknown[]).filter((item): item is string => typeof item === 'string' && item !== key);
    index.unshift(key);
    for (const stale of index.splice(MAX_VIEWS)) store.removeItem(VIEW_PREFIX + stale);
    store.setItem(VIEW_INDEX, JSON.stringify(index));
  } catch { /* quota or blocked storage: position is only kept for this session */ }
}

export function loadPrefs(): ReaderPrefs {
  try {
    const value = JSON.parse(storage()?.getItem(PREFS) || '{}') as Partial<ReaderPrefs>;
    return { night: value.night === true, hoverMenu: value.hoverMenu !== false };
  } catch { return { ...DEFAULT_PREFS }; }
}
export function savePrefs(prefs: ReaderPrefs): void {
  try { storage()?.setItem(PREFS, JSON.stringify(prefs)); } catch { /* ignore */ }
}

/**
 * Zoom that makes a page exactly fill the available width.
 * `available` is the scroll area's inner width; `padding` the horizontal
 * padding around pages (both sides together).
 */
export function fitWidthScale(available: number, pageWidth: number, padding: number, min = 0.25, max = 3): number {
  if (!(available > 0) || !(pageWidth > 0)) return 1;
  const scale = (available - padding) / pageWidth;
  return Math.max(min, Math.min(max, Math.floor(scale * 1000) / 1000));
}
