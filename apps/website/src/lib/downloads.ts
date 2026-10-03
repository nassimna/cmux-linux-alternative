type BrowserPlatform = {
  platform: string
  userAgent: string
  maxTouchPoints: number
  architecture?: string | undefined
  bitness?: string | undefined
}

export function recommendedDownload(browser: BrowserPlatform) {
  const { platform, userAgent, maxTouchPoints, architecture, bitness } = browser
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(`${platform} ${userAgent}`)) return undefined
  if (/Mac/i.test(platform) && maxTouchPoints > 1) return undefined

  const arm = /arm|aarch64/i.test(architecture ?? `${platform} ${userAgent}`)
  if (/Mac/i.test(platform)) {
    if (architecture === 'arm') return { os: 'mac', asset: 'mac-arm64' } as const
    if (architecture === 'x86' && bitness === '64') return { os: 'mac', asset: 'mac-x64' } as const
    return { os: 'mac', asset: undefined } as const
  }
  const x64 =
    architecture && bitness
      ? architecture === 'x86' && bitness === '64'
      : /x86_64|amd64|Win64|x64/i.test(`${platform} ${userAgent}`)
  if (/Win/i.test(platform)) {
    return { os: 'windows', asset: !arm && x64 ? 'windows-x64' : undefined } as const
  }
  if (/Linux/i.test(platform)) {
    return { os: 'linux', asset: !arm && x64 ? 'linux-x64' : undefined } as const
  }
  return undefined
}
