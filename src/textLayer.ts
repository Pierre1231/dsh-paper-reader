/**
 * Selectable text layer, built in time slices off the live document.
 *
 * Geometry is a port of pdf.js 4.10.38 `TextLayer#appendText/#layout`
 * (Apache-2.0, see PDFJS-LICENSE) with three deliberate differences:
 *
 * 1. Each time slice builds its spans in a detached DocumentFragment and
 *    inserts them with ONE DOM operation. (Spans stay direct children of the
 *    layer, as in pdf.js: wrapper elements break drag selection, see
 *    selectionGuard.ts.) pdf.js appends every span to the live page and sets the font
 *    of a measuring canvas attached to `document.body` in between, which makes
 *    the host recompute style for each span and gives host MutationObservers,
 *    extensions and accessibility one record per span.
 * 2. Text is measured on an OffscreenCanvas with an explicit `lang` that the
 *    layer also carries, so measuring never touches the host document and the
 *    measured font is the rendered font (see textLayerLanguage).
 * 3. Marked-content wrappers are flattened. Every span is positioned in page
 *    percentages, so zoom only changes `--scale-factor` and the layer survives
 *    re-rendering. (Paragraph/figure detection also skipped wrapped spans.)
 *
 * Positions use the scale-1 viewport *including* page rotation, so rotated
 * pages need no separate CSS rotation of the layer.
 */
import type { PageViewport } from 'pdfjs-dist';
import type { TextContent, TextItem, TextStyle } from 'pdfjs-dist/types/src/display/api';
import type { SlicedJob } from './taskScheduler';

type Matrix = [number, number, number, number, number, number];
type MeasureContext = { font: string; measureText(text: string): TextMetrics; lang?: string };

const DEFAULT_ASCENT = 0.8;
const MAX_SPANS = 100000;

export function multiplyTransform(m1: ArrayLike<number>, m2: ArrayLike<number>): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export interface TextSpanLayout {
  /** Page-percentage position. */
  left: number;
  top: number;
  /** Unscaled font height in PDF units (CSS px at --scale-factor 1). */
  fontHeight: number;
  /** Degrees. */
  angle: number;
  /** Target width in PDF units, or 0 when the text must not be stretched. */
  canvasWidth: number;
}

/** Pure geometry of one text item; matches pdf.js 4.10.38 for unrotated pages. */
export function layoutTextItem(item: Pick<TextItem, 'str' | 'transform' | 'width' | 'height'>, style: Pick<TextStyle, 'vertical'>, viewportTransform: ArrayLike<number>, pageWidth: number, pageHeight: number, ascentRatio: number): TextSpanLayout {
  const tx = multiplyTransform(viewportTransform, item.transform);
  let angle = Math.atan2(tx[1], tx[0]);
  if (style.vertical) angle += Math.PI / 2;
  const fontHeight = Math.hypot(tx[2], tx[3]);
  const fontAscent = fontHeight * ascentRatio;
  let left: number, top: number;
  if (angle === 0) {
    left = tx[4];
    top = tx[5] - fontAscent;
  } else {
    left = tx[4] + fontAscent * Math.sin(angle);
    top = tx[5] - fontAscent * Math.cos(angle);
  }
  let shouldScale = false;
  if (item.str.length > 1) shouldScale = true;
  else if (item.str !== ' ' && item.transform[0] !== item.transform[3]) {
    const x = Math.abs(item.transform[0]), y = Math.abs(item.transform[3]);
    if (x !== y && Math.max(x, y) / Math.min(x, y) > 1.5) shouldScale = true;
  }
  return {
    left: (100 * left) / pageWidth,
    top: (100 * top) / pageHeight,
    fontHeight,
    angle: angle * (180 / Math.PI),
    canvasWidth: shouldScale ? (style.vertical ? item.height : item.width) : 0,
  };
}

/**
 * Generic families ("sans-serif") resolve per language, and an empty `lang`
 * resolves differently on a canvas than in the DOM (in a zh-CN host the same
 * Latin line measured 9% apart). Measuring and rendering must therefore use
 * one explicit, non-empty language: the PDF's /Lang, otherwise English.
 */
export function textLayerLanguage(contentLang: string | null | undefined): string {
  return contentLang && contentLang.trim() ? contentLang.trim() : 'en';
}

type MeasureEntry = { context: MeasureContext; font: string; ascents: Map<string, number> };
const measureContexts = new Map<string, MeasureEntry>();
let minFontSize: number | null = null;

function getMeasure(lang: string, host: HTMLElement): MeasureEntry {
  const cached = measureContexts.get(lang);
  if (cached) return cached;
  let context: MeasureContext | null = null;
  try {
    // Preferred: never touches the host document at all.
    const offscreen = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d') as unknown as MeasureContext | null : null;
    if (offscreen && 'lang' in offscreen) { offscreen.lang = lang; context = offscreen; }
  } catch { context = null; }
  if (!context) {
    // Older engines: a hidden canvas carrying the same lang, inside the reader
    // (not the host body), like pdf.js but scoped.
    const canvas = host.ownerDocument.createElement('canvas');
    canvas.lang = lang;
    canvas.hidden = true;
    canvas.className = 'pr-measure-canvas';
    (host.closest('.pr-reader') || host.ownerDocument.body).appendChild(canvas);
    context = canvas.getContext('2d') as unknown as MeasureContext | null;
  }
  if (!context) throw new Error('无法创建文字测量画布');
  const entry = { context, font: '', ascents: new Map<string, number>() };
  measureContexts.set(lang, entry);
  return entry;
}

