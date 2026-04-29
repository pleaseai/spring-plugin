# Plan: Spring Ask Skill (Thin Delegating Skill)

> Track: spring-ask-skill-20260429
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: ADR-0001 (lazy-skill-loading-via-hooks); spec.md
- **Issue**: TBD
- **Created**: 2026-04-29
- **Approach**: Single-file skill authoring with a referenced library-mapping table. The bulk of the work is writing precise instructions Claude can follow deterministically — there is almost no executable code in this track. The track is gated by `hook-sync-20260429` shipping the cache producer; it should land in the same release window so neither side is dangling.

## Purpose

After this track ships, a Claude Code user asking a Spring question in a Spring project gets a version-correct answer fetched on-demand from `@pleaseai/ask` — no per-component skill files, no upfront install, no manual command. The user verifies it works by asking "How do I configure OAuth2 with Spring Security?" in a Boot 3.5.0 project and observing that the response cites Spring Security 6.4.x documentation (not 5.x or 6.0.x).

## Context

ADR-0001 defines the lazy-loading model. The `hook-sync-20260429` track produces the per-project version cache. This track produces the consumer: a single thin skill that reads that cache and delegates to `@pleaseai/ask` with the resolved version pinned.

The skill is unusual for this codebase because it is mostly *prose*, not code. The "implementation" is writing instructions Claude follows reliably. Quality here is measured by how often Claude correctly maps a question to a library, reads the cache, and constructs the right delegation call — measurable via the eval suite once it lands.

The cache shape, override store, and consent flow are defined by sibling tracks. This track only consumes them. If those contracts change, this track's instructions are updated; the change is mechanical.

## Architecture Decision

**One skill, one file.** Per-library skills (`spring-framework`, `spring-security`, etc.) duplicate instructions that differ only in a library identifier. A single skill with a mapping table is dramatically less maintenance and matches the "thin delegation" philosophy of ADR-0001.

**Library mapping is a separate file, loaded only when needed.** Inlining the full keyword-to-library mapping in `SKILL.md` would bloat the always-loaded skill instructions. Putting the mapping in `library-mapping.md` keeps the skill description small and lets `SKILL.md` reference the file by path. Claude reads the mapping only when the skill fires.

**The skill references concrete file paths**, not abstractions. Instructions like "read the cache" without a path leave Claude guessing; instructions with the literal `~/.cache/pleaseai-spring/projects/<sha256(absolute project_dir)>.json` are deterministic. The cost is coupling to the cache schema; the benefit is that the skill behaves identically across model versions.

**Refuse to answer Spring questions in non-Spring projects.** Silently answering with training-data knowledge breaks the version-correctness contract. The skill must surface "this is not a Spring project" rather than degrade.

**Consent flow lives in skill instructions, not a separate command.** When the cache reports `needs_consent: true`, the skill walks Claude through prompting the user and recording the choice. A separate `/spring:consent` command is an extra UX surface for what is effectively an inline question.

## Tasks

- [ ] T001 Author `skills/spring-ask/SKILL.md` with frontmatter (`name`, `description`) and the core instructions: cache read, sync invocation on cache miss, delegation to `@pleaseai/ask` (file: `skills/spring-ask/SKILL.md`)
- [ ] T002 Build the keyword-to-library mapping table (file: `skills/spring-ask/library-mapping.md`) (depends on T001)
- [ ] T003 [P] Add the consent-flow instructions for Tier 2 (`requires-build-tool`) and Tier 3 (`--boot` override) cases per spec FR-6 (file: `skills/spring-ask/SKILL.md`) (depends on T001)
- [ ] T004 [P] Add the stale-cache (>24h) re-sync instruction per spec FR-8 (file: `skills/spring-ask/SKILL.md`) (depends on T001)
- [ ] T005 [P] Add the `kind: 'not-found'` graceful refusal instruction per spec FR-7 (file: `skills/spring-ask/SKILL.md`) (depends on T001)
- [ ] T006 Validate skill description against false-positive cases — Java without Spring, Kotlin coroutines, generic web frameworks, other JVM ecosystems. Refine description until matching is reliable. (file: `skills/spring-ask/SKILL.md`) (depends on T001, T002, T003, T004, T005)
- [ ] T007 [P] Token-budget check: measure the skill's loaded weight against NFR-2's <2,000 token target (manual; record measurement in PR description) (depends on T006)
- [ ] T008 Write an eval suite case under `evals/spring/cases/` that exercises the skill against a Boot 3.5.0 fixture and asserts version-correct delegation. Optional if eval suite is not yet wired; otherwise required. (file: `evals/spring/cases/spring-ask-version-pin.yaml` or equivalent) (depends on T006)
- [ ] T009 Update the plugin manifest (if needed) to declare the skill so Claude Code auto-loads it (file: `.claude-plugin/plugin.json`) (depends on T001)
- [ ] T010 [P] Document the skill behavior and consent flow for users in `.please/docs/knowledge/spring-ask-skill.md` or as a section in `README.md` (file: `.please/docs/knowledge/spring-ask-skill.md`) (depends on T006)

