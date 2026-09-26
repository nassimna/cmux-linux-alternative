import { mkdtemp, symlink, writeFile, chmod, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ApplicationStateStore } from '../persistence/application-state-store'
import { ServiceLogger } from '../logging/service-logger'
import { TerminalService, type PtyAdapter } from '../terminal/terminal-service'
import {
  ConfigurationQualification,
  ConfigurationQualificationError
} from './configuration-qualification'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function fixture(config: unknown, terminals?: TerminalService, logger?: ServiceLogger) {
  const directory = await mkdtemp(join(tmpdir(), 'node-config-qualification-'))
  directories.push(directory)
  await chmod(directory, 0o700)
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  const fakeState = {
    revision: 3,
    notificationSettings: { systemEnabled: true, includeBody: false },
    shortcutOverrides: {} as Record<string, string | null>,
    readSnapshot() {
      return {
        revision: this.revision,
        notificationSettings: this.notificationSettings,
        shortcutOverrides: this.shortcutOverrides
      }
    },
    exclusive<T>(operation: () => Promise<T>) {
      return operation()
    },
    replaceConfigurationRuntimeSettings(
      expectedRevision: number,
      notifications: typeof this.notificationSettings,
      shortcuts: typeof this.shortcutOverrides
    ) {
      if (expectedRevision !== this.revision) throw new Error('stale revision')
      this.notificationSettings = notifications
      this.shortcutOverrides = shortcuts
      this.revision += 1
      return this.revision
    }
  }
  const state = fakeState as unknown as ApplicationStateStore
  return {
    directory,
    path,
    state,
    fakeState,
    service: await ConfigurationQualification.create(
      join(directory, 'state.db'),
      state,
      true,
      terminals,
      logger
    )
  }
}

