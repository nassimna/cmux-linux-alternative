import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pnpmStore = join(root, '..', 'node_modules', '.pnpm')
if (!existsSync(pnpmStore)) process.exit(0)

for (const entry of readdirSync(pnpmStore)) {
  if (!entry.startsWith('node-pty@')) continue
  const packageRoot = join(pnpmStore, entry, 'node_modules', 'node-pty')
  const prebuilds = join(packageRoot, 'prebuilds')
  const prebuiltDirectories = existsSync(prebuilds)
    ? readdirSync(prebuilds, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => join('prebuilds', item.name))
    : []
  for (const directory of ['build/Release', ...prebuiltDirectories]) {
    const helper = join(packageRoot, directory, 'spawn-helper')
    if (existsSync(helper)) chmodSync(helper, 0o755)
  }
}
