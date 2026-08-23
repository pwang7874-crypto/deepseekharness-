import { describe, expect, it } from 'vitest'
import { actionDuration, actionForEmotion, chooseAutonomousAction } from './pet-life'

describe('pet life state selection', () => {
  it('settles into sleep or a yawn late at night', () => {
    expect(chooseAutonomousAction({ hour: 2, inactiveMs: 60_000, connected: true }, 0.1)).toBe('sleep')
    expect(chooseAutonomousAction({ hour: 2, inactiveMs: 60_000, connected: true }, 0.9)).toBe('yawn')
  })

  it('uses calm micro-actions during daytime', () => {
    expect(chooseAutonomousAction({ hour: 12, inactiveMs: 10_000, connected: true }, 0)).toBe('tilt')
    expect(chooseAutonomousAction({ hour: 12, inactiveMs: 10_000, connected: true }, 0.3)).toBe('stretch')
  })

  it('gives every visible action a finite lifetime', () => {
    for (const action of ['tilt', 'stretch', 'wiggle', 'yawn', 'sleep', 'nuzzle', 'surprise', 'celebrate'] as const) {
      expect(actionDuration(action)).toBeGreaterThan(0)
      expect(actionDuration(action)).toBeLessThanOrEqual(6500)
    }
  })

  it('maps model emotions into a closed action vocabulary', () => {
    expect(actionForEmotion('thinking')).toBe('tilt')
    expect(actionForEmotion('speaking')).toBe('wiggle')
    expect(actionForEmotion('made-up')).toBe('idle')
  })
})
