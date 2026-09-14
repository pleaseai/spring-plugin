# Tech Stack

> Technology choices and rationale for `@pleaseai/spring`.

## Runtime

### Bun
- **What**: JavaScript runtime for executing plugin scripts.
- **Why**: Fast startup (~10ms vs ~80ms for Node), built-in TypeScript without a bundler, native fetch/glob APIs.
- **Where**: `scripts/*.ts` files invoked by skills and slash commands.
- **Version target**: latest stable. The committed `bun.lock` uses Bun's text-format lockfile (default since 1.3); Bun 1.1.x cannot read it. `engines.bun` sits above that at `>=1.4.2`, matching `ci.yml`'s pin, because `build:skill:check` byte-compares the committed bundles against CI's codegen — an older Bun regenerates them differently and fails the gate on an untouched tree.

### Node fallback
- **Why**: Some users may not have Bun. Scripts should not rely on Bun-only globals (`Bun.file`, `Bun.serve`) unless the README documents a Bun requirement.
- **Approach**: Prefer `fs/promises`, `node:path`, native `fetch`. If Bun-only API is essential, gate it and document.

## Language

### TypeScript (strict)
- **Why**: Type safety for parsing build files (`pom.xml`, `build.gradle`), schema validation for `manifest.json`, refactor confidence as the BOM resolver grows.
- **Config**: `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`.
- **No `any`** without a comment justifying why type inference fails.

## Plugin Architecture

### Two install channels
The skill ships both as a Claude Code plugin and as a standalone skill installed
with `npx skills` ([vercel-labs/skills](https://github.com/vercel-labs/skills)).
The second channel copies **only** the `skills/spring-docs/` directory, so it has
no plugin root, no `node_modules`, and no dependency install. Everything the
skill executes at runtime therefore lives inside its own directory.

- Manifest at `.claude-plugin/plugin.json` (only file in that dir).
- TypeScript sources stay at the plugin root (`scripts/`) where tests, typecheck
  and lint reach them.
- `bun run build:skill` bundles them into `skills/spring-docs/scripts/*.mjs` —
  dependency-free, committed, and run with `node`.
- Skill content references scripts through `${CLAUDE_SKILL_DIR}`, which resolves
  at the personal, project **and** plugin level. `${CLAUDE_PLUGIN_ROOT}` is
  substituted only in plugin skills, so it cannot be used here.

### Skills
Skills (`skills/spring-installer/SKILL.md`) describe behavior and reference scripts. Auto-invoked by Claude Code when the conversation matches the skill description.

## Build File Parsing

### Gradle (`build.gradle`, `build.gradle.kts`)
- **Approach**: Regex-based extraction of Spring Boot plugin version. Full Groovy/Kotlin parsing is overkill for this need.
- **Library**: none — keep dependency surface minimal.
- **Edge cases**: version catalogs (`libs.versions.toml`), `ext` blocks, `subprojects { }`. Handle the common cases; document fallbacks (`/spring:install --boot 3.5`) for the rest.

### Maven (`pom.xml`)
- **Approach**: XML parsing via `fast-xml-parser` (chosen — pure JS, no native deps).
- **Source**: Look for `spring-boot-starter-parent` or `spring-boot-dependencies` in dependency management.
- **Inheritance**: Resolve parent POM via `<relativePath>` (≤5-hop bound) and the local `~/.m2/repository` cache for external parents. `${...}` interpolation is rejected with the FR-17 `requires-build-tool` reason.

## BOM Resolution

### `spring-boot-dependencies` POM from Maven Central
- **URL pattern**: `https://repo1.maven.org/maven2/org/springframework/boot/spring-boot-dependencies/{version}/spring-boot-dependencies-{version}.pom`
- **Parse**: extract `<properties>` for component versions (`spring-framework.version`, `spring-security.version`, etc.).
- **Cache**: store resolved BOM under `~/.cache/pleaseai-spring/boms/{version}.json` to avoid re-fetching.

### Plugin-owned cache layout (`~/.cache/pleaseai-spring/`)
- `boms/{version}.json` — resolved Spring component versions per Boot version (BOM resolver track).
- `catalogs/{artifact}-{version}.toml` — published Gradle version catalogs (FR-16) populated by future fetch flow; checked after `~/.m2` and `~/.gradle/caches`.
- `overrides.json` — per-project `--boot` overrides (FR-15), keyed by `sha256(absolute project_dir)`.

## Documentation Conversion

### Source: `docs.spring.io` (Antora)
- Per-component HTML mirrors at predictable URLs (e.g., `docs.spring.io/spring-framework/reference/`).
- Antora-generated content uses `xref:`, `include::`, attribute substitution.

### HTML → Markdown
- **Library**: `turndown` for base HTML → Markdown conversion.
- **Custom rules**: `scripts/lib/antora-rules.ts` handles Antora-specific patterns. Each rule has a fixture-based unit test.
- **Output**: one Markdown file per Antora page, mirroring the upstream nav structure.

## Logging

Scripts print JSON on stdout and nothing else — there is no logger library.
`consola` was adopted during the scaffold track and removed once the skill
bundles had to stay dependency-free (TD-001); a logger would be inlined into
every bundle for output the skill's callers parse as JSON anyway.

## Distribution

### Prebuilt archives
- **Format**: tar.gz uploaded to GitHub Releases on `pleaseai/spring`.
- **Catalog**: `prebuilt/catalog.json` maps `{component, version}` → release asset URL + sha256.
- **Build trigger**: nightly GitHub Actions workflow (`.github/workflows/nightly-build.yml`) on upstream releases.

### Live conversion fallback
- Triggered when `prebuilt/catalog.json` has no entry for the requested version.
- ~30–60 seconds for full Framework reference.
- Output written to `.claude/skills/spring-*/` directly.

## CI/CD

### GitHub Actions
- **Lint + test + coverage** on every PR: `bun run typecheck`, `bun run lint`, `bun run test:coverage`, then `bun run coverage:check` enforces ≥90% line coverage on `scripts/lib/detect-*.ts`. lcov report uploaded as a CI artifact.
- **Eval suite** on PRs touching `scripts/lib/`: `bun run evals/spring/run.ts` with pass-rate delta in PR comment.
- **Nightly archive build** for new upstream releases.
- **Release** via `release-please` based on Conventional Commits.

## Local Development

### Setup
```bash
git clone https://github.com/pleaseai/spring
cd spring
bun install
```

### Plugin loading in Claude Code
```bash
ln -s "$(pwd)" ~/.claude/plugins/spring
```

### Iterate on conversion
```bash
bun run scripts/fetch.ts framework 6.2.1 --output /tmp/spring-framework-6.2.1
```

## Dependency Policy

- **Keep deps minimal**: every new dep needs justification in PR description.
- **No deps with native bindings** if avoidable — keeps prebuilt archive builds reproducible across architectures.
- **Pin direct deps** in `package.json`; let Bun's lockfile resolve transitives.

## Out of Stack

- **No bundler for the plugin channel** — `bun` runs `.ts` directly. `Bun.build` is used for one thing only: the committed skill bundles the standalone channel needs (see § Two install channels).
- **No frontend framework** — there is no UI; all output is terminal/files.
- **No database** — caches use the filesystem under `~/.cache/pleaseai-spring/`.
- **No long-running server** — every command is a one-shot invocation.
