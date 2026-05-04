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
 * preserved. Comments are stripped before matching so that `include(...)`
 * occurrences inside line or block comments don't yield phantom subprojects.
 */
export function parseSettingsIncludes(source: string): GradleInclude[] {
  // Strings carry the include paths, so only comments are masked here.
  const masked = stripComments(source)
  const out: GradleInclude[] = []
  let m: RegExpExecArray | null
  // Reset lastIndex defensively — multiple parser entrypoints may share state if
  // we ever hoist these into a shared object.
  INCLUDE_CALL_RE.lastIndex = 0
  m = INCLUDE_CALL_RE.exec(masked)
  while (m !== null) {
    const args = m[1] ?? m[2] ?? ''
    // Reject `includeBuild(...)` — the negative-lookbehind in the call regex
    // rejects `.include`, but `includeBuild` starts with `include` and would
    // otherwise match. Detect by checking the suffix.
    if (m[0].startsWith('includeBuild')) {
      m = INCLUDE_CALL_RE.exec(masked)
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
    m = INCLUDE_CALL_RE.exec(masked)
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
 * Comments and string literals are masked with same-length spaces while we
 * search for the keyword and walk braces, so a `// pluginManagement` line or
 * a `"... { ..."` literal cannot shadow the real block. The returned slice is
 * taken from the original source so downstream regex matching still sees real
 * version literals.
 */
function extractPluginManagementBlock(source: string): string | undefined {
  const bounds = findPluginManagementBlockBounds(source)
  if (!bounds)
    return undefined
  return source.slice(bounds.openBrace + 1, bounds.closeBrace)
}

/**
 * Return `source` with the first balanced `pluginManagement { ... }` block
 * removed (replaced with whitespace of the same length so character indices
 * remain stable). Used by the orchestrator's FR-17 escalation check, which
 * must not see `apply(...)` calls that legitimately live inside
 * `pluginManagement` (those are not settings-plugin applications).
 */
export function stripPluginManagementBlock(source: string): string {
  const bounds = findPluginManagementBlockBounds(source)
  if (!bounds)
    return source
  const out = source.split('')
  for (let j = bounds.keyword; j <= bounds.closeBrace; j++) {
    if (source.charCodeAt(j) !== 10)
      out[j] = ' '
  }
  return out.join('')
}

interface PluginManagementBounds {
  /** Index of the first character of the `pluginManagement` keyword. */
  keyword: number
  /** Index of the opening `{`. */
  openBrace: number
  /** Index of the matching closing `}`. */
  closeBrace: number
}

function findPluginManagementBlockBounds(source: string): PluginManagementBounds | undefined {
  const masked = stripCommentsAndStrings(source)
  const keyword = masked.indexOf(PLUGIN_MANAGEMENT_KEYWORD)
  if (keyword === -1)
    return undefined
  const openBrace = masked.indexOf('{', keyword + PLUGIN_MANAGEMENT_KEYWORD.length)
  if (openBrace === -1)
    return undefined
  let depth = 1
  let i = openBrace + 1
  while (i < masked.length && depth > 0) {
    const ch = masked.charCodeAt(i)
    if (ch === 123)
      depth++ // '{'
    else if (ch === 125)
      depth-- // '}'
    i++
  }
  if (depth !== 0)
    return undefined
  return { keyword, openBrace, closeBrace: i - 1 }
}

/**
 * Replace line comments and block comments with same-length whitespace,
 * preserving newlines so positions in the original source map 1:1.
 */
function stripComments(source: string): string {
  return maskNonCode(source, false)
}

/**
 * Replace comments AND string literals (single, double, and triple-quoted)
 * with same-length whitespace. Newlines are preserved.
 */
function stripCommentsAndStrings(source: string): string {
  return maskNonCode(source, true)
}

function maskNonCode(source: string, maskStrings: boolean): string {
  const out = source.split('')
  const len = source.length
  let i = 0
  while (i < len) {
    const c = source.charCodeAt(i)
    const next = i + 1 < len ? source.charCodeAt(i + 1) : -1
    // Line comment: //
    if (c === 47 && next === 47) {
      while (i < len && source.charCodeAt(i) !== 10) {
        out[i] = ' '
        i++
      }
      continue
    }
    // Block comment: /* ... */
    if (c === 47 && next === 42) {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? len : end + 2
      maskRange(source, out, i, stop)
      i = stop
      continue
    }
    if (maskStrings && (c === 34 || c === 39)) {
      const stop = endOfStringLiteral(source, i)
      maskRange(source, out, i, stop)
      i = stop
      continue
    }
    i++
  }
  return out.join('')
}

function endOfStringLiteral(source: string, start: number): number {
  const len = source.length
  const quote = source.charCodeAt(start)
  // Triple-quoted: """ or '''
  if (
    start + 2 < len
    && source.charCodeAt(start + 1) === quote
    && source.charCodeAt(start + 2) === quote
  ) {
    let i = start + 3
    while (i + 2 < len) {
      if (
        source.charCodeAt(i) === quote
        && source.charCodeAt(i + 1) === quote
        && source.charCodeAt(i + 2) === quote
      ) {
        return i + 3
      }
      i++
    }
    return len
  }
  // Single-quoted: walk until matching quote, honoring backslash escapes.
  let i = start + 1
  while (i < len) {
    const ch = source.charCodeAt(i)
    if (ch === 92 && i + 1 < len) { // '\\' escape
      i += 2
      continue
    }
    if (ch === quote)
      return i + 1
    if (ch === 10) // unterminated string at newline — bail
      return i
    i++
  }
  return len
}

function maskRange(source: string, out: string[], start: number, end: number): void {
  for (let j = start; j < end; j++) {
    if (source.charCodeAt(j) !== 10)
      out[j] = ' '
  }
}
