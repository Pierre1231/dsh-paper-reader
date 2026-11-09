import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/figures.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const {
  detectPdfFigures,
  collectPdfFigures,
  invalidatePdfFigureCache,
  findPdfFigureAtPoint,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const rect = (left, top, width, height = 12) => ({ left, top, width, height });
const fragment = (text, left, top, width, fontSize = 10, height = 10) => ({
  text, rect: rect(left, top, width, height), fontSize,
});
const page = rect(0, 0, 600, 800);

function bodyColumns(top = 230) {
  return [0, 1, 2].flatMap(row => [
    fragment(`Left body paragraph line ${row} contains enough prose to be ordinary text.`, 50, top + row * 14, 230),
    fragment(`Right body paragraph line ${row} contains enough prose to be ordinary text.`, 320, top + row * 14, 230),
  ]);
}

test('SuperMimic Figure 1 uses the page-top region above its multiline caption', () => {
  const figures = detectPdfFigures([
    fragment('humanoid', 72, 24, 60),
    fragment('learned world model', 350, 48, 120),
    fragment('policy', 220, 105, 45),
    fragment('Figure 1: SuperMimic learns a differentiable model', 50, 180, 500),
    fragment('for whole-body humanoid control from motion capture.', 50, 194, 430),
    ...bodyColumns(),
  ], 2, page);

  assert.equal(figures.length, 1);
  assert.equal(figures[0].key, 'pdf-2-figure-1');
  assert.equal(figures[0].kind, 'figure');
  assert.equal(figures[0].pageNumber, 2);
  assert.equal(figures[0].caption,
    'Figure 1: SuperMimic learns a differentiable model for whole-body humanoid control from motion capture.');
  assert.deepEqual(figures[0].rect, rect(50, 0, 500, 180));
  assert.deepEqual(figures[0].captionRect, rect(50, 180, 500, 24));
  assert.equal(findPdfFigureAtPoint(figures, 300, 90), figures[0]);
  assert.equal(findPdfFigureAtPoint(figures, 300, 180), null, 'the caption top edge is outside the half-open region');
  assert.equal(findPdfFigureAtPoint(figures, 300, 185), null, 'caption is not part of the graphic hover region');
  assert.equal(findPdfFigureAtPoint(figures, 300, 235), null, 'body below the caption is excluded');
});

test('SuperMimic Table 1 retains table-cell text but excludes the prose above it', () => {
  const tableText = [
    fragment('Method', 55, 120, 80), fragment('Return', 200, 120, 60),
    fragment('SuperMimic', 55, 136, 80), fragment('0.91', 200, 136, 60),
    fragment('Baseline', 55, 152, 80), fragment('0.42', 200, 152, 60),
  ];
  const figures = detectPdfFigures([
    ...bodyColumns(40),
    ...tableText,
    fragment('Table 1: Results across tasks', 60, 200, 200),
    fragment('Values are normalized.', 60, 212, 180),
    fragment('A later body paragraph must not join the caption.', 50, 250, 230),
    fragment('Right-column text remains independent of the table.', 320, 250, 230),
  ], 7, page);

  assert.equal(figures.length, 1);
  assert.equal(figures[0].key, 'pdf-7-table-1');
  assert.equal(figures[0].kind, 'table');
  assert.equal(figures[0].caption, 'Table 1: Results across tasks Values are normalized.');
  assert.deepEqual(figures[0].rect, rect(50, 78, 230, 122));
  for (const cell of tableText) {
    assert.equal(findPdfFigureAtPoint(figures, cell.rect.left + 2, cell.rect.top + 2), figures[0], cell.text);
  }
  assert.equal(findPdfFigureAtPoint(figures, 60, 60), null, 'preceding body paragraph is excluded');
  assert.equal(findPdfFigureAtPoint(figures, 60, 205), null, 'caption is excluded');
});

test('anchored prose references and ordinary paragraphs do not become figures', () => {
  const figures = detectPdfFigures([
    fragment('Figure 1 shows the architecture in more detail.', 50, 40, 230),
    fragment('Table 2 compares every baseline with our method.', 50, 54, 230),
    fragment('As shown in Figure 3, the policy generalizes.', 50, 80, 230),
    fragment('This ordinary paragraph mentions figures and tables without a caption.', 50, 94, 230),
    fragment('Figure 5(a) shows the rollout throughput and batch size.', 50, 120, 230),
    fragment('Figure 6(b,c) compares the policies.', 50, 134, 230),
  ], 3, page);
  assert.deepEqual(figures, []);
});

test('an earlier caption bounds a later figure instead of overlapping it', () => {
  const figures = detectPdfFigures([
    fragment('Figure 1: First page-wide diagram.', 50, 100, 500),
    fragment('Figure 2: Second page-wide diagram.', 50, 300, 500),
  ], 4, page);
  assert.equal(figures.length, 2);
  assert.deepEqual(figures[0].rect, rect(50, 0, 500, 100));
  assert.deepEqual(figures[1].rect, rect(50, 110, 500, 190));
});

test('a caption in the opposite column does not clip a table', () => {
  const figures = detectPdfFigures([
    fragment('Method', 55, 20, 80), fragment('Return', 200, 20, 60),
    fragment('SuperMimic', 55, 36, 80), fragment('0.91', 200, 36, 60),
    fragment('Figure 2: Right-column diagram.', 320, 100, 230),
    fragment('Table 1: Left-column results.', 50, 300, 230),
    ...bodyColumns(400),
  ], 5, page);
  const table = figures.find(figure => figure.kind === 'table');
  assert.ok(table);
  assert.deepEqual(table.rect, rect(50, 0, 230, 300));
});

function makeDomSpan(text, bounds, { marked = false, nonLeaf = false } = {}) {
  const span = {
    textContent: text,
    querySelector(selector) { return selector === 'span' && nonLeaf ? {} : null; },
    closest(selector) { return selector === '.markedContent' && marked ? span : null; },
    getBoundingClientRect: () => bounds,
  };
  return span;
}

test('DOM adapter reads pdf.js leaf spans and skips markedContent wrappers', () => {
  const caption = makeDomSpan('Figure 4: DOM-backed diagram.', rect(40, 140, 250));
  const marked = makeDomSpan('Figure 99: must not be read.', rect(40, 20, 250), { marked: true });
  const wrapper = makeDomSpan('wrapper', rect(40, 20, 250), { nonLeaf: true });
  const empty = makeDomSpan('   ', rect(40, 20, 250));
  const spans = [caption, marked, wrapper, empty];
  const layer = {
    ownerDocument: { defaultView: { getComputedStyle: () => ({ fontSize: '10px' }) } },
    getBoundingClientRect: () => rect(0, 0, 400, 600),
    querySelectorAll(selector) {
      assert.equal(selector, 'span');
      return spans;
    },
  };

  const figures = collectPdfFigures(layer, 9);
  assert.equal(figures.length, 1);
  assert.equal(figures[0].pageNumber, 9);
  assert.equal(figures[0].caption, 'Figure 4: DOM-backed diagram.');
  assert.deepEqual(figures[0].rect, rect(40, 0, 250, 140));
});

function makeCachedLayer(records = [fragment('Figure 1: Cached diagram.', 40, 140, 250)]) {
  const state = { bounds: rect(100, 200, 400, 600), records, scans: 0, styles: 0, spanRects: 0, layerRects: 0 };
  const layer = {
    dataset: { renderGeneration: '1' },
    ownerDocument: { defaultView: { getComputedStyle() {
      state.styles++;
      return { fontSize: '10px' };
    } } },
    getBoundingClientRect() { state.layerRects++; return state.bounds; },
    querySelectorAll(selector) {
      assert.equal(selector, 'span');
      state.scans++;
      return state.records.map(record => ({
        textContent: record.text,
        querySelector: () => null,
        closest: () => null,
        getBoundingClientRect() {
          state.spanRects++;
          return { ...record.rect, left: record.rect.left + state.bounds.left, top: record.rect.top + state.bounds.top };
        },
      }));
    },
  };
  return { layer, state };
}

test('cached figures and captions translate on scroll without scanning spans or computing styles', () => {
  const { layer, state } = makeCachedLayer();
  const first = collectPdfFigures(layer, 1)[0];
  const reads = { styles: state.styles, spanRects: state.spanRects };
  assert.deepEqual(first.rect, rect(140, 200, 250, 140));
  state.bounds = rect(70, -120, 400, 600);
  const moved = collectPdfFigures(layer, 1)[0];
  assert.deepEqual(moved.rect, rect(110, -120, 250, 140));
  assert.deepEqual(moved.captionRect, rect(110, 20, 250, 10));
  assert.deepEqual(first.rect, rect(140, 200, 250, 140), 'previous client rectangles stay unchanged');
  assert.equal(state.scans, 1);
  assert.equal(state.styles, reads.styles);
  assert.equal(state.spanRects, reads.spanRects);
  assert.equal(state.layerRects, 2);
  moved.rect.left = 999;
  moved.captionRect.top = 999;
  assert.deepEqual(collectPdfFigures(layer, 1)[0].rect, rect(110, -120, 250, 140), 'callers cannot corrupt cache');
  assert.equal(collectPdfFigures(layer, 1)[0].captionRect.top, 20);
});

test('explicit invalidation refreshes replaced DOM at the same dimensions', () => {
  const { layer, state } = makeCachedLayer();
  collectPdfFigures(layer, 1);
  state.records = [fragment('Table 8: Replacement.', 30, 240, 300)];
  assert.equal(collectPdfFigures(layer, 1)[0].kind, 'figure', 'same-size DOM changes require invalidation');
  invalidatePdfFigureCache(layer);
  const refreshed = collectPdfFigures(layer, 1)[0];
  assert.equal(refreshed.key, 'pdf-1-table-8');
  assert.deepEqual(refreshed.rect, rect(130, 200, 300, 240));
  assert.equal(state.scans, 2);
  invalidatePdfFigureCache({}); // An uncached, lightweight layer is harmless.
});

test('render generation and page number changes each refresh the cache', () => {
  const { layer, state } = makeCachedLayer();
  collectPdfFigures(layer, 1);
  state.records = [fragment('Figure 2: New render.', 40, 160, 250)];
  layer.dataset.renderGeneration = '2';
  assert.equal(collectPdfFigures(layer, 1)[0].key, 'pdf-1-figure-2');
  assert.equal(collectPdfFigures(layer, 9)[0].key, 'pdf-9-figure-2');
  assert.equal(state.scans, 3);
});

test('width, height, and scaled geometry changes invalidate rendered-size cache entries', () => {
  const { layer, state } = makeCachedLayer();
  collectPdfFigures(layer, 1);
  state.bounds.width = 500;
  state.records = [fragment('Figure 1: Wider render.', 50, 175, 312.5)];
  assert.deepEqual(collectPdfFigures(layer, 1)[0].rect, rect(150, 200, 312.5, 175));
  state.bounds.height = 750;
  collectPdfFigures(layer, 1);
  state.bounds = rect(100, 200, 800, 1200);
  state.records = [fragment('Figure 1: Zoomed render.', 80, 280, 500, 20, 20)];
  assert.deepEqual(collectPdfFigures(layer, 1)[0].rect, rect(180, 200, 500, 280));
  assert.equal(state.scans, 4);
});

test('pages with no figures cache empty results and release them on invalidation', () => {
  const { layer, state } = makeCachedLayer([fragment('An ordinary body sentence.', 40, 140, 250)]);
  assert.deepEqual(collectPdfFigures(layer, 1), []);
  const styleReads = state.styles;
  state.bounds.top -= 300;
  assert.deepEqual(collectPdfFigures(layer, 1), []);
  assert.equal(state.scans, 1);
  assert.equal(state.styles, styleReads);
  state.records = [fragment('Figure 3: Arrived after rendering.', 40, 140, 250)];
  invalidatePdfFigureCache(layer);
  assert.equal(collectPdfFigures(layer, 1)[0].key, 'pdf-1-figure-3');
  assert.equal(state.scans, 2);
});

test('cache entries remain independent and support layers without dataset or text', () => {
  const { layer: first, state: firstState } = makeCachedLayer();
  const { layer: empty, state: emptyState } = makeCachedLayer([]);
  delete first.dataset;
  delete empty.dataset;
  assert.equal(collectPdfFigures(first, 1).length, 1);
  assert.deepEqual(collectPdfFigures(empty, 1), []);
  firstState.bounds.top += 20;
  emptyState.bounds.top += 20;
  assert.equal(collectPdfFigures(first, 1)[0].rect.top, 220);
  assert.deepEqual(collectPdfFigures(empty, 1), []);
  assert.equal(firstState.scans, 1);
  assert.equal(emptyState.scans, 1);
  assert.equal(emptyState.styles, 0);
  invalidatePdfFigureCache(first);
  collectPdfFigures(first, 1);
  collectPdfFigures(empty, 1);
  assert.equal(firstState.scans, 2);
  assert.equal(emptyState.scans, 1, 'invalidating one layer does not clear another');
});

test('invalid page arguments are rejected explicitly', () => {
  assert.throws(() => detectPdfFigures([], 0, page), /one-based/);
  assert.throws(() => detectPdfFigures([], 1, rect(0, 0, 0, 600)), /non-empty/);
});
