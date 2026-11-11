export interface PdfParagraph {
  key: string;
  elements: HTMLElement[];
  text: string;
  /** One copied bounding rectangle per visual line. */
  rects: DOMRect[];
  /** Contains a display formula (attached scripts or fraction parts). */
  math?: boolean;
}

/** A DOM-independent rectangle used by the geometry functions and their tests. */
export interface PdfParagraphRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfTextFragment {
  text: string;
  rect: PdfParagraphRect;
  fontSize: number;
  /** Present for fragments collected from a text layer, optional in pure geometry tests. */
  element?: HTMLElement;
}

export interface PdfVisualLine {
  text: string;
  rect: PdfParagraphRect;
  fontSize: number;
  fragments: PdfTextFragment[];
  /** Set when sub/superscripts or fraction parts were attached (a formula). */
  math?: boolean;
  displayMath?: boolean;
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

function horizontalGap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(b.left - right(a), a.left - right(b));
}

function verticalOverlap(a: PdfParagraphRect, b: PdfParagraphRect): number {
  return Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));
}

function joinFragments(fragments: PdfTextFragment[]): string {
  let text = "";
  let previous: PdfTextFragment | undefined;
  for (const fragment of fragments) {
    if (previous) {
      const gap = fragment.rect.left - right(previous.rect);
      // PDF.js normally includes spaces in the text items. Add one only for
      // visibly separated Latin words when the source omitted that space.
      if (gap > Math.max(1, Math.min(previous.fontSize, fragment.fontSize) * 0.12) &&
          /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(fragment.text)) text += " ";
    }
    text += fragment.text;
    previous = fragment;
  }
  return text.trim();
}

/**
 * Merge baseline-aligned fragments into visual lines. A large horizontal gap
 * starts another line even at the same baseline, which separates page columns.
 */
