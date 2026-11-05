import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('../src/overlayGeometry.ts', import.meta.url))],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
});
const { positionReaderOverlay, isPointInOverlayBridge } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

const rect = (left, top, width, height) => ({ left, top, width, height });
const boundary = rect(100, 200, 400, 500);
const size = { width: 160, height: 40 };

test('overlay is centered above its anchor in client coordinates', () => {
  assert.deepEqual(positionReaderOverlay(rect(220, 350, 80, 20), boundary, size),
    { left: 180, top: 302, placement: 'top' });
});

test('insufficient space above places the overlay below with the requested gap', () => {
  assert.deepEqual(positionReaderOverlay(rect(220, 230, 80, 20), boundary, size),
    { left: 180, top: 258, placement: 'bottom' });
});

test('an exact padded top fit retains the top placement', () => {
  assert.deepEqual(positionReaderOverlay(rect(220, 256, 80, 20), boundary, size),
    { left: 180, top: 208, placement: 'top' });
});

test('overlay clamps left and right to the actual boundary including padding', () => {
  assert.equal(positionReaderOverlay(rect(90, 350, 20, 20), boundary, size).left, 108);
  assert.equal(positionReaderOverlay(rect(490, 350, 20, 20), boundary, size).left, 332);
});

test('overlay clamps both vertical edges when the anchor is outside the boundary', () => {
  assert.deepEqual(positionReaderOverlay(rect(200, 100, 80, 20), boundary, size),
    { left: 160, top: 208, placement: 'bottom' });
  assert.deepEqual(positionReaderOverlay(rect(200, 900, 80, 20), boundary, size),
    { left: 160, top: 652, placement: 'top' });
});

test('custom padding and gap support negative boundary origins', () => {
  assert.deepEqual(positionReaderOverlay(rect(-40, -10, 20, 10), rect(-100, -100, 200, 200),
    { width: 80, height: 20 }, 4, 12), { left: -70, top: -42, placement: 'top' });
});

test('scarce space relaxes padding while keeping a fitting menu inside', () => {
  assert.deepEqual(positionReaderOverlay(rect(103, 205, 4, 2), rect(100, 200, 20, 20),
    { width: 16, height: 16 }), { left: 102, top: 202, placement: 'bottom' });
});

test('oversized menus and zero-sized boundaries produce finite boundary-aligned positions', () => {
  assert.deepEqual(positionReaderOverlay(rect(100, 200, 20, 10), rect(100, 200, 10, 10), size),
    { left: 100, top: 200, placement: 'bottom' });
  assert.deepEqual(positionReaderOverlay(rect(100, 200, 0, 0), rect(100, 200, 0, 0), size),
    { left: 100, top: 200, placement: 'bottom' });
});

test('inputs are not mutated and negative spacing is treated as zero', () => {
  const anchor = Object.freeze(rect(220, 350, 80, 20));
  assert.deepEqual(positionReaderOverlay(anchor, Object.freeze({ ...boundary }), Object.freeze({ ...size }), -4, -8),
    { left: 180, top: 310, placement: 'top' });
});

test('bridge includes anchor and menu interiors and their edges', () => {
  const anchor = rect(100, 200, 200, 100);
  const menu = rect(120, 152, 160, 40);
  for (const point of [{ x: 110, y: 250 }, { x: 150, y: 170 }, { x: 280, y: 192 }]) {
    assert.equal(isPointInOverlayBridge(point, anchor, menu), true);
  }
});

test('vertical bridge covers the short shared gap with a bounded buffer', () => {
  const anchor = rect(100, 200, 200, 100);
  const menu = rect(120, 152, 160, 40);
  assert.equal(isPointInOverlayBridge({ x: 200, y: 196 }, anchor, menu), true);
  assert.equal(isPointInOverlayBridge({ x: 113, y: 196 }, anchor, menu), true);
  assert.equal(isPointInOverlayBridge({ x: 111, y: 196 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 295, y: 196 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 200, y: 135 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 200, y: 320 }, anchor, menu), false);
});

test('bridge also handles a menu below or beside its anchor', () => {
  assert.equal(isPointInOverlayBridge({ x: 180, y: 304 }, rect(100, 200, 200, 100), rect(120, 308, 160, 40)), true);
  const anchor = rect(100, 200, 100, 100);
  const menu = rect(208, 220, 80, 40);
  assert.equal(isPointInOverlayBridge({ x: 204, y: 240 }, anchor, menu), true);
  assert.equal(isPointInOverlayBridge({ x: 204, y: 280 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 204, y: 240 }, menu, anchor), true);
});

test('diagonal bridge is narrow instead of admitting the empty bounding box or anchor/menu hull', () => {
  const anchor = rect(0, 0, 100, 100);
  const menu = rect(200, 200, 80, 40);
  assert.equal(isPointInOverlayBridge({ x: 150, y: 150 }, anchor, menu), true);
  assert.equal(isPointInOverlayBridge({ x: 155, y: 150 }, anchor, menu), true);
  assert.equal(isPointInOverlayBridge({ x: 175, y: 120 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 110, y: 170 }, anchor, menu), false);
  assert.equal(isPointInOverlayBridge({ x: 150, y: 150 }, menu, anchor), true);
});

test('diagonal bridge works in all four relative directions', () => {
  const anchor = rect(100, 100, 40, 40);
  for (const [menu, point] of [
    [rect(160, 160, 20, 20), { x: 150, y: 150 }],
    [rect(60, 160, 20, 20), { x: 90, y: 150 }],
    [rect(60, 60, 20, 20), { x: 90, y: 90 }],
    [rect(160, 60, 20, 20), { x: 150, y: 90 }],
  ]) assert.equal(isPointInOverlayBridge(point, anchor, menu, 2), true);
});

test('zero buffer tests only the actual gap; touching or overlapping rectangles create no outer halo', () => {
  const anchor = rect(100, 200, 200, 100);
  const menu = rect(120, 152, 160, 40);
  assert.equal(isPointInOverlayBridge({ x: 119, y: 196 }, anchor, menu, 0), false);
  assert.equal(isPointInOverlayBridge({ x: 120, y: 196 }, anchor, menu, 0), true);
  assert.equal(isPointInOverlayBridge({ x: 119, y: 196 }, anchor, menu, -1), false);
  assert.equal(isPointInOverlayBridge({ x: 95, y: 180 }, anchor, rect(120, 180, 160, 40)), false);
  assert.equal(isPointInOverlayBridge({ x: 95, y: 200 }, anchor, rect(120, 160, 160, 40)), false);
});
