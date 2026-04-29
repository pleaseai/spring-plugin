# Plan: Hook-Driven Version Sync

> Track: hook-sync-20260429
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: ADR-0001 (lazy-skill-loading-via-hooks); spec.md
- **Issue**: #9
- **Created**: 2026-04-29
- **Approach**: Two-layer separation — `scripts/sync.ts` is the I/O-bearing orchestrator; cache serialization, hashing, and concurrency primitives live as pure helpers in `scripts/lib/sync-*.ts`. All three Claude Code hooks delegate to the same sync.ts script; per-hook differences are encoded in command-line flags rather than separate scripts.

## Purpose

After this track ships, a Claude Code user in a Spring project gets version-correct documentation lookups without ever running `/spring:install`. Editing `pom.xml` or `build.gradle` automatically refreshes the cache; opening a session in a new project picks up its version on the first turn. The user verifies it works by editing the Boot version in their build file — the next assistant turn surfaces the change.

## Context

ADR-0001 defines the model: detection result is cached per project at `~/.cache/pleaseai-spring/projects/<hash>.json`; the thin spring-ask skill (separate track) reads the cache and delegates to `@pleaseai/ask` with the version pinned. This track owns the cache *producer* side. The skill track owns the *consumer* side.

The detect.ts function from `build-file-detect-20260428` is the data source. resolve.ts produces the component-version map. sync.ts composes them into the cache file and signals Claude when the content has changed.

Hook frequency makes detect.ts performance load-bearing — `FileChanged` may fire dozens of times during an edit-heavy session. The Tier-1 ~50ms target from ADR-0002 is what makes this architecture viable; if Tier-1 ever drifts past 100ms, the hook frequency becomes a UX problem.

`asyncRewake: true` (per the Claude Code hooks docs) lets a background hook signal the assistant on exit code 2. We use this exclusively to surface version *changes*, never to surface "I ran." Exit 0 = silent.

## Architecture Decision

**One sync.ts entry point, three hooks.** Hook handlers in Claude Code are arbitrary commands; using a single script keeps the orchestration logic centralized and testable. Per-hook variation (matchers, command args) lives in `hooks.json`, not in the script.

**The cache file is the contract.** The skill (separate track) only knows the JSON schema, not how it gets populated. This makes the producer/consumer relationship inspectable by reading one file on disk and replaceable without coordinated changes — a future "manual override" mechanism could write the same cache shape directly.

**Atomic writes via temp + rename.** Writing the cache directly would risk torn reads from a concurrent skill invocation. `rename(2)` is atomic on local filesystems and works across all platforms Claude Code supports.

**`asyncRewake: true` over polling.** Hooks fire async; `asyncRewake` lets sync.ts surface a context-injection event when (and only when) the version actually changed. The skill never has to "ask if the cache is fresh" — the hook proactively wakes Claude when it is not.

**Library Layer stays I/O-free.** Cache serialization is pure (in: object, out: string); hashing is pure; flock helpers take a callback rather than embedding I/O in the lib module.

## Tasks

- [ ] T001 Implement cache serialization helpers (file: `scripts/lib/sync-cache.ts`, `scripts/lib/__tests__/sync-cache.test.ts`)
- [ ] T002 Implement project-dir hash + cache path resolution (file: `scripts/lib/sync-paths.ts`, `scripts/lib/__tests__/sync-paths.test.ts`)
- [ ] T003 Implement sync.ts orchestrator (detect → resolve → write cache → exit code) (file: `scripts/sync.ts`, `scripts/__tests__/sync.test.ts`) (depends on T001, T002)
- [ ] T004 [P] Implement flock-style concurrent-write guard (file: `scripts/lib/sync-lock.ts`, `scripts/lib/__tests__/sync-lock.test.ts`) (depends on T002)
- [ ] T005 [P] Add `--quiet`, `--allow-build-tool`, `--pre-warm` flag handling (file: `scripts/sync.ts`) (depends on T003)
- [ ] T006 Configure hooks in `.claude-plugin/hooks/hooks.json` for SessionStart, FileChanged, CwdChanged (file: `.claude-plugin/hooks/hooks.json`) (depends on T003)
- [ ] T007 Update plugin manifest to reference hooks directory (file: `.claude-plugin/plugin.json`) (depends on T006)
- [ ] T008 End-to-end fixture test simulating SessionStart, FileChanged, and CwdChanged invocation paths against a fixture project (file: `scripts/__tests__/sync-e2e.test.ts`) (depends on T003, T004, T005)
- [ ] T009 [P] Document the cache schema and hook config in `.please/docs/knowledge/sync.md` (file: `.please/docs/knowledge/sync.md`) (depends on T003)

