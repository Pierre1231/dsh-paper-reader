/** Plain-text bridge between PDF selections and a DSH conversation input slot. */
export type SelectionAction = 'explain' | 'translate' | 'ask';

export interface PdfSelection {
  /** The session that owns the PDF selection; never inferred from the active tab. */
  sessionId: string;
  fileName: string;
  /** One-based PDF page number. */
  page: number;
  /** Optional inclusive ending page for a selection spanning multiple pages. */
  pageEnd?: number;
  text: string;
}

/** The current DSH InputActions insertion token, in editor detect coordinates. */
export interface InsertionSpan {
  start: number;
  end: number;
  draftRev: number;
}

/** The public portion of the inputActions slot prop used by this bridge. */
export interface DraftInputActions {
  captureInsertion(): InsertionSpan;
  insertText(text: string, span: InsertionSpan): boolean;
  addAttachments?(ids: string[]): boolean;
  removeAttachment?(id: string): void;
}

/** Supply this from the live session-scoped slot, not from a global last-used editor. */
export interface DraftQuoteReference {
  source: 'paper-reader-quote';
  ref: string;
  label: string;
  clipboardText: string;
  appearance: 'file';
}

export interface DraftBinding {
  sessionId: string;
  inputActions?: DraftInputActions | null;
  createDrafts?: (files: File[]) => Array<{ id: string }>;
  releaseDraftAttachment?: (id: string) => void;
  insertReference?: (reference: DraftQuoteReference, span: InsertionSpan) => boolean;
  /** Explicit session-addressed admission; never submits the user's composer. */
  sendMessage?: (text: string, attachmentIds: string[], signal?: AbortSignal) => Promise<{ kind: 'success' | 'error' }>;
}

export interface DraftRequest {
  readonly selection: Readonly<PdfSelection>;
  readonly action: SelectionAction;
  /** A complete, copyable draft. No operation in this module submits it. */
  readonly text: string;
}

export type DraftFailure = 'session-mismatch' | 'input-unavailable' | 'capture-failed' | 'insert-rejected' | 'insert-failed' | 'attachment-unavailable' | 'attachment-failed';

export interface PreparedDraftInsertion {
  readonly request: DraftRequest;
  readonly span?: Readonly<InsertionSpan>;
  /** Identity prevents a captured revision being used against another editor instance. */
  readonly inputActions?: DraftInputActions;
  readonly failure?: DraftFailure;
}

export type DraftInsertionResult =
  | { status: 'inserted'; request: DraftRequest }
  | { status: 'pending'; reason: DraftFailure; request: DraftRequest; referenceInserted?: boolean };

const instructions: Record<SelectionAction, string> = {
  explain: '请解释以下 PDF 选段：',
  translate: '请翻译以下 PDF 选段：',
  ask: '请根据以下 PDF 选段回答我的问题：',
};

/** Snapshot the selected passage before the viewer or browser selection changes. */
export function createDraftRequest(selection: PdfSelection, action: SelectionAction): DraftRequest {
  if (!selection || typeof selection.sessionId !== 'string' || !selection.sessionId.trim() ||
      typeof selection.fileName !== 'string' || !selection.fileName.trim() ||
      !Number.isSafeInteger(selection.page) || selection.page < 1 ||
      (selection.pageEnd !== undefined && (!Number.isSafeInteger(selection.pageEnd) || selection.pageEnd < selection.page)) ||
      typeof selection.text !== 'string' || !selection.text.trim() ||
      !Object.prototype.hasOwnProperty.call(instructions, action)) {
    throw new TypeError('A session, filename, one-based page, selected text and valid action are required');
  }
  const snapshot = Object.freeze({
    sessionId: selection.sessionId,
    fileName: selection.fileName,
    page: selection.page,
    ...(selection.pageEnd === undefined ? {} : { pageEnd: selection.pageEnd }),
    text: selection.text,
  });
  return Object.freeze({
    selection: snapshot,
    action,
    text: `${instructions[action]}\n\n来源：${snapshot.fileName}，第 ${snapshot.page}${snapshot.pageEnd !== undefined && snapshot.pageEnd !== snapshot.page ? `–${snapshot.pageEnd}` : ''} 页\n\n${snapshot.text}`,
  });
}

export function createFigureDraftRequest(selection: PdfSelection): DraftRequest {
  const base = createDraftRequest(selection, 'explain');
  return Object.freeze({
    selection: base.selection,
    action: 'explain',
    text: '解释这张图表',
  });
}

