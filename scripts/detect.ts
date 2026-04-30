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
import { join } from 'node:path'

import process from 'node:process'
import { parseGradle } from './lib/detect-gradle.ts'
import { parsePom } from './lib/detect-maven.ts'
import {

  SUGGEST_BOOT_OVERRIDE,

} from './lib/detect-types.ts'

const POM = 'pom.xml'
const GRADLE_KTS = 'build.gradle.kts'
const GRADLE_GROOVY = 'build.gradle'

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
    const xml = readFileSync(pomPath, 'utf8')
    const { result } = parsePom(xml, POM)
    return result
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
