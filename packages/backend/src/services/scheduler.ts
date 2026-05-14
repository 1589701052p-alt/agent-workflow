// DAG scheduler for one task. M1 supports a LINEAR subset of the workflow
// schema only:
//   - input nodes      (materialize launcher value as a virtual node_run)
//   - agent-single     (run via runNode)
//   - output nodes     (skipped at scheduling time; detail page reads them)
//
// Multi-process, wrappers (git/loop), and retries are explicitly rejected:
// the task fails with `workflow-unsupported-feature`. The full implementation
// lands in M3 (P-3-02, P-3-03) and M4 (P-4-01).
//
// Cycles are also rejected (cycles inside loop wrappers are only allowed when
// loop wrappers exist, which they don't in M1).

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, nodeRunOutputs, nodeRuns, skills, tasks } from '@/db/schema'
import { runNode, type ResolvedSkill, type RunResult } from '@/services/runner'
import { emitTaskStatus, getTask } from '@/services/task'
import { createLogger, type Logger } from '@/util/log'
import { Semaphore } from '@/util/semaphore'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

export interface RunTaskOptions {
  taskId: string
  db: DbClient
  appHome: string
  /** Override opencode binary command (tests inject mock-opencode). */
  opencodeCmd?: string[]
  log?: Logger
  /**
   * When aborted, any node currently running is SIGTERMed via runNode and the
   * task transitions to status=canceled. Subsequent nodes are not started.
   */
  signal?: AbortSignal
  /** Default per-node timeout in ms (from settings); node-level override wins. */
  defaultPerNodeTimeoutMs?: number
  /** Global concurrency limit for agent nodes within this task. Default 4. */
  maxConcurrentNodes?: number
}

/**
 * Drive one task from "pending" to a terminal status. Caller decides whether
 * to await this (tests) or fire-and-forget (HTTP route).
 */
export async function runTask(opts: RunTaskOptions): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = WorkflowDefinitionSchema.parse(raw)
  } catch (err) {
    await failTask(db, taskId, 'snapshot-invalid', (err as Error).message)
    return
  }

  // 3. Mark running.
  await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)

  // 4. Validate node kinds (M1 subset).
  for (const node of definition.nodes) {
    if (node.kind !== 'input' && node.kind !== 'agent-single' && node.kind !== 'output') {
      await failTask(
        db,
        taskId,
        `M1 does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported in M1`,
        node.id,
      )
      return
    }
  }

  // 5. Topological sort excluding output nodes (they're sinks for display).
  const order = topologicalOrder(definition, log)
  if (order === null) {
    await failTask(db, taskId, 'workflow has a cycle (M1 has no loop wrappers)', 'cycle detected')
    return
  }

  // 6. Walk nodes in order.
  //    Inputs persist as a virtual node_run with one output named 'out'.
  //    Agent-single nodes invoke the runner.
  //    Output nodes are skipped — task detail page reads their bindings.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  // 6. Run nodes level-parallel under semaphores (P-3-05):
  //    - global semaphore caps concurrent agent nodes (config: maxConcurrentNodes)
  //    - write semaphore (capacity 1) serializes non-readonly agents
  //    - input/output nodes bypass both
  //
  //    Each iteration pulls every node whose upstreams are all done and
  //    kicks them off in parallel. The batch settles before we look at
  //    failures or the abort signal, so an in-flight write isn't stranded.
  const globalSem = new Semaphore(opts.maxConcurrentNodes ?? 4)
  const writeSem = new Semaphore(1)
  const upstreamsOf = buildUpstreamMap(definition)
  const remaining = new Map(order.map((n) => [n.id, n]))
  const completed = new Set<string>()
  let halt: 'failed' | 'canceled' | null = null
  let haltDetail: { summary: string; message: string; nodeId?: string } | null = null

  while (remaining.size > 0 && halt === null) {
    if (opts.signal?.aborted === true) {
      halt = 'canceled'
      break
    }
    const ready: WorkflowNode[] = []
    for (const n of remaining.values()) {
      const ups = upstreamsOf.get(n.id) ?? []
      if (ups.every((u) => completed.has(u))) ready.push(n)
    }
    if (ready.length === 0) {
      // No progress possible — bug or schedule held by halted batch.
      halt = 'failed'
      haltDetail = { summary: 'scheduler stalled', message: 'no ready nodes' }
      break
    }
    for (const n of ready) remaining.delete(n.id)

    const results = await Promise.all(
      ready.map((node) =>
        runOneNode({
          node,
          definition,
          task,
          taskId,
          db,
          opts,
          inputsMap,
          globalSem,
          writeSem,
          log,
        }),
      ),
    )
    for (let i = 0; i < ready.length; i++) {
      const node = ready[i]!
      const r = results[i]!
      if (r.kind === 'ok') {
        completed.add(node.id)
        continue
      }
      if (halt === null) {
        halt = r.kind
        haltDetail = { summary: r.summary, message: r.message, nodeId: node.id }
      }
    }
  }

  if (halt === 'failed' && haltDetail !== null) {
    await failTask(db, taskId, haltDetail.summary, haltDetail.message, haltDetail.nodeId)
    return
  }
  if (halt === 'canceled') {
    await cancelTaskRow(db, taskId, haltDetail?.nodeId)
    return
  }

  // 7. All nodes done → task done.
  await db.update(tasks).set({ status: 'done', finishedAt: Date.now() }).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
  log.info('task done', { taskId })
}

