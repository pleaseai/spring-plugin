# Tech Stack

> Technology choices and rationale for `@pleaseai/spring`.

## Runtime

### Bun
- **What**: JavaScript runtime for executing plugin scripts.
- **Why**: Fast startup (~10ms vs ~80ms for Node), built-in TypeScript without a bundler, native fetch/glob APIs.
- **Where**: `scripts/*.ts` files invoked by skills and slash commands.
- **Version target**: latest stable (≥1.1).

### Node fallback
- **Why**: Some users may not have Bun. Scripts should not rely on Bun-only globals (`Bun.file`, `Bun.serve`) unless the README documents a Bun requirement.
- **Approach**: Prefer `fs/promises`, `node:path`, native `fetch`. If Bun-only API is essential, gate it and document.

## Language

### TypeScript (strict)
- **Why**: Type safety for parsing build files (`pom.xml`, `build.gradle`), schema validation for `manifest.json`, refactor confidence as the BOM resolver grows.
- **Config**: `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`.
- **No `any`** without a comment justifying why type inference fails.

## Plugin Architecture

### Claude Code plugin conventions
- Manifest at `.claude-plugin/plugin.json` (only file in that dir).
- Components (`skills/`, `commands/`, `scripts/`) at plugin root.
- Path references use `${CLAUDE_PLUGIN_ROOT}` inside skills and scripts.

### Slash commands
Each slash command is a thin Markdown file in `commands/` that references a skill or invokes a script. Commands are entry points only — logic lives in skills/scripts.

### Skills
Skills (`skills/spring-installer/SKILL.md`) describe behavior and reference scripts. Auto-invoked by Claude Code when the conversation matches the skill description.

## Build File Parsing

### Gradle (`build.gradle`, `build.gradle.kts`)
- **Approach**: Regex-based extraction of Spring Boot plugin version. Full Groovy/Kotlin parsing is overkill for this need.
- **Library**: none — keep dependency surface minimal.
- **Edge cases**: version catalogs (`libs.versions.toml`), `ext` blocks, `subprojects { }`. Handle the common cases; document fallbacks (`/spring:install --boot 3.5`) for the rest.

### Maven (`pom.xml`)
- **Approach**: XML parsing via `fast-xml-parser` or built-in DOM utility.
- **Source**: Look for `spring-boot-starter-parent` or `spring-boot-dependencies` in dependency management.
- **Inheritance**: Resolve parent POM if `<relativePath>` or Maven Central reference exists.

## BOM Resolution

### `spring-boot-dependencies` POM from Maven Central
- **URL pattern**: `https://repo1.maven.org/maven2/org/springframework/boot/spring-boot-dependencies/{version}/spring-boot-dependencies-{version}.pom`
- **Parse**: extract `<properties>` for component versions (`spring-framework.version`, `spring-security.version`, etc.).
- **Cache**: store resolved BOM under `~/.cache/pleaseai-spring/boms/{version}.json` to avoid re-fetching.

## Documentation Conversion

### Source: `docs.spring.io` (Antora)
- Per-component HTML mirrors at predictable URLs (e.g., `docs.spring.io/spring-framework/reference/`).
- Antora-generated content uses `xref:`, `include::`, attribute substitution.

### HTML → Markdown
- **Library**: `turndown` for base HTML → Markdown conversion.
- **Custom rules**: `scripts/lib/antora-rules.ts` handles Antora-specific patterns. Each rule has a fixture-based unit test.
- **Output**: one Markdown file per Antora page, mirroring the upstream nav structure.

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
- **Lint + test** on every PR: `bun run lint`, `bun test`.
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

- **No bundler** — `bun` runs `.ts` directly.
- **No frontend framework** — there is no UI; all output is terminal/files.
- **No database** — caches use the filesystem under `~/.cache/pleaseai-spring/`.
- **No long-running server** — every command is a one-shot invocation.
