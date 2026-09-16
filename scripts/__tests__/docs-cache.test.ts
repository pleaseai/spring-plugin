import { describe, expect, test } from 'bun:test'

import {
  archiveName,
  archiveUrl,
  checksumUrl,
  docsCachePath,
  isCatalog,
  isSafeSegment,
  lookupTag,
  parseChecksum,
  summarizeCatalog,
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

describe('isSafeSegment', () => {
  test('accepts the project, version and rebuild-tag spellings the catalog uses', () => {
    expect(isSafeSegment('boot')).toBe(true)
    expect(isSafeSegment('3.5.16')).toBe(true)
    expect(isSafeSegment('boot-4.1.1+rebuild.1')).toBe(true)
  })

  test('rejects the traversal segments a charset test alone would admit', () => {
    // Both are spelled entirely in allowed characters, and joining either one
    // climbs out of the cache directory.
    expect(isSafeSegment('..')).toBe(false)
    expect(isSafeSegment('.')).toBe(false)
  })

  test('rejects separators and the empty string', () => {
    expect(isSafeSegment('../../etc')).toBe(false)
    expect(isSafeSegment('a/b')).toBe(false)
    expect(isSafeSegment('a\\b')).toBe(false)
    expect(isSafeSegment('')).toBe(false)
  })
})

describe('lookupTag — unpublished entries', () => {
  test('reports a reserved tag with no archive as unpublished, not found', () => {
    const catalog = {
      version: '1',
      generated_at: null,
      projects: { boot: { '9.9.9': { tag: 'boot-9.9.9', released_at: null } } },
    }
    // Downloading from a reserved-but-empty tag 404s, which reads as an
    // unreachable network rather than as the "not built yet" it is.
    expect(lookupTag(catalog, 'boot', '9.9.9')).toEqual({
      kind: 'unpublished',
      project: 'boot',
      version: '9.9.9',
      tag: 'boot-9.9.9',
    })
  })
})

describe('isCatalog', () => {
  test('accepts a well-formed catalog', () => {
    expect(isCatalog(CATALOG)).toBe(true)
  })

  test('rejects valid JSON that lookupTag would throw on', () => {
    expect(isCatalog(null)).toBe(false)
    expect(isCatalog({ version: '1' })).toBe(false)
    expect(isCatalog({ version: 1, projects: {} })).toBe(false)
  })

  test('rejects an entry with no tag', () => {
    expect(isCatalog({ version: '1', projects: { boot: { '3.5.16': { released_at: null } } } })).toBe(false)
  })

  test('rejects an array where a keyed map is required', () => {
    expect(isCatalog({ version: '1', projects: [] })).toBe(false)
    expect(isCatalog({ version: '1', projects: { boot: [] } })).toBe(false)
  })

  test('rejects an entry whose released_at is neither a string nor null', () => {
    const entry = (released_at: unknown): unknown =>
      ({ version: '1', projects: { boot: { '3.5.16': { tag: 'boot-3.5.16', released_at } } } })
    expect(isCatalog(entry(null))).toBe(true)
    expect(isCatalog(entry('2026-09-12T00:00:00Z'))).toBe(true)
    // Absent, not null: `lookupTag` would hand callers `undefined` behind a
    // `string | null` type.
    expect(isCatalog({ version: '1', projects: { boot: { '3.5.16': { tag: 'boot-3.5.16' } } } })).toBe(false)
  })
})

describe('summarizeCatalog', () => {
  const MULTI = {
    version: '1',
    generated_at: '2026-09-15T13:47:09.470Z',
    projects: {
      framework: {
        '6.2.0': { tag: 'framework-6.2.0', released_at: '2026-01-01T00:00:00Z' },
      },
      boot: {
        '3.5.9': { tag: 'boot-3.5.9', released_at: '2026-05-01T00:00:00Z' },
        '3.5.10': { tag: 'boot-3.5.10', released_at: '2026-06-01T00:00:00Z' },
        '4.1.1': { tag: 'boot-4.1.1', released_at: null },
      },
    },
  }

  test('reports every project, with reserved tags kept out of the published list', () => {
    expect(summarizeCatalog(MULTI)).toEqual({
      kind: 'coverage',
      projects: [
        { project: 'boot', published: ['3.5.9', '3.5.10'], unpublished: ['4.1.1'] },
        { project: 'framework', published: ['6.2.0'], unpublished: [] },
      ],
    })
  })

  test('orders versions numerically, so 3.5.10 follows 3.5.9 instead of preceding it', () => {
    const summary = summarizeCatalog(MULTI, 'boot')
    expect(summary).toMatchObject({ kind: 'coverage' })
    expect(summary.kind === 'coverage' && summary.projects[0]?.published).toEqual(['3.5.9', '3.5.10'])
  })

  test('narrows to one project when asked', () => {
    expect(summarizeCatalog(MULTI, 'framework')).toEqual({
      kind: 'coverage',
      projects: [{ project: 'framework', published: ['6.2.0'], unpublished: [] }],
    })
  })

  test('names the known projects when the requested one is absent', () => {
    expect(summarizeCatalog(MULTI, 'security')).toEqual({
      kind: 'unknown-project',
      project: 'security',
      known: ['boot', 'framework'],
    })
  })

  test('orders a shorter version before the longer one it prefixes', () => {
    const catalog = {
      ...MULTI,
      projects: {
        boot: {
          '4.0': { tag: 'boot-4.0', released_at: '2026-01-01T00:00:00Z' },
          '4.0.8': { tag: 'boot-4.0.8', released_at: '2026-01-01T00:00:00Z' },
          '4': { tag: 'boot-4', released_at: '2026-01-01T00:00:00Z' },
        },
      },
    }
    const summary = summarizeCatalog(catalog, 'boot')
    expect(summary.kind === 'coverage' && summary.projects[0]?.published).toEqual(['4', '4.0', '4.0.8'])
  })

  test('keeps comparing past a numeric tie, so a leading zero cannot hide a later difference', () => {
    // '1.02.3' and '1.2.4' agree at the '02'/'2' chunk. Settling on that tie
    // reported two different versions as equal and left the rest of the list
    // in input order.
    const catalog = {
      ...MULTI,
      projects: {
        boot: {
          '1.2.4': { tag: 'boot-1.2.4', released_at: '2026-01-01T00:00:00Z' },
          '1.02.3': { tag: 'boot-1.02.3', released_at: '2026-01-01T00:00:00Z' },
          '1.2.1': { tag: 'boot-1.2.1', released_at: '2026-01-01T00:00:00Z' },
        },
      },
    }
    const summary = summarizeCatalog(catalog, 'boot')
    expect(summary.kind === 'coverage' && summary.projects[0]?.published).toEqual(['1.2.1', '1.02.3', '1.2.4'])
  })

  test('refuses a catalog schema it does not understand, as lookupTag does', () => {
    expect(summarizeCatalog({ ...MULTI, version: '2' })).toEqual({ kind: 'schema', found: '2' })
  })

  test('reports a project that publishes nothing as empty rather than absent', () => {
    expect(summarizeCatalog({ ...MULTI, projects: { boot: {} } })).toEqual({
      kind: 'coverage',
      projects: [{ project: 'boot', published: [], unpublished: [] }],
    })
  })
})
