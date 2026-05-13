# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repo is in the **design / pre-implementation stage**. It currently contains:

- `proposal/init.md` — the original product proposal (written in **Chinese**, raw form).
- `design/proposal.md` — **supplemented proposal** (产品规格定稿). Refines `proposal/init.md` after multi-round Q&A with the author. **This is the authoritative product spec going forward**; `proposal/init.md` is preserved for history.
- `design/design.md` — **technical design** (技术设计). Architecture, data model, API surface, execution engine, runtime, file layout, roadmap.
- `design/plan.md` — **implementation plan** (实施计划). Breaks down the M0–M5 roadmap into 81 numbered issues (P-{milestone}-{seq}) with deps, files, sizes, and acceptance criteria. Pick from this when starting work.
- No source code, no package manifest, no build/lint/test toolchain yet. There are no commands to run.

When the design docs and `proposal/init.md` disagree, `design/*.md` wins (they were written to clarify and resolve open questions in the original).

When asked to implement features: read `design/proposal.md` first for product intent, `design/design.md` for technical detail, then confirm scope with the user before generating code or scaffolding.

## Product vision (from `proposal/init.md`)

The goal is an **orchestration platform that drives multiple `opencode` CLI processes as collaborating agents**, instead of using opencode's built-in subagents. The motivation: when many subagents (especially audit-style ones) run inside a single opencode session, the parent session's context grows uncontrollably and model accuracy degrades. By moving inter-agent message passing into a deterministic, framework-level pipeline, each agent process keeps a small, focused context.

The canonical workflow it must support is **Code → Audit → Fix**:

1. The framework snapshots the working repo's git commit ID, runs a worker agent (an opencode process) in that repo, then snapshots the commit ID again. The diff between the two snapshots — including uncommitted changes — is the worker's structured output.
2. That diff is fed into one or more auditor agents. The framework may shard the diff (per-file, N-files-per-shard, etc.) and fan out to parallel auditor processes, each producing its own audit result.
3. Audit results are aggregated (or sharded again) and fed into fixer agents using the same fan-out pattern.

This pattern — record-state → run-agents → diff/aggregate → fan-out — is the core abstraction; specific workflows are user-defined compositions of it.

## Architecture concepts the platform must implement

(Below is a summary; for full detail read `design/proposal.md` and `design/design.md`.)

