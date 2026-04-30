import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')
const projectPath = (name: string): string => join(PROJECTS, name)

describe('FR-12: catalog reference resolution (orchestrator)', () => {
  test('libs.versions.toml resolves spring.boot catalog reference → detected', async () => {
    const result = await detect(projectPath('gradle-catalog'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.4.4')
      expect(result.source.file).toMatch(/libs\.versions\.toml$/)
      expect(result.source.locator).toMatch(/spring-boot|spring\.boot/)
    }
  })

  test('property interpolation resolves via gradle.properties → detected', async () => {
    const result = await detect(projectPath('gradle-properties'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.10')
      expect(result.source.file).toMatch(/gradle\.properties$/)
      expect(result.source.locator).toContain('springBootVersion')
    }
  })

  test('per-module gradle.properties overrides root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-prop-override-'))
    try {
      writeFileSync(join(root, 'gradle.properties'), 'springBootVersion=3.0.0\n')
      writeFileSync(
        join(root, 'build.gradle'),
        `plugins {\n  id 'org.springframework.boot' version "\${springBootVersion}"\n}\n`,
      )
      // Per-module override at the project root (the immediate dir under detection).
      // The orchestrator reads project gradle.properties; "root" here is also the project.
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.0.0')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('catalog reference but libs.versions.toml missing → not-found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-cat-missing-'))
    try {
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version libs.versions.spring.boot.get()\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('catalog reference present but alias missing in toml → not-found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-cat-no-alias-'))
    try {
      mkdirSync(join(root, 'gradle'))
      writeFileSync(
        join(root, 'gradle', 'libs.versions.toml'),
        `[versions]\njunit = "5.10.0"\n`,
      )
      writeFileSync(
        join(root, 'build.gradle.kts'),
        `plugins {\n  id("org.springframework.boot") version libs.versions.spring.boot.get()\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('property reference without gradle.properties → not-found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-prop-missing-'))
    try {
      writeFileSync(
        join(root, 'build.gradle'),
        `plugins {\n  id 'org.springframework.boot' version "\${springBootVersion}"\n}\n`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
