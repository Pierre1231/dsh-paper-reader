import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Tests for hover menu race condition fix.
 * 
 * The bug: When user moves mouse rapidly between different positions of the same
 * paragraph, the 180ms timer doesn't reset, causing the menu to trigger at the
 * wrong position.
 * 
 * The fix: Add position tracking to detect significant position changes (>5px)
 * and reset the timer when position changes significantly.
 */

// Mock the schedule function behavior
function createScheduleSimulator() {
  let hoverTimer = null;
  let pending = null;
  let hoverTicket = 0;
  const triggered = [];

  const clearHoverTimer = () => {
    hoverTicket++;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = null;
    pending = null;
  };

  const schedule = (key, mode, activate, position) => {
    // Check if same key and mode
    if (pending?.key === key && pending.mode === mode) {
      const lastPos = pending.position;
      // If position hasn't changed significantly (< 5px), just update activate
      if (lastPos && position &&
          Math.abs(lastPos.x - position.x) < 5 &&
          Math.abs(lastPos.y - position.y) < 5) {
        pending.activate = activate;
        return;
      }
      // Position changed significantly, reset timer
      clearHoverTimer();
    } else {
      clearHoverTimer();
    }

    pending = { key, mode, activate, position };
    const ticket = hoverTicket;
    hoverTimer = setTimeout(() => {
      const target = pending;
      pending = null;
      hoverTimer = null;
      if (ticket === hoverTicket) {
        target?.activate(ticket);
        triggered.push({ key: target?.key, position: target?.position });
      }
    }, 120); // Using 120ms as per plan 004
  };

  return {
    schedule,
    triggered,
    getPending: () => pending,
    cleanup: () => clearHoverTimer(),
  };
}

test('schedule triggers menu at the correct position after delay', async () => {
  const sim = createScheduleSimulator();

  // Schedule at position A
  sim.schedule('para-1', 'hover', () => {}, { x: 100, y: 200 });

  // Wait for trigger
  await new Promise(resolve => setTimeout(resolve, 150));

  assert.equal(sim.triggered.length, 1);
  assert.deepEqual(sim.triggered[0].position, { x: 100, y: 200 });
  sim.cleanup();
});

test('rapid position changes reset the timer', async () => {
  const sim = createScheduleSimulator();

  // Schedule at position A
  sim.schedule('para-1', 'hover', () => {}, { x: 100, y: 200 });

  // Wait 60ms (half of delay)
  await new Promise(resolve => setTimeout(resolve, 60));

  // Move to position B (significant change > 5px)
  sim.schedule('para-1', 'hover', () => {}, { x: 150, y: 250 });

  // Wait another 60ms (total 120ms from first, but only 60ms from second)
  await new Promise(resolve => setTimeout(resolve, 60));

  // Should not have triggered yet (timer was reset)
  assert.equal(sim.triggered.length, 0);

  // Wait for the full delay from the second position
  await new Promise(resolve => setTimeout(resolve, 70));

  // Should have triggered at position B
  assert.equal(sim.triggered.length, 1);
  assert.deepEqual(sim.triggered[0].position, { x: 150, y: 250 });
  sim.cleanup();
});

test('small position jitter does not reset timer', async () => {
  const sim = createScheduleSimulator();

  // Schedule at position A
  sim.schedule('para-1', 'hover', () => {}, { x: 100, y: 200 });

  // Wait 60ms
  await new Promise(resolve => setTimeout(resolve, 60));

  // Small jitter (< 5px) - should update activate but not reset timer
  let activateCalled = false;
  sim.schedule('para-1', 'hover', () => { activateCalled = true; }, { x: 102, y: 203 });

  // Wait another 70ms (total 130ms from first, timer should NOT have reset)
  await new Promise(resolve => setTimeout(resolve, 70));

  // Should have triggered (timer was not reset by small jitter)
  assert.equal(sim.triggered.length, 1);
  // Position should still be the original (A), not the jittered position (B)
  assert.deepEqual(sim.triggered[0].position, { x: 100, y: 200 });
  sim.cleanup();
});

test('different keys reset the timer', async () => {
  const sim = createScheduleSimulator();

  // Schedule para-1
  sim.schedule('para-1', 'hover', () => {}, { x: 100, y: 200 });

  // Wait 60ms
  await new Promise(resolve => setTimeout(resolve, 60));

  // Schedule para-2 (different key)
  sim.schedule('para-2', 'hover', () => {}, { x: 100, y: 300 });

  // Wait 70ms
  await new Promise(resolve => setTimeout(resolve, 70));

  // para-1 should not have triggered
  assert.equal(sim.triggered.length, 0);

  // Wait for para-2 to trigger
  await new Promise(resolve => setTimeout(resolve, 60));

  assert.equal(sim.triggered.length, 1);
  assert.equal(sim.triggered[0].key, 'para-2');
  sim.cleanup();
});
