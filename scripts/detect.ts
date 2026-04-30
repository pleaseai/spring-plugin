/**
 * Build-file detection — Domain Layer (orchestrator + CLI).
 *
 * Owns the I/O boundary: discovers build files, reads them, dispatches to the
 * pure parsers in `scripts/lib/`, and returns a single {@link DetectResult}.
 *
 * Library Layer parsers in `scripts/lib/` are I/O-free (NFR-1); this module
 * is the single place where filesystem access is permitted for detection.
 */

import type { DetectedResult, DetectResult, NotFoundResult, UnsupportedResult } from './lib/detect-types.ts'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import process from 'node:process'

import { resolveCatalogVersion, resolveProperty } from './lib/detect-gradle-catalog.ts'
import { parseSettingsIncludes, parseSettingsPluginManagement } from './lib/detect-gradle-settings.ts'
import { parseGradle } from './lib/detect-gradle.ts'
import { parsePom } from './lib/detect-maven.ts'
import {

  SUGGEST_BOOT_OVERRIDE,

} from './lib/detect-types.ts'
import { mavenCachePath } from './lib/maven-cache.ts'
import {
  clearOverride,
  getOverride,
  OVERRIDES_CACHE_SUBDIR,
  OVERRIDES_FILENAME,
  parseOverridesFile,
  projectKey,
  serializeOverrides,
  setOverride,
} from './lib/overrides.ts'

const POM = 'pom.xml'
const GRADLE_KTS = 'build.gradle.kts'
const GRADLE_GROOVY = 'build.gradle'
const SETTINGS_KTS = 'settings.gradle.kts'
const SETTINGS_GROOVY = 'settings.gradle'
const VERSION_CATALOG = 'gradle/libs.versions.toml'
const GRADLE_PROPERTIES = 'gradle.properties'

/** FR-5: maximum number of parent POMs to walk before giving up. */
const MAX_PARENT_HOPS = 5

/** Test-only override for the local Maven repository (FR-14). */
const M2_ENV_OVERRIDE = 'PLEASEAI_SPRING_M2_ROOT'
/** Test-only override for the override-store home directory (FR-15). */
const CACHE_HOME_ENV_OVERRIDE = 'PLEASEAI_SPRING_CACHE_HOME'

const WIN_SEP_RE = /\\/g

function getM2Root(): string {
  return process.env[M2_ENV_OVERRIDE] ?? join(homedir(), '.m2', 'repository')
}

function getCacheHome(): string {
  return process.env[CACHE_HOME_ENV_OVERRIDE] ?? homedir()
}

function getOverridesPath(): string {
  return join(getCacheHome(), OVERRIDES_CACHE_SUBDIR, OVERRIDES_FILENAME)
}

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

  // FR-15: an existing --boot override short-circuits detection.
  const overrideHit = readOverrideForProject(projectDir)
  if (overrideHit)
    return overrideHit

  // Maven takes precedence: if pom.xml exists, treat the project as Maven.
  // Build files of both types are unusual; downstream tracks may revisit this rule.
  const pomPath = join(projectDir, POM)
  if (existsSync(pomPath)) {
    return resolveMaven(projectDir, pomPath)
  }

  for (const fname of [GRADLE_KTS, GRADLE_GROOVY]) {
    const p = join(projectDir, fname)
    if (existsSync(p)) {
      return resolveGradle(projectDir, p, fname)
    }
  }

  return notFound(projectDir)
}

/**
 * Read the persisted `--boot` override for {@link projectDir}, if any. Returns
 * a synthetic `DetectedResult` so downstream callers see the same shape as
 * file-derived detection.
 */
function readOverrideForProject(projectDir: string): DetectedResult | undefined {
  const path = getOverridesPath()
  if (!existsSync(path))
    return undefined
  const store = parseOverridesFile(readFileSync(path, 'utf8'))
  const entry = getOverride(store, projectKey(resolve(projectDir)))
  if (!entry)
    return undefined
  return {
    kind: 'detected',
    version: entry.version,
    source: {
      file: path,
      locator: `--boot override (granted ${entry.grantedAt})`,
    },
  }
}

/**
 * Persist a `--boot` override for {@link projectDir}. Creates the cache
 * directory if needed.
 */
export function grantBootOverride(projectDir: string, version: string): void {
  const path = getOverridesPath()
  mkdirSync(dirname(path), { recursive: true })
  const previous = existsSync(path) ? parseOverridesFile(readFileSync(path, 'utf8')) : {}
  const next = setOverride(previous, projectKey(resolve(projectDir)), version, new Date().toISOString())
  writeFileSync(path, serializeOverrides(next))
}

