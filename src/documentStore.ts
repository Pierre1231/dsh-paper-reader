/**
 * Opened PDF documents, keyed by *content* rather than by array identity.
 *
 * A host may hand the preview the same file as a new Uint8Array on every
 * re-render, or unmount/remount the preview when tabs or conversations switch.
 * Keying on identity would re-parse the whole PDF (fonts, images, operator
 * lists) each time. Here the same bytes reuse one parsed document; an unused
 * document stays warm for a short while and is then destroyed.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import bundledAssets from 'pdf-bundled-assets';
import { acquirePdfWorker, type PdfWorkerResult } from './pdfWorker';
import { traceOpen, traceWorker } from './trace';


export interface PdfRect { left: number; top: number; width: number; height: number }
export interface PdfImageRects { width: number; height: number; rects: PdfRect[] }

export interface PdfHandle {
  readonly id: number;
  readonly key: string;
  readonly pdf: PDFDocumentProxy;
  readonly numPages: number;
  readonly firstPageSize: { width: number; height: number };
  readonly workerMode: PdfWorkerResult['mode'];
  readonly workerReason?: string;
  /** Text content is fetched once per page and document. */
  textContent(page: number): Promise<{ content: TextContent; cached: boolean; ms: number }>;
  /** Embedded image boxes at scale 1, computed on first request. */
  imageRects(page: number): Promise<PdfImageRects>;
  /** Synchronous view of imageRects(); undefined until computed. */
  imageRectsNow(page: number): PdfImageRects | undefined;
  /** Release a far-away page's operator list and decoded resources. */
  cleanupPage(page: number): void;
}

const IDLE_TTL_MS = 60000;
const MAX_IDLE_DOCUMENTS = 2;

function decodeAsset(value: string | undefined, name: string): Uint8Array {
  if (!value) throw new Error(`PDF 字体资源不可用：${name}`);
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
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

async function readImageRects(pdf: PDFDocumentProxy, pageNumber: number): Promise<PdfImageRects> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const operators = await page.getOperatorList();
  const stack: number[][] = [];
  let transform: number[] = viewport.transform.slice();
  const rects: PdfRect[] = [];
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
      rects.push({ left, top, width: right - left, height: bottom - top });
    }
  }
  return { width: viewport.width, height: viewport.height, rects };
}

type Entry = {
  key: string;
  refs: number;
  idleSince: number;
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<PdfHandle>;
  destroy: () => void;
};
const entries = new Map<string, Entry>();
let nextDocumentId = 0;

function destroyEntry(entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entries.delete(entry.key);
  entry.destroy();
}

function trimIdle() {
  const idle = [...entries.values()].filter(entry => entry.refs === 0).sort((a, b) => a.idleSince - b.idleSince);
  while (idle.length > MAX_IDLE_DOCUMENTS) destroyEntry(idle.shift()!);
}

export function openPdfDocument(bytes: Uint8Array, key: string, workerUrl: string): { promise: Promise<PdfHandle>; release: () => void } {
  let entry = entries.get(key);
  if (entry) {
    entry.refs++;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    traceOpen({ key, bytes: bytes.length, reused: true });
  } else {
    const started = performance.now();
    let task: ReturnType<typeof pdfjs.getDocument> | undefined;
    let destroyed = false;
    const id = ++nextDocumentId;
    // The worker copies are made from the caller's bytes; never transfer them.
    const copy = bytes.slice();
    const promise = acquirePdfWorker(workerUrl).then(async worker => {
      traceWorker(worker);
      if (destroyed) throw new Error('文档已关闭');
      if (worker.mode !== 'thread') {
        // Last resort: pdf.js decides (and will usually parse on the main thread).
        console.warn(`[dsh-paper-reader] PDF 将在主线程解析，界面可能卡顿：${worker.reason}`);
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      task = pdfjs.getDocument({
        data: copy,
        worker: worker.mode === 'thread' ? worker.worker : undefined,
        useWorkerFetch: false,
        CMapReaderFactory: BundledCMapReaderFactory,
        StandardFontDataFactory: BundledStandardFontDataFactory,
      });
      const pdf = await task.promise;
      const first = await pdf.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      const texts = new Map<number, Promise<TextContent>>();
      const images = new Map<number, Promise<PdfImageRects>>();
      const imagesReady = new Map<number, PdfImageRects>();
      const handle: PdfHandle = {
        id, key, pdf, numPages: pdf.numPages,
        firstPageSize: { width: viewport.width, height: viewport.height },
        workerMode: worker.mode,
        workerReason: worker.mode === 'thread' ? undefined : worker.reason,
        async textContent(pageNumber) {
          const started = performance.now();
          let pending = texts.get(pageNumber);
          const cached = !!pending;
          if (!pending) {
            pending = pdf.getPage(pageNumber).then(page => page.getTextContent());
            texts.set(pageNumber, pending);
            pending.catch(() => texts.delete(pageNumber));
          }
          const content = await pending;
          return { content, cached, ms: performance.now() - started };
        },
        imageRects(pageNumber) {
          let pending = images.get(pageNumber);
          if (!pending) {
            pending = readImageRects(pdf, pageNumber);
            images.set(pageNumber, pending);
            pending.then(value => imagesReady.set(pageNumber, value), () => images.delete(pageNumber));
          }
          return pending;
        },
        imageRectsNow: pageNumber => imagesReady.get(pageNumber),
        cleanupPage(pageNumber) {
          // Do not wait: cleanup is skipped by pdf.js while a render is pending.
          void pdf.getPage(pageNumber).then(page => page.cleanup()).catch(() => {});
        },
      };
      traceOpen({ key, bytes: bytes.length, reused: false, ms: Math.round(performance.now() - started), pages: pdf.numPages, worker: worker.mode });
      return handle;
    });
    promise.catch(error => {
      traceOpen({ key, bytes: bytes.length, reused: false, error: error instanceof Error ? error.message : String(error) });
      const current = entries.get(key);
      if (current?.promise === promise) { entries.delete(key); if (current.timer) clearTimeout(current.timer); }
    });
    entry = {
      key, refs: 1, idleSince: 0, promise,
      destroy: () => { destroyed = true; void task?.destroy().catch(() => {}); },
    };
    entries.set(key, entry);
  }
  const owned = entry;
  let released = false;
  return {
    promise: owned.promise,
    release() {
      if (released) return;
      released = true;
      owned.refs = Math.max(0, owned.refs - 1);
      if (owned.refs > 0 || entries.get(owned.key) !== owned) return;
      owned.idleSince = performance.now();
      owned.timer = setTimeout(() => { if (owned.refs === 0) destroyEntry(owned); }, IDLE_TTL_MS);
      trimIdle();
    },
  };
}

/** Destroy every document (plugin disposal). */
export function closeAllPdfDocuments() {
  for (const entry of [...entries.values()]) destroyEntry(entry);
}
