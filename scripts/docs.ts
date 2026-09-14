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
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import {
  archiveName,
  archiveUrl,
  CATALOG_URL,
  checksumUrl,
  DOCS_REPO,
  docsCachePath,
  isCatalog,
  isSafeSegment,
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
  // A pointer names the directory this resolves to, so a corrupted or tampered
  // one must not be able to point outside the cache.
  if (!isSafeSegment(tag))
    return undefined
  return tag
}

function writePointer(cacheHome: string, project: string, version: string, tag: string): void {
  const path = pointerPath(cacheHome, project, version)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${tag}\n`)
}

/** The table of contents every published tree carries; its absence means the tree is unusable. */
const INDEX_FILE = '_index.md'

function ready(
  project: string,
  version: string,
  tag: string,
  path: string,
  cached: boolean,
): ReadyResult {
  return { kind: 'ready', project, version, tag, path, index: join(path, INDEX_FILE), cached }
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

/** True when `path` holds a documentation tree a caller can actually read from. */
function isUsableTree(path: string): boolean {
  try {
    // A regular file, not merely an entry: `existsSync` is equally true of a
    // directory named `_index.md`, and a tree published on that answer is
    // served as ready forever while no caller can read the index out of it.
    return statSync(join(path, INDEX_FILE)).isFile()
  }
  catch {
    return false
  }
}

/** Sibling directory holding the unpacked bytes of one archive, keyed by its digest. */
function contentName(target: string, digest: string): string {
  return `${basename(target)}.content-${digest.slice(0, 12)}`
}

/** True when `path` is itself a directory — not a symlink that resolves to one. */
function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  }
  catch {
    return false
  }
}

/**
 * Name of the content directory `target` currently points at.
 *
 * Reduced to a basename because {@link linkOnto} writes the link relative on
 * POSIX and absolute on Windows, and the caller compares it against directory
 * entries either way.
 *
 * @returns undefined when `target` is missing, or is a directory rather than a
 * link — both mean no content directory is live.
 */
function liveContent(target: string): string | undefined {
  try {
    return basename(readlinkSync(target))
  }
  catch {
    return undefined
  }
}

/**
 * Publish `extracted` at `target` without `target` ever being missing.
 *
 * The bytes land in a sibling directory named after their digest and `target`
 * becomes a symlink to it. Replacing a symlink is a single `rename`, which is
 * atomic: every reader sees either the old tree or the new one, never a gap.
 * Moving the tree itself into place could not offer that — `rename` will not
 * replace a populated directory, so the previous tree had to be moved aside
 * first, and between those two renames the path callers read did not exist.
 *
 * Keying on the digest also makes re-publication free when the bytes have not
 * changed, and leaves the superseded tree in place for readers that are still
 * inside it; {@link sweepLeftovers} reclaims it once nothing can be.
 */
function publish(extracted: string, target: string, digest: string): void {
  const name = contentName(target, digest)
  const content = join(dirname(target), name)

  if (!isUsableTree(content)) {
    // Not a duplicate — either new bytes, or a partial tree a killed run left
    // under this digest. Either way the extracted copy is the good one.
    discard(content)
    renameSync(extracted, content)
  }

  if (!linkOnto(target, name)) {
    // No symlink support (Windows outside Developer Mode, some filesystems).
    // Fall back to moving the tree itself into place, which reopens the window
    // this function exists to close — correctness over atomicity.
    swapOnto(content, target)
  }
}

/**
 * Replace `target` with a link to the sibling named `name`.
 *
 * Windows gets a junction, which needs neither Developer Mode nor elevation —
 * the directory symlink it would otherwise use needs one of the two, and the
 * cache would be unpublishable on an ordinary account. A junction resolves only
 * against an absolute path, so the link is written absolute there and relative
 * everywhere else, where a relative link keeps the cache tree movable.
 *
 * @returns false when the platform refuses to create a link at all, which is
 * the caller's signal to fall back.
 */
function linkOnto(target: string, name: string): boolean {
  const junction = process.platform === 'win32'
  const staged = `${target}.link-${randomUUID()}`
  try {
    symlinkSync(junction ? join(dirname(target), name) : name, staged, junction ? 'junction' : 'dir')
  }
  catch {
    return false
  }

  try {
    // A real directory here is the pre-indirection layout, or a fallback
    // publication. `rename` will not put a symlink over a directory, so that
    // one publication still moves the old tree aside; every later one is the
    // atomic symlink swap.
    const displaced = isDirectoryEntry(target) ? `${target}.replaced-${randomUUID()}` : undefined
    if (displaced !== undefined)
      renameSync(target, displaced)
    renameSync(staged, target)
    if (displaced !== undefined)
      discard(displaced)
    return true
  }
  catch (err) {
    discard(staged)
    throw err
  }
}

/**
 * Move `content` onto `target` itself, for platforms with no usable symlink.
 *
 * Swaps rather than clearing first: `renameSync` refuses a non-empty target
 * directory outright, so remove-then-rename lost a concurrent race with
 * ENOTEMPTY after a good download, and clearing first left the shared path
 * missing for as long as the delete took.
 */
function swapOnto(content: string, target: string): void {
  const displaced = existsSync(target) ? `${target}.replaced-${randomUUID()}` : undefined
  if (displaced !== undefined)
    renameSync(target, displaced)
  try {
    renameSync(content, target)
  }
  catch (err) {
    // Never end emptier than we started: put the previous tree back. Unless a
    // concurrent publisher already refilled the path — then its tree is the one
    // callers read, and ours is debris rather than a restore candidate.
    if (displaced !== undefined) {
      if (existsSync(target))
        discard(displaced)
      else
        renameSync(displaced, target)
    }
    throw err
  }
  // The new tree is published and readable from here on, so failing to delete
  // the one it replaced is leftover debris, not a failed download.
  if (displaced !== undefined)
    discard(displaced)
}

/** Delete a directory nothing reads from any more, without failing the caller. */
function discard(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  }
  catch {
    // Left for `sweepLeftovers` on a later run.
  }
}

/** How long a leftover directory may sit before it counts as debris. */
const LEFTOVER_TTL_MS = 60 * 60 * 1000

/** Name fragments marking a directory beside `target` as this module's own leftover. */
const LEFTOVER_MARKERS = ['.staging-', '.replaced-', '.link-', '.content-'] as const

/**
 * Delete the staging and displaced directories a killed run left behind.
 *
 * Both are named after `target` and both are removed on every path that
 * completes, so whatever is still here belongs either to a run in flight or to
 * one that died mid-publication. Age separates them: downloading and extracting
 * an archive takes seconds, so an hour-old directory has no owner left to
 * break. Without this a crash leaks one whole documentation tree per occurrence
 * and nothing ever reclaims it.
 */
function sweepLeftovers(target: string): void {
  const parent = dirname(target)
  const prefix = basename(target)
  const live = liveContent(target)
  const cutoff = Date.now() - LEFTOVER_TTL_MS
  let entries: string[]
  try {
    entries = readdirSync(parent)
  }
  catch {
    // The cache directory does not exist yet on a first run, and it can also
    // be a file, be unreadable, or vanish under us. None of that is a reason
    // to reject a resolution that has its own answer for a broken cache — and
    // an `existsSync` guard would still lose the race to a concurrent delete.
    return
  }
  for (const name of entries) {
    if (!LEFTOVER_MARKERS.some(marker => name.startsWith(`${prefix}${marker}`)))
      continue
    // The tree `target` currently points at is not debris, however old it is:
    // a cache that is never refreshed would otherwise delete itself an hour
    // after it was filled.
    if (name === live)
      continue
    const path = join(parent, name)
    try {
      if (statSync(path).mtimeMs < cutoff)
        rmSync(path, { recursive: true, force: true })
    }
    catch {
      // Reclaiming disk is never worth failing a download over.
    }
  }
}

/**
 * Unpack `archive` and publish the single top-level directory it holds at
 * `target`, keyed by `digest` — the verified checksum of these exact bytes.
 */
function unpack(archive: Buffer, project: string, version: string, target: string, digest: string): void {
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
    // Checked before publication, not after: a correctly checksummed but
    // mispackaged archive would otherwise be cached as ready with an index
    // path that does not resolve.
    if (!isUsableTree(extracted))
      throw new Error(`archive does not contain ${project}-${version}/${INDEX_FILE}`)

    publish(extracted, target, digest)
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

  // Both are joined into cache paths and into the archive URL, so they are
  // checked here, at the boundary, rather than at each use.
  if (!isSafeSegment(project) || !isSafeSegment(version)) {
    return unavailable(
      project,
      version,
      'project and version may contain only letters, digits, dot, plus, hyphen and underscore',
    )
  }

  if (noFetch) {
    const tag = readPointer(cacheHome, project, version)
    const path = tag === undefined ? undefined : docsCachePath(cacheHome, tag)
    if (tag === undefined || path === undefined || !isUsableTree(path)) {
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

  let parsed: unknown
  try {
    parsed = JSON.parse(catalogText)
  }
  catch (err) {
    return unavailable(project, version, `catalog.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!isCatalog(parsed))
    return unavailable(project, version, 'catalog.json does not have the expected shape', 'update the plugin')
  const catalog: Catalog = parsed

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
    case 'unpublished':
      return unavailable(
        project,
        version,
        `${DOCS_REPO} reserved ${lookup.tag} for ${project} ${version} but has published no archive under it`,
        `open an issue at https://github.com/${DOCS_REPO}/issues to have it built`,
      )
  }

  const { tag } = lookup
  if (!isSafeSegment(tag)) {
    return unavailable(
      project,
      version,
      `catalog.json maps ${project} ${version} to an unusable tag "${tag}"`,
      `report it at https://github.com/${DOCS_REPO}/issues`,
    )
  }

  const target = docsCachePath(cacheHome, tag)
  // Before the cache-hit return, not inside `unpack`: a refresh that died
  // while the previous tree was still usable leaves debris that every later
  // run then skips past, because those runs never reach the download.
  sweepLeftovers(target)
  // An incomplete tree falls through to a re-download rather than failing:
  // repairing it is exactly what this function is for.
  if (isUsableTree(target) && !refresh) {
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
    unpack(archive, project, version, target, actual)
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