export function buildPdfVisualLines(fragments: PdfTextFragment[]): PdfVisualLine[] {
  const ordered = fragments
    .filter(fragment => fragment.text.trim() && fragment.rect.width >= 0 && fragment.rect.height > 0 &&
      Number.isFinite(fragment.rect.left) && Number.isFinite(fragment.rect.top) &&
      Number.isFinite(fragment.rect.width) && Number.isFinite(fragment.rect.height))
    .slice()
    .sort((a, b) => bottom(a.rect) - bottom(b.rect) || a.rect.left - b.rect.left);

  const bands: { fragments: PdfTextFragment[]; baseline: number; fontSize: number }[] = [];
  for (const fragment of ordered) {
    let best: (typeof bands)[number] | undefined;
    let bestDistance = Infinity;
    for (const band of bands) {
      const distance = Math.abs(bottom(fragment.rect) - band.baseline);
      const tolerance = Math.max(1.5, Math.min(fragment.fontSize, band.fontSize) * 0.35);
      const overlap = verticalOverlap(fragment.rect, unionRects(band.fragments.map(item => item.rect)));
      if (distance <= tolerance && overlap >= Math.min(fragment.rect.height, band.fragments[0].rect.height) * 0.25 && distance < bestDistance) {
        best = band;
        bestDistance = distance;
      }
    }
    if (best) {
      best.fragments.push(fragment);
      const count = best.fragments.length;
      best.baseline += (bottom(fragment.rect) - best.baseline) / count;
      best.fontSize += (fragment.fontSize - best.fontSize) / count;
    } else {
      bands.push({ fragments: [fragment], baseline: bottom(fragment.rect), fontSize: fragment.fontSize });
    }
  }

  const lines: PdfVisualLine[] = [];
  for (const band of bands) {
    const inReadingOrder = band.fragments.slice().sort((a, b) => a.rect.left - b.rect.left || a.rect.top - b.rect.top);
    let current: PdfTextFragment[] = [];
    let currentRight = 0;
    const flush = () => {
      if (!current.length) return;
      const length = current.reduce((sum, fragment) => sum + Math.max(1, fragment.text.length), 0);
      const fontSize = current.reduce((sum, fragment) => sum + fragment.fontSize * Math.max(1, fragment.text.length), 0) / length;
      lines.push({ text: joinFragments(current), rect: unionRects(current.map(fragment => fragment.rect)), fontSize, fragments: current });
      current = [];
    };
    for (const fragment of inReadingOrder) {
      if (current.length) {
        const previous = current[current.length - 1];
        const gap = fragment.rect.left - currentRight;
        const maxGap = Math.max(2, Math.max(previous.fontSize, fragment.fontSize) * 1.5);
        if (gap > maxGap) flush();
      }
      current.push(fragment);
      currentRight = Math.max(currentRight, right(fragment.rect));
    }
    flush();
  }
  return lines.filter(line => line.text).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

const baselineOf = (line: PdfVisualLine) => bottom(line.rect);
const midY = (rect: PdfParagraphRect) => rect.top + rect.height / 2;

function isFractionPart(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  return /^[\p{L}\d]{1,3}$/u.test(compact) ||
    (/[+\-−×÷*/^√]/.test(compact) && !/\p{L}{4,}/u.test(compact));
}

function readingOrder(a: PdfTextFragment, b: PdfTextFragment): number {
  // The text layer follows the PDF content stream, which is the order the
  // author wrote the formula in (numerator before denominator, base before
  // script). Pure geometry tests have no elements: fall back to x order.
  if (a.element && b.element && a.element !== b.element) {
    return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
  }
  return a.rect.left - b.rect.left || a.rect.top - b.rect.top;
}

function mergeMathLines(lines: PdfVisualLine[], fontSize: number): PdfVisualLine {
  const fragments = lines.flatMap(line => line.fragments).sort(readingOrder);
  return { text: joinFragments(fragments), rect: unionRects(lines.map(line => line.rect)), fontSize, fragments, math: true };
}

const EQUATION_LABEL = /^\(\s*\d+(?:\.\d+)*[a-z]?\s*\)$/i;
const PROSE_WORDS = /\b[A-Za-z]{3,}\s+[A-Za-z]{3,}\b/;
const MATH_RELATION = /[=≈≠≤≥]/;

function splitNumberedEquations(input: PdfVisualLine[]) {
  const claimed = new Set<PdfVisualLine>();
  const equations: PdfVisualLine[] = [];
  for (const label of input) {
    if (!EQUATION_LABEL.test(label.text)) continue;
    const size = label.fontSize;
    const available = input.filter(line => !claimed.has(line) && !EQUATION_LABEL.test(line.text) &&
      !PROSE_WORDS.test(line.text) && right(line.rect) <= label.rect.left);
    const aligned = available.filter(line => Math.abs(baselineOf(line) - baselineOf(label)) <= size * 0.35 &&
      verticalOverlap(line.rect, label.rect) >= Math.min(line.rect.height, label.rect.height) * 0.6)
      .sort((first, second) => right(second.rect) - right(first.rect));
    const closest = aligned[0];
    if (!closest) continue;
    const labelGap = label.rect.left - right(closest.rect);
    if (labelGap < size || labelGap > size * 14) continue;
    const core = [closest];
    let left = closest.rect.left;
    for (const line of aligned.slice(1)) {
      if (left - right(line.rect) > size * 3.5) break;
      core.push(line);
      left = Math.min(left, line.rect.left);
    }
    if (!core.some(line => MATH_RELATION.test(line.text))) continue;
    const bounds = unionRects(core.map(line => line.rect));
    const pieces = available.filter(line =>
      line.rect.left >= bounds.left - size * 0.5 && right(line.rect) <= right(bounds) + size * 0.5 &&
      Math.abs(midY(line.rect) - midY(label.rect)) <= size * 1.7);
    const block = [...new Set([...core, ...pieces])];
    block.forEach(line => claimed.add(line));
    equations.push({ ...mergeMathLines(block, size), displayMath: true });
  }
  return { equations, lines: input.filter(line => !claimed.has(line)) };
}

/**
 * Attach sub/superscripts, fraction numerators/denominators and radicands to
 * the line they belong to. Such a "satellite" sits on a different baseline
 * (and usually a smaller size), so line building and the paragraph rules
 * (font ratio, one successor) split a display equation into fragments and a
 * hover only covered part of it. A satellite usually overlaps its host.
 * A separated fraction instead requires aligned math above and below a
 * nearby equation line before either part is attached.
 */
export function attachPdfScripts(input: PdfVisualLine[]): PdfVisualLine[] {
  const { equations, lines } = splitNumberedEquations(input);
  const host = lines.map((_, index) => index);
  const find = (index: number): number => host[index] === index ? index : (host[index] = find(host[index]));
  const weight = (line: PdfVisualLine) => line.fontSize * 1000 + line.text.length;
  for (let a = 0; a < lines.length; a++) {
    for (let b = a + 1; b < lines.length; b++) {
      const first = lines[a], second = lines[b];
      const size = Math.max(first.fontSize, second.fontSize);
      if (Math.abs(baselineOf(first) - baselineOf(second)) < size * 0.2) continue;
      if (verticalOverlap(first.rect, second.rect) < Math.min(first.rect.height, second.rect.height) * 0.15) continue;
      const [small, large] = weight(first) <= weight(second) ? [first, second] : [second, first];
      const reach = large.fontSize * 1.2;
      if (small.rect.left < large.rect.left - reach || right(small.rect) > right(large.rect) + reach) continue;
      const ra = find(a), rb = find(b);
      if (ra !== rb) host[ra] = rb;
    }
  }
  const fractionBounds = new Map<number, PdfParagraphRect>();
  lines.forEach((anchor, anchorIndex) => {
    if (!MATH_RELATION.test(anchor.text)) return;
    const size = anchor.fontSize;
    const above: number[] = [];
    const below: number[] = [];
    lines.forEach((part, index) => {
      const offset = midY(part.rect) - midY(anchor.rect);
      if (Math.abs(offset) < size * 0.6 || Math.abs(offset) > size * 1.8 ||
          horizontalGap(anchor.rect, part.rect) > size * 2 ||
          part.rect.width > size * 6 || !isFractionPart(part.text)) return;
      (offset < 0 ? above : below).push(index);
    });
    const used = new Set<number>();
    for (const upper of above) {
      const numerator = lines[upper].rect;
      const lower = below.find(index => {
        if (used.has(index)) return false;
        const denominator = lines[index].rect;
        return bottom(numerator) < denominator.top &&
          (bottom(numerator) <= anchor.rect.top || denominator.top >= bottom(anchor.rect)) &&
          horizontalOverlap(numerator, denominator) >= Math.min(numerator.width, denominator.width) * 0.5;
      });
      if (lower === undefined) continue;
      used.add(lower);
      const root = find(anchorIndex);
      host[find(upper)] = root;
      host[find(lower)] = root;
      fractionBounds.set(anchorIndex, unionRects([fractionBounds.get(anchorIndex) ?? anchor.rect, numerator, lines[lower].rect]));
    }
  });
  // A formula's own pieces on its main baseline can be split apart by a gap
  // (an unstretched one-glyph span such as "√" renders narrower than in the
  // PDF). Rejoin same-baseline neighbours of a formula within two glyph widths;
  // an equation number far to the right stays separate.
  const sizes = () => { const count = new Map<number, number>(); lines.forEach((_, index) => count.set(find(index), (count.get(find(index)) || 0) + 1)); return count; };
  for (let changed = true; changed;) {
    changed = false;
    const count = sizes();
    for (let a = 0; a < lines.length; a++) {
      for (let b = 0; b < lines.length; b++) {
        if (a === b || find(a) === find(b) || (count.get(find(a)) || 0) < 2) continue;
        const formula = lines[a], piece = lines[b];
        const size = Math.max(formula.fontSize, piece.fontSize);
        if (Math.abs(baselineOf(formula) - baselineOf(piece)) >= size * 0.2) continue;
        if (verticalOverlap(formula.rect, piece.rect) < Math.min(formula.rect.height, piece.rect.height) * 0.5) continue;
        const gap = horizontalGap(fractionBounds.get(a) ?? formula.rect, piece.rect);
        if (gap > size * 2) continue;
        host[find(b)] = find(a);
        changed = true;
      }
    }
  }
  const clusters = new Map<number, PdfVisualLine[]>();
  lines.forEach((line, index) => {
    const root = find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(line); else clusters.set(root, [line]);
  });
  const merged = [...equations];
  for (const cluster of clusters.values()) {
    if (cluster.length === 1) { merged.push(cluster[0]); continue; }
    const base = cluster.reduce((best, line) => weight(line) > weight(best) ? line : best);
    merged.push(mergeMathLines(cluster, base.fontSize));
  }
  return merged.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

function hasColumnOverlap(a: PdfVisualLine, b: PdfVisualLine): boolean {
  const minimumWidth = Math.min(a.rect.width, b.rect.width);
  return horizontalOverlap(a.rect, b.rect) >= Math.max(1, minimumWidth * 0.15);
}

function canContinueParagraph(previous: PdfVisualLine, current: PdfVisualLine): boolean {
  if (previous.displayMath || current.displayMath) return false;
  const fontRatio = Math.min(previous.fontSize, current.fontSize) / Math.max(previous.fontSize, current.fontSize);
  if (fontRatio < 0.75) return false;
  const gap = current.rect.top - bottom(previous.rect);
  // Academic PDFs often use block paragraphs with no first-line indent.
  // SuperMimic body lines are ~2px apart at 9.96px font size, while paragraph
  // boundaries are ~6.4px apart; a generous line-height threshold merges the
  // whole section. Keep the threshold below that inter-paragraph gap.
  return gap <= Math.max(2, Math.min(previous.fontSize, current.fontSize) * 0.45);
}

/**
 * Group lines into linear paragraph chains. Each line chooses its nearest
 * overlapping line above; incompatible or already-continued lines start a new
 * paragraph. The one-successor rule stops a full-width line bridging columns.
 */
export function groupPdfVisualLines(input: PdfVisualLine[]): PdfVisualLine[][] {
  const lines = input.slice().sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const parents = lines.map(() => -1);
  const children = lines.map(() => -1);

  for (let index = 1; index < lines.length; index++) {
    const current = lines[index];
    let nearest = -1;
    let nearestDistance = Infinity;
    for (let candidate = 0; candidate < index; candidate++) {
      const previous = lines[candidate];
      const minimumHeight = Math.min(previous.rect.height, current.rect.height);
      // Require a genuinely later baseline rather than another fragment on the
      // same visual row whose rectangle happens to overlap vertically.
      if (bottom(current.rect) - bottom(previous.rect) <= minimumHeight * 0.45) continue;
      if (!hasColumnOverlap(previous, current)) continue;
      const distance = Math.max(0, current.rect.top - bottom(previous.rect));
      if (distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    if (nearest >= 0 && children[nearest] < 0 && canContinueParagraph(lines[nearest], current)) {
      parents[index] = nearest;
      children[nearest] = index;
    }
  }

  const paragraphs: PdfVisualLine[][] = [];
  for (let index = 0; index < lines.length; index++) {
    if (parents[index] >= 0) continue;
    const paragraph: PdfVisualLine[] = [];
    let cursor = index;
    while (cursor >= 0) {
      paragraph.push(lines[cursor]);
      cursor = children[cursor];
    }
    paragraphs.push(paragraph);
  }
  return paragraphs;
}

interface PdfParagraphCache {
  paragraphs: PdfParagraph[];
  elements: HTMLElement[];
  /** Client-space layer bounds used to translate cached line rects on scroll. */
  layerRect: PdfParagraphRect;
}

const paragraphCache = new WeakMap<HTMLElement, PdfParagraphCache>();

function readFontSize(element: HTMLElement, layer: HTMLElement): number {
  const view = layer.ownerDocument.defaultView;
  const value = view ? Number.parseFloat(view.getComputedStyle(element).fontSize) : Number.NaN;
  const rectHeight = element.getBoundingClientRect().height;
  return Number.isFinite(value) && value > 0 ? value : rectHeight > 0 ? rectHeight : 12;
}

function collectFragments(layer: HTMLElement): PdfTextFragment[] {
  const fragments: PdfTextFragment[] = [];
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

function buildParagraphs(layer: HTMLElement, pageNumber: number): PdfParagraph[] {
  const groups = groupPdfVisualLines(attachPdfScripts(buildPdfVisualLines(collectFragments(layer))));
  return groups.map((lines, index) => ({
    key: `pdf-${pageNumber}-paragraph-${index + 1}`,
    elements: lines.flatMap(line => line.fragments.flatMap(fragment => fragment.element ? [fragment.element] : [])),
    text: lines.map(line => line.text).join("\n"),
    rects: lines.map(line => new DOMRect(line.rect.left, line.rect.top, line.rect.width, line.rect.height)),
    math: lines.some(line => line.math),
  }));
}

function clientRect(rect: { left: number; top: number; width: number; height: number }): PdfParagraphRect {
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

/** Find the cached paragraph containing a text-layer element. */
export function findPdfParagraph(target: Element, layer: HTMLElement, pageNumber: number): PdfParagraph | null {
  if (!layer.contains(target)) return null;
  let cache = paragraphCache.get(layer);
  // PdfPage replaces all spans on zoom but retains the layer element itself.
  // Checking only the WeakMap key would therefore return detached elements and
  // coordinates from the previous zoom.
  const intact = cache && cache.elements.length > 0 &&
    layer.contains(cache.elements[0]) && layer.contains(cache.elements[cache.elements.length - 1]);
  if (!cache || !intact) {
    const paragraphs = buildParagraphs(layer, pageNumber);
    cache = {
      paragraphs,
      elements: paragraphs.flatMap(paragraph => paragraph.elements),
      layerRect: clientRect(layer.getBoundingClientRect()),
    };
    paragraphCache.set(layer, cache);
  } else {
    const bounds = layer.getBoundingClientRect();
    if (bounds.width !== cache.layerRect.width || bounds.height !== cache.layerRect.height) {
      // A same-DOM layout change (for example a CSS resize) needs fresh geometry.
      const paragraphs = buildParagraphs(layer, pageNumber);
      cache = { paragraphs, elements: paragraphs.flatMap(paragraph => paragraph.elements), layerRect: clientRect(bounds) };
      paragraphCache.set(layer, cache);
    } else {
      // DOMRects are client coordinates, not document coordinates. Translate
      // them when scrolling instead of leaving highlights at the old position.
      const dx = bounds.left - cache.layerRect.left;
      const dy = bounds.top - cache.layerRect.top;
      if (dx || dy) {
        for (const paragraph of cache.paragraphs) {
          paragraph.rects = paragraph.rects.map(rect => new DOMRect(rect.left + dx, rect.top + dy, rect.width, rect.height));
        }
        cache.layerRect = clientRect(bounds);
      }
    }
  }
  return cache.paragraphs.find(paragraph => paragraph.elements.some(element => element === target || element.contains(target))) || null;
}
