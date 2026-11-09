import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/paragraphs.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const {
  buildPdfVisualLines,
  groupPdfVisualLines,
  findPdfParagraph,
} = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

const rect = (left, top, width, height = 12) => ({ left, top, width, height });
const fragment = (text, left, top, width, fontSize = 12, height = 12) => ({
  text, rect: rect(left, top, width, height), fontSize,
});
const recognize = fragments => groupPdfVisualLines(buildPdfVisualLines(fragments));
const texts = groups => groups.map(group => group.map(line => line.text).join('\n'));

test('nearby baselines and adjacent fragments form visual lines with retained newlines', () => {
  const groups = recognize([
    fragment('Hello', 50, 0, 42),
    fragment('world', 98, 0.5, 45, 12, 11.5),
    fragment('next line', 50, 14, 90),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].text, 'Hello world');
  assert.deepEqual(texts(groups), ['Hello world\nnext line']);
  assert.deepEqual(groups[0][0].rect, rect(50, 0, 93, 12));
});

test('aligned double columns stay in separate lines and paragraph chains', () => {
  const groups = recognize([
    fragment('Left one', 50, 0, 180),
    fragment('Right one', 350, 0, 180),
    fragment('Left two', 50, 16, 180),
    fragment('Right two', 350, 16, 180),
    fragment('Left three', 60, 32, 170),
    fragment('Right three', 350, 32, 180),
  ]);
  assert.deepEqual(texts(groups), [
    'Left one\nLeft two\nLeft three',
    'Right one\nRight two\nRight three',
  ]);
  assert.equal(buildPdfVisualLines([
    fragment('Left', 50, 0, 180), fragment('Right', 350, 0, 180),
  ]).length, 2);
});

test('vertical spacing and font-size changes split headings and paragraphs', () => {
  const groups = recognize([
    fragment('A large heading', 50, 0, 220, 20, 22),
    fragment('Body first line', 50, 28, 230),
    fragment('Body second line', 60, 42, 220),
    fragment('New paragraph', 50, 68, 230),
    fragment('Same paragraph', 50, 82, 230),
  ]);
  assert.deepEqual(texts(groups), [
    'A large heading',
    'Body first line\nBody second line',
    'New paragraph\nSame paragraph',
  ]);

  assert.deepEqual(texts(recognize([
    fragment('First', 50, 0, 200),
    fragment('Second after a large gap', 50, 40, 200),
  ])), ['First', 'Second after a large gap']);
});

test('block paragraphs with normal leading and no indent stay separate', () => {
  const line = (text, top) => fragment(text, 634, top, 430, 9.96, 9.953);
  const groups = recognize([
    line('Previous paragraph line', 225.516),
    line('to more motions therefore amounts to scaling up compute.', 237.484),
    line('SuperMimic addresses this inefficiency with a single learned, differentiable world model fit from', 253.875),
    line('logged simulator transitions. Backpropagation-through-time (BPTT) through short imagined roll-', 265.828),
    line('outs provides analytic policy gradients through the learned model, allowing one dynamics model to', 277.797),
    line('amortize learning across the entire mocap library. Because these gradients come from the learned', 289.75),
    line('model rather than from differentiating the simulator, SuperMimic remains compatible with rigid-', 301.719),
    line('body simulators, including those with non-smooth contacts and non-differentiable implementations.', 313.672),
    line('On one GPU, SuperMimic surpasses the normalized return of SONIC’s released checkpoint within', 330.063),
  ]);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].length, 6);
  assert.ok(groups[1][0].text.startsWith('SuperMimic addresses'));
  assert.ok(groups[1][5].text.startsWith('body simulators'));
});

test('a full-width line cannot bridge two columns through shared successors', () => {
  const groups = recognize([
    fragment('Introduction', 50, 0, 480),
    fragment('Left column', 50, 18, 180),
    fragment('Right column', 350, 18, 180),
    fragment('Left continuation', 50, 34, 180),
    fragment('Right continuation', 350, 34, 180),
  ]);
  const allText = texts(groups);
  assert.equal(allText.length, 3);
  assert.ok(allText.includes('Introduction'));
  assert.ok(allText.every(text => !(text.includes('Left') && text.includes('Right'))));
  assert.ok(allText.some(text => text.includes('Left column\nLeft continuation')));
  assert.ok(allText.some(text => text.includes('Right column\nRight continuation')));
});

function makeDomSpan(text, bounds, { marked = false, nonLeaf = false } = {}) {
  const span = {
    textContent: text,
    calls: 0,
    querySelector(selector) { return selector === 'span' && nonLeaf ? {} : null; },
    closest(selector) { return selector === '.markedContent' && marked ? span : null; },
    contains(target) { return target === span; },
    getBoundingClientRect() {
      span.calls++;
      return {
        ...bounds,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        x: bounds.left,
        y: bounds.top,
      };
    },
  };
  return span;
}

test('DOM lookup excludes markedContent, copies line rects and caches by layer', t => {
  const previousDOMRect = globalThis.DOMRect;
  globalThis.DOMRect = class DOMRectCopy {
    constructor(x, y, width, height) {
      this.x = x; this.y = y; this.left = x; this.top = y;
      this.width = width; this.height = height;
      this.right = x + width; this.bottom = y + height;
    }
  };
  t.after(() => {
    if (previousDOMRect === undefined) delete globalThis.DOMRect;
    else globalThis.DOMRect = previousDOMRect;
  });

  const firstBounds = rect(50, 0, 180);
  const first = makeDomSpan('First line', firstBounds);
  const second = makeDomSpan('Second line', rect(50, 14, 180));
  const marked = makeDomSpan('must not appear', rect(50, 28, 180), { marked: true });
  const empty = makeDomSpan('   ', rect(50, 28, 180));
  const wrapper = makeDomSpan('wrapper', rect(50, 28, 180), { nonLeaf: true });
  const spans = [first, second, marked, empty, wrapper];
  const layerBounds = rect(40, 100, 500, 600);
  const layer = {
    queryCount: 0,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontSize: '12px' }) } },
    contains: target => spans.includes(target),
    getBoundingClientRect: () => layerBounds,
    querySelectorAll(selector) {
      assert.equal(selector, 'span');
      layer.queryCount++;
      return spans;
    },
  };

  const paragraph = findPdfParagraph(second, layer, 2);
  assert.ok(paragraph);
  assert.equal(paragraph.key, 'pdf-2-paragraph-1');
  assert.equal(paragraph.text, 'First line\nSecond line');
  assert.deepEqual(paragraph.elements, [first, second]);
  assert.equal(paragraph.rects.length, 2);
  assert.ok(paragraph.rects[0] instanceof globalThis.DOMRect);
  assert.notEqual(paragraph.rects[0], firstBounds);
  assert.deepEqual(
    { left: paragraph.rects[0].left, top: paragraph.rects[0].top, width: paragraph.rects[0].width, height: paragraph.rects[0].height },
    firstBounds,
  );

  const readCount = first.calls + second.calls;
  assert.equal(findPdfParagraph(first, layer, 2), paragraph);
  assert.equal(layer.queryCount, 1);
  assert.equal(first.calls + second.calls, readCount);
  layerBounds.top += 200;
  assert.equal(findPdfParagraph(first, layer, 2), paragraph);
  assert.equal(paragraph.rects[0].top, firstBounds.top + 200);
  assert.equal(layer.queryCount, 1);
  assert.equal(findPdfParagraph({}, layer, 2), null);
});
