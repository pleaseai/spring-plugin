# Project Workflow

> Defines the development workflow for `@pleaseai/spring`.
> Referenced by `/please:implement`.

## Guiding Principles

1. **The Plan is the Source of Truth**: All work is tracked in the track's `plan.md`
2. **The Tech Stack is Deliberate**: Changes to the tech stack must be documented in `tech-stack.md` before implementation
3. **Test-Driven Development**: Write tests before implementing functionality
4. **High Code Coverage**: Aim for >80% code coverage for new code
5. **Non-Interactive & CI-Aware**: Prefer non-interactive commands. Use `CI=true` for watch-mode tools

## Task Workflow

All tasks follow a strict lifecycle within `/please:implement`:

### Standard Task Lifecycle

1. **Select Task**: Choose the next available task from `plan.md`
2. **Mark In Progress**: Update task status from `[ ]` to `[~]`
3. **Write Failing Tests (Red Phase)**:
   - Create test file for the feature or bug fix
   - Write unit tests defining expected behavior
   - Run tests and confirm they fail as expected
4. **Implement to Pass Tests (Green Phase)**:
   - Write minimum code to make failing tests pass
   - Run test suite and confirm all tests pass
5. **Refactor (Optional)**:
   - Improve clarity, remove duplication, enhance performance
   - Rerun tests to ensure they still pass
6. **Verify Coverage**: Run coverage reports. Target: >80% for new code
7. **Document Deviations**: If implementation differs from tech stack, update `tech-stack.md` first
8. **Commit**: Stage and commit with conventional commit message (one commit per task)
9. **Update Progress**: Mark the task as completed in `## Progress` with a timestamp

### Phase Completion Protocol

Executed when all tasks in a phase are complete:

1. **Verify Test Coverage**: Identify all files changed in the phase, ensure test coverage
2. **Run Full Test Suite**: Execute `bun test`, debug failures (max 2 fix attempts)
3. **Run Eval Suite** (when scripts/lib changed): `bun run evals/spring/run.ts` and report pass-rate delta
4. **Manual Verification Plan**: Generate step-by-step verification instructions for the user
5. **User Confirmation**: Wait for explicit user approval before proceeding
6. **Create Checkpoint**: Commit with message `chore(checkpoint): complete phase {name}`
7. **Update Plan**: Mark phase as complete in `plan.md`

## Quality Gates

Before marking any task complete:

- [ ] All tests pass (`bun test`)
- [ ] Code coverage meets requirements (>80% project-wide; **≥90% line coverage for `scripts/lib/detect-*.ts`**, gated in CI via `bun run coverage:check`)
- [ ] No TypeScript errors (`bun run typecheck`)
- [ ] No linting errors (`bun run lint`)
- [ ] Library Layer files under `scripts/lib/` have no I/O imports (enforced by ESLint `no-restricted-imports` for `node:fs`, `node:fs/promises`, `node:net`, `node:http`, `node:https`, `bun`)
- [ ] Eval suite shows no pass-rate regression (when applicable)
- [ ] Documentation updated if needed (README, SKILL.md descriptions)

## Development Commands

### Setup

```bash
bun install
```

### Daily Development

```bash
# Run a script directly (no build step)
bun run scripts/fetch.ts framework 6.2.1 --output /tmp/spring-framework-6.2.1

# Symlink plugin into Claude Code for live testing
ln -sf "$(pwd)" ~/.claude/plugins/spring
```

### Testing

```bash
# Unit tests
bun test

# Watch mode (interactive)
bun test --watch

# Single file
bun test scripts/lib/antora-rules.test.ts

# Coverage report (text + lcov)
bun run test:coverage

# Library Layer coverage gate (≥ 90% line coverage)
bun run coverage:check
```

### Eval Suite

```bash
# Run full Spring task suite
bun run evals/spring/run.ts

# Single eval
bun run evals/spring/run.ts --case framework-bean-scopes

# Compare against baseline
bun run evals/spring/run.ts --baseline main
```

### Before Committing

```bash
bun run lint && bun run typecheck && bun test
```

Linting and formatting are unified through `@pleaseai/eslint-config` (no
Prettier). Use `bun run lint:fix` to auto-fix style issues. A pre-commit hook
(Husky + `lint-staged`) runs `eslint --fix` on staged files; the same checks
run in CI on every PR via `.github/workflows/ci.yml` (typecheck → lint → test).

### Building Prebuilt Archives

```bash
# Build a single archive locally
bun run scripts/build-archive.ts framework 6.2.1

# Verify catalog entry
cat prebuilt/catalog.json | jq '.["spring-framework-6.2.1"]'
```

## Testing Requirements

### Unit Testing

- Every module in `scripts/lib/` must have corresponding tests
- Antora conversion rules must have fixture-based tests against real Spring HTML
- Mock network calls (`fetch`) — never hit `docs.spring.io` from unit tests
- Test both success and failure cases (404, malformed XML, missing BOM property)

### Integration Testing

- End-to-end: `bun run scripts/install.ts` against a fixture project (mock build.gradle)
- Verify the generated `.claude/skills/spring-*/` matches expected layout
- Verify `CLAUDE.md` block insertion is idempotent and removable

### Eval Suite

- The flagship metric is "0 wrong-version errors" on the Spring task suite
- Changes to `scripts/lib/` must run evals and report delta in PR
- A regression in pass rate or wrong-version count blocks release

## Commit Guidelines

Follow the project's commit convention. See `Skill("standards:commit-convention")` for details.

### Types

- `feat`: New feature (e.g., new component support)
- `fix`: Bug fix (e.g., Antora rule edge case)
- `docs`: Documentation only (README, SKILL.md descriptions)
- `style`: Formatting changes
- `refactor`: Code change without behavior change
- `perf`: Performance improvements (e.g., conversion speed)
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (deps, CI config)

### Scope examples

- `feat(installer): support spring-cloud-gateway`
- `fix(antora): handle nested xref with attribute substitution`
- `docs(readme): update prebuilt coverage matrix`

## Definition of Done

A task is complete when:

1. All code implemented to specification
2. Unit tests written and passing
3. Code coverage meets project requirements (>80%)
4. TypeScript compiles with strict mode, no `any`
5. Eval suite has no regression (when applicable)
6. Progress updated in `plan.md`
7. Changes committed with proper conventional commit message
