import type { DraftBinding, DraftRequest } from './draftBridge';

export interface ReadingSendRequest {
  readonly request: DraftRequest;
  readonly image?: { readonly blob: Blob; readonly fileName: string };
}

export type ReadingSendFailure = 'session-mismatch' | 'manual-action' | 'send-unavailable' | 'send-failed' | 'attachment-unavailable' | 'attachment-failed';
export type ReadingSendResult =
  | { status: 'sent' }
  | { status: 'cancelled' }
  | { status: 'pending'; reason: ReadingSendFailure };

/** Send only the explicitly chosen reading operation. The composer stays untouched. */
export async function sendReadingRequest(
  selected: ReadingSendRequest,
  binding?: DraftBinding | null,
  options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<ReadingSendResult> {
  const { request, image } = selected;
  const current = () => !options.signal?.aborted && (options.isCurrent?.() ?? true);
  if (!current()) return { status: 'cancelled' };
  if (request.action !== 'explain' && request.action !== 'translate') return { status: 'pending', reason: 'manual-action' };
  if (!binding || binding.sessionId !== request.selection.sessionId) return { status: 'pending', reason: 'session-mismatch' };
  if (typeof binding.sendMessage !== 'function') return { status: 'pending', reason: 'send-unavailable' };
  if (image && (typeof binding.createDrafts !== 'function' || typeof binding.releaseDraftAttachment !== 'function')) {
    return { status: 'pending', reason: 'attachment-unavailable' };
  }
  let ids: string[] = [];
  const release = () => {
    for (const id of ids) { try { binding.releaseDraftAttachment?.(id); } catch { /* Keep the original failure retryable. */ } }
  };
  if (image) {
    try {
      const descriptors = binding.createDrafts!([new File([image.blob], image.fileName, { type: image.blob.type || 'image/png' })]);
      ids = descriptors.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0);
      if (ids.length !== 1) { release(); return { status: 'pending', reason: 'attachment-failed' }; }
    } catch { release(); return { status: 'pending', reason: 'attachment-failed' }; }
  }
  if (!current()) { release(); return { status: 'cancelled' }; }
  try {
    const result = await binding.sendMessage(request.text, ids, options.signal);
    // A positive Host admission owns the attachments even if navigation happened
    // meanwhile. Releasing/retrying them here could duplicate an accepted message.
    if (result?.kind === 'success') return { status: 'sent' };
    release();
    return current() ? { status: 'pending', reason: 'send-failed' } : { status: 'cancelled' };
  } catch {
    release();
    return current() ? { status: 'pending', reason: 'send-failed' } : { status: 'cancelled' };
  }
}
