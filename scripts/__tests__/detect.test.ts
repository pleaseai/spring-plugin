import type { DetectResult } from '../lib/detect-types.ts'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'
import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')
const projectPath = (name: string): string => join(PROJECTS, name)

describe('detect (orchestrator)', () => {
  test('Maven starter-parent project → detected', async () => {
    const result = await detect(projectPath('maven-starter'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.1')
      expect(result.source.file).toBe('pom.xml')
    }
  })

  test('Maven BOM-import project → detected', async () => {
    const result = await detect(projectPath('maven-bom'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.3.5')
    }
  })

  test('Gradle Groovy plugins-block → detected', async () => {
    const result = await detect(projectPath('gradle-groovy'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.5')
      expect(result.source.file).toBe('build.gradle')
    }
  })

  test('Gradle Kotlin DSL plugins-block → detected', async () => {
    const result = await detect(projectPath('gradle-kotlin'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.3.0')
      expect(result.source.file).toBe('build.gradle.kts')
    }
  })

  test('FR-10: empty directory → not-found with --boot suggestion', async () => {
    const result = await detect(projectPath('empty'))
    expect(result.kind).toBe('not-found')
    if (result.kind === 'not-found') {
      expect(result.reason).toContain('No supported build file')
      expect(result.suggestion).toContain('--boot')
    }
  })

  test('valid pom.xml without Spring Boot → not-found with --boot suggestion (AC-2)', async () => {
    const result = await detect(projectPath('no-spring-maven'))
    expect(result.kind).toBe('not-found')
    if (result.kind === 'not-found') {
      expect(result.suggestion).toContain('--boot')
    }
  })

  test('malformed pom.xml → unsupported with --boot suggestion (AC-2)', async () => {
    const result = await detect(projectPath('malformed-pom'))
    expect(result.kind).toBe('unsupported')
    if (result.kind === 'unsupported') {
      expect(result.suggestion).toContain('--boot')
    }
  })

  test('FR-10: non-existent directory does not throw — returns not-found', async () => {
    const result = await detect(projectPath('does-not-exist-xyz'))
    expect(result.kind).toBe('not-found')
  })

  test('preference: when both pom.xml and build.gradle exist, pom.xml wins', async () => {
    // Fixtures aren't easily co-locatable; use Bun's fs to set up a tmp dir.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-pref-'))
    try {
      fs.writeFileSync(
        path.join(tmp, 'pom.xml'),
        `<?xml version="1.0"?><project><parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.4.2</version></parent></project>`,
      )
      fs.writeFileSync(
        path.join(tmp, 'build.gradle'),
        `plugins { id 'org.springframework.boot' version '3.0.0' }`,
      )
      const result: DetectResult = await detect(tmp)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.2')
      }
    }
    finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('detect CLI (FR-11, AC-3)', () => {
  const SCRIPT = join(import.meta.dir, '..', 'detect.ts')

  test('detected → exit 0, JSON to stdout', async () => {
    const proc = Bun.spawn(['bun', 'run', SCRIPT, projectPath('maven-starter')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exit = await proc.exited
    expect(exit).toBe(0)
    const parsed = JSON.parse(stdout) as DetectResult
    expect(parsed.kind).toBe('detected')
    if (parsed.kind === 'detected') {
      expect(parsed.version).toBe('3.2.1')
    }
  })

  test('not-found → exit 1', async () => {
    const proc = Bun.spawn(['bun', 'run', SCRIPT, projectPath('empty')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exit = await proc.exited
    expect(exit).toBe(1)
    const parsed = JSON.parse(stdout) as DetectResult
    expect(parsed.kind).toBe('not-found')
  })

  test('unsupported (malformed pom) → exit 1', async () => {
    const proc = Bun.spawn(['bun', 'run', SCRIPT, projectPath('malformed-pom')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(proc.stdout).text()
    const exit = await proc.exited
    expect(exit).toBe(1)
    const parsed = JSON.parse(stdout) as DetectResult
    expect(parsed.kind).toBe('unsupported')
  })

  test('missing argument → exit 2 with usage on stderr', async () => {
    const proc = Bun.spawn(['bun', 'run', SCRIPT], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stderr = await new Response(proc.stderr).text()
    const exit = await proc.exited
    expect(exit).toBe(2)
    expect(stderr).toMatch(/usage/i)
  })
})
