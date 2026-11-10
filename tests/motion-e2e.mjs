import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const directory = await mkdtemp(path.join(tmpdir(), 'paper-motion-'))
const pdfPath = path.join(directory, 'motion.pdf')
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ...[1, 2].map(number => {
    const stream = `BT /F1 16 Tf 70 700 Td (Reading motion page ${number}) Tj 0 -40 Td (A paragraph for selection and search.) Tj 0 -40 Td (Another paragraph for hover feedback.) Tj ET`
    return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
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
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.goto(url)
  const text = page.locator('[data-pdf-page="1"] .pr-text-layer span').filter({ hasText: 'Reading motion page 1' }).first()
  await text.waitFor()
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
  assert.deepEqual(errors, [])
  console.log('PASS: menu exit, interruption, reduced motion; real PDF reader')
} finally {
  await browser?.close()
  server.kill()
  await rm(directory, { recursive: true, force: true })
}