## Dependencies

```
T001 ──┐
T002 ──┴─ T003 ──┬── T005 [P] ──┐
                ├── T006 ──── T007
                └── T009 [P]
T002 ──── T004 [P] ─────────────┐
                                 ├── T008
T003 ───────────────────────────┘
```

T001 and T002 are independent and unblock T003. T004 (lock) shares only T002 with the orchestrator and runs in parallel. T005 (flag handling) layers on T003. T006 (hooks.json) and T007 (manifest reference) are sequential. T008 is the integration gate; T009 (docs) parallels.

## Key Files

- `scripts/sync.ts` — orchestrator (Domain Layer): reads detect+resolve outputs, manages flock + asyncRewake exit codes, owns all I/O.
- `scripts/lib/sync-cache.ts` — pure JSON serialization of the cache schema.
- `scripts/lib/sync-paths.ts` — pure project-dir hashing and path derivation.
- `scripts/lib/sync-lock.ts` — flock primitive returning a guard that takes a callback.
- `.claude-plugin/hooks/hooks.json` — three hook definitions per FR-6, FR-7, FR-8.
- `.claude-plugin/plugin.json` — references the `hooks/` directory per Claude Code convention.
- `.please/docs/knowledge/sync.md` — operator-facing reference: cache schema, hook flow, troubleshooting.
- `~/.cache/pleaseai-spring/projects/` — runtime cache directory; sync.ts creates on demand.

## Verification

### Automated Tests

- [ ] sync-cache helper round-trips a representative cache JSON without mutation.
- [ ] sync-paths produces deterministic, collision-resistant hashes for project paths.
- [ ] sync-lock prevents concurrent writers (verified with two parallel bun-run processes).
- [ ] sync.ts writes cache, exits 0 on no-change, exits 2 on version-change.
- [ ] sync.ts respects `--quiet` (no stdout) and `--allow-build-tool` (Tier-2 path enabled, validated against build-file-detect FR-17).
- [ ] End-to-end harness simulates each hook invocation path with fixture builds and asserts the resulting cache state.
- [ ] Atomic cache write — verify temp+rename behavior produces no partial cache file when sync.ts is killed mid-write (FR-3). Test by truncating the temp file and asserting the destination either has the prior content or no file at all.

### Observable Outcomes

- Running `bun run scripts/sync.ts --project-dir /tmp/spring-fixture` writes `~/.cache/pleaseai-spring/projects/<hash>.json` with the fixture's Boot version.
- Editing the fixture's `build.gradle` and re-running sync.ts updates the cache; stdout shows `Spring Boot <new> detected (was <old>)`.
- Pre-existing cache + matching version → sync.ts exits silently with code 0; stdout is empty.
- `--pre-warm` exits 0 and populates `@pleaseai/ask`'s cache for the components named in `.spring-skill.json` (or the default component set).

### Manual Testing

- [ ] Install the plugin in a real Spring Boot project; verify SessionStart populates the cache without any user command.
- [ ] Edit `pom.xml` Boot version; verify FileChanged hook updates the cache and the next assistant turn injects the change as context.
- [ ] Switch to a different Spring project (`cd`); verify CwdChanged populates that project's cache file separately.
- [ ] Run with no JDK installed and `--allow-build-tool` set; verify the script does not invoke build tools and surfaces a clean Tier-1 result (or `needs_consent` if the project requires Tier 2).

### Acceptance Criteria Check

- [ ] AC-1 through AC-7 from spec.md are met.

## Decision Log

- **2026-04-29 — Aligns to ADR-0001/0002/0003**: This track is the implementation arm of the lazy-loading model. Cache schema, hook event matchers, and asyncRewake usage are all derived directly from the ADRs.
- **Open**: Whether `--pre-warm` should accept a `--components` filter or always pre-warm the default component set. Resolved during T005.

## Surprises & Discoveries

(Implementation will record unexpected findings here — e.g., flock semantics on macOS vs. Linux, FileChanged debounce behavior in Claude Code.)
