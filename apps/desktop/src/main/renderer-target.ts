import { RENDERER_ORIGIN } from './renderer-protocol'

export function resolveRendererTarget(
  isPackaged: boolean,
  developmentUrl: string | undefined
): string {
  if (!isPackaged && developmentUrl) {
    return developmentUrl
  }
  return `${RENDERER_ORIGIN}/index.html`
}
