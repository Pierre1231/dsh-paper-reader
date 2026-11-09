import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/renderQueue.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { createPdfRenderQueue } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
function setup() {
  const frames = new Map(); let next = 0;
  const queue = createPdfRenderQueue({ request: callback => { frames.set(++next, callback); return next; }, cancel: id => frames.delete(id) });
  const tick = () => { const frame = frames.entries().next().value; assert.ok(frame); frames.delete(frame[0]); frame[1](0); };
  return { queue, frames, tick };
}

test('visible page work gets priority and only one continuation runs in each frame', () => {
  const { queue, frames, tick } = setup(); const ran = [];
  queue.schedule(() => ran.push('prefetch'), () => 100000);
  queue.schedule(() => ran.push('visible'), () => 0);
  queue.schedule(() => ran.push('nearby'), () => 100010);
  assert.equal(frames.size, 1);
  tick(); assert.deepEqual(ran, ['visible']);
  tick(); assert.deepEqual(ran, ['visible', 'prefetch']);
  tick(); assert.deepEqual(ran, ['visible', 'prefetch', 'nearby']);
  assert.equal(frames.size, 0);
});

test('a viewport jump reprioritizes work that has already been queued', () => {
  const { queue, tick } = setup(); let page = 1; const ran = [];
  queue.schedule(() => ran.push(1), () => page === 1 ? 0 : 1000);
  queue.schedule(() => ran.push(9), () => page === 9 ? 0 : 1000);
  page = 9; tick(); assert.deepEqual(ran, [9]);
});

test('cancelled and cleared page work cannot start; clearing is reusable for effect replay', () => {
  const { queue, frames, tick } = setup(); const ran = [];
  const cancel = queue.schedule(() => ran.push('cancelled'), () => 0);
  cancel(); assert.equal(frames.size, 0);
  queue.schedule(() => ran.push('unmounted'), () => 0);
  queue.clear(); assert.equal(frames.size, 0);
  queue.schedule(() => ran.push('remounted'), () => 0);
  tick(); assert.deepEqual(ran, ['remounted']);
});

test('a continuation that schedules its next chunk still yields to another frame', () => {
  const { queue, tick } = setup(); const ran = [];
  queue.schedule(() => { ran.push('chunk1'); queue.schedule(() => ran.push('chunk2'), () => 0); }, () => 0);
  tick(); assert.deepEqual(ran, ['chunk1']);
  tick(); assert.deepEqual(ran, ['chunk1', 'chunk2']);
});
