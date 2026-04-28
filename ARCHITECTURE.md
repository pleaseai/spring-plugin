# Architecture

> Agent-first architecture document for `@pleaseai/spring` — Claude Code plugin
> for Spring ecosystem documentation.

> **Status**: Target architecture. The repository currently contains only
> `README.md`, `LICENSE`, and project metadata; the modules described below
> are the planned implementation. As code lands, this document is updated
> to reflect actual structure (not aspirational design).

## System Overview

**Purpose**: Detect Spring versions in a user's project, resolve the entire Spring component matrix via the Spring Boot BOM, and install version-matched reference docs as Claude Code skills under `.claude/skills/spring-*/`.

**Primary users**:
- **Spring developers using Claude Code** — invoke `/spring:install` once per project; consume the installed skills implicitly through Claude's auto-invocation.
- **Claude Code itself** — auto-loads the generated `SKILL.md` files based on conversation context (the AI agent is a first-class consumer, not just a side-channel).
- **CI / postinstall hooks** — re-run `/spring:install` non-interactively to keep checked-in skills fresh.

**Core workflow** (the `/spring:install` golden path):

1. **Detect**: read `build.gradle` / `build.gradle.kts` / `pom.xml` from project root and extract the declared Spring Boot version (or fall back to a CLI override).
2. **Resolve**: download `spring-boot-dependencies-{version}.pom` from Maven Central and parse `<properties>` to get matching versions for Framework, Security, Data, Cloud, etc.
3. **Acquire**: for each component+version pair, prefer a prebuilt archive from this plugin's GitHub Releases (~3 s); fall back to live HTML→Markdown conversion of `docs.spring.io` Antora content (~30–60 s) when no prebuilt exists.
4. **Install**: write per-component skill directories under `.claude/skills/spring-*/` with `SKILL.md`, `manifest.json`, `INDEX.md`, and `references/...` Markdown.
5. **Annotate**: insert/update a `<!-- spring-skill:start -->` block in the project's `CLAUDE.md` listing the installed components and versions.

**Key constraints**:

- **Idempotent**: re-running `/spring:install` with unchanged versions is a no-op. Safe in postinstall hooks.
- **Version-correct**: zero wrong-version answers is the flagship metric. A regression here blocks release.
- **Offline-capable after first install**: subsequent Claude Code sessions read only from `.claude/skills/`. Air-gapped flows pre-stage archives in `~/.cache/pleaseai-spring/archives/`.
- **No native deps**: keep the install pipeline dependency-light so prebuilt archive builds reproduce across architectures.

## Dependency Layers

Dependencies flow downward only. Lower layers must not import upper layers.

```
┌──────────────────────────────────────────────────┐
│              Interface Layer                     │  Slash commands (commands/*.md)
│              ─────────────────                   │  Plugin manifest (.claude-plugin/plugin.json)
├──────────────────────────────────────────────────┤
│              Skill Layer                         │  skills/spring-installer/SKILL.md
│              ───────────                         │  (Bridges commands → scripts; Claude-invoked)
├──────────────────────────────────────────────────┤
│              Orchestration Layer                 │  scripts/install.ts (top-level pipeline)
│              ───────────────────                 │
├──────────────────────────────────────────────────┤
│              Domain Layer                        │  scripts/detect.ts, scripts/resolve.ts
│              ────────────                        │  scripts/fetch.ts (per-stage logic)
├──────────────────────────────────────────────────┤
│              Library Layer                       │  scripts/lib/antora-rules.ts
│              ─────────────                       │  scripts/lib/manifest.ts
├──────────────────────────────────────────────────┤
│              Infrastructure                      │  Filesystem, network (fetch),
│              ──────────────                      │  ~/.cache/pleaseai-spring/, Maven Central
└──────────────────────────────────────────────────┘
```

**Invariants**:

- **Library layer has no I/O**: pure functions for parsing and conversion. All reads/writes happen one layer up. This keeps `scripts/lib/*` trivially unit-testable with fixture inputs.
- **Domain layer functions are independently runnable**: `bun run scripts/fetch.ts framework 6.2.1 --output /tmp/...` works without first running detect or resolve. Each stage is a usable CLI on its own.
- **Slash commands hold no logic**: `commands/install.md` just delegates; behavior lives in the skill and scripts.

## Entry Points

For understanding **the install pipeline** (most common starting point):

- `commands/install.md` — Slash command entry. Maps `/spring:install` to the installer skill.
- `skills/spring-installer/SKILL.md` — Skill description that Claude Code auto-invokes; orchestrates calls to scripts.
- `scripts/install.ts` — Top-level pipeline: detect → resolve → acquire → install → annotate `CLAUDE.md`.

For understanding **version detection**:

- `scripts/detect.ts` — Parses build files. Read this to see how Gradle/Maven inputs are turned into a Boot version string.
- `scripts/resolve.ts` — Takes a Boot version, fetches the BOM POM, returns the full component version map.

