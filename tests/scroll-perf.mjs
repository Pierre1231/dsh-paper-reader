import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'
const url = process.env.PAPER_TEST_URL
if (!url) throw new Error('Set PAPER_TEST_URL')
const label = process.env.PERF_LABEL || 'current'
const baseline = process.env.PERF_BASELINE === '1'
const output = 'test-results/performance'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(String(error)))
  await page.addInitScript(() => {
    const data = window.pdfPerf = { pageRects: 0, spanRects: 0, pixelReads: 0, pixelReadMs: 0, pngEncodes: 0, commits: [], longTasks: [], frames: [] }
    const rect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function (...args) {
      if (this.matches?.('[data-pdf-page]')) data.pageRects++
      else if (this.matches?.('.pr-text-layer span')) data.spanRects++
      return rect.apply(this, args)
    }
    const read = CanvasRenderingContext2D.prototype.getImageData
    CanvasRenderingContext2D.prototype.getImageData = function (...args) {
      const start = performance.now(); data.pixelReads++
      try { return read.apply(this, args) } finally { data.pixelReadMs += performance.now() - start }
    }
    const encode = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (...args) { data.pngEncodes++; return encode.apply(this, args) }
    new MutationObserver(records => {
      for (const record of records) {
        const page = record.target
        if (page.matches?.('[data-pdf-page]') && page.dataset.renderStatus === 'ready') data.commits.push({ page: Number(page.dataset.pdfPage), time: performance.now() })
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-render-status'] })
    new PerformanceObserver(list => { for (const task of list.getEntries()) data.longTasks.push({ start: task.startTime, duration: task.duration }) }).observe({ type: 'longtask', buffered: true })
  })
  await page.goto(url + (baseline ? '?baseline=1' : ''), { waitUntil: 'networkidle' })
  await page.addStyleTag({ content: '#draft{display:none}#app{float:none;width:640px;height:100%}' })
  await page.locator('[data-pdf-page="1"][data-render-status="ready"]').waitFor({ timeout: 20000 })
  // Reproduce the common "clicked/read a passage, then kept scrolling" case.
  const title = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'SuperMimic:' }).first()
  await title.evaluate(node => {
    const range = document.createRange(); range.setStart(node.firstChild, 3); range.collapse(true)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 2000 })
  await cdp.send('Profiler.start')
  const cycles = []
  for (const direction of ['down', 'up']) {
    cycles.push(await page.evaluate(async direction => {
      const root = document.querySelector('.pr-scroll'), data = window.pdfPerf
      const start = performance.now(), initialTop = root.scrollTop, endTop = direction === 'down' ? root.scrollHeight - root.clientHeight : 0
      const before = { pageRects: data.pageRects, spanRects: data.spanRects, pixelReads: data.pixelReads, pngEncodes: data.pngEncodes, commits: data.commits.length }
      let last, lastProbe = 0, blank = 0, probes = 0
      const gaps = []
      await new Promise(resolve => {
        const step = time => {
          if (last !== undefined) gaps.push(time - last)
          last = time
          root.scrollTop = initialTop + (endTop - initialTop) * Math.min(1, (time - start) / 6000)
          if (time - lastProbe > 100) {
            const node = document.elementFromPoint(350, 420)?.closest('[data-pdf-page]')
            if (node) { probes++; if (!node.querySelector('canvas')?.width) blank++ }
            lastProbe = time
          }
          if (time - start < 6000) requestAnimationFrame(step)
          else resolve()
        }
        requestAnimationFrame(step)
      })
      const finish = performance.now()
      await new Promise(resolve => setTimeout(resolve, 5800))
      const layers = [...document.querySelectorAll('[data-pdf-page]')]
      const canvases = layers.map(node => node.querySelector('canvas')).filter(canvas => canvas.width > 0)
      const sorted = gaps.toSorted((a,b) => a-b), percentile = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0
      const tasks = data.longTasks.filter(task => task.start >= start && task.start < finish)
      return { direction, duration: finish - start, frames: gaps.length, over34ms: gaps.filter(gap => gap > 34).length,
        p95ms: percentile(.95), p99ms: percentile(.99), maxFrameMs: Math.max(...gaps),
        longTasks: tasks.length, longTaskMs: tasks.reduce((sum,task) => sum + task.duration,0),
        pageRectReads: data.pageRects - before.pageRects, spanRectReads: data.spanRects - before.spanRects,
        pixelReads: data.pixelReads - before.pixelReads, pngEncodes: data.pngEncodes - before.pngEncodes,
        renderCommits: data.commits.length - before.commits, visibleBlankSamples: blank, visibleSamples: probes,
        retainedCanvasPages: canvases.length, retainedTextPages: layers.filter(node => node.querySelector('.pr-text-layer span')).length,
        retainedCanvasMiB: canvases.reduce((sum,canvas) => sum + canvas.width * canvas.height * 4, 0) / 1024 / 1024,
        collapsedSelection: getSelection()?.isCollapsed }
    }, direction))
  }
  const { profile } = await cdp.send('Profiler.stop')
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const totals = new Map()
  for (let i=0; i < (profile.samples?.length || 0); i++) {
    const frame = byId.get(profile.samples[i])?.callFrame
    if (!frame) continue
    const key = `${frame.functionName || '(anonymous)'}:${frame.lineNumber}`
    totals.set(key, { name: frame.functionName || '(anonymous)', line: frame.lineNumber + 1, ms: (totals.get(key)?.ms || 0) + (profile.timeDeltas?.[i] || 0) / 1000 })
  }
  const hot = [...totals.values()].sort((a,b) => b.ms-a.ms).slice(0,20)
  const result = { label, viewport: { width: 1280, height: 900, sidebar: 640, dpr: 2 }, cycles, hot, errors,
    limits: 'Isolated headless Chrome diagnostic; canvas MiB is raw RGBA size, not measured GPU allocation. CPU sampling is enabled equally for comparisons.' }
  assert.deepEqual(errors, [])
  if (process.env.PERF_ASSERT_BOUNDED === '1') assert.ok(cycles.every(cycle => cycle.retainedCanvasPages <= 6), 'offscreen pages must be released despite a collapsed PDF selection')
  await writeFile(`${output}/${label}.json`, JSON.stringify(result, null, 2))
  await writeFile(`${output}/${label}.cpuprofile`, JSON.stringify(profile))
  console.log(JSON.stringify(result))
} finally { await browser.close() }
