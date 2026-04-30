/**
 * Pure helpers for the `--boot` override store (FR-15). Library Layer — no I/O.
 *
 * The store is a JSON object keyed by `sha256(absolute project_dir)` with values
 * `{ version, grantedAt }`. The orchestrator handles file reads/writes and
 * timestamp generation; this module is computation-only.
 */

import { createHash } from 'node:crypto'

export interface OverrideEntry {
  version: string
  grantedAt: string
}

export type OverrideStore = Record<string, OverrideEntry>

/**
 * Stable SHA-256 hex digest of the absolute project directory path.
 *
 * @param absoluteProjectDir Absolute path. Callers must normalize before passing
 *   so that, e.g., trailing slashes don't produce different keys.
 */
export function projectKey(absoluteProjectDir: string): string {
  return createHash('sha256').update(absoluteProjectDir).digest('hex')
}

/**
 * Defensive parser — never throws. Returns an empty store for any input that
 * is not a valid JSON object (including null, arrays, primitives, malformed).
 */
export function parseOverridesFile(content: string): OverrideStore {
  if (content.trim() === '')
    return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return {}
  return parsed as OverrideStore
}

export function getOverride(store: OverrideStore, key: string): OverrideEntry | undefined {
  return store[key]
}

export function setOverride(
  store: OverrideStore,
  key: string,
  version: string,
  grantedAt: string,
): OverrideStore {
  return { ...store, [key]: { version, grantedAt } }
}

export function clearOverride(store: OverrideStore, key: string): OverrideStore {
  if (!(key in store))
    return store
  const next: OverrideStore = { ...store }
  delete next[key]
  return next
}

export function serializeOverrides(store: OverrideStore): string {
  return `${JSON.stringify(store, null, 2)}\n`
}

/**
 * Relative path of the override store inside `~/.cache/pleaseai-spring/`.
 * The orchestrator joins this with the resolved cache root before any I/O.
 */
export const OVERRIDES_FILENAME = 'overrides.json' as const
export const OVERRIDES_CACHE_SUBDIR = '.cache/pleaseai-spring' as const