For understanding **doc conversion** (the deepest part of the system):

- `scripts/fetch.ts` — Per-component fetch + convert. Decides prebuilt vs. live based on `prebuilt/catalog.json`.
- `scripts/lib/antora-rules.ts` — Custom Turndown rules for Antora-specific HTML constructs (`xref:`, `include::`, attribute substitution).

For understanding **what gets written to the user's project**:

- `scripts/install.ts` (output section) — How `.claude/skills/spring-*/` is laid out.
- `scripts/lib/manifest.ts` — Schema for `.claude/skills/*/manifest.json` (version, source URL, fetched_at, archive_sha256).

## Module Reference

| Module                      | Purpose                                                | Key Files                                       | Depends On                              | Depended By                  |
| --------------------------- | ------------------------------------------------------ | ----------------------------------------------- | --------------------------------------- | ---------------------------- |
| `.claude-plugin/`           | Plugin manifest (Claude Code convention).              | `plugin.json`                                   | —                                       | Claude Code runtime          |
| `commands/`                 | Slash command entry points (thin Markdown).            | `install.md`, `list.md`, `update.md`, `remove.md`, `add.md` | `skills/spring-installer/`              | Claude Code runtime          |
| `skills/spring-installer/`  | Skill that orchestrates scripts; Claude-invoked.       | `SKILL.md`                                      | `scripts/install.ts`                    | `commands/`                  |
| `scripts/` (orchestration)  | Pipeline driver; one `.ts` per stage.                  | `install.ts`, `detect.ts`, `resolve.ts`, `fetch.ts` | `scripts/lib/`, network, filesystem | `skills/spring-installer/`   |
| `scripts/lib/`              | Pure helpers (parsing, conversion rules, schemas).     | `antora-rules.ts`, `manifest.ts`                | —                                       | `scripts/*.ts`               |
| `prebuilt/`                 | Catalog mapping `{component, version}` → release URL.  | `catalog.json`                                  | —                                       | `scripts/fetch.ts`           |
| `.github/workflows/`        | Nightly archive builds, PR checks, releases.           | `nightly-build.yml`, `ci.yml`, `release.yml`    | —                                       | GitHub Actions runtime       |
| `evals/spring/`             | Task suite measuring pass rate / wrong-version errors. | `run.ts`, `cases/*`                             | Claude Code SDK                         | CI (`.github/workflows/ci.yml`) |
| `.please/`                  | Workspace state (specs, plans, knowledge).             | `config.yml`, `docs/knowledge/*.md`             | —                                       | `/please:*` commands         |

> **Note**: `.please/` is the meta-workspace (track planning, knowledge files);
> `.claude/skills/spring-*/` is the **output** of the plugin written into the
> *user's* project, not a module of this repo.

## Architecture Invariants

These constraints must hold across all changes. Violations are blocking review issues.

**Plugin layout follows Claude Code conventions strictly.**
The manifest lives at `.claude-plugin/plugin.json` and is the **only** file in that directory. All other components (`skills/`, `commands/`, `scripts/`) sit at the plugin root. Path references inside skills/scripts use `${CLAUDE_PLUGIN_ROOT}`. *Why*: Claude Code's plugin loader assumes this layout — deviating breaks discovery.

**Commands hold no logic.**
A `commands/*.md` file is a thin entry point that names a skill or invokes a script. Behavior lives in the skill or in `scripts/`. *Why*: keeps commands inspectable and lets the same logic be reached from scripts/tests without going through the slash-command path.

**Library layer is I/O-free.**
Modules under `scripts/lib/` (e.g., `antora-rules.ts`, `manifest.ts`) accept inputs and return outputs — no `fetch`, no `fs`, no `process.env`. *Why*: lets the bulk of the conversion logic be tested with fixture inputs and run safely in any environment.

**Network calls go through a single boundary.**
All `fetch()` calls live in the orchestration scripts (`scripts/install.ts`, `scripts/resolve.ts`, `scripts/fetch.ts`). Unit tests for those scripts mock the network. *Why*: tests must never hit `docs.spring.io` or Maven Central.

**No native dependencies.**
Do NOT add npm/bun deps with native bindings (e.g., `node-gyp` packages). *Why*: prebuilt archive builds run on multiple architectures in CI; native deps make the build matrix expensive and fragile.

**The BOM is the single source of truth for component versions.**
Do NOT maintain a separate compatibility matrix in this repo. *Why*: any drift between our matrix and Spring's BOM produces wrong-version installs — the very failure mode this plugin exists to prevent.

**The `<!-- spring-skill:start -->` / `<!-- spring-skill:end -->` markers in user `CLAUDE.md` are sacred.**
The plugin reads, writes, and removes content **only** between these markers. Do NOT touch user content above or below. *Why*: users edit their own `CLAUDE.md`; corrupting it breaks trust in the plugin permanently.

