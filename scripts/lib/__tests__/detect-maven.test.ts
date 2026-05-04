import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { parsePom } from '../detect-maven.ts'

const FIXTURES = join(import.meta.dir, 'fixtures', 'detect', 'maven')

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.pom.xml`), 'utf8')
}

describe('parsePom', () => {
  test('FR-1: detects spring-boot-starter-parent', () => {
    const { result, hints } = parsePom(fixture('starter-parent'), 'pom.xml')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.1')
      expect(result.source.file).toBe('pom.xml')
      expect(result.source.locator).toContain('spring-boot-starter-parent')
    }
    expect(hints.parent).toBeUndefined()
  })

  test('FR-2: detects spring-boot-dependencies BOM in dependencyManagement', () => {
    const { result } = parsePom(fixture('bom-import'), 'pom.xml')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.3.5')
      expect(result.source.locator).toContain('spring-boot-dependencies')
    }
  })

  test('returns not-found for valid pom.xml without Spring Boot', () => {
    const { result, hints } = parsePom(fixture('no-spring'), 'pom.xml')
    expect(result.kind).toBe('not-found')
    if (result.kind === 'not-found') {
      expect(result.suggestion).toContain('--boot')
    }
    expect(hints.parent).toBeUndefined()
    expect(hints.modules).toBeUndefined()
  })

  test('returns unsupported with reason for malformed XML', () => {
    const { result } = parsePom(fixture('malformed'), 'pom.xml')
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reason).toMatch(/malformed|invalid|parse/i)
      expect(result.suggestion).toContain('--boot')
      expect(result.source?.file).toBe('pom.xml')
    }
  })

  test('emits parent hint with relativePath for sibling parent', () => {
    const { result, hints } = parsePom(fixture('sibling-relative-parent'), 'app/pom.xml')
    expect(result.kind).toBe('not-found')
    expect(hints.parent).toEqual({
      groupId: 'com.example',
      artifactId: 'parent-aggregator',
      version: '1.0.0',
      relativePath: '../parent/pom.xml',
    })
  })

  test('emits parent hint without relativePath for external parent (FR-14 input)', () => {
    const { result, hints } = parsePom(fixture('external-parent'), 'pom.xml')
    expect(result.kind).toBe('not-found')
    expect(hints.parent).toEqual({
      groupId: 'com.acme',
      artifactId: 'acme-platform-bom',
      version: '4.5.0',
    })
  })

  test('detects spring-boot-starter-parent even when relativePath is empty self-closing', () => {
    // starter-parent fixture has <relativePath/>; ensure parent hint is NOT emitted
    // because the version was already attributed to spring-boot.
    const { result, hints } = parsePom(fixture('starter-parent'), 'pom.xml')
    expect(result.kind).toBe('detected')
    expect(hints.parent).toBeUndefined()
  })

  test('exposes modules list for multi-module aggregator pom (FR-6 input)', () => {
    const xml = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.example</groupId>
  <artifactId>aggregator</artifactId>
  <version>1.0.0</version>
  <modules>
    <module>app</module>
    <module>shared</module>
  </modules>
</project>`
    const { result, hints } = parsePom(xml, 'pom.xml')
    expect(result.kind).toBe('not-found')
    expect(hints.modules).toEqual(['app', 'shared'])
  })

  test('treats spring-boot-starter-parent without version as unsupported', () => {
    const xml = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
  </parent>
</project>`
    const { result } = parsePom(xml, 'pom.xml')
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reason).toMatch(/version/i)
    }
  })

  test('detects via spring-boot-dependencies even when both parent and dependencyManagement present', () => {
    // Edge: parent points elsewhere but BOM imports spring-boot-dependencies.
    const xml = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>platform</artifactId>
    <version>1.0.0</version>
  </parent>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>3.4.0</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`
    const { result } = parsePom(xml, 'pom.xml')
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.4.0')
    }
  })

  test('FR-17: spring-boot-dependencies BOM with Maven property interpolation escalates to requires-build-tool', () => {
    const xml = `<?xml version="1.0"?>
<project>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>\${spring-boot.version}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`
    const { result } = parsePom(xml, 'pom.xml')
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.reason).toContain('requires-build-tool')
      expect(result.reason).toContain('Maven property interpolation')
    }
  })
})
