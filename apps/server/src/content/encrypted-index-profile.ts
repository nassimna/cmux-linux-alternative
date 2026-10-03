import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'

/** Never let an isolated state copy attach to the Rust-owned profile index. */
export function isolatedIndexProfile(sourceStatePath: string, workingStatePath: string): string {
  const source = dirname(sourceStatePath)
  const working = dirname(workingStatePath)
  const sourceCanonical = realpathSync(source)
  const workingCanonical = realpathSync(working)
  if (
    sourceCanonical !== source ||
    workingCanonical !== working ||
    sourceCanonical === workingCanonical
  )
    throw new Error('Encrypted search requires separate canonical source and working profiles')
  return workingCanonical
}
