import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const M2_ENV = 'PLEASEAI_SPRING_M2_ROOT'

function SPRING_BOOT_BOM_POM(version: string): string {
  return `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${version}</version>
    <relativePath/>
  </parent>
  <groupId>com.acme</groupId>
  <artifactId>acme-platform-bom</artifactId>
  <version>1.0.0</version>
</project>`
}

describe('FR-14: Maven external parent via ~/.m2 cache', () => {
  let savedM2: string | undefined

  beforeEach(() => {
    savedM2 = process.env[M2_ENV]
  })
  afterEach(() => {
    if (savedM2 === undefined)
      delete process.env[M2_ENV]
    else process.env[M2_ENV] = savedM2
  })

  test('cache hit: external parent resolves to spring-boot-starter-parent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-m2-hit-'))
    const m2 = join(root, 'm2-repo')
    try {
      // Project POM declares com.acme:acme-platform-bom:1.0.0 as parent
      // (no relativePath that resolves on disk).
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>acme-platform-bom</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      // Populate m2 cache with the parent pom (which itself uses spring-boot-starter-parent).
      const parentDir = join(m2, 'com', 'acme', 'acme-platform-bom', '1.0.0')
      mkdirSync(parentDir, { recursive: true })
      writeFileSync(join(parentDir, 'acme-platform-bom-1.0.0.pom'), SPRING_BOOT_BOM_POM('3.4.7'))

      process.env[M2_ENV] = m2
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.4.7')
        // FR-8: out-of-project sources (~/.m2 cache hits) emit POSIX-absolute paths.
        expect(result.source.file.startsWith('/')).toBe(true)
        expect(result.source.file).toContain('m2-repo')
        expect(result.source.file.includes('~/')).toBe(false)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('cache miss: returns unsupported with external-parent-not-cached', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-m2-miss-'))
    const m2 = join(root, 'empty-m2')
    try {
      mkdirSync(m2)
      const project = join(root, 'project')
      mkdirSync(project)
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>missing-parent</artifactId>
    <version>9.9.9</version>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      process.env[M2_ENV] = m2
      const result = await detect(project)
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toContain('external-parent-not-cached')
        expect(result.reason).toContain('com.acme:missing-parent:9.9.9')
        expect(result.suggestion).toMatch(/--boot/)
        // Per spec, suggestion should hint at running the project build once.
        expect(result.suggestion).toMatch(/mvn|install|build/i)
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('relativePath that does not resolve falls back to m2 cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-m2-fallback-'))
    const m2 = join(root, 'm2-repo')
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>acme-platform-bom</artifactId>
    <version>2.0.0</version>
    <relativePath>../wrong-path/pom.xml</relativePath>
  </parent>
  <artifactId>app</artifactId>
</project>`,
      )
      const parentDir = join(m2, 'com', 'acme', 'acme-platform-bom', '2.0.0')
      mkdirSync(parentDir, { recursive: true })
      writeFileSync(
        join(parentDir, 'acme-platform-bom-2.0.0.pom'),
        SPRING_BOOT_BOM_POM('3.0.5'),
      )
      process.env[M2_ENV] = m2
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.0.5')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('cache hit but parent itself has no Boot → walks parent\'s parent (still respects hop bound)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-m2-chain-'))
    const m2 = join(root, 'm2-repo')
    try {
      const project = join(root, 'project')
      mkdirSync(project, { recursive: true })
      writeFileSync(
        join(project, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>top-bom</artifactId>
    <version>5.0.0</version>
  </parent>
  <artifactId>leaf</artifactId>
</project>`,
      )
      // top-bom 5.0.0 has its own parent pointing at platform-foundation 1.0.0
      const topDir = join(m2, 'com', 'acme', 'top-bom', '5.0.0')
      mkdirSync(topDir, { recursive: true })
      writeFileSync(
        join(topDir, 'top-bom-5.0.0.pom'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.acme</groupId>
    <artifactId>platform-foundation</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>top-bom</artifactId>
</project>`,
      )
      const foundationDir = join(m2, 'com', 'acme', 'platform-foundation', '1.0.0')
      mkdirSync(foundationDir, { recursive: true })
      writeFileSync(
        join(foundationDir, 'platform-foundation-1.0.0.pom'),
        SPRING_BOOT_BOM_POM('3.2.0'),
      )
      process.env[M2_ENV] = m2
      const result = await detect(project)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.2.0')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
