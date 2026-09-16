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
 * Each reader below takes the *active* setting, never the file's raw text: a
 * commented-out exclusion still contains a pattern that would match, so a text
 * scan passes while the analyser receives nothing — the same blind spot one
 * level down. ESLint's is read from the evaluated config, and the other two
 * from a line that a leading `#` disqualifies.
 *
 * `Bun.Glob` stands in for three matchers it is not, so a pass is not proof
 * that SonarCloud reads a pattern the same way. What it does catch is the
 * failure that actually happened: a pattern that matches no bundle at all.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..', '..')

/** The committed bundles every exclusion below is supposed to cover. */
const BUNDLES = Array.from(new Bun.Glob('skills/*/scripts/*.mjs').scanSync(ROOT), p => p.replaceAll('\\', '/'))

/**
 * Split on `\r?\n`, not `\n`: the repository carries no `.gitattributes`, so a
 * Windows checkout with `core.autocrlf=true` leaves a `\r` on every value, and
 * a pattern ending in `\r` matches no bundle — a false failure that reads
 * exactly like the misconfiguration this file exists to catch.
 */
async function lines(file: string): Promise<string[]> {
  return (await Bun.file(join(ROOT, file)).text()).split(/\r?\n/)
}

/** The patterns `.sonarcloud.properties` sets for `key`, as a `key=a,b` line. */
async function sonarExclusions(key: string): Promise<string[]> {
  // A commented-out setting starts with `#`, so it never matches the key prefix.
  const line = (await lines('.sonarcloud.properties')).find(l => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).split(',').map(v => v.trim()).filter(Boolean) : []
}

/** The `skills/` entries of `.codacy.yml`'s `exclude_paths:` block. */
async function codacyExclusions(): Promise<string[]> {
  const source = await lines('.codacy.yml')
  const start = source.findIndex(l => l.startsWith('exclude_paths:'))
  expect(start).toBeGreaterThanOrEqual(0)

  const patterns: string[] = []
  for (const line of source.slice(start + 1)) {
    const entry = /^\s+-\s*'([^']+)'/.exec(line)
    if (entry) {
      patterns.push(entry[1] ?? '')
      continue
    }
    // A comment or a blank line sits inside the block; anything else ends it.
    if (line.trim() !== '' && !line.trimStart().startsWith('#'))
      break
  }
  return patterns.filter(p => p.startsWith('skills/'))
}

/** The `skills/` ignore patterns ESLint actually loads, off the evaluated config. */
async function eslintIgnores(): Promise<string[]> {
  const config = (await import(pathToFileURL(join(ROOT, 'eslint.config.js')).href)) as {
    default: { ignores?: string[] }[]
  }
  return config.default.flatMap(entry => entry.ignores ?? []).filter(p => p.startsWith('skills/'))
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

  test('.sonarcloud.properties excludes them from issues and duplication', async () => {
    expectCoversBundles(await sonarExclusions('sonar.exclusions'))
    expectCoversBundles(await sonarExclusions('sonar.cpd.exclusions'))
  })

  test('.codacy.yml excludes them', async () => {
    expectCoversBundles(await codacyExclusions())
  })

  test('eslint.config.js ignores them', async () => {
    expectCoversBundles(await eslintIgnores())
  })
})
