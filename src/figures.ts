import {
  buildPdfVisualLines,
  groupPdfVisualLines,
  type PdfParagraphRect,
  type PdfTextFragment,
  type PdfVisualLine,
} from "./paragraphs";

export type PdfFigureKind = "figure" | "table";

/** A caption-anchored hover region. All rectangles use client coordinates. */
export interface PdfFigure {
  key: string;
  kind: PdfFigureKind;
  pageNumber: number;
  caption: string;
  /** The figure/table itself; the caption is deliberately excluded. */
  rect: PdfParagraphRect;
  captionRect: PdfParagraphRect;
}

interface CaptionBlock {
  key: string;
  kind: PdfFigureKind;
  lines: PdfVisualLine[];
  rect: PdfParagraphRect;
  text: string;
}

const right = (rect: PdfParagraphRect) => rect.left + rect.width;
const bottom = (rect: PdfParagraphRect) => rect.top + rect.height;

function unionRects(rects: PdfParagraphRect[]): PdfParagraphRect {
  const left = Math.min(...rects.map(rect => rect.left));
  const top = Math.min(...rects.map(rect => rect.top));
  const maxRight = Math.max(...rects.map(right));
  const maxBottom = Math.max(...rects.map(bottom));
  return { left, top, width: maxRight - left, height: maxBottom - top };
}

function horizontalOverlap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left));
}

function verticalOverlap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));
}

function captionStart(line: PdfVisualLine): { kind: PdfFigureKind; key: string } | null {
  const match = line.text.trim().match(/^(Figure|Fig\.?|Table)\s+(\d+|[IVXLC]+)\b\s*([.:])?/i);
  if (!match) return null;
  const rest = line.text.trim().slice(match[0].length);
  // References at the beginning of a prose sentence are not captions. Explicit
  // "Figure 1:" / "Table 1." forms remain valid even for an unusual description.
  const proseRest = rest.replace(/^\s*\([a-z](?:\s*[,–-]\s*[a-z])*\)\s*/i, '');
  if (!match[3] && /^(shows?|illustrates?|presents?|depicts?|demonstrates?|is|are|was|were|contains?|compares?)\b/i.test(proseRest)) {
    return null;
  }
  const kind: PdfFigureKind = match[1].toLowerCase() === "table" ? "table" : "figure";
  return { kind, key: `${kind}-${match[2].toLowerCase()}` };
}

function canContinueCaption(previous: PdfVisualLine, current: PdfVisualLine): boolean {
  if (captionStart(current) || /[.!?。！？]$/.test(previous.text.trim())) return false;
  const fontRatio = Math.min(previous.fontSize, current.fontSize) / Math.max(previous.fontSize, current.fontSize);
  if (fontRatio < 0.8) return false;
  const gap = current.rect.top - bottom(previous.rect);
  if (gap > Math.max(2.5, previous.fontSize * 0.55)) return false;
  return horizontalOverlap(previous.rect, current.rect) >= Math.min(previous.rect.width, current.rect.width) * 0.15 ||
    Math.abs(previous.rect.left - current.rect.left) <= previous.fontSize * 2;
}

function findCaptions(lines: PdfVisualLine[]): CaptionBlock[] {
  const captions: CaptionBlock[] = [];
  const consumed = new Set<PdfVisualLine>();
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index];
    if (consumed.has(first)) continue;
    const start = captionStart(first);
    if (!start) continue;
    const captionLines = [first];
    consumed.add(first);
    // Four lines covers normal academic captions without allowing a caption to
    // consume an entire following section when terminal punctuation is absent.
    for (let next = index + 1; next < lines.length && captionLines.length < 4; next++) {
      const previous = captionLines[captionLines.length - 1];
      if (!canContinueCaption(previous, lines[next])) break;
      captionLines.push(lines[next]);
      consumed.add(lines[next]);
    }
    captions.push({
      key: start.key,
      kind: start.kind,
      lines: captionLines,
      rect: unionRects(captionLines.map(line => line.rect)),
      text: captionLines.map(line => line.text.trim()).join(" ").replace(/\s+/g, " "),
    });
  }
  return captions;
}

function hasTwoTextColumns(lines: PdfVisualLine[], page: PdfParagraphRect): boolean {
  const middle = page.left + page.width / 2;
  let rows = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.rect.width > page.width * 0.48) continue;
    const paired = lines.some((other, otherIndex) => {
      if (index === otherIndex || other.rect.width > page.width * 0.48) return false;
      const overlap = verticalOverlap(line.rect, other.rect);
      if (overlap < Math.min(line.rect.height, other.rect.height) * 0.55) return false;
      if (horizontalOverlap(line.rect, other.rect) > 0) return false;
      const lineCenter = line.rect.left + line.rect.width / 2;
      const otherCenter = other.rect.left + other.rect.width / 2;
      return (lineCenter < middle && otherCenter > middle) || (lineCenter > middle && otherCenter < middle);
    });
    if (paired) rows++;
  }
  // One pair can be a diagram with two labels; repeated rows are much stronger
  // evidence of a two-column article.
  return rows >= 4;
}