async function emitStatus(db: DbClient, taskId: string): Promise<void> {
  const t = await getTask(db, taskId)
  if (t !== null) emitTaskStatus(t)
}

function broadcastNodeStatus(
  taskId: string,
  nodeRunId: string,
  nodeId: string,
  status:
    | 'pending'
    | 'running'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted'
    | 'skipped'
    | 'exhausted',
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'node.status',
    nodeRunId,
    nodeId,
    status,
  })
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: 'pending' | 'done',
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    startedAt: now,
    finishedAt: status === 'done' ? now : null,
  })
  return id
}

async function failTask(
  db: DbClient,
  taskId: string,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'failed',
    finishedAt: Date.now(),
    errorSummary,
    errorMessage,
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

async function cancelTaskRow(db: DbClient, taskId: string, failedNodeId?: string): Promise<void> {
  const set: Record<string, unknown> = {
    status: 'canceled',
    finishedAt: Date.now(),
    errorSummary: 'canceled by user',
    errorMessage: 'aborted by signal',
  }
  if (failedNodeId !== undefined) set.failedNodeId = failedNodeId
  await db.update(tasks).set(set).where(eq(tasks.id, taskId))
  await emitStatus(db, taskId)
}

async function loadAgent(db: DbClient, name: string): Promise<Agent | null> {
  const rows = await db.select().from(agents).where(eq(agents.name, name)).limit(1)
  const row = rows[0]
  if (!row) return null
  const out: Agent = {
    id: row.id,
    name: row.name,
    description: row.description,
    outputs: JSON.parse(row.outputs) as string[],
    readonly: row.readonly,
    permission: JSON.parse(row.permission) as Record<string, unknown>,
    skills: JSON.parse(row.skills) as string[],
    frontmatterExtra: JSON.parse(row.frontmatterExtra) as Record<string, unknown>,
    bodyMd: row.bodyMd,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
  if (row.model !== null) out.model = row.model
  if (row.variant !== null) out.variant = row.variant
  if (row.temperature !== null) out.temperature = row.temperature
  if (row.steps !== null) out.steps = row.steps
  if (row.maxSteps !== null) out.maxSteps = row.maxSteps
  return out
}

async function resolveSkills(
  db: DbClient,
  appHome: string,
  names: string[],
): Promise<ResolvedSkill[]> {
  const out: ResolvedSkill[] = []
  for (const name of names) {
    const rows = await db.select().from(skills).where(eq(skills.name, name)).limit(1)
    const row = rows[0]
    if (!row) {
      // Skill not in DB — assume it's a project skill that opencode will
      // discover via the worktree's .opencode/skills. No injection needed.
      out.push({ name, sourceKind: 'project' })
      continue
    }
    if (row.sourceKind === 'managed') {
      const skillPath = `${appHome}/${row.managedPath ?? `skills/${name}/files`}`
      out.push({ name, sourceKind: 'managed', sourcePath: skillPath })
    } else if (row.sourceKind === 'external' && row.externalPath !== null) {
      out.push({ name, sourceKind: 'external', sourcePath: row.externalPath })
    }
  }
  return out
}

/**
 * Look up upstream node_run outputs for each incoming edge targeting `nodeId`
 * and produce the resolved input map for the next runNode invocation.
 * Multiple edges → same target port → concatenated with a horizontal-rule
 * separator (per design/proposal.md §4.2.2).
 */
async function resolveUpstreamInputs(
  db: DbClient,
  taskId: string,
  edges: WorkflowEdge[],
  nodeId: string,
  log: Logger,
): Promise<Record<string, string>> {
  const grouped = new Map<string, string[]>()
  const incoming = edges.filter((e) => e.target.nodeId === nodeId)

  for (const edge of incoming) {
    // Find the node_run for the upstream node (M1: one run per node).
    const runRows = await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, edge.source.nodeId))
      .limit(1)
    const run = runRows.find((r) => r.taskId === taskId)
    if (!run) {
      log.warn('upstream node_run not found', { taskId, sourceNodeId: edge.source.nodeId })
      continue
    }
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, run.id))
    const port = outRows.find((o) => o.portName === edge.source.portName)
    const content = port?.content ?? ''
    const list = grouped.get(edge.target.portName) ?? []
    list.push(content)
    grouped.set(edge.target.portName, list)
  }

  const result: Record<string, string> = {}
  for (const [name, values] of grouped) {
    result[name] = values.length === 1 ? (values[0] ?? '') : values.join('\n\n---\n\n')
  }
  return result
}

