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
  attachPdfScripts,
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

// Display equation (1) of "Attention Is All You Need", in CSS px at scale 1
// (top = page height - PDF baseline - ascent). Numerator and denominator sit
// on their own baselines, scripts are 7 px.
const equation = () => [
  fragment('Attention(', 220, 472.8, 45.7, 10, 10),
  fragment('Q, K, V', 265.6, 472.8, 31.2, 10, 10),
  fragment(') = softmax(', 299.0, 472.8, 55.4, 10, 10),
  fragment('QK', 355.6, 466.0, 16.3, 10, 10),
  fragment('T', 372.7, 464.8, 4.7, 7, 7),
  fragment('√', 358.1, 472.5, 8.3, 10, 10),
  fragment('d', 366.4, 480.2, 5.2, 10, 10),
  fragment('k', 371.6, 483.3, 4.2, 7, 7),
  // In the browser the unstretched "√" renders narrower, leaving a 16 px gap
  // that splits ")V" into its own segment on the main baseline.
  fragment(')', 382.1, 472.8, 3.9, 10, 10),
  fragment('V', 386.0, 472.8, 5.8, 10, 10),
  fragment('(1)', 493.1, 472.8, 11.6, 10, 10),
];

test('a display equation with a fraction and scripts becomes one hover paragraph', () => {
  const plain = groupPdfVisualLines(buildPdfVisualLines(equation()));
  assert.ok(plain.length > 1, 'without attachment the formula is split');
  const groups = groupPdfVisualLines(attachPdfScripts(buildPdfVisualLines(equation())));
  const line = groups.flat().find(item => item.text.includes('Attention('));
  assert.ok(groups.flat().some(item => item.text === '(1)' && item !== line), 'the equation number stays separate');
  for (const piece of ['Attention(', 'QK', 'T', '√', 'd', 'k', ')V']) assert.ok(line.text.includes(piece), piece);
  assert.equal(line.rect.left, 220);
  assert.ok(line.rect.top <= 464.8 && line.rect.top + line.rect.height >= 490.3, 'covers numerator, superscript and subscript');
});

test('a separated fraction stack joins the baseline and following term without absorbing nearby text', () => {
  const lines = attachPdfScripts(buildPdfVisualLines([
    fragment('f =', 160, 100, 18),
    fragment('a + b', 197, 86, 22, 10, 10),
    fragment('c - d', 197, 116, 22, 10, 10),
    fragment('+ 1', 235, 100, 18),
    fragment('(7)', 500, 100, 16),
    fragment('Ordinary text below the display', 145, 138, 230),
  ]));
  const formula = lines.find(line => line.text.startsWith('f ='));
  assert.equal(formula.math, true);
  assert.deepEqual(formula.rect, rect(160, 86, 93, 40));
  assert.deepEqual(formula.fragments.map(piece => piece.text), ['f =', 'a + b', 'c - d', '+ 1']);
  assert.ok(lines.some(line => line.text === '(7)'));
  assert.ok(lines.some(line => line.text === 'Ordinary text below the display'));
});

test('separated rows without aligned math on both sides stay independent', () => {
  const lines = attachPdfScripts(buildPdfVisualLines([
    fragment('f =', 160, 100, 18),
    fragment('a + b', 197, 86, 22, 10, 10),
    fragment('c - d', 220, 116, 22, 10, 10),
  ]));
  assert.equal(lines.length, 3);
});

