let worker: Worker | undefined

async function mono16k(blob: Blob) {
  const context = new AudioContext()
  const decoded = await context.decodeAudioData(await blob.arrayBuffer())
  const frames = Math.ceil(decoded.duration * 16_000)
  const offline = new OfflineAudioContext(1, Math.max(frames, 1), 16_000)
  const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
  const rendered = await offline.startRendering()
  await context.close()
  return rendered.getChannelData(0).slice()
}

export async function transcribeRecording(blob: Blob, onState: (state: 'loading' | 'transcribing') => void) {
  const audio = await mono16k(blob)
  if (audio.length < 1_600) throw new Error('录音太短，请至少说 0.1 秒。')
  worker ??= new Worker(new URL('./stt-worker.ts', import.meta.url), { type: 'module' })
  const id = crypto.randomUUID()
  return new Promise<string>((resolve, reject) => {
    const listener = (event: MessageEvent<{ id: string; type: string; text?: string; error?: string }>) => {
      if (event.data.id !== id) return
      if (event.data.type === 'loading' || event.data.type === 'transcribing') return onState(event.data.type)
      worker?.removeEventListener('message', listener)
      if (event.data.type === 'result') resolve(event.data.text ?? '')
      else reject(new Error(event.data.error || '语音识别失败'))
    }
    worker?.addEventListener('message', listener)
    worker?.postMessage({ id, audio }, [audio.buffer])
  })
}

export async function startMicrophoneRecording() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前系统 WebView 不支持麦克风录音。')
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
  recorder.start(250)
  return {
    stop: () => new Promise<Blob>((resolve) => {
      recorder.onstop = () => { stream.getTracks().forEach((track) => track.stop()); resolve(new Blob(chunks, { type: recorder.mimeType })) }
      recorder.stop()
    }),
    cancel: () => { if (recorder.state !== 'inactive') recorder.stop(); stream.getTracks().forEach((track) => track.stop()) },
  }
}
