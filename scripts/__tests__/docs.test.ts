import type { Fetcher } from '../docs.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveDocs } from '../docs.ts'
import { archiveName, archiveUrl, CATALOG_URL, checksumUrl, DOCS_CACHE_SUBDIR, docsCachePath } from '../lib/docs-cache.ts'

const PROJECT = 'boot'
const VERSION = '4.1.1'
const TAG = 'boot-4.1.1'

function catalogJson(tag: string): string {
  return JSON.stringify({
    version: '1',
    generated_at: '2026-09-12T00:00:00Z',
    projects: { boot: { [VERSION]: { tag, released_at: '2026-09-12T00:00:00Z' } } },
  })
}

/** Build a real `<project>-<version>/` archive, the shape the docs repo ships. */
function buildArchive(dir: string, topLevel: string, index = '# Table of contents\n'): Buffer {
  const tree = join(dir, topLevel)
  mkdirSync(join(tree, 'how-to'), { recursive: true })
  writeFileSync(join(tree, '_index.md'), index)
  writeFileSync(join(tree, 'how-to', 'index.md'), '# How-to\n')
  const archivePath = join(dir, `${topLevel}.tar.gz`)
  const result = Bun.spawnSync(['tar', '-czf', archivePath, '-C', dir, topLevel])
  if (result.exitCode !== 0)
    throw new Error(`tar failed: ${result.stderr.toString()}`)
  return Buffer.from(readFileSync(archivePath))
}

function respond(body: string | Buffer, ok = true, status = 200): Awaited<ReturnType<Fetcher>> {
  return {
    ok,
    status,
    text: async () => (typeof body === 'string' ? body : body.toString()),
    arrayBuffer: async () => {
      // Sliced to the view, not handed the whole backing store: a Buffer sits
      // in a pooled slab far larger than its payload, and `.buffer` would make
      // the caller hash the slab instead of the archive.
      const buf = typeof body === 'string' ? Buffer.from(body) : body
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    },
  }
}

