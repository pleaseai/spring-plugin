---
id: SPEC-001
level: V_M
domain: install
feature: detect
depends: []
conflicts: []
traces: []
created_at: 2026-04-30T10:00:42Z
updated_at: 2026-04-30T10:00:42Z
source_tracks: ["build-file-detect-20260428"]
---

# Build-File Detection Specification

## Purpose

Build-File Detection 관련 요구사항. `scripts/detect.ts`는 프로젝트 루트를 받아 빌드 파일을 검사하고, 선언된 Spring Boot 버전(있는 경우)을 구조화된 결과로 반환하는 단일 진실 공급원이다. 다운스트림 단계(`resolve.ts`, `install.ts`)는 이 결과를 소비하며, 다른 컴포넌트는 빌드 파일을 파싱할 수 없다.

## Requirements

### Requirement: Detect Spring Boot version from pom.xml via spring-boot-starter-parent (FR-1)

The system MUST Detect Spring Boot version from `pom.xml` when declared via `spring-boot-starter-parent`.

#### Scenario: spring-boot-starter-parent detection

- GIVEN a `pom.xml` with `<parent><artifactId>spring-boot-starter-parent</artifactId><version>3.x.y</version></parent>`
- WHEN `detect()` is invoked at the project root
- THEN it returns `{ kind: 'detected', version: '3.x.y', source: { file: 'pom.xml', locator: 'spring-boot-starter-parent in <parent>' } }`

### Requirement: Detect Spring Boot version from pom.xml via spring-boot-dependencies BOM (FR-2)

The system MUST Detect Spring Boot version from `pom.xml` when declared via `spring-boot-dependencies` BOM in `<dependencyManagement>` (no `<parent>`).

#### Scenario: spring-boot-dependencies BOM detection

- GIVEN a `pom.xml` declaring `spring-boot-dependencies` in `<dependencyManagement>` without a Spring Boot parent
- WHEN `detect()` is invoked
- THEN it returns `kind: 'detected'` with the BOM version

### Requirement: Detect Spring Boot version from build.gradle (Groovy DSL) (FR-3)

The system MUST Detect Spring Boot version from `build.gradle` (Groovy DSL) when declared via the Spring Boot plugin.

#### Scenario: Groovy plugin DSL detection

- GIVEN a `build.gradle` with `id 'org.springframework.boot' version '3.x.y'` (or `plugins { id ... }`, `apply plugin:`, `buildscript { ext['spring-boot.version'] = '...' }`)
- WHEN `detect()` is invoked
- THEN it returns `kind: 'detected'` with the declared version

### Requirement: Detect Spring Boot version from build.gradle.kts (Kotlin DSL) (FR-4)

The system MUST Detect Spring Boot version from `build.gradle.kts` (Kotlin DSL) for the equivalent patterns.

#### Scenario: Kotlin DSL detection

- GIVEN a `build.gradle.kts` with `id("org.springframework.boot") version "3.x.y"` (or `plugins { id(...) }`)
- WHEN `detect()` is invoked
- THEN it returns `kind: 'detected'` with the declared version

### Requirement: Resolve Maven parent POM inheritance (FR-5)

The system MUST Resolve Maven **parent POM inheritance** when the immediate `pom.xml` declares `<parent>` pointing at a sibling project file. Maximum 5 levels of parent traversal to bound the search.

#### Scenario: parent POM traversal

- GIVEN a `pom.xml` with `<parent><relativePath>...</relativePath></parent>` pointing at a sibling parent file containing the Boot version
- WHEN `detect()` is invoked at the child directory
- THEN it reads the parent file from disk, continues the search there, and returns the Boot version (≤ 5 hops)

### Requirement: Detect Spring Boot version in Maven multi-module projects (FR-6)

The system MUST Detect Spring Boot version in **Maven multi-module** projects.

#### Scenario: multi-module Maven scan

- GIVEN a project with a parent `pom.xml` and child `<modules>` declarations
- WHEN `detect()` is invoked at the parent directory
- THEN it searches the parent POM first; if no Boot version, scans declared modules in order and returns the first child's Boot version

### Requirement: Detect Spring Boot version in Gradle multi-module projects (FR-7)

The system MUST Detect Spring Boot version in **Gradle multi-module** projects.

#### Scenario: multi-module Gradle scan

