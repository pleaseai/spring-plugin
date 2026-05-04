import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

describe('FR-17: requires-build-tool taxonomy', () => {
  test('Maven $revision property interpolation in <version> → requires-build-tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-rev-'))
    try {
      writeFileSync(
        join(root, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>\${revision}</version>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toContain('requires-build-tool')
        expect(result.suggestion).toMatch(/--boot/)
        // Suggestion must mention both the build-tool fallback (ADR-0002) and --boot override
        expect(result.suggestion.toLowerCase()).toMatch(/build[- ]?tool|maven|gradle/)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Gradle buildSrc/ present (no Boot resolved otherwise) → requires-build-tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-buildsrc-'))
    try {
      mkdirSync(join(root, 'buildSrc'))
      writeFileSync(
        join(root, 'buildSrc', 'build.gradle.kts'),
        `plugins { \`kotlin-dsl\` }\n`,
      )
      // Project's main build references the spring-boot plugin via buildSrc-defined alias.
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins { id("com.example.spring-conventions") }\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toContain('requires-build-tool')
        expect(result.reason).toMatch(/buildSrc/i)
        expect(result.suggestion).toMatch(/--boot/)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Gradle init.gradle.kts at project root → requires-build-tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-init-'))
    try {
      writeFileSync(join(root, 'init.gradle.kts'), `// custom init script\n`)
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins { java }\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toContain('requires-build-tool')
        expect(result.reason).toMatch(/init/i)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Gradle settings plugins (apply outside pluginManagement) → requires-build-tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-sp-'))
    try {
      writeFileSync(
        join(root, 'settings.gradle.kts'),
        `apply<MyCustomSettingsPlugin>()
include("app")
`,
      )
      writeFileSync(join(root, 'build.gradle.kts'), `plugins { java }\n`)
      mkdirSync(join(root, 'app'))
      writeFileSync(join(root, 'app', 'build.gradle.kts'), `plugins { java }\n`)
      const result = await detect(root)
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toContain('requires-build-tool')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('regular Gradle project without build-tool patterns: returns not-found, NOT requires-build-tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-clean-'))
    try {
      writeFileSync(join(root, 'build.gradle.kts'), `plugins { java }\n`)
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
      if (result.kind === 'not-found') {
        expect(result.reason).not.toContain('requires-build-tool')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('Gradle buildSrc + Boot detected via plugins block → still detects (buildSrc only escalates when no other source)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-rbt-buildsrc-but-detected-'))
    try {
      mkdirSync(join(root, 'buildSrc'))
      writeFileSync(
        join(root, 'buildSrc', 'build.gradle.kts'),
        `plugins { \`kotlin-dsl\` }\n`,
      )
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version "3.4.2"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.2')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
