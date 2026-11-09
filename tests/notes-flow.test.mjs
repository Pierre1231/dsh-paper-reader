import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { buildNotesPrompt } from '../src/notesPrompt.mjs';

/**
 * Integration test for the new notes flow as wired in client.tsx:
 * buildNotesPrompt → DraftRequest → retryDraftInsertion into the
 * conversation input. The AI then summarizes the whole discussion
 * (user questions + its own answers) into Markdown.
 */

const source = await readFile(new URL('../src/draftBridge.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
const { retryDraftInsertion } =
  await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString('base64')}`);

function makeEditor(sessionId = 'session-1') {
  let draft = '';
  let rev = 1;
  const actions = {
    captureInsertion: () => ({ start: draft.length, end: draft.length, draftRev: rev }),
    insertText(text, span) {
      if (span.draftRev !== rev) return false;
      draft = draft.slice(0, span.start) + text + draft.slice(span.end);
      rev++;
      return true;
    },
  };
  return {
    binding: { sessionId, inputActions: actions },
    getDraft: () => draft,
  };
}

/** Mirrors the generateNotes handler in client.tsx. */
function generateNotes({ fileName, sessionId, binding }) {
  const prompt = buildNotesPrompt(fileName);
  const request = { selection: { sessionId, fileName, page: 1, text: prompt }, action: 'ask', text: prompt };
  return retryDraftInsertion(request, binding);
}

test('inserts the notes prompt into the conversation draft', () => {
  const editor = makeEditor();
  const result = generateNotes({ fileName: 'paper.pdf', sessionId: 'session-1', binding: editor.binding });

  assert.equal(result.status, 'inserted', 'Should insert into the draft');
  const draft = editor.getDraft();
  assert.ok(draft.includes('paper.pdf'), 'Draft should reference the paper');
  assert.ok(draft.includes('疑问'), 'Draft should carry the required structure');
  assert.ok(draft.includes('Markdown'), 'Draft should request Markdown output');
});

test('fails gracefully when the session does not match', () => {
  const editor = makeEditor('other-session');
  const result = generateNotes({ fileName: 'paper.pdf', sessionId: 'session-1', binding: editor.binding });

  assert.equal(result.status, 'pending', 'Should not insert into another session');
  assert.equal(result.reason, 'session-mismatch');
  assert.equal(editor.getDraft(), '', 'Draft must stay untouched');
});

test('fails gracefully when there is no binding', () => {
  const result = generateNotes({ fileName: 'paper.pdf', sessionId: 'session-1', binding: undefined });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'session-mismatch');
});

test('appends to an existing draft instead of replacing it', () => {
  const editor = makeEditor();
  const first = generateNotes({ fileName: 'paper.pdf', sessionId: 'session-1', binding: editor.binding });
  assert.equal(first.status, 'inserted');
  const afterFirst = editor.getDraft();

  const second = generateNotes({ fileName: 'paper.pdf', sessionId: 'session-1', binding: editor.binding });
  assert.equal(second.status, 'inserted');
  assert.ok(editor.getDraft().startsWith(afterFirst), 'Second insertion must append, not replace');
});
