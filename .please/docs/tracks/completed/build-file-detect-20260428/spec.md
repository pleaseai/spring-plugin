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
    file: string         // For in-project sources: POSIX-relative path from the project root
                         // (e.g., `pom.xml`, `gradle/libs.versions.toml`).
                         // For out-of-project sources: POSIX absolute path with the user's
                         // home directory expanded (e.g., `/Users/alice/.m2/repository/...`,
                         // `/home/bob/.cache/pleaseai-spring/overrides.json`). Implementations
                         // MUST expand `~/` to the resolved `$HOME` before storing the value;
                         // the literal `~/` prefix never appears in the stored string.
                         // Spec text uses `~/` as readability shorthand only; the contract is
                         // an absolute path. Out-of-project sources include FR-14 (~/.m2 cache),
                         // FR-15 (overrides.json), and FR-16 (~/.gradle cache, our own cache).
    locator: string      // human-readable hint (e.g., "spring-boot-starter-parent in <parent>")
    line?: number        // best-effort line number for diagnostics
  }
  ```

- [ ] **FR-9**: When detection fails on a recognized-but-unsupported pattern (e.g., version catalog reference `id 'org.springframework.boot' version libs.versions.spring.boot.get()`), return `{ kind: 'unsupported', reason, suggestion: "Use --boot <version> to override" }`. Do NOT throw.
- [ ] **FR-10**: When no build file is found at the project root (no `pom.xml`, `build.gradle`, `build.gradle.kts`), return `{ kind: 'not-found', reason: 'No supported build file at <path>', suggestion: 'Run from a Spring project root, or pass --boot <version>' }`. Do NOT throw.
- [ ] **FR-11**: Expose a CLI: `bun run scripts/detect.ts <project-dir>` prints the result as JSON to stdout. Exit code: `0` for `kind: 'detected'`, `1` for `kind: 'unsupported'` or `kind: 'not-found'`, `2` for unexpected internal errors (only — never thrown for recognized failure modes).
- [ ] **FR-12**: Detect Spring Boot version when declared via Gradle version catalog (`gradle/libs.versions.toml`) or `gradle.properties` variable substitution. Resolve catalog references such as `id 'org.springframework.boot' version libs.versions.spring.boot.get()` by parsing the `[versions]` table of `libs.versions.toml`; resolve variable interpolation such as `version "$springBootVersion"` by reading `gradle.properties` (root and per-module — subproject overrides root). Source attribution names the originating file (catalog or properties) and the resolved key.
- [ ] **FR-13**: Detect Spring Boot version declared in `settings.gradle(.kts)` `pluginManagement { plugins { id 'org.springframework.boot' version '...' } }` block. The orchestrator inspects this block as an additional version source ordered before the per-module `build.gradle(.kts)` walk in FR-7; a hit short-circuits the multi-module subproject scan.
- [ ] **FR-14**: Resolve Maven external parent POM via local cache lookup at `~/.m2/repository/<groupId-with-slashes>/<artifactId>/<version>/<artifactId>-<version>.pom` when the project's `<parent>` declaration omits `<relativePath>` or its `<relativePath>` does not resolve to a sibling project file on disk. The cache lookup respects the FR-5 traversal bound (≤5 hops). If the parent POM is not present in the local cache, return `kind: 'unsupported'` with `reason: 'external-parent-not-cached'` and suggest running the project's build at least once (`./mvnw install -N`) or passing `--boot <version>`.
- [ ] **FR-15**: Persist user `--boot` overrides per project at `~/.cache/pleaseai-spring/overrides.json`, keyed by `sha256(absolute project_dir)`. The orchestrator consults this store before invoking detection; an existing override short-circuits detection and is reported as `kind: 'detected'` with `source: { file: '/home/<user>/.cache/pleaseai-spring/overrides.json', locator: '--boot override (granted <ISO timestamp>)' }` (the literal `/home/<user>/` is shown for illustration; implementations write the expanded `$HOME` path per FR-8). Per the FR-8 `DetectSource.file` contract, out-of-project sources use expanded absolute paths — the `~/` prefix never appears in the stored value. The CLI accepts `--boot <version>` to grant or refresh an override and `--clear-override` to revoke.
- [ ] **FR-16**: Resolve Gradle published version catalog declared via `dependencyResolutionManagement { versionCatalogs { create(...) { from("group:artifact:version") } } }`. Parse `dependencyResolutionManagement.repositories { ... }` in `settings.gradle(.kts)` to derive candidate Maven URLs; locate the catalog `.toml` artifact first in `~/.m2/repository` using standard Maven layout (`<group-with-slashes>/<artifact>/<version>/<artifact>-<version>.toml`), then in `~/.gradle/caches/modules-2/files-2.1/` using Gradle's hashed artifact layout (`<group>/<artifact>/<version>/<sha1-hash>/<artifact>-<version>.toml` — Gradle adds a hash directory between version and artifact filename), and in `~/.cache/pleaseai-spring/catalogs/` before fetching from a configured remote repository. Network fetch is the only network call permitted by this track and routes through the same client used by `scripts/resolve.ts` to preserve the single-network-boundary invariant.
- [ ] **FR-17**: Distinguish patterns that fundamentally require build-tool evaluation (`buildSrc/`, applied settings plugins, `<version>${revision}</version>` CI interpolation, custom Gradle init scripts) from merely-unrecognized patterns by returning `kind: 'unsupported'` with `reason` containing the literal token `requires-build-tool` and `suggestion` naming both the build-tool fallback consent flow (per ADR-0002) and the `--boot <version>` override (FR-15). Other unsupported cases continue to return `reason` strings that do not contain `requires-build-tool`, so callers can distinguish "we cannot parse this without code execution" from "we don't yet support this static pattern."

### Non-functional Requirements

- [ ] **NFR-1**: All parsing logic is in `scripts/lib/` (Library Layer) — pure functions accepting strings or already-read file contents and returning typed results. No `fs`, `fetch`, or `process.env` access in `scripts/lib/`.
- [ ] **NFR-2**: All I/O (file reads, parent POM traversal, multi-module walks) lives in `scripts/detect.ts` (Domain Layer) and is unit-tested with mocked filesystem inputs.
- [ ] **NFR-3**: External dependencies kept minimal: at most one XML parser (`fast-xml-parser`); no Groovy/Kotlin parser library — Gradle DSL handled by regex per `tech-stack.md`.
- [ ] **NFR-4**: Test coverage ≥ 90% for `scripts/lib/` (branch coverage, not just lines), measured via Bun's built-in coverage reporter.
- [ ] **NFR-5**: Detection of a single-file `pom.xml` or `build.gradle(.kts)` completes in under 100ms on a warm cache (no parent traversal, no multi-module walk).

## Acceptance Criteria

- [ ] **AC-1**: A fixture suite under `scripts/lib/__tests__/fixtures/detect/` covers at minimum the matrix below; each fixture is a real-world-shaped build file (or directory) with an expected `DetectResult`:

  | Source                          | Pattern                                                        | Expected `kind` |
  | ------------------------------- | -------------------------------------------------------------- | --------------- |
  | `pom.xml`                       | spring-boot-starter-parent                                     | `detected`      |
  | `pom.xml`                       | spring-boot-dependencies BOM                                   | `detected`      |
  | `pom.xml`                       | parent POM with `<relativePath>` (sibling)                     | `detected`      |
  | `pom.xml`                       | multi-module (parent has version)                              | `detected`      |
  | `pom.xml`                       | multi-module (child has version)                               | `detected`      |
  | `pom.xml`                       | external parent, `~/.m2` cache hit (FR-14)                     | `detected`      |
  | `pom.xml`                       | external parent, `~/.m2` cache miss (FR-14)                    | `unsupported`   |
  | `build.gradle`                  | `plugins { id ... version '...' }`                             | `detected`      |
  | `build.gradle`                  | `apply plugin: 'org.springframework.boot'` + ext               | `detected`      |
  | `build.gradle.kts`              | `plugins { id(...) version "..." }`                            | `detected`      |
  | `build.gradle.kts`              | settings + multi-module subproject                             | `detected`      |
  | `gradle/libs.versions.toml`     | `version libs.versions.spring.boot.get()` reference (FR-12)    | `detected`      |
  | `gradle.properties`             | `springBootVersion=3.x.y` substitution (FR-12)                 | `detected`      |
  | `settings.gradle.kts`           | `pluginManagement { plugins { ... version ... } }` (FR-13)     | `detected`      |
  | `settings.gradle.kts`           | `from("group:artifact:version")` published catalog, cached (FR-16) | `detected`      |
  | `~/.cache/.../overrides.json`   | prior `--boot` override (FR-15)                                | `detected`      |
  | `buildSrc/`                     | dynamic plugin version definition (FR-17)                      | `unsupported`   |
  | (none)                          | empty directory                                                | `not-found`     |
  | `pom.xml`                       | no Spring Boot at all                                          | `not-found`     |
  | `pom.xml`                       | malformed XML                                                  | `unsupported`   |

- [ ] **AC-2**: Every `unsupported` and `not-found` result includes a `suggestion` string that names the `--boot` override flag, so users have an unambiguous next step.
- [ ] **AC-3**: The CLI (`bun run scripts/detect.ts <dir>`) exit code maps cleanly: `0` for detected, `1` for unsupported/not-found, never throws on a recognized failure mode.
- [ ] **AC-4**: `bun test` runs the full fixture suite green; `bun test --coverage` reports ≥ 90% branch coverage for `scripts/lib/detect-*.ts`.
- [ ] **AC-5**: A spot-check on three real Spring sample projects (the same ones referenced in the eval suite, when it lands) returns the correct version. (Recorded manually in PR description; not automated in this track.)
- [ ] **AC-6**: `scripts/lib/detect-*.ts` has zero `import` statements that resolve to `node:fs`, `node:net`, `node:http`, or `bun`-namespace I/O. Enforced via a single ESLint custom rule (or a guard test that `grep`s the module).

## Out of Scope

- **Resolution of component versions** from a Boot version (Framework, Security, Data, …) — that is the next track (`resolve.ts` calling Maven Central for the Boot BOM POM).
- **Live network calls** beyond the FR-16 published-catalog path. Detection is filesystem-first; FR-16 is the single sanctioned network exit and routes through the existing fetch client.
- **Pre-release detection** (RC, M1, SNAPSHOT). The detector reports the version string verbatim; downstream stages reject pre-release per the existing architectural invariant.
- **Build-tool evaluation as a primary path** (`mvn help:effective-pom`, `./gradlew`). Patterns requiring JVM evaluation are reported via FR-17 with `requires-build-tool` reason; the actual fallback execution is owned by ADR-0002's Tier-2 flow in a follow-up track, not by this one.
- **Bazel, sbt, or other JVM build tools.** Out of scope for this plugin entirely.
- **Watching** for build file changes. One-shot invocation only; auto-sync on edit is owned by the hook track per ADR-0001.
- **Caching detection results across invocations** beyond the FR-15 override store. The orchestrator may cache within a single invocation; cross-invocation result caching is the caller's responsibility (the `sync.ts` hook trigger in ADR-0001 will own this).

## Assumptions

- The project root passed to `detect.ts` is a directory the user has read access to. No special handling for symlink loops beyond Node's default behavior.
- "Multi-module" in this spec means the standard Maven `<modules>` declaration in a parent POM, or Gradle `include(...)` calls in `settings.gradle(.kts)`. Custom build-orchestration setups (e.g., `composite builds`, `Maven Reactor` overrides) are not supported.
- Q4 (additional constraints) was not answered; we apply the conservative defaults from `ARCHITECTURE.md` invariants ("Library layer is I/O-free", "no native deps") and `tech-stack.md` dependency policy. NFR-1, NFR-2, NFR-3 enforce this explicitly.
- Bun's filesystem APIs are used in the Domain layer (`scripts/detect.ts`); the Library layer (`scripts/lib/`) takes already-read strings as input so it can be tested with literal fixtures and runs identically under Node fallback.

## References

- `ARCHITECTURE.md` § Dependency Layers, § Architecture Invariants ("Library layer has no I/O", "Domain layer functions are independently runnable")
- `.please/docs/knowledge/tech-stack.md` § Build File Parsing (Gradle/Maven), § Dependency Policy
- Sibling spec: `plugin-scaffold-20260428` (provides the `scripts/lib/` location and test runner this track populates)
- ADR: `.please/docs/decisions/0001-lazy-skill-loading-via-hooks.md` — establishes the `sync.ts` orchestrator that consumes this track's output via `SessionStart`/`FileChanged`/`CwdChanged` hooks.
- ADR: `.please/docs/decisions/0002-three-tier-version-detection.md` — places the requirements in this track at Tier 1; FR-17 is the structured handoff to Tier 2.
- ADR: `.please/docs/decisions/0003-extended-static-parser-coverage.md` — proposes FR-12 through FR-17 as introduced by this amendment, including the local Maven/Gradle cache piggyback approach.
- Gradle version catalog reference: <https://docs.gradle.org/current/userguide/version_catalogs.html> — establishes the published-catalog import contract used by FR-16.