**Pre-release Spring versions (RC, M1, SNAPSHOT) are unsupported.**
Do NOT add resolution paths for non-GA versions. *Why*: pre-release docs change between RCs, producing skill files that go stale within days. Users on pre-release lines should not get false confidence from a versioned skill.

**Wrong-version regressions block releases.**
The eval suite must report 0 wrong-version errors before release. A change that introduces even one is reverted, not patched forward. *Why*: this is the flagship correctness metric.

## Cross-Cutting Concerns

**Error handling**

- Boundary errors are **loud and specific**. Build file parse failures print the file path and line, and suggest the override flag (`/spring:install --boot 3.5`).
- Network failures distinguish three modes: no network (suggest manual fallback), 404 (likely an EOL or pre-release version — emit warning, allow user to retry with a different version), rate-limited (back off and retry once).
- Internal contracts are **trusted**. Once `resolve.ts` returns a version map, downstream functions assume the versions are valid; no double-validation in helpers.
- Antora rules **never silently drop** unknown directives — they emit a warning so users can report missing patterns.

**Logging**

- Single-purpose CLI: all output goes to stdout/stderr. No logger library; use a tiny `log()` helper that respects `--verbose`.
- Default verbosity shows progress (one line per stage); `--verbose` adds per-page conversion timing.
- Warnings for unknown Antora directives, EOL versions, and missing prebuilt archives go to stderr with a `[warning]` prefix.

**Testing**

- **Runtime**: Bun's built-in test runner (`bun test`).
- **Unit tests** live next to source: `scripts/lib/antora-rules.test.ts` next to `antora-rules.ts`.
- **Fixture-based**: Antora rule tests use real Spring HTML snippets stored under `tests/fixtures/antora/`. Network is always mocked.
- **Integration tests**: end-to-end run of `scripts/install.ts` against a fixture project (mock `build.gradle`); asserts on the resulting `.claude/skills/spring-*/` layout and the `CLAUDE.md` block content.
- **Eval suite**: `evals/spring/run.ts` runs a Claude Code task suite and reports pass-rate + wrong-version counts. Required on PRs touching `scripts/lib/` or `prebuilt/catalog.json`.
- **Coverage target**: >80% for new code (see `.please/docs/knowledge/workflow.md`).

**Configuration**

- **Project-level**: optional `.spring-skill.json` at user-project root (components allowlist, Boot override, skip-prebuilt flag, custom skills dir, marker name override).
- **CLI flags** override `.spring-skill.json`, which overrides auto-detection.
- **Plugin-internal**: `prebuilt/catalog.json` is the only config inside this repo; everything else is derived per invocation.
- **Caches**: `~/.cache/pleaseai-spring/boms/` (resolved BOMs), `~/.cache/pleaseai-spring/archives/` (downloaded prebuilt tarballs). Caches are content-addressed and safe to delete.

**Distribution**

- **Plugin code**: published via the `pleaseai/` Claude Code plugin marketplace; release tags follow semver, generated by `release-please` from Conventional Commits.
- **Prebuilt archives**: each component+version is a separate GitHub Release on `pleaseai/spring`; assets are tar.gz with sha256 verified at install time.
- **Documentation content**: archives carry upstream Spring license (Apache-2.0) in a `NOTICE` file. We change format (HTML → Markdown), not licensing.

## Quality Notes

**Status: aspirational.**
The repository currently contains only `README.md`, `LICENSE`, and project metadata. None of the modules in the table above exist yet. This document describes the **target shape** so the first implementation track has a coherent skeleton to build into. As code lands, sections move from "planned" to "well-tested" / "fragile" with concrete pointers.

**Expected fragility hotspots** (when implementation begins):

- **`scripts/lib/antora-rules.ts`**: Antora's HTML output evolves with each Spring docs publish. New patterns will surface as bug reports. Strong fixture coverage is non-optional here.
- **`scripts/detect.ts`**: Gradle/Maven build files come in many flavors (version catalogs, Kotlin DSL, multi-module projects, `subprojects { }` blocks). Document fallbacks (`--boot` override) prominently for cases the detector cannot handle.
- **`scripts/resolve.ts`**: Maven Central availability is not 100%. The resolver should cache aggressively and fail clearly when offline.

**Technical debt tracker**: see `.please/docs/tracks/tech-debt-tracker.md`. (Empty until first track is in flight.)

---

_Last updated: 2026-04-28_

_Status: planned architecture (no code yet)_

_Key references:_

- `README.md` — User-facing overview and command reference.
- `.please/docs/knowledge/product.md` — Vision, target users, success metrics.
- `.please/docs/knowledge/tech-stack.md` — Runtime, language, dependency policy.
- `.please/docs/knowledge/workflow.md` — TDD lifecycle, quality gates, eval suite rules.
- _ADRs:_ none yet — first decisions captured under `.please/docs/decisions/` as the implementation begins.
