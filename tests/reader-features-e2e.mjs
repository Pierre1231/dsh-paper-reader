// v0.7 reading features, end to end in an isolated Chrome page:
// fit width, ctrl-wheel zoom, remembered position, links + citation preview +
// back, search, outline, night mode, hover toggle, margin hover menu, and
// formula screenshots / cleaned text sent to the conversation.
//
//   PAPER_TEST_PDF=/path/supermimic.pdf PAPER_FORMULA_PDF=/path/1706.03762.pdf node tests/reader-features-e2e.mjs
// Env: CHROME_PATH
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const paperPath = process.env.PAPER_TEST_PDF, formulaPath = process.env.PAPER_FORMULA_PDF
if (!paperPath || !formulaPath) throw new Error('Set PAPER_TEST_PDF (SuperMimic) and PAPER_FORMULA_PDF (arXiv 1706.03762)')
const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:640px;height:100%;float:right}#draft,#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>'
const pdfs = { paper: await readFile(paperPath), formula: await readFile(formulaPath) }
let current = 'paper'
const files = { '/': [html, 'text/html; charset=utf-8'], '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [await readFile(process.env.FEATURES_CLIENT || 'lib/client.js'), 'text/javascript'] }
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  const route = path === '/paper.pdf' ? [pdfs[current], 'application/pdf'] : files[path]
  if (!route) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); res.end(route[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const report = {}
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  const pageInput = () => page.locator('.pr-page-input input').inputValue()
  const ready = number => page.locator(`[data-pdf-page="${number}"][data-render-status="ready"]`).waitFor({ timeout: 30000 })
  const go = async number => {
    await page.locator('.pr-page-input input').fill(String(number))
    await page.locator('.pr-page-input input').press('Enter')
    await ready(number)
  }
  await page.goto(url, { waitUntil: 'networkidle' })
  await ready(1)

  // 1. Fit width by default, following the panel width.
  const fitted = async () => page.evaluate(() => {
    const scroll = document.querySelector('.pr-scroll'), pages = document.querySelector('.pr-pages')
    const style = getComputedStyle(pages)
    return { page: document.querySelector('[data-pdf-page="1"]').getBoundingClientRect().width, available: scroll.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), pressed: document.querySelector('.pr-zoom').getAttribute('aria-pressed') }
  })
  let fit = await fitted()
  assert.equal(fit.pressed, 'true', 'fit width is the default')
  assert.ok(Math.abs(fit.page - fit.available) <= 2, `page fills the panel width (${fit.page} vs ${fit.available})`)
  await page.addStyleTag({ content: '#app{width:420px !important}' })
  await page.waitForFunction(() => { const p = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect().width; const s = document.querySelector('.pr-scroll'); const st = getComputedStyle(document.querySelector('.pr-pages')); return Math.abs(p - (s.clientWidth - parseFloat(st.paddingLeft) - parseFloat(st.paddingRight))) <= 2 }, undefined, { timeout: 5000 })
  report.fitWidth = true
  await page.addStyleTag({ content: '#app{width:640px !important}' })
  await page.waitForTimeout(400)

  // 2. Ctrl + wheel zooms at the pointer and keeps that point in place.
  const point = await page.evaluate(() => { const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect(); return { x: r.left + r.width * 0.3, y: r.top + r.height * 0.25 } })
  const before = await page.evaluate(({ x, y }) => { const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect(); return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height, zoom: document.querySelector('.pr-zoom').textContent } }, point)
  await page.mouse.move(point.x, point.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -240)
  await page.keyboard.up('Control')
  await page.waitForFunction(old => document.querySelector('.pr-zoom').textContent !== old, before.zoom)
  await page.waitForTimeout(200)
  const after = await page.evaluate(({ fx, fy }) => { const r = document.querySelector('[data-pdf-page="1"]').getBoundingClientRect(); return { x: r.left + fx * r.width, y: r.top + fy * r.height, zoom: document.querySelector('.pr-zoom').textContent, pressed: document.querySelector('.pr-zoom').getAttribute('aria-pressed') } }, before)
  assert.ok(parseInt(after.zoom) > parseInt(before.zoom), `ctrl+wheel zooms in (${before.zoom} → ${after.zoom})`)
  assert.equal(after.pressed, 'false', 'manual zoom leaves fit width')
  assert.ok(Math.abs(after.x - point.x) <= 4 && Math.abs(after.y - point.y) <= 4, `the point under the pointer stays put (${JSON.stringify(after)} vs ${JSON.stringify(point)})`)
  report.ctrlWheelZoom = { from: before.zoom, to: after.zoom }
  await page.locator('.pr-zoom').click() // back to fit width
  await page.waitForFunction(() => document.querySelector('.pr-zoom').getAttribute('aria-pressed') === 'true')

  // 3. Citation link: preview on hover, jump on click, then back.
  await go(2)
  const link = page.locator('[data-pdf-page="2"] .pr-link').first()
  await link.scrollIntoViewIfNeeded()
  await link.hover()
  const preview = page.locator('.pr-link-preview')
  await preview.waitFor({ state: 'visible', timeout: 5000 })
  const previewText = await preview.textContent()
  assert.ok(/第 \d+ 页/.test(previewText) && previewText.length > 40, `preview shows the destination text: ${previewText.slice(0, 80)}`)
  report.citationPreview = previewText.slice(0, 120)
  const from = Number(await pageInput())
  await link.click()
  await page.waitForFunction(old => Number(document.querySelector('.pr-page-input input').value) > old + 3, from)
  const chip = page.locator('.pr-return-chip')
  await chip.waitFor()
  assert.match(await chip.textContent(), new RegExp(`返回第 ${from} 页`))
  const jumped = Number(await pageInput())
  await chip.click()
  await page.waitForFunction(old => document.querySelector('.pr-page-input input').value === String(old), from)
  report.linkJump = { from, to: jumped, back: true }

  // 4. Search: Ctrl+F, hits highlighted, Enter steps, Esc closes.
  await page.locator('.pr-scroll').focus()
  await page.keyboard.press('Control+f')
  const input = page.getByRole('searchbox', { name: '在文档中搜索' })
  await input.waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '在文档中搜索')
  await input.fill('world model')
  await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector('.pr-search-count')?.textContent || ''), undefined, { timeout: 15000 })
  const count = await page.locator('.pr-search-count').textContent()
  const total = Number(count.split('/')[1])
  assert.ok(total >= 5, `search finds the phrase repeatedly (${count})`)
  await page.locator('.pr-search-active').first().waitFor()
  const first = Number(count.split('/')[0])
  await input.press('Enter')
  await page.waitForFunction(old => Number(document.querySelector('.pr-search-count').textContent.split('/')[0]) === (old % Number(document.querySelector('.pr-search-count').textContent.split('/')[1])) + 1, first)
  await input.press('Escape')
  await page.locator('.pr-searchbar').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.pr-search-hit').count(), 0)
  report.search = { query: 'world model', total }

  // 5. Outline: jump to a section.
  await page.getByRole('button', { name: '目录' }).click()
  const items = page.getByRole('menuitem')
  assert.ok(await items.count() >= 5, 'outline lists the sections')
  const target = items.filter({ hasText: /Related Work/ }).first()
  const startPage = Number(await pageInput())
  await target.click()
  await page.waitForFunction(old => document.querySelector('.pr-page-input input').value !== String(old), startPage)
  report.outline = { from: startPage, to: Number(await pageInput()) }

  // 6. Night mode inverts pages and keeps raster images in their real colours.
  await go(1)
  await page.getByRole('button', { name: '显示设置' }).click()
  await page.getByLabel('夜间阅读').check()
  await page.locator('.pr-reader[data-night]').waitFor()
  assert.match(await page.locator('[data-pdf-page="1"] canvas').evaluate(node => getComputedStyle(node).filter), /invert/)
  await page.locator('[data-pdf-page="1"] .pr-night-images > div').first().waitFor({ timeout: 10000 })
  await page.locator('[data-pdf-page="1"]').screenshot({ path: 'test-results/visual/night-page.png' })
  await page.getByLabel('夜间阅读').uncheck()
  await page.keyboard.press('Escape')
  report.nightMode = true

  // 7. Hover menu sits beside the paragraph (never over it); it can be switched off.
  await go(2)
  const paragraph = await page.evaluate(() => { const span = [...document.querySelectorAll('[data-pdf-page="2"] .pr-text-layer span')].find(node => node.textContent.length > 50 && node.getBoundingClientRect().top > 200); const r = span.getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 } })
  await page.mouse.move(paragraph.x, paragraph.y); await page.mouse.move(paragraph.x + 2, paragraph.y)
  const hoverMenu = page.getByRole('toolbar', { name: '悬停段落的操作' })
  await hoverMenu.waitFor({ timeout: 5000 })
  const layout = await page.evaluate(() => {
    const menu = document.querySelector('.pr-selection-menu').getBoundingClientRect(), outline = document.querySelector('.pr-hover-highlight').getBoundingClientRect()
    return { orientation: document.querySelector('.pr-selection-menu').dataset.orientation, overlap: !(menu.right <= outline.left || menu.left >= outline.right || menu.bottom <= outline.top || menu.top >= outline.bottom) }
  })
  assert.equal(layout.orientation, 'vertical')
  assert.equal(layout.overlap, false, 'the hover menu does not cover the paragraph')
  report.marginMenu = layout
  await page.mouse.move(5, 5)
  await page.getByRole('button', { name: '显示设置' }).click()
  await page.getByLabel('悬停显示操作').uncheck()
  await page.keyboard.press('Escape')
  await page.mouse.move(paragraph.x, paragraph.y); await page.mouse.move(paragraph.x + 2, paragraph.y)
  await page.waitForTimeout(700)
  assert.equal(await hoverMenu.count(), 0, 'hover actions can be switched off')
  await page.getByRole('button', { name: '显示设置' }).click()
  await page.getByLabel('悬停显示操作').check()
  await page.keyboard.press('Escape')
  report.hoverToggle = true

  // 8. The reading position survives a restart.
  await go(6)
  await page.waitForTimeout(900)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForFunction(() => document.querySelector('.pr-page-input input')?.value === '6', undefined, { timeout: 15000 })
  report.restoredPage = 6

  // 9. Formulas are sent with a typeset screenshot; text loses printed line breaks.
  current = 'formula'
  await page.reload({ waitUntil: 'networkidle' })
  await ready(1)
  await go(4)
  const spanCenter = text => page.evaluate(text => { const span = [...document.querySelectorAll('[data-pdf-page="4"] .pr-text-layer span')].find(node => node.textContent === text || node.textContent.startsWith(text)); span.scrollIntoView({ block: 'center' }); const r = span.getBoundingClientRect(); return { x: r.left + Math.min(10, r.width / 2), y: r.top + r.height / 2 } }, text)
  let spot = await spanCenter('Attention(')
  await page.waitForTimeout(300)
  spot = await spanCenter('Attention(')
  await page.mouse.move(spot.x, spot.y); await page.mouse.move(spot.x + 1, spot.y)
  await hoverMenu.waitFor({ timeout: 5000 })
  await hoverMenu.getByRole('button', { name: '解释' }).click()
  await page.waitForFunction(() => window.testHarness.sentMessages.length === 1, undefined, { timeout: 20000 })
  const formula = await page.evaluate(() => { const m = window.testHarness.sentMessages[0]; return { text: m.text, files: m.files.map(file => ({ name: file.name, type: file.type, size: file.size })) } })
  assert.equal(formula.files.length, 1, 'the formula image is attached')
  assert.match(formula.files[0].name, /第4页公式\.png$/)
  assert.ok(formula.files[0].size > 2000)
  assert.match(formula.text, /Attention\(Q, K, V\) = softmax\(/)
  assert.match(formula.text, /附图/)
  report.formulaImage = formula.files[0]
  spot = await spanCenter('plicative) attention.')
  await page.mouse.move(5, 5)
  await page.mouse.move(spot.x, spot.y); await page.mouse.move(spot.x + 1, spot.y)
  await hoverMenu.waitFor({ timeout: 5000 })
  await hoverMenu.getByRole('button', { name: '复制' }).click()
  await page.waitForTimeout(300)
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  assert.match(copied, /\(multiplicative\)/, 'soft hyphenation across lines is joined')
  assert.ok(!copied.includes('\n'), 'printed line breaks are removed inside a paragraph')
  report.cleanText = copied.slice(0, 120)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ status: 'passed', ...report }, null, 1))
} finally {
  await browser.close(); server.close()
}
