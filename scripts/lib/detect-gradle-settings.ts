/**
 * Pure parsers for `settings.gradle(.kts)`.
 *
 * - {@link parseSettingsIncludes} — extract `include(...)` declarations (FR-7).
 * - {@link parseSettingsPluginManagement} — extract `pluginManagement { plugins { ... } }`
 *   spring-boot version declarations (FR-13). _Implemented in T012._
 *
 * Library Layer: pure functions, no I/O.
 */

export interface GradleInclude {
  /** Verbatim project path as written in the build file (e.g., `:app`, `shared:core`). */
  path: string
  /**
   * Filesystem subdirectory derived from {@link path} using Gradle's default
   * project-path → directory mapping (`:a:b` → `a/b`). Custom `projectDir`
   * overrides via `project(...).projectDir = ...` are NOT supported here; the
   * orchestrator skips entries whose subdir does not exist on disk.
   */
  subdir: string
}

const INCLUDE_CALL_RE = /(?<![\w.])include\s*(?:\(([^)]*)\)|([^\n]*))/g
const QUOTED_STRING_RE = /['"]([^'"]+)['"]/g

/**
 * Extract every `include(...)` argument from a `settings.gradle(.kts)` source.
 * Returns the project paths in the order they appear; duplicates (rare) are
 * preserved.
 */
export function parseSettingsIncludes(source: string): GradleInclude[] {
  const out: GradleInclude[] = []
  let m: RegExpExecArray | null
  // Reset lastIndex defensively — multiple parser entrypoints may share state if
  // we ever hoist these into a shared object.
  INCLUDE_CALL_RE.lastIndex = 0
  m = INCLUDE_CALL_RE.exec(source)
  while (m !== null) {
    const args = m[1] ?? m[2] ?? ''
    // Reject `includeBuild(...)` — the negative-lookbehind in the call regex
    // rejects `.include`, but `includeBuild` starts with `include` and would
    // otherwise match. Detect by checking the suffix.
    if (m[0].startsWith('includeBuild')) {
      m = INCLUDE_CALL_RE.exec(source)
      continue
    }
    QUOTED_STRING_RE.lastIndex = 0
    let s: RegExpExecArray | null = QUOTED_STRING_RE.exec(args)
    while (s !== null) {
      const path = s[1]
      if (path)
        out.push({ path, subdir: pathToSubdir(path) })
      s = QUOTED_STRING_RE.exec(args)
    }
    m = INCLUDE_CALL_RE.exec(source)
  }
  return out
}

const LEADING_COLON_RE = /^:/

function pathToSubdir(path: string): string {
  return path.replace(LEADING_COLON_RE, '').split(':').join('/')
}

const PLUGIN_MANAGEMENT_KEYWORD = 'pluginManagement'
const SPRING_BOOT_VERSION_RE
  = /\bid\s*(?:\(\s*)?['"]org\.springframework\.boot['"]\s*(?:\)\s*)?version\s+['"]([^'"]+)['"]/

/**
 * FR-13: extract a literal Spring Boot version from a `pluginManagement { plugins { ... } }`
 * block in `settings.gradle(.kts)`. Returns `undefined` when the block is missing,
 * malformed, or when the version is a property interpolation (`"${name}"`).
 *
 * Property interpolations are intentionally not resolved here — the orchestrator
 * handles those via `gradle.properties` (FR-12 / T011) once it sees a hint elsewhere.
 */
export function parseSettingsPluginManagement(source: string): string | undefined {
  const block = extractPluginManagementBlock(source)
  if (!block)
    return undefined
  const m = SPRING_BOOT_VERSION_RE.exec(block)
  if (!m || !m[1])
    return undefined
  const version = m[1]
  if (version.includes('$') || version.startsWith('libs.'))
    return undefined
  return version
}

/**
 * Extract the contents of the first balanced `pluginManagement { ... }` block.
 * Naive brace matcher — does not understand strings or comments. Sufficient for
 * the conservative regex matching done downstream.
 */
function extractPluginManagementBlock(source: string): string | undefined {
  const idx = source.indexOf(PLUGIN_MANAGEMENT_KEYWORD)
  if (idx === -1)
    return undefined
  const open = source.indexOf('{', idx + PLUGIN_MANAGEMENT_KEYWORD.length)
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
