import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const M2_ENV = 'PLEASEAI_SPRING_M2_ROOT'
const GRADLE_CACHES_ENV = 'PLEASEAI_SPRING_GRADLE_CACHES'
const CACHE_HOME_ENV = 'PLEASEAI_SPRING_CACHE_HOME'

const SETTINGS_WITH_PUBLISHED_CATALOG = `dependencyResolutionManagement {
  versionCatalogs {
    create("libs") {
      from("com.example:platform-catalog:1.0.0")
    }
  }
}
`

const BUILD_USING_CATALOG = `plugins {
  id("org.springframework.boot") version libs.versions.spring.boot.get()
}
`

function TOML_WITH_SPRING_BOOT(version: string): string {
  return `[versions]
spring-boot = "${version}"
junit = "5.10.0"
`
}

describe('FR-16: published catalog cache-first lookup', () => {
  let saved: Record<string, string | undefined>
  let homeRoot: string

  beforeEach(() => {
    saved = {
      m2: process.env[M2_ENV],
      gradle: process.env[GRADLE_CACHES_ENV],
      cache: process.env[CACHE_HOME_ENV],
    }
    homeRoot = mkdtempSync(join(tmpdir(), 'detect-pubcat-home-'))
    process.env[CACHE_HOME_ENV] = homeRoot
  })

  afterEach(() => {
    for (const [k, env] of [['m2', M2_ENV], ['gradle', GRADLE_CACHES_ENV], ['cache', CACHE_HOME_ENV]] as const) {
      if (saved[k] === undefined)
        delete process.env[env]
      else process.env[env] = saved[k]!
    }
    rmSync(homeRoot, { recursive: true, force: true })
  })

  test('m2 cache hit: published catalog resolves to detected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pubcat-m2-'))
    const m2 = join(root, 'm2-repo')
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'settings.gradle.kts'), SETTINGS_WITH_PUBLISHED_CATALOG)
      writeFileSync(join(project, 'build.gradle.kts'), BUILD_USING_CATALOG)

      // Populate m2 with the catalog .toml
      const catDir = join(m2, 'com', 'example', 'platform-catalog', '1.0.0')
      mkdirSync(catDir, { recursive: true })
      writeFileSync(join(catDir, 'platform-catalog-1.0.0.toml'), TOML_WITH_SPRING_BOOT('3.4.1'))

      process.env[M2_ENV] = m2
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.1')
        expect(result.source.file).toContain('platform-catalog-1.0.0.toml')
        expect(result.source.locator).toContain('published catalog')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Gradle hashed cache hit: catalog resolved from modules-2/files-2.1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pubcat-gradle-'))
    const gradleCaches = join(root, 'gradle-caches')
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'settings.gradle.kts'), SETTINGS_WITH_PUBLISHED_CATALOG)
      writeFileSync(join(project, 'build.gradle.kts'), BUILD_USING_CATALOG)

      // Populate Gradle hashed cache
      const versionDir = join(gradleCaches, 'modules-2', 'files-2.1', 'com.example', 'platform-catalog', '1.0.0')
      const sha1Dir = join(versionDir, 'abcdef0123456789abcdef0123456789abcdef01')
      mkdirSync(sha1Dir, { recursive: true })
      writeFileSync(join(sha1Dir, 'platform-catalog-1.0.0.toml'), TOML_WITH_SPRING_BOOT('3.2.7'))

      process.env[GRADLE_CACHES_ENV] = gradleCaches
      // Empty m2 so it falls through.
      process.env[M2_ENV] = join(root, 'empty-m2')
      mkdirSync(process.env[M2_ENV])
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.2.7')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('plugin-owned cache hit (~/.cache/pleaseai-spring/catalogs/)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pubcat-owned-'))
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'settings.gradle.kts'), SETTINGS_WITH_PUBLISHED_CATALOG)
      writeFileSync(join(project, 'build.gradle.kts'), BUILD_USING_CATALOG)

      // Empty m2 + gradle.
      const m2 = join(root, 'empty-m2')
      const gradleCaches = join(root, 'empty-gradle')
      mkdirSync(m2)
      mkdirSync(gradleCaches)
      process.env[M2_ENV] = m2
      process.env[GRADLE_CACHES_ENV] = gradleCaches
      // Populate plugin-owned cache (under homeRoot/.cache/pleaseai-spring).
      const ownedDir = join(homeRoot, '.cache', 'pleaseai-spring', 'catalogs')
      mkdirSync(ownedDir, { recursive: true })
      writeFileSync(join(ownedDir, 'platform-catalog-1.0.0.toml'), TOML_WITH_SPRING_BOOT('3.0.5'))

      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.0.5')
        expect(result.source.file).toContain('catalogs')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('full cache miss: detection falls through to other sources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pubcat-miss-'))
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'settings.gradle.kts'), SETTINGS_WITH_PUBLISHED_CATALOG)
      writeFileSync(join(project, 'build.gradle.kts'), BUILD_USING_CATALOG)

      const m2 = join(root, 'empty-m2')
      const gradleCaches = join(root, 'empty-gradle')
      mkdirSync(m2)
      mkdirSync(gradleCaches)
      process.env[M2_ENV] = m2
      process.env[GRADLE_CACHES_ENV] = gradleCaches
      // homeRoot is fresh and has no catalogs/

      const result = await detect(project)
      // Catalog reference unresolved + no other version source → not-found.
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('settings without versionCatalogs.create.from is a no-op', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pubcat-empty-settings-'))
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(join(project, 'settings.gradle.kts'), `rootProject.name = "demo"\n`)
      writeFileSync(join(project, 'build.gradle.kts'), BUILD_USING_CATALOG)
      const result = await detect(project)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
