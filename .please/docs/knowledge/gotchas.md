# Gotchas

> Known project pitfalls and workarounds. Update when a non-obvious issue is hit twice.

## Toolchain

- **`bun run lint` requires Node 22+ in CI** — the eslint binary uses `#!/usr/bin/env node`. The Bun setup action does not install Node. Add `actions/setup-node@v4` before `oven-sh/setup-bun@v2`. Older Node (≤20) lacks `Object.groupBy` used by `eslint-flat-config-utils`. Local dev is fine because Node 22+ is usually already installed.

- **Bun 1.3+ writes text-format `bun.lock`** (not legacy `bun.lockb`); lower Bun versions cannot read the new lockfile and will fail `bun install --frozen-lockfile`. That is the floor the lockfile needs — `engines.bun` sits higher (`>=1.4.2`), because the committed skill bundles are byte-compared against CI's Bun (see below). Documented in `tech-stack.md` § Runtime.

- **Committed skill bundles are Bun-version-coupled** — `bun run build:skill:check` byte-compares a fresh bundle against the committed one, so a Bun whose codegen differs from CI's pin fails the gate on an untouched source tree. Keep the local Bun and `ci.yml`'s `bun-version` on the same version; after bumping either, run `bun run build:skill` and commit the result, and raise `engines.bun` to match so a contributor on an older Bun is told before the gate tells them.

- **`import.meta.main` is not portable through a bundle** — Bun lowers it to a `__require` comparison that resolves only when some dependency happens to pull in the CJS interop helper. `detect.js` worked by accident (fast-xml-parser supplied it) while `docs.js` threw `ReferenceError: __require is not defined` under plain `node`. `scripts/build-skill.ts` pins it with `define: { 'import.meta.main': 'true' }`; a bundle is always the entrypoint.

- **`@pleaseai/eslint-config` includes formatting** — designed standalone, no Prettier. Auto-format applies: no semicolons, single quotes, sorted JSON keys. Adopt early or expect a cascade reformat across every committed file. Do not also install Prettier.

- **eslint `ignores` must exclude cross-track files** — keep `.please/`, `.claude/`, root markdown (`README.md`, `CLAUDE.md`, `ARCHITECTURE.md`) in the ignore-list. Otherwise `bun run lint:fix` from one track will reformat files owned by other tracks or by `.please/` workspace state, producing a noisy out-of-scope diff.

- **lint-staged + `--max-warnings 0` + ignored files**: when a staged path falls under eslint's ignore-list, eslint emits a "File ignored because of a matching ignore pattern" *warning* that trips `--max-warnings 0` and fails the pre-commit hook. Add `--no-warn-ignored` to the lint-staged eslint command to suppress.

## Static analysis (SonarQube Cloud, Codacy)

Neither service is invoked by a workflow — both analyse every push through their GitHub App. That changes where their configuration lives and when it takes effect.

- **SonarQube Cloud is in Automatic Analysis mode, which reads `.sonarcloud.properties` and ignores `sonar-project.properties`.** The docs are explicit that the two files are different and that a `sonar-project.properties` in an imported project is ignored. Three further constraints: only the copy on the **default branch** applies (a change does not affect the PR that makes it), **wildcards are not allowed** in the values, and where the file and the SonarQube Cloud UI disagree the **file wins** — so an entry that matches nothing cannot be corrected from the UI while it is still there.

- **Codacy reads `.codacy.yml` (or `.codacy.yaml`), and the first line must be `---`.** Additions are honoured on the PR that makes them; only removals wait for the default branch. Once the file exists, the UI's "Ignored files" settings stop applying. Validate before pushing: `docker run --rm -v "$(pwd)":/src codacy/codacy-analysis-cli validate-configuration --directory /src`.

- **Codacy's ESLint runs its own rule set, not this repo's, unless the Code patterns UI toggle says otherwise.** That is why `bun run lint` is clean while Codacy reports dozens of `Found <fn> from package "node:fs" with non literal argument` — the rule is `detect-non-literal-fs-filename` from `eslint-plugin-security`, which is not in this repo's dependency tree at all. On a module whose job is building and reading cache paths it fires on nearly every line. Codacy detects `eslint.config.js` for ESLint v9, but using it requires activating the per-tool "Configuration file" toggle on the repository's Code patterns page — a UI action, not a repo change.

- **The committed skill bundles must be excluded from both.** `skills/*/scripts/*.mjs` is generated from `scripts/*.ts` and committed for the `npx skills` channel, so analysing it scores the same program twice: full-file duplication against its source, plus the `var` declarations Bun emits, which cannot be edited away because `build:skill:check` byte-compares the bundle. `eslint.config.js` already ignored it; `.sonarcloud.properties` and `.codacy.yml` now do too.

- **Neither check blocks a merge.** The `main` ruleset carries no `required_status_checks` rule — only `deletion`, `non_fast_forward`, and a `pull_request` rule with `required_approving_review_count: 0`, `allowed_merge_methods: ["squash"]`, and `required_review_thread_resolution: true`. A PR showing `mergeStateStatus: BLOCKED` on green CI is almost always an **unresolved review thread**, not a failing analyser. Auto-merge cannot be armed at all: the repository has `allow_auto_merge: false`.

## Repo / process

- **Husky 9 pre-commit hook**: just `bunx lint-staged` on a single line. No shebang, no `set -e` — the `_/h` wrapper handles shell setup. Adding the legacy boilerplate is harmless but stale.

- **`.claude/scheduled_tasks.lock` is per-session runtime state** — must be in `.gitignore` to prevent accidental commits. The file is created by Claude Code's scheduler and recreated each session.

- **Spec-immutable files** (e.g., `ARCHITECTURE.md` during a track that doesn't own it): document any override in `tech-stack.md` (or another non-locked file) and reference the future track that will reconcile. Do not edit the locked file even when it contradicts a sanctioned deviation — the spec contract is the constraint.
