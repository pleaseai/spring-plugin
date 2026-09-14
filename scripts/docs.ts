#!/usr/bin/env bun
/**
 * Documentation resolution — Domain Layer (orchestrator + CLI).
 *
 * Turns a `(project, version)` pair into a filesystem path holding the
 * converted Spring documentation for exactly that version, downloading the
 * published archive from `pleaseai/spring-docs` on a cache miss.
 *
 * Nothing is written into the user's project. The docs live in a shared cache
 * and callers are handed a path, so a project carries no documentation files,
 * `CLAUDE.md` is never rewritten, and two projects on the same Spring version
 * share one copy. The pure helpers live in `scripts/lib/docs-cache.ts`; this
 * module owns the network and filesystem boundary.
 *
 * Usage:
 *   node scripts/docs.ts boot 4.1.1 [--refresh] [--no-fetch]
 *
 * Exit codes:
 *   0 — docs are on disk; `path` in the JSON output says where
 *   1 — that version is not published, or it could not be fetched
 *   2 — bad arguments, or an unexpected internal error
 */

import type { Catalog } from './lib/docs-cache.ts'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import {
  archiveName,
  archiveUrl,
  CATALOG_URL,
  checksumUrl,
  DOCS_REPO,
  docsCachePath,
  lookupTag,
  parseChecksum,
} from './lib/docs-cache.ts'

/** Test-only override for the cache home directory, as in `detect.ts`. */
const CACHE_HOME_ENV_OVERRIDE = 'PLEASEAI_SPRING_CACHE_HOME'

/** The slice of `fetch` this module uses — narrow enough for a test to supply. */
export type Fetcher = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  text: () => Promise<string>
  arrayBuffer: () => Promise<ArrayBuffer>
}>

export interface ResolveOptions {
  project: string
  version: string
  /** Directory the `.cache/pleaseai-spring/docs` tree hangs off. */
  cacheHome?: string
  fetchImpl?: Fetcher
  /** Re-download even when the tree is already cached. */
  refresh?: boolean
  /** Never touch the network: serve a previous resolution or fail. */
  noFetch?: boolean
}

export interface ReadyResult {
  kind: 'ready'
  project: string
  version: string
  tag: string
  /** Absolute path of the unpacked documentation tree. */
  path: string
  /** Table of contents inside {@link path}. */
  index: string
  /** True when this run downloaded nothing. */
  cached: boolean
}

export interface UnavailableResult {
  kind: 'unavailable'
  project: string
  version: string
  reason: string
  suggestion?: string
}

export type ResolveResult = ReadyResult | UnavailableResult

function cacheHomeOf(explicit: string | undefined): string {
  return explicit ?? process.env[CACHE_HOME_ENV_OVERRIDE] ?? homedir()
}

/**
 * Records which tag a version resolved to, so `--no-fetch` can find the tree
 * without asking the catalog again. A rebuild moves the version to a new tag,
 * so the pointer is rewritten on every successful online resolution.
 */
function pointerPath(cacheHome: string, project: string, version: string): string {
  return `${docsCachePath(cacheHome, `${project}-${version}`)}.tag`
}

function readPointer(cacheHome: string, project: string, version: string): string | undefined {
  const path = pointerPath(cacheHome, project, version)
  if (!existsSync(path))
    return undefined
  const tag = readFileSync(path, 'utf8').trim()
  return tag === '' ? undefined : tag
}

