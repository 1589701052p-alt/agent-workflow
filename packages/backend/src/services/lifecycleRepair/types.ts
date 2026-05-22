// RFC-057 — internal types shared by the repair engine + per-rule option
// modules. Kept separate from the main lifecycleRepair.ts entry to avoid
// a circular import cycle between the engine and the options-*.ts files.

import type { LifecycleAlertRule, RepairOptionMeta, RepairOutcome } from '@agent-workflow/shared'

import type { DbClient } from '@/db/client'
import type { StartTaskDeps } from '@/services/task'

export interface ParsedLifecycleAlert {
  id: string
  taskId: string
  rule: LifecycleAlertRule
  severity: 'warning' | 'error'
  detail: Record<string, unknown>
  detectedAt: number
  resolvedAt: number | null
}

export interface RepairTaskRow {
  id: string
  status: string
  workflowSnapshot: string
}

export interface RepairNodeRunRow {
  id: string
  nodeId: string
  status: string
  retryIndex: number
  reviewIteration: number
  clarifyIteration: number
  shardKey: string | null
  iteration: number
}

export interface RepairContext {
  readonly db: DbClient
  readonly alert: ParsedLifecycleAlert
  readonly task: RepairTaskRow
  readonly actorUserId: string | null
  readonly appHome: string
  readonly deps: StartTaskDeps
  readonly now: () => number
}

export interface PreflightResult {
  available: boolean
  unavailableReasonKey?: string
  previewSteps: string[]
  ctx: Record<string, unknown>
}

export interface ApplyResult {
  beforeSnapshot: Record<string, unknown>
  afterSnapshot: Record<string, unknown>
  /** If true, the engine calls `resumeTask` after the option's apply() returns. */
  resumeAfterApply?: boolean
}

export interface RepairOptionDef extends RepairOptionMeta {
  preflight: (rc: RepairContext) => Promise<PreflightResult>
  apply: (rc: RepairContext, preflight: PreflightResult) => Promise<ApplyResult>
}

export type { LifecycleAlertRule, RepairOutcome }
