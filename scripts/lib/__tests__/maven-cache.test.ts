import { describe, expect, test } from 'bun:test'

import { mavenCachePath } from '../maven-cache.ts'

describe('mavenCachePath', () => {
  test('builds standard Maven layout path', () => {
    const p = mavenCachePath(
      'org.springframework.boot',
      'spring-boot-dependencies',
      '3.4.0',
      '/Users/alice/.m2/repository',
    )
    expect(p).toBe(
      '/Users/alice/.m2/repository/org/springframework/boot/spring-boot-dependencies/3.4.0/spring-boot-dependencies-3.4.0.pom',
    )
  })

  test('handles single-segment group id', () => {
    const p = mavenCachePath('com.acme', 'platform', '1.0.0', '/home/bob/.m2/repository')
    expect(p).toBe('/home/bob/.m2/repository/com/acme/platform/1.0.0/platform-1.0.0.pom')
  })

  test('handles relative m2 root (used in tests)', () => {
    const p = mavenCachePath('com.acme', 'tools', '2.0.0', './fake-m2')
    expect(p).toBe('fake-m2/com/acme/tools/2.0.0/tools-2.0.0.pom')
  })
})
