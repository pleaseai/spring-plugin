# Plan: Build-File Detection

> Track: build-file-detect-20260428
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: build-file-detect-20260428
- **Issue**: (assigned by /please:new-track)
- **Created**: 2026-04-28
- **Approach**: Two-layer separation (pure parsers in `scripts/lib/`, I/O orchestrator in `scripts/detect.ts`). Implement Maven and Gradle parsers in parallel, then layer multi-module/parent-traversal extensions on top of the orchestrator. Each extension is independently mergeable behind the same return contract.

## Purpose

Land the first domain function in the install pipeline: turn a project root into a structured `DetectResult` describing the declared Spring Boot version, or a clear "unsupported"/"not-found" with a `--boot` override suggestion. This becomes the only entry point downstream stages (`resolve.ts`, `install.ts`) use to learn the Boot version.

## Context

The repository has no `scripts/`, no test suite, no ESLint config until `plugin-scaffold-20260428` lands. **This track depends on plugin-scaffold-20260428 merging first**; do not start implementation until that PR is merged. The scaffold track creates `scripts/`, `scripts/lib/`, `scripts/lib/__tests__/`, the placeholder test that proves Bun's runner is wired, the ESLint flat config, and the `bun run typecheck/lint/test` script names this track relies on.

athens-v2's dynamic-loading pivot does **not** affect this track's contract. `detect.ts` returns the same `DetectResult` whether the eventual install writes static Markdown or a thin `@pleaseai/ask`-delegating skill; the consumer of that result changes, not the producer.

## Architecture Decision

**Library/Domain split is non-negotiable.** `ARCHITECTURE.md` states "Library layer has no I/O" as a hard invariant. The pragmatic payoff is enormous here: every parsing edge case (malformed XML, weird Gradle DSLs, parent POM inheritance) becomes a literal-string fixture test that runs in microseconds with zero filesystem mocking. The orchestrator layer (`scripts/detect.ts`) becomes thin enough that its own tests can mock `fs.readFile` without simulating Spring's full universe of valid build files.

**Parsers per build system, not per pattern.** A single `detect-maven.ts` handles every Maven case (parent, BOM, malformed). A single `detect-gradle.ts` handles every Gradle case (Groovy, Kotlin, plugins block, apply plugin + ext). Splitting per pattern would scatter the regex/XML knowledge across files and make it hard to share fixture inputs.

**Multi-module / parent traversal is orchestrator concern, not parser concern.** Parsers receive an already-read string and return a `DetectResult` (or a partial signal that says "no version here, but this file references parent X"). The orchestrator owns the walking and bounds the search depth. This keeps parsers I/O-free and keeps the walking logic in one place where the depth bound is enforced uniformly.

**Use `fast-xml-parser` for XML, regex for Gradle DSL.** `tech-stack.md` already settled this: regex is sufficient for the patterns we care about; full Groovy/Kotlin AST parsing is overkill and adds heavyweight deps. `fast-xml-parser` is a pure-JS, no-native-deps choice that handles malformed XML by throwing — which we catch and convert to `kind: 'unsupported'`.

**ESLint custom rule, not a separate guard test.** A custom rule in `eslint.config.js` (using `no-restricted-imports`) is more idiomatic and runs as part of the standard `bun run lint`. A guard test that `grep`s files would also work but is harder to discover and easier to ignore.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────┐
│ CLI: bun run scripts/detect.ts <project-dir>        │
└─────────────────┬───────────────────────────────────┘
                  │ JSON to stdout, exit 0/1/2
                  ▼
┌─────────────────────────────────────────────────────┐
│ Domain Layer — scripts/detect.ts                    │
│                                                     │
│  detect(projectDir) → DetectResult                  │
│   1. Discover build files (pom.xml | build.gradle*) │
│   2. Read file(s) from disk                         │
│   3. Dispatch to Maven or Gradle parser             │
│   4. If parser returns "no version found":          │
│      - Maven: walk <parent><relativePath> (≤5 hops) │
│      - Maven: walk <modules>                        │
│      - Gradle: walk settings.gradle(.kts) include() │
│   5. Aggregate to single DetectResult               │
└─────────────────┬───────────────────────────────────┘
                  │ already-read string + path label
                  ▼
