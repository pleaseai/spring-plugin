import type { DetectResult, DetectSource } from '../detect-types.ts'

import { describe, expect, test } from 'bun:test'
import {

  isDetected,
  isNotFound,
  isUnsupported,
  REQUIRES_BUILD_TOOL,
} from '../detect-types.ts'

describe('detect-types', () => {
  test('isDetected narrows to the detected variant', () => {
    const result: DetectResult = {
      kind: 'detected',
      version: '3.2.1',
      source: { file: 'pom.xml', locator: 'spring-boot-starter-parent in <parent>' },
    }
    expect(isDetected(result)).toBe(true)
    expect(isUnsupported(result)).toBe(false)
    expect(isNotFound(result)).toBe(false)
    if (isDetected(result)) {
      expect(result.version).toBe('3.2.1')
    }
  })

  test('isUnsupported narrows and accepts optional source', () => {
    const result: DetectResult = {
      kind: 'unsupported',
      reason: 'malformed XML',
      suggestion: 'Use --boot <version> to override',
    }
    expect(isUnsupported(result)).toBe(true)
    expect('source' in result).toBe(false)
  })

  test('isNotFound narrows to the not-found variant', () => {
    const result: DetectResult = {
      kind: 'not-found',
      reason: 'No supported build file at /tmp/empty',
      suggestion: 'Run from a Spring project root, or pass --boot <version>',
    }
    expect(isNotFound(result)).toBe(true)
  })

  test('REQUIRES_BUILD_TOOL is the canonical literal token (FR-17)', () => {
    expect(REQUIRES_BUILD_TOOL).toBe('requires-build-tool')
    const reason = `${REQUIRES_BUILD_TOOL}: buildSrc/ defines plugin version dynamically`
    expect(reason.includes(REQUIRES_BUILD_TOOL)).toBe(true)
  })

  test('DetectSource shape supports optional line number', () => {
    const source: DetectSource = {
      file: 'build.gradle',
      locator: 'plugins block id org.springframework.boot',
      line: 12,
    }
    expect(source.line).toBe(12)
  })
})
