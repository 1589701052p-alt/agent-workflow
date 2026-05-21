// RFC-054 W3-2 — perf regression detector.
//
// Compare two perf samples (baseline + current). For each named operation,
// fail if current.median is BOTH > baseline.median × 1.20 (20% regression)
// AND delta > 0.1 ms (absolute floor). The two-gate design prevents
// false positives on microbenchmarks where sub-ms jitter alone can drive
// a 50% ratio without indicating real slowdown.
//
// Run:
//   bun run tests/perf/run.ts --out /tmp/current.json
//   bun run tests/perf/diff.ts tests/perf/baseline.json /tmp/current.json
//
// CI wires this as the perf gate; the workflow either:
//   * (PR) runs the diff vs main's baseline.json and posts the table
//   * (main) refreshes baseline.json after green merge
//
// Exits 0 on clean (no regression), 1 on any regression. Stdout is the
// human-readable report (always printed); stderr carries the summary
// line for CI grep.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface SampleStats {
  median_ms: number
  p50_ms: number
  p95_ms: number
  iterations: number
}

interface PerfReport {
  schemaVersion: 1
  capturedAt: string
  platform: string
  runtime: string
  samples: Record<string, SampleStats>
}

const RATIO_THRESHOLD = 1.2 // 20% regression
const ABSOLUTE_FLOOR_MS = 0.1 // ignore microbench jitter under 0.1ms delta

interface RowResult {
  name: string
  baselineMs: number
  currentMs: number
  ratio: number
  deltaMs: number
  status: 'ok' | 'regression' | 'improvement' | 'missing-baseline' | 'missing-current'
}

function loadReport(path: string): PerfReport {
  const text = readFileSync(path, 'utf-8')
  return JSON.parse(text) as PerfReport
}

function diff(baseline: PerfReport, current: PerfReport): RowResult[] {
  const rows: RowResult[] = []
  const allNames = new Set<string>([
    ...Object.keys(baseline.samples),
    ...Object.keys(current.samples),
  ])
  for (const name of [...allNames].sort()) {
    const b = baseline.samples[name]
    const c = current.samples[name]
    if (b === undefined) {
      rows.push({
        name,
        baselineMs: 0,
        currentMs: c?.median_ms ?? 0,
        ratio: 0,
        deltaMs: 0,
        status: 'missing-baseline',
      })
      continue
    }
    if (c === undefined) {
      rows.push({
        name,
        baselineMs: b.median_ms,
        currentMs: 0,
        ratio: 0,
        deltaMs: 0,
        status: 'missing-current',
      })
      continue
    }
    const ratio = b.median_ms === 0 ? (c.median_ms === 0 ? 1 : Infinity) : c.median_ms / b.median_ms
    const deltaMs = c.median_ms - b.median_ms
    let status: RowResult['status']
    if (ratio >= RATIO_THRESHOLD && deltaMs >= ABSOLUTE_FLOOR_MS) {
      status = 'regression'
    } else if (ratio <= 0.8 && Math.abs(deltaMs) >= ABSOLUTE_FLOOR_MS) {
      status = 'improvement'
    } else {
      status = 'ok'
    }
    rows.push({
      name,
      baselineMs: b.median_ms,
      currentMs: c.median_ms,
      ratio: Math.round(ratio * 100) / 100,
      deltaMs: Math.round(deltaMs * 1000) / 1000,
      status,
    })
  }
  return rows
}

function statusGlyph(s: RowResult['status']): string {
  switch (s) {
    case 'ok':
      return '✓'
    case 'regression':
      return 'X'
    case 'improvement':
      return '+'
    case 'missing-baseline':
      return '?'
    case 'missing-current':
      return '!'
  }
}

function render(rows: RowResult[], baseline: PerfReport, current: PerfReport): string {
  const lines: string[] = []
  lines.push('perf diff:')
  lines.push(`  baseline: ${baseline.capturedAt} on ${baseline.platform} (${baseline.runtime})`)
  lines.push(`  current : ${current.capturedAt} on ${current.platform} (${current.runtime})`)
  lines.push('')
  const w = Math.max(20, ...rows.map((r) => r.name.length))
  lines.push(
    `  ${'name'.padEnd(w)}  ${'baseline'.padStart(10)}  ${'current'.padStart(10)}  ${'ratio'.padStart(7)}  ${'delta'.padStart(8)}  status`,
  )
  lines.push(
    `  ${'-'.repeat(w)}  ${'-'.repeat(10)}  ${'-'.repeat(10)}  ${'-'.repeat(7)}  ${'-'.repeat(8)}  ------`,
  )
  for (const r of rows) {
    const deltaStr = `${r.deltaMs > 0 ? '+' : ''}${r.deltaMs.toFixed(3)}ms`
    lines.push(
      `  ${r.name.padEnd(w)}  ${(r.baselineMs.toFixed(3) + 'ms').padStart(10)}  ${(r.currentMs.toFixed(3) + 'ms').padStart(10)}  ${(r.ratio.toFixed(2) + 'x').padStart(7)}  ${deltaStr.padStart(10)}  ${statusGlyph(r.status)} ${r.status}`,
    )
  }
  return lines.join('\n')
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length !== 2) {
    process.stderr.write('usage: bun run tests/perf/diff.ts <baseline.json> <current.json>\n')
    process.exit(2)
  }
  const baseline = loadReport(resolve(process.cwd(), args[0]!))
  const current = loadReport(resolve(process.cwd(), args[1]!))
  const rows = diff(baseline, current)
  const report = render(rows, baseline, current)
  process.stdout.write(report + '\n')

  const regressions = rows.filter((r) => r.status === 'regression')
  const missing = rows.filter(
    (r) => r.status === 'missing-baseline' || r.status === 'missing-current',
  )
  process.stderr.write(
    `\nPERF_SUMMARY regressions=${regressions.length} missing=${missing.length} total=${rows.length}\n`,
  )
  if (regressions.length > 0) {
    const pct = Math.round((RATIO_THRESHOLD - 1) * 100)
    process.stderr.write(
      `X ${regressions.length} perf regression(s) over ${pct}% threshold (absolute floor ${ABSOLUTE_FLOOR_MS}ms)\n`,
    )
    process.exit(1)
  }
  process.exit(0)
}

main()
