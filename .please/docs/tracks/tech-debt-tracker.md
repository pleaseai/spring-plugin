# Tech Debt Tracker

> Tracked across all tracks. Updated during implementation and retrospectives.

## Active

| ID | Source Track | Description | Priority | Created |
|----|------------|-------------|----------|---------|
| TD-001 | plugin-scaffold-20260428 | `consola@3.4.2` adopted as runtime dep but no call site yet. First feature track must consume it or remove it. | low | 2026-04-29 |
| TD-002 | plugin-scaffold-20260428 | `README.md` "## Development" still references `bun run scripts/fetch.ts` and prebuilt-pipeline artifacts that don't exist (spec forbade rewriting). Reconcile after `arch-md-v2-20260428` lands. | medium | 2026-04-29 |
| TD-003 | plugin-scaffold-20260428 | `@pleaseai/eslint-config@0.0.1` is the only published version; source repo shows 0.0.3. Bump pin when later versions publish. | low | 2026-04-29 |
| TD-004 | plugin-scaffold-20260428 | CI uses `actions/setup-node@v4` only because eslint shells out to Node. If linting moves to a Bun-native path, drop the Node setup step. | low | 2026-04-29 |

## Resolved

| ID | Source Track | Description | Resolved In | Date |
|----|------------|-------------|-------------|------|
