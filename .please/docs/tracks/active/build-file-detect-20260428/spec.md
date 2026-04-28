---
product_spec_domain: install/detect
---

# Build-File Detection

> Track: build-file-detect-20260428
> Type: feature

## Overview

Implement `scripts/detect.ts`, the first domain function in the Spring install pipeline. Given a project root, it inspects the relevant build file(s) and returns a structured result describing which Spring Boot version (if any) the project declares. It is the single source of truth that downstream stages (`resolve.ts`, `install.ts`) consume — no other component is permitted to parse build files.

This function is **architecture-agnostic** with respect to the athens-v2 dynamic-loading direction: detect.ts contracts (input: project dir → output: structured result) are identical whether the eventual install writes static Markdown or a thin skill that delegates to `@pleaseai/ask` at runtime.

The function lives in the **Domain Layer** per `ARCHITECTURE.md`: it may read files but performs no network I/O and exposes a CLI for direct invocation (`bun run scripts/detect.ts <project-dir>`).

## Requirements

### Functional Requirements

- [ ] **FR-1**: Detect Spring Boot version from `pom.xml` when declared via `spring-boot-starter-parent` (`<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.x.y</version></parent>`).
- [ ] **FR-2**: Detect Spring Boot version from `pom.xml` when declared via `spring-boot-dependencies` BOM in `<dependencyManagement>` (no `<parent>`).
- [ ] **FR-3**: Detect Spring Boot version from `build.gradle` (Groovy DSL) when declared via the Spring Boot plugin: `id 'org.springframework.boot' version '3.x.y'` (also `plugins { id ... }`, `apply plugin:`, and `buildscript { ext['spring-boot.version'] = '...' }` patterns).
- [ ] **FR-4**: Detect Spring Boot version from `build.gradle.kts` (Kotlin DSL) for the equivalent patterns: `id("org.springframework.boot") version "3.x.y"`, `plugins { id(...) }`, etc.
- [ ] **FR-5**: Resolve Maven **parent POM inheritance** when the immediate `pom.xml` declares `<parent>` pointing at a sibling project file (`<relativePath>...</relativePath>`); read the parent file from disk and continue the search there. Maximum 5 levels of parent traversal to bound the search.
- [ ] **FR-6**: Detect Spring Boot version in **Maven multi-module** projects: when invoked at a directory that contains a parent POM and child modules, search the parent POM first; if not found, scan declared `<modules>` for the first child whose POM declares a Boot version.
- [ ] **FR-7**: Detect Spring Boot version in **Gradle multi-module** projects: when invoked at a `settings.gradle(.kts)` root, search the root build file first; if not found, walk `include(...)` subprojects (one level deep) and scan each subproject's `build.gradle(.kts)` for the Boot plugin declaration.
- [ ] **FR-8**: Return a **structured result object** with the following shape (TypeScript types defined in `scripts/lib/detect-types.ts`):

  ```ts
  type DetectResult =
    | { kind: 'detected'; version: string; source: DetectSource }
    | { kind: 'unsupported'; reason: string; suggestion: string; source?: DetectSource }
    | { kind: 'not-found'; reason: string; suggestion: string }

  type DetectSource = {
    file: string         // relative path from project root
    locator: string      // human-readable hint (e.g., "spring-boot-starter-parent in <parent>")
    line?: number        // best-effort line number for diagnostics
  }
  ```

- [ ] **FR-9**: When detection fails on a recognized-but-unsupported pattern (e.g., version catalog reference `id 'org.springframework.boot' version libs.versions.spring.boot.get()`), return `{ kind: 'unsupported', reason, suggestion: "Use --boot <version> to override" }`. Do NOT throw.
- [ ] **FR-10**: When no build file is found at the project root (no `pom.xml`, `build.gradle`, `build.gradle.kts`), return `{ kind: 'not-found', reason: 'No supported build file at <path>', suggestion: 'Run from a Spring project root, or pass --boot <version>' }`. Do NOT throw.
- [ ] **FR-11**: Expose a CLI: `bun run scripts/detect.ts <project-dir>` prints the result as JSON to stdout. Exit code: `0` for `kind: 'detected'`, `1` for `kind: 'unsupported'` or `kind: 'not-found'`, `2` for unexpected internal errors (only — never thrown for recognized failure modes).

### Non-functional Requirements

- [ ] **NFR-1**: All parsing logic is in `scripts/lib/` (Library Layer) — pure functions accepting strings or already-read file contents and returning typed results. No `fs`, `fetch`, or `process.env` access in `scripts/lib/`.
- [ ] **NFR-2**: All I/O (file reads, parent POM traversal, multi-module walks) lives in `scripts/detect.ts` (Domain Layer) and is unit-tested with mocked filesystem inputs.
- [ ] **NFR-3**: External dependencies kept minimal: at most one XML parser (`fast-xml-parser`); no Groovy/Kotlin parser library — Gradle DSL handled by regex per `tech-stack.md`.
- [ ] **NFR-4**: Test coverage ≥ 90% for `scripts/lib/` (branch coverage, not just lines), measured via Bun's built-in coverage reporter.
- [ ] **NFR-5**: Detection of a single-file `pom.xml` or `build.gradle(.kts)` completes in under 100ms on a warm cache (no parent traversal, no multi-module walk).

