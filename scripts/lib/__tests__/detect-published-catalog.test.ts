import { describe, expect, test } from 'bun:test'

import {
  gradleCacheCatalogDir,
  m2CatalogPath,
  parsePublishedCatalogs,
  pleaseaiCatalogCachePath,
} from '../detect-published-catalog.ts'

describe('parsePublishedCatalogs', () => {
  test('Kotlin: dependencyResolutionManagement.versionCatalogs.create.from', () => {
    const src = `dependencyResolutionManagement {
  versionCatalogs {
    create("libs") {
      from("com.example:platform-catalog:1.0.0")
    }
  }
}`
    expect(parsePublishedCatalogs(src)).toEqual([
      {
        alias: 'libs',
        group: 'com.example',
        artifact: 'platform-catalog',
        version: '1.0.0',
      },
    ])
  })

  test('Groovy syntax (single quotes)', () => {
    const src = `dependencyResolutionManagement {
  versionCatalogs {
    create('springLibs') {
      from('org.example:spring-catalog:2.5.0')
    }
  }
}`
    expect(parsePublishedCatalogs(src)).toEqual([
      {
        alias: 'springLibs',
        group: 'org.example',
        artifact: 'spring-catalog',
        version: '2.5.0',
      },
    ])
  })

  test('multiple catalogs in one block', () => {
    const src = `dependencyResolutionManagement {
  versionCatalogs {
    create("libs") { from("com.example:catalog:1.0") }
    create("toolsLibs") { from("com.tools:tooling-catalog:0.5") }
  }
}`
    expect(parsePublishedCatalogs(src)).toEqual([
      { alias: 'libs', group: 'com.example', artifact: 'catalog', version: '1.0' },
      { alias: 'toolsLibs', group: 'com.tools', artifact: 'tooling-catalog', version: '0.5' },
    ])
  })

  test('returns [] when no versionCatalogs block', () => {
    expect(parsePublishedCatalogs('rootProject.name = "demo"')).toEqual([])
  })

  test('skips create() blocks that do NOT call from(...)', () => {
    const src = `versionCatalogs {
  create("inline") {
    version("foo", "1.0")
  }
  create("published") {
    from("com.example:c:1.0")
  }
}`
    expect(parsePublishedCatalogs(src)).toEqual([
      { alias: 'published', group: 'com.example', artifact: 'c', version: '1.0' },
    ])
  })
})

describe('cache path builders', () => {
  test('m2CatalogPath builds standard layout for a .toml artifact', () => {
    const p = m2CatalogPath('com.example', 'catalog', '1.0', '/home/u/.m2/repository')
    expect(p).toBe('/home/u/.m2/repository/com/example/catalog/1.0/catalog-1.0.toml')
  })

  test('gradleCacheCatalogDir returns the parent dir under modules-2/files-2.1', () => {
    const p = gradleCacheCatalogDir('com.example', 'catalog', '1.0', '/home/u/.gradle/caches')
    expect(p).toBe(
      '/home/u/.gradle/caches/modules-2/files-2.1/com.example/catalog/1.0',
    )
  })

  test('pleaseaiCatalogCachePath uses our own catalogs/ subdir and includes the group to avoid collisions', () => {
    const p = pleaseaiCatalogCachePath('com.example', 'catalog', '1.0', '/home/u/.cache/pleaseai-spring')
    expect(p).toBe('/home/u/.cache/pleaseai-spring/catalogs/com.example-catalog-1.0.toml')
  })

  test('pleaseaiCatalogCachePath produces distinct paths for two publishers of the same artifact', () => {
    const a = pleaseaiCatalogCachePath('com.example', 'catalog', '1.0', '/c')
    const b = pleaseaiCatalogCachePath('org.other', 'catalog', '1.0', '/c')
    expect(a).not.toBe(b)
  })
})
