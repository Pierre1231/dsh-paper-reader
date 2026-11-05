import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import bundledAssets from 'pdf-bundled-assets';
import { findPdfParagraph, type PdfParagraphRect } from './paragraphs';
import { collectPdfFigures, findPdfFigureAtPoint, invalidatePdfFigureCache, type PdfFigure } from './figures';
import { positionReaderOverlay, isPointInOverlayBridge, type OverlayRect } from './overlayGeometry';
import { ReaderIcon } from './icons';

function decodeAsset(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`PDF 字体资源不可用：${name}`);
  const raw = atob(value);
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
class BundledCMapReaderFactory {
  async fetch({ name }: { name: string }) {
    return { cMapData: decodeAsset(bundledAssets.cmaps[`${name}.bcmap`], name), isCompressed: true };
  }
}
class BundledStandardFontDataFactory {
  async fetch({ filename }: { filename: string }) {
    return decodeAsset(bundledAssets.standard_fonts[filename], filename);
  }
}

export type PdfReaderAction = "explain" | "translate" | "ask" | "copy";
export interface PdfQuote {
  text: string;
  pageStart: number;
  pageEnd: number;
  kind?: 'text' | 'figure';
  image?: Blob;
}
export interface PdfReaderProps {
  data: Uint8Array;
  fileName: string;
  sessionId: string;
  /** URL of the matching pdfjs-dist worker, supplied by the host. */
  workerSrc: string;
  onAction: (action: PdfReaderAction, quote: PdfQuote) => void;
  /** Disable the selectable text layer when selection is not needed. Defaults to true. */
  enableTextLayer?: boolean;
  /** Remember the current page and zoom for this key during the current session. */
  stateKey?: string;
  /** Short-lived UI feedback; does not change the PDF or draft. */
  statusMessage?: string;
  /** Generate and export the accumulated reading notes for this paper. */
  onGenerateNotes?: () => void;
}

const readerStates = new Map<string, { page: number; scale: number }>();
let nextReaderInstance = 0;

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const clampScale = (value: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));

type MenuState = {
  quote: PdfQuote;
  anchor: OverlayRect;
  origin?: 'pointer' | 'keyboard';
  mode: 'selection' | 'hover' | 'figure';
  key?: string;
  capture?: CaptureJob;
  returnFocus?: HTMLElement | null;
  imageReady?: Promise<Blob | undefined>;
  highlights?: Array<{ left: number; top: number; width: number; height: number }>;
};
type CaptureJob = {
  key: string;
  controller: AbortController;
  promise: Promise<Blob | undefined>;
  claimed: boolean;
  done: boolean;
  blob?: Blob;
};

