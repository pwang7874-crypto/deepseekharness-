import { describe, expect, it } from 'vitest'
import { createVoiceActivityState, updateVoiceActivity } from './voice-activity'

describe('voice activity detection', () => {
  it('does not stop while the room is merely quiet', () => {
    const result = updateVoiceActivity(createVoiceActivityState(0), 0.006, 1200)
    expect(result.state.heardSpeech).toBe(false)
    expect(result.finished).toBe(false)
  })

  it('stops after speech followed by a natural pause', () => {
    const spoken = updateVoiceActivity(createVoiceActivityState(0), 0.08, 800)
    expect(spoken.state.heardSpeech).toBe(true)
    expect(updateVoiceActivity(spoken.state, 0.004, 1600).finished).toBe(false)
    expect(updateVoiceActivity(spoken.state, 0.004, 1800).finished).toBe(true)
  })

  it('has a hard timeout when no speech is detected', () => {
    expect(updateVoiceActivity(createVoiceActivityState(0), 0, 30_001).finished).toBe(true)
  })
})
