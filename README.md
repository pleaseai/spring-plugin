# @pleaseai/spring

> Claude Code plugin for Spring ecosystem documentation.

Detects Spring versions from your build files, downloads matching reference docs as LLM-friendly Markdown, and makes them available to Claude Code as version-aware skills. Works across Spring Framework, Boot, Security, Data, and Cloud.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## What this does

When you run `/spring:install` in a Spring project, this plugin:

1. **Detects** Spring versions from `build.gradle`, `build.gradle.kts`, or `pom.xml`
2. **Resolves** the full ecosystem via the Spring Boot BOM — one declared Boot version pins Framework, Security, Data, and the rest
3. **Downloads** version-matched documentation (prebuilt archive when available, fresh conversion otherwise)
4. **Installs** it as Claude Code skills under `.claude/skills/spring-*/`

After install, Claude Code automatically loads the right Spring docs whenever you work on Spring code — no manual lookup, no version mismatch, no hallucinated APIs from the wrong major release.

## Why a separate plugin

Spring's documentation has characteristics that don't fit generic doc-fetching tools:

- **Antora-based** — `xref:`, `include::`, attribute substitution, conditional blocks
- **Multi-repository** — Framework, Boot, Security, Data, Cloud each live in their own repo
- **BOM-driven versioning** — your declared Boot version implicitly pins ten other components
- **Large conversion cost** — full Framework reference is ~200 pages, ~60 seconds to convert
- **Build-tool integration** — version detection requires understanding `build.gradle` and `pom.xml`

Bundling this complexity into a generic doc tool would inflate it for every user, even those not using Spring. Extracting it as a focused plugin keeps the surface area honest and lets Spring expertise live where it belongs.

## Installation

```
/plugin install pleaseai/spring
```

Or, for local development:

```bash
git clone https://github.com/pleaseai/spring ~/.claude/plugins/spring
```

Verify it loaded:

```
/spring:list
```

## Commands

### `/spring:install`

Detect Spring versions in the current project and install matching docs.

```
/spring:install            # auto-detect everything
/spring:install --boot 3.5 # override Boot line, derive the rest
/spring:install framework  # install only Spring Framework
```

What happens:

1. Reads `build.gradle` / `build.gradle.kts` / `pom.xml` from project root
2. Finds the Spring Boot version (most projects pin via `spring-boot-starter-parent` or the Spring Dependency Management plugin)
3. Fetches the matching `spring-boot-dependencies` BOM from Maven Central
4. Resolves transitive Spring component versions (Framework, Security, Data, etc.)
5. For each component:
   - Checks if a prebuilt archive exists in this plugin's GitHub Releases
   - If yes: downloads and extracts (~3 seconds)
   - If no: fetches docs from `docs.spring.io`, converts Antora HTML to Markdown (~30–60 seconds)
6. Installs into `.claude/skills/spring-<component>/` with a generated `SKILL.md`
7. Updates the project's `CLAUDE.md` with version notes

Idempotent: re-running with the same versions is a no-op. Safe to put in a postinstall hook.

### `/spring:list`

Show installed Spring skills and their versions.

```
/spring:list
```

```
spring-framework  6.2.1   (auto-detected from Boot 3.5.0)
spring-boot       3.5.0   (declared in build.gradle)
spring-security   6.4.0   (auto-detected from Boot 3.5.0)
spring-data-jpa   3.5.0   (auto-detected from Boot 3.5.0)
```

### `/spring:update`

Refresh installed components against the latest patches in their declared minor lines.

```
/spring:update                # all installed components
/spring:update framework      # one component
/spring:update --check        # dry run, no changes
```

Honors the version line declared at install time. To move across minor or major lines, use `/spring:install` again with a new Boot version.

### `/spring:remove`

Uninstall one or more components. Removes the skill directory and the corresponding `CLAUDE.md` block.

```
/spring:remove security
/spring:remove --all
```

### `/spring:add`

