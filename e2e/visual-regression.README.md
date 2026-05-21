# visual-regression — pixel baselines for 8 key pages (RFC-054 W2-5)

Spec: `e2e/visual-regression.spec.ts`. Baselines: `e2e/visual-regression.spec.ts-snapshots/`.

## How the gate works

The spec is **opt-in** via `RUN_VISUAL_REGRESSION=1`. Default `bun run e2e`
skips it because:

- The first run on each platform needs to GENERATE baselines (and would
  fail without them).
- Font subpixel jitter between macOS and Linux means baselines are
  platform-specific. Playwright auto-suffixes snapshots
  (`*-chromium-darwin.png` vs `*-chromium-linux.png`), but a developer
  running locally is on a different platform than CI.

Threshold: `maxDiffPixelRatio: 0.002` (0.2%) per RFC-054 plan §risk 9.

## Pages covered

| Page         | Stable anchor                                  |
| ------------ | ---------------------------------------------- |
| `/auth`      | "Sign in" heading                              |
| `/agents`    | "Agents" heading                               |
| `/workflows` | "Workflows" heading                            |
| `/repos`     | "Repos"-ish heading (regex)                    |
| `/memory`    | "Memory"-ish heading                           |
| `/settings`  | "Settings"-ish heading                         |
| `/`          | networkidle (homepage shell is data-dependent) |
| `/tasks`     | "Tasks"-ish heading                            |

## Running locally (darwin baselines)

```sh
# 1. Build the daemon binary the spec spawns.
bun run build:binary

# 2. Generate (or refresh) darwin baselines.
RUN_VISUAL_REGRESSION=1 bun run e2e e2e/visual-regression.spec.ts --update-snapshots

# 3. Re-run against the committed baselines.
RUN_VISUAL_REGRESSION=1 bun run e2e e2e/visual-regression.spec.ts
```

Each PR that touches UI must run step 3 locally and confirm the diff
is zero (or commit refreshed baselines in the same PR).

## CI workflow

`.github/workflows/visual-regression-nightly.yml` (added in this PR) runs:

- **schedule** `0 9 * * *` UTC daily (15 min after git-protocols nightly).
- **workflow_dispatch** for ad-hoc verification after a UI change.
- **pull_request** when the diff touches `packages/frontend/**` or this
  spec / workflow itself.

The CI runs on **ubuntu-latest** and compares against the committed
`*-chromium-linux.png` baselines.

## Generating ubuntu baselines (first-time / refresh)

Two options:

### Option A — local Linux box (preferred)

If you have docker / VM access to a Linux environment:

```sh
docker run --rm -v "$PWD:/work" -w /work \
  mcr.microsoft.com/playwright:v1.50.0-jammy \
  bash -lc '
    bun install --frozen-lockfile &&
    bun run build:binary &&
    RUN_VISUAL_REGRESSION=1 bun run e2e e2e/visual-regression.spec.ts --update-snapshots
  '
```

Then commit the resulting `*-chromium-linux.png` files in a dedicated PR
titled e.g. `chore(visual): refresh ubuntu baselines after <topic>`.

### Option B — let CI do it via workflow_dispatch

1. Open a PR branch.
2. Trigger the nightly workflow with `workflow_dispatch` against the branch.
3. The first run fails (no `-chromium-linux.png` files yet).
4. Download the workflow's failure artifact, which contains the _actual_
   screenshots written by the failed run.
5. Copy those PNGs into `e2e/visual-regression.spec.ts-snapshots/` on
   the branch, commit, push.
6. Next workflow run is green.

This is the documented escape hatch in RFC-054 plan §risk 9: snapshot
update must be human-triggered, NEVER automatic on CI failure.

## What this gate does NOT cover

- Pages that depend on live data (e.g. a workflow editor with nodes
  laid out — node positions are data-driven and noisy).
- Hover / focus states (only the at-rest state is snapshotted).
- Dialogs / overlays (those land in a separate `keyboard-flows.spec.ts`).
- Mobile / small viewport — the 1280×800 baseline is desktop-only.

Adding a new page to the spec: snapshot 5× consecutive locally to
confirm zero pixel diff, then commit baseline. If the first run on
ubuntu CI shows >0.2% diff, anti-alias / font fallback differences are
the likely cause — start with `text-rendering: geometricPrecision` on
the problematic surface before considering raising the threshold.
