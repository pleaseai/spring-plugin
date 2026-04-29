---
product_spec_domain: install/sync
---

# Hook-Driven Version Sync

> Track: hook-sync-20260429
> Type: feature

## Overview

Implement `scripts/sync.ts` and the three Claude Code hooks (`SessionStart`, `FileChanged`, `CwdChanged`) that populate the per-project version cache consumed by the lazy spring-ask skill. This track realizes the dynamic-loading direction defined in ADR-0001 and supersedes the upfront `/spring:install` command as the default install path.

The hook layer translates "user opens or edits a Spring project" into "the version cache is current" without any user-initiated command. Detection is async and short (~50ms Bun static parse per ADR-0002 Tier 1), so the user never blocks on hook execution. When the cache content actually changes — Boot version upgrade, branch switch, project transition — the hook surfaces the change to Claude via `asyncRewake: true` so the next assistant turn carries the updated context.

## Requirements

### Functional Requirements

- [ ] **FR-1**: Implement `scripts/sync.ts` as the single orchestrator entry point invoked by all three hooks. CLI signature: `bun run scripts/sync.ts --project-dir <abs-path> [--quiet] [--allow-build-tool] [--pre-warm]`.
- [ ] **FR-2**: `sync.ts` invokes `scripts/detect.ts` (Tier 1 per ADR-0002), passes the resolved Boot version to `scripts/resolve.ts` to fetch the component-version map, and writes the combined result to `~/.cache/pleaseai-spring/projects/<sha256(absolute project_dir)>.json`.
- [ ] **FR-3**: Atomic cache write — write to a sibling temp file in the same directory, then `rename(2)` over the destination. Prevents torn reads from concurrent skill invocations sharing the same project.
- [ ] **FR-4**: Cache schema (tagged union mirroring `DetectResult` from `build-file-detect-20260428` FR-8):
  ```json
  // kind: "detected" — Boot version successfully resolved (Tier 1, 2, or 3)
  {
    "project_dir": "/abs/path",
    "kind": "detected",
    "boot": "3.5.0",
    "components": { "framework": "6.2.1", "security": "6.4.0", "...": "..." },
    "detected_at": "2026-04-29T12:34:56Z",
    "source": { "file": "build.gradle.kts", "locator": "plugins block", "line": 5 },
    "tier": 1,
    "needs_consent": false
  }

  // kind: "unsupported" — static parsing recognized but cannot resolve;
  //   FR-5 mandates `needs_consent: true` whenever reason contains
  //   `requires-build-tool` and the user has not granted Tier-2 consent.
  {
    "project_dir": "/abs/path",
    "kind": "unsupported",
    "reason": "requires-build-tool: buildSrc-based plugin definition",
    "suggestion": "Run with --boot <version> or grant build-tool consent",
    "detected_at": "2026-04-29T12:34:56Z",
    "source": { "file": "build.gradle.kts", "locator": "plugins block", "line": 5 },
    "tier": 1,
    "needs_consent": true
  }

  // kind: "not-found" — no recognized build file at the project root
  {
    "project_dir": "/abs/path",
    "kind": "not-found",
    "reason": "No supported build file at <path>",
    "suggestion": "Run from a Spring project root, or pass --boot <version>",
    "detected_at": "2026-04-29T12:34:56Z",
    "tier": 1,
    "needs_consent": false
  }
  ```
  All variants share `project_dir`, `kind`, `detected_at`, `tier`, `needs_consent`. Fields `tier` and `needs_consent` correspond to ADR-0002's three-tier escalation. AC-5 references the `unsupported` shape (with `needs_consent: true`) as a successful sync.
- [ ] **FR-5**: When detect returns `kind: 'unsupported'` with `reason` containing `requires-build-tool` (per build-file-detect FR-17) and `--allow-build-tool` was not passed, write `kind: 'unsupported'` + `needs_consent: true` to the cache. The skill flow handles the consent prompt; sync.ts itself never prompts because hooks are non-interactive.
- [ ] **FR-6**: Configure `SessionStart` hook (matchers `startup`, `resume`) in `.claude-plugin/hooks/hooks.json` to invoke sync.ts with `async: true`, `asyncRewake: true`, `timeout: 30`, command `bun run "$CLAUDE_PLUGIN_ROOT/scripts/sync.ts" --project-dir "$CLAUDE_PROJECT_DIR"`.
- [ ] **FR-7**: Configure `FileChanged` hook with literal-filename matcher `pom.xml|build.gradle|build.gradle.kts|settings.gradle|settings.gradle.kts|libs.versions.toml|gradle.properties` (the FileChanged event uses literal filenames, not regex) to invoke sync.ts with the same flags as FR-6.
- [ ] **FR-8**: Configure `CwdChanged` hook (no matcher; always fires) to invoke sync.ts so multi-project sessions resync on directory transition.
- [ ] **FR-9**: When detect returns `kind: 'detected'` and the new version differs from the cached version (or no cached version exists), sync.ts exits with code 2 — Claude Code's `asyncRewake` contract — and emits a one-line summary to stdout that Claude consumes as additional context (e.g., `Spring Boot 3.5.0 detected (was 3.4.7)` or `Spring Boot 3.5.0 detected (initial)`).
- [ ] **FR-10**: When detect returns `kind: 'detected'` with the same version already cached, sync.ts exits 0 silently — no Claude wake-up, no log line. This is the common case during a hot edit loop and must not pollute the conversation context.
- [ ] **FR-11**: `--quiet` suppresses the additional-context line on stdout but still writes the cache. Used for postinstall and `--pre-warm` scenarios where context injection is undesirable.
- [ ] **FR-12**: `--allow-build-tool` enables Tier-2 escalation per ADR-0002. Without this flag, `requires-build-tool` cases stay at `unsupported` + `needs_consent: true` for the skill to handle. CI sets this via env var (`PLEASEAI_SPRING_ALLOW_BUILD_TOOL=1`).
- [ ] **FR-13**: Concurrent sync invocations on the same project (e.g., `FileChanged` and `CwdChanged` firing back-to-back) coordinate via a flock-style guard at `~/.cache/pleaseai-spring/projects/<hash>.lock`. The second invocation either waits briefly or short-circuits if the first wrote a fresh cache.
- [ ] **FR-14**: `--pre-warm` mode runs the full pipeline (detect → resolve → optional component-doc cache hydration via `@pleaseai/ask` for the components named in `.spring-skill.json`) and exits without setting `asyncRewake`. Used by an opt-in `/spring:install --pre-warm` command and by CI.

