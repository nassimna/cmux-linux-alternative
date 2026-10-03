import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { closeSync, existsSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { build } from 'esbuild'
import { expect, it } from 'vitest'

import { ApplicationStateStore } from '../persistence/application-state-store'
import { IsolatedCredentialScope } from './credential-scope'
import { SecretServiceCredentialProvider } from './credential-secret-service'
import { verifyNativeCredentialState } from './credential-enroll-utility'
import { RemoteCredentialEnrollmentService } from './remote-credential-enrollment-service'

it('qualifies only a private native database with an active Node owner', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.native-credential-state-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'state.sqlite3')
  try {
    const owner = await ApplicationStateStore.openNative(
      path,
      join(directory, 'backup.sqlite3'),
      directory
    )
    const file = lstatSync(path)
    const request = { nativeStatePath: path, stateIdentity: `${file.dev}:${file.ino}` }
    try {
      const scope = IsolatedCredentialScope.loadOrCreate(path)
      await SecretServiceCredentialProvider.create(
        join(directory, 'remote-agent-brokers'), scope
      )
      await expect(verifyNativeCredentialState(request)).resolves.toBeUndefined()
      await expect(verifyNativeCredentialState({
        ...request, stateIdentity: `${file.dev}:${file.ino + 1}`
      })).rejects.toMatchObject({ code: 'native_unavailable' })
      const enrollment = await RemoteCredentialEnrollmentService.create({
        workingStatePath: path,
        nativeMode: true,
        keyring: {
          validateInheritedFd: () => undefined,
          enrollFromInheritedFd: () => Promise.resolve(),
          delete: () => Promise.resolve(),
          has: () => Promise.resolve(true)
        },
        revokeTargetTransports: () => Promise.resolve()
      })
      try {
        await expect(enrollment.beginOnlineNew(randomUUID(), randomUUID()))
          .rejects.toMatchObject({ code: 'storage_unavailable' })
      } finally {
        enrollment.close()
      }
    } finally {
      owner.close()
    }
    await expect(verifyNativeCredentialState(request)).rejects.toMatchObject({
      code: 'native_unavailable'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('stores and commits a new native key through a private child descriptor', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.native-credential-helper-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'state.sqlite3')
  try {
    const owner = await ApplicationStateStore.openNative(
      path, join(directory, 'backup.sqlite3'), directory
    )
    try {
      IsolatedCredentialScope.loadOrCreate(path)
      const targetId = randomUUID()
      const enrollmentId = randomUUID()
      const markerPath = join(directory, 'stored-target')
      const keyring = {
        validateInheritedFd: () => undefined,
        enrollFromInheritedFd: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        has: () => Promise.resolve(
          existsSync(markerPath) && readFileSync(markerPath, 'utf8') === targetId
        )
      }
      const enrollment = await RemoteCredentialEnrollmentService.create({
        workingStatePath: path,
        nativeMode: true,
        keyring,
        revokeTargetTransports: () => Promise.resolve()
      })
      try {
        await enrollment.beginOnlineNew(targetId, enrollmentId)
        const helperPath = join(directory, 'native-helper.mjs')
        await build({
          stdin: {
            contents: `import { writeFileSync } from 'node:fs';
              import { runNativeCredentialWrite } from './src/remote/credential-enroll-utility.ts';
              const request = JSON.parse(process.argv[2]);
              const markerPath = process.argv[3];
              const keyring = {
                validateInheritedFd: () => {},
                enrollFromInheritedFd: async () => { throw new Error('replacement forbidden') },
                enrollNewFromInheritedFd: async (id) => writeFileSync(markerPath, id),
                delete: async () => {},
                has: async () => false
              };
              runNativeCredentialWrite(request, { keyring }).then(
                (value) => process.stdout.write(JSON.stringify(value)),
                (error) => { process.stderr.write(error.code ?? 'failed'); process.exitCode = 1 }
              );`,
            resolveDir: process.cwd(),
            sourcefile: 'native-credential-helper-entry.ts',
            loader: 'ts'
          },
          bundle: true,
          platform: 'node',
          format: 'esm',
          external: ['better-sqlite3', 'dbus-next', 'ssh2', 'zod'],
          outfile: helperPath
        })
        const descriptorPath = join(directory, 'key')
        await writeFile(descriptorPath, 'private-key-fixture', { mode: 0o600 })
        const file = lstatSync(path)
        const request = {
          version: 7,
          nativeStatePath: path,
          stateIdentity: `${file.dev}:${file.ino}`,
          targetId,
          enrollmentId,
          expectedRevision: 0
        }
        const descriptor = openSync(descriptorPath, 'r')
        let child: ReturnType<typeof spawnSync>
        try {
          child = spawnSync(process.execPath,
            [helperPath, JSON.stringify(request), markerPath],
            { stdio: ['ignore', 'pipe', 'pipe', descriptor], timeout: 10_000 })
        } finally {
          closeSync(descriptor)
        }
        expect(child.status, child.stderr.toString()).toBe(0)
        expect(JSON.parse(child.stdout.toString())).toEqual({
          status: 'stored', targetId, enrollmentId
        })
        expect(await enrollment.beginOnlineNew(targetId, enrollmentId)).toBe(enrollmentId)
        const target = {
          remoteTargetId: targetId,
          label: 'Native SSH',
          host: 'native.example.com',
          port: 22,
          user: 'builder',
          mutation: { expectedRevision: 0, idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64) }
        }
        expect((await enrollment.commitOnlineNew(enrollmentId, targetId, () =>
          owner.exclusive(() => owner.commitEnrolledRemoteTarget(target, enrollmentId))
        )).target.revision).toBe(1)
      } finally {
        enrollment.close()
      }
    } finally {
      owner.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
