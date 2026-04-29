# Gotchas

> Known project pitfalls and workarounds. Update when a non-obvious issue is hit twice.

## Toolchain

- **`bun run lint` requires Node 22+ in CI** — the eslint binary uses `#!/usr/bin/env node`. The Bun setup action does not install Node. Add `actions/setup-node@v4` before `oven-sh/setup-bun@v2`. Older Node (≤20) lacks `Object.groupBy` used by `eslint-flat-config-utils`. Local dev is fine because Node 22+ is usually already installed.

- **Bun 1.3+ writes text-format `bun.lock`** (not legacy `bun.lockb`). `package.json` must pin `engines.bun: ">=1.3.0"`; lower Bun versions cannot read the new lockfile and will fail `bun install --frozen-lockfile`. Documented in `tech-stack.md` § Runtime.

- **`@pleaseai/eslint-config` includes formatting** — designed standalone, no Prettier. Auto-format applies: no semicolons, single quotes, sorted JSON keys. Adopt early or expect a cascade reformat across every committed file. Do not also install Prettier.

- **eslint `ignores` must exclude cross-track files** — keep `.please/`, `.claude/`, root markdown (`README.md`, `CLAUDE.md`, `ARCHITECTURE.md`) in the ignore-list. Otherwise `bun run lint:fix` from one track will reformat files owned by other tracks or by `.please/` workspace state, producing a noisy out-of-scope diff.

- **lint-staged + `--max-warnings 0` + ignored files**: when a staged path falls under eslint's ignore-list, eslint emits a "File ignored because of a matching ignore pattern" *warning* that trips `--max-warnings 0` and fails the pre-commit hook. Add `--no-warn-ignored` to the lint-staged eslint command to suppress.

## Repo / process

- **Husky 9 pre-commit hook**: just `bunx lint-staged` on a single line. No shebang, no `set -e` — the `_/h` wrapper handles shell setup. Adding the legacy boilerplate is harmless but stale.

- **`.claude/scheduled_tasks.lock` is per-session runtime state** — must be in `.gitignore` to prevent accidental commits. The file is created by Claude Code's scheduler and recreated each session.

- **Spec-immutable files** (e.g., `ARCHITECTURE.md` during a track that doesn't own it): document any override in `tech-stack.md` (or another non-locked file) and reference the future track that will reconcile. Do not edit the locked file even when it contradicts a sanctioned deviation — the spec contract is the constraint.
