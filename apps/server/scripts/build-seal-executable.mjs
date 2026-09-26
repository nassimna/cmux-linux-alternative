import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('Sealed executable launch requires Linux')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeHeaders = [
  resolve(dirname(process.execPath), '../include/node'),
  '/usr/include/node'
].find((candidate) => existsSync(resolve(candidate, 'node_api.h')))
if (!nodeHeaders) throw new Error('Node API headers are required to build sealed executable support')
mkdirSync(resolve(root, 'dist'), { recursive: true })
execFileSync('cc', [
  '-std=c11', '-O2', '-fPIC', '-shared', '-Wall', '-Wextra', '-Werror',
  `-I${nodeHeaders}`,
  resolve(root, 'src/agents/seal-executable.c'),
  '-o', resolve(root, 'dist/seal-executable.node')
], {
  stdio: 'inherit',
  // An AppImage parent can make GCC infer its mount as the compiler prefix.
  env: { ...process.env, GCC_EXEC_PREFIX: process.env.GCC_EXEC_PREFIX ?? '/usr/lib/gcc/' }
})
