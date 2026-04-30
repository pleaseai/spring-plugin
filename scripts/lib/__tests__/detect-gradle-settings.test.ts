import { describe, expect, test } from 'bun:test'

import { parseSettingsIncludes } from '../detect-gradle-settings.ts'

describe('parseSettingsIncludes', () => {
  test('Groovy include with single-quoted arg', () => {
    expect(parseSettingsIncludes('include \'app\'')).toEqual([
      { path: 'app', subdir: 'app' },
    ])
  })

  test('Groovy include with leading colon', () => {
    expect(parseSettingsIncludes('include \':app\'')).toEqual([
      { path: ':app', subdir: 'app' },
    ])
  })

  test('Groovy include with multiple args', () => {
    expect(parseSettingsIncludes('include \'app\', \'shared\'')).toEqual([
      { path: 'app', subdir: 'app' },
      { path: 'shared', subdir: 'shared' },
    ])
  })

  test('Kotlin include with parentheses', () => {
    expect(parseSettingsIncludes('include("app", "shared")')).toEqual([
      { path: 'app', subdir: 'app' },
      { path: 'shared', subdir: 'shared' },
    ])
  })

  test('nested project path :a:b → subdir a/b', () => {
    expect(parseSettingsIncludes('include(":a:b")')).toEqual([
      { path: ':a:b', subdir: 'a/b' },
    ])
  })

  test('multiple include calls aggregate', () => {
    const src = `rootProject.name = "demo"

include("app")
include("shared:core")
include(":vendor:bom")
`
    expect(parseSettingsIncludes(src)).toEqual([
      { path: 'app', subdir: 'app' },
      { path: 'shared:core', subdir: 'shared/core' },
      { path: ':vendor:bom', subdir: 'vendor/bom' },
    ])
  })

  test('empty / unrelated input returns []', () => {
    expect(parseSettingsIncludes('')).toEqual([])
    expect(parseSettingsIncludes('rootProject.name = "demo"')).toEqual([])
  })

  test('include written across multiple lines (parens form)', () => {
    const src = `include(
  "app",
  "shared",
)`
    expect(parseSettingsIncludes(src)).toEqual([
      { path: 'app', subdir: 'app' },
      { path: 'shared', subdir: 'shared' },
    ])
  })

  test('does not match a method named foo.include or includeBuild', () => {
    expect(parseSettingsIncludes('includeBuild("../tooling")')).toEqual([])
    expect(parseSettingsIncludes('foo.include("nope")')).toEqual([])
  })
})