export function createReferenceDraftRequest(selection: PdfSelection, action: SelectionAction): DraftRequest {
  const base = createDraftRequest(selection, action);
  const prompts: Record<SelectionAction, string> = {
    explain: '解释这段选段',
    translate: '翻译为中文',
    ask: '根据这段选段回答：',
  };
  return Object.freeze({
    selection: base.selection,
    action,
    text: prompts[action],
  });
}

export function createInlineQuoteReference(selection: PdfSelection): DraftQuoteReference {
  createDraftRequest(selection, 'explain');
  const pages = `${selection.page}${selection.pageEnd !== undefined && selection.pageEnd !== selection.page ? `–${selection.pageEnd}` : ''}`;
  return {
    source: 'paper-reader-quote',
    ref: JSON.stringify({ v: 1, sessionId: selection.sessionId, fileName: selection.fileName, page: selection.page, pageEnd: selection.pageEnd, text: selection.text }),
    label: `PDF选段 · 第${pages}页`,
    clipboardText: `@PDF选段-第${pages}页`,
    appearance: 'file',
  };
}

/** Expand the self-contained chip payload when the user sends the draft. */
export function serializeInlineQuote(ref: string): string {
  const quote = JSON.parse(ref) as { v?: number; sessionId?: string; fileName?: string; page?: number; pageEnd?: number; text?: string };
  if (quote.v !== 1 || typeof quote.sessionId !== 'string' || !quote.sessionId || typeof quote.fileName !== 'string' || !quote.fileName ||
      !Number.isSafeInteger(quote.page) || (quote.page ?? 0) < 1 || typeof quote.text !== 'string' || !quote.text.trim()) {
    throw new Error('Invalid paper quote reference');
  }
  const pages = `${quote.page}${quote.pageEnd !== undefined && quote.pageEnd !== quote.page ? `–${quote.pageEnd}` : ''}`;
  return `来源：${quote.fileName}，第 ${pages} 页\n\n${quote.text}`;
}

/** Capture before any asynchronous work. Only the owning live slot can be used. */
export function captureDraftInsertion(request: DraftRequest, binding?: DraftBinding | null): PreparedDraftInsertion {
  if (!binding || binding.sessionId !== request.selection.sessionId) {
    return { request, failure: 'session-mismatch' };
  }
  const actions = binding.inputActions;
  if (!actions || typeof actions.captureInsertion !== 'function' || typeof actions.insertText !== 'function') {
    return { request, failure: 'input-unavailable' };
  }
  try {
    const span = actions.captureInsertion();
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) ||
        span.start < 0 || span.end < span.start || !Number.isSafeInteger(span.draftRev) || span.draftRev < 0) {
      return { request, failure: 'capture-failed' };
    }
    // A selection in the draft belongs to the user. Insert after it instead of replacing it.
    return { request, inputActions: actions, span: Object.freeze({ start: span.end, end: span.end, draftRev: span.draftRev }) };
  } catch {
    return { request, failure: 'capture-failed' };
  }
}

/** Attempt once against the same session and editor instance captured above. */
export function insertDraftRequest(prepared: PreparedDraftInsertion, binding?: DraftBinding | null): DraftInsertionResult {
  const { request } = prepared;
  if (!binding || binding.sessionId !== request.selection.sessionId) {
    return { status: 'pending', reason: 'session-mismatch', request };
  }
  if (prepared.failure) return { status: 'pending', reason: prepared.failure, request };
  if (!prepared.inputActions || binding.inputActions !== prepared.inputActions || !prepared.span) {
    return { status: 'pending', reason: 'input-unavailable', request };
  }
  try {
    return prepared.inputActions.insertText(request.text, prepared.span) === true
      ? { status: 'inserted', request }
      : { status: 'pending', reason: 'insert-rejected', request };
  } catch {
    return { status: 'pending', reason: 'insert-failed', request };
  }
}

