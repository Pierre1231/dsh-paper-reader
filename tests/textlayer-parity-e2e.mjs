// Geometry parity: the sliced text layer (src/textLayer.ts) against pdf.js
// 4.10.38's own TextLayer, span by span, in Chrome.
//
//   PAPER_TEST_PDFS=/a.pdf,/b.pdf node tests/textlayer-parity-e2e.mjs
// Env: CHROME_PATH, PARITY_PAGES (default 1,2,3,7), PARITY_SCALE (default 1.25)
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const require = createRequire(import.meta.url)
const pdfs = (process.env.PAPER_TEST_PDFS || process.env.PAPER_TEST_PDF || '').split(',').filter(Boolean)
if (!pdfs.length) throw new Error('Set PAPER_TEST_PDFS (comma separated) or PAPER_TEST_PDF')
const pages = (process.env.PARITY_PAGES || '1,2,3,7').split(',').map(Number)
const scale = Number(process.env.PARITY_SCALE || 1.25)
const css = await readFile('src/pdf-reader.css', 'utf8')
const entry = `
  import * as pdfjs from 'pdfjs-dist'
  import { createTextLayerJob } from './src/textLayer.ts'
  import { createTaskScheduler } from './src/taskScheduler.ts'
  window.runParity = async (pages, scale) => {
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.mjs'
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await (await fetch('/paper.pdf')).arrayBuffer()) }).promise
    const out = []
    const scheduler = createTaskScheduler()
    for (const number of pages) {
      if (number > doc.numPages) continue
      const page = await doc.getPage(number)
      const viewport = page.getViewport({ scale })
      const content = await page.getTextContent()
      const box = (id) => { const host = document.getElementById(id); host.style.width = viewport.width + 'px'; host.style.height = viewport.height + 'px'; host.style.setProperty('--scale-factor', String(scale)); host.style.setProperty('--total-scale-factor', String(scale)); const layer = host.querySelector('.pr-text-layer'); layer.replaceChildren(); return layer }
      const reference = box('reference')
      await new pdfjs.TextLayer({ textContentSource: content, container: reference, viewport }).render()
      const ours = box('ours')
      const job = createTextLayerJob({ content, viewport: page.getViewport({ scale: 1 }), container: ours, deviceScale: devicePixelRatio * scale, priority: () => 0 })
      await scheduler.run(job)
      // Ground truth from the PDF: every stretched span must render exactly
      // the run's width, and its text baseline must sit on the PDF baseline.
      const items = content.items.filter(item => item.str !== undefined && item.str !== '')
      const measure = layer => {
        const spans = [...layer.querySelectorAll('span')].filter(span => !span.classList.contains('markedContent'))
        const origin = layer.getBoundingClientRect()
        let widthErr = 0, widthErrText = '', baselineErr = 0, baselineErrText = '', checked = 0
        spans.forEach((span, index) => {
          const item = items[index]
          if (!item || item.str !== span.textContent) return
          const tx = pdfjs.Util.transform(viewport.transform, item.transform)
          if (Math.abs(tx[1]) > 1e-6 || Math.abs(tx[2]) > 1e-6) return // horizontal text only
          const rect = span.getBoundingClientRect()
          if (item.str.length > 1) {
            // Allowed: 1 px or 0.3 % of the run, whichever is larger (font-size rounding).
            const expected = item.width * scale
            const error = Math.abs(rect.width - expected) / Math.max(1, expected * 0.003)
            if (error > widthErr) { widthErr = error; widthErrText = item.str }
          }
          const marker = document.createElement('i')
          marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline'
          span.prepend(marker)
          const baseline = marker.getBoundingClientRect().bottom - origin.top
          marker.remove()
          const error = Math.abs(baseline - tx[5])
          if (error > baselineErr) { baselineErr = error; baselineErrText = item.str }
          checked++
        })
        const round = value => Math.round(value * 100) / 100
        return { spans: spans.length, checked, widthErr: round(widthErr), widthErrText: widthErrText.slice(0, 30), baselineErr: round(baselineErr), baselineErrText: baselineErrText.slice(0, 30), text: layer.textContent }
      }
      const a = measure(reference), b = measure(ours)
      out.push({ page: number, chunks: job.chunks, sameSpans: a.spans === b.spans, sameText: a.text === b.text, checked: b.checked,
        ours: { widthErrUnits: b.widthErr, baselineErr: b.baselineErr, worst: b.widthErrText || b.baselineErrText },
        pdfjs: { widthErrUnits: a.widthErr, baselineErr: a.baselineErr } })
    }
    return out
  }`
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: ['chrome120'] })
const worker = await readFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'))
const html = `<!doctype html><html lang="${process.env.PARITY_HOST_LANG || 'zh-CN'}"><meta charset="utf-8"><style>${css}
  body{margin:0} .pr-page{position:relative;display:inline-block;margin:4px;vertical-align:top}
  .hiddenCanvasElement{display:none}</style>
  <div class="pr-shell" style="display:block;height:auto;overflow:visible"><div id="reference" class="pr-page"><div class="pr-text-layer"></div></div><div id="ours" class="pr-page"><div class="pr-text-layer"></div></div></div>
  <script type="module" src="/parity.js"></script>`

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
let failed = false
try {
  for (const pdf of pdfs) {
    const bytes = await readFile(pdf)
    const server = http.createServer((req, res) => {
      const route = { '/': [html, 'text/html'], '/parity.js': [bundle.outputFiles[0].contents, 'text/javascript'], '/pdf.worker.mjs': [worker, 'text/javascript'], '/paper.pdf': [bytes, 'application/pdf'] }[new URL(req.url, 'http://x').pathname]
      if (!route) { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': route[1] }); res.end(route[0])
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const context = await browser.newContext({ viewport: { width: 2400, height: 1600 }, deviceScaleFactor: 1.5 })
    const tab = await context.newPage()
    await tab.goto(`http://127.0.0.1:${server.address().port}/`)
    await tab.waitForFunction(() => typeof window.runParity === 'function')
    const results = await tab.evaluate(([pages, scale]) => window.runParity(pages, scale), [pages, scale])
    for (const result of results) {
      console.log(path.basename(pdf), JSON.stringify(result))
      // Same spans, same text, and sub-pixel geometry (CSS rounding of % positions).
      // Same spans and text as pdf.js; geometry as close to the PDF as pdf.js gets in an English host
      // (its own rounding reaches ~1.5 units), regardless of the host language.
      if (!result.sameSpans || !result.sameText || result.ours.widthErrUnits > 2 || result.ours.baselineErr > 1.5) failed = true
    }
    await context.close(); server.close()
  }
} finally { await browser.close() }
assert.equal(failed, false, 'text layer geometry diverged from the PDF')
console.log('text layer parity: ok')
