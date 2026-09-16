/**
 * Guards the analyser exclusions that keep `skills/<skill>/scripts/` out of Sonar,
 * Codacy and ESLint.
 *
 * The exclusion in ee09832 was written as a bare directory prefix
 * (`skills/spring-docs/scripts/`). Every analyser matches patterns against the
 * whole file path, so that prefix matched nothing and was dropped without a
 * warning — SonarCloud kept indexing 5,018 generated lines for two days before
 * anyone noticed. A pattern that matches no file looks identical to a pattern
 * that works, so assert the match instead of reading the config.
 *
 * `Bun.Glob` stands in for three matchers it is not, so a pass is not proof
 * that SonarCloud reads a pattern the same way. What it does catch is the
 * failure that actually happened: a pattern that matches no bundle at all.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..', '..')

/** The committed bundles every exclusion below is supposed to cover. */
const BUNDLES = Array.from(new Bun.Glob('skills/*/scripts/*.mjs').scanSync(ROOT), p => p.replaceAll('\\', '/'))

function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
}

/** Values of a `key=a,b` line in a `.properties` file. */
function properties(source: string, key: string): string[] {
  const line = source.split('\n').find(l => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).split(',').filter(Boolean) : []
}

/** Every single-quoted `skills/.../scripts/...` pattern in a config file. */
function skillPatterns(source: string): string[] {
  return Array.from(source.matchAll(/'(skills\/[^']*scripts[^']*)'/g), m => m[1]!)
}

function expectCoversBundles(patterns: string[]): void {
  expect(patterns.length).toBeGreaterThan(0)
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for (const bundle of BUNDLES) expect([pattern, bundle, glob.match(bundle)]).toEqual([pattern, bundle, true])
  }
}

describe('generated bundle exclusions', () => {
  test('the bundles the exclusions target are committed', () => {
    // A Set, because `Bun.Glob.scanSync` fixes no traversal order.
    expect(new Set(BUNDLES)).toEqual(new Set(['skills/spring-docs/scripts/detect.mjs', 'skills/spring-docs/scripts/docs.mjs']))
  })

  test('.sonarcloud.properties excludes them from issues and duplication', () => {
    const source = read('.sonarcloud.properties')
    expectCoversBundles(properties(source, 'sonar.exclusions'))
    expectCoversBundles(properties(source, 'sonar.cpd.exclusions'))
  })

  test('.codacy.yml excludes them', () => {
    expectCoversBundles(skillPatterns(read('.codacy.yml')))
  })

  test('eslint.config.js ignores them', () => {
    expectCoversBundles(skillPatterns(read('eslint.config.js')))
  })
})
