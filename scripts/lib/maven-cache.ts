/**
 * Pure helpers for Maven local-cache (`~/.m2/repository`) layout.
 * Library Layer — no I/O.
 *
 * Standard Maven layout:
 *   <m2Root>/<groupId-with-slashes>/<artifactId>/<version>/<artifactId>-<version>.pom
 *
 * Used by FR-14 (external parent POM resolution) — see `scripts/detect.ts`.
 */

import { join } from 'node:path'

const DOT_GLOBAL_RE = /\./g

/**
 * Build the local-cache path for a Maven artifact's POM file.
 *
 * @param groupId Dotted group id (e.g., `org.springframework.boot`).
 * @param artifactId Artifact id (e.g., `spring-boot-dependencies`).
 * @param version Resolved version string.
 * @param m2Root Absolute (or relative — for tests) path to the local repository.
 * @returns The fully composed POM path.
 */
export function mavenCachePath(
  groupId: string,
  artifactId: string,
  version: string,
  m2Root: string,
): string {
  const groupPath = groupId.replace(DOT_GLOBAL_RE, '/')
  return join(m2Root, groupPath, artifactId, version, `${artifactId}-${version}.pom`)
}
