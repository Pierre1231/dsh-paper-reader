import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
const page = await browser.newPage()
page.on('console', async message => { if (message.text().includes('paper-reader')) console.log(message.text(), await Promise.all(message.args().map(arg => arg.jsonValue().catch(() => '<unavailable>')))) })
await page.goto(process.env.PAPER_TEST_URL, { waitUntil: 'networkidle' })
await page.locator('[data-pdf-page="1"] .pr-text-layer span').first().waitFor()
await page.waitForTimeout(1000)
await browser.close()
