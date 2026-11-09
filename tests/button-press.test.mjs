import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Tests for button press feedback.
 * 
 * The fix: Add scale(0.97) press feedback to buttons.
 */

const cssContent = await readFile(new URL('../src/pdf-reader.css', import.meta.url), 'utf8');

test('button active state includes scale transform', () => {
  // Check for :active state with transform
  assert.ok(
    cssContent.includes(':active') && cssContent.includes('transform: scale(0.97)'),
    'CSS should include active state with transform: scale(0.97)'
  );
});

test('button transition includes transform', () => {
  // Find button transition - it should include transform
  assert.ok(
    cssContent.includes('transition:') && cssContent.includes('transform'),
    'Button transition should include transform'
  );
});

test('keyboard input method disables transform', () => {
  assert.ok(
    cssContent.includes('[data-input-method="keyboard"]'),
    'CSS should include keyboard input method handling'
  );
  
  // Check that keyboard mode disables transform
  const keyboardSection = cssContent.match(
    /\[data-input-method="keyboard"\][^{]*\{[^}]*transform[^}]*\}/g
  );
  assert.ok(
    keyboardSection && keyboardSection.some(section => section.includes('transform: none')),
    'Keyboard mode should disable transform'
  );
});

test('reduced motion disables button transform', () => {
  const reducedMotionSection = cssContent.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?transform:\s*none[\s\S]*?}/g
  );
  assert.ok(reducedMotionSection, 'Reduced motion should disable transform');
  
  // Check that reduced motion section exists and includes transform: none
  assert.ok(
    reducedMotionSection.some(section => section.includes('transform: none')),
    'Reduced motion should disable transform'
  );
});

test('pressed state uses correct color variable', () => {
  assert.ok(
    cssContent.includes('--pr-pressed'),
    'CSS should define --pr-pressed variable'
  );
  
  // Check that active state uses the pressed color
  const activeMatch = cssContent.match(/:active[^{]*\{[^}]*--pr-pressed[^}]*\}/);
  assert.ok(
    activeMatch || cssContent.includes('var(--pr-pressed)'),
    'Active state should use --pr-pressed color'
  );
});
