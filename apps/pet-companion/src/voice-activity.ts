export type VoiceActivityState = {
  startedAt: number
  noiseFloor: number
  heardSpeech: boolean
  lastVoiceAt: number
}

export function createVoiceActivityState(now: number): VoiceActivityState {
  return { startedAt: now, noiseFloor: 0.008, heardSpeech: false, lastVoiceAt: 0 }
}

export function updateVoiceActivity(state: VoiceActivityState, rms: number, now: number) {
  const elapsed = now - state.startedAt
  const noiseFloor = elapsed < 650 && !state.heardSpeech ? state.noiseFloor * 0.9 + rms * 0.1 : state.noiseFloor
  const threshold = Math.max(0.018, noiseFloor * 2.7)
  const voiceNow = rms >= threshold
  const heardSpeech = state.heardSpeech || voiceNow
  const lastVoiceAt = voiceNow ? now : state.lastVoiceAt
  return {
    state: { ...state, noiseFloor, heardSpeech, lastVoiceAt },
    finished: (heardSpeech && now - lastVoiceAt > 950) || elapsed > 30_000,
  }
}