- GIVEN a `settings.gradle(.kts)` root with `include(...)` subprojects
- WHEN `detect()` is invoked at the root
- THEN it searches the root build file first; if no Boot version, walks each included subproject's `build.gradle(.kts)` (one level deep)

### Requirement: Return a structured DetectResult object (FR-8)

The system MUST Return a **structured result object** as a discriminated union (`detected`/`unsupported`/`not-found`) with `DetectSource` carrying POSIX-relative paths for in-project sources and POSIX-absolute paths (with `~/` expanded to `$HOME`) for out-of-project sources (`~/.m2`, `~/.cache/pleaseai-spring`, `~/.gradle`).

#### Scenario: structured result contract

- GIVEN any detection invocation
- WHEN it completes
- THEN the return value matches the `DetectResult` discriminated union; `source.file` is POSIX-relative for in-project sources and POSIX-absolute for out-of-project sources, with `~/` always expanded

### Requirement: Return unsupported on recognized-but-unsupported patterns (FR-9)

The system MUST return `kind: 'unsupported'` with a `--boot` override suggestion when detection fails on a recognized-but-unsupported pattern. It MUST NOT throw.

#### Scenario: recognized but unsupported

- GIVEN a build file with a pattern the parser recognizes but cannot evaluate (e.g., unresolved catalog reference)
- WHEN `detect()` is invoked
- THEN it returns `{ kind: 'unsupported', reason, suggestion: 'Use --boot <version> to override' }` without throwing

### Requirement: Return not-found when no build file is present (FR-10)

The system MUST return `kind: 'not-found'` with a suggestion when no supported build file is found at the project root. It MUST NOT throw.

#### Scenario: empty project directory

- GIVEN a directory with no `pom.xml`, `build.gradle`, or `build.gradle.kts`
- WHEN `detect()` is invoked
- THEN it returns `{ kind: 'not-found', reason: 'No supported build file at <path>', suggestion: 'Run from a Spring project root, or pass --boot <version>' }`

### Requirement: Expose CLI with mapped exit codes (FR-11)

The system MUST Expose a CLI: `bun run scripts/detect.ts <project-dir>` prints the result as JSON to stdout. Exit code: `0` for `detected`, `1` for `unsupported`/`not-found`, `2` for unexpected internal errors only.

#### Scenario: CLI exit code mapping

- GIVEN any CLI invocation
- WHEN the result is `detected`/`unsupported`/`not-found`/internal error
- THEN exit code is `0`/`1`/`1`/`2` respectively, and stdout contains the JSON-serialized result

### Requirement: Detect Spring Boot version via Gradle version catalog or gradle.properties (FR-12)

The system MUST Detect Spring Boot version when declared via Gradle version catalog (`gradle/libs.versions.toml`) or `gradle.properties` variable substitution. Subproject `gradle.properties` overrides the root.

#### Scenario: catalog and properties resolution

- GIVEN a `build.gradle(.kts)` referencing `libs.versions.spring.boot.get()` or `version "$springBootVersion"`
- WHEN `detect()` is invoked
- THEN it resolves the value from `libs.versions.toml` `[versions]` table or from `gradle.properties` (subproject overrides root) and returns `kind: 'detected'` with source attribution to the originating file and key

### Requirement: Detect Spring Boot in settings.gradle pluginManagement (FR-13)

The system MUST Detect Spring Boot version declared in `settings.gradle(.kts)` `pluginManagement { plugins { ... } }` block. A hit short-circuits the multi-module subproject scan.

#### Scenario: pluginManagement detection

- GIVEN a `settings.gradle(.kts)` with `pluginManagement { plugins { id 'org.springframework.boot' version '...' } }`
- WHEN `detect()` is invoked
- THEN it returns the Boot version from `pluginManagement` before walking subprojects (per FR-7 ordering)

### Requirement: Resolve Maven external parent POM via ~/.m2 cache (FR-14)

The system MUST Resolve Maven external parent POM via local cache lookup at `~/.m2/repository/<groupId-with-slashes>/<artifactId>/<version>/<artifactId>-<version>.pom` when `<parent>` omits or fails to resolve `<relativePath>`. Cache lookup respects the FR-5 traversal bound (≤5 hops). On cache miss, return `kind: 'unsupported'` with `reason: 'external-parent-not-cached'`.

