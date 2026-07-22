import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface TokenCipher {
  decrypt(value: Buffer): string
  encrypt(value: string): Buffer
  isSecure(): boolean
}

export class ControlTokenStore {
  public constructor(
    private readonly tokenPath: string,
    private readonly cipher: TokenCipher
  ) {}

  public async loadOrCreate(): Promise<string> {
    if (!this.cipher.isSecure()) {
      return createControlToken()
    }

    try {
      const metadata = await lstat(this.tokenPath)
      if (!metadata.isFile()) {
        throw new Error('The stored control credential must be a regular file')
      }
      if (process.platform !== 'win32') {
        await chmod(dirname(this.tokenPath), 0o700)
        await chmod(this.tokenPath, 0o600)
      }
      const encrypted = await readFile(this.tokenPath)
      return this.decrypt(encrypted)
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }

    const token = createControlToken()
    const encrypted = this.cipher.encrypt(token)
    const directory = dirname(this.tokenPath)
    const temporaryPath = `${this.tokenPath}.${process.pid}.tmp`

    await mkdir(directory, { mode: 0o700, recursive: true })
    await chmod(directory, 0o700)

    try {
      const file = await open(temporaryPath, 'wx', 0o600)
      try {
        await file.writeFile(encrypted)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporaryPath, this.tokenPath)
      await chmod(this.tokenPath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true })
      throw error
    }

    return token
  }

  private decrypt(encrypted: Buffer): string {
    try {
      const token = this.cipher.decrypt(encrypted)
      if (Buffer.byteLength(token) < 32) {
        throw new Error('invalid token length')
      }
      return token
    } catch {
      throw new Error('The stored control credential could not be decrypted')
    }
  }
}

function createControlToken(): string {
  return randomBytes(32).toString('base64url')
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
