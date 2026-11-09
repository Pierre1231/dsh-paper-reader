// Main-thread stress probe for the reader in an isolated Chrome page.
//
// It does NOT replace acceptance inside the real DSH GUI. It answers one
// narrower question: which host conditions turn PDF opening into a multi-second
// UI freeze, and does the reader keep the main thread responsive under them?
//
//   PAPER_TEST_PDF=/path/paper.pdf node tests/host-stress.mjs
//
// Matrix (each runs in a fresh browser context):
//   worker  = thread | blocked   (blocked: CSP `worker-src 'none'`, so PDF.js
//                                  would fall back to parsing on the main thread)
//   host    = light | heavy      (heavy: ~40k chat-like nodes plus global
//                                  sibling / :has() selectors)
// Env: CHROME_PATH, STRESS_ONLY="thread:heavy,blocked:light", STRESS_CLIENT=lib/client.js,
//      STRESS_SCROLL=1 to also scroll through the document.
import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const pdfPath = process.env.PAPER_TEST_PDF
if (!pdfPath) throw new Error('Set PAPER_TEST_PDF')
const clientPath = process.env.STRESS_CLIENT || 'lib/client.js'
const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const heavyHost = `
<style>
  .host-chat * + * { margin-top: 2px }
  .host-chat p:last-child { margin-bottom: 0 }
  .host-chat li:nth-child(2n) { color: #333 }
  body:has(.pr-selection-menu) .host-chat { outline: 0 }
  :where(div, span):has(> code) { letter-spacing: 0 }
</style>
<script>
  addEventListener('DOMContentLoaded', () => {
    const chat = document.createElement('div'); chat.className = 'host-chat'
    const html = []
    for (let i = 0; i < 1600; i++) html.push('<article><p>Message ' + i + ' <b>bold</b> <code>x = ' + i + '</code> some ordinary chat text that wraps.</p><ul><li>a</li><li>b</li><li>c</li></ul><pre><span>const</span> <span>v</span> = <span>' + i + '</span></pre></article>')
    chat.innerHTML = html.join('')
    document.querySelector('#draft').after(chat)
  })
</script>`
const page = host => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:640px;height:100%;float:right}#draft{display:none}#open-result{display:none}.host-chat{height:100%;overflow:auto;width:calc(100% - 660px);float:left;font:14px system-ui}</style>${host === 'heavy' ? heavyHost : ''}</head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>`
const files = { '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [await readFile(clientPath), 'text/javascript'], '/paper.pdf': [await readFile(pdfPath), 'application/pdf'] }
const server = http.createServer((req, res) => {
  const address = new URL(req.url, 'http://localhost')
  const headers = { 'Cache-Control': 'no-store' }
  if (address.searchParams.get('worker') === 'blocked') headers['Content-Security-Policy'] = "worker-src 'none'"
  if (address.pathname === '/') { res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }); res.end(page(address.searchParams.get('host'))); return }
  const file = files[address.pathname]
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, { ...headers, 'Content-Type': file[1] }); res.end(file[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const only = process.env.STRESS_ONLY?.split(',')
const results = []
try {
  for (const worker of ['thread', 'blocked']) for (const host of ['light', 'heavy']) {
    if (only && !only.includes(`${worker}:${host}`)) continue
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 })
    const tab = await context.newPage()
    const logs = []
    tab.on('console', message => { if (/fake worker|worker|PDF page/i.test(message.text())) logs.push(message.text().slice(0, 200)) })
    tab.on('pageerror', error => logs.push('pageerror: ' + String(error).slice(0, 200)))
    await tab.addInitScript(() => {
      const data = window.stress = { longTasks: [], frames: [], ready: {}, text: {}, start: performance.now() }
      try { new PerformanceObserver(list => { for (const t of list.getEntries()) data.longTasks.push([Math.round(t.startTime), Math.round(t.duration)]) }).observe({ type: 'longtask', buffered: true }); data.longTaskSupported = true } catch { data.longTaskSupported = false }
      let last = performance.now()
      const tick = now => { data.frames.push(now - last); last = now; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      new MutationObserver(records => {
        for (const record of records) {
          const node = record.target
          if (node.matches?.('[data-pdf-page]') && node.dataset.renderStatus === 'ready' && !(node.dataset.pdfPage in data.ready)) data.ready[node.dataset.pdfPage] = Math.round(performance.now())
          if (node.matches?.('[data-pdf-page]') && node.dataset.textStatus === 'ready' && !(node.dataset.pdfPage in data.text)) data.text[node.dataset.pdfPage] = Math.round(performance.now())
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-render-status', 'data-text-status'] })
    })
    const started = Date.now()
    await tab.goto(`${base}?worker=${worker}&host=${host}`, { waitUntil: 'load' })
    let timedOut = false
    try { await tab.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 90000 }) } catch { timedOut = true }
    // Let the initial preload window (pages near the viewport) settle.
    await tab.waitForTimeout(4000)
    if (process.env.STRESS_SCROLL === '1') {
      await tab.evaluate(async () => {
        const root = document.querySelector('.pr-scroll')
        for (let i = 0; i < 120; i++) { root.scrollTop += 120; await new Promise(r => requestAnimationFrame(r)) }
        for (let i = 0; i < 120; i++) { root.scrollTop -= 120; await new Promise(r => requestAnimationFrame(r)) }
      })
      await tab.waitForTimeout(3000)
    }
    const data = await tab.evaluate(() => {
      const s = window.stress
      const frames = s.frames.slice(1)
      const sorted = frames.slice().sort((a, b) => a - b)
      return {
        longTaskSupported: s.longTaskSupported,
        longTasks: s.longTasks.length,
        longTaskTotalMs: s.longTasks.reduce((sum, t) => sum + t[1], 0),
        longestTaskMs: Math.max(0, ...s.longTasks.map(t => t[1])),
        maxFrameGapMs: Math.round(sorted[sorted.length - 1] || 0),
        p95FrameGapMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
        framesOver100ms: frames.filter(f => f > 100).length,
        page1ReadyMs: s.ready[1],
        page1TextMs: s.text[1],
        readyPages: Object.keys(s.ready).length,
        trace: window.__dshPaperReaderTrace?.() || null,
      }
    })
    results.push({ worker, host, timedOut, wallMs: Date.now() - started, ...data, logs: logs.slice(0, 6) })
    console.log(JSON.stringify(results[results.length - 1], (key, value) => key === 'trace' ? (value ? { workerMode: value.workerMode, pages: value.pages?.slice(0, 4) } : null) : value))
    await context.close()
  }
} finally {
  await browser.close(); server.close()
}
await mkdir('test-results/stress', { recursive: true })
await writeFile(`test-results/stress/${process.env.STRESS_LABEL || 'current'}.json`, JSON.stringify(results, null, 2))
