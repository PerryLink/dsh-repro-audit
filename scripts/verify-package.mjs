// Post-build package gate.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const fail = message => {
  console.error(`verify-package: ${message}`)
  process.exit(1)
}
for (const file of ['lib/index.js', 'lib/index.d.ts', 'cordis.patch.yml', 'README.md', 'README-zh.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!existsSync(path.join(root, file))) fail(`missing ${file} (run pnpm run build)`)
}
for (const entry of ['lib', 'cordis.patch.yml']) {
  if (!(pkg.files ?? []).includes(entry)) fail(`package.json#files does not publish ${entry}`)
}
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json#dsh.bundle.patch must point at cordis.patch.yml')
if (Object.keys(pkg.dependencies ?? {}).length !== 0) fail('runtime dependencies must stay empty')
const peers = pkg.peerDependencies ?? {}
if (peers['@perrylink/dsh-research-core'] === undefined) fail('the REP core package must be declared as a peer')
if (peers['@deepseek-ai/dsh-tools'] === undefined) fail('the tool registry must be declared as a peer')
const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
for (const key of ['enabled', 'root', 'maxFiles', 'maxDepth', 'maxFileBytes']) {
  if (!patch.includes(key)) fail(`cordis.patch.yml is missing config key ${key}`)
}
console.log('verify-package: ok (entries present, zero runtime dependencies, patch/config aligned)')