async function readPdfImageRects(page: PDFPageProxy, viewport: ReturnType<PDFPageProxy['getViewport']>): Promise<PdfParagraphRect[]> {
  const operators = await page.getOperatorList();
  const stack: number[][] = [];
  let transform = viewport.transform.slice();
  const rectangles: PdfParagraphRect[] = [];
  for (let index = 0; index < operators.fnArray.length; index++) {
    const operation = operators.fnArray[index];
    const args = operators.argsArray[index];
    if (operation === pdfjs.OPS.save) { stack.push(transform.slice()); continue; }
    if (operation === pdfjs.OPS.restore) { if (stack.length) transform = stack.pop()!; continue; }
    if (operation === pdfjs.OPS.transform) { transform = pdfjs.Util.transform(transform, args); continue; }
    if (operation !== pdfjs.OPS.paintImageXObject && operation !== pdfjs.OPS.paintInlineImageXObject && operation !== pdfjs.OPS.paintImageMaskXObject) continue;
    const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(point => pdfjs.Util.applyTransform(point, transform));
    const left = Math.min(...points.map(point => point[0]));
    const top = Math.min(...points.map(point => point[1]));
    const right = Math.max(...points.map(point => point[0]));
    const bottom = Math.max(...points.map(point => point[1]));
    if (right - left > 2 && bottom - top > 2 && [left, top, right, bottom].every(Number.isFinite)) {
      rectangles.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return rectangles;
}

type PageProps = {
  pdf: PDFDocumentProxy;
  number: number;
  scale: number;
  textEnabled: boolean;
  initialSize: { width: number; height: number };
  scrollRoot: HTMLElement | null;
  onImageRects: (page: number, rects: PdfParagraphRect[]) => void;
};

function PdfPage({ pdf, number, scale, textEnabled, initialSize, scrollRoot, onImageRects }: PageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const previousRender = useRef<Promise<unknown>>(Promise.resolve());
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(initialSize);
  const [status, setStatus] = useState<"waiting" | "loading" | "ready" | "error">("waiting");
  const [noText, setNoText] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scrollRoot) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      if (releaseTimer) clearTimeout(releaseTimer);
      if (entry.isIntersecting) {
        setVisible(true);
      } else {
        releaseTimer = setTimeout(() => {
          const selection = window.getSelection();
          // Keep all loaded text layers while a selection in the reader exists.
          if (selection && ((selection.anchorNode && scrollRoot.contains(selection.anchorNode)) ||
            (selection.focusNode && scrollRoot.contains(selection.focusNode)))) return;
          setVisible(false);
          setStatus("waiting");
        }, 5000);
      }
    }, { root: scrollRoot, rootMargin: "1500px 0px" });
    observer.observe(host);
    return () => { observer.disconnect(); if (releaseTimer) clearTimeout(releaseTimer); };
  }, [scrollRoot]);

  useEffect(() => {
    if (!visible) {
      if (canvasRef.current) { canvasRef.current.width = 0; canvasRef.current.height = 0; }
      if (textRef.current) { textRef.current.replaceChildren(); invalidatePdfFigureCache(textRef.current); }
      return;
    }
    let cancelled = false;
    let page: PDFPageProxy | undefined;
    let renderTask: ReturnType<PDFPageProxy["render"]> | undefined;
    let textLayer: InstanceType<typeof pdfjs.TextLayer> | undefined;
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!canvas || !textContainer) return;
    setStatus("loading");
    onImageRects(number, []);
    setNoText(false);
    textContainer.replaceChildren();
    invalidatePdfFigureCache(textContainer);
    textContainer.dataset.renderGeneration = String(Number(textContainer.dataset.renderGeneration || 0) + 1);
    const renderCanvas = document.createElement('canvas');

    (async () => {
      try {
        page = await pdf.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale });
        setSize({ width: base.width, height: base.height });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        // A cancelled render may still be settling when zoom changes quickly.
        await previousRender.current;
        if (cancelled) return;
        const context = renderCanvas.getContext("2d");
        if (!context) throw new Error("无法创建页面画布");
        renderCanvas.width = Math.floor(viewport.width * ratio);
        renderCanvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        previousRender.current = renderTask.promise.catch(() => {});
        await renderTask.promise;
        if (cancelled) return;
        // Keep the previous visible bitmap until its sharp replacement is ready.
        canvas.width = renderCanvas.width;
        canvas.height = renderCanvas.height;
        canvas.getContext('2d')?.drawImage(renderCanvas, 0, 0);
        renderCanvas.width = 0; renderCanvas.height = 0;
        void readPdfImageRects(page, viewport).then(rects => {
          if (cancelled) return;
          // Keep page-local positions; client positions change whenever the
          // reader scrolls, even while this canvas stays mounted.
          onImageRects(number, rects);
        }).catch(() => { if (!cancelled) onImageRects(number, []); });
        if (textEnabled) {
          const content = await page.getTextContent();
          if (cancelled) return;
          const hasText = content.items.some((item) => "str" in item && item.str.trim());
          setNoText(!hasText);
          if (hasText) {
            textLayer = new pdfjs.TextLayer({ textContentSource: content, container: textContainer, viewport });
            await textLayer.render();
          }
        }
        if (!cancelled) { invalidatePdfFigureCache(textContainer); setStatus("ready"); }
      } catch (error) {
        if (!cancelled) {
          console.error(`PDF page ${number} failed to render`, error);
          setStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      const release = () => { renderCanvas.width = 0; renderCanvas.height = 0; };
      if (renderTask) void renderTask.promise.catch(() => {}).then(release);
      else release();
      textContainer.replaceChildren();
      invalidatePdfFigureCache(textContainer);
    };
  }, [pdf, number, scale, textEnabled, visible, onImageRects]);

  return (
    <div
      ref={hostRef}
      className="pr-page"
      data-pdf-page={number}
      data-render-status={status}
      aria-busy={status === 'loading'}
      aria-label={`第 ${number} 页`}
      style={{ width: size.width * scale, height: size.height * scale, "--scale-factor": scale, "--total-scale-factor": scale } as React.CSSProperties}
    >
      <canvas ref={canvasRef} aria-label={`第 ${number} 页的内容`} />
      <div ref={textRef} className="pr-text-layer" />
      {(status === "waiting" || status === "loading") && <span className="pr-page-status">正在加载第 {number} 页…</span>}
      {status === "error" && <span className="pr-page-status pr-page-error" role="alert">第 {number} 页加载失败</span>}
      {status === "ready" && noText && <span className="pr-no-text">此页没有可选文字</span>}
    </div>
  );
}

function tightenFigureToImages(figure: PdfFigure, images: PdfParagraphRect[], x: number, y: number): PdfFigure | null {
  if (figure.kind !== 'figure' || !images.length) return figure;
  const relevant = images.filter(rect => {
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // Tiny raster symbols (for example fire/snowflake icons inside a vector
    // diagram) must not define the bounds of the whole composite figure.
    return rect.width >= figure.rect.width * 0.18 && rect.height >= 12 &&
      rect.width * rect.height >= figure.rect.width * figure.rect.height * 0.03 &&
      centerX >= figure.rect.left && centerX <= figure.rect.left + figure.rect.width &&
      centerY >= figure.rect.top && centerY <= figure.rect.top + figure.rect.height;
  });
  if (!relevant.length) return figure;
  const top = Math.min(...relevant.map(rect => rect.top));
  // The embedded bitmap is only one part of some composite figures. Use its
  // top edge to exclude title/author prose, but keep the caption-bounded full
  // lane so vector charts and labels beside the bitmap are not cut off.
  const bottom = figure.rect.top + figure.rect.height;
  const left = Math.max(figure.rect.left, Math.min(...relevant.map(rect => rect.left)));
  const right = figure.rect.left + figure.rect.width;
  if (x < left || x > right || y < top || y > bottom) return null;
  return { ...figure, rect: { left, top, width: right - left, height: bottom - top } };
}

