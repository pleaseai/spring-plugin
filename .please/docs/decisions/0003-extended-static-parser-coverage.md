# ADR-0003: Extended Static Parser Coverage and Local Build-Tool Cache Lookup

## Status

Proposed

## Context

ADR-0002 places Tier 1 (Bun static parsing) at the core of version
detection, claiming ~95% coverage. The current `build-file-detect-20260428`
spec only mandates parsing four files:

- `pom.xml`
- `build.gradle`
- `build.gradle.kts`
- Parent POMs reachable via `<parent><relativePath>` (≤5 hops)

These four files alone cover only **70–80% of real-world Spring projects**.
The gap is real and well-defined:

| Pattern | Required source | Currently in spec? |
|---|---|---|
| Maven property substitution from inherited parent | parent POM `<properties>` | partially (FR-5) |
| Gradle property substitution: `version "$springBootVersion"` | `gradle.properties` | no |
| Version catalog: `version libs.versions.spring.boot.get()` | `gradle/libs.versions.toml` | no |
| `pluginManagement { plugins { id ... version ... } }` | `settings.gradle(.kts)` | no |
| `dependencyResolutionManagement.versionCatalogs.from("g:a:v")` | published catalog artifact | no |
| `<parent>` without sibling `<relativePath>` | `~/.m2/repository` cache | no |
| `--boot` user override | persistent override store | no |

These remaining patterns are **all statically resolvable by Bun** — they
require reading additional plain-text files (TOML, properties, XML), or in
the published-catalog case, fetching a TOML file from a Maven repository
URL. None require build-script execution, JDK installation, or build-tool
invocation. They cleanly stay within the Tier-1 envelope.

There is also a high-value optimization adjacent to this work: when the
user has previously run `mvn install` or `./gradlew build`, the resolved
BOM is already on disk under `~/.m2/repository/.../spring-boot-dependencies-X.Y.Z.pom`
(Maven) or under `~/.gradle/caches/modules-2/files-2.1/...` (Gradle).
`scripts/resolve.ts` can read these directly and skip the Maven Central
fetch (~3s saved per cache hit, plus full offline support when the local
cache is populated).

Without this ADR, Tier 1 underperforms its 95% target, Tier 2 fires more
often than necessary (with its consent prompts and JDK requirement), and
the project does not exploit the user's prior build effort.

## Decision

Extend `scripts/detect.ts` and `scripts/lib/` to read the following
additional sources, in this order, before declaring a result `unsupported`:

**Static file sources (Tier 1):**

1. `gradle/libs.versions.toml` (default Gradle version catalog).
2. `gradle.properties` (root and per-module) for variable substitution into
   Gradle plugin/dependency declarations.
3. `settings.gradle(.kts)` `pluginManagement { plugins { ... } }` block as
   an additional plugin-version source.
4. Maven external parent POM lookup in `~/.m2/repository` when the project's
   `<parent>` has no `<relativePath>` pointing at a sibling project file.

**Network-fetched sources (still Tier 1):**

5. Published version catalog: when `settings.gradle(.kts)` declares
   `versionCatalogs { create(...) { from("group:artifact:version") } }`,
   parse the `repositories { ... }` block to derive the Maven URL of the
   `.toml` artifact, fetch it via the same fetch path used by
   `scripts/resolve.ts`, and parse it. Reuse `~/.m2`, `~/.gradle`, and our
   own `~/.cache/pleaseai-spring/` caches before hitting the network.

**Persistence:**

6. User `--boot` overrides persist in
   `~/.cache/pleaseai-spring/overrides.json` keyed by `sha256(project_dir)`.
   Skill flow consults this store before invoking detection.

**Resolver-side complement (`scripts/resolve.ts`):**

7. When resolving the Spring Boot BOM (`spring-boot-dependencies-{version}.pom`),
   look up local Maven and Gradle dependency caches before fetching from
   Maven Central. Order: `~/.cache/pleaseai-spring/boms/` →
   `~/.m2/repository/org/springframework/boot/spring-boot-dependencies/` →
   `~/.gradle/caches/modules-2/files-2.1/org.springframework.boot/spring-boot-dependencies/`
   → Maven Central.

These extensions are formalized as new functional requirements appended to
the `build-file-detect-20260428` spec:

```
FR-12: Resolve Gradle plugin version when declared via version catalog
       (`libs.versions.toml`) or `gradle.properties` substitution.
FR-13: Inspect `settings.gradle(.kts)` `pluginManagement { plugins { ... } }`
       block as a version source.
FR-14: Resolve Maven external parent POM via ~/.m2/repository lookup when
       the project's <parent> declaration omits <relativePath> or its
       <relativePath> does not resolve to a sibling project file on disk.
       Fall back to `unsupported` if not cached locally.
FR-15: Persist `--boot` override per project to
       ~/.cache/pleaseai-spring/overrides.json keyed by project_dir hash.
FR-16: Resolve published version catalog (`from("group:artifact:version")`):
       parse settings.gradle repositories, derive the TOML artifact URL,
       fetch via the same path as the spring-boot-dependencies BOM. Reuse
       caches before network.
FR-17: Document escalation to Tier 2 (ADR-0002) for `buildSrc/`, settings
       plugins, and any pattern requiring JVM evaluation. The detect
       result for these paths returns `unsupported` with a specific
       suggestion to consent to build-tool fallback or pass `--boot`.
```

