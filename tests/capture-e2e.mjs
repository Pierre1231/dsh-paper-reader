import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
const url = process.env.PAPER_TEST_URL
if (!url) throw new Error('Set PAPER_TEST_URL')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const errors = []
const setup = async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.locator('[data-pdf-page="1"] .pr-text-layer span').first().waitFor({ timeout: 20000 })
  await page.locator('.pr-page-input input').fill('7')
  await page.locator('.pr-page-input input').press('Enter')
  await page.locator('[data-pdf-page="7"][data-render-status="ready"]').waitFor({ timeout: 20000 })
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.toBlob
    window.encodes = []
    window.encodeCount = 0
    window.encodeBlocked = true
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      window.encodeCount++
      original.call(this, blob => {
        if (window.encodeBlocked) window.encodes.push(() => callback(blob))
        else callback(blob)
      }, ...args)
    }
    window.releaseEncodes = () => { window.encodeBlocked = false; for (const release of window.encodes.splice(0)) release() }
  })
  return page
}
const hover = async (page, index) => {
  const title = page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Normalized return' }).nth(index)
  const box = await title.boundingBox()
  await page.mouse.move(box.x + 35, box.y + 45)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 10000 })
  return box
}
try {
  const page = await setup()
  await hover(page, 0)
  await page.waitForFunction(() => window.encodes.length === 1)
  const first = await page.locator('.pr-figure-highlight').boundingBox()
  const secondTitle = page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Normalized return' }).nth(1)
  const second = await secondTitle.boundingBox()
  await page.mouse.move(second.x + 35, second.y + 45)
  await page.waitForFunction(top => document.querySelector('.pr-figure-highlight')?.getBoundingClientRect().top > top + 60, first.y)
  await page.waitForFunction(() => window.encodes.length === 2)
  await page.locator('.pr-selection-menu button').first().click()
  await page.getByRole('status').filter({ hasText: '正在准备清晰图表' }).waitFor()
  // Repeated click on the same still-pending action is acknowledged only once.
  await hover(page, 1)
  await page.locator('.pr-selection-menu button').first().click()
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.length), 0)
  await page.evaluate(() => window.releaseEncodes())
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 1)
  await page.waitForTimeout(100)
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.length), 1)
  assert.equal(await page.evaluate(() => window.encodeCount), 2, 'claimed capture survives menu closure and is reused')
  // A completed capture is cached for an intentional later action.
  await hover(page, 1)
  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 2)
  assert.equal(await page.evaluate(() => window.encodeCount), 2, 'completed capture is reused without another PNG encode')
  await page.close()

  const outgoing = await setup()
  await hover(outgoing, 0)
  await outgoing.waitForFunction(() => window.encodes.length === 1)
  await outgoing.locator('.pr-selection-menu button').first().click()
  await outgoing.getByRole('status').filter({ hasText: '正在准备清晰图表' }).waitFor()
  await outgoing.evaluate(() => window.testHarness.renderLocal())
  await outgoing.locator('input[type=file]').waitFor()
  await outgoing.evaluate(() => window.releaseEncodes())
  await outgoing.waitForTimeout(150)
  assert.equal(await outgoing.evaluate(() => window.testHarness.sentMessages.length), 0, 'outgoing reader never inserts a delayed image into another document')
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', abandonedPrefetch: true, claimedCaptureSurvives: true, duplicatePendingAction: true, completedCaptureCache: true, documentSwitch: true, errors }))
} finally { await browser.close() }
