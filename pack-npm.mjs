import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const npmName = 'dsh-paper-reader-pierre'
const packCli = process.env.npm_execpath
if (!packCli) throw new Error('Run this script with npm run pack:npm or pnpm run pack:npm')

const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const plugin = JSON.parse(await readFile('dsh.plugin.json', 'utf8'))
if (plugin.name !== manifest.name || plugin.entry.name !== manifest.name || plugin.version !== manifest.version) {
  throw new Error('Package and plugin manifests must agree before packing')
}
const client = await readFile('lib/client.js', 'utf8')
const clientPrefix = `window.__ModuleLoader__.load({ id: '${manifest.name}',`
if (!client.startsWith(clientPrefix)) throw new Error('Build the client before packing')
const patchFile = manifest.dsh.bundle.patch
const patch = await readFile(patchFile, 'utf8')
const entry = `      name: ${manifest.name}\n`
if (!patch.includes(entry)) throw new Error('Bundle patch does not match the package manifest')

const destination = resolve('dist')
await mkdir(destination, { recursive: true })
const staging = await mkdtemp(join(tmpdir(), 'dsh-paper-reader-npm-'))
try {
  for (const file of [...manifest.files, 'README.md', 'CHANGELOG.md', 'LICENSE']) {
    await cp(file, join(staging, file), { recursive: true })
  }
  await writeFile(join(staging, 'package.json'), JSON.stringify({
    ...manifest,
    name: npmName,
    private: undefined,
    files: [...manifest.files, 'CHANGELOG.md'],
    scripts: undefined,
    devDependencies: undefined,
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org' },
  }, null, 2) + '\n')
  await writeFile(join(staging, 'dsh.plugin.json'), JSON.stringify({
    ...plugin, name: npmName, entry: { ...plugin.entry, name: npmName },
  }, null, 2) + '\n')
  await writeFile(join(staging, patchFile), patch.replace(entry, `      name: ${npmName}\n`))
  await writeFile(join(staging, 'lib/client.js'), `window.__ModuleLoader__.load({ id: '${npmName}',${client.slice(clientPrefix.length)}`)
  execFileSync(process.execPath, [packCli, 'pack', '--pack-destination', destination], { cwd: staging, stdio: 'inherit' })
} finally {
  await rm(staging, { recursive: true, force: true })
}