describe('configuration qualification', () => {
  it('projects a private schema-1 copy without changing it and reports extension fields', async () => {
    const { service, path } = await fixture({
      schemaVersion: 1,
      revision: 7,
      appearance: { theme: 'dark', futurePreference: 'retained' },
      remoteSessions: { reconnectMaxAttempts: 3 }
    })
    const before = await readFile(path)
    const result = await service.inspect()
    const after = await readFile(path)
    expect(result.config).toMatchObject({
      schemaVersion: 2,
      revision: 7,
      appearance: { theme: 'dark', density: 'comfortable' }
    })
    expect(result.unknownFieldsPresent).toBe(true)
    expect(result.runtimeSettingsMatch).toBe(true)
    expect(result.writable).toBe(false)
    expect(after).toEqual(before)
  })

  it('rejects a symlink and a future schema without writing', async () => {
    const { directory, path, service } = await fixture({ schemaVersion: 3 })
    await expect(service.inspect()).rejects.toMatchObject({ code: 'invalid_config' })
    await rm(path)
    await symlink(join(directory, 'elsewhere'), path)
    await expect(service.inspect()).rejects.toBeInstanceOf(ConfigurationQualificationError)
  })

  it('fails closed on unqualified action trust policy', async () => {
    const { service } = await fixture({
      schemaVersion: 2,
      actions: { approvedExecutables: ['bash'] }
    })
    await expect(service.inspect()).rejects.toMatchObject({ code: 'invalid_config' })
  })

  it('atomically updates a section, preserves extensions, and commits runtime settings', async () => {
    const { service, path, state } = await fixture({
      schemaVersion: 2,
      revision: 7,
      appearance: { theme: 'dark', futurePreference: 'keep me' }
    })
    const result = await service.update({
      expectedRevision: 7,
      update: {
        appearance: { theme: 'light', density: 'compact', fontFamily: 'Sans' },
        notifications: { systemEnabled: false, includeBody: true }
      }
    })
    expect(result.config).toMatchObject({ revision: 8, appearance: { theme: 'light' } })
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      appearance: { theme: 'light', futurePreference: 'keep me' },
      notifications: { systemEnabled: false, includeBody: true }
    })
    expect(state.readSnapshot().notificationSettings).toEqual({
      systemEnabled: false,
      includeBody: true
    })
  })

  it('rejects stale updates without modifying the file', async () => {
    const { service, path } = await fixture({ schemaVersion: 2, revision: 7 })
    const before = await readFile(path)
    await expect(
      service.update({
        expectedRevision: 6,
        update: { logging: { level: 'debug' } }
      })
    ).rejects.toMatchObject({ code: 'revision_conflict' })
    expect(await readFile(path)).toEqual(before)
  })

  it('compensates the file when the SQLite runtime mutation rejects', async () => {
    const { service, path, fakeState } = await fixture({ schemaVersion: 2, revision: 9 })
    fakeState.replaceConfigurationRuntimeSettings = () => {
      throw new Error('injected SQLite failure')
    }
    await expect(
      service.update({
        expectedRevision: 9,
        update: { notifications: { systemEnabled: false, includeBody: false } }
      })
    ).rejects.toMatchObject({ code: 'runtime_failure' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schemaVersion: 2, revision: 9 })
  })

  it.skipIf(process.platform !== 'linux')(
    'validates saved shell at startup and applies updates only to future implicit launches',
    async () => {
      const commands: Array<{ executable: string; args: string[] }> = []
      const adapter: PtyAdapter = {
        spawn: (executable, args) => {
          commands.push({ executable, args })
          return Promise.resolve({
            pid: commands.length,
            onData: () => ({ dispose() {} }),
            onExit: () => ({ dispose() {} }),
            write() {},
            resize() {},
            kill() {}
          })
        }
      }
      const terminals = new TerminalService(adapter)
      const { service, path, directory, state } = await fixture(
        {
          schemaVersion: 2,
          revision: 0,
          terminal: { shellPath: '/bin/sh' }
        },
        terminals
      )
      const invalidStartup = await fixture(
        {
          schemaVersion: 2,
          terminal: { shellPath: join(directory, 'missing-shell') }
        },
        new TerminalService(adapter)
      )
      await expect(invalidStartup.service.initializeTerminalRuntime()).rejects.toMatchObject({
        code: 'invalid_config'
      })
      await service.initializeTerminalRuntime()
      const original = await terminals.create({ rows: 24, cols: 80, cwd: directory })
      expect(original.terminal.command).toEqual(['/bin/sh', '-l'])

      const invalidPath = join(directory, 'missing-shell')
      await expect(
        service.update({
          expectedRevision: 0,
          update: {
            terminal: {
              shellPath: invalidPath,
              fontFamily: 'monospace',
              fontSize: 13,
              scrollback: 10_000,
              multilinePasteProtection: true
            }
          }
        })
      ).rejects.toMatchObject({ code: 'invalid_config' })
      expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
        revision: 0,
        terminal: { shellPath: '/bin/sh' }
      })

      await service.update({
        expectedRevision: 0,
        update: {
          terminal: {
            shellPath: '/bin/false',
            fontFamily: 'monospace',
            fontSize: 13,
            scrollback: 10_000,
            multilinePasteProtection: true
          }
        }
      })
      expect(terminals.attach(original.terminal.id).terminal.command).toEqual(['/bin/sh', '-l'])
      expect(
        (await terminals.create({ rows: 24, cols: 80, cwd: directory })).terminal.command
      ).toEqual(['/bin/false'])
      const restarted = new TerminalService(adapter)
      const qualification = await ConfigurationQualification.create(
        join(directory, 'state.db'),
        state,
        true,
        restarted
      )
      await qualification.initializeTerminalRuntime()
      expect(
        (await restarted.create({ rows: 24, cols: 80, cwd: directory })).terminal.command
      ).toEqual(['/bin/false'])
      await qualification.update({
        expectedRevision: 1,
        update: {
          terminal: {
            shellPath: null,
            fontFamily: 'monospace',
            fontSize: 13,
            scrollback: 10_000,
            multilinePasteProtection: true
          }
        }
      })
      expect(
        (await restarted.create({ rows: 24, cols: 80, cwd: directory })).terminal.command
      ).not.toEqual(['/bin/false'])
      expect(commands.at(-1)?.executable).not.toBe('/bin/false')
    }
  )

  it('loads and applies the private service logging level', async () => {
    const lines: string[] = []
    const logger = new ServiceLogger((line) => lines.push(line))
    const terminals = new TerminalService({
      spawn: () => {
        throw new Error('No PTY should start in this fixture')
      }
    })
    const { service } = await fixture(
      { schemaVersion: 2, revision: 4, logging: { level: 'error' } },
      terminals,
      logger
    )
    await service.initializeTerminalRuntime()
    expect(logger.getLevel()).toBe('error')
    expect(lines).toEqual([])

    await service.update({ expectedRevision: 4, update: { logging: { level: 'debug' } } })
    expect(logger.getLevel()).toBe('debug')
    expect(lines.at(-1)).toContain('[debug] Configuration was updated')
    logger.emit('trace', 'requestHandled')
    expect(lines).toHaveLength(1)
    await service.update({ expectedRevision: 5, update: { logging: { level: 'trace' } } })
    logger.emit('trace', 'requestHandled')
    expect(lines.at(-1)).toContain('[trace] Authenticated request completed')
  })
})
