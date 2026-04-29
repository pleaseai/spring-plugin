# ADR-0001: Lazy Skill Loading via Hooks

## Status

Proposed

## Context

The original `ARCHITECTURE.md` describes an upfront-install model: the user
runs `/spring:install`, which detects the Boot version, resolves the full
Spring component matrix via the BOM, downloads or generates per-component
Markdown documentation, and writes static skill directories under
`.claude/skills/spring-*/`. Subsequent Claude Code sessions auto-load these
skills.

This model has accumulated friction:

- **Install step is a UX wall**: new users must remember to run
  `/spring:install` before Claude can answer Spring questions correctly.
- **Disk footprint**: a full install writes 50–100MB of generated Markdown
  per project.
- **Stale skill problem**: when the user upgrades Spring Boot or switches
  branches, the on-disk skills go out of sync. Manual or CI-triggered
  re-runs are required, with a window where wrong-version answers leak.
- **CLAUDE.md mutation**: the install writes a
  `<!-- spring-skill:start -->` block into the user's `CLAUDE.md`. This
  block is sacred (`ARCHITECTURE.md` invariant), but every mutation is a
  potential trust failure.
- **`@pleaseai/ask` exists**: the `ask` skill already provides
  version-pinned access to library documentation. Re-implementing
  doc-fetching in this plugin duplicates work and diverges from a
  shared infrastructure component.

The `build-file-detect-20260428` spec hints at a way out:

> *"detect.ts contracts are identical whether the eventual install writes
> static Markdown or **a thin skill that delegates to `@pleaseai/ask` at
> runtime**."*

ADR-0002 makes detection cheap enough (~50ms via Bun static parsing) that
running it on every Claude Code session start and every build-file change is
trivial. This unlocks a fundamentally different installation model.

## Decision

Replace the upfront-install architecture with **lazy skill loading driven
by Claude Code hooks**.

**Composition:**

1. **One thin always-loaded skill**: `skills/spring-ask/SKILL.md`. It does
   not contain Spring documentation. Its instructions tell Claude to:
   - Read a per-project version cache file.
   - Map the user's question to the relevant Spring library.
   - Delegate to `@pleaseai/ask` with the version pinned from the cache.

2. **Three async hooks** populate the version cache:
   - `SessionStart` (matchers `startup`, `resume`)
   - `FileChanged` (matcher
     `pom.xml|build.gradle|build.gradle.kts|settings.gradle|settings.gradle.kts|libs.versions.toml|gradle.properties`)
   - `CwdChanged` (no matcher)

   Each hook runs `bun run "$CLAUDE_PLUGIN_ROOT/scripts/sync.ts" --project-dir
   "$CLAUDE_PROJECT_DIR"` with `async: true` and `asyncRewake: true`. A
   30-second timeout caps Tier-2 fallback (ADR-0002) cost.

3. **Per-project version cache**:
   `~/.cache/pleaseai-spring/projects/<sha256(project_dir)>.json` records
   the detected Boot version, resolved component versions, source provenance
   (file/locator/line), and detection timestamp. Atomic write
   (temp + rename) for concurrent-session safety.

