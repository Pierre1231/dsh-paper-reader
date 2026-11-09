import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/draftBridge.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
const { createDraftRequest, createReferenceDraftRequest, createInlineQuoteReference, serializeInlineQuote, insertInlineReferenceDraft, insertTextReferenceDraft, createFigureDraftRequest, insertFigureDraft, captureDraftInsertion, insertDraftRequest, retryDraftInsertion, copyDraftRequest } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

const selection = () => ({ sessionId: 'session-1', fileName: 'paper.pdf', page: 3, text: '原始选段\nsecond line' });
const makeEditor = () => {
  let draft = 'existing draft';
  let rev = 1;
  let locked = false;
  const actions = {
    captureInsertion: () => ({ start: 0, end: 8, draftRev: rev }),
    insertText(text, span) {
      if (locked || span.draftRev !== rev) return false;
      draft = draft.slice(0, span.start) + text + draft.slice(span.end);
      rev++;
      return true;
    },
    submit() { throw new Error('must not submit'); },
  };
  return {
    actions,
    binding: { sessionId: 'session-1', inputActions: actions },
    changeDraft(value) { draft = value; rev++; },
    setLocked(value) { locked = value; },
    draft: () => draft,
  };
};

test('all actions snapshot selection, include source and produce distinct drafts', () => {
  const selected = selection();
  const requests = ['explain', 'translate', 'ask'].map(action => createDraftRequest(selected, action));
  selected.text = 'changed';
  for (const request of requests) {
    assert.match(request.text, /paper\.pdf，第 3 页/);
    assert.match(request.text, /原始选段\nsecond line/);
    assert.equal(request.selection.text, '原始选段\nsecond line');
  }
  assert.match(requests[0].text, /解释/);
  assert.match(requests[1].text, /翻译/);
  assert.match(requests[2].text, /问题/);
  assert.throws(() => createDraftRequest({ ...selection(), page: 0 }, 'ask'), TypeError);
  assert.throws(() => createDraftRequest({ ...selection(), sessionId: ' ' }, 'ask'), TypeError);
});

test('cross-page selections retain and validate inclusive ending page', () => {
  const request = createDraftRequest({ ...selection(), pageEnd: 5 }, 'ask');
  assert.equal(request.selection.pageEnd, 5);
  assert.match(request.text, /paper\.pdf，第 3–5 页/);
  const samePage = createDraftRequest({ ...selection(), pageEnd: 3 }, 'ask');
  assert.match(samePage.text, /paper\.pdf，第 3 页/);
  assert.throws(() => createDraftRequest({ ...selection(), pageEnd: 2 }, 'ask'), TypeError);
  assert.throws(() => createDraftRequest({ ...selection(), pageEnd: 3.5 }, 'ask'), TypeError);
});

test('insert preserves selected draft text and never submits', () => {
  const editor = makeEditor();
  const request = createDraftRequest(selection(), 'explain');
  const prepared = captureDraftInsertion(request, editor.binding);
  assert.deepEqual(prepared.span, { start: 8, end: 8, draftRev: 1 });
  assert.equal(insertDraftRequest(prepared, editor.binding).status, 'inserted');
  assert.equal(editor.draft(), `existing${request.text} draft`);
});

test('stale revision and locked editor keep the selection and draft for explicit retry', () => {
  const editor = makeEditor();
  const request = createDraftRequest(selection(), 'translate');
  const prepared = captureDraftInsertion(request, editor.binding);
  editor.changeDraft('new draft');
  let result = insertDraftRequest(prepared, editor.binding);
  assert.equal(result.reason, 'insert-rejected');
  assert.equal(result.request, request);
  assert.equal(editor.draft(), 'new draft');
  editor.setLocked(true);
  result = retryDraftInsertion(request, editor.binding);
  assert.equal(result.reason, 'insert-rejected');
  assert.equal(editor.draft(), 'new draft');
  editor.setLocked(false);
  assert.equal(retryDraftInsertion(request, editor.binding).status, 'inserted');
  assert.equal(editor.draft(), `new draf${request.text}t`);
});