function isFullWidthCaption(caption: CaptionBlock, page: PdfParagraphRect, twoColumns: boolean): boolean {
  if (!twoColumns) return true;
  const middle = page.left + page.width / 2;
  const center = caption.rect.left + caption.rect.width / 2;
  if (caption.rect.width >= page.width * 0.44) return true;
  // Short, centred captions are common under a page-wide diagram.
  return Math.abs(center - middle) <= page.width * 0.12 && caption.rect.width >= page.width * 0.22;
}

function laneBounds(
  caption: CaptionBlock,
  lines: PdfVisualLine[],
  page: PdfParagraphRect,
  fullWidth: boolean,
): PdfParagraphRect {
  const middle = page.left + page.width / 2;
  const center = caption.rect.left + caption.rect.width / 2;
  const inLane = (line: PdfVisualLine) => {
    if (fullWidth) return true;
    const lineCenter = line.rect.left + line.rect.width / 2;
    return center < middle ? lineCenter < middle : lineCenter >= middle;
  };
  // Include labels as well as prose so an oversized diagram is not clipped to
  // the article's text column. Page bounds remain the final safety limit.
  const laneLines = lines.filter(inLane);
  const left = Math.max(page.left, Math.min(caption.rect.left, ...laneLines.map(line => line.rect.left)));
  const maxRight = Math.min(right(page), Math.max(right(caption.rect), ...laneLines.map(line => right(line.rect))));
  return { left, top: page.top, width: Math.max(0, maxRight - left), height: page.height };
}

function belongsToLane(line: PdfVisualLine, lane: PdfParagraphRect, fullWidth: boolean): boolean {
  if (fullWidth) return true;
  return horizontalOverlap(line.rect, lane) >= Math.min(line.rect.width, lane.width) * 0.2;
}

function isBodyParagraph(lines: PdfVisualLine[], lane: PdfParagraphRect): boolean {
  if (lines.length < 2) return false;
  // Table cells normally split into separate, narrow lines. Requiring several
  // wide, prose-sized lines prevents the table's own text becoming the boundary
  // that removes the table. A single-column table with prose in every cell is
  // inherently ambiguous and is a documented limitation of this heuristic.
  const wideProse = lines.filter(line => line.rect.width >= lane.width * 0.55 && line.text.trim().length >= 30);
  return wideProse.length >= 2 && wideProse.length >= lines.length / 2;
}

function inferTop(
  caption: CaptionBlock,
  lines: PdfVisualLine[],
  captionLines: Set<PdfVisualLine>,
  lane: PdfParagraphRect,
  page: PdfParagraphRect,
  fullWidth: boolean,
  previousCaptionBottom: number,
): number {
  const above = lines.filter(line => !captionLines.has(line) && bottom(line.rect) <= caption.rect.top + 1 &&
    bottom(line.rect) > page.top && belongsToLane(line, lane, fullWidth));
  const paragraphs = groupPdfVisualLines(above);
  let bodyBottom = page.top;
  for (const paragraph of paragraphs) {
    if (isBodyParagraph(paragraph, lane)) bodyBottom = Math.max(bodyBottom, ...paragraph.map(line => bottom(line.rect)));
  }
  return Math.max(page.top, previousCaptionBottom, bodyBottom);
}

/**
 * Detect figures/tables from pdf.js text geometry. No canvas pixels or PDF
 * operator streams are read; pageRect supplies the bounds needed for a graphic
 * at the top of a page, even when that graphic contains no text at all.
 */
export function detectPdfFigures(
  fragments: PdfTextFragment[],
  pageNumber: number,
  pageRect: PdfParagraphRect,
): PdfFigure[] {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) throw new TypeError("pageNumber must be one-based");
  if (![pageRect.left, pageRect.top, pageRect.width, pageRect.height].every(Number.isFinite) ||
      pageRect.width <= 0 || pageRect.height <= 0) throw new TypeError("pageRect must be a finite, non-empty rectangle");

  const lines = buildPdfVisualLines(fragments);
  const captions = findCaptions(lines);
  if (!captions.length) return [];
  const captionLines = new Set(captions.flatMap(caption => caption.lines));
  const twoColumns = hasTwoTextColumns(lines.filter(line => !captionLines.has(line)), pageRect);
  const figures: PdfFigure[] = [];
  const earlierCaptions: CaptionBlock[] = [];

  for (const caption of captions) {
    const fullWidth = isFullWidthCaption(caption, pageRect, twoColumns);
    const lane = laneBounds(caption, lines.filter(line => !captionLines.has(line)), pageRect, fullWidth);
    // A caption in the opposite article column is not a vertical boundary for
    // this one. Full-width lanes overlap and therefore bound every earlier one.
    const previousCaptionBottom = Math.max(pageRect.top, ...earlierCaptions
      .filter(earlier => horizontalOverlap(earlier.rect, lane) >= Math.min(earlier.rect.width, lane.width) * 0.2)
      .map(earlier => bottom(earlier.rect)));
    const top = inferTop(caption, lines, captionLines, lane, pageRect, fullWidth, previousCaptionBottom);
    const regionTop = Math.min(top, caption.rect.top);
    const region = {
      left: lane.left,
      top: regionTop,
      width: lane.width,
      height: Math.max(0, caption.rect.top - regionTop),
    };
    if (region.width > 0 && region.height > 0) {
      figures.push({
        key: `pdf-${pageNumber}-${caption.key}`,
        kind: caption.kind,
        pageNumber,
        caption: caption.text,
        rect: region,
        captionRect: caption.rect,
      });
    }
    earlierCaptions.push(caption);
  }
  return figures;
}

