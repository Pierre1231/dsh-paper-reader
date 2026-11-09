/**
 * Time-sliced, prioritised main-thread work (text layers, idle prefetch).
 *
 * Every slice runs for at most `budgetMs` and then yields a full macrotask, so
 * input, host rendering and the host's own tasks always get a turn. This is the
 * same slicing model React's scheduler uses; it does not depend on
 * requestAnimationFrame, so work is not frozen when the host throttles frames.
 */
export interface SlicedJob {
  /** Do work until `deadline` (performance.now() based). Return true when finished. */
  run(deadline: number): boolean;
  /** Lower runs first. Re-read before every slice, so scrolling reprioritises. */
  priority(): number;
}

export interface SliceClock {
  now(): number;
  post(callback: () => void): void;
}

export interface TaskScheduler {
  /** Resolves when the job finishes; rejects with an AbortError when cancelled. */
  run(job: SlicedJob, signal?: AbortSignal): Promise<void>;
  clear(): void;
  /** Number of jobs waiting or running. */
  readonly size: number;
}

function defaultClock(): SliceClock {
  let post: (callback: () => void) => void;
  if (typeof MessageChannel !== 'undefined') {
    const channel = new MessageChannel();
    const queue: Array<() => void> = [];
    channel.port1.onmessage = () => { queue.shift()?.(); };
    post = callback => { queue.push(callback); channel.port2.postMessage(null); };
  } else {
    post = callback => { setTimeout(callback, 0); };
  }
  return { now: () => performance.now(), post };
}

export function createTaskScheduler(options: { budgetMs?: number; clock?: SliceClock; onSlice?: (ms: number) => void } = {}): TaskScheduler {
  const budget = options.budgetMs ?? 6;
  const clock = options.clock ?? defaultClock();
  type Entry = { job: SlicedJob; resolve: () => void; reject: (error: unknown) => void; done: boolean };
  const entries = new Set<Entry>();
  let posted = false;
  const request = () => {
    if (posted || !entries.size) return;
    posted = true;
    clock.post(pump);
  };
  function pump() {
    posted = false;
    const start = clock.now();
    const deadline = start + budget;
    // Several small jobs may share one slice; one large job never exceeds it.
    while (entries.size && clock.now() < deadline) {
      let next: Entry | undefined;
      let best = Infinity;
      for (const entry of entries) {
        const value = entry.job.priority();
        if (!next || value < best) { next = entry; best = value; }
      }
      if (!next) break;
      let finished = false;
      try { finished = next.job.run(deadline); }
      catch (error) { entries.delete(next); next.done = true; next.reject(error); continue; }
      if (finished) { entries.delete(next); next.done = true; next.resolve(); }
      else break;
    }
    options.onSlice?.(clock.now() - start);
    request();
  }
  return {
    run(job, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        const entry: Entry = { job, resolve, reject, done: false };
        entries.add(entry);
        signal?.addEventListener('abort', () => {
          if (entry.done) return;
          entries.delete(entry); entry.done = true;
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
        request();
      });
    },
    clear() {
      for (const entry of entries) { entry.done = true; entry.reject(new DOMException('Aborted', 'AbortError')); }
      entries.clear();
    },
    get size() { return entries.size; },
  };
}
