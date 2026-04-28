# Product Guidelines

> Voice, UX principles, and design rules for `@pleaseai/spring`.

## Voice & Tone

### Honest, technical, non-promotional

The README sets the bar. Avoid marketing fluff; explain *why* design choices were made and *what trade-offs they imply*. Examples from existing copy that should be preserved:

- "Bundling this complexity into a generic doc tool would inflate it for every user."
- "We do not maintain a separate compatibility matrix — the BOM is authoritative."
- "Slower (~60s) but always works."

### Plain language for terminal output

CLI output and slash command results favor:

- Short, scannable lines over paragraphs
- Concrete numbers (e.g., "47/50", "~3 seconds") over qualitative claims ("fast")
- Acknowledgement of fallbacks and failure modes

### Korean and English parity

Output language is configurable via `.please/config.yml`. Both languages should:

- Use the same factual claims and numbers
- Match the README's directness

## CLI / Slash Command UX

### Be idempotent
`/spring:install` re-runs with same versions are no-ops. State the no-op explicitly to the user:

```
spring-framework  6.2.1   (already installed, no changes)
```

### Show the plan before running
Before downloading or converting, list what will happen:

```
Detected: Spring Boot 3.5.0 (build.gradle)
Resolving via spring-boot-dependencies-3.5.0.pom...
  spring-framework  6.2.1
  spring-security   6.4.0
  spring-data-jpa   3.5.0
Install path: .claude/skills/spring-*
```

### Distinguish prebuilt vs. live conversion
The user benefits from knowing whether the install hit the fast path:

```
spring-framework  6.2.1   prebuilt (~3s)
spring-security   6.4.0   converting from docs.spring.io (~45s)...
```

### Warn for EOL versions; do not block
If the user pins an EOL Spring line, emit a warning and continue. Do not silently downgrade or refuse.

## SKILL.md Generation

Each generated `SKILL.md` description must:

1. **Start with use cases**: "Use when answering questions about Spring Framework 6.2.1 APIs..."
2. **Name the version explicitly** so Claude's auto-invocation matches version-tagged questions.
3. **List exclusions**: "Do NOT use for Spring Boot, Security, or Cloud — use those dedicated skills instead."
4. **Stay under ~3 sentences** so it fits cleanly in skill listings.

## CLAUDE.md Block

The plugin manages a single block in the user's `CLAUDE.md`, delimited by:

```
<!-- spring-skill:start -->
...
<!-- spring-skill:end -->
```

### Rules
- **Never** edit content outside these markers.
- **Always** clean removal: `/spring:remove --all` deletes the block entirely.
- **Always** preserve user content above and below.

## Versioning

### Plugin
Use semver. Changelog is generated via `release-please` from conventional commits.

### Skill manifests
Each `manifest.json` carries:
- `version` — the upstream Spring version
- `source_url` — exact docs URL fetched
- `fetched_at` — ISO 8601 timestamp
- `archive_sha256` — for prebuilt archives

These let users audit what they have without re-running install.

## Code Style (Implementation)

### TypeScript / Bun
- Use `bun` runtime; no Node-specific APIs unless gated.
- Strict TypeScript, no `any` without comment justifying it.
- Prefer pure functions in `scripts/lib/*` over classes.

### Antora conversion
- Conversion rules live in `scripts/lib/antora-rules.ts`. New patterns should be unit-tested against fixtures from real Spring docs.
- Never silently drop unknown Antora directives — emit a warning so users can report missing patterns.

## Error Handling Philosophy

### Fail loudly at boundaries
- Build file parse errors → print the file path and line, suggest the override flag.
- Network failures → distinguish "no network" from "404" from "rate limited"; suggest `--no-prebuilt` or manual fallback.

### Trust internal contracts
Once the BOM has resolved versions, downstream functions assume the version is valid. No double-validation in helpers.

## Documentation

### README is the source of truth
Feature rollouts must update README sections (`Commands`, `Configuration`, `FAQ`) before merge. Stale README is a release blocker.

### Inline comments
Default to no comments. Only add when *why* is non-obvious — e.g., a workaround for a known Antora quirk, a version-specific edge case.

## Testing

### Eval suite is mandatory
Changes that affect output (conversion rules, BOM resolution, skill generation) must run against `evals/spring/` and report pass-rate delta in the PR.

### No regressions on wrong-version errors
The flagship metric is "0 wrong-version errors". A change that introduces even one is a release blocker.
