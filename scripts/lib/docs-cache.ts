/**
 * Pure helpers for resolving published `pleaseai/spring-docs` archives.
 * Library Layer: no I/O.
 *
 * The docs are not installed into the project. They are unpacked once into a
 * shared cache and referenced by path, so a project keeps zero documentation
 * files in version control and two projects on the same Spring version share
 * one copy. `scripts/docs.ts` owns the network and filesystem side.
 */

import { join } from 'node:path'

/** Repository publishing the converted documentation archives. */
export const DOCS_REPO = 'pleaseai/spring-docs' as const

/** Raw `catalog.json` on the docs repository's default branch. */
export const CATALOG_URL
  = `https://raw.githubusercontent.com/${DOCS_REPO}/main/catalog.json` as const

/**
 * Relative path of the documentation cache inside the home directory.
 *
 * Shares the `pleaseai-spring` root with the override store
 * (`scripts/lib/overrides.ts`), so clearing that one directory clears
 * everything this plugin has written.
 */
export const DOCS_CACHE_SUBDIR = '.cache/pleaseai-spring/docs' as const

/** Catalog schema version this client understands. */
export const SUPPORTED_CATALOG_VERSION = '1' as const

/** One published `(project, version)` pair. */
export interface CatalogEntry {
  /** Release tag carrying the archive, e.g. `boot-4.1.1`. */
  tag: string
  /** ISO-8601 publication time, or null while a tag exists unpublished. */
  released_at: string | null
}

/** The docs repository's master index. */
export interface Catalog {
  version: string
  generated_at: string | null
  projects: Record<string, Record<string, CatalogEntry>>
}

/** Why a catalog lookup produced no tag. */
export type LookupFailure
  = | { kind: 'schema', found: string }
    | { kind: 'unknown-project', project: string, known: string[] }
    | { kind: 'unknown-version', project: string, version: string, known: string[] }

export type LookupResult
  = | { kind: 'found', tag: string, releasedAt: string | null }
    | LookupFailure

/**
 * Find the release tag carrying `project` `version`.
 *
 * The catalog — not the tag naming scheme — is the authority: a corrected
 * archive is republished under `<project>-<version>+rebuild.N` and only the
 * catalog says which tag a version currently resolves to.
 */
export function lookupTag(catalog: Catalog, project: string, version: string): LookupResult {
  if (catalog.version !== SUPPORTED_CATALOG_VERSION)
    return { kind: 'schema', found: catalog.version }

  const versions = catalog.projects[project]
  if (!versions)
    return { kind: 'unknown-project', project, known: Object.keys(catalog.projects).sort() }

  const entry = versions[version]
  if (!entry)
    return { kind: 'unknown-version', project, version, known: Object.keys(versions) }

  return { kind: 'found', tag: entry.tag, releasedAt: entry.released_at }
}

/**
 * Basename of the archive asset for one `(project, version)` pair.
 *
 * Deliberately built from the pair rather than from the tag: a `+rebuild.N`
 * tag still ships `<project>-<version>.tar.gz`, because the archive describes
 * the documentation, not the attempt that published it.
 */
export function archiveName(project: string, version: string): string {
  return `${project}-${version}.tar.gz`
}

/** Download URL of an archive asset published under `tag`. */
export function archiveUrl(tag: string, project: string, version: string): string {
  return `https://github.com/${DOCS_REPO}/releases/download/${tag}/${archiveName(project, version)}`
}

/** Download URL of the checksum published beside the archive. */
export function checksumUrl(tag: string, project: string, version: string): string {
  return `${archiveUrl(tag, project, version)}.sha256`
}

/**
 * Directory holding one unpacked archive.
 *
 * Keyed by tag, not by version: a `+rebuild.N` tag is a different archive for
 * the same version, and keying by version would keep serving the superseded
 * tree from cache forever.
 */
export function docsCachePath(cacheHome: string, tag: string): string {
  return join(cacheHome, DOCS_CACHE_SUBDIR, tag)
}

const SHA256_LINE_RE = /^([0-9a-f]{64})\s+\*?(\S+)$/i

/**
 * Read the digest out of a `sha256sum`-style checksum file.
 *
 * The filename is checked, not ignored: the sidecar is fetched from the same
 * release as the archive, so a mismatch means the release's assets do not
 * belong together and the digest is not evidence about these bytes.
 *
 * @returns the lowercase digest, or undefined when the file is malformed or
 * names a different archive.
 */
export function parseChecksum(contents: string, expectedName: string): string | undefined {
  const line = contents.trim().split('\n')[0]?.trim()
  if (!line)
    return undefined
  const match = SHA256_LINE_RE.exec(line)
  if (!match || !match[1] || !match[2])
    return undefined
  if (match[2] !== expectedName)
    return undefined
  return match[1].toLowerCase()
}