function tightenFigureToCanvas(page: HTMLElement, figure: PdfFigure): PdfFigure {
  try {
    const canvas = page.querySelector<HTMLCanvasElement>('canvas');
    if (!canvas || !canvas.width || !canvas.height) return figure;
    const bounds = canvas.getBoundingClientRect();
    const left = Math.max(bounds.left, figure.rect.left);
    const top = Math.max(bounds.top, figure.rect.top);
    const right = Math.min(bounds.right, figure.rect.left + figure.rect.width);
    const bottom = Math.min(bounds.bottom, figure.rect.top + figure.rect.height);
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;
    const sx = Math.max(0, Math.floor((left - bounds.left) * scaleX));
    const sy = Math.max(0, Math.floor((top - bounds.top) * scaleY));
    const width = Math.min(canvas.width - sx, Math.ceil((right - left) * scaleX));
    const height = Math.min(canvas.height - sy, Math.ceil((bottom - top) * scaleY));
    if (width < 2 || height < 2) return figure;
    const context = canvas.getContext('2d');
    if (!context) return figure;
    const pixels = context.getImageData(sx, sy, width, height).data;
    const rows = new Array<number>(height).fill(0);
    const columns = new Array<number>(width).fill(0);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      // Only remove empty margins. Unlike the discarded dominant-color crop,
      // every sufficiently visible pixel counts, so faint panels stay included.
      if (pixels[offset + 3] > 0 && (pixels[offset] < 250 || pixels[offset + 1] < 250 || pixels[offset + 2] < 250)) { rows[y]++; columns[x]++; }
    }
    const occupiedRows = rows.map((count, index) => count > 0 ? index : -1).filter(index => index >= 0);
    const occupiedColumns = columns.map((count, index) => count > 0 ? index : -1).filter(index => index >= 0);
    if (!occupiedRows.length || !occupiedColumns.length) return figure;
    // Keep a small guard around every visible mark, including thin grey lines.
    const contentLeft = Math.max(left, bounds.left + (sx + occupiedColumns[0]) / scaleX - 2);
    const contentTop = Math.max(top, bounds.top + (sy + occupiedRows[0]) / scaleY - 2);
    const contentRight = Math.min(right, bounds.left + (sx + occupiedColumns[occupiedColumns.length - 1] + 1) / scaleX + 2);
    const contentBottom = Math.min(bottom, bounds.top + (sy + occupiedRows[occupiedRows.length - 1] + 1) / scaleY + 2);
    if (contentRight - contentLeft < 2 || contentBottom - contentTop < 2) return figure;
    return { ...figure, rect: { left: contentLeft, top: contentTop, width: contentRight - contentLeft, height: contentBottom - contentTop } };
  } catch { return figure; }
}

async function capturePdfFigure(page: HTMLElement, figure: PdfFigure, pdf: PDFDocumentProxy, scale: number, signal?: AbortSignal): Promise<Blob | undefined> {
  const canvas = page.querySelector<HTMLCanvasElement>('canvas');
  if (!canvas || !canvas.width || !canvas.height) return undefined;
  const bounds = canvas.getBoundingClientRect();
  const paddingLeft = 4;
  const paddingRight = 4;
  const paddingY = 4;
  const left = Math.max(bounds.left, figure.rect.left - paddingLeft);
  const top = Math.max(bounds.top, figure.rect.top - paddingY);
  const right = Math.min(bounds.right, figure.rect.left + figure.rect.width + paddingRight);
  const bottom = Math.min(bounds.bottom, figure.rect.top + figure.rect.height + paddingY);
  if (right - left < 2 || bottom - top < 2) return undefined;
  const toBlob = (output: HTMLCanvasElement) => new Promise<Blob | undefined>(resolve => output.toBlob(blob => resolve(blob || undefined), 'image/png'));
  // Snapshot crop coordinates above, but let the hover UI paint before rendering.
  await new Promise<void>(resolve => requestAnimationFrame(() => { setTimeout(resolve, 0); }));
  if (signal?.aborted) return undefined;
  try {
    // Re-render the vector/text source at high resolution instead of enlarging
    // the screen canvas. Offset the viewport to the figure's normalized bounds.
    const sourcePage = await pdf.getPage(figure.pageNumber);
    if (signal?.aborted) return undefined;
    // Crop offsets must use the scale-1 viewport. Using the display scale here
    // applies zoom twice and shifts the exported crop at 125%, 150%, etc.
    const baseViewport = sourcePage.getViewport({ scale: 1 });
    const renderScale = Math.min(4, Math.max(scale * 2, 3));
    const x = (left - bounds.left) / bounds.width * baseViewport.width;
    const y = (top - bounds.top) / bounds.height * baseViewport.height;
    const width = (right - left) / bounds.width * baseViewport.width;
    const height = (bottom - top) / bounds.height * baseViewport.height;
    const viewport = sourcePage.getViewport({ scale: renderScale, offsetX: -x * renderScale, offsetY: -y * renderScale });
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(width * renderScale));
    output.height = Math.max(1, Math.round(height * renderScale));
    const context = output.getContext('2d');
    if (!context) return undefined;
    const task = sourcePage.render({ canvasContext: context, viewport });
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try { await task.promise; }
    finally { signal?.removeEventListener('abort', cancel); }
    if (signal?.aborted) return undefined;
    return await toBlob(output);
  } catch {
    if (signal?.aborted) return undefined;
    // A missing renderer or a PDF-specific viewport issue still has the old
    // screen-canvas path as a safe fallback.
    try {
      const scaleX = canvas.width / bounds.width;
      const scaleY = canvas.height / bounds.height;
      const sx = (left - bounds.left) * scaleX;
      const sy = (top - bounds.top) * scaleY;
      const width = (right - left) * scaleX;
      const height = (bottom - top) * scaleY;
      const output = document.createElement('canvas');
      output.width = Math.max(1, Math.round(width));
      output.height = Math.max(1, Math.round(height));
      const context = output.getContext('2d');
      if (!context) return undefined;
      context.drawImage(canvas, sx, sy, width, height, 0, 0, output.width, output.height);
      return await toBlob(output);
    } catch { return undefined; }
  }
}

