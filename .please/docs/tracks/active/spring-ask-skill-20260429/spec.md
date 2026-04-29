---
product_spec_domain: install/skill
---

# Spring Ask Skill (Thin Delegating Skill)

> Track: spring-ask-skill-20260429
> Type: feature

## Overview

Implement `skills/spring-ask/SKILL.md` — a single thin Claude Code skill that resolves Spring ecosystem questions by reading the per-project version cache (produced by `hook-sync-20260429`) and delegating to `@pleaseai/ask` with version pinning. This skill replaces the upfront-install model: instead of writing per-component skill files at install time, the plugin ships one always-loaded skill that defers all documentation retrieval to the lazy `@pleaseai/ask` path defined in ADR-0001.

The skill is the user-facing "consumer" arm of the lazy-loading architecture. Its sole responsibilities are: (a) detect that a question is Spring-related, (b) resolve which Spring library (Framework, Boot, Security, Data, Cloud, Batch, Integration, etc.) the question concerns, (c) read the cached version for that library, and (d) invoke `@pleaseai/ask` to fetch and surface the version-correct documentation chunk. The skill itself contains no Spring documentation and does no fetching directly.

## Requirements

### Functional Requirements

- [ ] **FR-1**: Ship a single skill at `skills/spring-ask/SKILL.md` with frontmatter `name: spring-ask` and a `description` that triggers the skill on Spring Framework, Boot, Security, Data (JPA), Cloud, Batch, Integration, WebFlux, Reactor, and AOP related questions. The description must be specific enough to avoid false positives on non-Spring topics.
- [ ] **FR-2**: The skill instructions direct Claude to read the version cache at `~/.cache/pleaseai-spring/projects/<sha256(absolute project_dir)>.json` (per hook-sync FR-2, FR-4) before answering. The skill names the exact path computation so Claude can produce the correct hash itself.
- [ ] **FR-3**: When the cache file is absent, the skill instructs Claude to invoke `bun run "$CLAUDE_PLUGIN_ROOT/scripts/sync.ts" --project-dir "$CLAUDE_PROJECT_DIR"` synchronously before proceeding. This handles the cold-start case before SessionStart hook has fired or after the cache has been deleted.
- [ ] **FR-4**: Library mapping: the skill includes an explicit mapping table from question keywords to Spring library identifiers used by `@pleaseai/ask`. Examples: `@Component`, `ApplicationContext`, `@Configuration` → `spring-framework`; `@PreAuthorize`, `SecurityFilterChain`, OAuth2 → `spring-security`; `JpaRepository`, `@Entity` → `spring-data-jpa`; `@SpringBootApplication`, `application.properties` → `spring-boot`; etc. Unmapped Spring keywords default to `spring-framework`.
- [ ] **FR-5**: Delegate by invoking `ask` (or the equivalent Skill tool call to `ask:ask`) with parameters that include the resolved library identifier and the corresponding version from the cache's `components` field. The skill instructions must be explicit enough that Claude reliably constructs the correct delegation call.
- [ ] **FR-6**: When the cache reports `kind: 'unsupported'` and `needs_consent: true` (per hook-sync FR-5), the skill prompts the user once with a clear message explaining that static parsing failed and offers two paths: (a) consent to running the project's build tool (`mvn`/`./gradlew`) per ADR-0002 Tier 2, or (b) provide an explicit `--boot <version>` override. After consent, the skill records it via `bun run "$CLAUDE_PLUGIN_ROOT/scripts/sync.ts" --project-dir "$CLAUDE_PROJECT_DIR" --allow-build-tool` (Tier 2) or via the build-file-detect FR-15 override store (Tier 3).
- [ ] **FR-7**: When the cache reports `kind: 'not-found'` (no build file at the project root), the skill informs the user that the current directory is not a Spring project and falls back to general (non-version-pinned) Spring guidance — i.e., refuses to silently answer with potentially-wrong-version content.
- [ ] **FR-8**: When the cached `detected_at` timestamp is older than 24 hours, the skill instructs Claude to re-run sync.ts (synchronously, with `--quiet`) before delegating. This catches edge cases where hooks did not fire (e.g., the user edited a build file outside Claude Code's session).
- [ ] **FR-9**: The skill never invokes network calls directly. All network access is delegated to `@pleaseai/ask`, preserving the single-network-boundary invariant established by ADR-0001 and ARCHITECTURE.md.
- [ ] **FR-10**: The skill never writes to user `CLAUDE.md`, `.claude/skills/spring-*/`, or any other user-owned file. All state lives under `~/.cache/pleaseai-spring/`. This honors the "CLAUDE.md is sacred" invariant by sidestepping it entirely.

### Non-functional Requirements

- [ ] **NFR-1**: Skill description matching avoids false positives on adjacent topics (Java without Spring, Kotlin coroutines, generic web frameworks). The description is reviewed against a curated set of disambiguation cases.
- [ ] **NFR-2**: Skill instructions are concise enough to fit comfortably in any session's context budget — target <2,000 tokens for `SKILL.md`. Long-form mappings live in a referenced file (`skills/spring-ask/library-mapping.md`) loaded only when the skill fires.
- [ ] **NFR-3**: Skill behavior is deterministic for the same cache content. Two invocations with the same question and the same cache produce the same delegation call.

## Acceptance Criteria

- [ ] **AC-1**: Asking "How do I configure Spring Security with OAuth2?" in a Spring Boot 3.5.0 project triggers the skill, reads the cache, and delegates to `ask` for `spring-security` at the version mapped to Boot 3.5.0.
- [ ] **AC-2**: Asking the same question in a project without a build file produces a clear "not a Spring project" response — no version-pinned answer, no silent fallback to training-data knowledge.
- [ ] **AC-3**: Asking a Spring question when the cache is in `needs_consent: true` state surfaces the consent prompt exactly once per project; subsequent questions in the same session use the recorded consent.
- [ ] **AC-4**: Asking a non-Spring question (e.g., "How do I write a Vue 3 composable?") in a Spring project does not trigger the skill — the description matcher must be precise.
- [ ] **AC-5**: After running `/spring:install --pre-warm` (the opt-in pre-warmer per ADR-0001), the skill answers without further network access — the `@pleaseai/ask` cache is hot.
- [ ] **AC-6**: Skill description and library mapping fit within NFR-2's token budget when measured against a representative session.

## Out of Scope

- **The cache producer side** — `sync.ts` and the three hooks are owned by `hook-sync-20260429`.
- **`@pleaseai/ask` itself** — its API surface, version of its prompt cache, and rate limits are external to this track.
- **Documentation conversion** — the skill never converts HTML to Markdown. `ask` handles all retrieval and formatting.
- **Per-component skill files** under `.claude/skills/spring-*/`. The lazy model has exactly one skill (`spring-ask`); per-component skills do not exist.
- **A custom `/spring:ask` slash command**. The skill is implicit via Claude's auto-invocation; an explicit slash command is a separate UX track if ever needed.

## Assumptions

- `@pleaseai/ask` accepts a library-identifier + version + query and returns relevant documentation chunks. The exact API surface is contracted with ask's own track; this skill writes against a stable interface.
- `hook-sync-20260429` is implemented and the cache schema (FR-4 of that track) is the contract for this track's reads.
- The version cache is sufficient context for `ask` — i.e., `ask` does not require the original `pom.xml` / `build.gradle` content, only the resolved versions.
- Claude Code's skill auto-invocation reliably matches a well-written `description`. If matching turns out to be unreliable, this track is closed and an explicit slash command track is opened.

## References

- ADR-0001 — `.please/docs/decisions/0001-lazy-skill-loading-via-hooks.md` (defines the thin-skill + ask-delegation model implemented here)
- ADR-0002 — `.please/docs/decisions/0002-three-tier-version-detection.md` (FR-6 consent flow corresponds to Tier 2 escalation)
- Sibling track: `hook-sync-20260429` (produces the cache consumed here)
- Sibling track: `build-file-detect-20260428` (FR-15 override store consulted in FR-6 fallback path)
- `@pleaseai/ask` skill (the delegation target; treated as a contract, not documented internally)
