export type PetAction = 'idle' | 'tilt' | 'stretch' | 'wiggle' | 'yawn' | 'sleep' | 'nuzzle' | 'surprise' | 'celebrate'

export type LifeContext = {
  hour: number
  inactiveMs: number
  connected: boolean
}

export function actionForEmotion(emotion: string): PetAction {
  if (emotion === 'happy') return 'celebrate'
  if (emotion === 'thinking') return 'tilt'
  if (emotion === 'speaking') return 'wiggle'
  if (emotion === 'listening') return 'surprise'
  if (emotion === 'gentle') return 'nuzzle'
  if (emotion === 'concerned' || emotion === 'error') return 'surprise'
  return 'idle'
}

const daytime: PetAction[] = ['tilt', 'stretch', 'wiggle', 'tilt', 'stretch']
const quiet: PetAction[] = ['yawn', 'stretch', 'tilt', 'sleep']

/** Pure and injectable so autonomous behavior remains predictable in tests. */
export function chooseAutonomousAction(context: LifeContext, random = Math.random()): PetAction {
  if ((context.hour >= 23 || context.hour < 6) && context.inactiveMs > 45_000) return random < 0.62 ? 'sleep' : 'yawn'
  const choices = context.inactiveMs > 90_000 ? quiet : daytime
  const index = Math.min(choices.length - 1, Math.floor(Math.max(0, Math.min(0.9999, random)) * choices.length))
  return choices[index]
}

export function actionDuration(action: PetAction) {
  switch (action) {
    case 'sleep': return 6500
    case 'stretch': return 1900
    case 'yawn': return 1800
    case 'celebrate': return 2200
    case 'nuzzle': return 1700
    case 'surprise': return 1200
    case 'wiggle': return 1500
    case 'tilt': return 1800
    default: return 0
  }
}
