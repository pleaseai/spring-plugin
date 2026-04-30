/**
 * Build-file detection — Domain Layer (orchestrator + CLI).
 *
 * Owns the I/O boundary: discovers build files, reads them, dispatches to the
 * pure parsers in `scripts/lib/`, and returns a single {@link DetectResult}.
 *
 * Library Layer parsers in `scripts/lib/` are I/O-free (NFR-1); this module
 * is the single place where filesystem access is permitted for detection.
 */

import type { DetectResult, NotFoundResult, UnsupportedResult } from './lib/detect-types.ts'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import process from 'node:process'
import { parseGradle } from './lib/detect-gradle.ts'
import { parsePom } from './lib/detect-maven.ts'
import {

  SUGGEST_BOOT_OVERRIDE,

} from './lib/detect-types.ts'

const POM = 'pom.xml'
const GRADLE_KTS = 'build.gradle.kts'
const GRADLE_GROOVY = 'build.gradle'

/** FR-5: maximum number of parent POMs to walk before giving up. */
const MAX_PARENT_HOPS = 5

const WIN_SEP_RE = /\\/g

/**
 * Detect the declared Spring Boot version of a project.
 *
 * @param projectDir Absolute or relative directory path to a project root.
 * @returns A {@link DetectResult} — never throws on a recognized failure mode.
 */
export async function detect(projectDir: string): Promise<DetectResult> {
  if (!isExistingDirectory(projectDir)) {
    return notFound(projectDir)
  }

  // Maven takes precedence: if pom.xml exists, treat the project as Maven.
  // Build files of both types are unusual; downstream tracks may revisit this rule.
  const pomPath = join(projectDir, POM)
  if (existsSync(pomPath)) {
    return resolveMaven(projectDir, pomPath)
  }

  for (const fname of [GRADLE_KTS, GRADLE_GROOVY]) {
    const p = join(projectDir, fname)
    if (existsSync(p)) {
      const src = readFileSync(p, 'utf8')
      const { result } = parseGradle(src, fname)
      return result
    }
  }

  return notFound(projectDir)
}

function isExistingDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  }
  catch {
    return false
  }
}

/**
 * Resolve a Maven project's Spring Boot version, walking parent POMs (FR-5)
 * up to {@link MAX_PARENT_HOPS} hops via `<parent><relativePath>`.
 *
 * @param projectDir Project root directory (used as the base for source paths).
 * @param initialPath Absolute path to the leaf `pom.xml`.
 */
function resolveMaven(projectDir: string, initialPath: string): DetectResult {
  let currentAbs = initialPath
  let currentRel = POM
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    const xml = readFileSync(currentAbs, 'utf8')
    const { result, hints } = parsePom(xml, currentRel)
    if (result.kind === 'detected' || result.kind === 'unsupported') {
      return result
    }
    if (!hints.parent || !hints.parent.relativePath) {
      // Sibling parent traversal exhausted. T013 will add ~/.m2 cache fallback.
      return result
    }
    const candidate = resolve(dirname(currentAbs), hints.parent.relativePath)
    if (!existsSync(candidate)) {
      return result
    }
    currentAbs = candidate
    // Compute POSIX-relative path from project root for source attribution.
    currentRel = posixRelative(projectDir, currentAbs)
  }
  // Exhausted hop budget without finding a version.
  return parentTraversalExceeded(currentRel)
}

function posixRelative(from: string, to: string): string {
  const rel = relative(from, to)
  // `relative` uses platform separator; FR-8 contract is POSIX. Normalize.
  if (isAbsolute(rel))
    return rel
  return rel.split(WIN_SEP_RE).join('/')
}

function parentTraversalExceeded(lastFile: string): UnsupportedResult {
  return {
    kind: 'unsupported',
    reason: `Maven parent traversal exceeded ${MAX_PARENT_HOPS} hops without finding a Spring Boot version`,
    suggestion: SUGGEST_BOOT_OVERRIDE,
    source: { file: lastFile, locator: `parent traversal stopped after ${MAX_PARENT_HOPS} hops` },
  }
}

function notFound(projectDir: string): NotFoundResult {
  return {
    kind: 'not-found',
    reason: `No supported build file at ${projectDir}`,
    suggestion: `Run from a Spring project root, or pass --boot <version> (${SUGGEST_BOOT_OVERRIDE})`,
  }
}

function internalErrorResult(err: unknown): UnsupportedResult {
  const reason = err instanceof Error ? `internal error: ${err.message}` : 'internal error'
  return {
    kind: 'unsupported',
    reason,
    suggestion: SUGGEST_BOOT_OVERRIDE,
  }
}

// ------------------------------ CLI -----------------------------------------

const USAGE = 'usage: bun run scripts/detect.ts <project-dir>'

async function cli(argv: string[]): Promise<number> {
  const dir = argv[0]
  if (!dir) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  let result: DetectResult
  try {
    result = await detect(dir)
  }
  catch (err) {
    // FR-11: exit 2 only for unexpected internal errors.
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.stdout.write(`${JSON.stringify(internalErrorResult(err), null, 2)}\n`)
    return 2
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return result.kind === 'detected' ? 0 : 1
}

if (import.meta.main) {
  const code = await cli(process.argv.slice(2))
  process.exit(code)
}
