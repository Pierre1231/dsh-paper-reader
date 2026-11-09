// Mouse-drag selection across display equations, as a reader does it.
//
//   PAPER_FORMULA_PDF=/path/1706.03762.pdf node tests/formula-selection-e2e.mjs [client.js ...]
// ("Attention Is All You Need", arXiv 1706.03762, page 4, equation (1).)
// Env: CHROME_PATH
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const pdfPath = process.env.PAPER_FORMULA_PDF
if (!pdfPath) throw new Error('Set PAPER_FORMULA_PDF to arXiv 1706.03762')
const clients = process.argv.slice(2).length ? process.argv.slice(2) : ['lib/client.js']
const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:760px;height:100%;float:right}#draft,#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>'
const pdf = await readFile(pdfPath)
let client
const server = http.createServer((req, res) => {
  const route = { '/': [html, 'text/html; charset=utf-8'], '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [client, 'text/javascript'], '/paper.pdf': [pdf, 'application/pdf'] }[new URL(req.url, 'http://x').pathname]
  if (!route) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' }); res.end(route[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

const normalize = text => text.replace(/\s+/g, '')
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = []
try {
  for (const path of clients) {
    client = await readFile(path)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 })
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 30000 })
    await page.evaluate(() => { const scroll = document.querySelector('.pr-scroll'); scroll.scrollTop = document.querySelector('[data-pdf-page="4"]').offsetTop - 16 })
    await page.locator('[data-pdf-page="4"][data-render-status="ready"]').waitFor({ timeout: 30000 })
    // Bring equation (1) to the middle of the reader.
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('[data-pdf-page="4"] .pr-text-layer span')].find(node => node.textContent === 'Attention(')
      const scroll = document.querySelector('.pr-scroll')
      scroll.scrollTop += span.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 300
    })
    await page.waitForTimeout(400)
    const box = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('[data-pdf-page="4"] .pr-text-layer span')]
      const index = spans.findIndex(node => node.textContent === 'Attention(')
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
      const start = rect(spans[index])
      const v = spans.slice(index).find(node => node.textContent === 'V' && node.getBoundingClientRect().left > start.right + 100)
      const number = spans.slice(index).find(node => node.textContent === '(1)')
      return { start, v: rect(v), number: rect(number) }
    })
    const drag = async (from, to, steps = 24) => {
      await page.evaluate(() => getSelection().removeAllRanges())
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      for (let step = 1; step <= steps; step++) await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps)
      await page.mouse.up()
      await page.waitForTimeout(150)
      return page.evaluate(() => getSelection().toString())
    }
    const y = (box.start.top + box.start.bottom) / 2
    const result = { client: path, errors }
    // 1. Main line, left of "Attention(" to just right of the closing "V".
    result.toV = await drag({ x: box.start.left + 1, y }, { x: box.v.right + 2, y })
    // 2. Whole equation including the number, released just past it.
    result.toNumber = await drag({ x: box.start.left + 1, y }, { x: box.number.right + 3, y })
    // 3. Released in the blank gap between "V" and "(1)".
    result.releaseInGap = await drag({ x: box.start.left + 1, y }, { x: (box.v.right + box.number.left) / 2, y })
    // 4. Backwards: from the end of "V" back to the start.
    result.backwards = await drag({ x: box.v.right - 0.5, y }, { x: box.start.left + 1, y })
    // 5. Started in the margin just left of the equation.
    result.fromMargin = await drag({ x: box.start.left - 8, y }, { x: box.v.right + 2, y })
    // 6. Ordinary prose, both ends on text: must equal native selection.
    const prose = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('[data-pdf-page="4"] .pr-text-layer span')]
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
      return { from: rect(spans.find(node => node.textContent.startsWith('The two most commonly used'))), to: rect(spans.find(node => node.textContent.startsWith('plicative) attention.'))) }
    })
    result.prose = await drag({ x: prose.from.left + 1, y: (prose.from.top + prose.from.bottom) / 2 }, { x: prose.to.right - 30, y: (prose.to.top + prose.to.bottom) / 2 })
    // 7. Two-line display equation with sub/superscripts (page 5).
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('[data-pdf-page="5"] .pr-text-layer span')].find(node => node.textContent === 'MultiHead(')
      const scroll = document.querySelector('.pr-scroll')
      if (span) scroll.scrollTop += span.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 300
      else scroll.scrollTop = document.querySelector('[data-pdf-page="5"]').offsetTop
    })
    await page.locator('[data-pdf-page="5"][data-render-status="ready"]').waitFor({ timeout: 30000 })
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('[data-pdf-page="5"] .pr-text-layer span')].find(node => node.textContent === 'MultiHead(')
      const scroll = document.querySelector('.pr-scroll')
      scroll.scrollTop += span.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 300
    })
    await page.waitForTimeout(300)
    const multi = await page.evaluate(() => {
      const spans = [...document.querySelectorAll('[data-pdf-page="5"] .pr-text-layer span')]
      const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom } }
      const start = spans.findIndex(node => node.textContent === 'MultiHead(')
      const attention = spans.findIndex(node => node.textContent === '= Attention(')
      const close = spans.slice(attention).find(node => node.textContent === ')')
      return { from: rect(spans[start]), to: rect(close) }
    })
    result.twoLine = await drag({ x: multi.from.left + 1, y: (multi.from.top + multi.from.bottom) / 2 }, { x: multi.to.right + 2, y: (multi.to.top + multi.to.bottom) / 2 })
    results.push(result)
    console.log(JSON.stringify(result))
    await page.close()
  }
} finally { await browser.close(); server.close() }

const whole = 'Attention(Q,K,V)=softmax(QKT√dk)V'
for (const result of results) {
  assert.deepEqual(result.errors, [])
  for (const key of ['toV', 'releaseInGap', 'backwards', 'fromMargin']) {
    assert.equal(normalize(result[key]), whole, `${result.client} ${key}: whole equation selected`)
  }
  assert.equal(normalize(result.toNumber), whole + '(1)', `${result.client} toNumber: equation and its number`)
  assert.equal(normalize(result.twoLine), 'MultiHead(Q,K,V)=Concat(head1,...,headh)WOwhereheadi=Attention(QWQi,KWKi,VWVi)', `${result.client} twoLine: both lines of the equation`)
  assert.ok(result.prose.startsWith('The two most commonly used') && result.prose.includes('(multi-\nplicative)'), `${result.client} prose: multi-line drag`)
}
// Both ends on text: geometry selection must give what native selection gives,
// up to one glyph at the release point (the two round mid-glyph points differently).
if (results.length > 1) for (const result of results) {
  const [a, b] = [result.prose, results[0].prose].sort((x, y) => x.length - y.length)
  assert.ok(b.startsWith(a) && b.length - a.length <= 1, `${result.client} prose drag matches native selection`)
}
console.log('formula selection: ok')