## Acceptance Criteria

- [ ] **AC-1**: A fixture suite under `scripts/lib/__tests__/fixtures/detect/` covers at minimum the matrix below; each fixture is a real-world-shaped build file (or directory) with an expected `DetectResult`:

  | Source           | Pattern                                  | Expected `kind`    |
  | ---------------- | ---------------------------------------- | ------------------ |
  | `pom.xml`        | spring-boot-starter-parent               | `detected`         |
  | `pom.xml`        | spring-boot-dependencies BOM             | `detected`         |
  | `pom.xml`        | parent POM with `<relativePath>`         | `detected`         |
  | `pom.xml`        | multi-module (parent has version)        | `detected`         |
  | `pom.xml`        | multi-module (child has version)         | `detected`         |
  | `build.gradle`   | `plugins { id ... version '...' }`       | `detected`         |
  | `build.gradle`   | `apply plugin: 'org.springframework.boot'` + ext | `detected`         |
  | `build.gradle.kts` | `plugins { id(...) version "..." }`    | `detected`         |
  | `build.gradle.kts` | settings + multi-module subproject     | `detected`         |
  | `build.gradle`   | version catalog reference                 | `unsupported`      |
  | (none)           | empty directory                          | `not-found`        |
  | `pom.xml`        | no Spring Boot at all                    | `not-found`        |
  | `pom.xml`        | malformed XML                            | `unsupported`      |

- [ ] **AC-2**: Every `unsupported` and `not-found` result includes a `suggestion` string that names the `--boot` override flag, so users have an unambiguous next step.
- [ ] **AC-3**: The CLI (`bun run scripts/detect.ts <dir>`) exit code maps cleanly: `0` for detected, `1` for unsupported/not-found, never throws on a recognized failure mode.
- [ ] **AC-4**: `bun test` runs the full fixture suite green; `bun test --coverage` reports ≥ 90% branch coverage for `scripts/lib/detect-*.ts`.
- [ ] **AC-5**: A spot-check on three real Spring sample projects (the same ones referenced in the eval suite, when it lands) returns the correct version. (Recorded manually in PR description; not automated in this track.)
- [ ] **AC-6**: `scripts/lib/detect-*.ts` has zero `import` statements that resolve to `node:fs`, `node:net`, `node:http`, or `bun`-namespace I/O. Enforced via a single ESLint custom rule (or a guard test that `grep`s the module).

## Out of Scope

- **Resolution of component versions** from a Boot version (Framework, Security, Data, …) — that is the next track (`resolve.ts` calling Maven Central for the Boot BOM POM).
- **Live network calls** of any kind. Detection is filesystem-only.
- **Pre-release detection** (RC, M1, SNAPSHOT). The detector reports the version string verbatim; downstream stages reject pre-release per the existing architectural invariant.
- **Gradle version catalogs** (`libs.versions.toml`) as a *first-class* detection source. Recognized as `unsupported` with a clear suggestion to use `--boot` override; promoting it to `detected` is a follow-up track.
- **Plugin Management** (`pluginManagement {}` in `settings.gradle`) version overrides. Not in scope; treat the resolved-at-parse-time string as authoritative.
- **Bazel, sbt, or other JVM build tools.** Out of scope for this plugin entirely.
- **Watching** for build file changes. One-shot invocation only.
- **Caching** detection results. Caller's responsibility (cheap enough that recomputation is fine).

## Assumptions

- The project root passed to `detect.ts` is a directory the user has read access to. No special handling for symlink loops beyond Node's default behavior.
- "Multi-module" in this spec means the standard Maven `<modules>` declaration in a parent POM, or Gradle `include(...)` calls in `settings.gradle(.kts)`. Custom build-orchestration setups (e.g., `composite builds`, `Maven Reactor` overrides) are not supported.
- Q4 (additional constraints) was not answered; we apply the conservative defaults from `ARCHITECTURE.md` invariants ("Library layer is I/O-free", "no native deps") and `tech-stack.md` dependency policy. NFR-1, NFR-2, NFR-3 enforce this explicitly.
- Bun's filesystem APIs are used in the Domain layer (`scripts/detect.ts`); the Library layer (`scripts/lib/`) takes already-read strings as input so it can be tested with literal fixtures and runs identically under Node fallback.

## References

- `ARCHITECTURE.md` § Dependency Layers, § Architecture Invariants ("Library layer has no I/O", "Domain layer functions are independently runnable")
- `.please/docs/knowledge/tech-stack.md` § Build File Parsing (Gradle/Maven), § Dependency Policy
- Sibling spec: `plugin-scaffold-20260428` (provides the `scripts/lib/` location and test runner this track populates)