export function PdfReader(props: PdfReaderProps) {
  // A fresh instance prevents the outgoing document's effects and events from
  // writing state for a different document during a rapid switch.
  const instance = useMemo(() => ++nextReaderInstance, [props.data, props.sessionId, props.workerSrc, props.stateKey]);
  return <PdfReaderInstance key={instance} instance={instance} {...props} />;
}

function PdfReaderInstance({ instance, data, fileName, sessionId, workerSrc, onAction, enableTextLayer = true, stateKey, statusMessage, onGenerateNotes }: PdfReaderProps & { instance: number }) {
  const initialView = useRef((stateKey !== undefined && readerStates.get(stateKey)) || { page: 1, scale: 1 });
  const viewRef = useRef({ ...initialView.current });
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(initialView.current.scale);
  const [pageNumber, setPageNumber] = useState(initialView.current.page);
  const [pageInput, setPageInput] = useState(String(initialView.current.page));
  const [initialSize, setInitialSize] = useState({ width: 612, height: 792 });
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [menu, setMenuState] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  const setMenu = useCallback((update: React.SetStateAction<MenuState | null>) => {
    // Pointer frames can arrive between scheduling a React update and commit.
    // Keep the interaction snapshot synchronous so the same target cannot clear
    // a menu that has just opened and start another 180ms timer.
    const next = typeof update === 'function' ? update(menuRef.current) : update;
    menuRef.current = next;
    setMenuState(next);
  }, []);
  const [preparingFigures, setPreparingFigures] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuElementRef = useRef<HTMLDivElement>(null);
  const [preparingVisible, setPreparingVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);
  const captures = useRef(new Map<string, CaptureJob>());
  const actionsInFlight = useRef(new Set<string>());
  const imageRects = useRef(new Map<number, PdfParagraphRect[]>());
  const updateImageRects = useCallback((page: number, rects: PdfParagraphRect[]) => {
    if (rects.length) imageRects.current.set(page, rects);
    else imageRects.current.delete(page);
  }, []);

  const getCapture = useCallback((element: HTMLElement, figure: PdfFigure): CaptureJob | undefined => {
    if (!pdf) return undefined;
    const generation = element.querySelector<HTMLElement>('.pr-text-layer')?.dataset.renderGeneration || '0';
    const bounds = element.querySelector('canvas')?.getBoundingClientRect();
    const crop = [figure.rect.left - (bounds?.left || 0), figure.rect.top - (bounds?.top || 0), figure.rect.width, figure.rect.height]
      .map(value => Math.round(value * 10) / 10).join(':');
    // Include instance in cache key to prevent cross-document cache conflicts
    const key = `${instance}:${figure.pageNumber}:${figure.key}:${scale}:${generation}:${crop}`;
    const cached = captures.current.get(key);
    if (cached && !cached.controller.signal.aborted) {
      captures.current.delete(key); captures.current.set(key, cached);
      return cached;
    }
    for (const [oldKey, job] of captures.current) {
      if (!job.done && !job.claimed) { job.controller.abort(); captures.current.delete(oldKey); }
    }
    const job: CaptureJob = { key, controller: new AbortController(), promise: Promise.resolve(undefined), claimed: false, done: false };
    captures.current.set(key, job);
    job.promise = capturePdfFigure(element, figure, pdf, scale, job.controller.signal).catch(() => undefined).then(blob => {
      job.done = true;
      if (job.controller.signal.aborted) blob = undefined;
      job.blob = blob;
      if (!blob && captures.current.get(key) === job) captures.current.delete(key);
      let done = [...captures.current.values()].filter(item => item.done && item.blob);
      let bytes = done.reduce((sum, item) => sum + (item.blob?.size || 0), 0);
      while (done.length > 4 || bytes > 16 * 1024 * 1024) {
        const oldest = done.shift()!; bytes -= oldest.blob?.size || 0;
        captures.current.delete(oldest.key);
      }
      return blob;
    });
    return job;
  }, [pdf, scale, instance]);

  const showFigure = useCallback((element: HTMLElement, figure: PdfFigure, origin: 'pointer' | 'keyboard' = 'pointer', returnFocus?: HTMLElement | null) => {
    const capture = getCapture(element, figure);
    setMenu({ mode: 'figure', key: figure.key, anchor: figure.rect, origin, returnFocus,
      capture, imageReady: capture?.promise,
      quote: { kind: 'figure', text: figure.caption, pageStart: figure.pageNumber, pageEnd: figure.pageNumber },
      highlights: [{ ...figure.rect }] });
  }, [getCapture]);

  useEffect(() => {
    const job = menu?.capture;
    return () => { if (job && !job.done && !job.claimed) { job.controller.abort(); captures.current.delete(job.key); } };
  }, [menu]);

  useEffect(() => {
    if (!preparingFigures) { setPreparingVisible(false); return; }
    const timer = setTimeout(() => setPreparingVisible(true), 200);
    return () => clearTimeout(timer);
  }, [preparingFigures]);

  useLayoutEffect(() => {
    if (!menu || !scrollRoot || !menuElementRef.current) { setMenuPosition(null); return; }
    const element = menuElementRef.current;
    const bounds = scrollRoot.getBoundingClientRect();
    const viewport = window.visualViewport;
    const left = Math.max(bounds.left, viewport?.offsetLeft || 0);
    const top = Math.max(bounds.top, viewport?.offsetTop || 0);
    const right = Math.min(bounds.right, (viewport?.offsetLeft || 0) + (viewport?.width || window.innerWidth));
    const bottom = Math.min(bounds.bottom, (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight));
    element.style.maxWidth = `${Math.max(0, right - left - 16)}px`;
    const size = element.getBoundingClientRect();
    const position = positionReaderOverlay(menu.anchor, { left, top, width: right - left, height: bottom - top }, size);
    // Make the measured overlay visible before focusing; hidden elements cannot
    // receive focus during this first layout effect.
    element.style.left = `${position.left}px`; element.style.top = `${position.top}px`; element.style.visibility = 'visible';
    setMenuPosition(position);
    if (menu.origin === 'keyboard') element.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }, [menu, scrollRoot]);

  useEffect(() => {
    if (!scrollRoot) return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      if (initial) { initial = false; return; }
      setMenu(null);
    });
    observer.observe(scrollRoot);
    const close = () => setMenu(null);
    window.addEventListener('resize', close);
    window.visualViewport?.addEventListener('resize', close);
    return () => { observer.disconnect(); window.removeEventListener('resize', close); window.visualViewport?.removeEventListener('resize', close); };
  }, [scrollRoot]);

  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!menuElementRef.current?.contains(target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);

  const updateView = useCallback((changes: Partial<{ page: number; scale: number }>) => {
    viewRef.current = { ...viewRef.current, ...changes };
    if (stateKey !== undefined) readerStates.set(stateKey, viewRef.current);
  }, [stateKey]);
  const changeScale = useCallback((delta: number) => {
    const next = clampScale(viewRef.current.scale + delta);
    updateView({ scale: next });
    setScale(next);
    setMenu(null);
  }, [updateView]);

  useEffect(() => () => {
    captures.current.forEach(job => job.controller.abort());
    captures.current.clear();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPdf(null);
    setError("");
    setMenu(null);
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
    // PDF.js can transfer the buffer to its worker, so preserve the caller's bytes.
    const task = pdfjs.getDocument({ data: data.slice(), useWorkerFetch: false, CMapReaderFactory: BundledCMapReaderFactory, StandardFontDataFactory: BundledStandardFontDataFactory });
    (async () => {
      try {
        const document = await task.promise;
        const first = await document.getPage(1);
        if (cancelled) return;
        const viewport = first.getViewport({ scale: 1 });
        setInitialSize({ width: viewport.width, height: viewport.height });
        setPdf(document);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开 PDF 文件");
      }
    })();
    return () => {
      cancelled = true;
      const selection = window.getSelection();
      if (selection?.anchorNode && rootRef.current?.contains(selection.anchorNode)) selection.removeAllRanges();
      void task.destroy().catch(() => {});
    };
  }, [data, sessionId, workerSrc]);

  useLayoutEffect(() => {
    if (!pdf || !scrollRoot) return;
    const restoredPage = Math.max(1, Math.min(pdf.numPages, viewRef.current.page));
    const targetPage = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${restoredPage}"]`);
    if (targetPage) {
      scrollRoot.scrollTo({ top: scrollRoot.scrollTop + targetPage.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 16, behavior: "auto" });
    }
    updateView({ page: restoredPage });
    setPageNumber(restoredPage);
    setPageInput(String(restoredPage));
    const updatePage = () => {
      const pages = scrollRoot.querySelectorAll<HTMLElement>("[data-pdf-page]");
      const target = scrollRoot.getBoundingClientRect().top + Math.min(scrollRoot.clientHeight * 0.3, 160);
      let closest = 1;
      let distance = Infinity;
      pages.forEach((page) => {
        const rect = page.getBoundingClientRect();
        const d = target < rect.top ? rect.top - target : target > rect.bottom ? target - rect.bottom : 0;
        if (d < distance) { distance = d; closest = Number(page.dataset.pdfPage); }
      });
      if (pages.length) {
        updateView({ page: closest });
        setPageNumber(closest);
      }
    };
    scrollRoot.addEventListener("scroll", updatePage, { passive: true });
    return () => scrollRoot.removeEventListener("scroll", updatePage);
  }, [pdf, scrollRoot, updateView]);

  useEffect(() => { setPageInput(String(pageNumber)); }, [pageNumber]);

  const goToPage = useCallback((requested: number) => {
    if (!pdf || !scrollRoot) return;
    const number = Math.max(1, Math.min(pdf.numPages, Math.round(requested) || 1));
    const target = scrollRoot.querySelector<HTMLElement>(`[data-pdf-page="${number}"]`);
    if (target) scrollRoot.scrollTo({ top: scrollRoot.scrollTop + target.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top - 16, behavior: "auto" });
    updateView({ page: number });
    setPageNumber(number);
    setPageInput(String(number));
    setMenu(null);
  }, [pdf, scrollRoot, updateView]);

  useEffect(() => {
    const updateSelection = () => {
      const selection = window.getSelection();
      const root = rootRef.current;
      if (!enableTextLayer || !selection || selection.isCollapsed || !selection.rangeCount || !root ||
          !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
        setMenu(null);
        return;
      }
      const inTextLayer = (node: Node | null) => {
        const element = node instanceof Element ? node : node?.parentElement;
        const layer = element?.closest(".pr-text-layer");
        return !!layer && root.contains(layer);
      };
      if (!inTextLayer(selection.anchorNode) || !inTextLayer(selection.focusNode)) { setMenu(null); return; }
      const range = selection.getRangeAt(0);
      const text = selection.toString().trim();
      const pages = Array.from(root.querySelectorAll<HTMLElement>("[data-pdf-page]"))
        .filter((page) => { try { return range.intersectsNode(page.querySelector(".pr-text-layer") || page); } catch { return false; } })
        .map((page) => Number(page.dataset.pdfPage));
      const rect = range.getBoundingClientRect();
      if (!text || !pages.length || (!rect.width && !rect.height)) { setMenu(null); return; }
      setMenu({ mode: 'selection', quote: { text, pageStart: Math.min(...pages), pageEnd: Math.max(...pages) }, anchor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, origin: 'pointer' });
    };
    document.addEventListener("selectionchange", updateSelection);
    return () => document.removeEventListener("selectionchange", updateSelection);
  }, [enableTextLayer, pdf]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !pdf || !enableTextLayer) return;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    let hoverTicket = 0;
    let frame: number | undefined;
    let lastEvent: PointerEvent | undefined;
    let pending: { key: string; mode: 'hover' | 'figure'; activate: (ticket: number) => void; position?: { x: number; y: number } } | undefined;
    const clearHoverTimer = () => { hoverTicket++; if (hoverTimer !== undefined) clearTimeout(hoverTimer); hoverTimer = undefined; pending = undefined; };
    const clearCloseTimer = () => { if (closeTimer !== undefined) clearTimeout(closeTimer); closeTimer = undefined; };
    const focused = () => !!menuElementRef.current?.contains(document.activeElement);
    const closeSoon = () => {
      if (closeTimer !== undefined || focused()) return;
      closeTimer = setTimeout(() => {
        closeTimer = undefined;
        if (!focused()) setMenu(current => current?.mode === 'selection' ? current : null);
      }, 800);
    };
    const HOVER_DELAY = 120; // Reduced from 180ms for better responsiveness
    const POSITION_THRESHOLD = 5; // Pixels - position changes beyond this reset the timer

    const schedule = (key: string, mode: 'hover' | 'figure', activate: (ticket: number) => void, position?: { x: number; y: number }) => {
      const current = menuRef.current;
      if (current?.mode === mode && current.key === key) { clearHoverTimer(); clearCloseTimer(); return; }

      // If same key and mode, check if position changed significantly
      if (pending?.key === key && pending.mode === mode) {
        const lastPos = pending.position;
        // If position hasn't changed significantly (< threshold), just update activate
        if (lastPos && position &&
            Math.abs(lastPos.x - position.x) < POSITION_THRESHOLD &&
            Math.abs(lastPos.y - position.y) < POSITION_THRESHOLD) {
          pending.activate = activate;
          return;
        }
        // Position changed significantly, reset timer
        clearHoverTimer();
      } else {
        clearHoverTimer(); clearCloseTimer();
      }

      if (current?.mode !== 'selection') setMenu(null);
      pending = { key, mode, activate, position };
      const ticket = hoverTicket;
      hoverTimer = setTimeout(() => {
        const target = pending; pending = undefined; hoverTimer = undefined;
        if (ticket === hoverTicket) target?.activate(ticket);
      }, HOVER_DELAY);
    };
    const processPointer = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest('.pr-selection-menu')) { clearHoverTimer(); clearCloseTimer(); return; }
      if (focused()) { clearHoverTimer(); clearCloseTimer(); return; }
      const current = menuRef.current;
      const floating = menuElementRef.current?.getBoundingClientRect();
      if (current && floating && isPointInOverlayBridge({ x: event.clientX, y: event.clientY }, current.anchor, floating)) {
        clearHoverTimer(); clearCloseTimer(); return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode)) {
        clearHoverTimer(); clearCloseTimer(); return;
      }
      const pageElement = target.closest<HTMLElement>('[data-pdf-page]');
      if (!pageElement || !root.contains(pageElement) || pageElement.dataset.renderStatus !== 'ready') { clearHoverTimer(); closeSoon(); return; }
      const page = Number(pageElement.dataset.pdfPage);
      const layer = pageElement.querySelector<HTMLElement>('.pr-text-layer');
      if (layer) {
        const coarseFigure = findPdfFigureAtPoint(collectPdfFigures(layer, page), event.clientX, event.clientY);
        const canvasBounds = pageElement.querySelector('canvas')?.getBoundingClientRect();
        const clientImages = canvasBounds ? (imageRects.current.get(page) || []).map(rect => ({ ...rect, left: canvasBounds.left + rect.left, top: canvasBounds.top + rect.top })) : [];
        const figure = coarseFigure ? tightenFigureToImages(coarseFigure, clientImages, event.clientX, event.clientY) : null;
        if (figure) {
          schedule(figure.key, 'figure', ticket => {
            const preciseFigure = tightenFigureToCanvas(pageElement, figure);
            const rect = preciseFigure.rect;
            if (event.clientX < rect.left - 4 || event.clientX > rect.left + rect.width + 4 ||
                event.clientY < rect.top - 4 || event.clientY > rect.top + rect.height + 4 || ticket !== hoverTicket) return;
            showFigure(pageElement, preciseFigure);
          }, { x: event.clientX, y: event.clientY });
          return;
        }
      }
      const textLayer = target.closest<HTMLElement>('.pr-text-layer');
      if (!textLayer || !root.contains(textLayer)) { clearHoverTimer(); closeSoon(); return; }
      const paragraph = findPdfParagraph(target, textLayer, page);
      if (!paragraph || !paragraph.rects.length) { clearHoverTimer(); closeSoon(); return; }
      schedule(paragraph.key, 'hover', () => {
        const left = Math.min(...paragraph.rects.map(rect => rect.left));
        const right = Math.max(...paragraph.rects.map(rect => rect.right));
        const top = Math.min(...paragraph.rects.map(rect => rect.top));
        const bottom = Math.max(...paragraph.rects.map(rect => rect.bottom));
        setMenu({
          mode: 'hover', key: paragraph.key, origin: 'pointer',
          quote: { text: paragraph.text, pageStart: page, pageEnd: page },
          anchor: { left, top, width: right - left, height: bottom - top },
          highlights: paragraph.rects.map(rect => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })),
        });
      }, { x: event.clientX, y: event.clientY });
    };
    const onPointerMove = (event: PointerEvent) => {
      lastEvent = event;
      if (frame === undefined) frame = requestAnimationFrame(() => { frame = undefined; if (lastEvent) processPointer(lastEvent); });
    };
    const onScroll = () => { clearHoverTimer(); clearCloseTimer(); setMenu(null); };
    const onLeave = () => { if (frame !== undefined) cancelAnimationFrame(frame); frame = undefined; clearHoverTimer(); closeSoon(); };
    const onFocusIn = () => { if (focused()) clearCloseTimer(); };
    const onFocusOut = (event: FocusEvent) => { if (!menuElementRef.current?.contains(event.relatedTarget as Node | null)) closeSoon(); };
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerleave', onLeave);
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    return () => {
      clearHoverTimer(); clearCloseTimer(); if (frame !== undefined) cancelAnimationFrame(frame);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerleave', onLeave);
      root.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [enableTextLayer, pdf, scale, showFigure]);

  const closeMenu = (restoreFocus = false) => {
    const selected = menuRef.current;
    setMenu(null);
    if (restoreFocus) (selected?.returnFocus?.isConnected ? selected.returnFocus : scrollRoot)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.currentTarget.dataset.inputMethod = 'keyboard';
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      window.getSelection()?.removeAllRanges();
      return;
    }
    const target = event.target as HTMLElement;
    const toolbar = target.closest('.pr-selection-menu');
    if (toolbar && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      const buttons = [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      event.preventDefault(); buttons[next]?.focus(); return;
    }
    if (/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target.tagName) || target.isContentEditable || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goToPage(pageNumber + 1); }
    else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goToPage(pageNumber - 1); }
    else if (event.key === '+' || event.key === '=') { event.preventDefault(); changeScale(SCALE_STEP); }
    else if (event.key === '-') { event.preventDefault(); changeScale(-SCALE_STEP); }
  };

  const dispatch = (action: PdfReaderAction) => {
    if (!menu) return;
    const selected = menu;
    const actionKey = `${selected.capture?.key || selected.key}:${action}`;
    if (actionsInFlight.current.has(actionKey)) { closeMenu(selected.origin === 'keyboard'); return; }
    if (selected.capture) selected.capture.claimed = true;
    closeMenu(selected.origin === 'keyboard');
    if (selected.mode === 'figure' && selected.imageReady) {
      actionsInFlight.current.add(actionKey);
      setPreparingFigures(count => count + 1);
      void selected.imageReady.then(image => {
        if (rootRef.current) onAction(action, { ...selected.quote, image });
      }).finally(() => {
        actionsInFlight.current.delete(actionKey);
        if (rootRef.current) setPreparingFigures(count => Math.max(0, count - 1));
      });
      return;
    }
    onAction(action, selected.quote);
  };

  return (
    <div className="pr-reader" ref={rootRef} onKeyDown={onKeyDown} onPointerDownCapture={event => { event.currentTarget.dataset.inputMethod = 'pointer'; }} data-session-id={sessionId}>
      <div className="pr-toolbar" role="toolbar" aria-label="PDF 阅读工具">
        <div className="pr-title-row">
          <ReaderIcon name="document" />
          <span className="pr-filename" title={fileName}>{fileName}</span>
          {(preparingVisible || statusMessage) && <span className="pr-toolbar-status" data-kind={preparingVisible ? 'progress' : 'message'} role="status" title={preparingVisible ? '正在准备清晰图表…' : statusMessage}>
            {preparingVisible && <span className="pr-spinner" aria-hidden="true" />}
            <span>{preparingVisible ? '正在准备清晰图表…' : statusMessage}</span>
          </span>}
          {onGenerateNotes && <button type="button" className="pr-notes-entry" title="生成阅读笔记" aria-label="生成阅读笔记" onClick={onGenerateNotes}><ReaderIcon name="notes" /><span className="pr-notes-entry-label">笔记</span></button>}
        </div>
        <div className="pr-controls">
          <div className="pr-control-group">
            <button type="button" aria-label="上一页" title="上一页" disabled={!pdf || pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}><ReaderIcon name="previous" /></button>
            <label className="pr-page-input"><span className="pr-sr-only">页码</span><input type="number" min={1} max={pdf?.numPages || 1} value={pageInput} disabled={!pdf} onChange={event => setPageInput(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); goToPage(Number(pageInput)); event.currentTarget.blur(); } }} onBlur={() => goToPage(Number(pageInput))} /></label>
            <span className="pr-page-count">/ {pdf?.numPages || '–'}</span>
            <button type="button" aria-label="下一页" title="下一页" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => goToPage(pageNumber + 1)}><ReaderIcon name="next" /></button>
          </div>
          <span className="pr-divider" aria-hidden="true" />
          <div className="pr-control-group">
            <button type="button" aria-label="缩小" title="缩小" disabled={!pdf || scale <= MIN_SCALE} onClick={() => changeScale(-SCALE_STEP)}><ReaderIcon name="zoomOut" /></button>
            <span className="pr-zoom" aria-label={`缩放 ${Math.round(scale * 100)}%`}>{Math.round(scale * 100)}%</span>
            <button type="button" aria-label="放大" title="放大" disabled={!pdf || scale >= MAX_SCALE} onClick={() => changeScale(SCALE_STEP)}><ReaderIcon name="zoomIn" /></button>
          </div>
        </div>
      </div>
      <div className="pr-scroll" ref={setScrollRoot} tabIndex={0} aria-label="PDF 页面，使用左右方向键切换页面，加减号缩放" onScroll={() => setMenu(null)}>
        {error ? <div className="pr-message" role="alert">无法打开 PDF：{error}</div> : !pdf ? <div className="pr-message" role="status">正在打开 PDF…</div> : (
          <div className="pr-pages">{Array.from({ length: pdf.numPages }, (_, index) => <PdfPage key={index + 1} pdf={pdf} number={index + 1} scale={scale} textEnabled={enableTextLayer} initialSize={initialSize} scrollRoot={scrollRoot} onImageRects={updateImageRects} />)}</div>
        )}
      </div>
      {menu?.mode === 'figure' && menu.highlights?.map((rect, index) => <div key={`${menu.key}:${index}`} className="pr-figure-highlight" style={rect} aria-hidden="true" />)}
      {menu?.mode === 'hover' && <div className="pr-paragraph-outline pr-hover-highlight" style={{ left: menu.anchor.left - 3, top: menu.anchor.top - 2, width: menu.anchor.width + 6, height: menu.anchor.height + 4 }} aria-hidden="true" />}
      {menu && <div ref={menuElementRef} className="pr-selection-menu" data-placement={menuPosition?.placement} role="toolbar" aria-label={menu.mode === 'figure' ? '图表操作' : menu.mode === 'hover' ? '悬停段落的操作' : '选中文字的操作'} style={{ left: menuPosition?.left || 0, top: menuPosition?.top || 0, visibility: menuPosition ? 'visible' : 'hidden' }} onMouseDown={(event) => event.preventDefault()}>
        <button type="button" onClick={() => dispatch("explain")}>解释</button>
        {menu.mode !== 'figure' && <><button type="button" onClick={() => dispatch("translate")}>翻译</button><button type="button" onClick={() => dispatch("ask")}>提问</button></>}
        <button type="button" onClick={() => dispatch("copy")}>复制</button>
      </div>}
    </div>
  );
}

export default PdfReader;
