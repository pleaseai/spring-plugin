import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { detect } from '../detect.ts'

const PROJECTS = join(import.meta.dir, 'fixtures', 'detect', 'projects')
const projectPath = (name: string): string => join(PROJECTS, name)

describe('FR-6: Maven multi-module walk', () => {
  test('aggregator with no Boot version walks <modules> and finds version in child', async () => {
    const result = await detect(projectPath('maven-multimodule-child'))
    expect(result.kind).toBe('detected')
    if (result.kind === 'detected') {
      expect(result.version).toBe('3.2.7')
      // Source attribution should reflect the child file path.
      expect(result.source.file).toMatch(/app\/pom\.xml$/)
    }
  })

  test('first child without Boot is skipped; second child with Boot wins', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-mm-skip-'))
    try {
      mkdirSync(join(root, 'foo'))
      mkdirSync(join(root, 'bar'))
      writeFileSync(
        join(root, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>r</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>foo</module>
    <module>bar</module>
  </modules>
</project>`,
      )
      // foo: no Spring Boot
      writeFileSync(
        join(root, 'foo', 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>foo</artifactId>
  <version>1.0.0</version>
</project>`,
      )
      // bar: Spring Boot via BOM
      writeFileSync(
        join(root, 'bar', 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>bar</artifactId>
  <version>1.0.0</version>
  <dependencyManagement>
    <dependencies>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>3.3.8</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
</project>`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('detected')
      if (result.kind === 'detected') {
        expect(result.version).toBe('3.3.8')
      }
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('aggregator with no Boot in any child → not-found', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-mm-none-'))
    try {
      mkdirSync(join(root, 'a'))
      writeFileSync(
        join(root, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>r</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>a</module>
  </modules>
</project>`,
      )
      writeFileSync(
        join(root, 'a', 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>a</artifactId>
  <version>1.0.0</version>
</project>`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('module entry pointing at non-existent path is skipped silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'detect-mm-missing-'))
    try {
      writeFileSync(
        join(root, 'pom.xml'),
        `<?xml version="1.0"?>
<project>
  <groupId>com.example</groupId>
  <artifactId>r</artifactId>
  <version>1.0.0</version>
  <packaging>pom</packaging>
  <modules>
    <module>does-not-exist</module>
  </modules>
</project>`,
      )
      const result = await detect(root)
      expect(result.kind).toBe('not-found')
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