describe('resolveDocs', () => {
  let cacheHome: string
  let fixtures: string

  beforeEach(() => {
    cacheHome = mkdtempSync(join(tmpdir(), 'spring-docs-home-'))
    fixtures = mkdtempSync(join(tmpdir(), 'spring-docs-fixtures-'))
  })

  afterEach(() => {
    rmSync(cacheHome, { recursive: true, force: true })
    rmSync(fixtures, { recursive: true, force: true })
  })

  test('downloads, verifies and unpacks a published version', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const digest = createHash('sha256').update(archive).digest('hex')
    const requested: string[] = []
    const fetchImpl: Fetcher = async (url) => {
      requested.push(url)
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      if (url === archiveUrl(TAG, PROJECT, VERSION))
        return respond(archive)
      throw new Error(`unexpected url ${url}`)
    }

    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready')
      return
    expect(result.tag).toBe(TAG)
    expect(result.cached).toBe(false)
    expect(result.path).toBe(docsCachePath(cacheHome, TAG))
    // The tree is unpacked without its `<project>-<version>/` wrapper, so the
    // path handed to callers is the documentation root itself.
    expect(readFileSync(result.index, 'utf8')).toContain('Table of contents')
    expect(existsSync(join(result.path, 'how-to', 'index.md'))).toBe(true)
    expect(requested).toContain(archiveUrl(TAG, PROJECT, VERSION))
  })

  test('serves a cached tree without downloading the archive again', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const digest = createHash('sha256').update(archive).digest('hex')
    const urls: string[] = []
    const fetchImpl: Fetcher = async (url) => {
      urls.push(url)
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      if (url === archiveUrl(TAG, PROJECT, VERSION))
        return respond(archive)
      throw new Error(`unexpected url ${url}`)
    }

    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    urls.length = 0
    const second = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(second.kind === 'ready' && second.cached).toBe(true)
    // The catalog is still consulted — it is what reports a rebuild — but the
    // archive and its checksum are not fetched again.
    expect(urls).toEqual([CATALOG_URL])
  })

  test('follows the catalog to a rebuild tag instead of reusing the cached tree', async () => {
    const first = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const firstDigest = createHash('sha256').update(first).digest('hex')
    const rebuiltDir = mkdtempSync(join(tmpdir(), 'spring-docs-rebuild-'))
    const rebuiltArchive = buildArchive(rebuiltDir, `${PROJECT}-${VERSION}`, '# Corrected\n')
    const rebuiltDigest = createHash('sha256').update(rebuiltArchive).digest('hex')

    const rebuildTag = `${TAG}+rebuild.1`
    let tag = TAG
    let digest = firstDigest
    let archive = first
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(tag))
      if (url === checksumUrl(tag, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      if (url === archiveUrl(tag, PROJECT, VERSION))
        return respond(archive)
      throw new Error(`unexpected url ${url}`)
    }

    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    tag = rebuildTag
    digest = rebuiltDigest
    archive = rebuiltArchive
    const second = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(second.kind === 'ready' && second.tag).toBe(rebuildTag)
    if (second.kind === 'ready')
      expect(readFileSync(second.index, 'utf8')).toContain('Corrected')
    rmSync(rebuiltDir, { recursive: true, force: true })
  })

  test('writes nothing when the archive does not match its checksum', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${'0'.repeat(64)}  ${archiveName(PROJECT, VERSION)}\n`)
      if (url === archiveUrl(TAG, PROJECT, VERSION))
        return respond(archive)
      throw new Error(`unexpected url ${url}`)
    }

    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable')
      expect(result.reason).toContain('checksum mismatch')
    expect(existsSync(docsCachePath(cacheHome, TAG))).toBe(false)
    // Not even a staging directory survives a rejected download.
    const docsRoot = join(cacheHome, DOCS_CACHE_SUBDIR)
    expect(existsSync(docsRoot) ? readdirSync(docsRoot) : []).toEqual([])
  })

  test('names the issue tracker when the catalog has no such version', async () => {
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      throw new Error(`unexpected url ${url}`)
    }

    const result = await resolveDocs({ project: PROJECT, version: '3.0.0', cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable') {
      expect(result.reason).toContain('has not published boot 3.0.0')
      expect(result.suggestion).toContain('issues')
    }
  })

  test('--no-fetch serves a previous resolution and never calls the network', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const digest = createHash('sha256').update(archive).digest('hex')
    const online: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl: online })

    const offline: Fetcher = async () => {
      throw new Error('network used')
    }
    const cached = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl: offline, noFetch: true })
    const missing = await resolveDocs({ project: PROJECT, version: '3.5.16', cacheHome, fetchImpl: offline, noFetch: true })

    expect(cached.kind === 'ready' && cached.cached).toBe(true)
    expect(missing.kind).toBe('unavailable')
    if (missing.kind === 'unavailable')
      expect(missing.suggestion).toContain('--no-fetch')
  })

  test('refuses a project or version that would escape the cache directory', async () => {
    const offline: Fetcher = async () => {
      throw new Error('network used')
    }
    const result = await resolveDocs({ project: PROJECT, version: '../../../../tmp/pwned', cacheHome, fetchImpl: offline })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable')
      expect(result.reason).toContain('may contain only')
  })

  test('ignores a pointer file that names a tag outside the cache', async () => {
    const pointer = `${docsCachePath(cacheHome, `${PROJECT}-${VERSION}`)}.tag`
    mkdirSync(join(pointer, '..'), { recursive: true })
    writeFileSync(pointer, '../../../../tmp\n')
    const offline: Fetcher = async () => {
      throw new Error('network used')
    }
    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl: offline, noFetch: true })

    expect(result.kind).toBe('unavailable')
  })

  test('refuses a catalog tag that would escape the cache directory', async () => {
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson('../../../../tmp/pwned'))
      throw new Error('network used')
    }
    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable')
      expect(result.reason).toContain('unusable tag')
  })

  test('reports a catalog whose shape it cannot read instead of throwing', async () => {
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond('{"version":"1"}')
      throw new Error('network used')
    }
    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable')
      expect(result.reason).toContain('expected shape')
  })

  test('refuses an archive that carries no table of contents', async () => {
    // Built without `_index.md`, with the checksum kept honest against it.
    rmSync(join(fixtures, `${PROJECT}-${VERSION}`), { recursive: true, force: true })
    const tree = join(fixtures, `${PROJECT}-${VERSION}`)
    mkdirSync(tree, { recursive: true })
    writeFileSync(join(tree, 'how-to.md'), '# How-to\n')
    const indexless = Bun.spawnSync(['tar', '-czf', join(fixtures, 'indexless.tar.gz'), '-C', fixtures, `${PROJECT}-${VERSION}`])
    if (indexless.exitCode !== 0)
      throw new Error('tar failed')
    const bytes = Buffer.from(readFileSync(join(fixtures, 'indexless.tar.gz')))
    const digest = createHash('sha256').update(bytes).digest('hex')
    expect(bytes.length).toBeGreaterThan(0)

    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(bytes)
    }
    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
    if (result.kind === 'unavailable')
      expect(result.reason).toContain('_index.md')
    expect(existsSync(docsCachePath(cacheHome, TAG))).toBe(false)
  })

  test('re-downloads over a cached tree that lost its table of contents', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`)
    const digest = createHash('sha256').update(archive).digest('hex')
    let archiveRequests = 0
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      archiveRequests += 1
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    // A tree left incomplete by an older client is not a cache hit.
    rmSync(join(docsCachePath(cacheHome, TAG), '_index.md'))

    const repaired = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(archiveRequests).toBe(2)
    expect(repaired.kind === 'ready' && repaired.cached).toBe(false)
    expect(existsSync(join(docsCachePath(cacheHome, TAG), '_index.md'))).toBe(true)
    expect(readdirSync(cacheHome).length).toBeGreaterThan(0)
  })

  test('replaces an existing tree without leaving the cache path missing', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    // --refresh publishes over a populated directory; renameSync refuses one
    // outright, so this is the case the swap exists for.
    const refreshed = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl, refresh: true })

    expect(refreshed.kind).toBe('ready')
    expect(readFileSync(join(docsCachePath(cacheHome, TAG), '_index.md'), 'utf8')).toBe('# First\n')
    // No staging or displaced directory survives the publication.
    const leftovers = readdirSync(join(cacheHome, '.cache/pleaseai-spring/docs')).filter(n => n.includes('.staging-') || n.includes('.replaced-'))
    expect(leftovers).toEqual([])
  })

  test('reclaims debris a killed run left behind, but not a run in flight', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    // A process killed between the two renames leaves its displaced tree named
    // after the target and never comes back for it; a live run's staging
    // directory is named the same way and still has an owner.
    const target = docsCachePath(cacheHome, TAG)
    const abandoned = `${target}.replaced-abandoned`
    const inFlight = `${target}.staging-live`
    mkdirSync(abandoned, { recursive: true })
    mkdirSync(inFlight, { recursive: true })
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(abandoned, longAgo, longAgo)

    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl, refresh: true })

    expect(existsSync(abandoned)).toBe(false)
    expect(existsSync(inFlight)).toBe(true)
  })

  test('reclaims debris on a cache hit, which never reaches a download', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    // A refresh that died while the previous tree stayed usable: every later
    // run is a cache hit, so a sweep that only ran while unpacking would never
    // reclaim this.
    const abandoned = `${docsCachePath(cacheHome, TAG)}.replaced-abandoned`
    mkdirSync(abandoned, { recursive: true })
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(abandoned, longAgo, longAgo)

    const hit = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(hit.kind === 'ready' && hit.cached).toBe(true)
    expect(existsSync(abandoned)).toBe(false)
  })

  test('reports unavailable rather than throwing when the cache path is unusable', async () => {
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      return respond('', false, 404)
    }
    // A file where the cache directory belongs: `readdirSync` throws ENOTDIR,
    // and the sweep runs before the function has produced any result at all.
    mkdirSync(join(cacheHome, DOCS_CACHE_SUBDIR, '..'), { recursive: true })
    writeFileSync(join(cacheHome, DOCS_CACHE_SUBDIR), 'not a directory\n')

    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('unavailable')
  })

  test('publishes through a link, so the cache path is never a gap', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }

    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    // `path` stays the tag directory callers already know. What changed is
    // that the entry is a link: replacing it is one atomic rename, so a reader
    // arriving mid-publication sees the old tree or the new one, never neither.
    expect(result.kind === 'ready' && result.path).toBe(docsCachePath(cacheHome, TAG))
    const target = docsCachePath(cacheHome, TAG)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    // Named for the digest of the bytes it holds, so the tree's provenance is
    // readable off the directory listing, and suffixed so the name belongs to
    // this publication alone rather than to everyone publishing these bytes.
    expect(readlinkSync(target)).toStartWith(`${TAG}.content-${digest.slice(0, 12)}-`)
    // And reading through it still resolves, which is the only thing the
    // indirection may not cost.
    expect(readFileSync(join(target, '_index.md'), 'utf8')).toBe('# First\n')
  })

  test('re-points the link on a refresh and reclaims the tree it superseded', async () => {
    const first = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const second = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# Second\n')
    let archive = first
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${createHash('sha256').update(archive).digest('hex')}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    const target = docsCachePath(cacheHome, TAG)
    const superseded = join(join(cacheHome, DOCS_CACHE_SUBDIR), readlinkSync(target))

    // Aged past the TTL *before* the swap, which is the case the sweep gets
    // wrong when it reads a content directory's extraction time: a tree that
    // has been serving all day is exactly the one a reader is most likely to be
    // inside when it is superseded.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(superseded, longAgo, longAgo)
    archive = second
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl, refresh: true })

    // Left in place at first: a reader that opened the old tree before the swap
    // is still inside it, and deleting it under them is the failure the
    // indirection exists to avoid. Its hour runs from the swap, not from the
    // extraction, so the next run does not reclaim it either.
    expect(readFileSync(join(target, '_index.md'), 'utf8')).toBe('# Second\n')
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    expect(existsSync(superseded)).toBe(true)

    utimesSync(superseded, longAgo, longAgo)
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    // Once no reader can plausibly still be in it, the sweep reclaims it like
    // any other leftover — and never the tree the link currently points at.
    expect(existsSync(superseded)).toBe(false)
    expect(readFileSync(join(target, '_index.md'), 'utf8')).toBe('# Second\n')
  })

  test('reclaims a leftover link by its own age, not its target\'s', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })
    const target = docsCachePath(cacheHome, TAG)

    // A staged link a publication was killed before moving into place. Its
    // target is the live tree, so ageing it through the link would read the
    // tree's mtime instead — and a link left dangling has no target to read at
    // all, which is how a leftover leaks forever rather than being reclaimed.
    const stale = `${target}.link-stale`
    const dangling = `${target}.link-dangling`
    symlinkSync(readlinkSync(target), stale)
    symlinkSync(`${TAG}.content-gone`, dangling)
    // `lutimes`, so the link's own times move and not the live tree's.
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    lutimesSync(stale, longAgo, longAgo)
    lutimesSync(dangling, longAgo, longAgo)

    const hit = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(hit.kind === 'ready' && hit.cached).toBe(true)
    expect(existsSync(join(target, '_index.md'))).toBe(true)
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    // Read off the directory listing, because `existsSync` follows a link and
    // answers false for a dangling one that is still very much an entry.
    expect(readdirSync(join(cacheHome, DOCS_CACHE_SUBDIR)).filter(n => n.includes('.link-'))).toEqual([])
  })

  test('converts a cache written before the indirection into a link', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      return respond(archive)
    }
    // The old layout: the tag path is the tree itself. `rename` will not put a
    // link over a populated directory, so this publication has to move it aside
    // rather than fail the download.
    const target = docsCachePath(cacheHome, TAG)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'stale.md'), 'from the old layout\n')

    const result = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(result.kind).toBe('ready')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(target, '_index.md'), 'utf8')).toBe('# First\n')
    expect(existsSync(join(target, 'stale.md'))).toBe(false)
  })

  test('does not report a tree ready when its index is not a regular file', async () => {
    const archive = buildArchive(fixtures, `${PROJECT}-${VERSION}`, '# First\n')
    const digest = createHash('sha256').update(archive).digest('hex')
    let archiveRequests = 0
    const fetchImpl: Fetcher = async (url) => {
      if (url === CATALOG_URL)
        return respond(catalogJson(TAG))
      if (url === checksumUrl(TAG, PROJECT, VERSION))
        return respond(`${digest}  ${archiveName(PROJECT, VERSION)}\n`)
      archiveRequests += 1
      return respond(archive)
    }
    await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    // A directory by that name exists just as much as a file does, and a tree
    // published on that answer is served as ready while nothing can read it.
    const index = join(docsCachePath(cacheHome, TAG), '_index.md')
    rmSync(index)
    mkdirSync(index)

    const repaired = await resolveDocs({ project: PROJECT, version: VERSION, cacheHome, fetchImpl })

    expect(archiveRequests).toBe(2)
    expect(repaired.kind === 'ready' && repaired.cached).toBe(false)
    expect(readFileSync(index, 'utf8')).toBe('# First\n')
  })
})