function writePointer(cacheHome: string, project: string, version: string, tag: string): void {
  const path = pointerPath(cacheHome, project, version)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${tag}\n`)
}

function ready(
  project: string,
  version: string,
  tag: string,
  path: string,
  cached: boolean,
): ReadyResult {
  return { kind: 'ready', project, version, tag, path, index: join(path, '_index.md'), cached }
}

function unavailable(
  project: string,
  version: string,
  reason: string,
  suggestion?: string,
): UnavailableResult {
  return suggestion === undefined
    ? { kind: 'unavailable', project, version, reason }
    : { kind: 'unavailable', project, version, reason, suggestion }
}

/** Fetch one URL as text, turning any transport failure into a message. */
async function fetchText(fetchImpl: Fetcher, url: string): Promise<string | { error: string }> {
  try {
    const response = await fetchImpl(url)
    if (!response.ok)
      return { error: `GET ${url} → ${response.status}` }
    return await response.text()
  }
  catch (err) {
    return { error: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Unpack `archive` and move the single top-level directory it holds to `target`. */
function unpack(archive: Buffer, project: string, version: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true })
  // Staged next to the target so the rename below stays on one filesystem, and
  // so a crash mid-extraction never leaves a half-written tree under the name
  // callers read from.
  const staging = mkdtempSync(`${target}.staging-`)
  try {
    const archivePath = join(staging, archiveName(project, version))
    writeFileSync(archivePath, archive)
    const result = spawnSync('tar', ['-xzf', archivePath, '-C', staging], { encoding: 'utf8' })
    if (result.error)
      throw new Error(`could not run tar: ${result.error.message}`)
    if (result.status !== 0)
      throw new Error(`tar exited ${result.status}: ${(result.stderr ?? '').trim()}`)

    // Every archive entry sits under one `<project>-<version>/` directory, so
    // extraction never spills — that is the docs repo's packaging contract.
    const extracted = join(staging, `${project}-${version}`)
    if (!existsSync(extracted))
      throw new Error(`archive does not contain ${project}-${version}/`)

    if (existsSync(target))
      rmSync(target, { recursive: true, force: true })
    renameSync(extracted, target)
  }
  finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Resolve `(project, version)` to an unpacked documentation tree on disk.
 *
 * Never throws for a recognized failure — an unpublished version, an
 * unreachable network and a corrupt download all come back as
 * {@link UnavailableResult}.
 */
export async function resolveDocs(options: ResolveOptions): Promise<ResolveResult> {
  const { project, version, refresh = false, noFetch = false } = options
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url))
  const cacheHome = cacheHomeOf(options.cacheHome)

  if (noFetch) {
    const tag = readPointer(cacheHome, project, version)
    const path = tag === undefined ? undefined : docsCachePath(cacheHome, tag)
    if (tag === undefined || path === undefined || !existsSync(path)) {
      return unavailable(
        project,
        version,
        `${project} ${version} is not in the local cache`,
        'drop --no-fetch to download it',
      )
    }
    return ready(project, version, tag, path, true)
  }

  // The catalog is consulted even on a cache hit: it is a few kilobytes, and it
  // is the only thing that reports a rebuild having moved this version to a new
  // tag. Only the archive download — the expensive half — is skipped.
  const catalogText = await fetchText(fetchImpl, CATALOG_URL)
  if (typeof catalogText !== 'string')
    return unavailable(project, version, catalogText.error, 'check network access to raw.githubusercontent.com')

  let catalog: Catalog
  try {
    catalog = JSON.parse(catalogText) as Catalog
  }
  catch (err) {
    return unavailable(project, version, `catalog.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const lookup = lookupTag(catalog, project, version)
  switch (lookup.kind) {
    case 'schema':
      return unavailable(
        project,
        version,
        `catalog.json is schema version ${lookup.found}, this plugin understands 1`,
        'update the plugin',
      )
    case 'unknown-project':
      return unavailable(
        project,
        version,
        `${DOCS_REPO} publishes no project "${project}"`,
        `known projects: ${lookup.known.join(', ') || 'none'}`,
      )
    case 'unknown-version':
      return unavailable(
        project,
        version,
        `${DOCS_REPO} has not published ${project} ${version}`,
        `open an issue at https://github.com/${DOCS_REPO}/issues to have it built`,
      )
  }

  const { tag } = lookup
  const target = docsCachePath(cacheHome, tag)
  if (existsSync(target) && !refresh) {
    writePointer(cacheHome, project, version, tag)
    return ready(project, version, tag, target, true)
  }

  const checksumText = await fetchText(fetchImpl, checksumUrl(tag, project, version))
  if (typeof checksumText !== 'string')
    return unavailable(project, version, checksumText.error)

  const expected = parseChecksum(checksumText, archiveName(project, version))
  if (expected === undefined) {
    return unavailable(
      project,
      version,
      `the checksum published for ${tag} does not describe ${archiveName(project, version)}`,
    )
  }

  let archive: Buffer
  try {
    const response = await fetchImpl(archiveUrl(tag, project, version))
    if (!response.ok)
      return unavailable(project, version, `GET ${archiveUrl(tag, project, version)} → ${response.status}`)
    archive = Buffer.from(await response.arrayBuffer())
  }
  catch (err) {
    return unavailable(project, version, `downloading ${tag} failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    return unavailable(
      project,
      version,
      `checksum mismatch for ${tag}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
      'nothing was written to the cache; retry, and report it if it persists',
    )
  }

  try {
    unpack(archive, project, version, target)
  }
  catch (err) {
    return unavailable(project, version, `unpacking ${tag} failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  writePointer(cacheHome, project, version, tag)
  return ready(project, version, tag, target, false)
}

// ------------------------------ CLI -----------------------------------------

const USAGE = 'usage: bun run scripts/docs.ts <project> <version> [--refresh] [--no-fetch]'

interface ParsedArgs {
  project: string
  version: string
  refresh: boolean
  noFetch: boolean
}

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const positional: string[] = []
  let refresh = false
  let noFetch = false
  for (const arg of argv) {
    if (arg === '--refresh')
      refresh = true
    else if (arg === '--no-fetch')
      noFetch = true
    else if (arg.startsWith('--'))
      return { error: `unknown argument: ${arg}` }
    else positional.push(arg)
  }
  const [project, version, ...extra] = positional
  if (!project)
    return { error: 'missing <project>' }
  if (!version)
    return { error: 'missing <version>' }
  if (extra.length > 0)
    return { error: `unexpected argument: ${extra[0]}` }
  return { project, version, refresh, noFetch }
}

async function cli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`)
    return 2
  }

  let result: ResolveResult
  try {
    result = await resolveDocs(parsed)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    return 2
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.kind === 'ready' ? 0 : 1
}

if (import.meta.main) {
  const code = await cli(process.argv.slice(2))
  process.exit(code)
}
