/**
 * Build-file detection result types — Library Layer (no I/O).
 *
 * Source of truth for FR-8 in `.please/docs/tracks/active/build-file-detect-20260428/spec.md`.
 * Consumed by every parser and the orchestrator (`scripts/detect.ts`).
 */

/**
 * `DetectSource.file` path contract:
 * - **In-project sources**: POSIX-relative path from the project root
 *   (e.g., `pom.xml`, `gradle/libs.versions.toml`).
 * - **Out-of-project sources**: POSIX-absolute path with `$HOME` expanded
 *   (e.g., `/Users/alice/.m2/repository/...`,
 *   `/home/bob/.cache/pleaseai-spring/overrides.json`). Implementations MUST
 *   expand `~/` to the resolved `$HOME` before storing the value; the literal
 *   `~/` prefix never appears in the stored string.
 */
export interface DetectSource {
  file: string
  locator: string
  line?: number
}

export interface DetectedResult {
  kind: 'detected'
  version: string
  source: DetectSource
}

export interface UnsupportedResult {
  kind: 'unsupported'
  reason: string
  suggestion: string
  source?: DetectSource
}

export interface NotFoundResult {
  kind: 'not-found'
  reason: string
  suggestion: string
}

export type DetectResult = DetectedResult | UnsupportedResult | NotFoundResult

export const isDetected = (r: DetectResult): r is DetectedResult => r.kind === 'detected'
export const isUnsupported = (r: DetectResult): r is UnsupportedResult => r.kind === 'unsupported'
export const isNotFound = (r: DetectResult): r is NotFoundResult => r.kind === 'not-found'

/**
 * Canonical literal token for FR-17 — patterns that fundamentally require
 * build-tool evaluation (`buildSrc/`, settings plugins, `${revision}` interpolation).
 * Callers detect "requires-build-tool" by substring match against this token.
 */
export const REQUIRES_BUILD_TOOL = 'requires-build-tool' as const

/**
 * Standard suggestion when detection fails — every `unsupported` and `not-found`
 * result must include a suggestion that names `--boot <version>` (AC-2).
 */
export const SUGGEST_BOOT_OVERRIDE = 'Use --boot <version> to override' as const
