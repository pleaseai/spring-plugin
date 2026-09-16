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
 * level down. Each reader therefore drops the file's comment lines before it
 * takes anything from them.
 *
 * `Bun.Glob` stands in for three matchers it is not, so a pass is not proof
 * that SonarCloud reads a pattern the same way. What it does catch is the
 * failure that actually happened: a pattern that matches no bundle at all.
 */
import { join } from 'node:path'

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

/**
 * The patterns `.sonarcloud.properties` sets for `key`, as a `key=a,b` line.
 *
 * `.properties` allows whitespace around the `=` and before the key, so match
 * that rather than a bare prefix — a reformatted file should not fail the
 * guard. A commented-out setting starts with `#`, which the anchor rejects.
 */
async function sonarExclusions(key: string): Promise<string[]> {
  const setting = new RegExp(`^\\s*${key.replaceAll('.', '\\.')}\\s*=`)
  const line = (await lines('.sonarcloud.properties')).find(l => setting.test(l))
  // The first `=` is the separator; no exclusion pattern contains one.
  return line ? line.slice(line.indexOf('=') + 1).split(',').map(v => v.trim()).filter(Boolean) : []
}

/** The `skills/` entries of `.codacy.yml`'s `exclude_paths:` block. */
async function codacyExclusions(): Promise<string[]> {
  const source = await lines('.codacy.yml')
  const start = source.findIndex(l => l.startsWith('exclude_paths:'))
  expect(start).toBeGreaterThanOrEqual(0)

  const patterns: string[] = []
  for (const line of source.slice(start + 1)) {
    const entry = line.trim()
    if (entry.startsWith('- ')) {
      // Strip the quotes YAML does not require here; single, double, or none.
      patterns.push(entry.slice(2).trim().replace(/^["']|["']$/g, ''))
      continue
    }
    // A comment or a blank line sits inside the block; anything else ends it.
    if (entry !== '' && !entry.startsWith('#'))
      break
  }
  return patterns.filter(p => p.startsWith('skills/'))
}

/**
 * The `skills/` ignore patterns in `eslint.config.js`'s `ignores` array.
 *
 * Read as text with comment lines dropped, not by importing the module. The
 * evaluated config would be the stronger source, but reaching it needs either a
 * non-literal dynamic `import()` or `allowJs` in `tsconfig.json`, and neither is
 * worth a project-wide change here. Dropping `//` lines closes the gap that
 * matters: a commented-out ignore no longer supplies a pattern that passes.
 */
async function eslintIgnores(): Promise<string[]> {
  return (await lines('eslint.config.js'))
    .map(l => l.trim())
    .filter(l => !l.startsWith('//') && l.startsWith('\'skills/'))
    .map(l => l.slice(1, l.indexOf('\'', 1)))
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
