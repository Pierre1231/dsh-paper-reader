// Unit tests for the v0.6 main-thread work model: sliced scheduler, page
// memory budget, text-layer geometry and content identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function load(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
}
const { createTaskScheduler } = await load('taskScheduler');
const { createResidency } = await load('residency');
const { layoutTextItem, multiplyTransform, textLayerLanguage } = await load('textLayer');
const { pdfContentKey } = await load('contentKey');

function manualClock() {
  let now = 0; const posted = [];
  return {
    clock: { now: () => now, post: callback => posted.push(callback) },
    advance: ms => { now += ms; },
    runNext: () => { const callback = posted.shift(); assert.ok(callback, 'a slice was posted'); callback(); },
    get pending() { return posted.length; },
  };
}

test('scheduler runs the highest-priority job first and yields between slices', async () => {
  const time = manualClock();
  const scheduler = createTaskScheduler({ budgetMs: 6, clock: time.clock });
  const order = [];
  // Each step costs 4 ms of (fake) time; a job finishes after 3 steps.
  const job = (name, priority) => { let steps = 0; return { priority: () => priority, run: deadline => { while (time.clock.now() < deadline) { order.push(name); time.advance(4); if (++steps === 3) return true; } return false; } }; };
  const far = scheduler.run(job('far', 100));
  const visible = scheduler.run(job('visible', 0));
  assert.equal(time.pending, 1, 'one slice is posted, not one per job');
  time.runNext();
  assert.deepEqual(order, ['visible', 'visible'], 'a slice stops at its budget');
  time.runNext();
  assert.deepEqual(order.slice(2), ['visible', 'far'], 'a finished job hands the remaining budget to the next');
  while (time.pending) time.runNext();
  await Promise.all([visible, far]);
  assert.equal(order.filter(name => name === 'far').length, 3);
});

test('scheduler priority is re-read before every slice (scrolling reprioritises)', async () => {
  const time = manualClock();
  const scheduler = createTaskScheduler({ budgetMs: 5, clock: time.clock });
  let aPriority = 0; const order = [];
  const make = (name, priority) => { let left = 2; return { priority, run: () => { order.push(name); time.advance(10); return --left === 0; } }; };
  const a = scheduler.run(make('a', () => aPriority));
  const b = scheduler.run(make('b', () => 50));
  time.runNext();
  aPriority = 100;
  time.runNext();
  assert.deepEqual(order, ['a', 'b']);
  while (time.pending) time.runNext();
  await Promise.all([a, b]);
});

