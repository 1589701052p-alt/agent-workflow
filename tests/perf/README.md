# tests/perf — microbench baseline + regression gate (RFC-054 W3-2)

Two scripts and one committed JSON file form the perf gate:

| File            | Role                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`        | Times 5 hot-path operations 200-1000 iterations each, emits a JSON sample report (stdout or `--out file`).                             |
| `diff.ts`       | Compares two reports. Fails (exit 1) on any operation that regressed by ≥ 20% AND ≥ 0.1ms absolute delta. Two-gate to suppress jitter. |
| `baseline.json` | The committed reference report. CI compares each PR against this file.                                                                 |

## What gets benchmarked

The 5 microbenchmarks are deliberately tight and self-contained — no
subprocess spawn, no disk write past mem-fs migrations, no network.
Variance shot-to-shot is well under the 20% gate so the signal is
trustworthy.

| Name                         | Hot path                                                         |
| ---------------------------- | ---------------------------------------------------------------- |
| `workflow-parse-v3`          | `WorkflowDefinitionSchema.safeParse(complex_v3_workflow)` × 200  |
| `envelope-extract-and-parse` | `extractLastEnvelope → detectEnvelopeKind → parseEnvelope` × 200 |
| `secret-redact-long-text`    | `redactSensitiveString(multi-secret stderr blob)` × 500          |
| `safe-join-clean-path`       | `safeJoin(root, 'sub/dir/file.txt')` × 1000                      |
| `safe-join-traversal-reject` | `safeJoin(root, '../../etc/passwd')` (must throw) × 1000         |

End-to-end perf (concurrent task runs, HTTP latency, SQLite under load)
lives in `packages/backend/scripts/perf-sweep.ts` (P-5-12). That sweep
runs on a release cadence; this microbench gate runs per-PR.

## Local workflow

```sh
# Run a perf sweep, write JSON to /tmp:
bun run tests/perf/run.ts --out /tmp/current.json

# Compare against committed baseline:
bun run tests/perf/diff.ts tests/perf/baseline.json /tmp/current.json
# exit 0 = clean, exit 1 = regression
```

If your local diff reports a regression that you BELIEVE is jitter (not
a real change in the code being modified), re-run 3-5 times. Genuine
regressions reproduce; jitter doesn't. The gate's `delta ≥ 0.1ms` floor
already filters out sub-100µs noise on these operations, but cold
machines can still flap.

## Refreshing the baseline

Baseline refresh is a deliberate, separate PR:

```sh
bun run tests/perf/run.ts --out tests/perf/baseline.json
git add tests/perf/baseline.json
git commit -m 'perf: refresh baseline (median improvements <topic>)'
```

Don't refresh in the same PR as a code change — that hides the
improvement / regression signal under a single diff. The CI gate is
specifically designed to surface deltas before they're committed.

Refresh cadence (recommended): after a known perf-targeted PR lands
green, or on a quarterly cadence to absorb runtime-version / toolchain
drift. NEVER refresh to silence a regression you can't explain.

## Schema versioning

`baseline.json.schemaVersion` is currently `1`. If the report shape
grows (e.g. adding RSS-delta or rate-of-work fields), bump to `2` and
update both `run.ts` (emit shape) and `diff.ts` (compare shape) atomically.
The diff tool intentionally has no migration / forward-compat: better
to break loudly than to silently miss a regression because the field
names rotated.

## CI wiring

`.github/workflows/ci.yml` adds a `perf` job that:

1. Spawns a fresh ubuntu-latest runner.
2. Runs `bun run tests/perf/run.ts --out /tmp/current.json`.
3. Runs `bun run tests/perf/diff.ts tests/perf/baseline.json /tmp/current.json`.
4. Job fails (exit 1) on any regression.

The job is ubuntu-only — macOS GitHub runners have higher shot-to-shot
variance and would flap the gate. ubuntu-latest is the canonical
reference platform for this gate. Cross-platform perf parity is checked
manually via `perf-sweep.ts` on release.

## Why not Benchmark.js / mitata / tinybench?

External benchmark libraries add a dependency and tend to inline their
own warmup / outlier rejection that's harder to reason about. Five
microbenchmarks at this scale don't need a framework — the 25 lines in
`run.ts` (`bench()` helper + median/p95) are auditable in one screen.
If the suite grows past ~15 operations, revisit.