test('exact session and editor identity required at capture and insertion', () => {
  const editor = makeEditor();
  const request = createDraftRequest(selection(), 'ask');
  const wrong = { sessionId: 'session-1 ', inputActions: editor.actions };
  assert.equal(captureDraftInsertion(request, wrong).failure, 'session-mismatch');
  assert.equal(retryDraftInsertion(request, wrong).reason, 'session-mismatch');
  const prepared = captureDraftInsertion(request, editor.binding);
  assert.equal(insertDraftRequest(prepared, wrong).reason, 'session-mismatch');
  const replacement = makeEditor();
  assert.equal(insertDraftRequest(prepared, replacement.binding).reason, 'input-unavailable');
  assert.equal(editor.draft(), 'existing draft');
  assert.equal(replacement.draft(), 'existing draft');
  assert.equal(retryDraftInsertion(request, replacement.binding).status, 'inserted');
});

test('missing, invalid and throwing APIs fail safely and keep copyable request', async () => {
  const request = createDraftRequest(selection(), 'explain');
  const binding = { sessionId: 'session-1' };
  assert.equal(retryDraftInsertion(request, binding).reason, 'input-unavailable');
  binding.inputActions = { captureInsertion: () => { throw Error(); }, insertText: () => true };
  assert.equal(retryDraftInsertion(request, binding).reason, 'capture-failed');
  binding.inputActions = { captureInsertion: () => ({ start: 0, end: 0 }), insertText: () => true };
  assert.equal(retryDraftInsertion(request, binding).reason, 'capture-failed');
  binding.inputActions = { captureInsertion: () => ({ start: 0, end: 0, draftRev: 0 }), insertText: () => { throw Error(); } };
  const failure = retryDraftInsertion(request, binding);
  assert.equal(failure.reason, 'insert-failed');
  assert.equal(failure.request.selection.text, selection().text);
  assert.equal((await copyDraftRequest(request)).status, 'copy-failed');
  assert.equal((await copyDraftRequest(request, async () => { throw Error(); })).status, 'copy-failed');
  let copied = '';
  assert.equal((await copyDraftRequest(request, async text => { copied = text; })).status, 'copied');
  assert.equal(copied, request.text);
});

test('figure explanation attaches a real PNG draft and never submits', async () => {
  const editor = makeEditor();
  const attached = [];
  const released = [];
  editor.actions.addAttachments = ids => { attached.push(...ids); return true; };
  editor.actions.removeAttachment = id => { attached.splice(attached.indexOf(id), 1); };
  const binding = {
    ...editor.binding,
    createDrafts: files => files.map(file => ({ id: 'figure-1', file })),
    releaseDraftAttachment: id => released.push(id),
  };
  const request = createFigureDraftRequest(selection());
  assert.equal(request.text, '解释这张图表');
  const result = await insertFigureDraft(request, { blob: new Blob(['png'], { type: 'image/png' }), fileName: 'figure.png' }, binding);
  assert.equal(result.status, 'inserted');
  assert.deepEqual(attached, ['figure-1']);
  assert.deepEqual(released, []);
  assert.match(editor.draft(), /解释这张图表/);
});

test('figure attachment failures release resources and preserve the draft', async () => {
  const editor = makeEditor();
  const released = [];
  editor.actions.addAttachments = () => false;
  const binding = {
    ...editor.binding,
    createDrafts: () => [{ id: 'figure-2' }],
    releaseDraftAttachment: id => released.push(id),
  };
  const request = createFigureDraftRequest(selection());
  const result = await insertFigureDraft(request, { blob: new Blob(['png'], { type: 'image/png' }), fileName: 'figure.png' }, binding);
  assert.equal(result.reason, 'attachment-failed');
  assert.deepEqual(released, ['figure-2']);
  assert.equal(editor.draft(), 'existing draft');
  assert.equal((await insertFigureDraft(request, { blob: new Blob(['png']), fileName: 'figure.png' }, editor.binding)).reason, 'attachment-unavailable');
});