test('a numbered equation joins both sides of a summation but not the surrounding paragraphs', () => {
  const lines = [
    fragment('The policy objective is', 185, 0, 378, 17, 18.5),
    fragment('hHX−1', 434.5, 22.5, 40.2, 14, 19.7),
    fragment('i', 726.3, 22.5, 3.8, 17, 17),
    fragment('ˆ', 311.5, 37, 5.7, 17, 17),
    fragment('J(θ) =Es0∼ρ0, πθ', 307.5, 41.3, 124.5, 13.5, 19.8),
    fragment('γcˆt rˆt+1+γcˆH Vψ(ˆsH,gH,ξ).', 477.7, 41.3, 261.3, 15.5, 18.6),
    fragment('(2)', 841.9, 41.3, 19.9, 17, 17),
    fragment('t=0', 449, 65.3, 22.4, 11.9, 11.9),
    fragment('For motion tracking, the reward is', 185, 80, 640, 17, 17),
  ].map(piece => ({ ...piece, fragments: [piece] }));
  const groups = groupPdfVisualLines(attachPdfScripts(lines));
  const formula = groups.find(group => group[0].displayMath);
  assert.equal(formula?.length, 1);
  assert.deepEqual(formula[0].fragments, [lines[4], lines[3], lines[1], lines[7], lines[5], lines[2]].map(line => line.fragments[0]));
  assert.equal(formula[0].rect.left, 307.5);
  assert.ok(formula[0].rect.top + formula[0].rect.height >= 77.2);
  for (const text of ['The policy objective is', '(2)', 'For motion tracking, the reward is']) {
    assert.ok(groups.some(group => group.length === 1 && group[0].text === text));
  }
});

test('a detached reference number does not turn prose with an inline relation into a display equation', () => {
  const lines = attachPdfScripts(buildPdfVisualLines([
    fragment('The estimated value = 2', 160, 100, 148),
    fragment('(2)', 386, 100, 16),
  ]));
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => !line.displayMath));
});

test('a nearby equation label is split without splitting inline parenthesized numbers', () => {
  const rows = buildPdfVisualLines([
    fragment('R = r + γV,', 100, 20, 92, 17, 17),
    fragment('(3)', 217, 20, 20, 17, 17),
    fragment('f = g', 100, 60, 42, 17, 17),
    fragment('(4)', 144, 60, 20, 17, 17),
    fragment('The estimated value = 2', 100, 100, 160, 17, 17),
    fragment('(5)', 285, 100, 20, 17, 17),
    fragment('h =', 100, 140, 32, 17, 17),
    fragment('(6)', 157, 140, 20, 17, 17),
  ]);
  assert.deepEqual(rows.map(row => row.text), ['R = r + γV,', '(3)', 'f = g(4)', 'The estimated value = 2(5)', 'h =(6)']);
  const equation = attachPdfScripts(rows).find(line => line.displayMath);
  assert.equal(equation?.text, 'R = r + γV,');
  assert.equal(equation?.rect.width, 92);
});

test('inline sub/superscripts stay in their prose line and do not break the paragraph', () => {
  const lines = attachPdfScripts(buildPdfVisualLines([
    fragment('values of d', 50, 0, 60, 10, 10),
    fragment('k', 110, 3, 4, 7, 7),
    fragment(', the dot products', 115, 0, 90, 10, 10),
    fragment('grow large in magnitude', 50, 12, 120, 10, 10),
  ]));
  const paragraphs = groupPdfVisualLines(lines);
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].length, 2);
});

test('attachment leaves prose lines, columns and table rows alone', () => {
  const prose = attachPdfScripts(buildPdfVisualLines([
    fragment('First line of text', 50, 0, 200, 10, 10),
    fragment('Second line of text', 50, 12, 200, 10, 10),
  ]));
  assert.equal(prose.length, 2, 'stacked prose lines do not overlap');
  const columns = attachPdfScripts(buildPdfVisualLines([
    fragment('Left column line', 50, 0, 200, 10, 10),
    fragment('Right column line', 270, 4, 200, 10, 10),
  ]));
  assert.equal(columns.length, 2, 'overlapping lines in different columns stay apart');
  const table = attachPdfScripts(buildPdfVisualLines([
    fragment('Method', 50, 0, 40, 10, 10),
    fragment('BLEU', 120, 0, 30, 10, 10),
    fragment('28.4', 180, 0, 24, 10, 10),
  ]));
  assert.equal(table.length, 3, 'cells on one baseline are not merged');
});
