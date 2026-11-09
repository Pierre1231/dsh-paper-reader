import assert from 'node:assert/strict'
import { chromium } from 'playwright-core'
import { forgetReadingPositions, useActualSize } from './reader-helpers.mjs'
const url = process.env.PAPER_TEST_URL
if (!url) throw new Error('Set PAPER_TEST_URL')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const errors = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 960 } })
  await forgetReadingPositions(page)
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url, { waitUntil: 'networkidle' })
  await useActualSize(page)
  const go = async number => {
    await page.evaluate(number => { const scroll = document.querySelector('.pr-scroll'); scroll.scrollTop = document.querySelector(`[data-pdf-page="${number}"]`).offsetTop - 16 }, number)
    await page.locator(`[data-pdf-page="${number}"][data-render-status="ready"]`).waitFor({ timeout: 20000 })
  }
  await page.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 20000 })
  await page.locator('[data-pdf-page="2"][data-render-status="ready"]').waitFor({ timeout: 20000 })
  const selectedText = await page.evaluate(() => {
    const start = document.querySelector('[data-pdf-page="1"] .pr-text-layer span:not(.markedContent)').firstChild
    const end = document.querySelector('[data-pdf-page="2"] .pr-text-layer span:not(.markedContent)').firstChild
    const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, end.textContent.length)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    return selection.toString()
  })
  for (const number of [6, 10, 14, 19]) await go(number)
  await page.waitForTimeout(800)
  // v0.6 memory policy: sharp bitmaps outside the render band are kept up to a
  // budget (8 pages / 128 MiB); beyond it the farthest shrink to a 1/4-size
  // placeholder instead of going blank. Selected pages are never shrunk.
  const pages = () => page.evaluate(() => [...document.querySelectorAll('[data-pdf-page]')].map(node => ({ number: Number(node.dataset.pdfPage), status: node.dataset.canvasStatus, pixels: node.querySelector('canvas').width * node.querySelector('canvas').height })))
  let state = await pages()
  const sharp = state.filter(item => item.status === 'ready').map(item => item.number)
  const placeholders = state.filter(item => item.status === 'placeholder')
  assert.ok(sharp.includes(1) && sharp.includes(2), `both pages of an active cross-page selection stay sharp: ${sharp}`)
  assert.ok(sharp.length <= 8, `sharp bitmaps stay within the page budget: ${sharp}`)
  assert.ok(placeholders.length > 0 && !sharp.includes(6), `pages beyond the budget become placeholders: ${placeholders.map(item => item.number)}`)
  const fullPixels = Math.max(...state.filter(item => item.status === 'ready').map(item => item.pixels))
  assert.ok(placeholders.every(item => item.pixels * 10 < fullPixels), 'placeholders are a fraction of a sharp page')
  assert.equal(await page.evaluate(() => getSelection().toString()), selectedText)
  await page.evaluate(() => getSelection().removeAllRanges())
  // Clearing the selection releases the pin: once more pages are read and the
  // budget is exceeded again, pages 1 and 2 (now the farthest) shrink first.
  for (const number of [12, 16, 19]) { await go(number); await page.waitForTimeout(300) }
  await page.waitForFunction(() => [1, 2].every(number => document.querySelector(`[data-pdf-page="${number}"]`).dataset.canvasStatus !== 'ready'), undefined, { timeout: 5000 })
  const retained = (await pages()).filter(item => item.pixels > 0).map(item => item.number)
  // Jumping back shows the placeholder at once (no blank page), then redraws sharp with text.
  const jumpBack = await page.evaluate(async () => {
    const scroll = document.querySelector('.pr-scroll'); scroll.scrollTop = 0
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const node = document.querySelector('[data-pdf-page="1"]')
    return { pixels: node.querySelector('canvas').width, label: !!node.querySelector('.pr-page-status') }
  })
  assert.ok(jumpBack.pixels > 0 && !jumpBack.label, 'a recycled page shows its placeholder immediately when scrolled back')
  await go(1)
  assert.ok(await page.locator('[data-pdf-page="1"] .pr-text-layer span').count() > 10, 'a recycled page redraws with selectable text')
  state = await pages()

  await go(7)
  const title = page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Normalized return' }).first()
  const box = await title.boundingBox()
  await page.evaluate(() => {
    window.scrollProbe = { spans: 0, pixels: 0 }
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.matches?.('.pr-text-layer span') && this.closest('[data-pdf-page]')?.dataset.pdfPage === '7') window.scrollProbe.spans++
      return rect.apply(this, args)
    }
    const read = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...args) { window.scrollProbe.pixels++; return read.apply(this, args) }
  })
  for (let step = 0; step < 6; step++) {
    await page.locator('.pr-scroll').evaluate(node => { node.scrollTop += 3 })
    await page.mouse.move(box.x + 35 + step % 2, box.y + 45)
    await page.waitForTimeout(40)
  }
  const during = await page.evaluate(() => ({ ...window.scrollProbe }))
  assert.equal(during.spans, 0, 'active scrolling skips full-page hover geometry scans')
  assert.equal(during.pixels, 0, 'active scrolling skips synchronous figure pixel readbacks')
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 5000 })
  assert.ok(await page.evaluate(() => window.scrollProbe.pixels > 0), 'hover resumes at the pointer after scroll settles')
  assert.equal(await page.evaluate(() => window.testHarness.sentMessages.length), 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', sharpWithCrossPageSelection: sharp, retainedAfterDeselect: retained, selectionSurvives: true, releaseAfterDeselect: true, placeholderOnJumpBack: true, recycledPageRedraw: true, hoverWorkSkippedDuringScroll: during, hoverResumes: true, errors }))
} finally { await browser.close() }
