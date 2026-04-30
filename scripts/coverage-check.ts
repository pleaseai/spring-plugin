/**
 * Coverage threshold check for the Library Layer (T009 / NFR-4).
 *
 * Reads `coverage/lcov.info` produced by `bun test --coverage --coverage-reporter=lcov`
 * and fails CI when line coverage of any `scripts/lib/detect-*.ts` file falls below
 * the configured threshold.
 *
 * Bun's lcov output does not currently emit branch metadata (BRF/BRH/BRDA), so this
 * gate uses **line** coverage as the practical proxy for the spec's "≥ 90% branch
 * coverage" requirement. See plan.md Surprises & Discoveries for the gap log.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const DEFAULT_LCOV = join(process.cwd(), 'coverage', 'lcov.info')
const DEFAULT_THRESHOLD = 0.9
const DEFAULT_PATTERN = /^scripts\/lib\/detect-.*\.ts$/
const LINE_BREAK_RE = /\r?\n/

export interface FileCoverage {
  file: string
  linesFound: number
  linesHit: number
  ratio: number
}

export interface CoverageCheckResult {
  files: FileCoverage[]
  failures: FileCoverage[]
  threshold: number
}

/**
 * Parse an lcov.info file into per-source-file line coverage records.
 */
export function parseLcov(content: string): FileCoverage[] {
  const records: FileCoverage[] = []
  let currentFile: string | undefined
  let lf = 0
  let lh = 0

  for (const line of content.split(LINE_BREAK_RE)) {
    if (line.startsWith('SF:')) {
      currentFile = line.slice(3).trim()
      lf = 0
      lh = 0
    }
    else if (line.startsWith('LF:') && currentFile) {
      lf = Number.parseInt(line.slice(3), 10)
    }
    else if (line.startsWith('LH:') && currentFile) {
      lh = Number.parseInt(line.slice(3), 10)
    }
    else if (line === 'end_of_record' && currentFile) {
      records.push({
        file: currentFile,
        linesFound: lf,
        linesHit: lh,
        ratio: lf === 0 ? 1 : lh / lf,
      })
      currentFile = undefined
      lf = 0
      lh = 0
    }
  }
  return records
}

export function checkCoverage(
  records: FileCoverage[],
  options: { pattern?: RegExp, threshold?: number } = {},
): CoverageCheckResult {
  const pattern = options.pattern ?? DEFAULT_PATTERN
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const files = records.filter(r => pattern.test(r.file))
  const failures = files.filter(r => r.ratio < threshold)
  return { files, failures, threshold }
}

function format(ratio: number): string {
  return `${(ratio * 100).toFixed(2)}%`
}

async function main(): Promise<number> {
  const lcovPath = process.env.COVERAGE_LCOV ?? DEFAULT_LCOV
  if (!existsSync(lcovPath)) {
    process.stderr.write(`coverage report not found at ${lcovPath}; run 'bun test --coverage --coverage-reporter=lcov' first\n`)
    return 2
  }
  const content = readFileSync(lcovPath, 'utf8')
  const records = parseLcov(content)
  const { files, failures, threshold } = checkCoverage(records)

  if (files.length === 0) {
    process.stderr.write(`no scripts/lib/detect-*.ts files found in ${lcovPath}\n`)
    return 1
  }

  process.stdout.write(`Library Layer coverage gate (≥ ${format(threshold)} line coverage)\n`)
  for (const f of files) {
    const status = f.ratio >= threshold ? 'OK' : 'FAIL'
    process.stdout.write(`  [${status}] ${f.file}: ${format(f.ratio)} (${f.linesHit}/${f.linesFound} lines)\n`)
  }

  if (failures.length > 0) {
    process.stderr.write(`\n❌ ${failures.length} file(s) below ${format(threshold)} threshold:\n`)
    for (const f of failures) {
      process.stderr.write(`   - ${f.file}: ${format(f.ratio)}\n`)
    }
    return 1
  }
  process.stdout.write(`\n✅ All Library Layer files meet the ${format(threshold)} threshold.\n`)
  return 0
}

if (import.meta.main) {
  const code = await main()
  process.exit(code)
}
