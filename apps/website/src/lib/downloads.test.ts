import assert from 'node:assert/strict'
import test from 'node:test'
import { recommendedDownload } from './downloads.ts'

void test('recommends the matching desktop OS and available architecture', () => {
  assert.deepEqual(
    recommendedDownload({
      platform: 'Win32',
      userAgent: 'Windows NT 10.0; Win64; x64',
      maxTouchPoints: 0
    }),
    { os: 'windows', asset: 'windows-x64' }
  )
  assert.deepEqual(
    recommendedDownload({ platform: 'Linux x86_64', userAgent: 'Linux x86_64', maxTouchPoints: 0 }),
    { os: 'linux', asset: 'linux-x64' }
  )
  assert.deepEqual(
    recommendedDownload({
      platform: 'macOS',
      userAgent: 'Macintosh',
      maxTouchPoints: 0,
      architecture: 'arm',
      bitness: '64'
    }),
    { os: 'mac', asset: 'mac-arm64' }
  )
  assert.deepEqual(
    recommendedDownload({
      platform: 'macOS',
      userAgent: 'Macintosh',
      maxTouchPoints: 0,
      architecture: 'x86',
      bitness: '64'
    }),
    { os: 'mac', asset: 'mac-x64' }
  )
})

void test('does not guess an Intel Mac or offer x64 as a native ARM download', () => {
  assert.deepEqual(
    recommendedDownload({ platform: 'MacIntel', userAgent: 'Macintosh', maxTouchPoints: 0 }),
    { os: 'mac', asset: undefined }
  )
  assert.deepEqual(
    recommendedDownload({
      platform: 'Linux aarch64',
      userAgent: 'Linux aarch64',
      maxTouchPoints: 0
    }),
    { os: 'linux', asset: undefined }
  )
})

void test('uses explicit CPU hints over a frozen x64 user agent', () => {
  assert.deepEqual(
    recommendedDownload({
      platform: 'Windows',
      userAgent: 'Windows NT 10.0; Win64; x64',
      maxTouchPoints: 0,
      architecture: 'x86',
      bitness: '32'
    }),
    { os: 'windows', asset: undefined }
  )
})

void test('leaves mobile devices and unknown platforms with manual downloads', () => {
  for (const browser of [
    { platform: 'MacIntel', userAgent: 'Macintosh', maxTouchPoints: 5 },
    { platform: 'Linux armv8', userAgent: 'Android 15', maxTouchPoints: 5 },
    { platform: 'iPhone', userAgent: 'iPhone', maxTouchPoints: 5 },
    { platform: 'CrOS', userAgent: 'CrOS x86_64', maxTouchPoints: 0 },
    { platform: 'unknown', userAgent: 'unknown', maxTouchPoints: 0 }
  ])
    assert.equal(recommendedDownload(browser), undefined)
})
