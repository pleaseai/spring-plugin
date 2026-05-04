/**
 * Pure helpers for FR-16 — Gradle published version catalog discovery.
 * Library Layer: no I/O.
 *
 * The orchestrator handles file reads and TOML parsing (it reuses the
 * `[versions]` reader from {@link ./detect-gradle-catalog.ts}). This module:
 *
 * - extracts `versionCatalogs.create(...) { from("g:a:v") }` declarations from
 *   `settings.gradle(.kts)` (so the orchestrator knows which artifact to look up),
 * - composes candidate cache paths under the standard local Maven and Gradle
 *   layouts plus our plugin-owned cache directory.
 *
 * Network fetching is **not** implemented in this track — `scripts/resolve.ts`
 * (a downstream track) owns the single network boundary. T015 implements the
 * cache-first fallback up to the network boundary; on full cache miss the
 * orchestrator returns `kind:'unsupported'` so the user can populate the cache
 * by running their build once or pass `--boot`.
 */

import { join } from 'node:path'

const FROM_CALL_RE = /from\s*\(\s*['"]([^:'"]+):([^:'"]+):([^'"]+)['"]\s*\)/
const CREATE_CALL_RE = /create\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const VERSION_CATALOGS_KEYWORD = 'versionCatalogs'

const SPACE = 32
const TAB = 9
const NEWLINE = 10
const CR = 13

function isAsciiWhitespace(charCode: number): boolean {
  return charCode === SPACE || charCode === TAB || charCode === NEWLINE || charCode === CR
}

export interface PublishedCatalogRef {
  /** Catalog accessor name in the project (`libs`, `springLibs`, …). */
  alias: string
  group: string
  artifact: string
  version: string
}

/**
 * Extract every `versionCatalogs.create("alias") { from("g:a:v") }` declaration
 * from a `settings.gradle(.kts)` source. Returns the catalogs in declaration order.
 */
export function parsePublishedCatalogs(source: string): PublishedCatalogRef[] {
  const block = extractVersionCatalogsBlock(source)
  if (!block)
    return []

  const out: PublishedCatalogRef[] = []
  CREATE_CALL_RE.lastIndex = 0
  let createMatch: RegExpExecArray | null = CREATE_CALL_RE.exec(block)
  while (createMatch !== null) {
    const alias = createMatch[1]
    if (alias) {
      const blockEnd = findCreateBlockEnd(block, createMatch.index + createMatch[0].length)
      const inner = block.slice(createMatch.index, blockEnd)
      const fromMatch = FROM_CALL_RE.exec(inner)
      if (fromMatch && fromMatch[1] && fromMatch[2] && fromMatch[3]) {
        out.push({
          alias,
          group: fromMatch[1],
          artifact: fromMatch[2],
          version: fromMatch[3],
        })
      }
    }
    createMatch = CREATE_CALL_RE.exec(block)
  }
  return out
}

function extractVersionCatalogsBlock(source: string): string | undefined {
  const idx = source.indexOf(VERSION_CATALOGS_KEYWORD)
  if (idx === -1)
    return undefined
  const open = source.indexOf('{', idx + VERSION_CATALOGS_KEYWORD.length)
  if (open === -1)
    return undefined
  let depth = 1
  let i = open + 1
  while (i < source.length && depth > 0) {
    const ch = source.charCodeAt(i)
    if (ch === 123)
      depth++ // '{'
    else if (ch === 125)
      depth-- // '}'
    i++
  }
  if (depth !== 0)
    return undefined
  return source.slice(open + 1, i - 1)
}

/**
 * Given the position right after a `create("alias")` call, return the position
 * of the matching closing `}` of that create block. Falls back to the end of
 * the input when no balanced block is found.
 */
function findCreateBlockEnd(block: string, fromIndex: number): number {
  // Skip whitespace (incl. newline/CR) looking for the opening `{`. Multi-line
  // `create(...) {\n  from(...) }` is the common formatting for Kotlin DSL.
  let i = fromIndex
  while (i < block.length && isAsciiWhitespace(block.charCodeAt(i)))
    i++
  if (i >= block.length || block.charCodeAt(i) !== 123)
    return block.length
  let depth = 1
  i++
  while (i < block.length && depth > 0) {
    const ch = block.charCodeAt(i)
    if (ch === 123)
      depth++
    else if (ch === 125)
      depth--
    i++
  }
  return i
}

const GROUP_DOT_RE = /\./g

/**
 * Standard local-Maven layout path for a `.toml` published catalog artifact.
 */
export function m2CatalogPath(group: string, artifact: string, version: string, m2Root: string): string {
  const groupPath = group.replace(GROUP_DOT_RE, '/')
  return join(m2Root, groupPath, artifact, version, `${artifact}-${version}.toml`)
}

/**
 * Gradle's hashed-artifact layout *directory* — the toml file lives under a
 * `<sha1>` subdirectory of this dir (e.g.,
 * `~/.gradle/caches/modules-2/files-2.1/com.example/catalog/1.0/<sha1>/catalog-1.0.toml`).
 * The orchestrator scans this directory's children for the artifact filename.
 */
export function gradleCacheCatalogDir(
  group: string,
  artifact: string,
  version: string,
  gradleCachesRoot: string,
): string {
  return join(gradleCachesRoot, 'modules-2', 'files-2.1', group, artifact, version)
}

/**
 * Plugin-owned catalog cache (manually populated when the user runs detect with
 * a known catalog or via a future fetch flow). The `group` is included in the
 * filename so that two publishers shipping the same `artifact:version` pair do
 * not collide in this flat cache directory.
 */
export function pleaseaiCatalogCachePath(
  group: string,
  artifact: string,
  version: string,
  pleaseaiCacheRoot: string,
): string {
  return join(pleaseaiCacheRoot, 'catalogs', `${group}-${artifact}-${version}.toml`)
}