4. **`/spring:install` becomes optional** with a new `--pre-warm` flag for
   CI and air-gapped flows. It populates the local cache (and
   `@pleaseai/ask`'s cache) ahead of time; without it, the lazy path still
   works on first query.

**What goes away:**

- Per-component skill directories under `.claude/skills/spring-*/`.
- `<!-- spring-skill:start -->` block in user `CLAUDE.md` (sacred-marker
  maintenance burden eliminated).
- `scripts/install.ts` as the primary entry point (retained as opt-in
  pre-warmer).
- Most of `scripts/fetch.ts` and `prebuilt/catalog.json` — `@pleaseai/ask`
  owns this layer. Pre-warm path may keep a thin wrapper.

**What stays:**

- `scripts/detect.ts` and `scripts/lib/detect-*.ts` — now invoked by
  `sync.ts` instead of `install.ts`. Frequency goes up (per session/file
  change instead of per install), making ADR-0002's 50ms target more
  important.
- `scripts/resolve.ts` — invoked by `sync.ts` to fill the component
  version map after detect.
- Eval suite — tests against the cache + delegation flow instead of
  static skill files.

## Consequences

### Positive

- **Zero install friction**. The plugin works after `bun install` /
  marketplace install with no user action.
- **Automatic version sync**. Build-file edits propagate to the cache via
  `FileChanged` hook; the next query uses the new version. No stale-skill
  window, no CI cron job.
- **No CLAUDE.md mutation**. The sacred-marker invariant becomes trivially
  satisfied because no marker exists.
- **Disk footprint shrinks** from 50–100MB to <1MB (single thin skill +
  small JSON cache).
- **Architecture simplification**. `install.ts` and most of `fetch.ts`
  become optional pre-warmer code; the core path is `sync.ts → cache →
  thin skill → ask`.
- **Per-context loading**. Claude only invokes `ask` for the libraries the
  current question needs (Framework, Security, Data, etc.) instead of
  loading all installed skills.
- **Eval suite simplification**. Tests no longer need to assert against
  a generated `.claude/skills/spring-*/` directory; they assert against
  the version cache and delegation behavior.

### Negative

- **First-query offline failure**. With no cache and no `@pleaseai/ask`
  cache, an air-gapped first query fails. Mitigated by `/spring:install
  --pre-warm` and clear error messaging that points to it.
- **External dependency on `@pleaseai/ask`**. Its SLA, rate limits, and
  cache strategy now bound our user experience. Document this dependency
  in `tech-stack.md`.
- **`docs.spring.io` HTML changes have immediate impact**. Static install
  buffered upstream changes until the next install run; lazy delegation
  surfaces breakage on the next query. Mitigated because `@pleaseai/ask`
  owns this risk centrally.
- **Hook configuration is plugin-level**. Misconfiguration affects all
  users of the plugin, not just one project. PR review must catch hook
  changes.
- **Architectural invariant change**. `ARCHITECTURE.md`'s
  "Offline-capable after first install" must be revised to
  "Offline-capable after first cache hit"; air-gapped flows route through
  `--pre-warm`. This requires `arch-md-v2` track scope expansion.
- **Token-budget per query**. Each `ask` delegation consumes tokens for
  the fetched documentation chunk. Mitigated by `ask`'s scoped retrieval
  (it returns relevant snippets, not full references).

### Neutral

- The `ask` skill is preferred for accuracy over training-knowledge
  (per its description). This is the project value proposition; lazy
  loading aligns the plugin shape with that preference instead of fighting
  it.
- `CwdChanged` covers the multi-project session case for free.
- `asyncRewake: true` lets the hook surface "version updated" context
  to Claude on the next turn, so users see a notification when build
  files change without polling.

## Alternatives Considered

- **Keep upfront install, add `FileChanged` hook for sync**: keeps the
  large disk footprint and CLAUDE.md mutation; hook adds complexity
  without removing the install step. Strictly worse.
- **Pure lazy without hooks (detect at query time)**: every query pays
  detect cost (50ms — fine) plus first-query resolve+fetch (3–30s — bad).
  Hooks let us amortize the resolve+fetch over background time.
- **Replace `/spring:install` entirely; remove pre-warm option**: breaks
  air-gapped CI and intentional offline-first users. The opt-in
  pre-warmer costs little to keep.
- **Pre-load all common Spring components into the thin skill**: bloats
  the always-loaded skill, defeats the per-context-loading benefit, and
  duplicates `@pleaseai/ask`'s job.
- **Use only `SessionStart`, skip `FileChanged`**: misses the case where
  the user edits `pom.xml` mid-session. The hook is cheap; including it
  is strictly better.

## Related

- ADR-0002: Three-Tier Version Detection — makes detection cheap enough
  to run on every hook trigger.
- ADR-0003: Extended Static Parser Coverage — defines what `sync.ts`
  reads when invoked by hooks.
- Spec: `.please/docs/tracks/active/build-file-detect-20260428/spec.md`
  hints at this direction in its athens-v2 note.
- `arch-md-v2-20260428` track — must absorb the
  "Offline-capable after first install" invariant change.
- Claude Code hooks documentation:
  `https://code.claude.com/docs/en/hooks.md` (especially `FileChanged`,
  `async`, `asyncRewake`, `CLAUDE_PROJECT_DIR`).
