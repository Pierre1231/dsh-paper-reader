/**
 * One dedicated PDF.js worker for the whole plugin.
 *
 * Letting `getDocument` create its own worker is fragile inside a host page:
 *  - if the host (or another plugin) ever evaluated a pdf.js worker on the main
 *    thread, `globalThis.pdfjsWorker` exists and pdf.js 4.x *always* parses on
 *    the main thread ("fake worker") from then on;
 *  - one failed worker start sets a sticky static flag, so every later document
 *    also parses on the main thread;
 *  - both cases are reported only as a console warning.
 * Main-thread parsing blocks the whole host UI. Here the worker is created
 * explicitly, the "ready" handshake is awaited, and the outcome is recorded so
 * diagnostics can show which mode is really in use.
 */
import * as pdfjs from 'pdfjs-dist';
import type { PDFWorker } from 'pdfjs-dist';

export type PdfWorkerResult =
  | { mode: 'thread'; worker: PDFWorker; startupMs: number }
  | { mode: 'main-thread'; reason: string; startupMs: number };

const STARTUP_TIMEOUT_MS = 15000;
let shared: { url: string; promise: Promise<PdfWorkerResult>; terminate: () => void } | undefined;

export function acquirePdfWorker(url: string): Promise<PdfWorkerResult> {
  if (shared && shared.url === url) return shared.promise;
  shared?.terminate();
  const started = performance.now();
  let raw: Worker | undefined;
  let pdfWorker: PDFWorker | undefined;
  const promise = new Promise<PdfWorkerResult>(resolve => {
    const fail = (reason: string) => {
      raw?.terminate(); raw = undefined;
      resolve({ mode: 'main-thread', reason, startupMs: performance.now() - started });
    };
    if (!url) { fail('Worker 地址不可用'); return; }
    if (typeof Worker === 'undefined') { fail('当前环境不支持 Worker'); return; }
    try {
      raw = new Worker(url, { type: 'module', name: 'dsh-paper-reader-pdf' });
    } catch (error) {
      fail(`无法创建 Worker：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const worker = raw;
    let settled = false;
    const finish = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      result();
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      // pdf.worker posts {sourceName:'worker', targetName:'main', action:'ready'} after evaluation.
      if (!data || data.sourceName !== 'worker' || data.action !== 'ready') return;
      finish(() => {
        try {
          pdfWorker = pdfjs.PDFWorker.fromPort({ port: worker, name: 'dsh-paper-reader' }) as PDFWorker;
          resolve({ mode: 'thread', worker: pdfWorker, startupMs: performance.now() - started });
        } catch (error) {
          fail(`Worker 初始化失败：${error instanceof Error ? error.message : String(error)}`);
        }
      });
    };
    const onError = (event: ErrorEvent | Event) => {
      event.preventDefault?.();
      const message = 'message' in event && event.message ? `：${event.message}` : '（可能被宿主的内容安全策略阻止）';
      finish(() => fail(`Worker 加载失败${message}`));
    };
    const timer = setTimeout(() => finish(() => fail(`Worker 在 ${STARTUP_TIMEOUT_MS / 1000} 秒内未就绪`)), STARTUP_TIMEOUT_MS);
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
  shared = {
    url, promise,
    terminate: () => { try { pdfWorker?.destroy(); } catch { /* ignore */ } raw?.terminate(); raw = undefined; },
  };
  return promise;
}

/** Called when the plugin is disposed. Documents must already be destroyed. */
export function disposePdfWorker() {
  shared?.terminate();
  shared = undefined;
}

/** True if something on this page already loaded a pdf.js worker on the main thread. */
export function hostHasMainThreadPdfWorker(): boolean {
  try { return !!(globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } }).pdfjsWorker?.WorkerMessageHandler; }
  catch { return false; }
}
