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
- [x] T005 [P] ~~Add Prettier config and verify `bun run format:check` exits 0~~ — **superseded by T009**: Prettier removed when `@pleaseai/eslint-config` adopted; `.prettierrc`, `.prettierignore`, and `format`/`format:check` scripts no longer exist. Formatting is now handled by `eslint --fix`.
- [x] T006 Wire Husky pre-commit hook and `lint-staged` config (file: `.husky/pre-commit`, `package.json` `lint-staged` block) (depends on T002, T004, T005)
- [x] T007 [P] Add CI workflow that runs typecheck/lint/test on PRs (file: `.github/workflows/ci.yml`) (depends on T002) — initially included `format:check`, dropped during T009 when Prettier was removed.
- [x] T008 Append "Local Development" / "Project Layout" subsection to `README.md` referencing the real scripts (file: `README.md`) (depends on T002, T003, T004, T005)

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
- 2026-04-28T19:13Z — T005 done: `.prettierrc` (semi, single-quote, trailing-comma, 100 col), `.prettierignore` (excludes `.please/`, `.claude/`, root markdown out-of-scaffold-scope). Scripts `format` / `format:check`. `bun run format:check` exits 0.
- 2026-04-28T19:16Z — T006 done: `husky init` wired hook chain via `.husky/_/`. `.husky/pre-commit` runs `bunx lint-staged`. Lint-staged config in `package.json` runs eslint+prettier on staged TS/JS, prettier on JSON/MD/YAML. Hook **fired live during this commit** (lint-staged output captured) — SC-7 verified.
- 2026-04-28T19:18Z — T007 done: `.github/workflows/ci.yml` runs on PRs+pushes to main. Single Bun version (`latest`) via `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile`, then typecheck → lint → format:check → test. SC-5 will be verified once the PR runs in CI.
- 2026-04-28T19:20Z — T008 done: appended `### Local Development` and `### Project Layout` subsections inside the existing `## Development` section of `README.md`. Lists the real scripts (`bun run typecheck/lint/format/test`) and the actual on-disk layout. Existing aspirational content kept untouched per spec.
- 2026-04-29T08:00Z — **T009 (post-spec revision)**: switched ESLint+Prettier setup to `@pleaseai/eslint-config@0.0.1`. The org-standard config wraps `@antfu/eslint-config` and is designed standalone (no Prettier). Removed `prettier`, `@eslint/js`, `typescript-eslint`, `globals` deps; removed `.prettierrc`, `.prettierignore`, `format`, `format:check` scripts. Updated `eslint.config.js` to a single `pleaseai({ ignores })` call. Auto-formatted all source via `bun run lint:fix` (no semicolons, single quotes, JSON key sort). Updated lint-staged to a single eslint --fix step, CI to drop format step, README/workflow.md to reflect unified linter+formatter. All gates (typecheck/lint/test) green.
- 2026-04-29T08:30Z — **CI fix**: Initial CI run failed with `TypeError: Object.groupBy is not a function`. The eslint binary uses `#!/usr/bin/env node` and Ubuntu runner default Node was <21, which lacks `Object.groupBy` (Node 21+ feature consumed by `eslint-flat-config-utils`). Added `actions/setup-node@v4` (Node 22) to the workflow before `oven-sh/setup-bun@v2`. CI now green (15s). **SC-1 + SC-5 verified.**
- 2026-04-29T09:05Z — **T010 (post-spec revision)**: adopted [`consola`](https://github.com/unjs/consola)@3.4.2 as the project logger. Added to `dependencies` (runtime, not devDependencies). Documented in `tech-stack.md` § Logging — overrides the "no logger library / tiny `log()` helper" line in `ARCHITECTURE.md`. No source consumes it yet (spec forbids `.ts` source under `scripts/skills/` beyond the placeholder test); first usage lands in a subsequent feature track.
- 2026-04-29T10:30Z — **Review-fix iteration 1** (commit `8fa5f88`): three doc/config drift issues identified by `/review:code-review` and applied. (1) `engines.bun` bumped `>=1.1.0` → `>=1.3.0` to match the text-format `bun.lock` floor; `tech-stack.md` § Runtime updated to match. (2) Plan T005 marked superseded by T009. (3) Plan T007 description corrected to drop the stale `format:check` reference. Iteration 2 returned **clean — no critical or important issues** at confidence ≥80.

## Decision Log

(Implementation may add ADR references here if non-obvious decisions surface.)

## Surprises & Discoveries

- **2026-04-28 / T002**: Bun 1.3.13 emits a **text-format `bun.lock`** (TOML-ish), not the legacy binary `bun.lockb`. The plan and spec referenced `bun.lockb` based on older Bun behavior. Text format is preferable for code review (diff-friendly) — committed as-is. CI's `--frozen-lockfile` works against both formats.
- **2026-04-28 / T002**: `tsc --noEmit` on the current empty include pattern emits TS18003 ("No inputs were found"). Resolved naturally once T003 adds the first `.ts` file. Adjusting tsconfig to suppress was rejected — better to let the typechecker enforce that source exists before being declared green.
- **2026-04-29 / T009**: Spec named separate ESLint + Prettier tooling. After landing T004/T005, the org standard `@pleaseai/eslint-config` was adopted instead — it bundles formatting rules (no Prettier needed) and adds `eslint-plugin-package-json` for manifest hygiene. Net effect: simpler toolchain, fewer deps (4 removed: `prettier`, `@eslint/js`, `typescript-eslint`, `globals`), but reformatting (no semicolons, single quotes, sorted JSON keys) cascaded across every committed file. Caught only by adopting the standard early — adopting later would have produced a much noisier diff.
- **2026-04-29 / CI**: `bun run lint` invokes the eslint binary which uses `#!/usr/bin/env node`. The Bun setup action does not install Node, so Ubuntu's default Node (~20) was active in CI. `eslint-flat-config-utils` calls `Object.groupBy` (Node 21+). Fix: add `actions/setup-node@v4` Node 22 step before Bun setup. **Implication for future tracks**: any tool that's actually a Node binary (eslint, tsc when invoked via npm script, etc.) needs an explicit Node setup in CI, even though we run "everything via bun" locally — Bun's `bun run script` does not transparently virtualize Node binaries.
- **2026-04-29 / T010**: `ARCHITECTURE.md` § Cross-Cutting Concerns / Logging says "No logger library; use a tiny `log()` helper that respects `--verbose`." Choosing `consola` overrides that. The override lives in `tech-stack.md` for now; `ARCHITECTURE.md` is locked for this track per spec and will be revised in `arch-md-v2-20260428`. Future readers should treat `tech-stack.md` as authoritative until the arch revision lands.

## Outcomes & Retrospective

### What Was Shipped
- `.claude-plugin/plugin.json` + layout placeholders (`commands/`, `skills/`, `scripts/`, `scripts/lib/`).
- `package.json` + `tsconfig.json` (TypeScript strict + bundler resolution); `bun.lock` (text format) committed; `engines.bun >=1.3.0`.
- Placeholder test (`scripts/lib/__tests__/scaffold.test.ts`) wiring `bun test`.
- Unified linter+formatter via `@pleaseai/eslint-config` (no Prettier; T009 sanctioned deviation). `lint`, `lint:fix` scripts; `lint-staged` block.
- Husky pre-commit hook (`.husky/pre-commit` → `bunx lint-staged`).
- GitHub Actions CI (`.github/workflows/ci.yml`): Node 22 + Bun latest → typecheck → lint → test on PRs and pushes to main.
- `consola@3.4.2` runtime dep (T010), documented in `tech-stack.md` § Logging — first usage in a future feature track.
- README "Local Development" / "Project Layout" subsections; `workflow.md` Before-Committing line and CI flow updated.
- `.gitignore` rules: `node_modules/`, `dist/`, `.idea/`, `.vscode/`, build artifacts, `.claude/scheduled_tasks.lock`.

### What Went Well
- **Single-PR slice-by-concern**. Eight tasks fit cleanly under one PR; the review surface stayed proportional to the actual decision surface.
- **Pre-commit hook caught its own setup**. Husky fired during the T006 → T010 commits, exercising lint-staged five times before any human review — SC-7 verified live, not theoretically.
- **Spec immutability honored**. ARCHITECTURE.md untouched; the v2 pivot stays in `tech-stack.md` and the dedicated `arch-md-v2-20260428` track.
- **Adopting `@pleaseai/eslint-config` at the right moment**. Switching after T004/T005 (rather than before, or after merge) kept the reformat diff isolated to a single labeled commit.
- **CI feedback loop tight**. Two CI failures (Node 21 missing `Object.groupBy`; pinned `engines.bun` floor mismatch) caught and resolved within minutes via the babysit-style background watch.

### What Could Improve
- **Spec→reality drift on lockfile**. The spec said `bun.lockb`. Bun 1.3 produces `bun.lock`. The mismatch surfaced at commit time, not during planning. Future scaffolding specs should leave lockfile naming open ("the lockfile produced by `bun install`") rather than nail down a filename that changes between Bun versions.
- **Out-of-scope reformat near-miss**. The first `lint:fix` run after T009 reformatted `.please/` and `.claude/` files because the eslint ignore-list was too narrow. Caught and reverted, but the right move is to *start* with broad ignores covering anything authored outside the current track. Documented in T009 progress.
- **Plan drift after sanctioned deviations**. T005 / T007 plan entries kept their original "format:check" wording after T009 removed the script. Caught only by the post-implementation `/review:code-review` pass. Future deviations should rewrite the affected task lines as the deviation lands, not after.
- **Pre-existing aspirational README content**. `README.md` lines 329-342 still reference `bun run scripts/fetch.ts` (doesn't exist). Spec forbade rewriting, so we appended new sections instead. Leaves the doc bimodal until a docs track reconciles the two halves.

### Tech Debt Created
- **`consola` adopted but unused**. A runtime dep with zero call sites. Justified by org policy alignment and avoiding a noisy follow-up PR, but flagged here so the first feature track that lands code is responsible for either using it or removing it. → `tech-debt-tracker.md`.
- **README aspirational content vs. current scaffolding mismatch**. The "## Development" section still describes a pipeline that doesn't exist (`scripts/fetch.ts`, prebuilt archives, etc.). A future docs track should reconcile after `arch-md-v2-20260428` lands. → `tech-debt-tracker.md`.
- **`@pleaseai/eslint-config@0.0.1` is the only published version**. The repo's `package.json` shows 0.0.3 in source. We pinned to the published version, but a stale dep is a known-future-bump waiting to happen. Track when 0.0.2+ publishes.
- **Bun-only globals not yet used; CI Node setup added defensively**. The CI's `actions/setup-node@v4` step exists only because eslint shells out to Node. If a future change moves linting to a true Bun-native path (e.g., `bun --bun eslint`), the Node setup becomes dead weight worth removing.