#### Scenario: m2 cache hit and miss

- GIVEN a `pom.xml` with `<parent>` whose `<relativePath>` does not resolve on disk
- WHEN `detect()` is invoked
- THEN it consults `~/.m2/repository/...` for the parent POM; on hit, continues parent traversal (≤5 hops); on miss, returns `kind: 'unsupported'` with `reason: 'external-parent-not-cached'` and suggests `./mvnw install -N` or `--boot <version>`

### Requirement: Persist --boot overrides per project (FR-15)

The system MUST Persist user `--boot` overrides per project at `~/.cache/pleaseai-spring/overrides.json`, keyed by `sha256(absolute project_dir)`. An existing override short-circuits detection. The CLI accepts `--boot <version>` to grant/refresh and `--clear-override` to revoke.

#### Scenario: override short-circuit and CLI flags

- GIVEN a project with a prior `--boot` override stored at `~/.cache/pleaseai-spring/overrides.json`
- WHEN `detect()` is invoked
- THEN it returns `kind: 'detected'` with that version, source `file` is the absolute (`~/` expanded) overrides.json path, and `locator` is `--boot override (granted <ISO timestamp>)`. `--clear-override` revokes the entry

### Requirement: Resolve Gradle published version catalog (FR-16)

The system MUST Resolve Gradle published version catalog declared via `dependencyResolutionManagement { versionCatalogs { create(...) { from("group:artifact:version") } } }`. Cache lookup order: `~/.m2/repository` (Maven layout) → `~/.gradle/caches/modules-2/files-2.1/` (Gradle hashed layout) → `~/.cache/pleaseai-spring/catalogs/`. Network fetch routes through `scripts/resolve.ts` only.

#### Scenario: published catalog cache-first lookup

- GIVEN a `settings.gradle(.kts)` with `from("group:artifact:version")`
- WHEN `detect()` is invoked
- THEN it locates the catalog `.toml` in m2 → Gradle hashed cache → plugin-owned cache, in that order; only on full miss does it consider a network fetch (routed through `scripts/resolve.ts`, the single network boundary)

### Requirement: Distinguish requires-build-tool patterns (FR-17)

The system MUST Distinguish patterns that fundamentally require build-tool evaluation (`buildSrc/`, settings plugins, `${revision}` interpolation, custom init scripts) by returning `kind: 'unsupported'` with `reason` containing the literal token `requires-build-tool` and a `suggestion` naming both the build-tool fallback (per ADR-0002) and `--boot <version>`.

#### Scenario: requires-build-tool taxonomy

- GIVEN a build file with `buildSrc/`, an applied settings plugin, `<version>${revision}</version>`, or a custom Gradle init script defining the Boot plugin version
- WHEN `detect()` is invoked
- THEN it returns `kind: 'unsupported'` with `reason` containing `requires-build-tool` and a `suggestion` mentioning the build-tool fallback (ADR-0002) and `--boot <version>`. Other unsupported reasons MUST NOT contain the `requires-build-tool` token

## Non-functional Requirements

### Requirement: Library Layer parsing logic is pure (NFR-1)

The system SHOULD keep all parsing logic in `scripts/lib/` (Library Layer) as pure functions accepting strings or already-read file contents. No `fs`, `fetch`, or `process.env` access in `scripts/lib/`.

### Requirement: I/O lives in Domain Layer (NFR-2)

The system SHOULD keep all I/O (file reads, parent POM traversal, multi-module walks) in `scripts/detect.ts` (Domain Layer) and unit-test it with mocked filesystem inputs.

### Requirement: Minimal external dependencies (NFR-3)

The system SHOULD keep external dependencies minimal: at most one XML parser (`fast-xml-parser`); no Groovy/Kotlin parser library — Gradle DSL handled by regex per `tech-stack.md`.

### Requirement: Test coverage ≥ 90% for scripts/lib/ (NFR-4)

The system SHOULD maintain test coverage ≥ 90% for `scripts/lib/` (branch coverage, not just lines), measured via Bun's built-in coverage reporter.

### Requirement: Single-file detection completes in under 100ms warm (NFR-5)

The system SHOULD complete detection of a single-file `pom.xml` or `build.gradle(.kts)` in under 100ms on a warm cache (no parent traversal, no multi-module walk).
