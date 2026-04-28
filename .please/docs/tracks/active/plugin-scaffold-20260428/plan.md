# Plan: Plugin Scaffolding

> Track: plugin-scaffold-20260428
> Spec: [spec.md](./spec.md)

## Overview

- **Source**: /please:plan
- **Track**: plugin-scaffold-20260428
- **Issue**: (assigned by /please:new-track)
- **Created**: 2026-04-28
- **Approach**: Single-PR scaffolding, sliced by tooling concern. Each slice produces an independently-verifiable artifact (plugin layout, runtime, lint, format, test, hooks, CI, docs). No business code is introduced.

## Purpose

Land the empty-but-correct skeleton mandated by the spec so that subsequent feature tracks can focus on logic instead of tooling. A subsequent track will revise `ARCHITECTURE.md` to document the athens-v2 dynamic-loading direction; this track does not edit it.

## Context

The repository today contains only `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `LICENSE`, `.gitignore` (which already excludes `.please/state/`), and the `.please/` workspace. There is no `.claude-plugin/`, no `package.json`, no `tsconfig.json`, no `.github/workflows/`, and no source code. Anything missing from the spec's Scope must be created from scratch.

`tech-stack.md` is the binding constraint set: Bun runtime, TypeScript strict, no native deps, no bundler, pinned direct deps.

## Architecture Decision

**Single PR, slice-by-concern.** A scaffolding chore could be split into many micro-PRs (one per config file), but that produces churn without learning value — none of the slices are independently shippable to users. Bundling them into one PR keeps the review cost proportional to the actual decision surface (mostly "do these tools fit our policy?") and makes the plugin loadable end-to-end at the moment the PR merges.

**Defer everything that has its own track.** `commitlint`, eval suite, release automation, `@pleaseai/ask` integration, build-file detection, `ARCHITECTURE.md` v2 revision are all explicitly out of scope per the spec. The temptation to "while we're configuring tooling, also..." is the failure mode this decision exists to prevent.

**Husky over `simple-git-hooks` or shell-only.** Husky is the convention `lint-staged` is documented against, and adds no native deps. Keeps the integration boring.

**Flat ESLint config (`eslint.config.js`), not legacy `.eslintrc.*`.** ESLint 9+ defaults to flat config; using the legacy format would mean opting out of the future direction on day one.

**`bun install` produces `bun.lockb` (binary).** It is committed per Bun convention. CI uses `--frozen-lockfile` to fail on lockfile drift.

**No Architecture Diagram needed.** This track produces flat top-level files and directories with no inter-module data flow. A diagram would be noise.

## Tasks

- [x] T001 [P] Create `.claude-plugin/plugin.json` and empty layout directories (file: `.claude-plugin/plugin.json`, plus `.gitkeep` in `commands/`, `skills/`, `scripts/`, `scripts/lib/`)
- [x] T002 Create `package.json` + `tsconfig.json` and run `bun install` to generate `bun.lock` (file: `package.json`, `tsconfig.json`, `bun.lock`) — Bun 1.3+ writes text-format `bun.lock`, not legacy `bun.lockb`
- [x] T003 [P] Add placeholder test and verify `bun test` is wired (file: `scripts/lib/__tests__/scaffold.test.ts`) (depends on T002)
- [x] T004 [P] Add ESLint flat config and verify `bun run lint` exits 0 (file: `eslint.config.js`) (depends on T002)
- [ ] T005 [P] Add Prettier config and verify `bun run format --check` exits 0 (file: `.prettierrc`, `.prettierignore`) (depends on T002)
- [ ] T006 Wire Husky pre-commit hook and `lint-staged` config (file: `.husky/pre-commit`, `package.json` `lint-staged` block) (depends on T002, T004, T005)
- [ ] T007 [P] Add CI workflow that runs typecheck/lint/test on PRs (file: `.github/workflows/ci.yml`) (depends on T002)
- [ ] T008 Append "Local Development" / "Project Layout" subsection to `README.md` referencing the real scripts (file: `README.md`) (depends on T002, T003, T004, T005)

## Dependencies

```
T001 ──────────────────────────────────────── (independent)

