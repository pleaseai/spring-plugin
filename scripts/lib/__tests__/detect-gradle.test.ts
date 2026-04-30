import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { parseGradle } from '../detect-gradle.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'detect', 'gradle')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8')
}

describe('parseGradle', () => {
  test('FR-3 (Groovy): detects plugins { id ... version "..." }', () => {
    const { result, hints } = parseGradle(fixture('groovy-plugins-block.gradle'), 'build.gradle')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.5')
      expect(result.source.file).toBe('build.gradle')
      expect(result.source.locator).toMatch(/plugins/i)
      expect(typeof result.source.line).toBe('number')
    }
    expect(hints.pluginReferenced).toBe(true)
  })

  test('FR-3 (Groovy): detects apply plugin + buildscript ext.springBootVersion', () => {
    const { result } = parseGradle(fixture('groovy-apply-plugin.gradle'), 'build.gradle')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('2.7.18')
      expect(result.source.locator).toMatch(/buildscript|ext/i)
    }
  })

  test('FR-3 (Groovy): detects buildscript with ext[\'spring-boot.version\'] form', () => {
    const { result } = parseGradle(
      fixture('groovy-buildscript-ext.gradle'),
      'build.gradle',
    )
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.1.5')
    }
  })

  test('FR-4 (Kotlin): detects plugins { id("...") version "..." }', () => {
    const { result, hints } = parseGradle(
      fixture('kotlin-plugins-block.gradle.kts'),
      'build.gradle.kts',
    )
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.3.0')
      expect(result.source.file).toBe('build.gradle.kts')
    }
    expect(hints.pluginReferenced).toBe(true)
  })

  test('returns not-found for build.gradle without Spring Boot', () => {
    const { result, hints } = parseGradle(fixture('no-spring.gradle'), 'build.gradle')
    expect(result.kind).toBe('not-found')
    if (result.kind === 'not-found') {
      expect(result.suggestion).toContain('--boot')
    }
    expect(hints.pluginReferenced).toBe(false)
  })

  test('FR-9: catalog reference (no literal version) → not-found + catalogReference hint', () => {
    const { result, hints } = parseGradle(
      fixture('catalog-reference.gradle.kts'),
      'build.gradle.kts',
    )
    // Parser cannot resolve catalogs; orchestrator (T011) resolves them. The parser
    // emits a hint and returns not-found so the orchestrator can attempt resolution
    // before giving up with kind:'unsupported'.
    expect(result.kind).toBe('not-found')
    expect(hints.pluginReferenced).toBe(true)
    expect(hints.catalogReference).toEqual({ aliasPath: 'spring.boot' })
  })

  test('property reference ($name placeholder) → not-found + propertyReference hint', () => {
    const { result, hints } = parseGradle(
      fixture('property-reference.gradle'),
      'build.gradle',
    )
    expect(result.kind).toBe('not-found')
    expect(hints.pluginReferenced).toBe(true)
    expect(hints.propertyReference).toEqual({ name: 'springBootVersion' })
  })

  test('Groovy plugins block with double-quoted version is supported', () => {
    const src = `plugins {
  id "org.springframework.boot" version "3.4.1"
}`
    const { result } = parseGradle(src, 'build.gradle')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.4.1')
    }
  })

  test('Kotlin DSL with single quotes (rare but valid) is detected', () => {
    const src = `plugins {
  id('org.springframework.boot') version '3.0.5'
}`
    const { result } = parseGradle(src, 'build.gradle.kts')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.0.5')
    }
  })

  test('plugin block missing version literal but plugin id present → pluginReferenced hint', () => {
    const src = `plugins {
  id 'org.springframework.boot'
}`
    const { result, hints } = parseGradle(src, 'build.gradle')
    expect(result.kind).toBe('not-found')
    expect(hints.pluginReferenced).toBe(true)
  })

  test('FR-17 input: $revision interpolation is detected as property reference (orchestrator emits requires-build-tool)', () => {
    const src = `plugins {
  id 'org.springframework.boot' version "\${revision}"
}`
    const { result, hints } = parseGradle(src, 'build.gradle')
    expect(result.kind).toBe('not-found')
    expect(hints.propertyReference?.name).toBe('revision')
  })
})
