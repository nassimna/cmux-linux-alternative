import { getuid } from 'node:process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APPLICATION_ID, SOCKET_ENVIRONMENT_VARIABLE } from './identity'

interface EndpointEnvironment {
  platform: NodeJS.Platform
  environment: NodeJS.ProcessEnv
  temporaryDirectory: string
  userId: number | undefined
}

export function resolveControlEndpoint(
  isPackaged = false,
  input: EndpointEnvironment = {
    platform: process.platform,
    environment: process.env,
    temporaryDirectory: tmpdir(),
    userId: getuid?.()
  }
): string {
  const override = input.environment[SOCKET_ENVIRONMENT_VARIABLE]
  if (!isPackaged && override) {
    return override
  }

  if (input.platform === 'win32') {
    return `${APPLICATION_ID}-control`
  }

  const runtimeDirectory = input.environment.XDG_RUNTIME_DIR
  if (runtimeDirectory) {
    return join(runtimeDirectory, APPLICATION_ID, 'control.sock')
  }

  const userSuffix = input.userId === undefined ? 'unknown' : String(input.userId)
  return join(input.temporaryDirectory, `${APPLICATION_ID}-${userSuffix}`, 'control.sock')
}

export function toNodeSocketPath(endpoint: string, platform = process.platform): string {
  return platform === 'win32' ? `\\\\.\\pipe\\${endpoint}` : endpoint
}
