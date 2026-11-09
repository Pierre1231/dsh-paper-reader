// Host-behaviour regressions for the main-thread freeze investigation.
// Isolated Chrome page; it is evidence about specific failure modes, not a
// substitute for acceptance inside the real DSH GUI.
//
//   PAPER_TEST_PDF=/path/paper.pdf node tests/host-scenarios.mjs [client.js ...]
//
// Scenarios (CPU throttled, default 6x, to approximate a slower laptop):
//   main-thread-worker  the host page already evaluated a pdf.js worker on the
//                       main thread (globalThis.pdfjsWorker is set)
//   rerender-copy       the host re-renders the preview 8x with a *new*
//                       Uint8Array holding the same bytes
//   scroll-back         read to the end, wait 6.5 s, jump back to page 1
// Env: CHROME_PATH, SCENARIO_CPU (throttling rate), SCENARIO_ONLY=name,name
import http from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const pdfPath = process.env.PAPER_TEST_PDF
if (!pdfPath) throw new Error('Set PAPER_TEST_PDF')
const clients = process.argv.slice(2).length ? process.argv.slice(2) : ['lib/client.js']
const cpu = Number(process.env.SCENARIO_CPU || 6)
const only = process.env.SCENARIO_ONLY?.split(',')
const harness = await build({ entryPoints: ['tests/browser-harness.jsx'], bundle: true, write: false, platform: 'browser', jsx: 'automatic', format: 'iife' })
const hostWorker = await readFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'))
const page = (hostFirst) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}#app{width:640px;height:100%;float:right}#draft,#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script>${hostFirst
  // Host-owned pdf.js worker evaluated on the main thread *before* the reader opens.
  ? '<script type="module">await import("/host-pdf-worker.mjs"); window.hostWorkerLoaded = !!globalThis.pdfjsWorker; startHarness().catch(e=>document.body.append(String(e)))</script>'
  : '<script>startHarness().catch(e=>document.body.append(String(e)))</script>'}</body></html>`
const files = { '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/paper.pdf': [await readFile(pdfPath), 'application/pdf'], '/host-pdf-worker.mjs': [hostWorker, 'text/javascript'] }
let clientBytes
const server = http.createServer((req, res) => {
  const address = new URL(req.url, 'http://localhost')
  if (address.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page(address.searchParams.get('scenario') === 'main-thread-worker')); return
  }
  const file = address.pathname === '/client.js' ? [clientBytes, 'text/javascript'] : files[address.pathname]
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' }); res.end(file[0])
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

const monitor = () => {
  const data = window.scenario = { longTasks: [], frames: [], opening: 0, fakeWorker: false }
  new PerformanceObserver(list => { for (const t of list.getEntries()) data.longTasks.push([Math.round(t.startTime), Math.round(t.duration)]) }).observe({ type: 'longtask', buffered: true })
  let last = performance.now()
  const tick = now => { data.frames.push([Math.round(now), now - last]); last = now; requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  const warn = console.warn, log = console.log
  console.warn = (...args) => { if (String(args[0]).includes('fake worker')) data.fakeWorker = true; return warn.apply(console, args) }
  console.log = (...args) => { if (String(args[0]).includes('fake worker')) data.fakeWorker = true; return log.apply(console, args) }
  new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType === 1 && (node.matches?.('.pr-message[role="status"]') || node.querySelector?.('.pr-message[role="status"]'))) data.opening++
    }
  }).observe(document, { subtree: true, childList: true })
  data.window = (from, to) => {
    const tasks = data.longTasks.filter(([start]) => start >= from && start <= to)
    const frames = data.frames.filter(([at]) => at >= from && at <= to).map(([, gap]) => gap)
    return { longTasks: tasks.length, longTaskMs: tasks.reduce((sum, [, ms]) => sum + ms, 0), longestTaskMs: Math.max(0, ...tasks.map(([, ms]) => ms)), maxFrameGapMs: Math.round(Math.max(0, ...frames)) }
  }
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const results = []
try {
  for (const client of clients) {
    clientBytes = await readFile(client)
    for (const scenario of ['main-thread-worker', 'rerender-copy', 'scroll-back']) {
      if (only && !only.includes(scenario)) continue
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 })
      const tab = await context.newPage()
      const errors = []
      tab.on('pageerror', error => errors.push(String(error).slice(0, 200)))
      await tab.addInitScript(monitor)
      const cdp = await context.newCDPSession(tab)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu })
      await tab.goto(`${base}?scenario=${scenario}`, { waitUntil: 'load' })
      const t0 = await tab.evaluate(() => performance.now())
      await tab.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 120000 })
      const result = { client, scenario, cpu }
      if (scenario === 'main-thread-worker') {
        await tab.locator('[data-pdf-page="2"][data-render-status="ready"]').waitFor({ timeout: 120000 }).catch(() => {})
        await tab.waitForTimeout(1500)
        Object.assign(result, await tab.evaluate(t0 => ({
          hostWorkerLoaded: window.hostWorkerLoaded === true,
          parsedOnMainThread: window.scenario.fakeWorker,
          workerMode: window.__dshPaperReaderTrace?.().worker?.mode ?? 'unknown (v0.5.1 has no trace)',
          page1ReadyMs: Math.round(performance.now() - t0),
          ...window.scenario.window(0, performance.now()),
        }), t0))
      }
      if (scenario === 'rerender-copy') {
        await tab.waitForTimeout(1000)
        const from = await tab.evaluate(() => performance.now())
        const openingBefore = await tab.evaluate(() => window.scenario.opening)
        for (let index = 0; index < 8; index++) {
          await tab.evaluate(() => window.testHarness.renderDocument({ copy: true }))
          await tab.waitForTimeout(250)
        }
        await tab.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 120000 })
        await tab.waitForTimeout(500)
        Object.assign(result, await tab.evaluate(([from, before]) => ({
          readerRestarts: window.scenario.opening - before,
          ...window.scenario.window(from, performance.now()),
        }), [from, openingBefore]))
      }
      if (scenario === 'scroll-back') {
        await tab.evaluate(async () => {
          const root = document.querySelector('.pr-scroll')
          while (root.scrollTop + root.clientHeight < root.scrollHeight - 2) { root.scrollTop += 300; await new Promise(r => setTimeout(r, 120)) }
        })
        await tab.waitForTimeout(6500)
        Object.assign(result, await tab.evaluate(async () => {
          const root = document.querySelector('.pr-scroll')
          root.scrollTop = 0
          await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
          const page = document.querySelector('[data-pdf-page="1"]')
          const canvas = page.querySelector('canvas')
          const firstFrame = { canvasPixels: canvas.width * canvas.height, loadingLabel: !!page.querySelector('.pr-page-status') }
          const start = performance.now()
          while (page.dataset.renderStatus !== 'ready' && performance.now() - start < 60000) await new Promise(r => setTimeout(r, 20))
          return { afterJumpBack: firstFrame, sharpAgainMs: Math.round(performance.now() - start) }
        }))
      }
      result.errors = errors
      results.push(result)
      console.log(JSON.stringify(result))
      await context.close()
    }
  }
} finally {
  await browser.close(); server.close()
}
await mkdir('test-results/scenarios', { recursive: true })
await writeFile('test-results/scenarios/latest.json', JSON.stringify(results, null, 2))
