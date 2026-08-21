import { describe, expect, it } from 'vitest'
import { motionForEmotion, shouldKeepCurrentBubble, speechTuning } from './personality'

describe('desktop pet personality', () => {
  it('maps lifecycle emotions to Live2D motion groups', () => {
    expect(motionForEmotion('thinking')).toBe('idle_think')
    expect(motionForEmotion('speaking')).toBe('talk')
    expect(motionForEmotion('happy')).toBe('happy')
  })
  it('makes lively speech faster and higher than a calm tone', () => {
    const lively = speechTuning('speaking', '活泼俏皮', 0.6)
    const calm = speechTuning('speaking', '温柔冷静', 0.6)
    expect(lively.rate).toBeGreaterThan(calm.rate)
    expect(lively.pitch).toBeGreaterThan(calm.pitch)
    expect(speechTuning('happy', '活泼', 1).volume).toBe(1)
  })
  it('does not replace a spoken answer with an early completion bubble', () => {
    expect(shouldKeepCurrentBubble({ type: 'task-complete' }, true)).toBe(true)
    expect(shouldKeepCurrentBubble({ type: 'task-complete' }, false)).toBe(false)
  })
})
