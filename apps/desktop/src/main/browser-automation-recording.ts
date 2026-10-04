import { randomUUID } from 'node:crypto'

import { BrowserWindow } from 'electron'

const MAX_RECORDING_BYTES = 16 * 1024 * 1024

export class BrowserAutomationRecording {
  readonly #window: BrowserWindow
  #painting = false
  #stopped = false

  public constructor(
    public readonly width: number,
    public readonly height: number
  ) {
    this.#window = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `automation-recording-${randomUUID()}`
      }
    })
    this.#window.webContents.setAudioMuted(true)
    this.#window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.#window.webContents.on('will-navigate', (event) => event.preventDefault())
  }

  public async initialize(): Promise<void> {
    await this.#window.loadURL(
      'data:text/html,' +
        encodeURIComponent(
          '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:"><canvas></canvas>'
        )
    )
    await this.#window.webContents.executeJavaScript(`(() => {
      const canvas = document.querySelector('canvas');
      canvas.width = ${this.width}; canvas.height = ${this.height};
      const context = canvas.getContext('2d');
      const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('WebM encoding unavailable');
      const state = { canvas, context, chunks: [], bytes: 0, overflow: false, started: false };
      state.start = () => {
        const stream = canvas.captureStream(0);
        const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2000000 });
        state.stream = stream; state.recorder = recorder;
        state.done = new Promise((resolve, reject) => {
          recorder.ondataavailable = event => {
            state.bytes += event.data.size;
            if (state.bytes > ${MAX_RECORDING_BYTES}) {
              state.overflow = true;
              if (recorder.state !== 'inactive') recorder.stop();
            } else state.chunks.push(event.data);
          };
          recorder.onerror = event => reject(new Error(event.error?.message || 'WebM encoding failed'));
          recorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop());
            if (state.overflow) { reject(new Error('Recording size limit exceeded')); return; }
            const bytes = new Uint8Array(await new Blob(state.chunks, { type: mimeType }).arrayBuffer());
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
            resolve(btoa(binary));
          };
        });
        recorder.start(250); state.startedAt = performance.now(); state.started = true;
      };
      window.recording = state;
    })()`)
  }

  public async frame(jpeg: string): Promise<void> {
    if (this.#painting || this.#stopped || this.#window.isDestroyed()) return
    this.#painting = true
    try {
      await this.#window.webContents.executeJavaScript(`(async () => {
        const state = window.recording;
        if (state.started && state.recorder.state === 'inactive') return;
        const image = new Image();
        image.src = ${JSON.stringify(`data:image/jpeg;base64,${jpeg}`)};
        await image.decode();
        state.context.drawImage(image, 0, 0, state.canvas.width, state.canvas.height);
        if (!state.started) state.start();
        state.stream.getVideoTracks()[0].requestFrame();
      })()`)
    } finally {
      this.#painting = false
    }
  }

  public async stop(): Promise<Buffer> {
    this.#stopped = true
    try {
      const recording = (await this.#window.webContents.executeJavaScript(`(async () => {
        const state = window.recording;
        if (!state.started) throw new Error('No browser frames were recorded');
        const durationMs = performance.now() - state.startedAt;
        if (state.recorder.state !== 'inactive') state.recorder.stop();
        return { base64: await state.done, durationMs };
      })()`)) as { base64: string; durationMs: number }
      const bytes = finalizeWebmRecording(
        Buffer.from(recording.base64, 'base64'),
        recording.durationMs
      )
      if (bytes.length === 0 || bytes.length > MAX_RECORDING_BYTES) {
        throw new Error('Recording size limit exceeded')
      }
      return bytes
    } finally {
      this.dispose()
    }
  }

  public dispose(): void {
    this.#stopped = true
    if (!this.#window.isDestroyed()) this.#window.destroy()
  }
}

interface WebmElement {
  id: number
  start: number
  dataStart: number
  end: number
  unknownSize: boolean
}

const SEGMENT_ID = 0x18538067
const INFO_ID = 0x1549a966
const CLUSTER_ID = 0x1f43b675
const CUES_ID = 0x1c53bb6b
const SEEK_HEAD_ID = 0x114d9b74
const SEGMENT_CHILD_IDS = new Set([
  INFO_ID,
  CLUSTER_ID,
  CUES_ID,
  SEEK_HEAD_ID,
  0x1654ae6b,
  0x1941a469,
  0x1043a770,
  0x1254c367
])

function readVint(bytes: Buffer, offset: number, end: number) {
  const first = bytes[offset]
  if (offset >= end || first === undefined || first === 0) throw new Error('Invalid WebM recording')
  let length = 1
  while ((first & (1 << (8 - length))) === 0) length += 1
  if (offset + length > end) throw new Error('Invalid WebM recording')
  const mask = (1 << (8 - length)) - 1
  let value = first & mask
  let unknown = value === mask
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[offset + index]!
    value = value * 256 + byte
    unknown = unknown && byte === 0xff
  }
  if (!unknown && !Number.isSafeInteger(value)) throw new Error('Invalid WebM recording')
  return { length, value, unknown }
}

function readElement(bytes: Buffer, offset: number, end: number): WebmElement {
  const id = readVint(bytes, offset, end)
  if (id.length > 4) throw new Error('Invalid WebM recording')
  const size = readVint(bytes, offset + id.length, end)
  const dataStart = offset + id.length + size.length
  const elementEnd = size.unknown ? end : dataStart + size.value
  if (elementEnd > end) throw new Error('Invalid WebM recording')
  return {
    id: bytes.readUIntBE(offset, id.length),
    start: offset,
    dataStart,
    end: elementEnd,
    unknownSize: size.unknown
  }
}

function readElements(bytes: Buffer, start: number, end: number): WebmElement[] {
  const elements: WebmElement[] = []
  while (start < end) {
    const element = readElement(bytes, start, end)
    if (element.unknownSize) {
      if (element.id !== CLUSTER_ID) throw new Error('Invalid WebM recording')
      let boundary = element.dataStart
      while (boundary < end) {
        const child = readElement(bytes, boundary, end)
        if (SEGMENT_CHILD_IDS.has(child.id)) break
        if (child.unknownSize) throw new Error('Invalid WebM recording')
        boundary = child.end
      }
      element.end = boundary
    }
    elements.push(element)
    start = element.end
  }
  return elements
}

function readUnsigned(bytes: Buffer, start: number, end: number): number {
  let value = 0
  for (let offset = start; offset < end; offset += 1) value = value * 256 + bytes[offset]!
  if (!Number.isSafeInteger(value)) throw new Error('Invalid WebM recording')
  return value
}

function encodeUnsigned(value: number): Buffer {
  const bytes = Buffer.alloc(8)
  bytes.writeBigUInt64BE(BigInt(value))
  return bytes
}

function encodeElement(id: number, data: Buffer): Buffer {
  let length = 1
  while (data.length >= 2 ** (7 * length) - 1) length += 1
  const size = Buffer.alloc(length)
  size.writeUIntBE(data.length, 0, length)
  size[0] = size[0]! | (1 << (8 - length))
  return Buffer.concat([Buffer.from(id.toString(16), 'hex'), size, data])
}

/** MediaRecorder writes live WebM without the metadata needed by saved-file players. */
function finalizeWebmRecording(bytes: Buffer, durationMs: number): Buffer {
  const header = readElement(bytes, 0, bytes.length)
  const segment = readElement(bytes, header.end, bytes.length)
  if (
    header.id !== 0x1a45dfa3 ||
    segment.id !== SEGMENT_ID ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new Error('Invalid WebM recording')
  }
  const children = readElements(bytes, segment.dataStart, segment.end)
  const info = children.find((child) => child.id === INFO_ID)
  if (!info) throw new Error('Invalid WebM recording')
  const infoChildren = readElements(bytes, info.dataStart, info.end)
  const timestampScale = infoChildren.find((child) => child.id === 0x2ad7b1)
  const scale = timestampScale
    ? readUnsigned(bytes, timestampScale.dataStart, timestampScale.end)
    : 1_000_000
  if (scale === 0) throw new Error('Invalid WebM recording')
  const duration = Buffer.alloc(8)
  duration.writeDoubleBE((Math.max(1, durationMs) * 1_000_000) / scale)
  const updatedInfo = encodeElement(
    INFO_ID,
    Buffer.concat([
      ...infoChildren
        .filter((child) => child.id !== 0x4489 && child.id !== 0xbf)
        .map((child) => bytes.subarray(child.start, child.end)),
      encodeElement(0x4489, duration)
    ])
  )
  const chunks = children
    .filter((child) => child.id !== SEEK_HEAD_ID && child.id !== CUES_ID && child.id !== 0xbf)
    .map((child) => ({
      source: child,
      position: 0,
      bytes:
        child.id === INFO_ID
          ? updatedInfo
          : child.id === CLUSTER_ID
            ? encodeElement(CLUSTER_ID, bytes.subarray(child.dataStart, child.end))
            : bytes.subarray(child.start, child.end)
    }))
  const seekHead = (positions: { id: number; position: number }[]) =>
    encodeElement(
      SEEK_HEAD_ID,
      Buffer.concat(
        positions.map(({ id, position }) =>
          encodeElement(
            0x4dbb,
            Buffer.concat([
              encodeElement(0x53ab, Buffer.from(id.toString(16), 'hex')),
              encodeElement(0x53ac, encodeUnsigned(position))
            ])
          )
        )
      )
    )
  const positions = chunks
    .filter((chunk) => chunk.source.id > 0xffffff)
    .map((chunk) => ({ id: chunk.source.id, position: 0 }))
  const cuesPosition = { id: CUES_ID, position: 0 }
  positions.push(cuesPosition)
  // Fixed-width seek offsets keep this header's size stable as positions are assigned.
  let offset = seekHead(positions).length
  const cuePoints: Buffer[] = []
  for (const chunk of chunks) {
    chunk.position = offset
    offset += chunk.bytes.length
    if (chunk.source.id !== CLUSTER_ID) continue
    const blocks = readElements(bytes, chunk.source.dataStart, chunk.source.end)
    const timestamp = blocks.find((block) => block.id === 0xe7)
    if (!timestamp) throw new Error('Invalid WebM recording')
    const clusterTime = readUnsigned(bytes, timestamp.dataStart, timestamp.end)
    for (const entry of blocks) {
      let block = entry
      if (entry.id === 0xa0) {
        const group = readElements(bytes, entry.dataStart, entry.end)
        if (group.some((child) => child.id === 0xfb)) continue
        const frame = group.find((child) => child.id === 0xa1)
        if (!frame) throw new Error('Invalid WebM recording')
        block = frame
      } else if (entry.id !== 0xa3) continue
      const track = readVint(bytes, block.dataStart, block.end)
      if (block.dataStart + track.length + 3 > block.end) throw new Error('Invalid WebM recording')
      if (entry.id === 0xa3 && (bytes[block.dataStart + track.length + 2]! & 0x80) === 0) continue
      const time = clusterTime + bytes.readInt16BE(block.dataStart + track.length)
      cuePoints.push(
        encodeElement(
          0xbb,
          Buffer.concat([
            encodeElement(0xb3, encodeUnsigned(time)),
            encodeElement(
              0xb7,
              Buffer.concat([
                encodeElement(0xf7, encodeUnsigned(track.value)),
                encodeElement(0xf1, encodeUnsigned(chunk.position))
              ])
            )
          ])
        )
      )
    }
  }
  if (cuePoints.length === 0) throw new Error('Recorded WebM has no video keyframes')
  let index = 0
  for (const chunk of chunks) {
    if (chunk.source.id > 0xffffff) positions[index++]!.position = chunk.position
  }
  cuesPosition.position = offset
  const data = Buffer.concat([
    seekHead(positions),
    ...chunks.map((chunk) => chunk.bytes),
    encodeElement(CUES_ID, Buffer.concat(cuePoints))
  ])
  return Buffer.concat([bytes.subarray(0, segment.start), encodeElement(SEGMENT_ID, data)])
}
