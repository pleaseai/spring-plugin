/**
 * Pure resolvers for Gradle version catalog (`libs.versions.toml`) and
 * `gradle.properties` value substitution. Library Layer — no I/O.
 *
 * Covers FR-12. Used by the orchestrator to resolve `GradleHints.catalogReference`
 * and `GradleHints.propertyReference` from {@link ../detect-gradle.ts}.
 */

const TABLE_HEADER_RE = /^\s*\[(.+?)\]\s*$/
const TOML_KV_RE = /^\s*([\w.-]+)\s*=\s*(['"])([^'"]*)\2/
const COMMENT_LINE_RE = /^\s*#/
// gradle.properties is split with string operations to avoid regex
// backtracking on lines with arbitrary whitespace; see {@link parseProperties}.
const QUOTE_OUTER_RE = /^(['"])(.*)\1$/
const DOT_GLOBAL_RE = /\./g
const LINE_BREAK_RE = /\r?\n/

/**
 * Resolve a version catalog reference of the form
 * `libs.versions.<aliasPath>.get()` against the `[versions]` table of
 * `libs.versions.toml`.
 *
 * The DSL uses dots as namespace separators while TOML keys typically use
 * kebab-case. This resolver tries the verbatim alias first, then several
 * common transformations.
 *
 * @param toml Raw `libs.versions.toml` contents.
 * @param aliasPath Dot-separated alias path, e.g., `spring.boot`.
 * @returns The resolved version string, or `undefined` when not found.
 */
export function resolveCatalogVersion(toml: string, aliasPath: string): string | undefined {
  const versionsTable = extractVersionsTable(toml)
  if (!versionsTable)
    return undefined
  for (const key of aliasCandidates(aliasPath)) {
    const v = readTomlString(versionsTable, key)
    if (v)
      return v
  }
  return undefined
}

function aliasCandidates(aliasPath: string): string[] {
  const seen = new Set<string>([aliasPath])
  seen.add(aliasPath.replace(DOT_GLOBAL_RE, '-'))
  seen.add(aliasPath.replace(DOT_GLOBAL_RE, '_'))
  seen.add(aliasPath.replace(DOT_GLOBAL_RE, ''))
  return [...seen]
}

function extractVersionsTable(toml: string): string | undefined {
  let inVersions = false
  const collected: string[] = []
  for (const line of toml.split(LINE_BREAK_RE)) {
    const header = TABLE_HEADER_RE.exec(line)
    if (header) {
      inVersions = header[1]?.trim() === 'versions'
      continue
    }
    if (inVersions)
      collected.push(line)
  }
  if (collected.length === 0)
    return undefined
  return collected.join('\n')
}

function readTomlString(table: string, key: string): string | undefined {
  for (const raw of table.split(LINE_BREAK_RE)) {
    if (COMMENT_LINE_RE.test(raw))
      continue
    const m = TOML_KV_RE.exec(raw)
    if (m && m[1] === key)
      return m[3] ?? undefined
  }
  return undefined
}

/**
 * Parse a `gradle.properties` file into a plain map. Comment lines (`#` or `!`)
 * are skipped. Quoted values are unwrapped. Later occurrences override earlier
 * ones, matching Gradle's "merged properties" semantics for repeat declarations.
 *
 * Implementation note: split on the first `=` or `:` using string operations
 * rather than a single regex — pure regex matchers tend to backtrack on lines
 * with arbitrary whitespace around values.
 */
export function parseProperties(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of content.split(LINE_BREAK_RE)) {
    const kv = parseKvLine(raw)
    if (!kv)
      continue
    const [key, value] = kv
    out[key] = value
  }
  return out
}

function parseKvLine(raw: string): [string, string] | undefined {
  const trimmed = raw.trimStart()
  if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!'))
    return undefined
  const sep = firstIndexOfAny(trimmed, '=', ':')
  if (sep <= 0)
    return undefined
  const key = trimmed.slice(0, sep).trim()
  if (!key)
    return undefined
  let value = trimmed.slice(sep + 1).trim()
  const quoted = QUOTE_OUTER_RE.exec(value)
  if (quoted)
    value = quoted[2] ?? ''
  return [key, value]
}

function firstIndexOfAny(s: string, a: string, b: string): number {
  const ai = s.indexOf(a)
  const bi = s.indexOf(b)
  if (ai === -1)
    return bi
  if (bi === -1)
    return ai
  return Math.min(ai, bi)
}

/**
 * Resolve a single property by name from `gradle.properties` content.
 */
export function resolveProperty(content: string, name: string): string | undefined {
  return parseProperties(content)[name]
}
