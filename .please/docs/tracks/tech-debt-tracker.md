# Tech Debt Tracker

> Tracked across all tracks. Updated during implementation and retrospectives.

## Active

| ID | Source Track | Description | Priority | Created |
|----|------------|-------------|----------|---------|
| TD-001 | plugin-scaffold-20260428 | `consola@3.4.2` adopted as runtime dep but no call site yet. First feature track must consume it or remove it. | low | 2026-04-29 |
| TD-002 | plugin-scaffold-20260428 | `README.md` "## Development" still references `bun run scripts/fetch.ts` and prebuilt-pipeline artifacts that don't exist (spec forbade rewriting). Reconcile after `arch-md-v2-20260428` lands. | medium | 2026-04-29 |
| TD-003 | plugin-scaffold-20260428 | `@pleaseai/eslint-config@0.0.1` is the only published version; source repo shows 0.0.3. Bump pin when later versions publish. | low | 2026-04-29 |
| TD-004 | plugin-scaffold-20260428 | CI uses `actions/setup-node@v4` only because eslint shells out to Node. If linting moves to a Bun-native path, drop the Node setup step. | low | 2026-04-29 |
| TD-005 | build-file-detect-20260428 | FR-16: `resolvePublishedCatalog` returns `not-found` on cache miss; needs network fallback once `scripts/resolve.ts` (single fetch boundary) lands in the resolve-bom track. | medium | 2026-04-30 |
| TD-006 | build-file-detect-20260428 | NFR-4: `coverage-check.ts` uses line coverage as proxy because Bun 1.3.13 lcov omits BRF/BRH/BRDA. Swap to branch ratios when Bun emits them or project adopts c8/istanbul. | low | 2026-04-30 |
| TD-007 | build-file-detect-20260428 | NFR-5: warm-cache latency ceiling is `100ms + 100ms CI noise margin`. Tighten toward spec's 100ms once stable CI variance is characterized over a few PRs. | low | 2026-04-30 |

## Resolved

| ID | Source Track | Description | Resolved In | Date |
|----|------------|-------------|-------------|------|
