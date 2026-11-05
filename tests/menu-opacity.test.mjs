import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Tests for menu opacity.
 * 
 * The fix: Menus should be fully opaque for better readability.
 */

const cssContent = await readFile(new URL('../src/pdf-reader.css', import.meta.url), 'utf8');

test('menu uses fallback menu color variable', () => {
  assert.ok(
    cssContent.includes('--pr-fallback-menu'),
    'CSS should define --pr-fallback-menu variable'
  );
  
  // Check that --pr-menu uses --pr-fallback-menu (not the host variable)
  assert.ok(
    cssContent.includes('--pr-menu: var(--pr-fallback-menu)') ||
    cssContent.includes('--pr-menu: var(--dsw-specific-menu, var(--pr-fallback-menu))'),
    '--pr-menu should use --pr-fallback-menu'
  );
});

test('fallback menu color is fully opaque in light mode', () => {
  // Check that light mode fallback menu is white (#fff)
  const lightModeSection = cssContent.match(
    /\.pr-shell,\s*\.pr-local,\s*\.pr-open-local\s*{[^}]+}/s
  );
  assert.ok(lightModeSection, 'Light mode section should exist');
  
  assert.ok(
    lightModeSection[0].includes('--pr-fallback-menu: #fff'),
    'Light mode fallback menu should be #fff (fully opaque)'
  );
});

test('fallback menu color is fully opaque in dark mode', () => {
  // Check that dark mode fallback menu is dark
  const darkModeSection = cssContent.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*{[^}]+}/s
  );
  assert.ok(darkModeSection, 'Dark mode section should exist');
  
  assert.ok(
    darkModeSection[0].includes('--pr-fallback-menu: #1F2937'),
    'Dark mode fallback menu should be #1F2937 (fully opaque)'
  );
});

test('selection menu has stronger shadow for depth', () => {
  const selectionMenuMatch = cssContent.match(/\.pr-selection-menu\s*{[^}]+}/s);
  assert.ok(selectionMenuMatch, '.pr-selection-menu should be defined');
  
  // Check for stronger shadow (multiple shadows)
  assert.ok(
    selectionMenuMatch[0].includes('0 8px 24px') || selectionMenuMatch[0].includes('0 4px 16px'),
    'Selection menu should have a visible shadow'
  );
});

test('removed toolbar dropdown leaves no styles behind', () => {
  // The "更多" dropdown was removed (v0.4.0); its styles must not linger.
  assert.ok(!cssContent.includes('.pr-toolbar-menu'), 'Removed dropdown styles should be gone');
  assert.ok(!cssContent.includes('.pr-more'), 'Removed more-button styles should be gone');
});