## Consequences

### Positive

- **Tier 1 coverage rises from ~70–80% to ~92–95%**, deferring fewer
  projects to consent-gated Tier 2.
- **Latency stays at ~50ms** for the common case — TOML/properties
  parsing is trivial. The only network exposure is FR-16 (published
  catalog), which only fires when a project actually uses one.
- **Local cache piggyback is essentially free**: `~/.m2` and `~/.gradle`
  reads are static-file reads. Resolve cost drops from ~3s (Maven
  Central) to ~10ms (cache hit) on machines that have previously built
  the project.
- **Full offline support after first build**: a developer who has run
  `./mvnw install` or `./gradlew build` has all required artifacts on
  disk; no network access is needed by detection or resolution.
- **Override persistence (FR-15) is reusable across all tiers**:
  Tier 2 consent grants and Tier 3 `--boot` values share the same
  store with consistent revocation semantics.
- **Tier 2 maintenance burden drops**. With Tier 1 catching 95% of
  cases, Tier 2 only needs to handle the genuinely dynamic 5%
  (`buildSrc/`, settings plugins).

### Negative

- **More fixture surface**. Each new source needs fixture-based tests:
  TOML samples, properties files, settings.gradle plugin blocks, partial
  `~/.m2` layouts. The `tests/fixtures/detect/` tree grows substantially.
- **TOML parser dependency**. Bun ships a TOML parser, but using it ties
  the I/O-free library layer to a Bun-specific API or a small TOML
  library (e.g., `@iarna/toml`). Pick one and document.
- **Cache layout assumptions**. `~/.m2/repository` and
  `~/.gradle/caches/modules-2/files-2.1/` are conventional but not
  contractual. Layout changes (rare but historical) would break FR-14
  (Maven external parent lookup) and FR-16 (published-catalog Gradle
  cache lookup). Mitigation: detect cache layout version, fall back
  to next source.
- **Published catalog fetch (FR-16) introduces network dependency in a
  new place**. Currently only `resolve.ts` and `fetch.ts` make network
  calls (the "single boundary" invariant). FR-16 needs to route through
  the same client used by `resolve.ts` to preserve that invariant.
- **Multi-module `gradle.properties`** semantics: subproject overrides
  root. The detector must walk the module hierarchy correctly. Document
  this and test with fixtures.

### Neutral

- The four base files in the original spec remain authoritative; this
  ADR layers additional sources on top. Existing test fixtures stay
  valid.
- This work is parallel-friendly: `gradle.properties` parsing, version
  catalog parsing, and `~/.m2` lookup are independent modules and
  independent tasks. They can land in any order.
- The escalation contract (FR-17) clarifies that Tier 1 is honest about
  its limits. `unsupported` returns include the specific source pattern
  that defeated parsing, so users know whether to consent to Tier 2 or
  use `--boot`.

## Alternatives Considered

- **Keep the spec at 4 files; rely on Tier 2 for the rest**:
  rejected. Tier 2 has a JDK prerequisite and consent UX cost. Solving
  cases that are statically resolvable using Tier 2 imposes that cost
  unnecessarily on a large minority of users.

- **Add only `libs.versions.toml`; leave the rest for later**:
  partial improvement. `libs.versions.toml` alone covers the most
  common modern Gradle case but misses `gradle.properties` (very common
  in older projects), `pluginManagement` (idiomatic with composite
  builds), and `~/.m2` lookup (essential for enterprise projects with
  corporate parents). Better to commit to the full set so Tier 2 has
  a clear, narrow remit.

- **Use a generic Groovy/Kotlin AST parser for `settings.gradle(.kts)`**:
  rejected. AST parsing is heavyweight (JVM dependency or large Wasm
  bundle) and brittle (DSL evolves with Gradle versions). Targeted
  regex on `pluginManagement { plugins { id ... version ... } }`
  handles the patterns we care about with far less surface.

- **Skip `~/.m2` / `~/.gradle` cache lookup; always fetch from Maven
  Central**: rejected. The latency win (3s → 10ms) and full offline
  support are too valuable to leave on the table, and the
  implementation is reading well-known file paths — modest complexity.

## Related

- ADR-0002: Three-Tier Version Detection — Tier 1 is the addressee of
  this ADR's extensions.
- ADR-0001: Lazy Skill Loading via Hooks — relies on Tier 1 staying
  fast (~50ms) even with these extensions.
- Spec: `.please/docs/tracks/active/build-file-detect-20260428/spec.md`
  — extend with FR-12 through FR-17 as proposed above.
- Plan: `.please/docs/tracks/active/build-file-detect-20260428/plan.md`
  — add tasks for the new sources.
- Reference: Gradle version catalogs documentation
  (`https://docs.gradle.org/current/userguide/version_catalogs.html`)
  — establishes the published-catalog import contract used by FR-16.