function setFont(entry: MeasureEntry, size: number, family: string) {
  const font = `${size}px ${family}`;
  if (font === entry.font) return;
  entry.context.font = font;
  entry.font = font;
}

function ascentRatioFor(entry: MeasureEntry, family: string): number {
  const cached = entry.ascents.get(family);
  if (cached) return cached;
  const context = entry.context;
  setFont(entry, 30, family);
  const metrics = context.measureText('');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = Math.abs(metrics.fontBoundingBoxDescent);
  const ratio = ascent && Number.isFinite(ascent) && Number.isFinite(descent) ? ascent / (ascent + descent) : DEFAULT_ASCENT;
  entry.ascents.set(family, ratio);
  return ratio;
}

/**
 * Browsers with a minimum font size setting (common in zh-CN Chromium builds)
 * would clamp tiny spans. Like pdf.js, render at `minFontSize` times the size
 * and scale back down. Measured once, inside the reader rather than the host body.
 */
function ensureMinFontSize(host: HTMLElement): number {
  if (minFontSize !== null) return minFontSize;
  const probe = host.ownerDocument.createElement('div');
  probe.style.cssText = 'position:absolute;opacity:0;line-height:1;font-size:1px;pointer-events:none';
  probe.textContent = 'X';
  host.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  minFontSize = height > 0 && Number.isFinite(height) ? height : 1;
  return minFontSize;
}

export interface TextLayerJob extends SlicedJob {
  readonly spans: number;
  readonly chunks: number;
  readonly items: number;
}

export interface TextLayerOptions {
  content: TextContent;
  /** The page viewport at scale 1 (rotation included). */
  viewport: PageViewport;
  /** Live `.pr-text-layer`; it must be empty and connected. */
  container: HTMLElement;
  /** Measurement precision only, normally devicePixelRatio × zoom. */
  deviceScale: number;
  priority: () => number;
}

export function createTextLayerJob({ content, viewport, container, deviceScale, priority }: TextLayerOptions): TextLayerJob {
  const items = content.items;
  const styles = content.styles;
  const transform = viewport.transform;
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;
  const doc = container.ownerDocument;
  const scale = deviceScale > 0 && Number.isFinite(deviceScale) ? deviceScale : 1;
  const minimum = ensureMinFontSize(container);
  const downscale = minimum > 1 ? ` scale(${1 / minimum})` : '';
  const lang = textLayerLanguage(content.lang);
  container.lang = lang;
  let index = 0;
  let spans = 0;
  let chunks = 0;
  const run = (deadline: number): boolean => {
    const measure = getMeasure(lang, container);
    const chunk = doc.createDocumentFragment();
    let added = 0;
    let steps = 0;
    while (index < items.length && spans < MAX_SPANS) {
      const item = items[index++] as TextItem;
      // Check the clock every 16 items; one item never takes long on its own.
      if ((++steps & 15) === 0 && performance.now() >= deadline) { index--; break; }
      if (item.str === undefined) continue; // marked content: flattened
      const style = styles[item.fontName] || ({ fontFamily: 'sans-serif', vertical: false } as TextStyle);
      const family = style.fontFamily || 'sans-serif';
      if (item.str !== '') {
        const layout = layoutTextItem(item, style, transform, pageWidth, pageHeight, ascentRatioFor(measure, family));
        const span = doc.createElement('span');
        const css = span.style;
        css.left = `${layout.left.toFixed(2)}%`;
        css.top = `${layout.top.toFixed(2)}%`;
        css.fontSize = `calc(var(--scale-factor)*${(minimum * layout.fontHeight).toFixed(2)}px)`;
        css.fontFamily = family;
        span.setAttribute('role', 'presentation');
        span.textContent = item.str;
        if (item.dir) span.dir = item.dir;
        let transformCss = downscale.trim();
        if (layout.canvasWidth !== 0) {
          setFont(measure, layout.fontHeight * scale, family);
          const { width } = measure.context.measureText(item.str);
          if (width > 0) transformCss = `scaleX(${(layout.canvasWidth * scale) / width})${downscale}`;
        }
        if (layout.angle !== 0) transformCss = `rotate(${layout.angle}deg) ${transformCss}`;
        if (transformCss) css.transform = transformCss;
        chunk.appendChild(span);
        spans++;
        added++;
      }
      if (item.hasEOL) {
        const br = doc.createElement('br');
        br.setAttribute('role', 'presentation');
        chunk.appendChild(br);
        added++;
      }
    }
    if (added) { container.appendChild(chunk); chunks++; }
    return index >= items.length || spans >= MAX_SPANS;
  };
  return {
    run,
    priority,
    get spans() { return spans; },
    get chunks() { return chunks; },
    get items() { return items.length; },
  };
}

/** True when a page has any visible text worth building a layer for. */
export function hasSelectableText(content: TextContent): boolean {
  return content.items.some(item => 'str' in item && item.str.trim() !== '');
}
