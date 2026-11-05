import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Typecheck gate.
 *
 * esbuild bundles without typechecking, so stale references to removed
 * identifiers (e.g. after a feature removal) build fine but crash at
 * runtime with ReferenceError — exactly the blank-reader bug from v0.4.0.
 * This test runs tsc --noEmit so the suite catches that class of bug.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const tscPath = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

test('TypeScript sources typecheck cleanly', () => {
  try {
    execFileSync(process.execPath, [tscPath, '--noEmit'], { cwd: root, encoding: 'utf8' });
  } catch (error) {
    assert.fail(`tsc --noEmit failed:\n${error.stdout || ''}\n${error.stderr || ''}`);
  }
});
