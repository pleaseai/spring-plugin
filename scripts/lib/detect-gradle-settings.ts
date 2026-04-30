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
