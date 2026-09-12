# @pleaseai/spring

> Claude Code plugin for version-matched Spring reference documentation.

Answers Spring questions from the documentation of the version your project actually declares, not the newest release. It reads the Spring Boot version out of your build file, resolves it to a published documentation archive, unpacks it once into a shared cache, and points Claude at that directory.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](./LICENSE)

## Status

Two scripts and one skill are implemented: build-file detection, documentation resolution, and the `spring-docs` skill that ties them together. There are no slash commands yet — the skill is the interface, and Claude invokes it on its own when a question needs Spring documentation.

## What it does

```
you: "does spring.jpa.open-in-view still default to true?"

  ├─ scripts/detect.ts .           → build.gradle declares Boot 3.5.16
  ├─ scripts/docs.ts boot 3.5.16   → ~/.cache/pleaseai-spring/docs/boot-3.5.16
  └─ Claude reads _index.md, opens the pages it needs, answers from 3.5.16
```

Nothing is written into your project. No `.claude/skills/spring-*/` tree, no `CLAUDE.md` block, no `.gitignore` entry — the documentation lives in a cache shared across every project and branch on the machine.

## Why not install the docs into the project

An early design wrote each component's Markdown under `.claude/skills/spring-*/` and annotated the project's `CLAUDE.md`. That was dropped:

- **One version is 150-250 files** (2.4 MB for Boot 3.5.16, 3.6 MB for 4.1.1). In the project tree that is a permanent diff, a `.gitignore` entry, and a branch-switch hazard.
- **Every project pays again** for the same version.
- **Rewriting someone's `CLAUDE.md`** is a trust cost with no return once the skill can simply name a path.
- **Staleness**: on-disk skills drift when the declared version changes. Resolving per question cannot drift.

The cache is keyed by release **tag**, not by version, so a corrected archive (`boot-4.1.1+rebuild.1`) lands beside the one it supersedes instead of silently serving stale bytes.

## Usage

The skill runs the scripts for you. To use them directly:

```bash
# Which Boot version does this project declare?
bun run scripts/detect.ts .

# Resolve that version's docs; prints JSON with a `path`
bun run scripts/docs.ts boot 3.5.16

# Require a cache hit (offline), or force a re-download
bun run scripts/docs.ts boot 3.5.16 --no-fetch
bun run scripts/docs.ts boot 3.5.16 --refresh
```

```json
{
  "kind": "ready",
  "project": "boot",
  "version": "3.5.16",
  "tag": "boot-3.5.16",
  "path": "/Users/you/.cache/pleaseai-spring/docs/boot-3.5.16",
  "index": "/Users/you/.cache/pleaseai-spring/docs/boot-3.5.16/_index.md",
  "cached": true
}
```

A version that has not been published comes back as `kind: "unavailable"` with the issue tracker in `suggestion`. The skill is instructed not to quietly substitute a different version — answering from the wrong minor is the failure this plugin exists to prevent.

## How resolution works

1. **Catalog lookup** — `catalog.json` on [`pleaseai/spring-docs`](https://github.com/pleaseai/spring-docs) maps `(project, version)` to a release tag. It is a few kilobytes and is fetched every time, because it is the only thing that reports a rebuild having moved a version to a new tag.
2. **Cache check** — if the tag's directory is already unpacked, that path is returned and nothing else is downloaded.
3. **Download and verify** — the `.tar.gz` (0.4-0.5 MB) and its `.sha256` sidecar. A digest mismatch writes nothing and fails loudly.
4. **Unpack** — into a staging directory beside the target, then renamed into place, so an interrupted run never leaves a half-written tree under the name callers read.

Each unpacked tree carries the `manifest.json` from its release: upstream repository, ref, commit, converter versions, file count, and a checksum over the content.

## Coverage

| Project | Versions | Source |
|---|---|---|
| `boot` | Spring Boot `3.3.0`-`3.x`, `4.0.8`+ | [`pleaseai/spring-docs`](https://github.com/pleaseai/spring-docs) releases |

Not buildable upstream, and therefore absent: Boot 3.2 and older predate the Antora documentation component, and 4.0.0-4.0.7 publish no content archive. Pre-release versions (M, RC, SNAPSHOT) are out of scope.

Spring Boot 3.x trees omit the generated appendix — auto-configuration class listings and configuration-property tables are a Gradle build output upstream never publishes. The prose corpus (reference, how-to, tutorial, specification) is complete.

Framework, Security, Data and Cloud are not published yet. When they are, resolving them is the same call with a different project key; BOM-based resolution of one declared Boot version into the whole component matrix belongs to that point, not before it.

## Plugin structure

```
.claude-plugin/plugin.json     plugin manifest
skills/spring-docs/SKILL.md    the skill Claude invokes
scripts/detect.ts              build-file detection (Gradle Groovy/Kotlin, Maven)
scripts/docs.ts                catalog lookup, download, verify, unpack
scripts/lib/                   pure helpers — no I/O
scripts/__tests__/             bun tests
```

Archive generation is not here. The conversion pipeline (Antora, Asciidoctor, the Markdown converter) lives in [`pleaseai/spring-docs`](https://github.com/pleaseai/spring-docs); this plugin only consumes its releases.

## Development

```bash
git clone https://github.com/pleaseai/spring-plugin
cd spring-plugin
bun install

bun run typecheck          # tsc --noEmit
bun run lint               # eslint --max-warnings 0
bun test                   # bun test runner

# Load it into Claude Code
ln -s "$(pwd)" ~/.claude/plugins/spring
```

Linting and formatting are unified through [`@pleaseai/eslint-config`](https://github.com/pleaseai/code-style/tree/main/packages/eslint-config) — no Prettier. Husky + `lint-staged` run `eslint --fix` on staged files, and CI runs the same checks on every PR.

## Related projects

- [`@pleaseai/spring-docs`](https://github.com/pleaseai/spring-docs) — the content repository this plugin reads
- [`@pleaseai/ask`](https://github.com/pleaseai/ask) — generic library docs for Claude Code (npm, github, pypi, pub)
- [Spring Boot](https://github.com/spring-projects/spring-boot) — upstream

## Licensing

Plugin code is Apache-2.0 ([`LICENSE`](./LICENSE)). The documentation archives keep Spring's upstream Apache-2.0 license: every archive ships a `NOTICE` pinned to the source commit, and nothing about the content's meaning is changed. Concerns about the mirroring belong on [`pleaseai/spring-docs`](https://github.com/pleaseai/spring-docs/issues).

---

Maintained by [Passion Factory](https://passionfactory.ai) as part of the Please Tools ecosystem.
