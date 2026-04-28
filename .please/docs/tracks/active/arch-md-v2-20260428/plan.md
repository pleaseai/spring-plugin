# Plan: ARCHITECTURE.md v2 Revision

> Track: arch-md-v2-20260428
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: arch-md-v2-20260428
- **Issue**: (assigned by /please:new-track)
- **Created**: 2026-04-28
- **Approach**: Section-by-section edits to a single file, executed in any order, closed by a consistency-pass commit. The new § Install Model (v2) section is written first so that subsequent edits to existing sections can link to it.

## Purpose

Make `ARCHITECTURE.md` accurately describe the v2 dynamic-loading install model so the same planning PR that introduces the v2 direction also documents it. After this track lands, a reader can open `ARCHITECTURE.md` cold and reach a complete and correct mental model of the install pipeline without consulting track specs or PR descriptions.

## Context

`ARCHITECTURE.md` (head: `ARCHITECTURE.md`) currently contains seven sections: § System Overview, § Dependency Layers, § Entry Points, § Module Reference, § Architecture Invariants, § Cross-Cutting Concerns, § Quality Notes. A targeted grep against the current file lists the following static-pipeline references that the v2 revision must remove or replace: prebuilt archive narrative (line 24), prebuilt archive builds (line 33), `scripts/fetch.ts` (lines 51, 82, 97, 122), `scripts/lib/antora-rules.ts` (lines 53, 83, 98, 119, 157), `prebuilt/` row in Module Reference (line 99), nightly archive workflow (line 100), Antora directive warning (line 152), Antora rules fixture path (lines 157–158), `prebuilt/catalog.json` (lines 160, 167).

This is a single-file edit. The edits to existing sections are mutually independent in semantics but share a file in version control, which means the implementer should serialize the edit commits to keep the diff readable per commit, even though the planning here treats them as logically parallel.

The track is **fully independent of sibling tracks** (`plugin-scaffold-20260428`, `build-file-detect-20260428`). Merge order does not matter — there is no overlap with files those tracks touch.

## Architecture Decision

**One section per task, one commit per section.** The alternative — a single mega-edit touching every section — would produce a diff where the reviewer cannot easily distinguish "intent" from "consequence." Section-scoped commits let the reviewer evaluate each section's revision against its specific spec scope item.

**Write the new section first.** § Install Model (v2) is the load-bearing addition. Existing sections need to link to it, so it has to exist before they are edited. This is the only ordering constraint in the task graph.

**Do not move existing sections.** Renaming or reordering a kept heading would silently break any URL fragment that anyone has shared (`#architecture-invariants`, etc.). Stick to in-place edits unless the spec explicitly calls for removal.

**Defer the optional ADR.** The spec lists "ADR creation" as out of scope for this track. The ADR — when it lands in its own track — can reference the post-revision document by stable anchors.

**No mermaid / plantuml.** ASCII diagrams in the existing document remain ASCII. Switching diagram tools mid-document would create stylistic inconsistency that one reviewer would inevitably flag, costing a round-trip with no informational gain.

## Tasks

