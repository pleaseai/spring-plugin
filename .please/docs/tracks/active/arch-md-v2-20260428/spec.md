# ARCHITECTURE.md v2 Revision

> Track: arch-md-v2-20260428
> Type: chore (docs)

## Overview

Rewrite the load-bearing sections of `ARCHITECTURE.md` to reflect the athens-v2 architectural pivot: replace the **static-install pipeline** (detect → resolve → fetch → convert → write Markdown to `.claude/skills/spring-*/`) with a **dynamic-loading skill** that delegates to `@pleaseai/ask` at runtime to fetch Spring reference content from GitHub on demand.

This is a **docs-only** track. No source files are added, modified, or removed. The track exists so that the v2 direction is documented in the same planning PR that introduces it (sibling tracks: `plugin-scaffold-20260428`, `build-file-detect-20260428`), preventing a window where the implementation lags the architecture document or vice versa.

`ARCHITECTURE.md` is currently the team's single bird's-eye view of the system. After this revision, a reader should be able to open `ARCHITECTURE.md` and reach a complete and correct understanding of the v2 install model without cross-referencing track specs or PR descriptions.

## Scope

### Sections to rewrite

- **§ System Overview** — replace the static-pipeline narrative with the dynamic-loading model. Explain that install produces a thin per-component skill that, at the moment Claude Code invokes it, calls `@pleaseai/ask` to fetch the relevant Spring reference content from upstream GitHub at the resolved version ref.
- **§ Entry Points** — remove "the install pipeline" framing as a sequence ending in conversion; replace with two distinct entry points: (1) `/spring:install` writes thin skills, (2) skill invocation at runtime delegates to `@pleaseai/ask`. Each entry point's "first file to read" pointer needs updating.
- **§ Module Reference** — remove rows for `prebuilt/` and any Antora-conversion library scaffolding that was justified solely by the static pipeline. Add a row for the runtime `@pleaseai/ask` boundary (likely a thin wrapper module under `scripts/lib/ask-bridge.ts` or similar — exact file naming is the implementing track's call). Update existing rows to reflect that `scripts/fetch.ts` no longer exists; the corresponding domain function in v2 is a skill-manifest writer, not a doc fetcher/converter.
- **§ Architecture Invariants** — remove invariants that pertained only to the static pipeline (Antora conversion, prebuilt archive sha256, nightly-build idempotency, etc.). Add invariants that protect the v2 model: (a) install-time output is metadata only (no Markdown bodies); (b) the `@pleaseai/ask` call is the single network boundary at runtime; (c) the resolved Boot version pins the GitHub ref used by `ask` (no drift between detected version and fetched content).

### Sections to add

- **§ Install Model (v2)** — new section explaining the install-time vs. runtime split, the data flow from detection through `@pleaseai/ask`, and the contract between the spring plugin and `@pleaseai/ask` (what shape the spring plugin's skill manifest takes, what `ask` is asked to do). Per ADR-0001, this section must additionally cover the **hook-driven sync** model: `SessionStart`, `FileChanged`, and `CwdChanged` hooks invoke `scripts/sync.ts` to populate a per-project version cache (`~/.cache/pleaseai-spring/projects/<hash>.json`) consumed by the thin `spring-ask` skill at query time. The traditional `/spring:install` command is documented as an opt-in pre-warmer for offline / CI scenarios, not the default install path.
- **§ Three-Tier Detection (Optional)** — short subsection (or paragraph in § Install Model (v2)) referencing ADR-0002's three-tier detection strategy: Bun static parsing (Tier 1) → opt-in build-tool fallback (Tier 2) → `--boot` user override (Tier 3). The body of the strategy lives in the ADR; ARCHITECTURE.md just summarizes the model and points to the ADR.

### Sections to leave untouched

- **§ Cross-Cutting Concerns** — most content (error handling, logging, security boundaries) carries over; only the "doc conversion" subsection (if present) is replaced with the runtime-fetch equivalent.
- **§ Quality Notes** — review for stale references but do not rewrite as a whole.
- Headings outside the listed sections must be preserved verbatim so cross-PR references still resolve.

### Coordination with sibling tracks

- `plugin-scaffold-20260428` spec already promised that ARCHITECTURE.md would be revised in a separate track and that scaffold should not touch it. This track delivers on that promise. **The order in which the three tracks merge does not matter** for correctness, since this track is docs-only and the scaffold track touches no overlapping files.
- `build-file-detect-20260428` spec is architecture-agnostic (the `DetectResult` contract is the same in both pipelines), so this revision does not change anything that detect-track depends on.

## Success Criteria

- [ ] **SC-1**: A reader who opens `ARCHITECTURE.md` cold can describe the v2 install model in one paragraph without referring to any other file.
- [ ] **SC-2**: Internal consistency: every section in the revised `ARCHITECTURE.md` agrees with every other section. There are no places where one section describes the static pipeline and another describes the dynamic one. (Reviewer-verified; no automation.)
- [ ] **SC-3**: No broken links or anchors inside `ARCHITECTURE.md`. Every `[text](#section)` resolves to an existing heading; every relative link to a sibling file (`README.md`, `.please/docs/knowledge/*.md`) points at a file that still exists. (Verified by `bun run lint:md` if a markdown linter is wired by the time this lands; otherwise manual.)
- [ ] **SC-4**: References to `prebuilt/`, `antora-rules.ts`, "HTML → Markdown conversion", "nightly archive build", and `scripts/fetch.ts` (in the static-pipeline meaning) are removed from the document. Searching the post-revision file for any of these strings returns zero matches in the body — they may appear only inside an explicit "removed in v2" sidebar or migration note, if such a note is included.
- [ ] **SC-5**: New § Install Model (v2) section exists and explains: (a) the thin `spring-ask` skill that delegates to `@pleaseai/ask` at query time; (b) the hook-driven sync model (`SessionStart`, `FileChanged`, `CwdChanged` → `scripts/sync.ts` → per-project cache) per ADR-0001; (c) the three-tier detection strategy per ADR-0002; (d) the relationship between `/spring:install --pre-warm` (opt-in) and the default zero-install path.
- [ ] **SC-6**: PR description includes a short rationale paragraph explaining *why* the pivot was made (cost / maintenance tradeoff: live conversion is expensive; pre-builds drift; delegating to `ask` lets the plugin focus on detection/resolution and reuse a generic doc-fetching primitive). This is for reviewer context, not for inclusion in `ARCHITECTURE.md` itself.

## Constraints

- **Docs-only**: zero changes outside `ARCHITECTURE.md` and (optionally) cross-references in `README.md` if they describe install behavior in incompatible terms. Code, configs, manifests, and tests are untouched.
- **Preserve existing heading anchors** unless a heading is being explicitly removed. Renaming a kept heading would break external references with no commensurate gain.
- **Do not document `@pleaseai/ask` internals**: describe only the contract spring uses (what we send, what we expect back). The shape of `ask`'s implementation belongs in `@pleaseai/ask`'s own docs.
- **Do not pre-empt sibling track scope decisions**: the new § Install Model (v2) section describes the model but does not pick file names for the skill-manifest writer or the `ask`-bridge module — those are the implementing tracks' design choices. Use placeholder phrasing ("the install module", "the ask bridge") where the eventual file path is undecided.
- **Markdown style consistent with the rest of `ARCHITECTURE.md`**: same heading depth conventions, same ASCII-diagram style, same use of bold for invariant statements.

## Out of Scope

- Code changes of any kind. If a revision exposes that a code file's name no longer makes sense (e.g., `scripts/fetch.ts`), the rename is a separate track — this one only stops referring to the old name.
- `README.md` rewrite. A small update to a single `README.md` paragraph is allowed if it directly contradicts the new `ARCHITECTURE.md` content; anything larger is a separate track.
- Documentation of the `@pleaseai/ask` plugin itself.
- Migration guide for users (the plugin has not shipped yet; no users to migrate).
- ADR creation: superseded by 2026-04-29. ADRs 0001-0003 (lazy skill loading, three-tier version detection, extended static parser coverage) are landed under `.please/docs/decisions/` and this track now references them as authoritative input. No new ADRs are created by this track; the ARCHITECTURE.md revision summarizes the ADR decisions but does not duplicate their reasoning.
- Diagram tooling changes (mermaid, plantuml, etc.). Stick with ASCII so the document stays inspectable in any viewer.

## Assumptions

- The dynamic-loading direction is decided. This track does not reopen the static-vs-dynamic debate — it documents the chosen direction so subsequent feature tracks have a consistent baseline. If the team decides to revert the pivot, this track is closed unmerged and `ARCHITECTURE.md` stays as-is.
- `@pleaseai/ask` provides a stable enough surface (e.g., `ask src <package>@<ref>` or equivalent) to be referenced as a contract. If `ask`'s API is in flux, the new § Install Model (v2) section uses verbs ("fetches", "delegates") rather than literal command names.

## References

- `plugin-scaffold-20260428/spec.md` § Architectural direction (athens v2) — the original statement of the pivot
- `build-file-detect-20260428/spec.md` § Overview — confirms the detect contract is invariant across pipelines
- `hook-sync-20260429/spec.md` — sibling track implementing the hook-driven sync model that ARCHITECTURE.md must document.
- `spring-ask-skill-20260429/spec.md` — sibling track implementing the thin delegating skill that ARCHITECTURE.md must document.
- ADR-0001 (`.please/docs/decisions/0001-lazy-skill-loading-via-hooks.md`) — the authoritative source for the lazy install model summarized in § Install Model (v2).
- ADR-0002 (`.please/docs/decisions/0002-three-tier-version-detection.md`) — the authoritative source for the three-tier detection strategy summarized in § Install Model (v2).
- ADR-0003 (`.please/docs/decisions/0003-extended-static-parser-coverage.md`) — extended static parser coverage; ARCHITECTURE.md may reference but does not duplicate.
- Claude Code hooks documentation (<https://code.claude.com/docs/en/hooks.md>) — referenced when describing hook events used by the v2 model.
- Existing `ARCHITECTURE.md` (entire file is the input artifact for this track)
- `@pleaseai/ask` plugin (referenced contract; do not document its internals)