test('scheduler cancellation rejects with AbortError and drops the job', async () => {
  const time = manualClock();
  const scheduler = createTaskScheduler({ clock: time.clock });
  const controller = new AbortController();
  let ran = 0;
  const pending = scheduler.run({ priority: () => 0, run: () => { ran++; return false; } }, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  while (time.pending) time.runNext();
  assert.equal(ran, 0);
  assert.equal(scheduler.size, 0);
});

function fakePage(number, { distance, near = false, pinned = false, full = 0, placeholder = 0, text = false }) {
  const page = {
    number, events: [],
    state: { full, placeholder, text },
    distance: () => distance, near: () => near, pinned: () => pinned,
    fullBytes: () => page.state.full, placeholderBytes: () => page.state.placeholder, hasText: () => page.state.text,
    demote: () => { page.events.push('demote'); page.state.placeholder = page.state.full / 16; page.state.full = 0; },
    evict: () => { page.events.push('evict'); page.state.placeholder = 0; },
    dropText: () => { page.events.push('drop'); page.state.text = false; },
  };
  return page;
}

test('budget shrinks the farthest sharp pages first and never near or selected ones', () => {
  const residency = createResidency({ fullBytes: 300, fullPages: 3, placeholderBytes: 1000, textPages: 100 }, () => () => {});
  const pages = [
    fakePage(1, { distance: 5000, pinned: true, full: 100 }),
    fakePage(2, { distance: 4000, full: 100 }),
    fakePage(3, { distance: 3000, full: 100 }),
    fakePage(4, { distance: 0, near: true, full: 100 }),
    fakePage(5, { distance: 900, full: 100 }),
  ];
  pages.forEach(page => residency.register(page));
  residency.enforce();
  assert.deepEqual(pages.map(page => page.events.join()), ['', 'demote', 'demote', '', ''],
    'selected page 1 and visible page 4 stay sharp; the two farthest unselected pages shrink');
});

test('placeholders and text layers have their own budgets', () => {
  const residency = createResidency({ fullBytes: Infinity, fullPages: 100, placeholderBytes: 10, textPages: 2 }, () => () => {});
  const pages = [
    fakePage(1, { distance: 900, placeholder: 6, text: true }),
    fakePage(2, { distance: 600, placeholder: 6, text: true }),
    fakePage(3, { distance: 0, near: true, placeholder: 6, text: true }),
  ];
  pages.forEach(page => residency.register(page));
  residency.enforce();
  assert.deepEqual(pages.map(page => page.events.join()), ['evict,drop', 'evict', ''],
    'farthest placeholders are cleared until within budget; the farthest text layer is dropped');
});

test('touch coalesces budget checks', () => {
  let scheduled = 0; let run;
  const residency = createResidency(undefined, callback => { scheduled++; run = callback; return () => {}; });
  residency.touch(); residency.touch(); residency.touch();
  assert.equal(scheduled, 1);
  run();
  residency.touch();
  assert.equal(scheduled, 2);
});

test('text geometry matches pdf.js 4.10.38 for an unrotated page', () => {
  // US Letter page, viewport transform at scale 1: [1,0,0,-1,0,792].
  const viewport = [1, 0, 0, -1, 0, 792];
  const item = { str: 'Attention', transform: [10, 0, 0, 10, 72, 700], width: 45, height: 10 };
  const layout = layoutTextItem(item, { vertical: false }, viewport, 612, 792, 0.8);
  // tx = [10,0,0,-10,72,92]; top = 92 - 10*0.8 = 84.
  assert.equal(layout.fontHeight, 10);
  assert.equal(layout.angle, 0);
  assert.ok(Math.abs(layout.left - 100 * 72 / 612) < 1e-9);
  assert.ok(Math.abs(layout.top - 100 * 84 / 792) < 1e-9);
  assert.equal(layout.canvasWidth, 45, 'multi-character runs are stretched to the PDF width');
  const single = layoutTextItem({ ...item, str: 'x' }, { vertical: false }, viewport, 612, 792, 0.8);
  assert.equal(single.canvasWidth, 0, 'single glyphs are not stretched');
});

test('rotated pages are laid out in display space, not with a CSS-rotated layer', () => {
  // 90° page rotation: viewport transform maps PDF x→display y.
  const viewport = [0, 1, 1, 0, 0, 0];
  const layout = layoutTextItem({ str: 'ab', transform: [10, 0, 0, 10, 100, 200], width: 12, height: 10 }, { vertical: false }, viewport, 792, 612, 0.8);
  assert.equal(Math.round(layout.angle), 90);
  assert.deepEqual(multiplyTransform([1, 0, 0, 1, 5, 6], [2, 0, 0, 2, 1, 1]), [2, 0, 0, 2, 6, 7]);
});

test('text layer language is explicit and never empty', () => {
  assert.equal(textLayerLanguage(null), 'en');
  assert.equal(textLayerLanguage(''), 'en');
  assert.equal(textLayerLanguage('  '), 'en');
  assert.equal(textLayerLanguage('zh-CN'), 'zh-CN');
});

test('content key ignores array identity and detects any byte change', () => {
  const bytes = new Uint8Array(4099).map((_, index) => (index * 31) & 255);
  const copy = bytes.slice();
  assert.equal(pdfContentKey(copy), pdfContentKey(bytes), 'a host-made copy maps to the same document');
  const offset = new Uint8Array(bytes.length + 1); offset.set(bytes, 1);
  assert.equal(pdfContentKey(offset.subarray(1)), pdfContentKey(bytes), 'unaligned views hash the same bytes');
  for (const index of [0, 2048, 4098]) {
    const changed = bytes.slice(); changed[index] ^= 1;
    assert.notEqual(pdfContentKey(changed), pdfContentKey(bytes), `byte ${index} changes the key`);
  }
  assert.notEqual(pdfContentKey(bytes.subarray(0, 4098)), pdfContentKey(bytes));
});
