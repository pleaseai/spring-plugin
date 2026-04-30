import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { clearBootOverride, detect, grantBootOverride } from '../detect.ts'

const CACHE_ENV = 'PLEASEAI_SPRING_CACHE_HOME'

describe('FR-15: --boot override persistence and short-circuit', () => {
  let savedCache: string | undefined
  let homeRoot: string

  beforeEach(() => {
    savedCache = process.env[CACHE_ENV]
    homeRoot = mkdtempSync(join(tmpdir(), 'detect-override-home-'))
    process.env[CACHE_ENV] = homeRoot
  })
  afterEach(() => {
    if (savedCache === undefined)
      delete process.env[CACHE_ENV]
    else process.env[CACHE_ENV] = savedCache
    rmSync(homeRoot, { recursive: true, force: true })
  })

  test('grant + detect: returns version with overrides.json source', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-proj-'))
    try {
      // No build files. Without an override, detect would return not-found.
      grantBootOverride(project, '3.4.0')
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.0')
        expect(result.source.file).toContain('overrides.json')
        expect(result.source.locator).toMatch(/--boot override.*granted/)
      }
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('override short-circuits even when build files would detect a different version', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-shortcircuit-'))
    try {
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?><project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>2.7.0</version>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      grantBootOverride(project, '3.5.5')
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.5.5')
      }
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('clear: subsequent detect runs the normal pipeline', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-clear-'))
    try {
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?><project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.0.1</version>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      grantBootOverride(project, '4.0.0')
      let result = await detect(project)
      expect(result.kind === 'detected' && result.version).toBe('4.0.0')

      clearBootOverride(project)
      result = await detect(project)
      expect(result.kind === 'detected' && result.version).toBe('3.0.1')
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('grant + grant refreshes the version (timestamp updates)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-refresh-'))
    try {
      grantBootOverride(project, '3.0.0')
      const overridesPath = join(homeRoot, '.cache', 'pleaseai-spring', 'overrides.json')
      const first = JSON.parse(readFileSync(overridesPath, 'utf8'))
      // Bun is fast; ensure ts diffs by waiting one ms.
      await new Promise(r => setTimeout(r, 5))
      grantBootOverride(project, '3.4.0')
      const second = JSON.parse(readFileSync(overridesPath, 'utf8'))
      const k = Object.keys(first)[0]
      expect(k).toBeDefined()
      const firstK = k!
      expect(first[firstK].version).toBe('3.0.0')
      expect(second[firstK].version).toBe('3.4.0')
      expect(second[firstK].grantedAt).not.toBe(first[firstK].grantedAt)
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('FR-8: stored source.file is an absolute path (no literal ~/)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-abs-'))
    try {
      grantBootOverride(project, '3.2.0')
      const result = await detect(project)
      if (result.kind === 'detected') {
        expect(result.source.file.startsWith('~/')).toBe(false)
        // Either truly absolute (Linux/macOS) or a Windows-style absolute path.
        expect(resolvePath(result.source.file)).toBe(result.source.file)
      }
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('clear is a no-op when overrides.json does not exist', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-override-clear-noop-'))
    try {
      clearBootOverride(project) // should not throw
      // No file should be created from a no-op clear.
      const overridesPath = join(homeRoot, '.cache', 'pleaseai-spring', 'overrides.json')
      expect(() => readFileSync(overridesPath, 'utf8')).toThrow()
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

describe('FR-15 CLI integration', () => {
  let savedCache: string | undefined
  let homeRoot: string
  const SCRIPT = join(import.meta.dir, '..', 'detect.ts')

  beforeEach(() => {
    savedCache = process.env[CACHE_ENV]
    homeRoot = mkdtempSync(join(tmpdir(), 'detect-cli-home-'))
    process.env[CACHE_ENV] = homeRoot
  })
  afterEach(() => {
    if (savedCache === undefined)
      delete process.env[CACHE_ENV]
    else process.env[CACHE_ENV] = savedCache
    rmSync(homeRoot, { recursive: true, force: true })
  })

  test('--boot grants and detection short-circuits via override', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-cli-grant-'))
    try {
      const proc = Bun.spawn(
        ['bun', 'run', SCRIPT, project, '--boot', '3.4.9'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, [CACHE_ENV]: homeRoot },
        },
      )
      const stdout = await new Response(proc.stdout).text()
      const exit = await proc.exited
      expect(exit).toBe(0)
      const parsed = JSON.parse(stdout)
      expect(parsed.kind).toBe('detected')
      expect(parsed.version).toBe('3.4.9')
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test('--clear-override on its own: clears and runs detection (returns not-found for empty dir)', async () => {
    const project = mkdtempSync(join(tmpdir(), 'detect-cli-clear-'))
    try {
      // Pre-grant via library so the override is present.
      grantBootOverride(project, '3.0.0')
      const proc = Bun.spawn(
        ['bun', 'run', SCRIPT, project, '--clear-override'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { ...process.env, [CACHE_ENV]: homeRoot },
        },
      )
      const stdout = await new Response(proc.stdout).text()
      const exit = await proc.exited
      expect(exit).toBe(1) // not-found (cleared)
      const parsed = JSON.parse(stdout)
      expect(parsed.kind).toBe('not-found')
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