/** Return the innermost region containing a client-space point. */
export function findPdfFigureAtPoint(figures: PdfFigure[], x: number, y: number): PdfFigure | null {
  const matches = figures.filter(figure => x >= figure.rect.left && x < right(figure.rect) &&
    y >= figure.rect.top && y < bottom(figure.rect));
  matches.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
  return matches[0] || null;
}

function readFontSize(element: HTMLElement, layer: HTMLElement): number {
  const view = layer.ownerDocument.defaultView;
  const value = view ? Number.parseFloat(view.getComputedStyle(element).fontSize) : Number.NaN;
  const rectHeight = element.getBoundingClientRect().height;
  return Number.isFinite(value) && value > 0 ? value : rectHeight > 0 ? rectHeight : 12;
}

function collectFragments(layer: HTMLElement): PdfTextFragment[] {
  const fragments: PdfTextFragment[] = [];
  // pdf.js 4.10.38 positions transparent spans absolutely. markedContent is a
  // zero-height structural wrapper, so only leaf spans have useful geometry.
  for (const element of layer.querySelectorAll<HTMLElement>("span")) {
    if (element.querySelector("span") || element.closest(".markedContent")) continue;
    const text = element.textContent || "";
    if (!text.trim()) continue;
    const bounds = element.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    fragments.push({
      element,
      text,
      rect: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
      fontSize: readFontSize(element, layer),
    });
  }
  return fragments;
}

interface PdfFigureCacheEntry {
  pageNumber: number;
  width: number;
  height: number;
  renderGeneration: string | undefined;
  /** Local CSS-pixel coordinates at this rendered size, without DOM references. */
  figures: PdfFigure[];
}

const pdfFigureCache = new WeakMap<HTMLElement, PdfFigureCacheEntry>();

/** Call before replacing text-layer contents and after TextLayer.render completes. */
export function invalidatePdfFigureCache(layer: HTMLElement): void {
  pdfFigureCache.delete(layer);
}

function translateFigure(figure: PdfFigure, left: number, top: number): PdfFigure {
  const translateRect = (rect: PdfParagraphRect): PdfParagraphRect => ({
    ...rect, left: rect.left + left, top: rect.top + top,
  });
  return { ...figure, rect: translateRect(figure.rect), captionRect: translateRect(figure.captionRect) };
}

/**
 * DOM adapter for PdfPage's .pr-text-layer. Only cache misses inspect spans.
 * Rendered width/height cover zoom; same-size rerenders must invalidate the
 * layer or change dataset.renderGeneration. Scroll only translates local boxes.
 */
export function collectPdfFigures(layer: HTMLElement, pageNumber: number): PdfFigure[] {
  const bounds = layer.getBoundingClientRect();
  // Optional access also supports lightweight DOM adapters without a dataset.
  const renderGeneration = layer.dataset?.renderGeneration;
  let cached = pdfFigureCache.get(layer);
  if (!cached || cached.pageNumber !== pageNumber || cached.width !== bounds.width ||
      cached.height !== bounds.height || cached.renderGeneration !== renderGeneration) {
    const fragments = collectFragments(layer).map(fragment => ({
      ...fragment,
      rect: {
        ...fragment.rect,
        left: fragment.rect.left - bounds.left,
        top: fragment.rect.top - bounds.top,
      },
    }));
    const figures = detectPdfFigures(fragments, pageNumber, {
      left: 0, top: 0, width: bounds.width, height: bounds.height,
    });
    cached = { pageNumber, width: bounds.width, height: bounds.height, renderGeneration, figures };
    pdfFigureCache.set(layer, cached);
  }
  // Always return fresh rectangles so callers cannot mutate the local cache.
  return cached.figures.map(figure => translateFigure(figure, bounds.left, bounds.top));
}
