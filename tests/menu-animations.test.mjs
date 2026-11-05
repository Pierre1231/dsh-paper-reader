import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Tests for menu animations.
 * 
 * The fix: Add enter/exit animations to menus with scale and fade effects.
 */

const cssContent = await readFile(new URL('../src/pdf-reader.css', import.meta.url), 'utf8');

test('menu enter animation keyframes exist', () => {
  assert.ok(
    cssContent.includes('@keyframes menu-enter'),
    'CSS should include menu-enter keyframes'
  );
  
  // Check for scale and opacity in the animation
  const enterMatch = cssContent.match(/@keyframes menu-enter\s*{[^}]+}/s);
  assert.ok(enterMatch, 'menu-enter keyframes should be defined');
  assert.ok(
    enterMatch[0].includes('scale(0.95)') || enterMatch[0].includes('scale(0.9'),
    'menu-enter should start with a subtle scale down'
  );
  assert.ok(
    enterMatch[0].includes('opacity: 0'),
    'menu-enter should start with opacity 0'
  );
});

test('menu exit animation keyframes exist', () => {
  assert.ok(
    cssContent.includes('@keyframes menu-exit'),
    'CSS should include menu-exit keyframes'
  );
  
  // Check that menu-exit exists and contains opacity
  const exitIndex = cssContent.indexOf('@keyframes menu-exit');
  assert.ok(exitIndex >= 0, 'menu-exit should be found');
  
  // Get the content after @keyframes menu-exit
  const afterExit = cssContent.slice(exitIndex);
  assert.ok(
    afterExit.includes('opacity: 0'),
    'menu-exit should include opacity: 0'
  );
});

test('selection menu has enter animation', () => {
  const selectionMenuMatch = cssContent.match(/\.pr-selection-menu\s*{[^}]+}/s);
  assert.ok(selectionMenuMatch, '.pr-selection-menu should be defined');
  assert.ok(
    selectionMenuMatch[0].includes('animation: menu-enter'),
    '.pr-selection-menu should have menu-enter animation'
  );
  assert.ok(
    selectionMenuMatch[0].includes('transform-origin'),
    '.pr-selection-menu should have transform-origin'
  );
});

test('reduced motion disables menu animations', () => {
  const reducedMotionMatch = cssContent.match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[^}]*\.pr-selection-menu[^}]+}/s
  );
  assert.ok(
    reducedMotionMatch || cssContent.includes('prefers-reduced-motion: reduce'),
    'CSS should include reduced motion support'
  );
  
  if (reducedMotionMatch) {
    assert.ok(
      reducedMotionMatch[0].includes('animation: none'),
      'Reduced motion should disable animations'
    );
  }
});

test('animation uses correct easing curve', () => {
  // Check for the cubic-bezier curve in animations
  assert.ok(
    cssContent.includes('cubic-bezier(0.23, 1, 0.32, 1)'),
    'Animations should use the correct easing curve'
  );
});
