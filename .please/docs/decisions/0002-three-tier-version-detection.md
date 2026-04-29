# ADR-0002: Three-Tier Spring Boot Version Detection Strategy

## Status

Proposed

## Context

`@pleaseai/spring` must determine the Spring Boot version declared by a user
project so that downstream stages (`resolve.ts`, `@pleaseai/ask` delegation)
fetch version-correct documentation. Wrong-version answers are the flagship
failure mode the plugin exists to prevent (`ARCHITECTURE.md` invariant:
*"Wrong-version regressions block releases"*).

Real-world Spring projects declare the Boot version through many mechanisms:

- Plain `<parent>spring-boot-starter-parent</parent>` in `pom.xml`
- `<dependencyManagement>` BOM imports (Maven)
- `id 'org.springframework.boot' version '3.x'` in `build.gradle(.kts)`
- Gradle version catalogs (`gradle/libs.versions.toml`)
- `gradle.properties` variable substitution
- `pluginManagement` block in `settings.gradle(.kts)`
- Corporate parent POM in private Nexus
- Programmatic definition in `buildSrc/`
- Gradle init scripts (system-level)
- CI variable interpolation (`<version>${revision}</version>`)

A single-strategy detector cannot cover all of these without prohibitive cost.
Two architectural pressures pull in opposite directions:

1. **Coverage**: missing a common pattern produces silent wrong-version
   installs.
2. **Cost**: invoking `mvn`/`gradle` on every detection imposes 5–60s latency,
   JDK prerequisite, build-script execution (RCE surface), and lock contention
   with the user's IDE/CLI.

Detection runs frequently in the lazy-loading model (ADR-0001): once at
`SessionStart`, on every `FileChanged` event for build files, and on every
`CwdChanged`. A 30s detection cost would compound into hundreds of seconds of
background work per development session.

## Decision

Adopt a **three-tier escalating detection strategy**:

**Tier 1 — Bun static parsing (default, ~95% coverage, ~50ms)**

Pure-JavaScript parsing in `scripts/lib/detect-*.ts` using `fast-xml-parser`
for Maven and regex for Gradle DSL. Reads `pom.xml`, `build.gradle(.kts)`,
`settings.gradle(.kts)`, `gradle/libs.versions.toml`, `gradle.properties`,
parent POMs via `<relativePath>`, and the local Maven/Gradle dependency caches
(`~/.m2/repository`, `~/.gradle/caches`). I/O-free per `ARCHITECTURE.md`
invariant — all reads happen in the orchestrator (`scripts/sync.ts`).

**Tier 2 — Build tool fallback (opt-in, ~+5% coverage, 5–30s, consent required)**

Only fires when Tier 1 returns `kind: 'unsupported'` AND the user has granted
consent for the project. Used as an *expander*, not an *evaluator*:

- Maven: `mvn help:effective-pom -q -Doutput="$(mktemp -t spring-detect-effective-XXXXXX.xml)"` →
  Tier-1 parser reads the flattened POM. The implementation uses `mktemp(1)`
  (or a per-project path under `~/.cache/pleaseai-spring/tier2/<sha256(project_dir)>.effective-pom.xml`)
  rather than a fixed `/tmp/effective.xml` to avoid race conditions and
  cross-project reads under concurrent detection invocations triggered by
  the lazy hooks (ADR-0001).
- Gradle: custom init script at
  `~/.cache/pleaseai-spring/gradle-detect-init.gradle` prints the resolved
  Spring Boot plugin version to stdout → Tier-1 string parser consumes it.

Consent is persisted in
`~/.cache/pleaseai-spring/overrides.json` keyed by `sha256(project_dir)` and
includes the tool (`mvn` | `gradle`), grant timestamp, and a revoke command.
CI uses `PLEASEAI_SPRING_ALLOW_BUILD_TOOL=1` for non-interactive consent.

**Tier 3 — User `--boot` override (last resort)**

