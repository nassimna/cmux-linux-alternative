import { describe, expect, it, vi } from 'vitest'

import { BrowserAutomationRecording } from './browser-automation-recording'

const recordingWindow = vi.hoisted(() => ({
  webContents: {
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    executeJavaScript: vi.fn()
  },
  isDestroyed: () => false,
  destroy: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    public constructor() {
      return recordingWindow
    }
  }
}))

const header = '1a45dfa3874282847765626d'
const tracks = '1654ae6b97ae95d781018381018685565f565039e086b08101ba8101'
const frames = ['a38781000080aabbcc', 'a38781006400ccddee', 'a38781001480ddeeaa']
const alphaTracks = '1654ae6b9bae99d781018381018685565f565039e08ab08101ba810153c08101'
const groupedFrames = [
  'a096a18781000000aabbcc75a18aa688ee8101a583fafbfc',
  'a099a18781006400ccddee75a18aa688ee8101a583fafbfcfb8100',
  'a096a18781001400ddeeaa75a18aa688ee8101a583fafbfc'
]
const live =
  header +
  '1853806701ffffffffffffff' +
  '1549a966872ad7b1830f4240' +
  alphaTracks +
  '1f43b67501ffffffffffffffe78100' +
  groupedFrames[0] +
  groupedFrames[1] +
  '1f43b67501ffffffffffffffe78203e8' +
  groupedFrames[2]
const finite =
  header +
  '18538067d4' +
  '1549a966872ad7b1831e8480' +
  tracks +
  '1f43b67595e78100' +
  frames[0] +
  frames[1] +
  '1f43b6758de78203e8' +
  frames[2]

function dataOffset(bytes: Buffer, offset: number, idLength: number): number {
  let length = 1
  while ((bytes[offset + idLength]! & (1 << (8 - length))) === 0) length += 1
  return offset + idLength + length
}

function elementEnd(bytes: Buffer, offset: number, idLength: number): number {
  const start = dataOffset(bytes, offset, idLength)
  const length = start - offset - idLength
  let size = bytes[offset + idLength]! & ((1 << (8 - length)) - 1)
  for (let index = 1; index < length; index += 1)
    size = size * 256 + bytes[offset + idLength + index]!
  return start + size
}

function uintField(id: string, value: number): Buffer {
  const data = Buffer.alloc(8)
  data.writeBigUInt64BE(BigInt(value))
  return Buffer.concat([Buffer.from(id + '88', 'hex'), data])
}

describe('BrowserAutomationRecording', () => {
  it.each([
    {
      name: 'live unknown-size clusters with VP9 alpha block groups',
      source: live,
      preservedFrames: groupedFrames,
      durationMs: 1250,
      durationTicks: 1250
    },
    {
      name: 'finite clusters with a 2ms timestamp scale',
      source: finite,
      preservedFrames: frames,
      durationMs: 2600,
      durationTicks: 1300
    }
  ])(
    'finalizes $name with duration and correct keyframe seek positions',
    async ({ source, preservedFrames, durationMs, durationTicks }) => {
      recordingWindow.webContents.executeJavaScript.mockResolvedValueOnce({
        base64: Buffer.from(source, 'hex').toString('base64'),
        durationMs
      })
      const recording = new BrowserAutomationRecording(100, 50)
      const bytes = await recording.stop()
      expect(bytes.subarray(0, header.length / 2).toString('hex')).toBe(header)
      const segmentStart = header.length / 2
      const segmentData = dataOffset(bytes, segmentStart, 4)
      expect(bytes[segmentStart + 4]).not.toBe(0x01)
      const durationOffset = bytes.indexOf(Buffer.from('448988', 'hex'))
      expect(durationOffset).toBeGreaterThan(0)
      expect(bytes.readDoubleBE(durationOffset + 3)).toBe(durationTicks)

      const clusterMarker = Buffer.from('1f43b675', 'hex')
      const seekHeadEnd = elementEnd(bytes, segmentData, 4)
      expect(elementEnd(bytes, segmentStart, 4)).toBe(bytes.length)
      const firstCluster = bytes.indexOf(clusterMarker, seekHeadEnd)
      const secondCluster = bytes.indexOf(clusterMarker, firstCluster + 4)
      expect(bytes[firstCluster + 4]).not.toBe(0x01)
      expect(bytes[secondCluster + 4]).not.toBe(0x01)
      for (const frame of preservedFrames)
        expect(bytes.includes(Buffer.from(frame, 'hex'))).toBe(true)
      const cuesOffset = bytes.indexOf(Buffer.from('1c53bb6b', 'hex'), secondCluster + 4)
      const cues = bytes.subarray(dataOffset(bytes, cuesOffset, 4))
      expect(cues.includes(uintField('b3', 0))).toBe(true)
      expect(cues.includes(uintField('b3', 1020))).toBe(true)
      expect(cues.includes(uintField('b3', 100))).toBe(false)
      expect(cues.includes(uintField('f7', 1))).toBe(true)
      expect(cues.includes(uintField('f1', firstCluster - segmentData))).toBe(true)
      expect(cues.includes(uintField('f1', secondCluster - segmentData))).toBe(true)
      const seekHead = bytes.subarray(segmentData, seekHeadEnd)
      expect(seekHead.subarray(0, 4).toString('hex')).toBe('114d9b74')
      expect(seekHead.includes(Buffer.from('53ab841c53bb6b', 'hex'))).toBe(true)
      expect(seekHead.includes(uintField('53ac', cuesOffset - segmentData))).toBe(true)
      expect(recordingWindow.destroy).toHaveBeenCalled()
    }
  )
})
