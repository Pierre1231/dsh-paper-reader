/**
 * In-document search over pdf.js text content (independent of which pages
 * currently have a text layer). Matching is case-insensitive, any run of
 * whitespace/line breaks in the query matches any run in the text, and a
 * soft hyphen at a line end is ignored ("multi-\nplicative" matches
 * "multiplicative"). Hits are returned as page-percentage rectangles, so
 * they stay correct at every zoom level.
 */
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { multiplyTransform } from './textLayer';

export interface SearchRect { left: number; top: number; width: number; height: number }
export interface SearchHit { page: number; rects: SearchRect[] }

interface IndexedChar { item: number; offset: number }
export interface PageSearchIndex {
  page: number;
  /** Normalised text: lower case, single spaces, hyphenated breaks joined. */
  text: string;
  /** For every character of `text`, its source item and offset (-1 for synthetic spaces). */
  map: IndexedChar[];
  items: TextItem[];
  viewportTransform: number[];
  width: number;
  height: number;
}

export function buildPageSearchIndex(page: number, content: TextContent, viewportTransform: number[], width: number, height: number): PageSearchIndex {
  const items = content.items.filter((item): item is TextItem => 'str' in item);
  let text = '';
  const map: IndexedChar[] = [];
  const pushSpace = () => { if (text && !text.endsWith(' ')) { text += ' '; map.push({ item: -1, offset: -1 }); } };
  items.forEach((item, itemIndex) => {
    const str = item.str;
    for (let offset = 0; offset < str.length; offset++) {
      const char = str[offset];
      if (/\s/.test(char)) { pushSpace(); continue; }
      text += char.toLowerCase();
      map.push({ item: itemIndex, offset });
    }
    if (item.hasEOL) {
      // Join "multi-" + "plicative" across a line break; otherwise a space.
      if (text.endsWith('-') && /[a-z]-$/.test(text.slice(-2))) { text = text.slice(0, -1); map.pop(); }
      else pushSpace();
    }
  });
  return { page, text, map, items, viewportTransform, width, height };
}

export function normaliseQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Rectangles (page percentages) covering text[start, end) of an index. */
function rectsFor(index: PageSearchIndex, start: number, end: number): SearchRect[] {
  const spans = new Map<number, { from: number; to: number }>();
  for (let position = start; position < end; position++) {
    const { item, offset } = index.map[position];
    if (item < 0) continue;
    const span = spans.get(item);
    if (span) { span.from = Math.min(span.from, offset); span.to = Math.max(span.to, offset + 1); }
    else spans.set(item, { from: offset, to: offset + 1 });
  }
  const rects: SearchRect[] = [];
  for (const [itemIndex, { from, to }] of spans) {
    const item = index.items[itemIndex];
    const tx = multiplyTransform(index.viewportTransform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    const length = Math.max(1, item.str.length);
    // Horizontal text (the common case); rotated text gets its bounding box.
    const angle = Math.atan2(tx[1], tx[0]);
    const x0 = item.width * from / length, x1 = item.width * to / length;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const corners = [[x0, 0.2], [x1, 0.2], [x0, -0.85], [x1, -0.85]].map(([x, y]) => [tx[4] + x * cos - y * fontHeight * sin, tx[5] + x * sin + y * fontHeight * cos]);
    const xs = corners.map(point => point[0]), ys = corners.map(point => point[1]);
    const left = Math.min(...xs), top = Math.min(...ys);
    rects.push({ left: 100 * left / index.width, top: 100 * top / index.height, width: 100 * (Math.max(...xs) - left) / index.width, height: 100 * (Math.max(...ys) - top) / index.height });
  }
  return rects;
}

/** All hits of `query` in reading order. Overlapping matches are skipped. */
export function searchIndex(index: PageSearchIndex, query: string, limit = 2000): SearchHit[] {
  const needle = normaliseQuery(query);
  if (!needle) return [];
  const hits: SearchHit[] = [];
  let from = 0;
  while (hits.length < limit) {
    const found = index.text.indexOf(needle, from);
    if (found < 0) break;
    hits.push({ page: index.page, rects: rectsFor(index, found, found + needle.length) });
    from = found + needle.length;
  }
  return hits;
}