/**
 * Revoke a `--boot` override for {@link projectDir}. No-op when the project
 * has no recorded override.
 */
export function clearBootOverride(projectDir: string): void {
  const path = getOverridesPath()
  if (!existsSync(path))
    return
  const previous = parseOverridesFile(readFileSync(path, 'utf8'))
  const next = clearOverride(previous, projectKey(resolve(projectDir)))
  writeFileSync(path, serializeOverrides(next))
}

/**
 * Resolve a Gradle project's Spring Boot version. Order of resolution:
 *
 * 1. Literal version in the project's own `build.gradle(.kts)`.
 * 2. Version catalog reference (FR-12) → `gradle/libs.versions.toml`.
 * 3. Property interpolation (FR-12) → `gradle.properties`.
 * 4. Multi-module walk (FR-7) — first subproject declaring a version wins.
 */
function resolveGradle(projectDir: string, rootBuildPath: string, rootRel: string): DetectResult {
  const src = readFileSync(rootBuildPath, 'utf8')
  const { result, hints } = parseGradle(src, rootRel)
  if (result.kind === 'detected' || result.kind === 'unsupported') {
    return result
  }

  // FR-12: catalog reference
  if (hints.catalogReference) {
    const catalogAbs = join(projectDir, VERSION_CATALOG)
    if (existsSync(catalogAbs)) {
      const tomlSrc = readFileSync(catalogAbs, 'utf8')
      const v = resolveCatalogVersion(tomlSrc, hints.catalogReference.aliasPath)
      if (v) {
        return {
          kind: 'detected',
          version: v,
          source: {
            file: VERSION_CATALOG,
            locator: `version catalog alias '${hints.catalogReference.aliasPath}' in [versions]`,
          },
        }
      }
    }
  }

  // FR-12: property interpolation
  if (hints.propertyReference) {
    const propsAbs = join(projectDir, GRADLE_PROPERTIES)
    if (existsSync(propsAbs)) {
      const propsSrc = readFileSync(propsAbs, 'utf8')
      const v = resolveProperty(propsSrc, hints.propertyReference.name)
      if (v) {
        return {
          kind: 'detected',
          version: v,
          source: {
            file: GRADLE_PROPERTIES,
            locator: `${hints.propertyReference.name} (gradle.properties)`,
          },
        }
      }
    }
  }

  // FR-13: settings.gradle pluginManagement — short-circuits multi-module walk on hit.
  const pmResult = resolvePluginManagement(projectDir)
  if (pmResult)
    return pmResult

  return walkGradleSubprojects(projectDir, result)
}

/**
 * FR-13: read `settings.gradle(.kts)` and check the `pluginManagement` block
 * for a literal Spring Boot version.
 */
function resolvePluginManagement(projectDir: string): DetectResult | undefined {
  const settingsRel = findSettingsFile(projectDir)
  if (!settingsRel)
    return undefined
  const src = readFileSync(join(projectDir, settingsRel), 'utf8')
  const v = parseSettingsPluginManagement(src)
  if (!v)
    return undefined
  return {
    kind: 'detected',
    version: v,
    source: {
      file: settingsRel,
      locator: 'pluginManagement plugins block',
    },
  }
}

/**
 * FR-7: parse `settings.gradle(.kts)` for `include(...)` and scan one level
 * of subprojects' build files for the Spring Boot plugin. Returns the
 * {@link fallback} result unchanged when no subproject resolves.
 */
function walkGradleSubprojects(projectDir: string, fallback: DetectResult): DetectResult {
  const settingsRel = findSettingsFile(projectDir)
  if (!settingsRel)
    return fallback
  const settingsAbs = join(projectDir, settingsRel)
  const includes = parseSettingsIncludes(readFileSync(settingsAbs, 'utf8'))
  for (const inc of includes) {
    for (const buildName of [GRADLE_KTS, GRADLE_GROOVY]) {
      const childRel = `${inc.subdir}/${buildName}`
      const childAbs = join(projectDir, inc.subdir, buildName)
      if (!existsSync(childAbs))
        continue
      const src = readFileSync(childAbs, 'utf8')
      const { result } = parseGradle(src, childRel)
      if (result.kind === 'detected')
        return result
      // Stop probing further build-file flavors for this subproject — we found one.
      break
    }
  }
  return fallback
}