┌─────────────────────────────────────────────────────┐
│ Library Layer — scripts/lib/ (NO I/O)               │
│                                                     │
│  detect-types.ts:    DetectResult, DetectSource     │
│  detect-maven.ts:    parsePom(xml, file) → result   │
│                      (uses fast-xml-parser)         │
│  detect-gradle.ts:   parseGroovy(src, file)         │
│                      parseKotlin(src, file)         │
│                      (regex-based)                  │
└─────────────────────────────────────────────────────┘
```

Data flow: each layer takes typed input and returns a typed result. Parsers never reach for `fs`; the orchestrator never knows the syntax of pom.xml or Gradle DSL.

## Tasks

- [x] T001 Define `DetectResult` and `DetectSource` types (file: `scripts/lib/detect-types.ts`)
- [x] T002 [P] Implement Maven parser with `fast-xml-parser` for spring-boot-starter-parent + spring-boot-dependencies BOM cases (file: `scripts/lib/detect-maven.ts`, `scripts/lib/__tests__/detect-maven.test.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/maven/`) (depends on T001)
- [x] T003 [P] Implement Gradle parser with regex for Groovy + Kotlin DSL (plugins block, apply plugin + ext) (file: `scripts/lib/detect-gradle.ts`, `scripts/lib/__tests__/detect-gradle.test.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/gradle/`) (depends on T001)
- [x] T004 Implement Domain orchestrator + CLI for single-file detection (Maven and Gradle, no multi-module yet) (file: `scripts/detect.ts`, `scripts/__tests__/detect.test.ts`) (depends on T002, T003)
- [ ] T005 Add Maven parent POM inheritance traversal (≤5 hops, follows `<parent><relativePath>`) (file: `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/maven-parent/`) (depends on T004)
- [ ] T006 [P] Add Maven multi-module walk (scan `<modules>` for first child with declared Boot version) (file: `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/maven-multimodule/`) (depends on T004)
- [ ] T007 [P] Add Gradle multi-module walk (parse `settings.gradle(.kts)` `include(...)` and scan one level of subprojects) (file: `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/gradle-multimodule/`) (depends on T004)
- [ ] T008 [P] Add ESLint `no-restricted-imports` rule that bans `node:fs`, `node:net`, `node:http`, `bun` from `scripts/lib/**/*.ts` (file: `eslint.config.js`) (depends on T002, T003)
- [ ] T009 [P] Wire `bun test --coverage` into CI and add a coverage threshold check that fails CI if branch coverage of `scripts/lib/detect-*.ts` falls below 90% (file: `.github/workflows/ci.yml`, optional `bunfig.toml`) (depends on T002, T003)
- [ ] T010 Spot-check on three real Spring sample projects, record versions and exit codes in PR description (manual; no file change) (depends on T005, T006, T007)
- [ ] T011 [P] Implement Gradle version catalog and `gradle.properties` resolver (file: `scripts/lib/detect-gradle-catalog.ts`, `scripts/lib/__tests__/detect-gradle-catalog.test.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/gradle-catalog/`) — covers FR-12 (depends on T003, T004)
- [ ] T012 [P] Add `settings.gradle(.kts)` `pluginManagement` block as a version source in the orchestrator (file: `scripts/lib/detect-gradle-settings.ts`, `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/gradle-plugin-management/`) — covers FR-13 (depends on T004, T007)
- [ ] T013 [P] Add Maven external parent POM lookup via `~/.m2/repository` cache (file: `scripts/detect.ts`, `scripts/lib/maven-cache.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/maven-m2-cache/`) — covers FR-14 (depends on T005)
- [ ] T014 Implement `--boot` override persistence and short-circuit (file: `scripts/lib/overrides.ts`, `scripts/detect.ts`, `scripts/lib/__tests__/overrides.test.ts`) — covers FR-15 (depends on T004)
- [ ] T015 [P] Implement Gradle published version catalog fetch with cache-first lookup (file: `scripts/lib/detect-published-catalog.ts`, `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/gradle-published-catalog/`) — covers FR-16 (depends on T011, T012); routes network calls through `scripts/resolve.ts`'s fetch client to preserve the single-network-boundary invariant
- [ ] T016 Add `requires-build-tool` reason taxonomy and corresponding suggestion message; update `DetectResult` documentation accordingly (file: `scripts/lib/detect-types.ts`, `scripts/detect.ts`, fixtures under `scripts/lib/__tests__/fixtures/detect/requires-build-tool/`) — covers FR-17 (depends on T001, T011, T013)

## Dependencies

```
T001
 ├── T002 [P] ─┐
 └── T003 [P] ─┤
                ├── T004 ──┬── T005 ──── T013 [P]
                │          ├── T006 [P]
                │          ├── T007 [P] ─┬── T012 [P]
                │          ├── T010
                │          ├── T011 [P] ─┬── T015 [P]
                │          │              └── T016 (also depends on T013)
                │          └── T014
                ├── T008 [P]
                └── T009 [P]
