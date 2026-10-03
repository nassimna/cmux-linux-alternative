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
        recorder.start(250); state.started = true;
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
      const base64 = (await this.#window.webContents.executeJavaScript(`(async () => {
        const state = window.recording;
        if (!state.started) throw new Error('No browser frames were recorded');
        if (state.recorder.state !== 'inactive') state.recorder.stop();
        return await state.done;
      })()`)) as string
      const bytes = Buffer.from(base64, 'base64')
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
