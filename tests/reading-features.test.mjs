// Unit tests for v0.7 reading features: fit width, saved positions, text
// cleanup for the AI, search matching, citation preview text, margin menu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const modules = new Map();
async function load(name) {
  if (modules.has(name)) return modules.get(name);
  let source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  // Inline sibling imports used at runtime (textLayer helpers).
  if (/from '\.\/textLayer'/.test(source)) {
    const textLayer = await load('textLayer');
    globalThis.__textLayer = textLayer;
    source = source.replace(/import \{ multiplyTransform \} from '\.\/textLayer';/, 'const { multiplyTransform } = globalThis.__textLayer;');
  }
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);
  modules.set(name, module);
  return module;
}
const { fitWidthScale, loadView, saveView, loadPrefs, savePrefs } = await load('viewState');
const { cleanPdfText, looksLikeMath } = await load('textCleanup');
const { buildPageSearchIndex, searchIndex } = await load('search');
const { previewTextAt } = await load('links');
const { positionMarginOverlay } = await load('overlayGeometry');

test('fit width fills the available width and respects the zoom limits', () => {
  assert.equal(fitWidthScale(660, 612, 48), 1);
  assert.equal(fitWidthScale(354, 612, 24), 0.539);
  assert.equal(fitWidthScale(100, 612, 48, 0.25), 0.25);
  assert.equal(fitWidthScale(0, 612, 48), 1, 'unknown width keeps 100%');
});

test('reading positions persist per document and only the latest 60 are kept', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
  saveView('doc-a', { page: 7, scale: 1.25, fit: false, offset: 0.4 });
  assert.deepEqual(loadView('doc-a'), { page: 7, scale: 1.25, fit: false, offset: 0.4 });
  assert.equal(loadView('missing'), null);
  for (let index = 0; index < 70; index++) saveView(`doc-${index}`, { page: 1, scale: 1, fit: true });
  assert.equal(loadView('doc-a'), null, 'oldest positions are evicted');
  assert.ok(loadView('doc-69'));
  assert.ok([...store.keys()].filter(key => key.startsWith('dsh-paper-reader:view:')).length <= 60);
  store.set('dsh-paper-reader:view:bad', '{"page":0}');
  assert.equal(loadView('bad'), null, 'invalid entries are ignored');
  store.set('dsh-paper-reader:prefs', JSON.stringify({ night: true, hoverMenu: false }));
  assert.deepEqual(loadPrefs(), { hoverMenu: false }, 'legacy night preference is ignored');
  savePrefs({ hoverMenu: true });
  assert.deepEqual(JSON.parse(store.get('dsh-paper-reader:prefs')), { hoverMenu: true });
  globalThis.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  assert.equal(loadView('doc-1'), null, 'blocked storage behaves like empty storage');
  assert.deepEqual(loadPrefs(), { hoverMenu: true });
  delete globalThis.localStorage;
});

test('text cleanup restores running text for translation', () => {
  assert.equal(cleanPdfText('and dot-product (multi-\nplicative) attention'), 'and dot-product (multiplicative) attention');
  assert.equal(cleanPdfText('values of the\nkeys and queries'), 'values of the keys and queries');
  assert.equal(cleanPdfText('深度学习模型\n的训练方法'), '深度学习模型的训练方法', 'no space between CJK lines');
  assert.equal(cleanPdfText('first paragraph.\n\nSecond one'), 'first paragraph.\n\nSecond one', 'blank lines stay paragraph breaks');
  assert.equal(cleanPdfText('This sentence ends here at the end of a long printed line.\nThe next paragraph starts'), 'This sentence ends here at the end of a long printed line.\nThe next paragraph starts');
  assert.equal(cleanPdfText('state-of-the-\nArt'), 'state-of-the- Art', 'a capitalised continuation is not de-hyphenated');
});

test('formula detection', () => {
  assert.equal(looksLikeMath('Attention(Q, K, V) = softmax(QKT√dk)V'), true);
  assert.equal(looksLikeMath('with learning rate α decayed'), true);
  assert.equal(looksLikeMath('We train the model for three hours.'), false);
});

const item = (str, x, y, width, size = 10, hasEOL = false) => ({ str, dir: 'ltr', transform: [size, 0, 0, size, x, y], width, height: size, fontName: 'f', hasEOL });
const viewport = [1, 0, 0, -1, 0, 792];

test('search is case-insensitive, spans line breaks and soft hyphens, and returns page rectangles', () => {
  const content = { items: [item('The multi-', 100, 700, 50, 10, true), item('plicative Attention head', 100, 688, 120)], styles: {} };
  const index = buildPageSearchIndex(3, content, viewport, 612, 792);
  const hits = searchIndex(index, 'MULTIPLICATIVE attention');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].page, 3);
  assert.equal(hits[0].rects.length, 2, 'one rectangle per line');
  const [line1, line2] = hits[0].rects;
  assert.ok(line1.top < line2.top);
  assert.ok(Math.abs(line1.left - 100 * (100 + 50 * 4 / 10) / 612) < 0.01, 'starts at "multi"');
  assert.equal(searchIndex(index, '   ').length, 0);
  assert.equal(searchIndex(index, 'head head').length, 0);
  const many = buildPageSearchIndex(1, { items: [item('a a a a', 0, 700, 40)], styles: {} }, viewport, 612, 792);
  assert.equal(searchIndex(many, 'a').length, 4);
});

test('citation preview reads the reference entry at the destination', () => {
  const content = { items: [
    item('Introduction text far above', 72, 700, 200, 10, true),
    item('[1] A. Author and B. Author. A paper about', 72, 300, 300, 9, true),
    item('humanoid control. In CoRL, 2025.', 84, 289, 200, 9, true),
    item('[2] C. Other. Another reference.', 72, 278, 250, 9, true),
  ], styles: {} };
  const text = previewTextAt(content, viewport, { page: 17, top: 792 - 300 - 9, left: 72 });
  assert.equal(text, '[1] A. Author and B. Author. A paper about humanoid control. In CoRL, 2025.');
  const section = previewTextAt(content, viewport, { page: 1 });
  assert.match(section, /^Introduction text far above/);
});

test('hover menu goes into the margin beside the paragraph, or reports no room', () => {
  const paragraph = { left: 100, top: 300, width: 400, height: 80 };
  const boundary = { left: 0, top: 50, width: 640, height: 800 };
  assert.deepEqual(positionMarginOverlay(paragraph, { left: 0, right: 640 }, boundary, { width: 52, height: 130 }), { left: 510, top: 300, placement: 'right' });
  assert.deepEqual(positionMarginOverlay(paragraph, { left: 0, right: 540 }, boundary, { width: 52, height: 130 }), { left: 38, top: 300, placement: 'left' });
  assert.equal(positionMarginOverlay(paragraph, { left: 60, right: 540 }, boundary, { width: 52, height: 130 }), null);
  assert.equal(positionMarginOverlay({ ...paragraph, top: 790 }, { left: 0, right: 640 }, boundary, { width: 52, height: 130 }).top, 712, 'kept inside the visible area');
});
