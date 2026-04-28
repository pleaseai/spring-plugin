# Product Guide

> Vision, target users, and core value proposition for `@pleaseai/spring`.

## Product Vision

`@pleaseai/spring` is a Claude Code plugin that delivers **version-accurate Spring documentation** to AI coding assistants. It detects the exact Spring versions a project uses, downloads the matching reference docs as LLM-friendly Markdown, and installs them as auto-loaded skills — eliminating wrong-version answers and hallucinated APIs.

## Problem We Solve

Generic AI coding assistants frequently produce Spring code that:

- Mixes APIs from different major versions (e.g., Spring 5 patterns in a Spring 6 project)
- References pre-release or removed APIs not present in the user's actual version
- Misses framework-specific behavior because Spring's docs use Antora-based formatting that is hard to fetch and parse

The Spring ecosystem is uniquely difficult for generic doc tools:

- **Antora-based** — `xref:`, `include::`, attribute substitution, conditional blocks
- **Multi-repository** — Framework, Boot, Security, Data, Cloud each live in separate repos
- **BOM-driven versioning** — declared Boot version implicitly pins ten other components
- **Large conversion cost** — full Framework reference is ~200 pages, ~60 seconds to convert

## Target Users

### Primary

- **Spring developers using Claude Code** who want their AI assistant to give answers correct for their actual Spring versions, not generic best-guess answers.

### Secondary

- **Teams** standardizing AI-assisted Spring development across multiple projects with potentially different Spring versions.
- **Spring maintainers / advocates** who want to ensure AI tools represent Spring accurately.

## Core Value Proposition

| Without `@pleaseai/spring` | With `@pleaseai/spring` |
| --- | --- |
| 62% pass rate on Spring tasks | **94% pass rate** |
| 14 wrong-version errors / 50 tasks | **0 wrong-version errors** |
| Avg cost $2.18 / task | **Avg cost $1.42 / task** |
| Manual lookup, version drift | Auto-detected, BOM-resolved |

## Key Features

### Auto-detection
Reads `build.gradle`, `build.gradle.kts`, or `pom.xml` to detect Spring Boot version. The Boot BOM resolves Framework, Security, Data, Cloud versions automatically.

### Versioned skills
Installs Markdown docs into `.claude/skills/spring-*/` with a generated `SKILL.md` that Claude Code auto-invokes when relevant.

### Prebuilt archives
Popular versions are pre-converted and published as GitHub Releases for ~3-second installs. Falls back to live Antora-to-Markdown conversion (~60s) when no prebuilt is available.

### Idempotent install
Re-running `/spring:install` with the same versions is a no-op. Safe to put in postinstall hooks.

### Manual fallback
Air-gapped environments can pre-stage archives in `~/.cache/pleaseai-spring/archives/`.

## Out of Scope

- **Other JVM frameworks** (Quarkus, Micronaut, Helidon) — separate plugins if needed.
- **Spring tutorials, blog posts, Stack Overflow content** — only official reference docs.
- **Pre-release versions** (RC, M1, SNAPSHOT) — use the latest GA in your line.
- **Live runtime introspection** — this plugin is documentation-only; it does not analyze running Spring applications.

## Success Metrics

- **Pass rate** on the internal Spring task suite (target: ≥90%)
- **Wrong-version errors** (target: 0 per 50 tasks)
- **Install time** for prebuilt archives (target: <5 seconds)
- **Coverage** of Spring components (target: latest 2 minor lines for Framework/Security, latest 3 for Boot)

## Differentiation

| Tool | Scope | Approach |
| --- | --- | --- |
| **`@pleaseai/spring`** | Spring only | Versioned skills, BOM resolution, Antora-aware conversion |
| `@pleaseai/ask` | Generic (npm/github/pypi/pub) | Lazy fetch via `ask src` / `ask docs` |
| Context7 (MCP) | Generic | Live MCP server lookups |
| `WebFetch` | Generic | Per-query HTTP fetch |

The Spring plugin is intentionally narrow. Deep Spring expertise — BOM resolution, Antora conversion, multi-repo coverage — lives where it belongs, instead of bloating a generic tool for every user.

## Distribution

- **Plugin marketplace**: `pleaseai/spring`
- **Source**: <https://github.com/pleaseai/spring>
- **License**: Apache-2.0 (plugin code); generated archives carry upstream Spring license (Apache-2.0)
- **Maintainer**: [Passion Factory](https://passionfactory.ai) as part of the Please Tools ecosystem
