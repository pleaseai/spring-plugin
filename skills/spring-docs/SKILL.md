---
name: spring-docs
allowed-tools:
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/docs.js *)
  - Bash(node ${CLAUDE_SKILL_DIR}/scripts/detect.js *)
description: Open the reference documentation for one Spring project and version — Spring Boot 3.3.0-3.5.x and 4.0.8+. Use when answering a question about Spring behavior, configuration properties, auto-configuration, actuator, testing support or an upgrade path, and whenever the answer must match the version the project actually declares rather than the newest release. Takes "<project> <version>", e.g. "boot 3.5.16".
---

# Spring reference documentation

Resolves one `(project, version)` pair to a local directory of converted Markdown
and reads from there. The documentation is never copied into the user's project:
it is unpacked once into a shared cache, so nothing lands in version control and
two projects on the same Spring version share one copy.

## Resolve the version

Run this first, with the project key and the exact version:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/docs.js boot 3.5.16
```

It prints JSON:

```json
{
  "kind": "ready",
  "project": "boot",
  "version": "3.5.16",
  "tag": "boot-3.5.16",
  "path": "~/.cache/pleaseai-spring/docs/boot-3.5.16",
  "index": "~/.cache/pleaseai-spring/docs/boot-3.5.16/_index.md",
  "cached": true
}
```

Read `_index.md` at `index` to see the table of contents, then open only the
pages the question needs — the tree is 150-250 files, so never read it whole.
`Grep` across `path` when you know the term but not the page.

Add `--no-fetch` to require a cache hit (offline), or `--refresh` to re-download.

## Which version to pass

Use the version the project declares, not the newest one. `scripts/detect.js`
reads it from `build.gradle`, `build.gradle.kts` or `pom.xml`:

```bash
node ${CLAUDE_SKILL_DIR}/scripts/detect.js .
```

Ask the user only when detection returns `kind: "not-found"` or `"unsupported"`.

## When a version is not published

`kind: "unavailable"` is not a failure to work around. The `suggestion` field
says what to do — usually opening an issue on `pleaseai/spring-docs` so that
version gets built. Do not fall back to another version's documentation without
saying so: answering Spring questions from the wrong minor is the failure mode
this skill exists to prevent. Answer from general knowledge instead, and say
which version you are describing.

## Coverage

- `boot` — Spring Boot `3.3.0`-`3.x` and `4.0.8`+. 3.2 and older predate the
  Antora documentation component; 4.0.0-4.0.7 publish no content archive.
- Spring Boot 3.x trees omit the generated appendix (auto-configuration class
  listings, configuration-property tables) because upstream never publishes it.
  Configuration properties for 3.x therefore have to come from the prose pages.
- Other Spring projects (framework, security, data) are not published yet;
  `unknown-project` says so.
