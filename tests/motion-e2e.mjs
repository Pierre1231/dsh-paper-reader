import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const directory = await mkdtemp(path.join(tmpdir(), 'paper-motion-'))
const pdfPath = path.join(directory, 'motion.pdf')
const objects = [
  '<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ...[1, 2].map(number => {
    const stream = `BT /F1 16 Tf 70 700 Td (Reading motion page ${number}) Tj 0 -40 Td (A paragraph for selection and search.) Tj 0 -40 Td (Another paragraph for hover feedback.) Tj 0 -60 Td (Jump to next chapter.) Tj ET`
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  }),
  '<< /Type /Annot /Subtype /Link /Rect [70 548 370 572] /Dest [4 0 R /XYZ null 700 null] >>',
  '<< /Type /Outlines /First 10 0 R /Last 10 0 R /Count 1 >>',
  '<< /Title (Second chapter) /Parent 9 0 R /Dest [4 0 R /XYZ null 700 null] >>'
]
let pdf = '%PDF-1.4\n'
const offsets = [0]
objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
const xref = Buffer.byteLength(pdf)
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
await writeFile(pdfPath, pdf)
const server = spawn(process.execPath, ['tests/browser-server.mjs'], { env: { ...process.env, PAPER_TEST_PDF: pdfPath }, stdio: ['ignore', 'pipe', 'pipe'] })
let browser
try {
  const url = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Test server timed out')), 20000)
    server.stdout.on('data', chunk => { output += chunk; const match = output.match(/PAPER_TEST_URL=(\S+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    server.stderr.on('data', chunk => process.stderr.write(chunk))
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)) })
  })
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true })
  const page = await browser.newPage()
  await page.addInitScript(() => localStorage.setItem('dsh-paper-reader:prefs', JSON.stringify({ night: true, hoverMenu: true })))
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url)
  const text = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'Reading motion page 1' }).first()
  await text.waitFor()
  await page.getByRole('button', { name: '显示设置', exact: true }).click()
  const displaySettings = page.getByRole('dialog', { name: '显示设置' })
  assert.equal(await displaySettings.getByRole('checkbox').count(), 1)
  assert.equal(await displaySettings.getByRole('checkbox', { name: /悬停显示操作/ }).isChecked(), true)
  await page.keyboard.press('Escape')
  const select = async () => {
    await text.evaluate(node => {
      const range = document.createRange()
      range.selectNodeContents(node)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await page.locator('.pr-selection-menu:not([data-closing])').waitFor()
  }
  await select()
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await page.waitForFunction(() => document.querySelector('.pr-selection-menu')?.hasAttribute('data-closing'))
  assert.equal(await page.locator('.pr-selection-menu').evaluate(node => getComputedStyle(node).pointerEvents), 'none')
  await select()
  await page.waitForTimeout(130)
  assert.equal(await page.locator('.pr-selection-menu:not([data-closing])').count(), 1)
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await page.locator('.pr-selection-menu').waitFor({ state: 'detached' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await select()
  assert.equal(await page.locator('.pr-selection-menu').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  await page.evaluate(() => window.getSelection().removeAllRanges())
  await page.locator('.pr-selection-menu').waitFor({ state: 'detached' })
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const paragraph = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'A paragraph for selection' }).first()
  const nextParagraph = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'Another paragraph' }).first()
  const highlight = page.locator('.pr-hover-highlight')
  const moveWithin = (target, offset) => target.evaluate((node, offset) => {
    const bounds = node.getBoundingClientRect()
    node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: bounds.left + offset, clientY: bounds.top + bounds.height / 2 }))
  }, offset)
  const clockStart = Date.now()
  await page.clock.install({ time: clockStart })
  await page.clock.pauseAt(clockStart + 1000)
  await moveWithin(paragraph, 8)
  await page.clock.runFor(64)
  await moveWithin(nextParagraph, 8)
  await page.clock.runFor(56)
  assert.equal(await highlight.count(), 0, 'crossing into another paragraph starts a new dwell')
  await moveWithin(nextParagraph, 20)
  await page.clock.runFor(56)
  assert.equal(await highlight.count(), 1, 'moving within the same paragraph keeps its original dwell deadline')
  const nextBounds = await nextParagraph.boundingBox()
  assert.ok(Math.abs((await highlight.boundingBox()).y - nextBounds.y) < 10, 'only the new paragraph is highlighted')
  assert.equal(await highlight.evaluate(node => getComputedStyle(node).transitionDuration), '0.07s')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await highlight.evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.locator('.pr-reader').dispatchEvent('pointerleave')
  await page.clock.runFor(400)
  await page.clock.resume()
  await highlight.waitFor({ state: 'detached' })
  await paragraph.hover()
  await page.locator('.pr-hover-highlight').waitFor()
  const originalTop = await page.locator('.pr-hover-highlight').evaluate(node => node.getBoundingClientRect().top)
  await page.locator('.pr-selection-menu').evaluate(node => { window.originalMotionMenu = node })
  await highlight.evaluate(node => { window.originalMotionHighlight = node })
  await nextParagraph.hover()
  assert.equal(await page.locator('.pr-selection-menu').evaluate(node => node === window.originalMotionMenu && !node.hasAttribute('data-closing')), true)
  await page.waitForFunction(top => document.querySelector('.pr-hover-highlight')?.getBoundingClientRect().top > top + 10, originalTop)
  assert.equal(await highlight.evaluate(node => node === window.originalMotionHighlight), true, 'handoff does not remount the highlight')
  await page.locator('.pr-selection-menu button').first().focus()
  await page.locator('.pr-reader').dispatchEvent('pointerleave')
  await page.waitForTimeout(400)
  assert.equal(await page.locator('.pr-selection-menu:not([data-closing])').count(), 1)
  await page.evaluate(() => { document.activeElement.blur(); document.querySelector('.pr-reader').dispatchEvent(new PointerEvent('pointerleave')) })
  await page.locator('.pr-selection-menu').waitFor({ state: 'detached', timeout: 1200 })
  await paragraph.hover()
  await highlight.waitFor()
  const scrollMovement = await paragraph.evaluate(node => {
    const scroll = document.querySelector('.pr-scroll')
    const frame = document.querySelector('.pr-hover-highlight')
    const paragraphTop = node.getBoundingClientRect().top
    const highlightTop = frame.getBoundingClientRect().top
    scroll.scrollTop += 48
    return {
      paragraph: node.getBoundingClientRect().top - paragraphTop,
      highlight: frame.getBoundingClientRect().top - highlightTop
    }
  })
  assert.ok(scrollMovement.paragraph < -40, 'the PDF scrolled before the scroll handler could run')
  assert.ok(Math.abs(scrollMovement.highlight - scrollMovement.paragraph) < 1,
    `highlight moves with the PDF before scroll cleanup: paragraph ${scrollMovement.paragraph}px, highlight ${scrollMovement.highlight}px`)
  await highlight.waitFor({ state: 'detached' })
  await page.mouse.move(8, 8)
  const filenameBefore = await page.locator('.pr-filename').boundingBox()
  await page.getByRole('button', { name: '生成阅读笔记', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.pr-toolbar-status[data-kind="success"]')?.textContent.includes('笔记指令已加入草稿'))
  assert.equal(await page.locator('.pr-status-icon').count(), 1)
  assert.deepEqual(await page.locator('.pr-filename').boundingBox(), filenameBefore)
  assert.match(await page.evaluate(() => window.testHarness.getDraft()), /笔记/)
  await page.evaluate(() => { window.testHarness.conversation.sendDelay = 300 })
  await select()
  await page.locator('.pr-selection-menu button').filter({ hasText: '解释' }).click()
  await page.locator('.pr-toolbar-status[data-kind="progress"] .pr-spinner').waitFor()
  await page.waitForFunction(() => document.querySelector('.pr-toolbar-status[data-kind="success"]')?.textContent === '已发送')
  const loadingPage = await browser.newPage()
  await loadingPage.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window)
    const cancel = window.cancelAnimationFrame.bind(window)
    let paused = true
    let sequence = 0
    const pending = new Map()
    window.requestAnimationFrame = callback => {
      if (!paused) return original(callback)
      const identifier = --sequence
      pending.set(identifier, callback)
      return identifier
    }
    window.cancelAnimationFrame = identifier => identifier < 0 ? pending.delete(identifier) : cancel(identifier)
    window.pauseReaderFrames = () => { paused = true }
    window.releaseReaderFrames = () => { paused = false; for (const callback of pending.values()) original(callback); pending.clear() }
  })
  await loadingPage.goto(url)
  await loadingPage.waitForFunction(() => !!document.querySelector('.pr-page-skeleton'), { }, { polling: 50 })
  assert.equal(await loadingPage.locator('.pr-page[data-canvas-status="loading"]').first().evaluate(node => getComputedStyle(node).opacity), '1')
  await loadingPage.evaluate(() => window.releaseReaderFrames())
  await loadingPage.locator('[data-pdf-page="1"][data-canvas-status="ready"]').waitFor()
  assert.equal(await loadingPage.locator('[data-pdf-page="1"] .pr-page-skeleton').count(), 0)
  await loadingPage.evaluate(() => { window.pauseReaderFrames(); document.querySelector('button[aria-label="放大"]').click() })
  await loadingPage.waitForFunction(() => document.querySelector('[data-pdf-page="1"]')?.dataset.canvasStatus === 'stale', {}, { polling: 50 })
  assert.equal(await loadingPage.locator('[data-pdf-page="1"] .pr-page-skeleton').count(), 0)
  assert.equal(await loadingPage.locator('[data-pdf-page="1"] canvas').evaluate(node => node.width > 0 && getComputedStyle(node.parentElement).opacity === '1'), true)
  await loadingPage.evaluate(() => window.releaseReaderFrames())
  await loadingPage.locator('[data-pdf-page="1"][data-canvas-status="ready"]').waitFor()
  assert.equal(await loadingPage.locator('[data-pdf-page="1"][data-first-reveal]').count(), 0)
  await loadingPage.close()
  await page.emulateMedia({ colorScheme: 'dark' })
  assert.equal(await page.locator('[data-pdf-page="1"] canvas').evaluate(node => getComputedStyle(node).filter), 'none')
  assert.equal(await page.locator('[data-pdf-page="1"]').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)')
  await page.evaluate(() => {
    const shell = document.querySelector('.pr-shell')
    shell.style.setProperty('--dsw-alias-bg-base', '#fbfaf7')
    shell.style.setProperty('--dsw-alias-label-primary', '#22222f')
  })
  await select()
  assert.equal(await page.locator('.pr-toolbar').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(251, 250, 247)')
  assert.match(await page.locator('.pr-selection-menu').evaluate(node => getComputedStyle(node).backgroundImage), /rgb\(251, 250, 247\)/)
  assert.equal(await page.locator('.pr-selection-menu').evaluate(node => getComputedStyle(node).color), 'rgb(34, 34, 47)')
  await mkdir('test-results/motion', { recursive: true })
  await page.locator('.pr-shell').screenshot({ path: 'test-results/motion/host-light-system-dark.png' })
  await page.evaluate(() => { const shell = document.querySelector('.pr-shell'); shell.style.setProperty('--dsw-alias-bg-base', '#1f2937'); shell.style.setProperty('--dsw-alias-label-primary', '#e6edf3') })
  await page.emulateMedia({ colorScheme: 'light' })
  assert.match(await page.locator('.pr-selection-menu').evaluate(node => getComputedStyle(node).backgroundImage), /rgb\(31, 41, 55\)/)
  await page.locator('.pr-shell').screenshot({ path: 'test-results/motion/host-dark-system-light.png' })
  for (const width of [320, 480, 640, 900]) {
    await page.evaluate(width => { document.querySelector('#app').style.width = `${width}px` }, width)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const layout = await page.locator('.pr-toolbar').evaluate(node => {
      const bounds = node.getBoundingClientRect()
      return { titleWidth: node.querySelector('.pr-filename').getBoundingClientRect().width,
        overflow: [...node.querySelectorAll('button,input')].some(control => { const rect = control.getBoundingClientRect(); return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 }) }
    })
    assert.ok(layout.titleWidth >= 40, `title remains readable at ${width}px`)
    assert.equal(layout.overflow, false, `toolbar fits ${width}px`)
  }
  await page.evaluate(() => { window.testHarness.conversation.failNextSend = 1 })
  await select()
  await page.locator('.pr-selection-menu button').filter({ hasText: '解释' }).click()
  await page.getByRole('alert').filter({ hasText: '发送失败' }).waitFor()
  await page.getByRole('button', { name: '重试发送', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.pr-toolbar-status[data-kind="success"]')?.textContent === '已发送')
  assert.deepEqual(errors, [])
  await page.evaluate(() => { const root = document.querySelector('.pr-scroll'); root.scrollTop = 150 })
  const pageTop = () => page.locator('[data-pdf-page="1"]').evaluate(node => node.getBoundingClientRect().top)
  const beforeSearch = await pageTop()
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  assert.ok(Math.abs(await pageTop() - beforeSearch) < 2, 'opening search preserves the reading line')
  await page.getByRole('searchbox').fill('paragraph')
  await page.locator('.pr-search-active').first().waitFor()
  await page.locator('.pr-location-cue').waitFor()
  await page.getByRole('button', { name: '下一个结果', exact: true }).click()
  await page.locator('.pr-location-cue').waitFor()
  await page.waitForTimeout(1000)
  assert.equal(await page.locator('.pr-location-cue').count(), 0)
  await page.evaluate(() => { document.querySelector('.pr-scroll').scrollTop = 200 })
  const beforeClose = await pageTop()
  await page.getByRole('searchbox').press('Escape')
  await page.locator('.pr-searchbar').waitFor({ state: 'detached' })
  const afterClose = await pageTop()
  assert.ok(Math.abs(afterClose - beforeClose) < 2, `closing search preserves the reading line (${beforeClose} → ${afterClose})`)
  assert.equal(await page.locator('.pr-scroll').evaluate(node => node === document.activeElement), true)
  await page.getByRole('button', { name: '目录', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Second chapter' }).click()
  await page.locator('[data-pdf-page="2"] .pr-location-cue').waitFor()
  await page.getByRole('button', { name: '返回第 1 页' }).click()
  await page.locator('[data-pdf-page="1"] .pr-location-cue').waitFor()
  await page.locator('[data-pdf-page="1"] .pr-link').click()
  await page.locator('[data-pdf-page="2"] .pr-location-cue').waitFor()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await page.locator('.pr-location-cue').evaluate(node => getComputedStyle(node).animationName), 'none')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  assert.equal(await page.locator('.pr-searchbar').evaluate(node => getComputedStyle(node).transitionDuration), '0s')
  assert.deepEqual(errors, [])
  console.log('PASS: menus, feedback, loading, zoom, themes, responsive toolbar, anchored search, outline/link navigation')
} finally {
  await browser?.close()
  server.kill()
  await rm(directory, { recursive: true, force: true })
}
