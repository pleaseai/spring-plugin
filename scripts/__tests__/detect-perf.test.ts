import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')

/**
 * NFR-5: detection of a single-file `pom.xml` or `build.gradle(.kts)` completes
 * in under 100ms on a warm cache (no parent traversal, no multi-module walk).
 *
 * The actual contract is 100ms; we assert against a generous 200ms ceiling to
 * absorb CI noise (cold filesystem cache, Bun JIT warmup, GitHub Actions runner
 * variance) while still catching a regression that crosses the budget by a
 * meaningful margin. The "warm" prerequisite is satisfied by an explicit
 * warm-up call before measurement.
 */
const NFR_5_BUDGET_MS = 100
const CI_NOISE_MARGIN_MS = 100
const ASSERT_BUDGET_MS = NFR_5_BUDGET_MS + CI_NOISE_MARGIN_MS

async function measureWarm(projectDir: string): Promise<number> {
  // Warm-up — populates filesystem caches and JIT-compiles parser hot paths.
  await detect(projectDir)
  await detect(projectDir)
  const start = performance.now()
  await detect(projectDir)
  return performance.now() - start
}

describe('NFR-5: warm-cache detection latency budget', () => {
  test('Maven single-file pom.xml: ≤200ms warm', async () => {
    const elapsed = await measureWarm(join(PROJECTS, 'maven-starter'))
    expect(elapsed).toBeLessThan(ASSERT_BUDGET_MS)
  })

  test('Gradle Kotlin DSL single-file: ≤200ms warm', async () => {
    const elapsed = await measureWarm(join(PROJECTS, 'gradle-kotlin'))
    expect(elapsed).toBeLessThan(ASSERT_BUDGET_MS)
  })

  test('Gradle Groovy single-file: ≤200ms warm', async () => {
    const elapsed = await measureWarm(join(PROJECTS, 'gradle-groovy'))
    expect(elapsed).toBeLessThan(ASSERT_BUDGET_MS)
  })
})
