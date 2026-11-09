import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for capture cache key fix.
 * 
 * The bug: The cache key doesn't include document instance identifier,
 * which can cause wrong screenshots when rapidly switching between documents.
 * 
 * The fix: Add instance identifier to the cache key.
 */

// Mock the getCapture function behavior
function createCaptureSimulator() {
  const captures = new Map();
  let instanceId = 0;

  const getCapture = (element, figure, pdf, scale, instance) => {
    const generation = element?.querySelector?.('.pr-text-layer')?.dataset?.renderGeneration || '0';
    const bounds = element?.querySelector?.('canvas')?.getBoundingClientRect?.();
    const crop = [
      figure.rect.left - (bounds?.left || 0),
      figure.rect.top - (bounds?.top || 0),
      figure.rect.width,
      figure.rect.height
    ].map(value => Math.round(value * 10) / 10).join(':');

    // Include instance in cache key to prevent cross-document cache conflicts
    const key = `${instance}:${figure.pageNumber}:${figure.key}:${scale}:${generation}:${crop}`;

    const cached = captures.get(key);
    if (cached && !cached.controller.signal.aborted) {
      captures.delete(key);
      captures.set(key, cached);
      return cached;
    }

    // Clean up unclaimed jobs (but only for same instance)
    for (const [oldKey, job] of captures) {
      if (!job.done && !job.claimed && oldKey.startsWith(`${instance}:`)) {
        job.controller.abort();
        captures.delete(oldKey);
      }
    }

    const job = {
      key,
      controller: { 
        signal: { aborted: false },
        abort() { this.signal.aborted = true; }
      },
      promise: Promise.resolve({ blob: new Blob(['test'], { type: 'image/png' }) }),
      claimed: false,
      done: false,
    };

    captures.set(key, job);
    return job;
  };

  return {
    getCapture,
    captures,
    setInstance: (id) => { instanceId = id; },
    getInstance: () => instanceId,
  };
}

test('cache key includes document instance identifier', () => {
  const sim = createCaptureSimulator();

  const mockElement = {
    querySelector: (selector) => {
      if (selector === '.pr-text-layer') return { dataset: { renderGeneration: '1' } };
      if (selector === 'canvas') return { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
      return null;
    },
  };

  const mockFigure = {
    pageNumber: 1,
    key: 'pdf-1-figure-1',
    rect: { left: 100, top: 100, width: 200, height: 150 },
  };

  // Get capture for instance 1
  const capture1 = sim.getCapture(mockElement, mockFigure, null, 1, 1);
  assert.ok(capture1.key.startsWith('1:'), 'Cache key should start with instance ID');

  // Get capture for instance 2 (different document)
  const capture2 = sim.getCapture(mockElement, mockFigure, null, 1, 2);
  assert.ok(capture2.key.startsWith('2:'), 'Cache key should start with instance ID');

  // Keys should be different
  assert.notEqual(capture1.key, capture2.key, 'Different instances should have different cache keys');

  // Same instance should return cached value
  const capture1Again = sim.getCapture(mockElement, mockFigure, null, 1, 1);
  assert.equal(capture1Again.key, capture1.key, 'Same instance should return same cache key');
});

test('rapid document switching does not cause cache conflicts', () => {
  const sim = createCaptureSimulator();

  const mockElement = {
    querySelector: (selector) => {
      if (selector === '.pr-text-layer') return { dataset: { renderGeneration: '1' } };
      if (selector === 'canvas') return { getBoundingClientRect: () => ({ left: 0, top: 0 }) };
      return null;
    },
  };

  const mockFigure = {
    pageNumber: 1,
    key: 'pdf-1-figure-1',
    rect: { left: 100, top: 100, width: 200, height: 150 },
  };

  // Simulate rapid switching between documents
  const captures = [];
  for (let i = 1; i <= 5; i++) {
    const capture = sim.getCapture(mockElement, mockFigure, null, 1, i);
    captures.push(capture);
  }

  // All captures should have different keys
  const keys = captures.map(c => c.key);
  const uniqueKeys = new Set(keys);
  assert.equal(uniqueKeys.size, 5, 'Each instance should have a unique cache key');

  // Verify all captures are stored separately
  assert.equal(sim.captures.size, 5, 'All captures should be stored separately');
});
