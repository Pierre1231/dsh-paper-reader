import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const url = process.env.PAPER_TEST_URL
if (!url) throw new Error('Set PAPER_TEST_URL')
const output = 'test-results/visual'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const context = await browser.newContext({ viewport: { width: 1280, height: 960 } })
await context.tracing.start({ screenshots: true, snapshots: true, sources: false })
const errors = []
const report = { layout: [], checks: [], boundary: [], screenshots: [] }
const prepare = async (page, baseline = false) => {
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url + (baseline ? '?baseline=1' : ''), { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: '#draft{display:none}#app{float:none;width:900px;height:100%;font-family:"Segoe UI","Microsoft YaHei",sans-serif}html,body{background:#f4f5f7}' })
  await page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'SuperMimic:' }).first().waitFor({ timeout: 20000 })
}
const go = async (page, number) => {
  await page.locator('.pr-page-input input').fill(String(number))
  await page.locator('.pr-page-input input').press('Enter')
  await page.locator(`[data-pdf-page="${number}"] .pr-text-layer span`).first().waitFor({ timeout: 20000 })
  if (await page.locator(`[data-pdf-page="${number}"]`).getAttribute('data-render-status') !== null) {
    await page.locator(`[data-pdf-page="${number}"][data-render-status="ready"]`).waitFor({ timeout: 20000 })
  }
}
const shot = async (page, name) => {
  await page.locator('.pr-shell').screenshot({ path: `${output}/${name}.png` })
  report.screenshots.push(`${output}/${name}.png`)
}
const hoverChart = async page => {
  const title = page.locator('[data-pdf-page="7"] .pr-text-layer span').filter({ hasText: 'Normalized return' }).first()
  const rect = await title.boundingBox()
  await page.mouse.move(rect.x + 35, rect.y + 45)
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor({ timeout: 10000 })
}
try {
  const baseline = await context.newPage()
  await prepare(baseline, true)
  await go(baseline, 7)
  await hoverChart(baseline)
  await shot(baseline, 'before-light')
  await baseline.close()

  const page = await context.newPage()
  await prepare(page)
  for (const width of [900, 640, 480, 360, 320]) {
    await page.evaluate(width => { document.querySelector('#app').style.width = `${width}px` }, width)
    const layout = await page.evaluate(() => {
      const reader = document.querySelector('.pr-reader').getBoundingClientRect()
      const title = document.querySelector('.pr-filename').getBoundingClientRect()
      const toolbar = document.querySelector('.pr-toolbar').getBoundingClientRect()
      const visible = [...document.querySelectorAll('.pr-controls button,.pr-controls input,.pr-more>button')]
      return { width: reader.width, titleWidth: title.width, toolbarHeight: toolbar.height,
        overflow: visible.some(el => { const box = el.getBoundingClientRect(); return box.left < reader.left - 1 || box.right > reader.right + 1 }) }
    })
    report.layout.push(layout)
    assert.ok(layout.titleWidth >= 40, `filename stays visible at ${width}px`)
    assert.equal(layout.overflow, false, `all main controls fit at ${width}px`)
  }
  report.checks.push('320–900px container layout')
  await go(page, 2)
  const line = page.locator('[data-pdf-page="2"] .pr-text-layer span').filter({ hasText: 'SuperMimic addresses this inefficiency' }).first()
  await page.evaluate(() => { document.querySelector('#app').style.width = '640px' })
  await line.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const dwell = await line.evaluate(async node => {
    const rect = node.getBoundingClientRect()
    const tick = () => node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: rect.left + 8, clientY: rect.top + 4 }))
    tick(); const timer = setInterval(tick, 45)
    await new Promise(resolve => setTimeout(resolve, 360))
    clearInterval(timer)
    return !!document.querySelector('.pr-hover-highlight')
  })
  assert.equal(dwell, true, 'small movement inside the same paragraph does not reset dwell')
  report.checks.push('same-target pointer jitter')
  const paragraphFeedback = await page.locator('.pr-paragraph-outline').evaluate(node => {
    const frame = node.getBoundingClientRect()
    const coveredText = [...document.querySelectorAll('[data-pdf-page="2"] .pr-text-layer span')].filter(span => {
      const rect = span.getBoundingClientRect(); return span.textContent.trim() && rect.left >= frame.left && rect.right <= frame.right && rect.top >= frame.top && rect.bottom <= frame.bottom
    })
    return { border: getComputedStyle(node).borderTopWidth, color: getComputedStyle(node).borderTopColor,
      coversRows: coveredText.length >= 5,
      fill: getComputedStyle(node).backgroundColor }
  })
  assert.ok(Number.parseFloat(paragraphFeedback.border) >= 1 && paragraphFeedback.coversRows, 'visible paragraph frame encloses the multiline selection')
  assert.notEqual(paragraphFeedback.fill, 'rgba(0, 0, 0, 0)')
  assert.equal(await page.locator('.pr-hover-highlight').count(), 1, 'one continuous surface fills the paragraph, including line gaps')
  await shot(page, 'paragraph-hover')
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.locator('.pr-paragraph-outline').evaluate(node => getComputedStyle(node).borderTopColor), paragraphFeedback.color, 'paragraph marks retain contrast on white PDF paper in dark UI')
  await shot(page, 'paragraph-hover-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  report.checks.push('continuous paragraph fill and frame in light/dark themes')

  await page.locator('.pr-selection-menu button').first().focus()
  await page.locator('.pr-reader').dispatchEvent('pointerleave')
  await page.waitForTimeout(950)
  assert.equal(await page.getByRole('toolbar', { name: '悬停段落的操作' }).isVisible(), true, 'focused actions stay open beyond close delay')
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '翻译')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.pr-selection-menu').count(), 0)
  assert.equal(await page.locator('.pr-paragraph-outline').count(), 0, 'the paragraph frame clears with the action menu')
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('pr-scroll')), true)
  report.checks.push('focus persistence, arrow navigation, Escape return')

  await page.evaluate(() => { document.querySelector('#app').style.width = '320px'; document.querySelector('.pr-scroll').scrollLeft = 90 })
  await line.evaluate(node => {
    const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 4)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('.pr-selection-menu').waitFor()
  const edge = await page.locator('.pr-selection-menu').evaluate(node => {
    const box = node.getBoundingClientRect(), bounds = document.querySelector('.pr-scroll').getBoundingClientRect()
    return { menu: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, boundary: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom } }
  })
  assert.ok(edge.menu.left >= edge.boundary.left + 7 && edge.menu.right <= edge.boundary.right - 7)
  assert.ok(edge.menu.top >= edge.boundary.top + 7)
  report.boundary.push(edge)
  await shot(page, 'after-narrow')
  await page.keyboard.press('Escape')
  await page.evaluate(() => { document.querySelector('#app').style.width = '900px'; document.querySelector('.pr-scroll').scrollLeft = 0 })

  // A selected line near the viewport top must place the menu below it.
  await line.evaluate(node => {
    const scroll = document.querySelector('.pr-scroll')
    scroll.scrollTop += node.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 9
  })
  await page.waitForTimeout(80)
  await line.evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  await page.locator('.pr-selection-menu').waitFor()
  assert.equal(await page.locator('.pr-selection-menu').getAttribute('data-placement'), 'bottom')
  report.checks.push('narrow edge clamp and top-edge flip')
  await page.keyboard.press('Escape')

  await go(page, 7)
  await page.getByRole('button', { name: '更多阅读操作' }).focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: '本页图表' }).press('Enter')
  assert.equal(await page.getByRole('menuitem', { name: /^图 \d/ }).count(), 2, 'inline Figure 5(a) prose is not listed as a figure')
  await page.getByRole('menuitem', { name: '图 3 · 第 7 页' }).press('Enter')
  await page.getByRole('toolbar', { name: '图表操作' }).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement.textContent), '解释')
  await page.locator('.pr-reader').dispatchEvent('pointerleave')
  await page.waitForTimeout(950)
  assert.equal(await page.getByRole('toolbar', { name: '图表操作' }).isVisible(), true)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('button', { name: '更多阅读操作' }).evaluate(node => node === document.activeElement), true)
  report.checks.push('keyboard figure discovery and focus return')

  await hoverChart(page)
  assert.equal(await page.locator('.pr-figure-highlight').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)')
  await shot(page, 'after-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  const dark = await page.locator('.pr-toolbar').evaluate(node => getComputedStyle(node).backgroundColor)
  assert.equal(dark, 'rgb(31, 41, 55)')
  await shot(page, 'after-dark')
  await page.evaluate(() => document.querySelector('.pr-shell').style.setProperty('--dsw-alias-bg-base', '#fafafa'))
  assert.equal(await page.locator('.pr-toolbar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(250, 250, 250)', 'host theme overrides system fallback')
  await page.evaluate(() => document.querySelector('.pr-shell').style.removeProperty('--dsw-alias-bg-base'))
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce', forcedColors: 'active' })
  const forced = await page.locator('.pr-figure-highlight').evaluate(node => ({ background: getComputedStyle(node).backgroundColor, border: getComputedStyle(node).borderTopStyle }))
  assert.equal(forced.background, 'rgba(0, 0, 0, 0)')
  assert.equal(forced.border, 'solid')
  assert.equal(await page.locator('.pr-selection-menu button').first().evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  report.checks.push('light/dark, host precedence, forced colors, reduced motion')
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference', forcedColors: 'none' })

  await page.locator('.pr-selection-menu button').first().click()
  await page.waitForFunction(() => window.testHarness.attachments.length === 1)
  await page.getByRole('status').filter({ hasText: '已加入草稿' }).waitFor()
  await page.waitForTimeout(2200)
  assert.equal(await page.locator('.pr-notice').count(), 0, 'success leaves no persistent banner')
  assert.equal(await page.locator('.pr-toolbar-status').count(), 0, 'success status expires')
  report.checks.push('figure attachment and transient success status')

  const oldWidth = await page.locator('[data-pdf-page="7"] canvas').evaluate(node => node.width)
  await page.evaluate(() => {
    window.previewFrames = []
    const end = performance.now() + 600
    const read = () => { const canvas = document.querySelector('[data-pdf-page="7"] canvas'); window.previewFrames.push(canvas.width); if (performance.now() < end) requestAnimationFrame(read) }
    read()
  })
  await page.getByRole('button', { name: '放大' }).click()
  await page.waitForFunction(old => document.querySelector('[data-pdf-page="7"] canvas').width > old && document.querySelector('[data-pdf-page="7"]').dataset.renderStatus === 'ready', oldWidth)
  await page.waitForTimeout(650)
  assert.equal(await page.evaluate(() => window.previewFrames.every(width => width > 0)), true, 'zoom keeps a visible backing bitmap')
  report.checks.push('zoom retains previous bitmap')

  const touchContext = await browser.newContext({ viewport: { width: 640, height: 960 }, hasTouch: true })
  const touchPage = await touchContext.newPage()
  await prepare(touchPage)
  await touchPage.evaluate(() => { document.querySelector('#app').style.width = '320px' })
  const touch = await touchPage.evaluate(() => {
    const reader = document.querySelector('.pr-reader').getBoundingClientRect()
    const buttons = [...document.querySelectorAll('.pr-controls button,.pr-more>button')]
    return { coarse: matchMedia('(pointer:coarse)').matches, buttons: buttons.map(node => {
      const box = node.getBoundingClientRect(); return { width: box.width, height: box.height, fits: box.left >= reader.left && box.right <= reader.right }
    }) }
  })
  assert.equal(touch.coarse, true)
  assert.ok(touch.buttons.every(box => box.width >= 44 && box.height >= 44 && box.fits), 'coarse-pointer controls keep 44px targets without overflow')
  await touchContext.close()
  report.checks.push('44px coarse-pointer targets in a 320px container')

  assert.deepEqual(errors, [])
  await writeFile(`${output}/report.json`, JSON.stringify({ ...report, errors, status: 'passed', realGui: 'not authenticated; isolated host only' }, null, 2))
  console.log(JSON.stringify({ status: 'passed', ...report, errors }))
} finally {
  await context.tracing.stop({ path: `${output}/reader-interactions.trace.zip` })
  await browser.close()
}
