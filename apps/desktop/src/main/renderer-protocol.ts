import { isAbsolute, relative, resolve } from 'node:path'

export const RENDERER_SCHEME = 'agent-workspace'
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://renderer`

export function resolveRendererAsset(rendererRoot: string, requestUrl: string): string | undefined {
  const url = new URL(requestUrl)
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== 'renderer') {
    return undefined
  }

  const rawPathname = requestUrl.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] ?? '/'
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return undefined
  }
  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    pathname.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return undefined
  }

  const asset = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const root = resolve(rendererRoot)
  const candidate = resolve(root, asset)
  const relativePath = relative(root, candidate)
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return undefined
  }
  return candidate
}