T002 ──┬── T003 ──┐
       ├── T004 ──┼── T006
       ├── T005 ──┘
       ├── T007
       └── T008  (also depends on T003, T004, T005)
```

T001 is fully independent and can land first, last, or in parallel. Everything else flows from T002 (the package manifest). T003, T004, T005, T007 run in parallel after T002. T006 needs lint + prettier configs to exist. T008 closes the chain by documenting the real script names.

## Key Files

- `.claude-plugin/plugin.json` — plugin manifest; only file in its directory per Claude Code convention.
- `package.json` — source of truth for scripts, deps, lint-staged config.
- `tsconfig.json` — TypeScript strict mode; will be the contract for every future `.ts` file.
- `eslint.config.js` — flat config; defines hygiene rules without formatting.
- `.prettierrc` — owns formatting.
- `.husky/pre-commit` — entry point for staged-file checks.
- `.github/workflows/ci.yml` — single source of CI behavior; mirrors local `bun run` scripts so "passes locally → passes CI" holds.
- `README.md` — receives one new subsection; the rest of the file is untouched.

## Verification

Tied to spec Success Criteria (SC-1…SC-7):

- **SC-1** (`bun install`): T002 — manual run on clean checkout in PR branch.
- **SC-2** (`bun run typecheck`): T002 — runs as part of CI (T007). With no `.ts` source yet this is trivially green; the value is wiring it.
- **SC-3** (`bun run lint`): T004 — `eslint.config.js` lints zero files green; CI (T007) enforces it.
- **SC-4** (`bun test`): T003 — placeholder test asserts a tautology to prove the runner is wired.
- **SC-5** (CI green on PR): T007 — checked on the PR for this track. **Blocking gate** for merge.
- **SC-6** (manifest convention): T001 — manual review against Claude Code's plugin convention; no schema validator dep.
- **SC-7** (Husky pre-commit fires): T006 — manually staged a `.ts` change and committed before merge; result documented in PR description.

## Progress

- 2026-04-28T19:05Z — T001 done: `.claude-plugin/plugin.json` + `.gitkeep` placeholders for `commands/`, `skills/`, `scripts/`, `scripts/lib/`.
- 2026-04-28T19:08Z — T002 done: `package.json` (Bun runtime, ESM, scripts/test+typecheck, deps pinned), `tsconfig.json` (strict + bundler resolution), `bun install` produced `bun.lock` (text format). `node_modules/` ignored.
- 2026-04-28T19:09Z — T003 done: placeholder test (`scripts/lib/__tests__/scaffold.test.ts`) using `bun:test`. `bun test` reports 1 pass / 0 fail. `bun run typecheck` exits 0 (TS18003 resolved). SC-2 + SC-4 verified.
- 2026-04-28T19:11Z — T004 done: `eslint.config.js` flat config with `typescript-eslint` recommended preset + hygiene rules (`no-unused-vars`, `consistent-type-imports`, `eqeqeq`). `bun run lint` exits 0 with `--max-warnings 0`. SC-3 verified.

## Decision Log

(Implementation may add ADR references here if non-obvious decisions surface.)

## Surprises & Discoveries

- **2026-04-28 / T002**: Bun 1.3.13 emits a **text-format `bun.lock`** (TOML-ish), not the legacy binary `bun.lockb`. The plan and spec referenced `bun.lockb` based on older Bun behavior. Text format is preferable for code review (diff-friendly) — committed as-is. CI's `--frozen-lockfile` works against both formats.
- **2026-04-28 / T002**: `tsc --noEmit` on the current empty include pattern emits TS18003 ("No inputs were found"). Resolved naturally once T003 adds the first `.ts` file. Adjusting tsconfig to suppress was rejected — better to let the typechecker enforce that source exists before being declared green.
