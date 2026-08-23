import assert from 'node:assert/strict'
import test from 'node:test'

test('compiled plugin loads with the current DSH settings validator', async () => {
  const plugin = await import('../lib/index.js')
  assert.equal(plugin.name, 'dsh-pet-voice-v2')
})
