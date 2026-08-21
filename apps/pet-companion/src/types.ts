import type { Emotion } from './personality'
export type PetEvent = { type: 'state' | 'task-complete' | 'task-error'; emotion: Emotion; text?: string; intensity?: number; at: number }