function findSettingsFile(projectDir: string): string | undefined {
  for (const name of [SETTINGS_KTS, SETTINGS_GROOVY]) {
    if (existsSync(join(projectDir, name)))
      return name
  }
  return undefined
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
  let modulesAtRoot: string[] | undefined
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop++) {
    const xml = readFileSync(currentAbs, 'utf8')
    const { result, hints } = parsePom(xml, currentRel)
    if (result.kind === 'detected' || result.kind === 'unsupported') {
      return result
    }
    // Capture <modules> at the leaf level only (FR-6 walks the project's own
    // children, not arbitrary ancestors).
    if (hop === 0 && hints.modules && hints.modules.length > 0) {
      modulesAtRoot = hints.modules
    }
    if (!hints.parent) {
      return walkModulesIfAny(projectDir, modulesAtRoot, result)
    }

    // Step 1: try sibling-parent (FR-5) when relativePath resolves on disk.
    let nextAbs: string | undefined
    if (hints.parent.relativePath) {
      const candidate = resolve(dirname(currentAbs), hints.parent.relativePath)
      if (existsSync(candidate))
        nextAbs = candidate
    }

    // Step 2: FR-14 — fall back to ~/.m2 cache for external parents.
    if (!nextAbs) {
      const m2Path = mavenCachePath(
        hints.parent.groupId,
        hints.parent.artifactId,
        hints.parent.version,
        getM2Root(),
      )
      if (existsSync(m2Path)) {
        nextAbs = m2Path
      }
      else {
        // Cache miss — emit FR-14 unsupported result.
        return externalParentNotCached(hints.parent, m2Path)
      }
    }

    currentAbs = nextAbs
    // Compute POSIX-relative path from project root for source attribution.
    currentRel = posixRelative(projectDir, currentAbs)
  }
  // Exhausted hop budget without finding a version.
  return parentTraversalExceeded(currentRel)
}

/**
 * FR-6: scan declared `<modules>` for the first child whose POM declares a
 * Spring Boot version. Returns the {@link fallback} result unchanged when no
 * child resolves.
 */
function walkModulesIfAny(
  projectDir: string,
  modules: string[] | undefined,
  fallback: DetectResult,
): DetectResult {
  if (!modules || modules.length === 0)
    return fallback
  for (const m of modules) {
    const childPom = join(projectDir, m, POM)
    if (!existsSync(childPom))
      continue
    const xml = readFileSync(childPom, 'utf8')
    const childRel = posixRelative(projectDir, childPom)
    const { result } = parsePom(xml, childRel)
    if (result.kind === 'detected')
      return result
    // Non-detected child results (not-found / unsupported) are skipped — try next.
  }
  return fallback
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

interface ParentRefShape { groupId: string, artifactId: string, version: string }

function externalParentNotCached(parent: ParentRefShape, m2Path: string): UnsupportedResult {
  const coords = `${parent.groupId}:${parent.artifactId}:${parent.version}`
  return {
    kind: 'unsupported',
    reason: `external-parent-not-cached: parent ${coords} not present in ~/.m2 (looked up at ${m2Path})`,
    suggestion: `Run the project's Maven build at least once (e.g., ./mvnw install -N) to populate the local cache, or pass --boot <version> to override (${SUGGEST_BOOT_OVERRIDE})`,
    source: { file: m2Path, locator: `external parent ${coords}` },
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

const USAGE = 'usage: bun run scripts/detect.ts <project-dir> [--boot <version> | --clear-override]'

interface ParsedArgs {
  projectDir: string
  boot?: string
  clear?: boolean
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  let projectDir: string | undefined
  let boot: string | undefined
  let clear = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--boot') {
      boot = argv[++i]
      if (!boot)
        return { error: '--boot requires a version argument' }
    }
    else if (a === '--clear-override') {
      clear = true
    }
    else if (a && !a.startsWith('--')) {
      projectDir ??= a
    }
    else {
      return { error: `unknown argument: ${a}` }
    }
  }
  if (!projectDir)
    return { error: 'missing <project-dir>' }
  return { projectDir, boot, clear }
}

async function cli(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n${USAGE}\n`)
    return 2
  }
  if (parsed.clear)
    clearBootOverride(parsed.projectDir)
  if (parsed.boot)
    grantBootOverride(parsed.projectDir, parsed.boot)
  let result: DetectResult
  try {
    result = await detect(parsed.projectDir)
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