### Non-functional Requirements

- [ ] **NFR-1**: Sync completes in <100ms (warm cache, no version change) when only Tier 1 runs. Aligns with the per-`FileChanged` hook frequency — multiple firings during a single edit must not cumulatively impact responsiveness.
- [ ] **NFR-2**: Hook configuration lives in `.claude-plugin/hooks/hooks.json`; the plugin manifest at `.claude-plugin/plugin.json` references the hooks directory per Claude Code conventions.
- [ ] **NFR-3**: `sync.ts` is in the Domain Layer (orchestrator with I/O). Pure helpers (cache serialization, hashing, flock guard) live in `scripts/lib/sync-*.ts` with the I/O-free invariant intact.

## Acceptance Criteria

- [ ] **AC-1**: SessionStart hook fires on a fresh session in a Spring project; sync writes the cache; cache contains the correct Boot version; subsequent skill invocation reads cache without re-running detect.
- [ ] **AC-2**: Editing `pom.xml` to change the Boot version triggers `FileChanged`; sync writes the new cache; the next assistant turn shows the new version in injected context.
- [ ] **AC-3**: `cd`-ing into a different Spring project triggers `CwdChanged`; sync writes that project's cache atomically without disturbing the previous project's cache file.
- [ ] **AC-4**: Concurrent sync invocations (simulated via two parallel bun runs) do not produce torn cache files; one writes, the other observes the existing cache without overwriting.
- [ ] **AC-5**: Sync exits 0 when no change, 2 when version differs (waking Claude), non-zero only on parse/IO error. `unsupported` is a successful sync (cache reflects unsupported state with `needs_consent: true`), exit 0.
- [ ] **AC-6**: `--quiet` mode produces no stdout output while still updating the cache.
- [ ] **AC-7**: `--pre-warm` mode hydrates `@pleaseai/ask`'s cache for the project's components and exits 0; subsequent skill invocations work fully offline.

## Out of Scope

- **Tier-2 build-tool fallback execution**. sync.ts orchestrates the escalation surface (`--allow-build-tool` flag, `needs_consent` cache flag) but the actual `mvn help:effective-pom` / `./gradlew` invocation is owned by a follow-up track per ADR-0002. The build-file-detect track's FR-17 only marks the escalation in the result; it does not execute build tools.
- **The thin skill** that consumes the cache — that is `spring-ask-skill-20260429`.
- **Cache eviction / TTL**. Per-invocation freshness check via timestamp comparison; long-term cleanup is a separate concern.
- **`overrides.json` schema and CRUD**. Owned by `build-file-detect-20260428` (FR-15). sync.ts only reads it.
- **Watching mode** (long-running daemon). Hooks are one-shot per event; no daemon process.

## Assumptions

- `scripts/detect.ts` (from `build-file-detect-20260428`) is implemented and respects FR-12~17 amendments. sync.ts is the first downstream consumer.
- `scripts/resolve.ts` accepts a Boot version and returns a component-version map; if not yet implemented when this track lands, sync.ts caches only the Boot version and leaves `components: {}` for resolve.ts to fill on first invocation.
- Claude Code hooks documentation is accurate (`async: true`, `asyncRewake: true` exit-code-2 semantics, FileChanged literal-matcher syntax, `CLAUDE_PROJECT_DIR` env var).
- `~/.cache/pleaseai-spring/` is writable; the same root is already used by the BOM cache (resolve.ts) and override store (FR-15).

## References

- ADR-0001 — `.please/docs/decisions/0001-lazy-skill-loading-via-hooks.md` (this track is the implementation)
- ADR-0002 — `.please/docs/decisions/0002-three-tier-version-detection.md` (sync.ts orchestrates Tier escalation)
- ADR-0003 — `.please/docs/decisions/0003-extended-static-parser-coverage.md` (cache shape includes `tier`, `needs_consent` fields per the three-tier model)
- Sibling track: `build-file-detect-20260428` (provides `detect.ts` consumed here)
- Sibling track: `spring-ask-skill-20260429` (consumes the cache produced here)
- Claude Code hooks documentation: <https://code.claude.com/docs/en/hooks.md>
