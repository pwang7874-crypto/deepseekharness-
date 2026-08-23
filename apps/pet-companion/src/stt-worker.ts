import { pipeline } from '@huggingface/transformers'

let transcriber: Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>> | undefined

self.onmessage = async (event: MessageEvent<{ id: string; audio: Float32Array }>) => {
  const { id, audio } = event.data
  try {
    if (!transcriber) {
      self.postMessage({ id, type: 'loading' })
      transcriber = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
        device: 'wasm',
        dtype: 'q8',
      })
    }
    self.postMessage({ id, type: 'transcribing' })
    const result = await transcriber(audio, { language: 'chinese', task: 'transcribe' })
    const text = Array.isArray(result) ? result.map((item) => item.text).join(' ') : result.text
    self.postMessage({ id, type: 'result', text: String(text ?? '').trim() })
  } catch (error) {
    self.postMessage({ id, type: 'error', error: String(error) })
  }
}
