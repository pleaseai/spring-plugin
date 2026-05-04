import { describe, expect, test } from 'bun:test'

import {
  clearOverride,
  getOverride,
  parseOverridesFile,
  projectKey,
  serializeOverrides,
  setOverride,
} from '../overrides.ts'

describe('projectKey', () => {
  test('returns deterministic sha256 hex digest', () => {
    const k = projectKey('/Users/alice/projects/demo')
    expect(k).toMatch(/^[0-9a-f]{64}$/)
    expect(projectKey('/Users/alice/projects/demo')).toBe(k)
  })

  test('different paths produce different keys', () => {
    expect(projectKey('/a')).not.toBe(projectKey('/b'))
  })
})

describe('parseOverridesFile', () => {
  test('returns empty object for empty input', () => {
    expect(parseOverridesFile('')).toEqual({})
    expect(parseOverridesFile('   ')).toEqual({})
  })

  test('returns empty object for malformed JSON (defensive — never throws)', () => {
    expect(parseOverridesFile('{not json}')).toEqual({})
  })

  test('parses a valid override store', () => {
    const json = `{
  "abc123": { "version": "3.2.0", "grantedAt": "2026-04-30T00:00:00.000Z" }
}`
    expect(parseOverridesFile(json)).toEqual({
      abc123: { version: '3.2.0', grantedAt: '2026-04-30T00:00:00.000Z' },
    })
  })

  test('rejects non-object JSON (returns empty)', () => {
    expect(parseOverridesFile('null')).toEqual({})
    expect(parseOverridesFile('[]')).toEqual({})
    expect(parseOverridesFile('"string"')).toEqual({})
  })
})

describe('setOverride / getOverride', () => {
  test('sets a fresh override and reads it back', () => {
    const store = setOverride({}, 'k1', '3.2.5', '2026-04-30T00:00:00.000Z')
    expect(getOverride(store, 'k1')).toEqual({
      version: '3.2.5',
      grantedAt: '2026-04-30T00:00:00.000Z',
    })
  })

  test('overrides existing entry on second set (refresh)', () => {
    let store = setOverride({}, 'k', '3.0.0', '2026-04-29T00:00:00.000Z')
    store = setOverride(store, 'k', '3.4.0', '2026-04-30T00:00:00.000Z')
    expect(getOverride(store, 'k')?.version).toBe('3.4.0')
  })

  test('returns undefined for unknown key', () => {
    expect(getOverride({}, 'nope')).toBeUndefined()
  })
})

describe('clearOverride', () => {
  test('removes the entry', () => {
    const store = setOverride({}, 'k', '3.2.5', '2026-04-30T00:00:00.000Z')
    expect(clearOverride(store, 'k')).toEqual({})
  })

  test('is a no-op when key not present', () => {
    const store = setOverride({}, 'a', '1.0.0', 'ts')
    expect(clearOverride(store, 'b')).toEqual(store)
  })
})

describe('serializeOverrides', () => {
  test('round-trips through parseOverridesFile', () => {
    const store = setOverride({}, 'k', '3.4.0', '2026-04-30T00:00:00.000Z')
    expect(parseOverridesFile(serializeOverrides(store))).toEqual(store)
  })

  test('emits trailing newline', () => {
    const out = serializeOverrides({})
    expect(out.endsWith('\n')).toBe(true)
  })
})
