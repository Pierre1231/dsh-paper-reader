import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/sendBridge.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { sendReadingRequest } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
const selected = (action = 'explain', text = '请解释以下 PDF 选段：\n\n来源：paper.pdf，第 3 页\n\n完整原文') => ({ request: { action, selection: { sessionId: 'one', fileName: 'paper.pdf', page: 3, text: '完整原文' }, text } });
const setup = () => {
  const sent = [], released = [];
  const binding = { sessionId: 'one',
    inputActions: { captureInsertion() { throw Error('must preserve composer'); }, insertText() { throw Error('must preserve composer'); }, submit() { throw Error('must not submit unrelated draft'); } },
    createDrafts: files => files.map(file => ({ id: 'png', file })),
    releaseDraftAttachment: id => released.push(id),
    sendMessage: async (text, ids, signal) => { sent.push({ text, ids, signal }); return { kind: 'success' }; },
  };
  return { binding, sent, released };
};

test('explain and translate directly send only the selected request, without touching the composer', async () => {
  for (const action of ['explain', 'translate']) {
    const { binding, sent } = setup();
    const selection = selected(action);
    assert.equal((await sendReadingRequest(selection, binding)).status, 'sent');
    assert.deepEqual(sent.map(item => [item.text, item.ids]), [[selection.request.text, []]]);
  }
});

test('long passages reach the sender in full with source and page', async () => {
  const { binding, sent } = setup();
  const text = '来源：paper.pdf，第 3 页\n\n' + '世界模型的完整原文。'.repeat(200) + '\n\n翻译为中文';
  await sendReadingRequest(selected('translate', text), binding);
  assert.equal(sent[0].text, text);
});

test('ask remains a manual action and never invokes the sender', async () => {
  const { binding, sent } = setup();
  assert.deepEqual(await sendReadingRequest(selected('ask'), binding), { status: 'pending', reason: 'manual-action' });
  assert.equal(sent.length, 0);
});

test('missing sender and wrong session fail without inserting or sending anything', async () => {
  const { binding, sent } = setup();
  assert.equal((await sendReadingRequest(selected(), null)).reason, 'session-mismatch');
  assert.equal((await sendReadingRequest(selected(), { ...binding, sessionId: 'other' })).reason, 'session-mismatch');
  assert.equal((await sendReadingRequest(selected(), { ...binding, sendMessage: undefined })).reason, 'send-unavailable');
  assert.equal(sent.length, 0);
});

test('PNG is registered before one combined image-and-text admission; success transfers ownership', async () => {
  const { binding, sent, released } = setup();
  let registered;
  binding.createDrafts = files => { registered = files[0]; return [{ id: 'figure' }]; };
  const image = { blob: new Blob(['actual PNG bytes'], { type: 'image/png' }), fileName: 'paper-第3页图表.png' };
  assert.equal((await sendReadingRequest({ ...selected('explain', '解释这张图表'), image }, binding)).status, 'sent');
  assert.deepEqual(sent[0].ids, ['figure']);
  assert.equal(sent[0].text, '解释这张图表');
  assert.equal(registered.name, image.fileName);
  assert.equal(await registered.text(), 'actual PNG bytes');
  assert.deepEqual(released, []);
});

test('failed or thrown admissions retain the request and release temporary image registrations', async () => {
  for (const fail of [async () => ({ kind: 'error' }), async () => { throw Error('offline'); }]) {
    const { binding, released } = setup(); binding.sendMessage = fail;
    const reading = { ...selected(), image: { blob: new Blob(['png']), fileName: 'figure.png' } };
    assert.deepEqual(await sendReadingRequest(reading, binding), { status: 'pending', reason: 'send-failed' });
    assert.deepEqual(released, ['png']);
    assert.equal(reading.image.blob.size, 3, 'the immutable source remains available for an explicit retry');
  }
});

test('attachment setup failures never send a bare figure prompt', async () => {
  const { binding, sent } = setup();
  const reading = { ...selected(), image: { blob: new Blob(['png']), fileName: 'figure.png' } };
  assert.equal((await sendReadingRequest(reading, { ...binding, createDrafts: undefined })).reason, 'attachment-unavailable');
  binding.createDrafts = () => [];
  assert.equal((await sendReadingRequest(reading, binding)).reason, 'attachment-failed');
  assert.equal(sent.length, 0);
});

test('navigation before admission cancels and cleans up a prepared image', async () => {
  const { binding, sent, released } = setup();
  let live = true;
  binding.createDrafts = () => { live = false; return [{ id: 'outgoing' }]; };
  const reading = { ...selected(), image: { blob: new Blob(['png']), fileName: 'figure.png' } };
  assert.equal((await sendReadingRequest(reading, binding, { isCurrent: () => live })).status, 'cancelled');
  assert.equal(sent.length, 0);
  assert.deepEqual(released, ['outgoing']);
});

test('aborted requests do not send, and live signals are forwarded to the host', async () => {
  const { binding, sent } = setup(); const controller = new AbortController(); controller.abort();
  assert.equal((await sendReadingRequest(selected(), binding, { signal: controller.signal })).status, 'cancelled');
  const live = new AbortController();
  await sendReadingRequest(selected(), binding, { signal: live.signal });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].signal, live.signal);
});

test('positive host acceptance is never misreported as retryable after navigation', async () => {
  const { binding, released } = setup(); const controller = new AbortController();
  binding.sendMessage = async () => { controller.abort(); return { kind: 'success' }; };
  assert.equal((await sendReadingRequest({ ...selected(), image: { blob: new Blob(['png']), fileName: 'figure.png' } }, binding, { signal: controller.signal })).status, 'sent');
  assert.deepEqual(released, []);
});
