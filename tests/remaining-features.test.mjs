import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Tests for remaining improvements:
 * - 008: Success feedback animation
 * - 006: Page transition animation
 * - 007: Loading state skeleton
 */

const cssContent = await readFile(new URL('../src/pdf-reader.css', import.meta.url), 'utf8');

// 008 - Success feedback
test('success feedback styles exist', () => {
  assert.ok(
    cssContent.includes('pr-status-success') || cssContent.includes('success'),
    'CSS should include success feedback styles'
  );
});

test('check pop animation keyframes exist', () => {
  assert.ok(
    cssContent.includes('@keyframes') && cssContent.includes('check-pop'),
    'CSS should include check-pop animation'
  );
});

// 006 - Page transition
test('page transition styles exist', () => {
  assert.ok(
    cssContent.includes('pr-page') && cssContent.includes('transition'),
    'CSS should include page transition styles'
  );
});

// 007 - Loading skeleton
test('skeleton loading styles exist', () => {
  assert.ok(
    cssContent.includes('skeleton') || cssContent.includes('pr-page-skeleton'),
    'CSS should include skeleton loading styles'
  );
});

test('skeleton pulse animation exists', () => {
  assert.ok(
    cssContent.includes('skeleton-pulse') || cssContent.includes('pulse'),
    'CSS should include skeleton pulse animation'
  );
});
