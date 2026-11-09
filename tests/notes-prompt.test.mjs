import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotesPrompt, buildNotesFolderName } from '../src/notesPrompt.mjs';

/**
 * Tests for the notes summarization prompt.
 *
 * The prompt is inserted into the conversation draft; the AI then
 * summarizes the whole discussion (user questions + its own answers)
 * into a Markdown notes document. Requirements come from the user's
 * earlier decisions:
 * - organized by paper chapters, not timeline
 * - per item: 疑问 + 解答 + 重要性
 * - keep corrected understandings, drop the wrong guesses themselves
 * - keep "是不是这样理解" confirmations
 * - ignore tool actions (translate/copy) and chit-chat
 * - start with a short paper overview for quick recall
 */

test('includes the paper file name', () => {
  const prompt = buildNotesPrompt('attention-paper.pdf');
  assert.ok(prompt.includes('attention-paper.pdf'), 'Should reference the paper so the AI knows the subject');
});

test('requests Markdown output', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(/markdown/i.test(prompt), 'Should ask for Markdown');
  assert.ok(prompt.includes('.md'), 'Should mention the .md file target');
});

test('requires chapter-based organization, not timeline', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('章节'), 'Should organize by chapters');
  assert.ok(!prompt.includes('按时间顺序\n') || prompt.includes('不要按'), 'Should reject timeline ordering');
});

test('requires the 疑问/解答/重要性 structure', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('疑问'), 'Should include question field');
  assert.ok(prompt.includes('解答'), 'Should include answer field');
  assert.ok(prompt.includes('重要性'), 'Should include importance field');
});

test('keeps corrected understandings but drops wrong guesses', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('纠正'), 'Should mention corrections');
  assert.ok(prompt.includes('正确理解'), 'Should keep the corrected understanding');
  assert.ok(prompt.includes('错误'), 'Should mention wrong guesses to exclude them');
});

test('keeps confirmation moments', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('确认'), 'Should capture confirmation moments');
});

test('ignores tool actions and chit-chat', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('忽略'), 'Should have an ignore section');
  assert.ok(prompt.includes('翻译'), 'Should exclude translation requests');
});

test('requires a paper overview at the start', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('概述'), 'Should require an overview for quick recall');
});

test('is a non-trivial prompt', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.length > 200, 'Should carry enough instruction detail');
});

test('different papers produce different prompts', () => {
  assert.notEqual(buildNotesPrompt('a.pdf'), buildNotesPrompt('b.pdf'), 'File name should be embedded');
});

test('works without a file name (generic prompt)', () => {
  const prompt = buildNotesPrompt();
  assert.ok(prompt.length > 200, 'Should still carry the full instruction');
  assert.ok(!prompt.includes('undefined'), 'Must not leak undefined');
  assert.ok(prompt.includes('论文'), 'Should still reference the paper generically');
  assert.ok(prompt.includes('疑问'), 'Should keep the required structure');
});

test('treats empty file name as generic', () => {
  const prompt = buildNotesPrompt('');
  assert.ok(!prompt.includes('《》'), 'Empty name must not produce empty brackets');
  assert.ok(prompt.includes('论文'), 'Should reference the paper generically');
});

// --- Folder naming standard (v0.4.0): notes are saved by the AI into a
// workspace-root folder named after the paper title. ---

test('folder name strips the .pdf extension', () => {
  assert.equal(buildNotesFolderName('paper.pdf'), 'paper');
  assert.equal(buildNotesFolderName('paper.PDF'), 'paper');
});

test('folder name replaces illegal filesystem characters', () => {
  const name = buildNotesFolderName('a/b\\c:d*e?f"g<h>i|j.pdf');
  assert.ok(!/[/\\?%*:|"<>]/.test(name), 'No illegal characters may remain');
  assert.ok(name.includes('-'), 'Illegal characters become dashes');
});

test('folder name normalizes whitespace', () => {
  assert.equal(buildNotesFolderName('My   Great    Paper.pdf'), 'My Great Paper');
});

test('dash with a space on one side is spaced on both sides', () => {
  assert.equal(buildNotesFolderName('ResNet: Deep Residual Learning.pdf'), 'ResNet - Deep Residual Learning');
  assert.equal(buildNotesFolderName('whole-body control.pdf'), 'whole-body control', 'Internal hyphens stay untouched');
});

test('already-spaced dashes do not produce double spaces', () => {
  const name = buildNotesFolderName('Liao 等 - 2026 - SuperMimic.pdf');
  assert.equal(name, 'Liao 等 - 2026 - SuperMimic');
  assert.ok(!name.includes('  '), 'No double spaces');
});

test('folder name is capped at 60 characters', () => {
  const long = buildNotesFolderName('Liao 等 - 2026 - SuperMimic Scaling humanoid whole-body control with one differentiable world model.pdf');
  assert.ok(long.length <= 60, `Should be capped, got ${long.length}`);
  assert.ok(!/[\s.\-]$/.test(long), 'Must not end with a space, dot or dash');
  assert.ok(long.startsWith('Liao 等 - 2026'), 'Should keep the readable head');
});

test('folder name falls back for empty input', () => {
  assert.equal(buildNotesFolderName(''), '论文阅读笔记');
  assert.equal(buildNotesFolderName(undefined), '论文阅读笔记');
  assert.equal(buildNotesFolderName('.pdf'), '论文阅读笔记');
});

test('prompt instructs the AI to save the file into the workspace folder', () => {
  const prompt = buildNotesPrompt('paper.pdf');
  assert.ok(prompt.includes('工作区根目录'), 'Should name the workspace root as the location');
  assert.ok(prompt.includes('论文笔记.md'), 'Should name the notes file');
  assert.ok(prompt.includes('paper'), 'Should embed the derived folder name');
});

test('generic prompt instructs deriving the folder name from the conversation', () => {
  const prompt = buildNotesPrompt();
  assert.ok(prompt.includes('工作区根目录'), 'Should name the workspace root');
  assert.ok(prompt.includes('论文笔记.md'), 'Should name the notes file');
  assert.ok(prompt.includes('60'), 'Should carry the length limit rule');
});