/**
 * Kahn's algorithm. Returns null if the graph has a cycle (M1: only one
 * caller, which fails the task immediately).
 *
 * Excludes 'output' nodes from the order — they don't run; the detail
 * page reads them on demand.
 */
function topologicalOrder(def: WorkflowDefinition, _log: Logger): WorkflowNode[] | null {
  const nodes = def.nodes.filter((n) => n.kind !== 'output')
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const inDegree = new Map<string, number>()
  for (const n of nodes) inDegree.set(n.id, 0)
  for (const e of def.edges) {
    if (!nodeById.has(e.source.nodeId) || !nodeById.has(e.target.nodeId)) continue
    inDegree.set(e.target.nodeId, (inDegree.get(e.target.nodeId) ?? 0) + 1)
  }
  const queue: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }
  const out: WorkflowNode[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    const n = nodeById.get(id)
    if (n) out.push(n)
    for (const e of def.edges) {
      if (e.source.nodeId !== id) continue
      if (!nodeById.has(e.target.nodeId)) continue
      const next = (inDegree.get(e.target.nodeId) ?? 0) - 1
      inDegree.set(e.target.nodeId, next)
      if (next === 0) queue.push(e.target.nodeId)
    }
  }
  if (out.length !== nodes.length) return null // cycle
  return out
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

function pickNumber(node: WorkflowNode, key: string): number | undefined {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** nodeId → list of upstream nodeIds (deduped). */
function buildUpstreamMap(definition: WorkflowDefinition): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const n of definition.nodes) m.set(n.id, [])
  for (const e of definition.edges) {
    const list = m.get(e.target.nodeId)
    if (list === undefined) continue
    if (!list.includes(e.source.nodeId)) list.push(e.source.nodeId)
  }
  return m
}

interface OneNodeResult {
  kind: 'ok' | 'failed' | 'canceled'
  summary: string
  message: string
}

