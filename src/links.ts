/**
 * PDF link annotations (citations, figure/section references, URLs) and the
 * text found at their destination for hover previews.
 */
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api';
import { multiplyTransform } from './textLayer';

export interface PdfLink {
  /** Page percentages. */
  left: number; top: number; width: number; height: number;
  url?: string;
  dest?: unknown;
}
export interface PdfDestination {
  page: number;
  /** Scale-1 CSS px from the page's top edge, when the destination names one. */
  top?: number;
  left?: number;
}

const SAFE_URL = /^(https?:|mailto:)/i;

export function linksFromAnnotations(annotations: Array<Record<string, any>>, viewport: PageViewport): PdfLink[] {
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect)) continue;
    const url = typeof annotation.url === 'string' && SAFE_URL.test(annotation.url) ? annotation.url : undefined;
    const dest = annotation.dest ?? undefined;
    if (!url && dest === undefined) continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(x1, x2), top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1), height = Math.abs(y2 - y1);
    if (!(width > 0.5 && height > 0.5)) continue;
    links.push({ left: 100 * left / viewport.width, top: 100 * top / viewport.height, width: 100 * width / viewport.width, height: 100 * height / viewport.height, url, dest });
  }
  return links;
}

export async function resolveDestination(pdf: PDFDocumentProxy, dest: unknown): Promise<PdfDestination | null> {
  try {
    const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const target = explicit[0];
    const index = typeof target === 'number' ? target : target && typeof target === 'object' ? await pdf.getPageIndex(target as never) : -1;
    if (!(index >= 0 && index < pdf.numPages)) return null;
    const page = await pdf.getPage(index + 1);
    const viewport = page.getViewport({ scale: 1 });
    const kind = (explicit[1] as { name?: string } | undefined)?.name;
    let x: number | null = null, y: number | null = null;
    if (kind === 'XYZ') { x = explicit[2] as number | null; y = explicit[3] as number | null; }
    else if (kind === 'FitH' || kind === 'FitBH') y = explicit[2] as number | null;
    else if (kind === 'FitR') { x = explicit[2] as number | null; y = explicit[5] as number | null; }
    if (typeof y !== 'number' || !Number.isFinite(y)) return { page: index + 1 };
    const [vx, vy] = viewport.convertToViewportPoint(typeof x === 'number' && Number.isFinite(x) ? x : 0, y);
    return { page: index + 1, top: Math.max(0, vy), left: typeof x === 'number' && Number.isFinite(x) ? Math.max(0, vx) : undefined };
  } catch { return null; }
}

/**
 * Text that starts at a destination: the reference entry a citation points
 * to, a figure caption, or the first lines of a section. Stops at a large
 * vertical gap, at the next numbered reference, or after `limit` characters.
 */
export function previewTextAt(content: TextContent, viewportTransform: number[], destination: PdfDestination, limit = 420): string {
  const items = content.items.filter((item): item is TextItem => 'str' in item);
  const placed = items.map(item => {
    const tx = multiplyTransform(viewportTransform, item.transform);
    const height = Math.hypot(tx[2], tx[3]);
    return { item, x: tx[4], baseline: tx[5], top: tx[5] - height * 0.85, height };
  });
  const top = destination.top ?? 0;
  const left = destination.left;
  // First item at (or just below) the destination, in the destination column.
  let start = placed.findIndex(entry => entry.item.str.trim() && entry.baseline >= top - 1 &&
    (left === undefined || entry.x >= left - 6));
  if (start < 0) start = placed.findIndex(entry => entry.item.str.trim());
  if (start < 0) return '';
  let text = '';
  let previous = placed[start];
  const numbered = /^\s*\[\d+\]/.test(previous.item.str);
  for (let index = start; index < placed.length; index++) {
    const entry = placed[index];
    if (index > start) {
      const lineStep = entry.baseline - previous.baseline;
      if (lineStep > previous.height * 2.2 || lineStep < -previous.height * 4) break;
      if (numbered && entry.item.str.trim() && /^\s*\[\d+\]/.test(entry.item.str) && lineStep > previous.height * 0.5) break;
    }
    text += entry.item.str;
    if (entry.item.hasEOL) text += text.endsWith('-') ? '' : ' ';
    if (entry.item.str.trim()) previous = entry;
    if (text.length >= limit) { text = text.slice(0, limit).replace(/\s+\S*$/, '') + '…'; break; }
  }
  return text.replace(/\s+/g, ' ').trim();
}