Persisted in the same `overrides.json`. Used when Tier 2 is unavailable
(no JDK), refused, or also fails (private Nexus parent without credentials).

The escalation owner is `scripts/sync.ts` (Domain Layer). Library Layer
parsers remain string-in/result-out and never invoke `child_process`.

## Consequences

### Positive

- **95% of projects pay only ~50ms** for detection — the lazy-loading model
  (ADR-0001) becomes feasible because the per-session detection cost is
  negligible.
- **No JDK prerequisite for the common case**. Tier 2 only requires a JDK
  when the user opts in for projects that genuinely need it.
- **RCE surface is opt-in and per-project**. Build script execution requires
  explicit consent; default behavior never executes user code.
- **Library-layer invariant preserved**. Tier 2 uses CLI as a flattening
  preprocessor; the actual parsing remains in pure functions that accept
  strings.
- **Spec FR-9 (`unsupported` with `--boot` suggestion) is naturally satisfied**.
  Each tier hands off to the next with structured reason and suggestion fields.
- **CI behavior is predictable**. CI environments default to Tier 1; Tier 2
  requires explicit env-var consent.

### Negative

- **Tier 2 implementation must handle two build tools differently**.
  `effective-pom` is clean; Gradle has no equivalent and requires a custom
  init script — additional maintenance surface.
- **Three escalation paths increase the test matrix**. Each tier needs its
  own fixture set and the consent flow needs end-to-end coverage.
- **First-time `unsupported` users see a consent prompt mid-session**. This
  is an unavoidable UX cost of "do not execute user code by default."
- **Tier 2 latency (5–30s) is still real** for users in that 5%. The
  `asyncRewake: true` hook pattern (ADR-0001) absorbs it but does not
  eliminate it.

### Neutral

- Three tiers map cleanly to spec FR-8 result kinds: Tier 1 success →
  `detected`; Tier 1 fail without consent → `unsupported`; Tier 2 success →
  `detected (source: build-tool-fallback)`; all-tier fail → `not-found` or
  `unsupported` with `--boot` suggestion.
- Caching is unified. All three tiers write to the same
  `~/.cache/pleaseai-spring/projects/<hash>.json` schema.

## Alternatives Considered

- **Single-tier Bun static parsing only**: simpler, but the residual ~5%
  (`buildSrc/`, settings plugins, private Nexus parents) would all surface
  as `unsupported` with no recourse beyond manual `--boot`. Acceptable for
  early users but degrades the value proposition for enterprise projects.

- **Single-tier `mvn`/`gradle` CLI evaluation**: highest coverage (~99%)
  but imposes JDK requirement, 5–60s latency on every detection,
  build-script RCE on every run, and lock contention with the user's
  IDE/CLI. Incompatible with the per-`FileChanged` hook frequency in
  ADR-0001.

- **Hybrid where Tier 2 fires automatically without consent**: rejected
  on security grounds. `/spring:install` and its hooks may be triggered
  by Claude Code automatically on session start; silently executing
  `./gradlew` of an untrusted repo is a code-execution vulnerability.

- **Network-based BOM evaluation service**: a hosted service that takes
  `pom.xml`/`build.gradle` content and returns the resolved Boot version.
  Rejected: introduces a hard external SLA dependency, privacy concerns
  (uploading internal build files), and does not solve the `buildSrc/`
  case (which is local code).

## Related

- ADR-0001: Lazy Skill Loading via Hooks — depends on Tier 1 being fast.
- ADR-0003: Extended Static Parser Coverage — defines exactly which sources
  Tier 1 reads.
- Spec: `.please/docs/tracks/active/build-file-detect-20260428/spec.md`
  (FR-9 unsupported handling, FR-10 not-found handling).
- ARCHITECTURE.md invariants: "Library layer is I/O-free", "Network calls go
  through a single boundary", "Wrong-version regressions block releases".