## Dependencies

```
T001 ──┬── T002 ──┐
       ├── T003 [P] ┐
       ├── T004 [P] ├── T006 ──┬── T007 [P]
       ├── T005 [P] ┘           ├── T008
       └── T009                  └── T010 [P]
```

T001 is the spine; everything layers on the base skill file. T002 (library mapping), T003 (consent flow), T004 (stale cache), T005 (not-found path) are independent additions to either `SKILL.md` or a referenced file. T006 (false-positive validation) gates T007/T008/T010.

## Key Files

- `skills/spring-ask/SKILL.md` — the always-loaded thin skill. Frontmatter + instructions; <2,000 tokens.
- `skills/spring-ask/library-mapping.md` — keyword-to-library identifier mapping; loaded only when the skill fires.
- `evals/spring/cases/spring-ask-version-pin.yaml` (or equivalent) — eval case validating version-correct delegation.
- `.claude-plugin/plugin.json` — references the skill if not picked up automatically.
- `.please/docs/knowledge/spring-ask-skill.md` (or `README.md` section) — user-facing docs on the skill, the consent flow, and how to override.

## Verification

### Automated Tests

- [ ] Eval suite case (T008) passes: a Spring Security question in a Boot 3.5.0 fixture returns Security 6.4.x documentation citations.
- [ ] Skill description does not match a curated false-positive set (T006): Java/Kotlin questions, Vue/React questions, generic JVM questions all leave the skill silent.

### Observable Outcomes

- Asking a Spring Framework question in a Spring project causes Claude to read `~/.cache/pleaseai-spring/projects/<hash>.json` and invoke `ask` with `--library spring-framework --version <framework-version-from-cache>`.
- Asking the same question with no cache file causes Claude to run `sync.ts` first, then proceed normally.
- Asking in a non-Spring project produces a "this is not a Spring project" response; no `ask` invocation occurs.

### Manual Testing

- [ ] In a fresh Spring Boot 3.5.0 project, ask a Security question; verify Claude cites Security 6.4.x docs (not 5.x).
- [ ] Delete the cache file and ask the same question; verify Claude re-runs sync before answering and the answer is still correct.
- [ ] Open a non-Spring project; ask a Spring question; verify the skill refuses to silently answer.
- [ ] In a project with `requires-build-tool` cache, ask a Spring question; verify the consent prompt appears, accept it, and verify the next question is version-pinned correctly.

### Acceptance Criteria Check

- [ ] AC-1 through AC-6 from spec.md are met.

## Decision Log

- **2026-04-29 — Aligns to ADR-0001/0002**: Single thin skill consuming the cache produced by `hook-sync-20260429`. Library mapping isolated to a referenced file to keep the always-loaded skill small.
- **Open**: Final form of the `@pleaseai/ask` invocation (Skill tool call vs. shell command). Resolved in T001 once the ask track's API contract is final.

## Surprises & Discoveries

(Implementation will record unexpected findings here — e.g., skill matcher behavior on borderline questions, ask invocation patterns that work better than the obvious one.)
