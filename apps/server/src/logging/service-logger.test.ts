import { describe, expect, it } from 'vitest'

import { ServiceLogger } from './service-logger'

describe('private service logger', () => {
  it('filters subsequent events by severity and only writes fixed messages', () => {
    const lines: string[] = []
    const logger = new ServiceLogger((line) => lines.push(line))
    logger.emit('debug', 'configurationUpdated')
    expect(lines).toEqual([])

    logger.setLevel('debug')
    logger.emit('debug', 'configurationUpdated')
    logger.emit('trace', 'requestHandled')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('[debug] Configuration was updated')

    logger.setLevel('trace')
    logger.emit('trace', 'requestHandled')
    expect(lines.at(-1)).toContain('[trace] Authenticated request completed')

    logger.setLevel('error')
    logger.emit('warn', 'terminalRetireFailed')
    expect(lines).toHaveLength(2)
    logger.emit('error', 'requestFailed')
    expect(lines.at(-1)).toContain('[error] Request failed')
    expect(() => logger.setLevel('invalid' as never)).toThrow('Invalid service log level')
  })
})
