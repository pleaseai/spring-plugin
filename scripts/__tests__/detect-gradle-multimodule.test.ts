import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')
const projectPath = (name: string): string => join(PROJECTS, name)

describe('FR-7: Gradle multi-module walk', () => {
  test('root with no Boot walks settings.gradle.kts include() and finds Boot in subproject', async () => {
    const result = await detect(projectPath('gradle-multimodule'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.4.3')
      expect(result.source.file).toMatch(/app\/build\.gradle\.kts$/)
    }
  })

  test('Groovy settings include() with multiple subprojects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-grmm-'))
    try {
      mkdirSync(join(root, 'svc-a'))
      mkdirSync(join(root, 'svc-b'))
      writeFileSync(
        join(root, 'settings.gradle'),
        `rootProject.name = 'demo'\ninclude 'svc-a', 'svc-b'\n`,
      )
      writeFileSync(
        join(root, 'build.gradle'),
        `plugins { id 'java' }\n`,
      )
      writeFileSync(
        join(root, 'svc-a', 'build.gradle'),
        `plugins { id 'java' }\n`,
      )
      writeFileSync(
        join(root, 'svc-b', 'build.gradle'),
        `plugins {\n  id 'org.springframework.boot' version '3.1.0'\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.1.0')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('subproject directory missing → skipped silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-grmm-missing-'))
    try {
      writeFileSync(
        join(root, 'settings.gradle'),
        `include 'ghost'\n`,
      )
      writeFileSync(
        join(root, 'build.gradle'),
        `plugins { id 'java' }\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('subproject Boot wins when root build.gradle.kts also lacks Boot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-grmm-kotlin-'))
    try {
      mkdirSync(join(root, 'core'))
      writeFileSync(
        join(root, 'settings.gradle.kts'),
        `rootProject.name = "demo"\ninclude("core")\n`,
      )
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins { java }\n`,
      )
      writeFileSync(
        join(root, 'core', 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version "3.2.0"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.2.0')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('no settings.gradle(.kts) → orchestrator does not walk', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-grmm-no-settings-'))
    try {
      writeFileSync(join(root, 'build.gradle'), `plugins { id 'java' }\n`)
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('nested project path :a:b → looks under a/b/build.gradle(.kts)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-grmm-nested-'))
    try {
      mkdirSync(join(root, 'a', 'b'), { recursive: true })
      writeFileSync(
        join(root, 'settings.gradle.kts'),
        `include(":a:b")\n`,
      )
      writeFileSync(join(root, 'build.gradle.kts'), `plugins { java }\n`)
      writeFileSync(
        join(root, 'a', 'b', 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version "3.0.5"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.0.5')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