- **Agent management** — virtual agent names. **DB is source of truth** (frontmatter fields + body markdown stored in DB columns). Per-run injection via `OPENCODE_CONFIG_CONTENT` inline JSON (highest precedence in opencode merge order).
- **Skill management** — file system is source of truth (whole skill dir under `~/.agent-workflow/skills/{name}/files/`). DB only indexes name → path. Per-run injection: `managed` skill copyDir into `OPENCODE_CONFIG_DIR/skills/{name}/`, `external` skill symlink, repo-local `.opencode/skills/` left for opencode self-discovery.
- **Runtime management** — local opencode binary discovered via PATH (settings can override absolute path). Daemon probes version on startup; refuses to start below documented minimum.
- **Workflow management** — DB-stored definition (with `$schema_version`, version auto-increment on PUT). YAML import/export with conflict resolution dialog.
- **Workflow editor** — xyflow v12 Dify-style canvas with nodes / edges / wrappers (git, loop). Side bar lists agents (drag to create), wrappers, IO nodes. Right drawer with Edit/Preview tabs. Auto-save (debounce 1s). Multi-tab sync via `/ws/workflows`.
- **Node model** — each node references one agent, plus per-node prompt template (supports `{{port_name}}` + `{{__repo_path__}}` etc.), per-node overrides (model/variant/temperature/retries/timeout). single ↔ multi-process togglable. `readonly` always inherited from agent (not overridable).
- **Output XML envelope** — `<workflow-output><port name="...">...</port></workflow-output>`. Agent declares `outputs: [...]` in frontmatter; framework appends an English protocol block to user prompt to instruct format. Last envelope in stdout wins.
- **Multi-process node** — declares `sourcePort` (typically a git wrapper's `git_diff`). Built-in shardings: per-file / per-N-files / per-directory. Renames = 1 shard; binary files skipped (note appended); empty diff = direct done. Aggregation by shard_key dictionary order. Auto `errors` port on parent.
- **Git wrapper** — no inputs, single output `git_diff` (snapshots commit + worktree before first inner node, after last; composes diff incl. untracked).
- **Loop wrapper** — `max_iterations` + `exit_condition` (port-empty / port-equals / port-count-lt). v1 has **no cross-iteration feedback ports**; cross-iter state is via worktree files only. Wrappers nest arbitrarily; `git in loop` = per-iter diff (last-iter wins as output); `loop in git` = full-loop total diff.
- **Process isolation** — see "Resolved open questions" below.
- **Task lifecycle** — worktree per task at `~/.agent-workflow/worktrees/{repo-slug}/{task-id}`. Base branch chosen at launch time (default repo HEAD). Status states: `pending / running / done / failed / canceled / interrupted (daemon restart) / exhausted (loop max)`. Cancel keeps worktree; resume rolls each retried node back to its `pre_snapshot` (git stash hash); single-node retry cascades downstream by default. Retries produce independent `node_runs` keyed by `retry_index`.
- **Daemon** — single Bun process, flock single-instance lock, graceful shutdown 30s, hourly background tasks (events archival, optional worktree GC, resource-limit check at 1Hz).
- **Tech stack** — backend: Bun + Hono + Drizzle + bun:sqlite (WAL/NORMAL) + ULID. Frontend: Vite + React 19 + TanStack Router/Query + xyflow v12 + shadcn (Base UI) + i18next. Distribution: `bun build` single binary, GitHub Releases (macOS + Linux).

## Resolved open questions

The original proposal flagged several open questions; the supplemented design docs resolve them:

- **Concurrent injection conflict** (`.opencode/agents/`, `.opencode/skills/` collisions across opencode processes) — solved with **two** opencode env vars and **no** `OPENCODE_DISABLE_*` flags:
  - `OPENCODE_CONFIG_CONTENT` — inline JSON of the agent definition. opencode merges this AFTER all directory scans (config.ts:641), so the platform's agent always wins, even against same-name agents in repo `.opencode/` or `~/.opencode/`.
  - `OPENCODE_CONFIG_DIR=~/.agent-workflow/runs/{task}/{node}/.opencode/` — per-process private dir for platform-managed skills.
  - Crucially, repo-local `.opencode/skills/` (business skills the user wants the agent to use) and `~/.opencode/` (auth baseline) and `~/.claude/skills` etc. all continue to load normally. cwd remains the user's worktree so git diff works naturally.
- **Same-task concurrent writers** — `agent.md` carries `readonly: true/false`; framework serializes writes within a task and parallelizes only readonly nodes.
- **Same-repo cross-task collisions** — every task gets its own `git worktree add` under `~/.agent-workflow/worktrees/{repo-slug}/{task-id}` and runs all its opencode children with that as cwd.

Re-validate against opencode source in `/Users/wangbinquan/Documents/code/opencode` before changing any of these mechanisms.

## Reference repositories on this machine

The proposal directs Claude to consult these when designing or making technical decisions:

- `/Users/wangbinquan/Documents/code/multica` — an existing multi-agent orchestration framework. The proposal states it already implements **agent management, skill management, runtime management, and task management**, so prefer reading and borrowing patterns from it over reinventing them. (It is a pnpm/turbo monorepo with `apps/`, `packages/`, `server/`, Docker assets, and its own `CLAUDE.md` and `AGENTS.md` worth reading first.)
- `/Users/wangbinquan/Documents/code/opencode` — the opencode source. Read this directly to answer any question about how an opencode process is launched, how it loads `.opencode/agents` and `.opencode/skills`, and what its standardized agent output XML looks like. (Bun-based monorepo.)

When the proposal and these repos disagree, the repos are authoritative for runtime behavior; the proposal is authoritative for product intent.
