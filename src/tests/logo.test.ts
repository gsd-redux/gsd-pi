import test from 'node:test'
import assert from 'node:assert/strict'
import { GSD_PI_LOGO, GSD_PI_BRAND } from '../logo.ts'

test('GSD_PI_BRAND is GSD-Pi', () => {
  assert.equal(GSD_PI_BRAND, 'GSD-Pi')
})

test('GSD_PI_LOGO fits 80-column terminals', () => {
  for (const line of GSD_PI_LOGO) {
    assert.ok(line.length <= 80, `line too wide (${line.length}): ${line}`)
  }
})

test('GSD_PI_LOGO has six rows', () => {
  assert.equal(GSD_PI_LOGO.length, 6)
})
