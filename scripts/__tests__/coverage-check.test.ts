import { describe, expect, test } from 'bun:test'

import { checkCoverage, parseLcov } from '../coverage-check.ts'

const SAMPLE_LCOV = `TN:
SF:scripts/detect.ts
FNF:5
FNH:3
LF:68
LH:43
end_of_record
TN:
SF:scripts/lib/detect-gradle.ts
LF:100
LH:95
end_of_record
TN:
SF:scripts/lib/detect-maven.ts
LF:100
LH:97
end_of_record
TN:
SF:scripts/lib/detect-types.ts
LF:5
LH:5
end_of_record
TN:
SF:scripts/lib/detect-low.ts
LF:100
LH:80
end_of_record
`

describe('parseLcov', () => {
  test('extracts SF / LF / LH triples per record', () => {
    const records = parseLcov(SAMPLE_LCOV)
    expect(records).toHaveLength(5)
    const gradle = records.find(r => r.file === 'scripts/lib/detect-gradle.ts')
    expect(gradle?.linesFound).toBe(100)
    expect(gradle?.linesHit).toBe(95)
    expect(gradle?.ratio).toBeCloseTo(0.95)
  })

  test('treats LF=0 as 100% (no executable lines)', () => {
    const lcov = 'SF:foo.ts\nLF:0\nLH:0\nend_of_record\n'
    const [r] = parseLcov(lcov)
    expect(r?.ratio).toBe(1)
  })

  test('ignores incomplete records (no end_of_record)', () => {
    const lcov = 'SF:partial.ts\nLF:10\nLH:5\n'
    expect(parseLcov(lcov)).toEqual([])
  })
})

describe('checkCoverage', () => {
  test('default pattern matches scripts/lib/detect-*.ts only', () => {
    const records = parseLcov(SAMPLE_LCOV)
    const { files } = checkCoverage(records)
    const names = files.map(f => f.file).sort()
    expect(names).toEqual([
      'scripts/lib/detect-gradle.ts',
      'scripts/lib/detect-low.ts',
      'scripts/lib/detect-maven.ts',
      'scripts/lib/detect-types.ts',
    ])
  })

  test('flags files below the 90% default threshold', () => {
    const records = parseLcov(SAMPLE_LCOV)
    const { failures, threshold } = checkCoverage(records)
    expect(threshold).toBe(0.9)
    expect(failures.map(f => f.file)).toEqual(['scripts/lib/detect-low.ts'])
  })

  test('respects custom threshold', () => {
    const records = parseLcov(SAMPLE_LCOV)
    const { failures } = checkCoverage(records, { threshold: 0.96 })
    expect(failures.map(f => f.file).sort()).toEqual([
      'scripts/lib/detect-gradle.ts',
      'scripts/lib/detect-low.ts',
    ])
  })

  test('respects custom pattern', () => {
    const records = parseLcov(SAMPLE_LCOV)
    const { files } = checkCoverage(records, { pattern: /^scripts\/detect\.ts$/ })
    expect(files.map(f => f.file)).toEqual(['scripts/detect.ts'])
  })

  test('passes when no files match (empty file list — caller decides what to do)', () => {
    const records = parseLcov(SAMPLE_LCOV)
    const { files, failures } = checkCoverage(records, { pattern: /nope/ })
    expect(files).toEqual([])
    expect(failures).toEqual([])
  })
})
