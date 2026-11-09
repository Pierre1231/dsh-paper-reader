// Shared setup for browser tests written against 100% zoom.
//
// Since v0.7 the reader opens at "fit width" and reopens a document where the
// reader left it. Tests that check other behaviour start every load at page 1
// and switch to 100% through the zoom button, exactly as a user would.

/** Call before page.goto (or on a context): every load starts without a remembered position. */
export async function forgetReadingPositions(target) {
  await target.addInitScript(() => {
    try { for (const key of Object.keys(localStorage)) if (key.startsWith('dsh-paper-reader:view')) localStorage.removeItem(key) } catch { /* storage blocked */ }
  })
}

/** Switch the open reader from fit width to 100% (no-op when already at a fixed zoom). */
export async function useActualSize(page) {
  await page.waitForFunction(() => { const zoom = document.querySelector('.pr-zoom'); return zoom && !zoom.disabled })
  const zoom = page.locator('.pr-zoom')
  if (await zoom.getAttribute('aria-pressed') === 'true') await zoom.click()
  await page.waitForFunction(() => document.querySelector('.pr-zoom')?.textContent === '100%')
}