```

The graph has four natural batches:

1. **After T001 lands**: T002 and T003 run in parallel.
2. **After T002 + T003 land**: T004, T008, T009 can all proceed (T004 is the bottleneck for the next batch; T008 and T009 are independent guard tasks that can run alongside).
3. **After T004 lands**: T005, T006, T007, T011, T014 in parallel; T010 waits for T005/T006/T007.
4. **After T005, T007, T011 land**: T012, T013, T015 can proceed in parallel; T016 starts after T011 + T013 land — these implement the FR-12~17 amendments (per ADR-0003).

## Key Files

- `scripts/lib/detect-types.ts` — single source of truth for `DetectResult` shape; consumed by every parser and the orchestrator.
- `scripts/lib/detect-maven.ts` — pure XML parsing; uses `fast-xml-parser`. No `fs`. Tests pass literal XML strings.
- `scripts/lib/detect-gradle.ts` — pure regex parsing for Groovy and Kotlin DSL. No `fs`. Tests pass literal source strings.
- `scripts/detect.ts` — orchestrator + CLI. Owns all `fs.readFile` calls, multi-module walking, parent traversal bound, exit code mapping. The single I/O boundary for detection.
- `scripts/lib/__tests__/fixtures/detect/` — fixture tree mirrors the AC matrix; each subdirectory is one row.
- `eslint.config.js` — extended with the `no-restricted-imports` rule that protects the Library Layer invariant.
- `.github/workflows/ci.yml` — gains the `--coverage` flag plus a threshold gate.

## Verification

Mapping to spec acceptance criteria:

- **AC-1** (fixture matrix coverage): T002 covers the first 4 Maven rows; T005 adds the sibling parent-POM row; T013 adds the external-parent `~/.m2` cache hit/miss rows (FR-14); T006 adds the two multi-module Maven rows; T003 covers the Gradle Groovy and Gradle Kotlin rows; T007 adds the Gradle multi-module subproject row; T011 adds the `libs.versions.toml` and `gradle.properties` rows (FR-12); T012 adds the `pluginManagement` row (FR-13); T015 adds the published-catalog row (FR-16); T014 adds the prior-override row (FR-15); T016 adds the `buildSrc/` row with `requires-build-tool` reason (FR-17); the `unsupported` (malformed XML) and `not-found` (empty dir, no Boot at all) rows are covered jointly by T002 + T003 + T004.
- **AC-2** (suggestion always present): asserted in every `unsupported`/`not-found` test in T002, T003, T004, T011, T013, T015, T016. T016 additionally asserts that the suggestion mentions both the build-tool fallback (per ADR-0002) and `--boot` override.
- **AC-3** (CLI exit code mapping): asserted in T004's CLI tests (one process-spawn test per `kind`); T014 adds tests for `--boot` and `--clear-override` flags.
- **AC-4** (90% branch coverage): enforced by T009 in CI; expanded coverage targets to include the new `scripts/lib/detect-gradle-catalog.ts`, `detect-gradle-settings.ts`, `detect-published-catalog.ts`, `overrides.ts`, and `maven-cache.ts` modules.
- **AC-5** (real-project spot check): T010 manual; recorded in PR description. With FR-12~17 in place, the spot-check should include at least one project using a version catalog and one using a `pluginManagement` block.
- **AC-6** (no I/O imports in `scripts/lib/`): enforced by T008 ESLint rule; runs as part of `bun run lint`. The rule applies to all new lib modules introduced by T011, T012, T015, T016. T013/T014 (which need filesystem and network access) live in `scripts/detect.ts` (orchestrator) or use a lib helper that takes already-read content as input.

Each task is "done" when its tests are green and the relevant SC is checked off in the spec.

## Progress

- 2026-04-30 — T001 ✅ `DetectResult` / `DetectSource` types + type guards landed in `scripts/lib/detect-types.ts`. Added `REQUIRES_BUILD_TOOL` and `SUGGEST_BOOT_OVERRIDE` literals to enable consistent attribution across FR-9, FR-15, FR-17.
- 2026-04-30 — T002 ✅ Maven parser `parsePom(xml, file)` covers FR-1 + FR-2; emits `MavenHints` (parent + modules) for downstream traversal (T005, T006, T013). Pure function, fast-xml-parser-backed, malformed XML → `unsupported`. 10 fixture-driven tests.
- 2026-04-30 — T003 ✅ Gradle parser `parseGradle(source, file)` covers FR-3 + FR-4 across plugins blocks (Groovy/Kotlin), apply plugin + ext, classpath, and `ext['spring-boot.version']`. Emits `GradleHints` (pluginReferenced, catalogReference for FR-12, propertyReference for FR-12 / FR-17 inputs). 11 fixture-driven tests.
- 2026-04-30 — T004 ✅ Domain orchestrator `detect(projectDir)` + CLI in `scripts/detect.ts`. Maven precedes Gradle when both build files are present. CLI emits JSON to stdout with exit codes per FR-11 (0 detected / 1 unsupported|not-found / 2 internal). 13 tests including 4 `Bun.spawn`-based CLI exit-code tests.

## Decision Log

- **2026-04-29 — ADR-0001 (Lazy Skill Loading via Hooks)**: This track's `detect.ts` is invoked by `sync.ts` from Claude Code hooks (`SessionStart`, `FileChanged`, `CwdChanged`) instead of from a one-shot `/spring:install` command. NFR-5 (≤100ms warm-cache detection) becomes load-bearing because detection runs on every session start and every build-file save.
- **2026-04-29 — ADR-0002 (Three-Tier Version Detection)**: This track is Tier 1. FR-17 codifies the structured handoff to Tier 2 (build-tool fallback) for `buildSrc/`, settings plugins, and `${revision}` interpolation. Tier 2 implementation lives in a separate track; this track only marks the escalation in the result.
- **2026-04-29 — ADR-0003 (Extended Static Parser Coverage)**: Adds FR-12 (version catalog + `gradle.properties`), FR-13 (`pluginManagement`), FR-14 (`~/.m2` external parent cache), FR-15 (`--boot` override persistence), FR-16 (published catalog fetch), and FR-17 (build-tool reason taxonomy). Tasks T011–T016 in this plan implement these FRs.
- **Open**: 5-hop traversal bound (FR-5) for sibling parent POMs is unchanged; if real-world projects exceed this, file a follow-up ADR ("detect.ts multi-module walk depth bound") rather than silently raising the limit.

## Surprises & Discoveries

(Implementation will record unexpected findings here — e.g., real-world Gradle DSL patterns the regex misses.)
