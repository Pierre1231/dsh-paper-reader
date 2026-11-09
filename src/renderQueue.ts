export interface RenderFrameClock {
  request(callback: FrameRequestCallback): number;
  cancel(id: number): void;
}

export interface PdfRenderQueue {
  /** One page continuation per frame; priority is re-read as the viewport moves. */
  schedule(continueWork: () => void, priority: () => number): () => void;
  /** Reusable after clear, including React's effect setup/cleanup replay. */
  clear(): void;
}

export function createPdfRenderQueue(clock: RenderFrameClock = {
  request: callback => requestAnimationFrame(callback),
  cancel: id => cancelAnimationFrame(id),
}): PdfRenderQueue {
  type Entry = { run: () => void; priority: () => number };
  const pending = new Set<Entry>();
  let frame: number | undefined;
  const request = () => {
    if (frame !== undefined || !pending.size) return;
    frame = clock.request(() => {
      frame = undefined;
      let next: Entry | undefined;
      let best = Infinity;
      for (const entry of pending) {
        const value = entry.priority();
        if (!next || value < best) { next = entry; best = value; }
      }
      if (next) { pending.delete(next); next.run(); }
      request();
    });
  };
  return {
    schedule(run, priority) {
      const entry = { run, priority };
      pending.add(entry); request();
      return () => {
        pending.delete(entry);
        if (!pending.size && frame !== undefined) { clock.cancel(frame); frame = undefined; }
      };
    },
    clear() {
      pending.clear();
      if (frame !== undefined) clock.cancel(frame);
      frame = undefined;
    },
  };
}
