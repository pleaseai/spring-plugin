import type { DetectedResult, DetectResult, NotFoundResult } from './detect-types.ts'
import {

  SUGGEST_BOOT_OVERRIDE,
} from './detect-types.ts'

/**
 * Hints emitted by the parser for the orchestrator to follow up on.
 *
 * - `pluginReferenced`: whether the file mentions the Spring Boot plugin at all
 *   (via `plugins { id ... }`, `apply plugin:`, or `classpath` notation).
 * - `catalogReference`: when `version libs.versions.<path>.get()` is used —
 *   T011 resolves the alias against `libs.versions.toml`.
 * - `propertyReference`: when `version "${name}"` or `version "$name"` is used —
 *   T011 resolves against `gradle.properties`.
 */
export interface GradleHints {
  pluginReferenced: boolean
  catalogReference?: CatalogReference
  propertyReference?: PropertyReference
}

export interface CatalogReference {
  aliasPath: string
}

export interface PropertyReference {
  name: string
}

export interface GradleParseOutput {
  result: DetectResult
  hints: GradleHints
}

const SPRING_BOOT_PLUGIN_ID_RE = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]\s*\)?/g
const APPLY_PLUGIN_RE = /\bapply\s+plugin\s*:\s*['"]org\.springframework\.boot['"]/
const CLASSPATH_PLUGIN_RE = /\bclasspath\s+['"]org\.springframework\.boot:spring-boot-gradle-plugin/

const PLUGINS_LITERAL_RE
  = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]\s*(?:\)\s*)?version\s+['"]([^'"]+)['"]/
const PLUGINS_CATALOG_RE
  = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]\s*(?:\)\s*)?version\s+libs\.versions\.([\w.]+)\.get\s*\(\s*\)/

const ASSIGN_VERSION_PATTERNS: RegExp[] = [
  /\bext\s*\.\s*springBootVersion\s*=\s*['"]([^'"$\\]+)['"]/,
  /\bext\s*\[\s*['"]spring-boot\.version['"]\s*\]\s*=\s*['"]([^'"$\\]+)['"]/,
  /\bclasspath\s*(?:\(\s*)?['"]org\.springframework\.boot:spring-boot-gradle-plugin:([^'"$\\{}]+)['"]/,
  /\bspringBootVersion\s*=\s*['"]([^'"$\\]+)['"]/,
]

const INTERPOLATION_BRACED_RE = /^\$\{(\w+)\}$/
const INTERPOLATION_BARE_RE = /^\$(\w+)$/

/**
 * Parse a Gradle build file (Groovy or Kotlin DSL) from a string.
 * Pure function — no I/O.
 *
 * Handles:
 * - FR-3 Groovy: `plugins { id 'org.springframework.boot' version '...' }`,
 *   `apply plugin:` + `buildscript { ext.springBootVersion = '...' }`,
 *   `ext['spring-boot.version'] = '...'` patterns.
 * - FR-4 Kotlin: `plugins { id("org.springframework.boot") version "..." }` and
 *   the equivalent buildscript patterns.
 *
 * Catalog references (`libs.versions.X.get()`) and property interpolations
 * (`"${name}"`) yield a `not-found` result with `GradleHints` so the orchestrator
 * (T011) can resolve via `libs.versions.toml` or `gradle.properties`.
 */
export function parseGradle(source: string, file: string): GradleParseOutput {
  const pluginReferenced
    = SPRING_BOOT_PLUGIN_ID_RE.test(source)
      || APPLY_PLUGIN_RE.test(source)
      || CLASSPATH_PLUGIN_RE.test(source)
  // The /g flag advances lastIndex on test() — reset before reuse.
  SPRING_BOOT_PLUGIN_ID_RE.lastIndex = 0

  // Pattern 1: literal version in plugins block
  const literal = PLUGINS_LITERAL_RE.exec(source)
  if (literal) {
    const raw = literal[1]
    if (raw === undefined)
      return notFoundWithHints(file, { pluginReferenced })
    if (raw.includes('${') || raw.startsWith('$')) {
      // Property interpolation in plugins block — surface hint, defer to orchestrator.
      const name = extractInterpolationName(raw)
      return {
        result: notFound(file),
        hints: {
          pluginReferenced: true,
          ...(name ? { propertyReference: { name } } : {}),
        },
      }
    }
    return {
      result: detected(raw, file, 'plugins block id org.springframework.boot', lineOf(source, literal.index)),
      hints: { pluginReferenced: true },
    }
  }

  // Pattern 2: catalog reference in plugins block
  const catalog = PLUGINS_CATALOG_RE.exec(source)
  if (catalog && catalog[1]) {
    return {
      result: notFound(file),
      hints: {
        pluginReferenced: true,
        catalogReference: { aliasPath: catalog[1] },
      },
    }
  }

  // Pattern 3: buildscript ext / classpath / springBootVersion assignments
  if (pluginReferenced) {
    for (const p of ASSIGN_VERSION_PATTERNS) {
      const m = p.exec(source)
      if (m && m[1]) {
        return {
          result: detected(m[1], file, 'buildscript ext / classpath version assignment', lineOf(source, m.index)),
          hints: { pluginReferenced: true },
        }
      }
    }
  }

  // Final fallback — no version literal found.
  return notFoundWithHints(file, { pluginReferenced })
}

/**
 * Convenience aliases matching the names called out in the plan
 * (parseGroovy / parseKotlin); both delegate to the unified parser
 * because the recognized patterns are common to both DSLs.
 */
export const parseGroovy = parseGradle
export const parseKotlin = parseGradle

function detected(version: string, file: string, locator: string, line: number): DetectedResult {
  return {
    kind: 'detected',
    version,
    source: { file, locator, line },
  }
}

function notFound(file: string): NotFoundResult {
  return {
    kind: 'not-found',
    reason: `No Spring Boot version declared in ${file}`,
    suggestion: `Run from a Spring project root, or pass --boot <version> to override (${SUGGEST_BOOT_OVERRIDE})`,
  }
}

function notFoundWithHints(file: string, hints: GradleHints): GradleParseOutput {
  return { result: notFound(file), hints }
}

function lineOf(source: string, index: number): number {
  // 1-based line numbers for diagnostics.
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10)
      line++
  }
  return line
}

function extractInterpolationName(raw: string): string | undefined {
  // ${name} → name; $name → name
  const braced = INTERPOLATION_BRACED_RE.exec(raw)
  if (braced && braced[1])
    return braced[1]
  const bare = INTERPOLATION_BARE_RE.exec(raw)
  if (bare && bare[1])
    return bare[1]
  return undefined
}
