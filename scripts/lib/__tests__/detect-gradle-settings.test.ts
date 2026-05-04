import { describe, expect, test } from 'bun:test'

import { parseSettingsIncludes, parseSettingsPluginManagement, stripPluginManagementBlock } from '../detect-gradle-settings.ts'

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

  test('ignores include() inside line comments', () => {
    const src = `// include("phantom-line")
include("real")
`
    expect(parseSettingsIncludes(src)).toEqual([{ path: 'real', subdir: 'real' }])
  })

  test('ignores include() inside block comments', () => {
    const src = `/* include("phantom-block")
   include("also-phantom") */
include("real")
`
    expect(parseSettingsIncludes(src)).toEqual([{ path: 'real', subdir: 'real' }])
  })
})

describe('parseSettingsPluginManagement (FR-13)', () => {
  test('Kotlin DSL: pluginManagement { plugins { id(...) version "..." } }', () => {
    const src = `pluginManagement {
  repositories {
    gradlePluginPortal()
  }
  plugins {
    id("org.springframework.boot") version "3.4.5"
  }
}

include("app")
`
    expect(parseSettingsPluginManagement(src)).toBe('3.4.5')
  })

  test('Groovy DSL with single quotes', () => {
    const src = `pluginManagement {
    plugins {
        id 'org.springframework.boot' version '3.2.8'
    }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.2.8')
  })

  test('returns undefined when no pluginManagement block', () => {
    const src = `plugins { id("org.springframework.boot") version "3.4.0" }`
    expect(parseSettingsPluginManagement(src)).toBeUndefined()
  })

  test('returns undefined when pluginManagement does not declare spring-boot', () => {
    const src = `pluginManagement {
  plugins {
    id("io.spring.dependency-management") version "1.1.5"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBeUndefined()
  })

  test('ignores spring-boot id outside pluginManagement (top-level plugins block in settings is rare but possible)', () => {
    const src = `plugins {
  id("org.springframework.boot") version "3.0.0"
}

pluginManagement {
  plugins {
    id("io.spring.dependency-management") version "1.1.5"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBeUndefined()
  })

  test('returns undefined when version is a property interpolation (orchestrator handles via gradle.properties)', () => {
    const src = `pluginManagement {
  plugins {
    id("org.springframework.boot") version "$springBootVersion"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBeUndefined()
  })

  test('handles nested braces inside pluginManagement', () => {
    const src = `pluginManagement {
  repositories {
    maven { url = uri("https://example.com/repo") }
    gradlePluginPortal()
  }
  plugins {
    id("org.springframework.boot") version "3.3.3"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.3.3')
  })

  test('returns undefined when pluginManagement block is malformed (missing closing brace)', () => {
    const src = `pluginManagement {
  plugins {
    id("org.springframework.boot") version "3.4.0"
  }
`
    expect(parseSettingsPluginManagement(src)).toBeUndefined()
  })

  test('ignores pluginManagement keyword that appears in a line comment', () => {
    const src = `// pluginManagement { plugins { id("org.springframework.boot") version "9.9.9" } }
pluginManagement {
  plugins {
    id("org.springframework.boot") version "3.4.0"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.4.0')
  })

  test('ignores pluginManagement keyword that appears inside a string literal', () => {
    const src = `val msg = "pluginManagement { plugins { } }"
pluginManagement {
  plugins {
    id("org.springframework.boot") version "3.5.1"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.5.1')
  })

  test('ignores braces inside string literals when matching pluginManagement block', () => {
    const src = `pluginManagement {
  val s = "}}}"
  plugins {
    id("org.springframework.boot") version "3.6.0"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.6.0')
  })

  test('handles triple-quoted Kotlin strings without losing block bounds', () => {
    const src = `pluginManagement {
  val msg = """
  pluginManagement { plugins { } }
  }}}}
  """
  plugins {
    id("org.springframework.boot") version "3.7.2"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.7.2')
  })

  test('handles backslash-escaped quotes in strings', () => {
    const src = `pluginManagement {
  val s = "a\\\"} } pluginManagement { id"
  plugins {
    id("org.springframework.boot") version "3.8.0"
  }
}`
    expect(parseSettingsPluginManagement(src)).toBe('3.8.0')
  })
})

describe('stripPluginManagementBlock', () => {
  test('removes a pluginManagement block while preserving surrounding code', () => {
    const src = `pluginManagement {
  plugins {
    id("org.springframework.boot") version "3.4.0"
  }
}

apply(plugin = "real-plugin")
`
    const out = stripPluginManagementBlock(src)
    expect(out).not.toContain('org.springframework.boot')
    // The downstream `apply` line must survive verbatim.
    expect(out).toContain('apply(plugin = "real-plugin")')
    // Length is preserved so character indices map 1:1.
    expect(out.length).toBe(src.length)
  })

  test('returns input unchanged when there is no pluginManagement block', () => {
    const src = `plugins {
  id("org.springframework.boot") version "3.4.0"
}
`
    expect(stripPluginManagementBlock(src)).toBe(src)
  })

  test('does not strip an apply(...) call sitting outside pluginManagement', () => {
    const src = `pluginManagement {
  apply(plugin = "settings-only-plugin")
}

apply(plugin = "real-settings-plugin")
`
    const out = stripPluginManagementBlock(src)
    expect(out).not.toContain('settings-only-plugin')
    expect(out).toContain('real-settings-plugin')
  })
})
