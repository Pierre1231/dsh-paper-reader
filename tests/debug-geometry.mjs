import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage()
await page.goto(process.env.PAPER_TEST_URL, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '下一页' }).click()
await page.locator('[data-pdf-page="2"] .pr-text-layer span').first().waitFor()
console.log(await page.evaluate(() => [...document.querySelectorAll('[data-pdf-page="2"] .pr-text-layer span')]
  .filter(element => element.textContent.trim() && !element.querySelector('span') && !element.closest('.markedContent'))
  .map(element => { const rect = element.getBoundingClientRect(); return { text: element.textContent, left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, fontSize: getComputedStyle(element).fontSize } })
  .filter(line => /scaling up compute|SuperMimic addresses|logged simulator|On one GPU|outs provides|structure, instead|amortize learning|body simulators/.test(line.text))))
await browser.close()
