import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('Files save requires Linux')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nodeHeaders = [
  resolve(dirname(process.execPath), '../include/node'),
  '/usr/include/node'
].find((candidate) => existsSync(resolve(candidate, 'node_api.h')))
if (!nodeHeaders) throw new Error('Node API headers are required to build content.save')
mkdirSync(resolve(root, 'dist'), { recursive: true })
execFileSync('cc', [
  '-std=c11', '-O2', '-fPIC', '-shared', '-Wall', '-Wextra', '-Werror',
  `-I${nodeHeaders}`,
  resolve(root, 'src/content/rename-exchange.c'),
  '-o', resolve(root, 'dist/rename-exchange.node')
], { stdio: 'inherit' })
