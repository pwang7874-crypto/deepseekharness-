import type { PetEvent } from './types'

export type Emotion = 'neutral' | 'listening' | 'thinking' | 'speaking' | 'happy' | 'gentle' | 'concerned' | 'error'

const baseStyle: Record<Emotion, [number, number]> = {
  happy: [1.12, 1.2], gentle: [0.88, 0.88], concerned: [0.9, 0.82], error: [0.92, 0.78],
  thinking: [0.9, 0.96], speaking: [1, 1], neutral: [1, 1], listening: [1, 1],
}
export function speechTuning(emotion: Emotion, tone: string, intensity: number) {
  const [rate, pitch] = baseStyle[emotion]
  const lively = /活泼|俏皮|可爱|元气/.test(tone)
  const calm = /温柔|冷静|沉稳|安静/.test(tone)
  return {
    rate: rate + intensity * 0.06 + (lively ? 0.1 : 0) - (calm ? 0.07 : 0),
    pitch: pitch + intensity * 0.08 + (lively ? 0.12 : 0) - (calm ? 0.04 : 0),
    volume: Math.max(0.35, Math.min(1, 0.65 + intensity * 0.35)),
  }
}

export function motionForEmotion(emotion: Emotion) {
  if (emotion === 'happy') return 'happy'
  if (emotion === 'thinking') return 'idle_think'
  if (emotion === 'speaking') return 'talk'
  if (emotion === 'listening') return 'tap_body'
  return 'idle'
}

export function shouldKeepCurrentBubble(event: Pick<PetEvent, 'type'>, synthesisSpeaking: boolean) {
  return event.type === 'task-complete' && synthesisSpeaking
}