interface OneNodeContext {
  node: WorkflowNode
  definition: WorkflowDefinition
  task: typeof tasks.$inferSelect
  taskId: string
  db: DbClient
  opts: RunTaskOptions
  inputsMap: Record<string, string>
  globalSem: Semaphore
  writeSem: Semaphore
  log: Logger
}

async function runOneNode(ctx: OneNodeContext): Promise<OneNodeResult> {
  const { node, definition, task, taskId, db, opts, inputsMap, globalSem, writeSem, log } = ctx
  if (opts.signal?.aborted === true) {
    return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
  }
  if (node.kind === 'output') return { kind: 'ok', summary: '', message: '' }

  if (node.kind === 'input') {
    const inputKey = pickString(node, 'inputKey')
    if (inputKey === null) {
      return {
        kind: 'failed',
        summary: `input node ${node.id} missing inputKey`,
        message: 'invalid',
      }
    }
    const value = inputsMap[inputKey] ?? ''
    const nrId = await insertNodeRun(db, taskId, node.id, 'done')
    await db.insert(nodeRunOutputs).values({ nodeRunId: nrId, portName: 'out', content: value })
    broadcastNodeStatus(taskId, nrId, node.id, 'done')
    return { kind: 'ok', summary: '', message: '' }
  }

  // agent-single (multi-process lands in P-3-02).
  const agentName = pickString(node, 'agentName')
  if (agentName === null) {
    return {
      kind: 'failed',
      summary: `node ${node.id} missing agentName`,
      message: 'invalid agent-single node',
    }
  }
  const agent = await loadAgent(db, agentName)
  if (agent === null) {
    return { kind: 'failed', summary: `agent '${agentName}' not found`, message: 'agent-not-found' }
  }

  const upstreamInputs = await resolveUpstreamInputs(db, taskId, definition.edges, node.id, log)
  const resolvedSkills = await resolveSkills(db, opts.appHome, agent.skills)
  const promptTemplate = pickString(node, 'promptTemplate') ?? undefined
  const nodeTimeoutMs = pickNumber(node, 'timeoutMs') ?? opts.defaultPerNodeTimeoutMs

  const nodeRunId = await insertNodeRun(db, taskId, node.id, 'pending')
  broadcastNodeStatus(taskId, nodeRunId, node.id, 'pending')

  // Acquire semaphores. Order matters: global → write so a write node can't
  // hold the write slot while waiting for its global slot.
  const releaseGlobal = await globalSem.acquire()
  const releaseWrite = agent.readonly ? null : await writeSem.acquire()

  let result: RunResult
  try {
    result = await runNode({
      taskId,
      nodeRunId,
      agent,
      inputs: upstreamInputs,
      worktreePath: task.worktreePath,
      templateMeta: {
        repoPath: task.repoPath,
        baseBranch: task.baseBranch,
        taskId,
        nodeId: node.id,
      },
      ...(promptTemplate !== undefined ? { promptTemplate } : {}),
      ...(nodeTimeoutMs !== undefined ? { timeoutMs: nodeTimeoutMs } : {}),
      skills: resolvedSkills,
      appHome: opts.appHome,
      ...(opts.opencodeCmd ? { opencodeCmd: opts.opencodeCmd } : {}),
      db,
      log: log.child('run'),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (err) {
    releaseWrite?.()
    releaseGlobal()
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: 'failed', summary: `node ${node.id} threw: ${msg}`, message: msg }
  }
  releaseWrite?.()
  releaseGlobal()

  broadcastNodeStatus(taskId, nodeRunId, node.id, result.status)
  if (result.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: 'node canceled',
      message: result.errorMessage ?? 'canceled',
    }
  }
  if (result.status !== 'done') {
    return {
      kind: 'failed',
      summary: result.errorMessage ?? `node ${node.id} ${result.status}`,
      message: result.errorMessage ?? result.status,
    }
  }
  return { kind: 'ok', summary: '', message: '' }
}