Install a single component without auto-detecting from build files. Useful for projects that don't use Boot, or for adding components outside the BOM.

```
/spring:add framework@6.2.1
/spring:add cloud-gateway@2024.0.0
```

## How Claude Code uses installed skills

After install, your project structure includes:

```
.claude/skills/
├── spring-framework/
│   ├── SKILL.md             ← Auto-loaded by Claude when relevant
│   ├── manifest.json        ← Version, source URL, fetch timestamp
│   ├── INDEX.md             ← Table of contents
│   └── references/
│       ├── core/
│       │   ├── beans.md
│       │   └── ...
│       ├── web/
│       │   ├── webmvc.md
│       │   └── ...
│       └── ...
├── spring-boot/
└── spring-security/
```

The generated `SKILL.md` carries a description like:

```markdown
---
name: spring-framework-docs
description: Use when answering questions about Spring Framework 6.2.1
  APIs, configuration, or behavior. Covers core IoC, web MVC, web reactive,
  data access, transactions, AOP, and testing. Do NOT use for Spring Boot,
  Security, or Cloud — use those dedicated skills instead.
---
```

Claude Code's auto-invocation matches this description against the conversation. When you ask a Spring Framework question, the skill loads, Claude consults the references, and answers with version-correct information.

The plugin also appends a block to your project's `CLAUDE.md`:

```markdown
<!-- spring-skill:start -->
## Spring References (managed by @pleaseai/spring)

- Spring Framework **6.2.1** — see `.claude/skills/spring-framework/`
- Spring Boot **3.5.0** — see `.claude/skills/spring-boot/`
- Spring Security **6.4.0** — see `.claude/skills/spring-security/`

When answering Spring questions, consult these references first.
Do NOT mix information across major versions.
<!-- spring-skill:end -->
```

The `<!-- spring-skill:start -->` markers let `/spring:remove` cleanly delete this block without touching anything else in your `CLAUDE.md`.

## Plugin structure

```
pleaseai/spring/
├── .claude-plugin/
│   └── plugin.json              ← Plugin manifest
├── skills/                      ← Skills shipped with the plugin
│   └── spring-installer/
│       └── SKILL.md             ← Implements /spring:install behavior
├── commands/                    ← Slash command entry points
│   ├── install.md               ← /spring:install
│   ├── list.md                  ← /spring:list
│   ├── update.md                ← /spring:update
│   ├── remove.md                ← /spring:remove
│   └── add.md                   ← /spring:add
├── scripts/                     ← Implementation invoked by skills
│   ├── detect.ts                ← Build file parsing
│   ├── resolve.ts               ← BOM-based version resolution
│   ├── fetch.ts                 ← Docs download + conversion
│   ├── install.ts               ← Skill installation
│   └── lib/
│       ├── antora-rules.ts      ← Antora-specific Turndown rules
│       └── manifest.ts          ← .claude/skills/*/manifest.json schema
├── prebuilt/                    ← Metadata for prebuilt archives
│   └── catalog.json             ← Maps version → release asset URL
└── .github/workflows/
    └── nightly-build.yml        ← Builds new archives on upstream releases
```

Per Claude Code conventions:
- The manifest lives at `.claude-plugin/plugin.json` (only file in that directory)
- All component directories (`skills/`, `commands/`, `scripts/`) live at plugin root
- `${CLAUDE_PLUGIN_ROOT}` is used in any path reference inside skills/scripts

## Version resolution

Spring's ecosystem versioning is centralized through Spring Boot's BOM (`spring-boot-dependencies`). Once you pin Boot, the rest follows.

Example: `build.gradle` with Boot 3.5.0:

```groovy
plugins {
  id 'org.springframework.boot' version '3.5.0'
  id 'io.spring.dependency-management' version '1.1.6'
}
```

The plugin fetches `spring-boot-dependencies-3.5.0.pom` from Maven Central and reads:

