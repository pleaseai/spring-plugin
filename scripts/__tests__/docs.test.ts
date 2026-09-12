import type { Fetcher } from '../docs.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { resolveDocs } from '../docs.ts'
import { archiveName, archiveUrl, CATALOG_URL, checksumUrl, docsCachePath } from '../lib/docs-cache.ts'

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
    arrayBuffer: async () => (typeof body === 'string' ? Buffer.from(body) : body).buffer as ArrayBuffer,
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
    const docsRoot = join(cacheHome, '.cache', 'pleaseai-spring', 'docs')
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
})