/** Insert a compact semantic chip, then append the short instruction. */
export async function insertInlineReferenceDraft(
  request: DraftRequest,
  binding?: DraftBinding | null,
): Promise<DraftInsertionResult> {
  const prepared = captureDraftInsertion(request, binding);
  if (prepared.failure) return { status: 'pending', reason: prepared.failure, request };
  if (!binding?.insertReference || !prepared.span) return { status: 'pending', reason: 'attachment-unavailable', request };
  let inserted = false;
  try {
    inserted = binding.insertReference(createInlineQuoteReference(request.selection), prepared.span) === true;
  } catch { inserted = false; }
  if (!inserted) return { status: 'pending', reason: 'attachment-failed', request };
  const result = retryDraftInsertion(request, binding);
  return result.status === 'pending' ? { ...result, referenceInserted: true } : result;
}

/** Attach a figure image and insert its prompt without ever submitting the draft. */
export async function insertFigureDraft(
  request: DraftRequest,
  image: { blob: Blob; fileName: string },
  binding?: DraftBinding | null,
): Promise<DraftInsertionResult> {
  const prepared = captureDraftInsertion(request, binding);
  if (prepared.failure) return { status: 'pending', reason: prepared.failure, request };
  const actions = binding?.inputActions;
  if (!binding?.createDrafts || !actions?.addAttachments) {
    return { status: 'pending', reason: 'attachment-unavailable', request };
  }
  let attachmentId = '';
  try {
    const file = new File([image.blob], image.fileName, { type: image.blob.type || 'image/png' });
    const drafts = binding.createDrafts([file]);
    attachmentId = drafts[0]?.id || '';
    if (!attachmentId) return { status: 'pending', reason: 'attachment-failed', request };
    if (actions.addAttachments([attachmentId]) !== true) {
      binding.releaseDraftAttachment?.(attachmentId);
      return { status: 'pending', reason: 'attachment-failed', request };
    }
  } catch {
    if (attachmentId) binding.releaseDraftAttachment?.(attachmentId);
    return { status: 'pending', reason: 'attachment-failed', request };
  }
  const result = insertDraftRequest(prepared, binding);
  if (result.status !== 'inserted') {
    actions.removeAttachment?.(attachmentId);
    binding.releaseDraftAttachment?.(attachmentId);
  }
  return result;
}

/** Attach the full passage as a compact file reference and insert only a short prompt. */
export async function insertTextReferenceDraft(
  request: DraftRequest,
  binding?: DraftBinding | null,
): Promise<DraftInsertionResult> {
  const prepared = captureDraftInsertion(request, binding);
  if (prepared.failure) return { status: 'pending', reason: prepared.failure, request };
  const actions = binding?.inputActions;
  if (!binding?.createDrafts || !actions?.addAttachments) {
    return { status: 'pending', reason: 'attachment-unavailable', request };
  }
  const { selection } = request;
  const pages = `${selection.page}${selection.pageEnd !== undefined && selection.pageEnd !== selection.page ? `–${selection.pageEnd}` : ''}`;
  let attachmentId = '';
  try {
    const content = `来源：${selection.fileName}，第 ${pages} 页\n\n${selection.text}`;
    const file = new File([content], `PDF选段-第${pages}页.md`, { type: 'text/markdown' });
    const drafts = binding.createDrafts([file]);
    attachmentId = drafts[0]?.id || '';
    if (!attachmentId) return { status: 'pending', reason: 'attachment-failed', request };
    if (actions.addAttachments([attachmentId]) !== true) {
      binding.releaseDraftAttachment?.(attachmentId);
      return { status: 'pending', reason: 'attachment-failed', request };
    }
  } catch {
    if (attachmentId) binding.releaseDraftAttachment?.(attachmentId);
    return { status: 'pending', reason: 'attachment-failed', request };
  }
  const result = insertDraftRequest(prepared, binding);
  if (result.status !== 'inserted') {
    actions.removeAttachment?.(attachmentId);
    binding.releaseDraftAttachment?.(attachmentId);
  }
  return result;
}

/** Explicit user retry: take a new revision and current caret from the live slot. */
export function retryDraftInsertion(request: DraftRequest, binding?: DraftBinding | null): DraftInsertionResult {
  return insertDraftRequest(captureDraftInsertion(request, binding), binding);
}

/** Explicit user copy. Inject the platform clipboard writer; failed copies keep the request. */
export async function copyDraftRequest(
  request: DraftRequest,
  writeText?: ((text: string) => Promise<void>) | null,
): Promise<{ status: 'copied' | 'copy-failed'; request: DraftRequest }> {
  if (!writeText) return { status: 'copy-failed', request };
  try {
    await writeText(request.text);
    return { status: 'copied', request };
  } catch {
    return { status: 'copy-failed', request };
  }
}
