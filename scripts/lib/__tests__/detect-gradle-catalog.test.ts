import { describe, expect, test } from 'bun:test'

import { parseProperties, resolveCatalogVersion, resolveProperty } from '../detect-gradle-catalog.ts'

describe('resolveCatalogVersion', () => {
  test('reads literal alias from [versions] table', () => {
    const toml = `[versions]
spring-boot = "3.4.2"
junit = "5.10.0"

[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }
`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBe('3.4.2')
  })

  test('handles single-quoted values', () => {
    const toml = `[versions]\nspring-boot = '3.3.5'\n`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBe('3.3.5')
  })

  test('handles dotted alias path with kebab-case key', () => {
    const toml = `[versions]\nspring-boot-version = "3.2.0"\n`
    expect(resolveCatalogVersion(toml, 'spring.boot.version')).toBe('3.2.0')
  })

  test('handles camelCase key when alias path has no dots', () => {
    const toml = `[versions]\nspringBoot = "3.1.5"\n`
    expect(resolveCatalogVersion(toml, 'springBoot')).toBe('3.1.5')
  })

  test('returns undefined when alias not found', () => {
    const toml = `[versions]\njunit = "5.10.0"\n`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBeUndefined()
  })

  test('returns undefined when no [versions] table', () => {
    const toml = `[plugins]\nspring-boot = { id = "org.springframework.boot" }\n`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBeUndefined()
  })

  test('skips other tables and stops at next [section]', () => {
    const toml = `[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "spring-boot" }

[versions]
spring-boot = "3.4.0"

[libraries]
boot-starter = "org.springframework.boot:spring-boot-starter"
`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBe('3.4.0')
  })

  test('ignores commented-out keys', () => {
    const toml = `[versions]
# spring-boot = "2.7.18"
spring-boot = "3.4.0"
`
    expect(resolveCatalogVersion(toml, 'spring.boot')).toBe('3.4.0')
  })

  test('returns undefined for empty input', () => {
    expect(resolveCatalogVersion('', 'spring.boot')).toBeUndefined()
  })
})

describe('parseProperties / resolveProperty', () => {
  test('parses key=value pairs', () => {
    const props = `springBootVersion=3.2.5
junit.version=5.10.0
`
    expect(parseProperties(props)).toEqual({
      'springBootVersion': '3.2.5',
      'junit.version': '5.10.0',
    })
  })

  test('handles quoted values and trims', () => {
    const props = `  spring-boot.version = '3.3.0'\n`
    expect(resolveProperty(props, 'spring-boot.version')).toBe('3.3.0')
  })

  test('handles double-quoted values', () => {
    const props = `springBootVersion="3.0.13"\n`
    expect(resolveProperty(props, 'springBootVersion')).toBe('3.0.13')
  })

  test('skips comment lines starting with # or !', () => {
    const props = `# default version
! deprecated
springBootVersion=3.2.0
`
    expect(resolveProperty(props, 'springBootVersion')).toBe('3.2.0')
  })

  test('returns undefined for missing key', () => {
    expect(resolveProperty('foo=bar\n', 'springBootVersion')).toBeUndefined()
  })

  test('later occurrences override earlier ones (gradle properties override semantics)', () => {
    const props = `springBootVersion=3.0.0
springBootVersion=3.4.5
`
    expect(resolveProperty(props, 'springBootVersion')).toBe('3.4.5')
  })

  test('treats empty input gracefully', () => {
    expect(resolveProperty('', 'foo')).toBeUndefined()
    expect(parseProperties('')).toEqual({})
  })
})
