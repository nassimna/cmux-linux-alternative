import { spawn } from 'node:child_process'

import { expect, it } from 'vitest'

import { linuxListeningPorts } from './linux-listening-ports'

it.skipIf(process.platform !== 'linux')(
  'finds IPv4 and IPv6 TCP listeners owned by terminal descendants',
  async () => {
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process')
         const child = spawn(process.execPath, ['-e',
           'const net = require("node:net"); net.createServer().listen(0, "127.0.0.1", function () { console.log(this.address().port) }); net.createServer().listen(0, "::1", function () { console.log(this.address().port) })'
         ], { stdio: ['ignore', 'pipe', 'inherit'] })
         child.stdout.pipe(process.stdout)
         process.on('SIGTERM', () => {
           child.kill('SIGTERM')
           child.once('exit', () => process.exit(0))
         })`
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    try {
      const ports = await new Promise<number[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Listener did not start')), 5_000)
        let output = ''
        parent.stdout.on('data', (data: Buffer) => {
          output += data.toString()
          const matches = [...output.matchAll(/^(\d+)\n/gm)]
          if (matches.length === 2) {
            clearTimeout(timeout)
            resolve(matches.map((match) => Number(match[1])).sort((a, b) => a - b))
          }
        })
        parent.once('exit', (code) => {
          clearTimeout(timeout)
          reject(new Error(`Listener exited before ready: ${code}`))
        })
      })
      expect(await linuxListeningPorts(parent.pid!)).toEqual(ports)
    } finally {
      if (parent.exitCode === null) {
        await new Promise<void>((resolve) => {
          parent.once('exit', () => resolve())
          parent.kill('SIGTERM')
        })
      }
    }
  },
  10_000
)
