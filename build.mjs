import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
await mkdir('lib', { recursive: true })
const workerPlugin = {
  name: 'inline-pdf-worker',
  setup(builder) {
    builder.onResolve({ filter: /^pdf-worker-source$/ }, () => ({ path: require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), namespace: 'paper-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'paper-worker' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }))
    builder.onResolve({ filter: /^pdf-bundled-assets$/ }, () => ({ path: 'pdf-bundled-assets', namespace: 'paper-assets' }))
    builder.onLoad({ filter: /.*/, namespace: 'paper-assets' }, async () => {
      const root = path.dirname(require.resolve('pdfjs-dist/package.json'))
      const assets = {}
      for (const [kind, suffixes] of [['cmaps', ['.bcmap']], ['standard_fonts', ['.pfb', '.ttf']]]) {
        const dir = path.join(root, kind)
        assets[kind] = Object.fromEntries(await Promise.all((await readdir(dir)).filter(name => suffixes.some(suffix => name.endsWith(suffix))).map(async name => [name, (await readFile(path.join(dir, name))).toString('base64')])))
      }
      return { contents: `export default ${JSON.stringify(assets)}`, loader: 'js' }
    })
  }
}
const output = await build({
  entryPoints: ['src/client.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: ['chrome120'], jsx: 'transform',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client'],
  loader: { '.css': 'text' }, plugins: [workerPlugin], logLevel: 'info'
})
const js = output.outputFiles.find(file => file.path.endsWith('.js') || file.path === '<stdout>')
if (!js) throw new Error('esbuild produced no client JavaScript')
await writeFile('lib/client.js', `window.__ModuleLoader__.load({ id: 'dsh-paper-reader', factory: (require) => { var module = { exports: {} }; var exports = module.exports;\n${js.text}\nreturn module.exports; } });\n`)
await writeFile('lib/index.js', await readFile('src/index.js'))