- [ ] T001 Add new § Install Model (v2) section explaining install-time vs. runtime split, data flow through `@pleaseai/ask`, and the contract spring uses (file: `ARCHITECTURE.md`)
- [ ] T002 Rewrite § System Overview to remove "prefer a prebuilt archive … fall back to live HTML→Markdown conversion" narrative; replace with the v2 install-then-runtime-fetch model and a back-link to § Install Model (v2) (file: `ARCHITECTURE.md`) (depends on T001)
- [ ] T003 Rewrite § Entry Points: remove pointers at `scripts/fetch.ts` and `scripts/lib/antora-rules.ts`; replace with two entry points (install thin-skill writer; runtime `ask`-bridge invocation) (file: `ARCHITECTURE.md`) (depends on T001)
- [ ] T004 Rewrite § Module Reference: remove rows for `prebuilt/` and `antora-rules.ts`; update `scripts/` row to drop `fetch.ts`; update `scripts/lib/` row to drop `antora-rules.ts`; update `.github/workflows/` row to drop nightly-build; add a row for the runtime ask-bridge module (file: `ARCHITECTURE.md`) (depends on T001)
- [ ] T005 Rewrite § Architecture Invariants: remove invariants about the Library layer being I/O-free (already covered by `tech-stack.md`; no need to duplicate against now-removed Antora context), about all `fetch()` going through `scripts/fetch.ts`, and about prebuilt archive builds; add v2 invariants — install output is metadata-only, the `ask` call is the single network boundary at runtime, the resolved Boot version pins the GitHub ref `ask` is told to fetch (file: `ARCHITECTURE.md`) (depends on T001)
- [ ] T006 Touch up § Cross-Cutting Concerns: remove "warnings for unknown Antora directives" / "missing prebuilt archives" lines; replace with the runtime equivalents — `ask` invocation failure modes, ref-not-found, ref-resolved-but-content-empty (file: `ARCHITECTURE.md`)
- [ ] T007 Touch up § Quality Notes: remove `scripts/lib/antora-rules.test.ts`, `tests/fixtures/antora/` references, `prebuilt/catalog.json` references; replace eval-suite gating to mention skill-manifest writer + ask-bridge module instead of `scripts/lib/` + `prebuilt/catalog.json`; remove `skip-prebuilt` from the optional project-level config example (file: `ARCHITECTURE.md`)
- [ ] T008 Final consistency pass: re-read the document end-to-end, fix any remaining static-pipeline residue, verify every internal link/anchor resolves, run `bun run lint:md` if available (file: `ARCHITECTURE.md`) (depends on T001, T002, T003, T004, T005, T006, T007)
- [ ] T009 PR description: write the rationale paragraph required by SC-6 explaining *why* the pivot was made (cost / maintenance tradeoff for live conversion vs. prebuilds vs. delegation to `ask`); not an in-document change (manual; depends on T008)

## Dependencies

```
T001 ──┬── T002
       ├── T003
       ├── T004
       └── T005

T006 (independent of T001 — surgical removal of warning lines)
T007 (independent of T001 — surgical removal of fixture references)

T002, T003, T004, T005, T006, T007 ──── T008 ──── T009
```

T001 must come first because T002–T005 link to or reference the new § Install Model (v2) heading. T006 and T007 are surgical removals of specific phrases and don't depend on T001 conceptually; they can be done at any point. T008 (consistency pass) gates everything; T009 (PR description) closes the track.

## Key Files

- `ARCHITECTURE.md` — the only file modified by this track. Every task targets it.
- `plugin-scaffold-20260428/spec.md` (sibling) — read for reference but not modified; its "ARCHITECTURE.md will be revised in a separate track" statement is the originating commitment this track satisfies.
- `build-file-detect-20260428/spec.md` (sibling) — read for reference but not modified; confirms the `DetectResult` contract is invariant across pipelines so § Module Reference can describe `scripts/detect.ts` confidently.

## Verification

Mapping to spec acceptance criteria:

- **SC-1** (cold-read mental model): T001 + T002 jointly responsible — § Install Model (v2) provides the explanation, § System Overview names it as the install model so a reader hits it on the first page.
- **SC-2** (internal consistency): T008 — the consistency pass is the only point where the document is read end-to-end, so it owns this SC.
- **SC-3** (no broken links / anchors): T008 — same pass also runs `bun run lint:md` if wired by then; otherwise manual link check.
- **SC-4** (no static-pipeline strings remain in the body): T002–T007 collectively remove every match; T008 verifies by re-grepping.
- **SC-5** (new § Install Model (v2) section exists): T001.
- **SC-6** (PR rationale paragraph): T009.

Each task is "done" when the corresponding section reads cleanly and matches the spec. No automated tests exist for this track — all verification is reviewer + grep.

## Progress

(Implementation will fill this section.)

## Decision Log

(Implementation may add ADR references here. The athens-v2 pivot ADR itself is a separate track and can land any time; this track's revision is the input it will reference.)

## Surprises & Discoveries

(Implementation will record unexpected findings here — e.g., a section that turned out to be more entangled with the static pipeline than the initial grep suggested.)