test('text rejection after attachment removes and releases the image', async () => {
  const editor = makeEditor();
  const released = [];
  const removed = [];
  editor.actions.addAttachments = () => true;
  editor.actions.removeAttachment = id => { removed.push(id); };
  const binding = {
    ...editor.binding,
    createDrafts: () => { editor.changeDraft('changed elsewhere'); return [{ id: 'figure-3' }]; },
    releaseDraftAttachment: id => released.push(id),
  };
  const result = await insertFigureDraft(createFigureDraftRequest(selection()), { blob: new Blob(['png']), fileName: 'figure.png' }, binding);
  assert.equal(result.reason, 'insert-rejected');
  assert.deepEqual(removed, ['figure-3']);
  assert.deepEqual(released, ['figure-3']);
  assert.equal(editor.draft(), 'changed elsewhere');
});

test('long text references keep the composer short while the attachment preserves full text', async () => {
  const editor = makeEditor();
  const attached = [];
  let uploaded;
  editor.actions.addAttachments = ids => { attached.push(...ids); return true; };
  const binding = {
    ...editor.binding,
    createDrafts: files => { uploaded = files[0]; return [{ id: 'quote-1' }]; },
  };
  const request = createReferenceDraftRequest(selection(), 'translate');
  assert.doesNotMatch(request.text, /原始选段/);
  const result = await insertTextReferenceDraft(request, binding);
  assert.equal(result.status, 'inserted');
  assert.deepEqual(attached, ['quote-1']);
  assert.equal(uploaded.type, 'text/markdown');
  assert.match(await uploaded.text(), /原始选段\nsecond line/);
  assert.match(await uploaded.text(), /第 3 页/);
  assert.doesNotMatch(editor.draft(), /原始选段/);
  assert.match(editor.draft(), /翻译为中文/);
});

test('text reference insertion failure removes and releases the attachment', async () => {
  const editor = makeEditor();
  const removed = [];
  const released = [];
  editor.actions.addAttachments = () => true;
  editor.actions.removeAttachment = id => { removed.push(id); };
  const binding = {
    ...editor.binding,
    createDrafts: () => { editor.changeDraft('busy'); return [{ id: 'quote-2' }]; },
    releaseDraftAttachment: id => released.push(id),
  };
  const result = await insertTextReferenceDraft(createReferenceDraftRequest(selection(), 'explain'), binding);
  assert.equal(result.reason, 'insert-rejected');
  assert.deepEqual(removed, ['quote-2']);
  assert.deepEqual(released, ['quote-2']);
  assert.equal(editor.draft(), 'busy');
});

test('inline quote chips preserve full text in a self-contained serializable payload', async () => {
  const editor = makeEditor();
  let insertedReference;
  const binding = {
    ...editor.binding,
    insertReference(reference, span) { insertedReference = { reference, span }; return true; },
  };
  const request = createReferenceDraftRequest(selection(), 'translate');
  const result = await insertInlineReferenceDraft(request, binding);
  assert.equal(result.status, 'inserted');
  assert.equal(insertedReference.reference.source, 'paper-reader-quote');
  assert.equal(insertedReference.span.start, 8);
  assert.match(insertedReference.reference.label, /第3页/);
  assert.doesNotMatch(editor.draft(), /原始选段/);
  assert.match(editor.draft(), /翻译为中文/);
  const modelText = serializeInlineQuote(insertedReference.reference.ref);
  assert.match(modelText, /原始选段\nsecond line/);
  assert.match(modelText, /paper\.pdf，第 3 页/);
  const reference = createInlineQuoteReference(selection());
  assert.equal(reference.appearance, 'file');
});

test('inline chip insertion failure does not leak text or submit', async () => {
  const editor = makeEditor();
  const request = createReferenceDraftRequest(selection(), 'explain');
  assert.equal((await insertInlineReferenceDraft(request, editor.binding)).reason, 'attachment-unavailable');
  const binding = { ...editor.binding, insertReference: () => false };
  assert.equal((await insertInlineReferenceDraft(request, binding)).reason, 'attachment-failed');
  assert.equal(editor.draft(), 'existing draft');
});
