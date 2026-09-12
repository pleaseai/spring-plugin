import { describe, expect, test } from 'bun:test'

import {
  archiveName,
  archiveUrl,
  checksumUrl,
  docsCachePath,
  lookupTag,
  parseChecksum,
} from '../lib/docs-cache.ts'

const CATALOG = {
  version: '1',
  generated_at: '2026-09-12T00:00:00Z',
  projects: {
    boot: {
      '3.5.16': { tag: 'boot-3.5.16', released_at: '2026-09-12T12:36:20Z' },
      '4.1.1': { tag: 'boot-4.1.1+rebuild.1', released_at: '2026-09-12T00:00:00Z' },
    },
  },
}

describe('lookupTag', () => {
  test('returns the tag the catalog records, rebuild suffix included', () => {
    expect(lookupTag(CATALOG, 'boot', '4.1.1')).toEqual({
      kind: 'found',
      tag: 'boot-4.1.1+rebuild.1',
      releasedAt: '2026-09-12T00:00:00Z',
    })
  })

  test('refuses a catalog schema it does not understand', () => {
    expect(lookupTag({ ...CATALOG, version: '2' }, 'boot', '3.5.16')).toEqual({ kind: 'schema', found: '2' })
  })

  test('names the known projects when the project is absent', () => {
    expect(lookupTag(CATALOG, 'framework', '6.2.0')).toEqual({
      kind: 'unknown-project',
      project: 'framework',
      known: ['boot'],
    })
  })

  test('reports an unpublished version separately from an unknown project', () => {
    const result = lookupTag(CATALOG, 'boot', '3.4.0')
    expect(result.kind).toBe('unknown-version')
  })
})

describe('asset naming', () => {
  test('an archive is named for the version, not for the tag that published it', () => {
    expect(archiveName('boot', '4.1.1')).toBe('boot-4.1.1.tar.gz')
    expect(archiveUrl('boot-4.1.1+rebuild.1', 'boot', '4.1.1'))
      .toBe('https://github.com/pleaseai/spring-docs/releases/download/boot-4.1.1+rebuild.1/boot-4.1.1.tar.gz')
    expect(checksumUrl('boot-4.1.1', 'boot', '4.1.1')).toEndWith('/boot-4.1.1.tar.gz.sha256')
  })

  test('the cache is keyed by tag, so a rebuild lands beside what it supersedes', () => {
    expect(docsCachePath('/home/u', 'boot-4.1.1'))
      .not
      .toBe(docsCachePath('/home/u', 'boot-4.1.1+rebuild.1'))
    expect(docsCachePath('/home/u', 'boot-4.1.1')).toBe('/home/u/.cache/pleaseai-spring/docs/boot-4.1.1')
  })
})

describe('parseChecksum', () => {
  const digest = 'a'.repeat(64)

  test('reads the digest from a sha256sum line', () => {
    expect(parseChecksum(`${digest}  boot-4.1.1.tar.gz\n`, 'boot-4.1.1.tar.gz')).toBe(digest)
  })

  test('accepts the binary-mode marker', () => {
    expect(parseChecksum(`${digest} *boot-4.1.1.tar.gz`, 'boot-4.1.1.tar.gz')).toBe(digest)
  })

  test('rejects a checksum that names a different archive', () => {
    expect(parseChecksum(`${digest}  boot-4.0.8.tar.gz`, 'boot-4.1.1.tar.gz')).toBeUndefined()
  })

  test('rejects malformed input', () => {
    expect(parseChecksum('', 'boot-4.1.1.tar.gz')).toBeUndefined()
    expect(parseChecksum('not-a-digest  boot-4.1.1.tar.gz', 'boot-4.1.1.tar.gz')).toBeUndefined()
  })
})