```xml
<properties>
  <spring-framework.version>6.2.1</spring-framework.version>
  <spring-security.version>6.4.0</spring-security.version>
  <spring-data-bom.version>2025.0.0</spring-data-bom.version>
  ...
</properties>
```

This becomes the source of truth for which doc versions to install. We do not maintain a separate compatibility matrix — the BOM is authoritative.

For projects without Boot (rare), use `/spring:add` to install components individually with explicit versions.

### Pre-release and EOL versions

- **Pre-release** (RC, M1, SNAPSHOT): Not supported. Use the latest GA in your line.
- **EOL versions**: Supported as long as upstream docs are reachable. The plugin emits a warning on install but proceeds.

## Prebuilt archives

To keep `/spring:install` fast, this plugin maintains pre-converted Markdown archives for popular Spring components and versions. Archives are published as GitHub Releases on this repository.

Coverage:

| Component | Version lines maintained |
|---|---|
| spring-framework | Latest two minor lines |
| spring-boot | Latest three minor lines |
| spring-security | Latest two minor lines |
| spring-data-jpa | Latest two minor lines |
| spring-cloud | Latest year line |

Archives are built nightly from upstream releases. If your project uses a version we don't have prebuilt, the plugin falls back to live conversion automatically — slower (~60s) but always works.

To skip the prebuilt cache and always convert fresh:

```
/spring:install --no-prebuilt
```

Useful if you're debugging a conversion issue or want to verify a fresh build matches the release.

## Manual fallback

If your environment can't reach `github.com` or `docs.spring.io`, you can pre-stage archives:

```bash
# Download on a connected machine
curl -L -o spring-framework-6.2.1.tar.gz \
  https://github.com/pleaseai/spring/releases/download/spring-framework-6.2.1/spring-framework-6.2.1.tar.gz

# Place in the plugin's offline cache
mkdir -p ~/.cache/pleaseai-spring/archives/
mv spring-framework-6.2.1.tar.gz ~/.cache/pleaseai-spring/archives/

# Install reads from cache first
/spring:install
```

## Configuration

The plugin reads configuration from `.spring-skill.json` at project root. All fields optional.

```json
{
  "components": ["framework", "boot", "security"],
  "excludeComponents": ["data-r2dbc", "data-cassandra"],
  "boot": "3.5.0",
  "skipPrebuilt": false,
  "claudeMdMarker": "spring-skill",
  "skillsDir": ".claude/skills"
}
```

CLI flags override this file, which overrides auto-detection.

## Eval results

We benchmark this plugin against bare Claude Code on a Spring task suite. Methodology and full results in [`evals/spring/`](evals/spring/).

| Setup | Pass rate | Wrong-version errors | Avg cost |
|---|---|---|---|
| **`@pleaseai/spring` installed** | **94%** (47/50) | 0 | $1.42 |
| Bare Claude Code | 62% (31/50) | 14 | $2.18 |
| `WebFetch` of `docs.spring.io` per task | 78% (39/50) | 6 | $3.91 |

The wrong-version errors are particularly stark: without versioned skills, Claude often answers with Spring 5.x patterns or pre-release features that don't exist in the user's actual version.

## Comparison with related tools

| Tool | Scope | Approach |
|---|---|---|
| **`@pleaseai/spring`** | Spring only | Versioned skills, BOM resolution, Antora-aware conversion |
| `@pleaseai/ask` | Generic (npm/github/pypi/pub) | Lazy fetch via `ask src` / `ask docs` |
| Context7 (MCP) | Generic | Live MCP server lookups |
| `WebFetch` | Generic | Per-query HTTP fetch |

We recommend installing both `@pleaseai/spring` and `@pleaseai/ask`. They complement each other:
- Spring plugin handles Spring's Antora ecosystem and BOM resolution
- ask handles everything else (Vue, React, Bun, your favorite npm package)

They write to different skill directories and don't conflict.

## Development

