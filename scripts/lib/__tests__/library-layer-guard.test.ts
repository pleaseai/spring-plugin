import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, test } from 'bun:test'

const ROOT = join(import.meta.dir, '..', '..', '..')
const ESLINT = join(ROOT, 'node_modules', '.bin', 'eslint')

async function lintStdin(filename: string, code: string): Promise<{ exit: number, stdout: string }> {
  // ESLint flat config uses --stdin + --stdin-filename to lint code from stdin
  // while letting file-pattern overrides match by the pretended filename.
  const proc = Bun.spawn(
    [ESLINT, '--stdin', '--stdin-filename', filename, '--no-warn-ignored'],
    {
      cwd: ROOT,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1' },
    },
  )
  proc.stdin.write(code)
  await proc.stdin.end()
  const stdout = await new Response(proc.stdout).text()
  const exit = await proc.exited
  return { exit, stdout }
}

describe('Library Layer ESLint guard (T008, AC-6, NFR-1)', () => {
  test('flags node:fs import in scripts/lib/*.ts', async () => {
    const { exit, stdout } = await lintStdin(
      'scripts/lib/__violation_fs.ts',
      `import { readFileSync } from 'node:fs'\nexport const x = readFileSync\n`,
    )
    expect(exit).not.toBe(0)
    expect(stdout).toMatch(/no-restricted-imports/)
    expect(stdout).toMatch(/Library Layer/i)
  })

  test('flags node:net import in scripts/lib/*.ts', async () => {
    const { exit, stdout } = await lintStdin(
      'scripts/lib/__violation_net.ts',
      `import * as net from 'node:net'\nexport const s = net\n`,
    )
    expect(exit).not.toBe(0)
    expect(stdout).toMatch(/no-restricted-imports/)
  })

  test('flags node:http import in scripts/lib/*.ts', async () => {
    const { exit, stdout } = await lintStdin(
      'scripts/lib/__violation_http.ts',
      `import * as http from 'node:http'\nexport const h = http\n`,
    )
    expect(exit).not.toBe(0)
    expect(stdout).toMatch(/no-restricted-imports/)
  })

  test('does NOT flag node:fs (the Library Layer rule) in scripts/lib/__tests__/*.ts (tests are exempt)', async () => {
    const { stdout } = await lintStdin(
      'scripts/lib/__tests__/__violation_fs_test.ts',
      `import { readFileSync } from 'node:fs'\n\nexport const x = readFileSync\n`,
    )
    // Other style rules may fire; only assert no Library Layer guard violation.
    expect(stdout).not.toMatch(/no-restricted-imports/)
  })

  test('does NOT flag node:fs (the Library Layer rule) in scripts/detect.ts (orchestrator may do I/O)', async () => {
    const { stdout } = await lintStdin(
      'scripts/__violation_orchestrator_check.ts',
      `import { readFileSync } from 'node:fs'\n\nexport const x = readFileSync\n`,
    )
    expect(stdout).not.toMatch(/no-restricted-imports/)
  })

  test('flags fs/promises subpath import in scripts/lib/*.ts', async () => {
    const { exit, stdout } = await lintStdin(
      'scripts/lib/__violation_fs_promises.ts',
      `import { readFile } from 'node:fs/promises'\nexport const x = readFile\n`,
    )
    expect(exit).not.toBe(0)
    expect(stdout).toMatch(/no-restricted-imports/)
  })
})
