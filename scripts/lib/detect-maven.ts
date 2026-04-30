import type { DetectedResult, DetectResult, DetectSource, NotFoundResult, UnsupportedResult } from './detect-types.ts'

import { XMLParser } from 'fast-xml-parser'
import {

  REQUIRES_BUILD_TOOL,
  SUGGEST_BOOT_OVERRIDE,

} from './detect-types.ts'

/**
 * Hints emitted by the parser for the orchestrator to follow up on.
 *
 * - `parent`: when present, the orchestrator may walk parent POMs (FR-5 sibling,
 *   FR-14 ~/.m2 cache).
 * - `modules`: when present, the orchestrator may walk multi-module children (FR-6).
 */
export interface MavenHints {
  parent?: ParentRef
  modules?: string[]
}

export interface ParentRef {
  groupId: string
  artifactId: string
  version: string
  relativePath?: string
}

export interface MavenParseOutput {
  result: DetectResult
  hints: MavenHints
}

const SPRING_BOOT_GROUP = 'org.springframework.boot'
const SPRING_BOOT_PARENT = 'spring-boot-starter-parent'
const SPRING_BOOT_BOM = 'spring-boot-dependencies'

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  parseTagValue: false,
  // Preserve order is not needed; arrayify <module> and <dependency> for safety.
  isArray: tagName => tagName === 'module' || tagName === 'dependency',
})

/**
 * Parse a Maven `pom.xml` from a string. Pure function — no I/O.
 *
 * @param xml The raw XML contents.
 * @param file POSIX-relative path used for source attribution in the result.
 * @returns A {@link MavenParseOutput} containing the {@link DetectResult} and
 *   any parent/modules hints the orchestrator can use to traverse further.
 */
export function parsePom(xml: string, file: string): MavenParseOutput {
  let doc: unknown
  try {
    doc = xmlParser.parse(xml)
  }
  catch (err) {
    return {
      result: malformed(file, err),
      hints: {},
    }
  }

  const project = (doc as { project?: unknown } | undefined)?.project
  if (!project || typeof project !== 'object') {
    return { result: malformed(file, new Error('no <project> root element')), hints: {} }
  }

  // Pattern 1: spring-boot-starter-parent in <parent>
  const parent = readParent(project as Record<string, unknown>)
  if (parent && parent.groupId === SPRING_BOOT_GROUP && parent.artifactId === SPRING_BOOT_PARENT) {
    if (!parent.version) {
      return {
        result: unsupported(
          file,
          'spring-boot-starter-parent declared without <version>',
          'parent (no version)',
        ),
        hints: {},
      }
    }
    if (containsInterpolation(parent.version)) {
      // FR-17: ${revision} or ${...} interpolation requires Maven evaluation.
      return {
        result: requiresBuildTool(
          file,
          `spring-boot-starter-parent <version> uses Maven property interpolation (${parent.version})`,
          'spring-boot-starter-parent in <parent>',
        ),
        hints: {},
      }
    }
    return {
      result: detected(parent.version, file, 'spring-boot-starter-parent in <parent>'),
      hints: {},
    }
  }

  // Pattern 2: spring-boot-dependencies BOM in <dependencyManagement>
  const bomVersion = readSpringBootBomVersion(project as Record<string, unknown>)
  if (bomVersion) {
    if (containsInterpolation(bomVersion)) {
      // FR-17: ${...} interpolation in BOM version requires Maven evaluation.
      return {
        result: requiresBuildTool(
          file,
          `spring-boot-dependencies <version> uses Maven property interpolation (${bomVersion})`,
          'spring-boot-dependencies BOM in <dependencyManagement>',
        ),
        hints: {},
      }
    }
    return {
      result: detected(bomVersion, file, 'spring-boot-dependencies BOM in <dependencyManagement>'),
      hints: {},
    }
  }

  // No version detected — surface hints for orchestrator to follow.
  const hints: MavenHints = {}
  if (parent)
    hints.parent = parent
  const modules = readModules(project as Record<string, unknown>)
  if (modules.length > 0)
    hints.modules = modules

  return {
    result: notFound(file),
    hints,
  }
}

function readParent(project: Record<string, unknown>): ParentRef | undefined {
  const raw = project.parent
  if (!raw || typeof raw !== 'object')
    return undefined
  const p = raw as Record<string, unknown>
  const groupId = asString(p.groupId)
  const artifactId = asString(p.artifactId)
  const version = asString(p.version)
  if (!groupId || !artifactId)
    return undefined
  const relativePath = asString(p.relativePath)
  return {
    groupId,
    artifactId,
    version: version ?? '',
    ...(relativePath ? { relativePath } : {}),
  }
}

function readSpringBootBomVersion(project: Record<string, unknown>): string | undefined {
  const dm = project.dependencyManagement
  if (!dm || typeof dm !== 'object')
    return undefined
  const deps = (dm as Record<string, unknown>).dependencies
  if (!deps || typeof deps !== 'object')
    return undefined
  const list = (deps as Record<string, unknown>).dependency
  const arr = Array.isArray(list) ? list : list ? [list] : []
  for (const d of arr) {
    if (!d || typeof d !== 'object')
      continue
    const dep = d as Record<string, unknown>
    if (
      asString(dep.groupId) === SPRING_BOOT_GROUP
      && asString(dep.artifactId) === SPRING_BOOT_BOM
    ) {
      const v = asString(dep.version)
      if (v)
        return v
    }
  }
  return undefined
}

function readModules(project: Record<string, unknown>): string[] {
  const m = project.modules
  if (!m || typeof m !== 'object')
    return []
  const list = (m as Record<string, unknown>).module
  if (!list)
    return []
  const arr = Array.isArray(list) ? list : [list]
  return arr.map(asString).filter((s): s is string => typeof s === 'string' && s.length > 0)
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string')
    return v.trim() || undefined
  if (typeof v === 'number')
    return String(v)
  return undefined
}

function detected(version: string, file: string, locator: string): DetectedResult {
  return {
    kind: 'detected',
    version,
    source: { file, locator },
  }
}

function unsupported(file: string, reason: string, locator: string): UnsupportedResult {
  const source: DetectSource = { file, locator }
  return {
    kind: 'unsupported',
    reason,
    suggestion: SUGGEST_BOOT_OVERRIDE,
    source,
  }
}

function notFound(file: string): NotFoundResult {
  return {
    kind: 'not-found',
    reason: `No Spring Boot version declared in ${file}`,
    suggestion: `Run from a Spring project root, or pass --boot <version> to override`,
  }
}

function malformed(file: string, err: unknown): UnsupportedResult {
  const reason = err instanceof Error ? `malformed XML: ${err.message}` : 'malformed XML'
  return unsupported(file, reason, 'pom.xml parse error')
}

const INTERPOLATION_RE = /\$\{[^}]+\}/

function containsInterpolation(value: string): boolean {
  return INTERPOLATION_RE.test(value)
}

/**
 * FR-17: structured handoff to the build-tool fallback (ADR-0002). The reason
 * always contains the literal token {@link REQUIRES_BUILD_TOOL} so callers can
 * distinguish "we cannot parse this without code execution" from generic
 * unsupported-pattern responses.
 */
function requiresBuildTool(file: string, detail: string, locator: string): UnsupportedResult {
  return {
    kind: 'unsupported',
    reason: `${REQUIRES_BUILD_TOOL}: ${detail}`,
    suggestion: `This pattern needs Maven/Gradle evaluation (build-tool fallback per ADR-0002). ${SUGGEST_BOOT_OVERRIDE}`,
    source: { file, locator },
  }
}
