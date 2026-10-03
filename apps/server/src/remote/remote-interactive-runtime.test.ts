import { describe, expect, it } from 'vitest'

import { NodePtyAdapter } from '../terminal/node-pty-adapter'
import { TerminalService, type PtyAdapter, type PtyProcess } from '../terminal/terminal-service'
import { RemoteInteractiveRuntime } from './remote-interactive-runtime'
import type { SshLaunchPlan } from './ssh-launch-plan'

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

function plan(onClose: () => void): SshLaunchPlan {
  return {
    executable: '/usr/bin/ssh',
    argv: ['-V'],
    revalidate: async () => {},
    environment: () => Promise.resolve({ SSH_AUTH_SOCK: '/attempt/agent.sock' }),
    close: () => { onClose(); return Promise.resolve() }
  } as unknown as SshLaunchPlan
}

class FakePty implements PtyProcess {
  public readonly pid = 4321
  public killed = false
  private exitListener: (event: { exitCode: number }) => void = () => {}

  public onData(): { dispose(): void } { return { dispose() {} } }
  public onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListener = listener
    return { dispose: () => { this.exitListener = () => {} } }
  }
  public write(): void {}
  public resize(): void {}
  public kill(): void { this.killed = true }
  public exit(code: number): void { this.exitListener({ exitCode: code }) }
}

describe('remote interactive runtime', () => {
  it('uses an isolated PTY environment, revokes the lease, and fences stale attempts', async () => {
    const pty = new FakePty()
    const spawns: unknown[] = []
    const adapter: PtyAdapter = {
      spawn: (...args) => { spawns.push(args); return Promise.resolve(pty) }
    }
    const terminals = new TerminalService(adapter)
    const runtime = new RemoteInteractiveRuntime(terminals)
    let closed = 0
    const first = await runtime.launch({
      remoteSessionId: SESSION_ID,
      generation: 1,
      plan: plan(() => { closed += 1 }),
      isCurrent: () => true
    })
    expect(spawns[0]).toEqual([
      '/usr/bin/ssh', ['-V'],
      { cwd: '/', rows: 24, cols: 80, env: { SSH_AUTH_SOCK: '/attempt/agent.sock' } }
    ])
    expect(terminals.attach(first.terminalId).terminal.command).toEqual(['remote-transport'])
    expect(runtime.isLive(SESSION_ID, 1)).toBe(true)
    expect(runtime.ownsTerminal(first.terminalId)).toBe(true)
    await expect(runtime.launch({
      remoteSessionId: SESSION_ID,
      generation: 2,
      plan: plan(() => { closed += 1 }),
      isCurrent: () => false
    })).rejects.toMatchObject({ code: 'stale_attempt' })
    expect(pty.killed).toBe(false)
    expect(runtime.isLive(SESSION_ID, 1)).toBe(true)
    await runtime.terminate(SESSION_ID, 1)
    expect(closed).toBe(2)
    expect(pty.killed).toBe(true)
    expect(runtime.isLive(SESSION_ID, 1)).toBe(false)
    expect(runtime.ownsTerminal(first.terminalId)).toBe(false)
  })

  it('revokes a lease on local SSH exit and reports only the matching generation', async () => {
    const pty = new FakePty()
    const terminals = new TerminalService({ spawn: () => Promise.resolve(pty) })
    const runtime = new RemoteInteractiveRuntime(terminals)
    const calls: string[] = []
    await runtime.launch({
      remoteSessionId: SESSION_ID,
      generation: 3,
      plan: plan(() => { calls.push('revoked') }),
      isCurrent: () => true,
      onExit: ({ generation }) => { calls.push(`exit ${generation}`) }
    })
    pty.exit(255)
    await new Promise((resolve) => setImmediate(resolve))
    expect(calls).toEqual(['revoked', 'exit 3'])
    expect(runtime.isLive(SESSION_ID, 3)).toBe(false)
  })

  it('waits for an exiting transport lease before shutdown completes', async () => {
    const pty = new FakePty()
    const terminals = new TerminalService({ spawn: () => Promise.resolve(pty) })
    const runtime = new RemoteInteractiveRuntime(terminals)
    let release!: () => void
    const revoked = new Promise<void>((resolve) => { release = resolve })
    const pendingPlan = {
      ...plan(() => {}),
      close: () => revoked
    } as unknown as SshLaunchPlan
    await runtime.launch({
      remoteSessionId: SESSION_ID,
      generation: 4,
      plan: pendingPlan,
      isCurrent: () => true
    })
    pty.exit(255)
    let disposed = false
    const shutdown = runtime.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await shutdown
    expect(disposed).toBe(true)
  })

  it('starts stock SSH in a real PTY and captures its bounded exit output', async () => {
    const terminals = new TerminalService(new NodePtyAdapter())
    const { terminal } = await terminals.createRemote(plan(() => {}), 24, 80)
    const exited = await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ssh did not exit')), 5000)
      const check = () => {
        if (!terminals.attach(terminal.id).terminal.exited) return
        clearTimeout(timeout)
        resolve()
      }
      terminals.subscribe(terminal.id, (event) => {
        if (event.event === 'terminal.exited') check()
      })
      check()
    })
    expect(exited).toBeUndefined()
    const output = Buffer.concat(terminals.attach(terminal.id).output.map((part) => Buffer.from(part.data, 'base64'))).toString()
    expect(output).toContain('OpenSSH_')
    expect(terminals.attach(terminal.id).terminal.command).toEqual(['remote-transport'])
    terminals.close(terminal.id)
  })
})