```bash
git clone https://github.com/pleaseai/spring
cd spring
bun install

# Run conversion locally against a specific version
bun run scripts/fetch.ts framework 6.2.1 --output /tmp/spring-framework-6.2.1

# Inspect the result
ls /tmp/spring-framework-6.2.1/

# Test plugin loading in Claude Code
ln -s "$(pwd)" ~/.claude/plugins/spring
```

Issues and PRs welcome. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

### Local Development

After cloning, install dev dependencies and run the toolchain:

```bash
bun install                # install dev deps from bun.lock
bun run typecheck          # tsc --noEmit
bun run lint               # eslint --max-warnings 0
bun run lint:fix           # eslint --fix (auto-fix style + format)
bun test                   # Bun test runner
```

Linting and formatting are unified through
[`@pleaseai/eslint-config`](https://github.com/pleaseai/code-style/tree/main/packages/eslint-config)
(built on `@antfu/eslint-config`) — no Prettier. A pre-commit hook
(Husky + `lint-staged`) runs `eslint --fix` on staged files; the same checks
run in CI on every PR via `.github/workflows/ci.yml`.

### Project Layout

```
.claude-plugin/plugin.json     plugin manifest (only file in this directory)
commands/                      slash command entry points (placeholder)
skills/                        auto-loaded skills (placeholder)
scripts/                       implementation scripts (placeholder)
└── lib/__tests__/             placeholder test confirming bun test wiring
.github/workflows/ci.yml       typecheck / lint / test on PRs
.husky/pre-commit              lint-staged on commit
.please/                       workspace state (specs, plans, knowledge)
```

The repository is currently a tooling skeleton — source files (`scripts/*.ts`,
`skills/*/SKILL.md`, `commands/*.md`) land in subsequent feature tracks.

## Licensing

### Plugin code

Licensed under **Apache-2.0**. See [`LICENSE`](./LICENSE).

### Generated archives

The plugin downloads Spring documentation and converts it to Markdown. Each generated archive carries Spring's upstream license (Apache-2.0) in a `NOTICE` file. We do not relicense documentation content; we only change format.

If you are a Spring maintainer and have concerns about how documentation is mirrored here, please open an issue.

## FAQ

**Why not just use `WebFetch` per question?**
Live fetching is slow, costs more in tokens, and gives Claude unstructured HTML. Pre-installed Markdown skills load instantly with version metadata baked in, and Claude's auto-invocation finds the right section without exploration.

**Why a Boot-centric design? My project doesn't use Boot.**
Most Spring projects do, and the BOM is the cleanest authoritative source for version resolution. For non-Boot projects, `/spring:add` lets you install components with explicit versions.

**How do I share installed skills with my team?**
Commit `.claude/skills/spring-*/` to your repo. The skills are plain Markdown — they version-control cleanly. Teammates skip the install step.

**Does this work offline?**
Yes, after one online install. Subsequent sessions read from `.claude/skills/` only. The "Manual fallback" section covers fully air-gapped setups.

**What about Spring projects in Kotlin? Or with Gradle Kotlin DSL?**
Both supported. The detector handles `build.gradle.kts` and works with Kotlin/Java/Groovy projects identically.

**Can I use this without Claude Code?**
The skill files are plain Markdown — any LLM tool that reads `.claude/skills/` or similar conventions can use them. But the slash commands (`/spring:install`) are Claude Code-specific.

**Why does `spring-data-jpa` have its own skill, but not `spring-data-jdbc`?**
We ship skills for components in the default coverage matrix. To install others, use `/spring:add data-jdbc@<version>`. Conversion happens live (no prebuilt) but works the same.

## Related projects

- [`@pleaseai/ask`](https://github.com/pleaseai/ask) — Generic library docs for Claude Code (npm, github, pypi, pub)
- [Spring Framework](https://github.com/spring-projects/spring-framework) — Upstream
- [Spring Boot](https://github.com/spring-projects/spring-boot) — Upstream

---

Maintained by [Passion Factory](https://passionfactory.ai) as part of the Please Tools ecosystem.
