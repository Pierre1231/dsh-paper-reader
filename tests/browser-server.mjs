// Isolated test page; it does not serve or replace the running DSH GUI.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
const pdfPath = process.env.PAPER_TEST_PDF
if (!pdfPath) throw new Error('Set PAPER_TEST_PDF to the path of a local PDF to run this isolated test server')
const harness = await build({ entryPoints:['tests/browser-harness.jsx'], bundle:true, write:false, platform:'browser', jsx:'automatic', format:'iife' })
const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0}#app{width:70%;height:90%;float:right}#draft{white-space:pre-wrap;width:28%;float:left}#open-result{display:none}</style></head><body><pre id="draft"></pre><span id="open-result"></span><div id="app"></div><script src="/harness.js"></script><script src="/client.js"></script><script>startHarness().catch(e=>document.body.append(String(e)))</script></body></html>'
const files = { '/': [html, 'text/html; charset=utf-8'], '/harness.js': [harness.outputFiles[0].contents, 'text/javascript'], '/client.js': [await readFile('lib/client.js'), 'text/javascript'], '/paper.pdf': [await readFile(pdfPath), 'application/pdf'] }
if (process.env.PAPER_TEST_BASELINE) files['/client-baseline.js'] = [await readFile(process.env.PAPER_TEST_BASELINE), 'text/javascript']
const server = http.createServer((req,res) => {
  const address = new URL(req.url, 'http://localhost')
  let file = files[address.pathname]
  if (address.pathname === '/' && address.searchParams.has('baseline') && files['/client-baseline.js']) file = [html.replace('src="/client.js"', 'src="/client-baseline.js"'), 'text/html; charset=utf-8']
  if (!file) { res.writeHead(404).end(); return }
  res.writeHead(200, {'Content-Type':file[1], 'Cache-Control':'no-store'}); res.end(file[0])
})
server.listen(0, '127.0.0.1', () => console.log(`PAPER_TEST_URL=http://127.0.0.1:${server.address().port}/`))
