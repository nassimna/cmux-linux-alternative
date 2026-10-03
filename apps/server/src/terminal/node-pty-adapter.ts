import { createRequire } from 'node:module'

import type * as NodePtyModule from 'node-pty'
import type { PtyAdapter, PtyProcess } from './terminal-service'

const requireNative = createRequire(import.meta.url)

export class NodePtyAdapter implements PtyAdapter {
  public spawn(
    command: string,
    args: string[],
    options: { cwd: string; rows: number; cols: number; env: NodeJS.ProcessEnv }
  ): Promise<PtyProcess> {
    // node-pty is a native addon. Load it only when the first terminal starts so
    // HTTP health and recovery can still run if the addon is unavailable.
    const pty = requireNative('node-pty') as typeof NodePtyModule
    if (typeof pty.spawn !== 'function') {
      throw new Error('The native PTY module has no spawn entrypoint')
    }
    const terminal = pty.spawn(command, args, {
      cwd: options.cwd,
      rows: options.rows,
      cols: options.cols,
      env: options.env,
      name: 'xterm-256color',
      encoding: null
    })
    return Promise.resolve({
      pid: terminal.pid,
      onData: (listener) =>
        terminal.onData((data) => listener(Buffer.isBuffer(data) ? data : Buffer.from(data))),
      onExit: (listener) => terminal.onExit(listener),
      write: (data) => terminal.write(data),
      resize: (cols, rows) => terminal.resize(cols, rows),
      kill: () => terminal.kill()
    })
  }
}
