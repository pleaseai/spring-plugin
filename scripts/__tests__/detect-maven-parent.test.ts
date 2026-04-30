import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')
const projectPath = (name: string): string => join(PROJECTS, name)

function SPRING_PARENT_POM(version: string): string {
  return `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>${version}</version>
    <relativePath/>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>p</artifactId>
  <version>1.0.0</version>
</project>`
}

function CHILD_POM_WITH_RELATIVE(relPath: string): string {
  return `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>p</artifactId>
    <version>1.0.0</version>
    <relativePath>${relPath}</relativePath>
  </parent>
  <artifactId>c</artifactId>
</project>`
}

describe('FR-5: Maven parent POM inheritance traversal', () => {
  test('one-hop sibling parent with spring-boot-starter-parent → detected', async () => {
    const result = await detect(projectPath('maven-parent-sibling/leaf'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.4.1')
      expect(result.source.locator).toContain('spring-boot-starter-parent')
      // Source should reflect that the version came from the parent file.
      expect(result.source.file).toMatch(/pom\.xml$/)
    }
  })

  test('two-hop chain (grandparent has version) → detected at the leaf', async () => {
    const result = await detect(projectPath('maven-parent-grandparent/a/b'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.0.13')
    }
  })

  test('exceeds 5-hop bound → unsupported with parent-traversal reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-parent-bound-'))
    try {
      // Build a 7-deep chain — each level points up via ../pom.xml — none has Spring Boot.
      // The chain is: a/b/c/d/e/f/g/pom.xml (project) → a/b/c/d/e/f → ... → a → root.
      // The root POM has no Spring Boot at all.
      const dirs = ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e', 'a/b/c/d/e/f', 'a/b/c/d/e/f/g']
      for (const d of dirs) {
        mkdirSync(join(root, d), { recursive: true })
      }
      // Root POM — no Spring Boot.
      writeFileSync(
        join(root, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>root</artifactId>
  <version>1.0.0</version>
</project>`,
      )
      writeFileSync(join(root, 'a', 'pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      for (let i = 1; i < dirs.length; i++) {
        writeFileSync(join(root, dirs[i]!, 'pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      }
      // Detect from the deepest level.
      const result = await detect(join(root, 'a/b/c/d/e/f/g'))
      expect(result.kind).toBe('unsupported')
      if (result.kind === 'unsupported') {
        expect(result.reason).toMatch(/parent.*5|hop|traversal/i)
        expect(result.suggestion).toContain('--boot')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('relativePath that does not resolve and parent not in m2 cache → unsupported (FR-14 fallback)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-parent-broken-'))
    const m2 = join(root, 'empty-m2')
    try {
      mkdirSync(m2)
      writeFileSync(
        join(root, 'pom.xml'),
        CHILD_POM_WITH_RELATIVE('../does-not-exist/pom.xml'),
      )
      const prev = process.env.PLEASEAI_SPRING_M2_ROOT
      process.env.PLEASEAI_SPRING_M2_ROOT = m2
      try {
        const result = await detect(root)
        expect(result.kind).toBe('unsupported')
        if (result.kind === 'unsupported') {
          expect(result.reason).toContain('external-parent-not-cached')
        }
      }
      finally {
        if (prev === undefined)
          delete process.env.PLEASEAI_SPRING_M2_ROOT
        else process.env.PLEASEAI_SPRING_M2_ROOT = prev
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('parent in chain found at exactly hop 5 → detected', async () => {
    // Build a 5-deep chain with Spring Boot at the top.
    const root = mkdtempSync(join(tmpdir(), 'detect-parent-5hop-'))
    try {
      // Layout:
      //   root/pom.xml         (Boot 3.5.0, top)
      //   root/a/pom.xml       (relativePath ../pom.xml)
      //   root/a/b/pom.xml     (relativePath ../pom.xml)
      //   root/a/b/c/pom.xml   (relativePath ../pom.xml)
      //   root/a/b/c/d/pom.xml (relativePath ../pom.xml) ← project, hop count = 4 traversals
      mkdirSync(join(root, 'a/b/c/d'), { recursive: true })
      writeFileSync(join(root, 'pom.xml'), SPRING_PARENT_POM('3.5.0'))
      writeFileSync(join(root, 'a/pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      writeFileSync(join(root, 'a/b/pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      writeFileSync(join(root, 'a/b/c/pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      writeFileSync(join(root, 'a/b/c/d/pom.xml'), CHILD_POM_WITH_RELATIVE('../pom.xml'))
      const result = await detect(join(root, 'a/b/c/d'))
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.5.0')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('malformed parent POM → unsupported (propagates parser failure)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-parent-malformed-'))
    try {
      writeFileSync(join(root, 'pom.xml'), CHILD_POM_WITH_RELATIVE('../parent/pom.xml'))
      mkdirSync(join(root, '..', 'parent'), { recursive: true })
      writeFileSync(join(root, '..', 'parent', 'pom.xml'), '<not<valid>>>')
      const result = await detect(root)
      expect(result.kind).toBe('unsupported')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(join(root, '..', 'parent'), { recursive: true, force: true })
    }
  })
})
