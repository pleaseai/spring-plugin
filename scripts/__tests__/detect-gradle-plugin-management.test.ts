import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

describe('FR-13: pluginManagement in settings.gradle(.kts) (orchestrator)', () => {
  test('settings.gradle.kts pluginManagement → detected, short-circuits subproject walk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pm-'))
    try {
      mkdirSync(join(root, 'app'))
      writeFileSync(
        join(root, 'settings.gradle.kts'),
        `pluginManagement {
  plugins {
    id("org.springframework.boot") version "3.4.6"
  }
}

include("app")
`,
      )
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins { java }\n`,
      )
      // app subproject also has Boot but a *different* version. pluginManagement
      // should win because FR-13 orders it before the subproject walk.
      writeFileSync(
        join(root, 'app', 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version "3.0.0"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.6')
        expect(result.source.file).toBe('settings.gradle.kts')
        expect(result.source.locator).toMatch(/pluginManagement/)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('settings.gradle (Groovy) pluginManagement → detected', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pm-groovy-'))
    try {
      writeFileSync(
        join(root, 'settings.gradle'),
        `pluginManagement {\n  plugins {\n    id 'org.springframework.boot' version '3.1.9'\n  }\n}\n`,
      )
      writeFileSync(join(root, 'build.gradle'), `plugins { id 'java' }\n`)
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.1.9')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('pluginManagement without spring-boot does NOT short-circuit; multi-module walk still runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-pm-fallthrough-'))
    try {
      mkdirSync(join(root, 'svc'))
      writeFileSync(
        join(root, 'settings.gradle.kts'),
        `pluginManagement {\n  plugins {\n    id("io.spring.dependency-management") version "1.1.5"\n  }\n}\ninclude("svc")\n`,
      )
      writeFileSync(join(root, 'build.gradle.kts'), `plugins { java }\n`)
      writeFileSync(
        join(root, 'svc', 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version "3.2.4"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.2.4')
        expect(result.source.file).toContain('svc')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
