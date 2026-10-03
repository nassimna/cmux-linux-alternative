import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  MAX_OUTPUT_CHUNK_BYTES,
  TerminalService,
  TerminalServiceError,
  type PtyAdapter,
  type PtyProcess
} from './terminal-service'
import { NodePtyAdapter } from './node-pty-adapter'

class FakePty implements PtyProcess {
  public readonly pid = 1234
  public readonly writes: Array<string | Buffer> = []
  public readonly sizes: [number, number][] = []
  public killed = false
  private dataListener: (data: Buffer) => void = () => {}
  private exitListener: (event: { exitCode: number }) => void = () => {}

  public onData(listener: (data: Buffer) => void): { dispose(): void } {
    this.dataListener = listener
    return { dispose: () => (this.dataListener = () => {}) }
  }

  public onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener
    return { dispose: () => (this.exitListener = () => {}) }
  }

  public write(data: string | Buffer): void {
    this.writes.push(data)
  }

  public resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows])
  }

  public kill(): void {
    this.killed = true
  }

  public output(data: string): void {
    this.dataListener(Buffer.from(data))
  }

  public exit(exitCode: number): void {
    this.exitListener({ exitCode })
  }
}

function createFixture(): { service: TerminalService; pty: FakePty } {
  const pty = new FakePty()
  const adapter: PtyAdapter = { spawn: () => Promise.resolve(pty) }
  return { service: new TerminalService(adapter), pty }
}

describe('TerminalService', () => {
  it('keeps ordered output, accepts checkpoints, and marks missing replay data', async () => {
    const { service, pty } = createFixture()
    const { terminal } = await service.create({ rows: 24, cols: 80, cwd: resolve('.') })
    const events: string[] = []
    const unsubscribe = service.subscribe(terminal.id, (event) => events.push(event.event))

    pty.output('first')
    expect(service.attach(terminal.id).output).toEqual([
      { sequence: 1, data: Buffer.from('first').toString('base64'), byteLength: 5 }
    ])
    service.checkpoint(terminal.id, {
      sequence: 1,
      rows: 24,
      cols: 80,
      activeBuffer: 'normal',
      data: 'screen'
    })
    pty.output('next')
    const attached = service.attach(terminal.id)
    expect(attached.checkpoint?.sequence).toBe(1)
    expect(attached.output.map((chunk) => chunk.sequence)).toEqual([2])
    expect(attached.reconstructionComplete).toBe(true)
    expect(events).toEqual(['terminal.output', 'terminal.output'])

    pty.output('x'.repeat(MAX_OUTPUT_CHUNK_BYTES * 5))
    expect(service.attach(terminal.id).reconstructionComplete).toBe(false)
    expect(
      service.attach(terminal.id).output.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    ).toBeLessThanOrEqual(256 * 1024)
    unsubscribe()
    service.close(terminal.id)
    expect(pty.killed).toBe(true)
  })

  it('routes input and resize to the PTY and retains an exited snapshot', async () => {
    const { service, pty } = createFixture()
    const { terminal } = await service.create({ rows: 24, cols: 80, command: ['/bin/sh'] })
    service.send(terminal.id, Buffer.from('printf hello\n'))
    service.resize(terminal.id, 40, 120)
    pty.exit(7)

    expect(pty.writes).toEqual([Buffer.from('printf hello\n')])
    expect(pty.sizes).toEqual([[120, 40]])
    expect(service.attach(terminal.id).terminal).toMatchObject({
      rows: 40,
      cols: 120,
      exited: true,
      exitCode: 7
    })
    expect(() => service.send(terminal.id, Buffer.from('later'))).toThrow(TerminalServiceError)
  })

  it('rejects a future checkpoint without losing output', async () => {
    const { service, pty } = createFixture()
    const { terminal } = await service.create({ rows: 24, cols: 80 })
    pty.output('ready')
    expect(() =>
      service.checkpoint(terminal.id, {
        sequence: 2,
        rows: 24,
        cols: 80,
        activeBuffer: 'normal',
        data: 'bad'
      })
    ).toThrow('ahead')
    expect(service.attach(terminal.id).lastSequence).toBe(1)
    service.dispose()
  })

  it('kills a PTY that finishes spawning after shutdown starts', async () => {
    const pty = new FakePty()
    let startSpawn!: () => void
    let finishSpawn!: (process: PtyProcess) => void
    const started = new Promise<void>((resolve) => {
      startSpawn = resolve
    })
    const adapter: PtyAdapter = {
      spawn: () => {
        startSpawn()
        return new Promise<PtyProcess>((resolve) => {
          finishSpawn = resolve
        })
      }
    }
    const service = new TerminalService(adapter)
    const creation = service.create({ rows: 24, cols: 80 })
    await started
    service.dispose()
    finishSpawn(pty)
    await expect(creation).rejects.toMatchObject({ code: 'service_stopping' })
    expect(pty.killed).toBe(true)
  })

  it('requires an observed PTY exit and retains unverified processes for retry', async () => {
    const { service, pty } = createFixture()
    const { terminal } = await service.create({ rows: 24, cols: 80 })
    await expect(service.terminateObserved(terminal.id, 10)).rejects.toMatchObject({
      code: 'termination_unverified'
    })
    expect(pty.killed).toBe(true)
    expect(() => service.attach(terminal.id)).toThrow('being terminated')
    expect(() => service.send(terminal.id, Buffer.from('later'))).toThrow('being terminated')
    pty.kill = () => {
      pty.exit(0)
    }
    expect(await service.terminateObserved(terminal.id, 100)).toMatchObject({ exitCode: 0 })
    expect(() => service.attach(terminal.id)).toThrow('does not exist')
  })

  it.skipIf(process.platform !== 'linux')('observes a disposable real PTY exit', async () => {
    const service = new TerminalService(new NodePtyAdapter())
    try {
      const { terminal } = await service.create({
        rows: 24,
        cols: 80,
        command: ['/bin/sleep', '30']
      })
      expect((await service.terminateObserved(terminal.id, 5_000)).exitCode).toEqual(
        expect.any(Number)
      )
      expect(() => service.attach(terminal.id)).toThrow('does not exist')
    } finally {
      service.dispose()
    }
  })
})
