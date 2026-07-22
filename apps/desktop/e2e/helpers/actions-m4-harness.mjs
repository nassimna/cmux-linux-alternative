import { createHash, randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { execFile, execFileSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function prepareM4Project(profileDirectory) {
  const projectDirectory = profileDirectory
  const cmuxDirectory = join(projectDirectory, '.cmux')
  const binDirectory = join(projectDirectory, 'm4-bin')
  const artifactDirectory = join(projectDirectory, 'm4-artifacts')
  await mkdir(cmuxDirectory, { recursive: true })
  await mkdir(binDirectory, { recursive: true })
  await mkdir(artifactDirectory, { recursive: true })
  const executable = join(binDirectory, 'action-runner')
  const source = join(binDirectory, 'action-runner.c')
  await writeFile(
    source,
    [
      '#include <stdio.h>',
      '#include <string.h>',
      '#include <unistd.h>',
      'static void touch(const char *path) { FILE *file = fopen(path, "w"); if (file) fclose(file); }',
      'int main(int argc, char **argv) {',
      '  if (argc < 2) return 2;',
      '  if (!strcmp(argv[1], "literal")) {',
      '    FILE *file = fopen("m4-artifacts/literal-result", "w");',
      '    if (!file || argc < 3) return 3; fputs(argv[2], file); fclose(file); return 0;',
      '  }',
      '  if (!strcmp(argv[1], "deny")) { touch("m4-artifacts/denied-side-effect"); return 0; }',
      '  if (!strcmp(argv[1], "output")) {',
      "    for (int index = 0; index < 8192; ++index) fputc('X', stdout);",
      '    fputs("M4_PRIVATE_MARKER", stderr); return 0;',
      '  }',
      '  if (!strcmp(argv[1], "slow")) { sleep(30); touch("m4-artifacts/slow-finished"); return 0; }',
      '  return 4;',
      '}',
      ''
    ].join('\n')
  )
  execFileSync(process.env.CC ?? 'cc', [source, '-O2', '-o', executable], { cwd: projectDirectory })
  await chmod(executable, 0o700)
  const actions = [
    definition('project.m4.literal', 'Literal argv', [
      'literal',
      '$(touch m4-artifacts/escape) ; *'
    ]),
    definition('project.m4.deny', 'Denied action', ['deny']),
    definition('project.m4.output', 'Bounded output', ['output']),
    definition('project.m4.slow', 'Cancelable action', ['slow'])
  ]
  const manifestBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, actions }))
  await writeFile(join(cmuxDirectory, 'actions.json'), manifestBytes)
  const canonicalRoot = await import('node:fs/promises').then(({ realpath }) =>
    realpath(projectDirectory)
  )
  const configurationDirectory = join(profileDirectory, 'configuration')
  await mkdir(configurationDirectory, { recursive: true })
  await writeFile(
    join(configurationDirectory, 'desktop.json'),
    `${JSON.stringify({
      schemaVersion: 2,
      revision: 0,
      actions: {
        approvedExecutables: [],
        trustedProjects: [
          {
            canonicalRoot,
            manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
            trustedAtUnixMs: 1
          }
        ]
      }
    })}\n`
  )
  return { artifactDirectory, projectDirectory }
}

function definition(id, title, args) {
  return {
    id,
    title,
    executable: { kind: 'projectRelativePath', path: 'm4-bin/action-runner' },
    args,
    workingDirectory: { kind: 'projectRoot' },
    environment: []
  }
}

export async function m4Cli(cliBinary, sessionFile, args) {
  let stdout
  try {
    ;({ stdout } = await execFileAsync(cliBinary, ['--session-file', sessionFile, ...args], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 45_000
    }))
  } catch (error) {
    throw new Error(
      `M4 CLI failed: ${JSON.stringify({
        code: error.code,
        signal: error.signal,
        stderr: String(error.stderr ?? ''),
        stdout: String(error.stdout ?? '')
      })}`,
      { cause: error }
    )
  }
  const envelope = JSON.parse(stdout)
  return envelope.result ?? envelope
}

export function m4CliProcess(cliBinary, sessionFile, args) {
  return execFileAsync(cliBinary, ['--session-file', sessionFile, ...args], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 45_000
  })
}

export function m4SpawnCli(cliBinary, sessionFile, args) {
  const child = execFile(cliBinary, ['--session-file', sessionFile, ...args], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 45_000
  })
  return child
}

export async function m4CliFailure(cliBinary, sessionFile, args) {
  try {
    await m4CliProcess(cliBinary, sessionFile, args)
  } catch (error) {
    const output = JSON.parse(String(error.stdout || error.stderr))
    return output.error ?? output.result?.invocation ?? output
  }
  throw new Error('Expected M4 CLI command to fail')
}

export async function m4RawCommand(sessionFile, command, params, id = randomUUID()) {
  const record = JSON.parse(await readFile(sessionFile, 'utf8'))
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.endpoint)
    let buffered = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error(`M4 raw command timed out: ${command}`))
    }, 20_000)
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ auth: { token: record.token } })}\n`)
      socket.write(`${JSON.stringify({ id, command, params })}\n`)
    })
    socket.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        const message = JSON.parse(line)
        if (message.id !== id) continue
        clearTimeout(timeout)
        socket.end()
        resolve(message)
      }
    })
    socket.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

export function actionInvokeParams(
  actionId,
  epoch,
  parameters,
  target,
  key = randomUUID(),
  correlationId = randomUUID()
) {
  return {
    actionId,
    actionVersion: 1,
    parameters,
    ...(target ? { target } : {}),
    idempotency: { epoch, key },
    correlationId
  }
}
