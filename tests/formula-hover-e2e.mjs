import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
import { useActualSize } from './reader-helpers.mjs'

if (!process.env.PAPER_TEST_PDF) throw new Error('Set PAPER_TEST_PDF to SuperMimic (2610.28480v2.pdf)')
const server = spawn(process.execPath, ['tests/browser-server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] })
let browser
try {
  const url = await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('Test server timed out')), 20000)
    server.stdout.on('data', chunk => {
      output += chunk
      const match = output.match(/PAPER_TEST_URL=(\S+)/)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Test server exited: ${code}`)) })
  })
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', headless: true })
  const page = await browser.newPage({ viewport: { width: 1580, height: 980 } })
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url)
  await page.locator('[data-pdf-page="1"]').waitFor()
  await page.evaluate(() => {
    const sheet = document.querySelector('.pr-page')
    const width = parseFloat(sheet.style.width) / Number(sheet.style.getPropertyValue('--scale-factor'))
    document.querySelector('#app').style.width = `${width * 1.711 + 48}px`
  })
  await page.waitForFunction(() => document.querySelector('.pr-zoom')?.textContent === '171%')
  await page.locator('.pr-page-input input').fill('5')
  await page.locator('.pr-page-input input').press('Enter')
  const sheet = page.locator('[data-pdf-page="5"][data-text-status="ready"]')
  await sheet.waitFor()
  const highlight = sheet.locator('.pr-hover-highlight')

  for (const zoom of ['171%', '100%']) {
    if (zoom === '100%') await useActualSize(page)
    const layout = await sheet.evaluate(element => {
      const spans = [...element.querySelectorAll('.pr-text-layer span')]
      const label = spans.findIndex(node => node.textContent.trim() === '(2)')
      const left = spans.findLastIndex((node, index) => index < label && node.textContent.trim() === 'J')
      const start = spans[left - 1]?.textContent === 'ˆ' ? left - 1 : left
      if (left < 0 || label < 0) throw new Error('Equation (2) not found')
      const scroll = element.closest('.pr-scroll')
      scroll.scrollTop += spans[left].getBoundingClientRect().top - scroll.getBoundingClientRect().top - 260
      const rect = node => {
        const { left, top, right, bottom } = node.getBoundingClientRect()
        return { left, top, right, bottom }
      }
      const formula = spans.slice(start, label).filter(node => node.textContent.trim())
      return {
        formula: formula.map(rect),
        label: rect(spans[label]),
        hover: [spans[left], formula.find(node => node.textContent === 'γ')].map(rect),
        previousText: rect(spans.slice(0, start).findLast(node => node.textContent.trim()))
      }
    })
    for (const hit of layout.hover) {
      await page.mouse.move(8, 8)
      await page.keyboard.press('Escape')
      await highlight.waitFor({ state: 'detached' })
      await page.mouse.move((hit.left + hit.right) / 2, (hit.top + hit.bottom) / 2)
      await highlight.waitFor({ timeout: 4000 })
      const frame = await highlight.boundingBox()
      const covered = layout.formula.filter(part => frame.x <= part.left + 1 && frame.y <= part.top + 1 &&
        frame.x + frame.width >= part.right - 1 && frame.y + frame.height >= part.bottom - 1).length
      assert.equal(covered, layout.formula.length, `${zoom}: equation (2) outline covers all glyphs (${covered}/${layout.formula.length})`)
      assert.ok(frame.x + frame.width < layout.label.left, 'equation number stays outside the outline')
      assert.ok(frame.y >= layout.previousText.bottom - 2, 'preceding prose stays outside the outline')
    }
  }
  assert.deepEqual(errors, [])
  console.log('PASS: SuperMimic page 5 equation (2), hover from either side at 171% and 100%')
} finally {
  await browser?.close()
  server.kill()
}
