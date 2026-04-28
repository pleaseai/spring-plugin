# CLAUDE.md

> Project-level instructions for Claude Code working on `@pleaseai/spring`.

## Project Overview

`@pleaseai/spring` is a Claude Code plugin that detects Spring versions from build files, downloads matching reference docs as LLM-friendly Markdown, and installs them as auto-loaded skills. See [`README.md`](./README.md) for the full overview.

<!-- please:knowledge v1 -->
## Project Knowledge

Consult these files for project context before exploring the codebase.
For full file listing with workspace artifacts, use `Skill("please:project-knowledge")`.

### Project Documents
- `ARCHITECTURE.md` — Codebase structure, module boundaries, architectural invariants
- `DESIGN.md` — Design decisions, patterns, data flows _(not yet written)_
- `SECURITY.md` — Security policies, authentication, authorization _(not yet written)_
- `CONTRIBUTING.md` — Contribution guide, code review process _(not yet written)_

### Domain Knowledge (.please/docs/knowledge/)
- `product.md` — Product vision, goals, target users
- `product-guidelines.md` — Branding, UX principles, design system
- `tech-stack.md` — Technology choices with rationale
- `workflow.md` — Task lifecycle, TDD, quality gates, dev commands
- `ubiquitous-language.md` — Domain terms glossary (DDD Ubiquitous Language)
- `gotchas.md` — Known project pitfalls and workarounds

### Decision Records
- `.please/docs/decisions/` — Architecture Decision Records (ADR)
<!-- /please:knowledge -->
