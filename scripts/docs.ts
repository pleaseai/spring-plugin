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
 *   node scripts/docs.ts --list [project]
 *
 * Exit codes:
 *   0 — docs are on disk (`path` says where), or coverage was listed
 *   1 — that version is not published, or the catalog could not be fetched
 *   2 — bad arguments, or an unexpected internal error
 */

import type { Catalog, ProjectCoverage } from './lib/docs-cache.ts'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
  summarizeCatalog,
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

/** A catalog could not be obtained; the wording callers report verbatim. */
interface CatalogFailure {
  reason: string
  suggestion?: string
}

/**
 * Fetch and validate `catalog.json`.
 *
 * Shared by resolution and coverage listing so the two can never disagree about
 * what the catalog says — the listing exists precisely to answer "what would a
 * resolution find", and a second copy of this parse is a second chance to drift.
 */
async function fetchCatalog(fetchImpl: Fetcher): Promise<Catalog | CatalogFailure> {
  const text = await fetchText(fetchImpl, CATALOG_URL)
  if (typeof text !== 'string')
    return { reason: text.error, suggestion: 'check network access to raw.githubusercontent.com' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (err) {
    return { reason: `catalog.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!isCatalog(parsed))
    return { reason: 'catalog.json does not have the expected shape', suggestion: 'update the plugin' }
  return parsed
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

/**
 * Name for the sibling directory holding one publication's unpacked bytes.
 *
 * The digest is provenance — it says which archive the tree came from — and the
 * random suffix is what makes the name this publication's alone. A name derived
 * from the digest only would be shared by every publisher of those bytes, and
 * two of them racing would each see it unusable, so the slower one would delete
 * the tree the faster one had already published and linked.
 */
function contentName(target: string, digest: string): string {
  return `${basename(target)}.content-${digest.slice(0, 12)}-${randomUUID()}`
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
 * True when anything at all occupies `path`.
 *
 * `lstat`, not `existsSync`: a link whose target is gone is still an entry
 * `rename` has to contend with, and `existsSync` follows the link and answers
 * that nothing is there.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
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
 * How a publication's attempt to put its link in place ended.
 *
 * `contended` and `unsupported` both mean "no link yet" but call for opposite
 * responses: losing a race is worth another attempt, and a platform that cannot
 * create the link at all fails identically however many times it is asked.
 */
type LinkOutcome = 'linked' | 'contended' | 'unsupported'

/**
 * How many times a publication re-attempts a *contended* link.
 *
 * Bounded rather than "until it succeeds": a rename can also fail for reasons no
 * number of attempts fixes — a permission change, a filesystem going read-only —
 * and an unbounded loop turns those into a hang instead of a fallback. Several
 * attempts is already far more contention than a documentation cache sees, and
 * the fallback below still publishes correctly when they run out.
 */
const LINK_ATTEMPTS = 5

/**
 * Publish `extracted` at `target` without `target` ever being missing.
 *
 * The bytes land in a sibling directory of their own and `target` becomes a
 * link to it. Replacing a link is a single `rename`, which is atomic: every
 * reader sees either the old tree or the new one, never a gap. Moving the tree
 * itself into place could not offer that — `rename` will not replace a
 * populated directory, so the previous tree had to be moved aside first, and
 * between those two renames the path callers read did not exist.
 *
 * The tree this supersedes is left where it is, because a reader that opened it
 * a moment before the swap is still inside it; {@link sweepLeftovers} reclaims
 * it once nothing can be.
 */
function publish(extracted: string, target: string, digest: string): void {
  const name = contentName(target, digest)
  const content = join(dirname(target), name)
  const superseded = liveContent(target)
  renameSync(extracted, content)

  // Before the swap, not after: between the two, a concurrent sweep still reads
  // the tree's extraction time, and an aged one is exactly what it deletes —
  // out from under the readers this grace period exists for. Stamping it early
  // costs nothing if the publication then fails, because the sweep never
  // reclaims whatever the link currently points at.
  if (superseded !== undefined && superseded !== name)
    retire(join(dirname(target), superseded))

  // Re-attempted only while the link is losing a race. On Windows every
  // publication moves the old entry aside, so concurrent refreshes overlap on a
  // window rather than on an instant, and a loser that gave up would replace the
  // winner's junction with a plain directory. A platform that cannot create the
  // link at all reports that instead, and is not asked again.
  let outcome: LinkOutcome = 'contended'
  for (let attempt = 0; attempt < LINK_ATTEMPTS && outcome === 'contended'; attempt++)
    outcome = linkOnto(target, name)

  // Fall back to moving the tree itself, which reopens the window this function
  // exists to close — correctness over atomicity.
  if (outcome !== 'linked')
    swapOnto(content, target)
}

/**
 * Mark a superseded tree as retired, as of now.
 *
 * The sweep ages a leftover by its mtime, and a published tree's mtime is when
 * it was extracted. Without this, a tree that had been serving for longer than
 * the TTL would be reclaimed by the very next run — so a reader that entered it
 * just before the swap would get none of the grace period the swap exists to
 * give them.
 */
function retire(path: string): void {
  const now = new Date()
  try {
    // `lutimes`, to stamp the entry rather than whatever it points at — the
    // same side of the link the sweep reads it back from. `swapOnto` can hand
    // this a link rather than a tree, and following it would age the tree the
    // old link pointed at while leaving the entry the sweep actually sees
    // untouched.
    lutimesSync(path, now, now)
  }
  catch {
    // Only costs the superseded tree its grace period; never the publication.
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
 * @returns how the attempt ended. Never throws and never ends with `target`
 * emptier than it found it: a failure here still has to leave a usable cache
 * behind.
 */
function linkOnto(target: string, name: string): LinkOutcome {
  const junction = process.platform === 'win32'
  const staged = `${target}.link-${randomUUID()}`
  try {
    symlinkSync(junction ? join(dirname(target), name) : name, staged, junction ? 'junction' : 'dir')
  }
  catch {
    // No link of either kind can be created here; asking again cannot change
    // that, and the caller's fallback is the only way to publish at all.
    return 'unsupported'
  }

  // One rename is the whole point, and two cases cannot have it. A populated
  // directory at `target` — the layout this cache had before the indirection,
  // and what the fallback writes — is something `rename` refuses to replace
  // anywhere. And on Windows `rename` cannot replace *any* directory, which a
  // junction is, so every publication there moves the old entry aside first and
  // publishes through a window two metadata operations wide.
  let displaced: string | undefined
  try {
    if (junction ? entryExists(target) : isDirectoryEntry(target)) {
      displaced = `${target}.replaced-${randomUUID()}`
      renameSync(target, displaced)
      // Retired the moment it is moved aside, not once the link lands: until it
      // is stamped it still carries the mtime it was published with, which on a
      // tree that had been serving for days is already past the cutoff — and a
      // concurrent sweep would take it out from under its readers right here.
      retire(displaced)
    }
    renameSync(staged, target)
  }
  catch {
    // Put the previous tree back — unless a concurrent publisher already
    // refilled the path, in which case its tree is the one callers read.
    if (displaced !== undefined && !entryExists(target)) {
      try {
        renameSync(displaced, target)
      }
      catch {
        // Left for the caller's fallback, which publishes into the gap.
      }
    }
    discard(staged)
    // Someone else holds the path, or the filesystem refused the move. Either
    // way another attempt is worth making before falling back.
    return 'contended'
  }

  // `displaced` is left where it is — a whole documentation tree with readers
  // possibly still inside it, already retired above, and reclaimed by the sweep
  // once its grace period is up.
  return 'linked'
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
  // `entryExists`, not `existsSync`: after a link publication `target` can be a
  // link whose tree is already gone, and `existsSync` follows it and answers
  // that the path is free — then `rename` fails on the entry that is still
  // there.
  const displaced = entryExists(target) ? `${target}.replaced-${randomUUID()}` : undefined
  if (displaced !== undefined) {
    renameSync(target, displaced)
    // Stamped here rather than after the swap, for the same reason as in
    // `linkOnto`: until it is, an old tree is already past the sweep's cutoff.
    retire(displaced)
  }
  try {
    renameSync(content, target)
  }
  catch (err) {
    // Never end emptier than we started: put the previous tree back. Unless a
    // concurrent publisher already refilled the path — then its tree is the one
    // callers read, and ours is debris rather than a restore candidate.
    // Already retired above, so leaving it is enough when the path is taken.
    if (displaced !== undefined && !entryExists(target))
      renameSync(displaced, target)
    throw err
  }
  // `displaced` stays where it is: retired rather than deleted, like every other
  // superseded tree, so a reader that entered it before the swap keeps it for
  // its grace period.
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
      // `lstat`, not `stat`: a staged link resolves to a content directory that
      // is usually older than the link itself, so following it would age a link
      // created moments ago by the tree it points at and delete it out from
      // under the publication in flight. A link whose target is already gone
      // would not be aged at all — `stat` throws, and the leftover leaks.
      if (lstatSync(path).mtimeMs < cutoff)
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
  const fetched = await fetchCatalog(fetchImpl)
  if (!('projects' in fetched))
    return unavailable(project, version, fetched.reason, fetched.suggestion)
  const catalog: Catalog = fetched

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

export interface ListOptions {
  /** Limit the report to one project; omitted, every project is listed. */
  project?: string
  fetchImpl?: Fetcher
}

export interface CoverageResult {
  kind: 'coverage'
  /** When the docs repository last regenerated the catalog. */
  generatedAt: string | null
  projects: ProjectCoverage[]
}

export type ListResult
  = | CoverageResult
    | { kind: 'unavailable', reason: string, suggestion?: string }

/**
 * Report which projects and versions `pleaseai/spring-docs` publishes.
 *
 * This is the skill's coverage answer. It is a live catalog read rather than a
 * list maintained in `SKILL.md`, because the docs repository publishes on its
 * own schedule: anything written down here is a claim about another repository
 * that was true when it was typed, and versions published afterwards become
 * invisible to the agent rather than merely undocumented.
 */
export async function listDocs(options: ListOptions = {}): Promise<ListResult> {
  const fetchImpl = options.fetchImpl ?? ((url: string) => fetch(url))
  const { project } = options

  const fetched = await fetchCatalog(fetchImpl)
  if (!('projects' in fetched))
    return { kind: 'unavailable', ...fetched }

  const summary = summarizeCatalog(fetched, project)
  switch (summary.kind) {
    case 'schema':
      return {
        kind: 'unavailable',
        reason: `catalog.json is schema version ${summary.found}, this plugin understands 1`,
        suggestion: 'update the plugin',
      }
    case 'unknown-project':
      return {
        kind: 'unavailable',
        reason: `${DOCS_REPO} publishes no project "${summary.project}"`,
        suggestion: `known projects: ${summary.known.join(', ') || 'none'}`,
      }
  }

  return { kind: 'coverage', generatedAt: fetched.generated_at, projects: summary.projects }
}

// ------------------------------ CLI -----------------------------------------

const USAGE = [
  'usage: bun run scripts/docs.ts <project> <version> [--refresh] [--no-fetch]',
  '       bun run scripts/docs.ts --list [project]',
].join('\n')

export type ParsedArgs
  = | { mode: 'resolve', project: string, version: string, refresh: boolean, noFetch: boolean }
    | { mode: 'list', project?: string }

export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const positional: string[] = []
  let refresh = false
  let noFetch = false
  let list = false
  for (const arg of argv) {
    if (arg === '--refresh')
      refresh = true
    else if (arg === '--no-fetch')
      noFetch = true
    else if (arg === '--list')
      list = true
    else if (arg.startsWith('--'))
      return { error: `unknown argument: ${arg}` }
    else positional.push(arg)
  }

  return list
    ? parseList(positional, refresh || noFetch)
    : parseResolve(positional, refresh, noFetch)
}

function parseList(positional: string[], cacheFlags: boolean): ParsedArgs | { error: string } {
  // Neither flag has anything to act on: the catalog is read fresh every time
  // and never cached, so accepting them would promise behaviour that does not
  // exist.
  if (cacheFlags)
    return { error: '--list takes no --refresh or --no-fetch' }
  const [project, ...extra] = positional
  if (extra.length > 0)
    return { error: `unexpected argument: ${extra[0]}` }
  return project === undefined ? { mode: 'list' } : { mode: 'list', project }
}

function parseResolve(positional: string[], refresh: boolean, noFetch: boolean): ParsedArgs | { error: string } {
  const [project, version, ...extra] = positional
  if (!project)
    return { error: 'missing <project>' }
  if (!version)
    return { error: 'missing <version>' }
  if (extra.length > 0)
    return { error: `unexpected argument: ${extra[0]}` }
  return { mode: 'resolve', project, version, refresh, noFetch }
}

async function cli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`)
    return 2
  }

  let result: ResolveResult | ListResult
  try {
    result = parsed.mode === 'list' ? await listDocs(parsed) : await resolveDocs(parsed)
  }
  catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    return 2
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.kind === 'unavailable' ? 1 : 0
}

if (import.meta.main) {
  const code = await cli(process.argv.slice(2))
  process.exit(code)
}
