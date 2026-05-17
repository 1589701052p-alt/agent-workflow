# Agent Workflow

Local orchestration platform that drives multiple `opencode` CLI processes as
collaborating agents. Each agent runs in its own process with a small focused
context, so audit-style fan-out stays accurate as the diff grows.

The canonical workflow it supports is **Code → Audit → Fix**: snapshot the
repo, run a worker agent in a per-task `git worktree`, diff the result, fan it
out (per-file / per-N-files / per-directory) to parallel auditor agents, then
feed the audit back to one or more fixer agents.

---

## Requirements

| Tool         | Minimum version              | Why                                     |
| ------------ | ---------------------------- | --------------------------------------- |
| **opencode** | 1.14.0 (1.14.25 verified)    | Spawned as the agent subprocess         |
| **git**      | 2.5+                         | `git worktree`, snapshots, stash, diff  |
| **OS**       | macOS or Linux               | Windows is not supported in v1          |

`opencode` must be on `PATH` (or `opencodePath` set in `config.json`). The
daemon refuses to start otherwise.

---

## Install

Download the binary for your platform from
[Releases](https://github.com/wangbinquan/agent-workflow/releases) and mark it
executable:

```bash
# macOS (Apple Silicon)
curl -L -o agent-workflow \
  https://github.com/wangbinquan/agent-workflow/releases/latest/download/agent-workflow-macos-arm64
chmod +x agent-workflow

# Linux (x86_64)
curl -L -o agent-workflow \
  https://github.com/wangbinquan/agent-workflow/releases/latest/download/agent-workflow-linux-x86_64
chmod +x agent-workflow

# Linux (arm64)
curl -L -o agent-workflow \
  https://github.com/wangbinquan/agent-workflow/releases/latest/download/agent-workflow-linux-arm64
chmod +x agent-workflow
```

The binary is one ~60 MiB executable that bundles the Bun runtime, the
backend, the SPA, and the database migrations.

---

## Quick start

```bash
./agent-workflow start
# agent-workflow ready — open this URL in your browser:
#   http://127.0.0.1:51234/?token=…
```

Click the URL. The token in the query string authenticates you for the
session; it is also written to `~/.agent-workflow/token` (mode 0600).

From the UI:

1. **Agents** → New agent. Pick a name, set the model (or leave blank for
   `config.defaultModel`), declare the output ports the agent will emit.
2. **Skills** → New skill. Markdown body + frontmatter. Skills attached to an
   agent are copied into its per-run `OPENCODE_CONFIG_DIR/skills/`.
3. **Workflows** → New workflow. Drag agents from the left palette onto the
   canvas, connect output → input handles, optionally wrap a region in a
   `git` wrapper (records the diff) or a `loop` wrapper.
4. **Workflows → Launch task**. Pick a repo from the recent list (or paste a
   path), fill the workflow's launcher inputs, and Start.
5. **Tasks** → click a row to watch live node status, see the diff, jump to a
   node's prompt / events / output / stats.

All persistent state lives under `~/.agent-workflow/`:

```
~/.agent-workflow/
├── db.sqlite              # agents, skills, workflows, tasks, node_runs, events
├── config.json            # editable in Settings page
├── token                  # 64-char hex, mode 0600
├── skills/                # managed skills' SKILL.md + files
├── worktrees/<repo>/<id>/ # per-task git worktree
├── runs/<task>/<node>/    # per-process OPENCODE_CONFIG_DIR
├── logs/                  # daemon.log + archived event JSONL
└── backups/               # `agent-workflow backup` output
```

---

## CLI

```bash
agent-workflow start [--port N] [--host H]   # foreground daemon
agent-workflow stop                          # SIGTERM the running daemon
agent-workflow status                        # PID + /health snapshot
agent-workflow doctor                        # 6 health checks
agent-workflow config get [key]              # print config or one key
agent-workflow config set <key> <value>      # JSON-parsed value if possible
agent-workflow migrate                       # apply pending DB migrations
agent-workflow backup                        # tar.gz under ~/.agent-workflow/backups/
agent-workflow version
```

---

## Configuration

`~/.agent-workflow/config.json` is the source of truth. The Settings page edits
it via `PUT /api/config`. Fields marked **restart required** only apply on the
next `agent-workflow start`:

| Field                                  | Default       | Notes                                                  |
| -------------------------------------- | ------------- | ------------------------------------------------------ |
| `opencodePath`                         | (PATH lookup) | Override the opencode binary                           |
| `defaultModel`                         | —             | Used by agents without an explicit `model`             |
| `maxConcurrentNodes`                   | `4`           | Global node-execution semaphore                        |
| `multiProcessSubprocessConcurrency`    | `4`           | Per multi-process node sub-pool                        |
| `defaultPerNodeTimeoutMs`              | `1800000`     | 30 min; overridable per node                           |
| `defaultPerTaskMaxDurationMs`          | `3600000`     | 1 h; `0` = unlimited                                   |
| `defaultPerTaskMaxTotalTokens`         | `0`           | `0` = unlimited                                        |
| `worktreeAutoGc`                       | `{enabled:false}` | Hourly background sweep                              |
| `eventsArchiveThresholds`              | 50k / 1M      | Per-node-run / global event row caps                   |
| `bindHost`                             | `127.0.0.1`   | **restart required**                                   |
| `bindPort`                             | `0`           | `0` picks free port; **restart required**              |
| `theme`                                | `system`      | `system / light / dark`                                |
| `language`                             | `zh-CN`       | `zh-CN / en-US`                                        |
| `logLevel`                             | `info`        | `debug / info / warn / error`                          |

---

## Docs

- [`docs/architecture.md`](./docs/architecture.md) — process model + data flow
- [`docs/agent.md`](./docs/agent.md) — agent.md frontmatter reference
- [`docs/skill.md`](./docs/skill.md) — SKILL.md frontmatter + dir layout
- [`docs/workflow-yaml.md`](./docs/workflow-yaml.md) — workflow YAML schema
- [`docs/performance-notes.md`](./docs/performance-notes.md) — perf tuning + benchmarks
- [`docs/troubleshooting.md`](./docs/troubleshooting.md) — common issues

Designed-but-not-shipped detail lives in [`design/`](./design/):

- [`design/proposal.md`](./design/proposal.md) — product spec (Chinese)
- [`design/design.md`](./design/design.md) — technical design (Chinese)
- [`design/plan.md`](./design/plan.md) — 81-issue roadmap

---

## Building from source

```bash
# bun >= 1.3.0
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/wangbinquan/agent-workflow.git
cd agent-workflow
bun install
bun test                  # 534 backend cases
bun run --filter @agent-workflow/frontend test  # 682 frontend cases

# Dev: backend on a random port + vite dev server on :5174
bun dev

# Production single-binary (dist/agent-workflow-<platform>-<arch>)
bun run build:binary
```

---

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).

Copyright 2026 WangBinquan.
