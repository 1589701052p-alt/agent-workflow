// RFC-120 — 任务问题清单 / 任务中心：纯函数 oracle。
//
// 这三个纯函数是「问题清单」的可断言核心，不碰 IO，被 backend service
// (`services/taskQuestions.ts`) 与前端清单共用：
//
//   * reconcileDesiredEntries — 一轮 clarify_round → 该轮应有的「承接条目」身份集合。
//     条目 = (问题 × 承接角色)。self→{self}；cross→{questioner}（恒有）∪
//     {designer | 该题 scope=designer 且轮已回答}。**未回答前不出 designer 条目**
//     （scope 是回答期的人工选择，答前未知；不能用 CLARIFY_QUESTION_SCOPE_DEFAULT
//     在创建时就臆造 designer 条目）。幂等：service 按唯一键 upsert、保人工覆盖层。
//
//   * deriveQuestionPhase — 条目的展示态（待处理/处理中/已处理待确认/完成/已关闭），
//     **派生**自来源轮 status + 人工确认覆盖层 + 承接 run 生命周期。执行三态不落库
//     （避免状态列漂移，契合本仓「不重算他处权威态」）。失败仍归「处理中」(D3)。
//     承接 run 由 service 的 `resolveHandlerRun` 按**精确 lineage**取（Codex F1，
//     非裸 freshest≥anchor）后传入——本函数只认「已解析的承接 run」。
//
//   * canReassign — 改派合法性。仅 designer（修订型）可改派，且目标须是工作流里
//     kind=agent 的节点（Codex F5——io/review/clarify/wrapper 无 prompt/产出契约）。
//
// 设计与决策见 design/RFC-120-task-question-list/{proposal,design}.md。

import type { ClarifyQuestion, ClarifyQuestionScope } from './schemas/clarify'
import { CLARIFY_QUESTION_SCOPE_DEFAULT } from './schemas/clarify'
import type { NodeRunStatus } from './schemas/task'

/** 承接角色：self=同节点反问的提问节点；questioner=跨节点反问者；designer=跨节点设计者。
 *  仅 designer 为「修订型」可改派；self/questioner 为「阻塞-产出型」恒自我续跑。 */
export type TaskQuestionRoleKind = 'self' | 'questioner' | 'designer'

export type TaskQuestionSourceKind = 'self' | 'cross'

/** 条目展示态（multica 式四态 + 已关闭终态）。 */
export type TaskQuestionPhase =
  | 'pending' // 待处理：未答 / 已答但承接 run 未起跑
  | 'processing' // 处理中：承接 run running / failed（失败仍处理中，D3）
  | 'awaiting_confirm' // 已处理待确认：承接 run done 且有产出
  | 'done' // 完成：人工确认关闭
  | 'closed' // 已关闭：来源反问轮被取消 / 放弃

/** 来源反问轮的状态（`clarify_rounds.status`）。 */
export type TaskQuestionRoundStatus = 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'

/** 人工确认覆盖层。 */
export type TaskQuestionConfirmation = 'open' | 'confirmed'

/** 一个「应存在的」承接条目身份（reconcile 的输出；service 据此 upsert）。 */
export interface DesiredTaskQuestionEntry {
  questionId: string
  questionTitle: string
  sourceKind: TaskQuestionSourceKind
  roleKind: TaskQuestionRoleKind
  /** 图解析的默认承接节点；解析不到（边缺失/畸形）为 null。落库 default_target_node_id。 */
  defaultTargetNodeId: string | null
}

export interface ReconcileRoundInput {
  kind: TaskQuestionSourceKind
  /** 本轮问题（只需 id/title；其余字段 reconcile 不关心）。 */
  questions: Pick<ClarifyQuestion, 'id' | 'title'>[]
  /** 轮是否已回答。**false 时（未答 / 取消 / 放弃）cross 只出 questioner 条目**
   *  ——scope 是回答期人工选择，答前未知，不能臆造 designer 条目。 */
  roundAnswered: boolean
  /** RFC-059 逐题 scope（仅 answered 时有意义）；缺省题 → CLARIFY_QUESTION_SCOPE_DEFAULT。 */
  scopes: Record<string, ClarifyQuestionScope>
  /** 冻结工作流图解析出的角色节点 id（解析不到为 null）。 */
  graph: {
    askingNodeId: string | null // self：提问节点
    questionerNodeId: string | null // cross：反问者
    designerNodeId: string | null // cross：图设计者（默认承接，可被 override 改派）
  }
}

/** 一轮 clarify_round → 该轮应有的承接条目身份集合（确定、幂等）。 */
export function reconcileDesiredEntries(input: ReconcileRoundInput): DesiredTaskQuestionEntry[] {
  const out: DesiredTaskQuestionEntry[] = []
  for (const q of input.questions) {
    if (input.kind === 'self') {
      // self：恒一条「提问节点」承接条目（阻塞-产出型，不可改派）。
      out.push({
        questionId: q.id,
        questionTitle: q.title,
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: input.graph.askingNodeId,
      })
      continue
    }
    // cross：反问者条目恒有（永远自我续跑，与 scope 无关）。
    out.push({
      questionId: q.id,
      questionTitle: q.title,
      sourceKind: 'cross',
      roleKind: 'questioner',
      defaultTargetNodeId: input.graph.questionerNodeId,
    })
    // designer 条目：仅当轮已回答 + 该题 scope=designer 才出（答前 scope 未知）。
    if (input.roundAnswered) {
      const scope = input.scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
      if (scope === 'designer') {
        out.push({
          questionId: q.id,
          questionTitle: q.title,
          sourceKind: 'cross',
          roleKind: 'designer',
          defaultTargetNodeId: input.graph.designerNodeId,
        })
      }
    }
  }
  return out
}

/** service 解析后传入的「承接 run」最小视图（精确 lineage 取出后的那一条）。 */
export interface HandlerRunView {
  status: NodeRunStatus
  /** mark-running 时置；null = 仍 pending（已 mint 未起跑）。 */
  startedAt: number | null
  /** 是否已落 node_run_outputs（成功产出的权威信号，同 runner「有输出行=成功」口径）。 */
  hasOutput: boolean
}

export interface DeriveQuestionPhaseInput {
  roundStatus: TaskQuestionRoundStatus
  confirmation: TaskQuestionConfirmation
  /** 本条目的承接 run（service `resolveHandlerRun` 按精确 lineage 取；null=未派发）。 */
  handlerRun: HandlerRunView | null
}

/** 条目展示态派生（纯）。失败仍归「处理中」(D3)。 */
export function deriveQuestionPhase(input: DeriveQuestionPhaseInput): TaskQuestionPhase {
  // 来源反问轮被取消/放弃 → 已关闭（withdrawn，无需确认）。
  if (input.roundStatus === 'canceled' || input.roundStatus === 'abandoned') {
    return 'closed'
  }
  // 人工已确认 → 完成。
  if (input.confirmation === 'confirmed') {
    return 'done'
  }
  const run = input.handlerRun
  // 未派发承接 run，或已 mint 但未起跑（pending，无 startedAt）→ 待处理。
  if (run === null || run.startedAt === null) {
    return 'pending'
  }
  // 承接 run 成功 done 且有产出 → 已处理待确认。
  if (run.status === 'done' && run.hasOutput) {
    return 'awaiting_confirm'
  }
  // 其余（running / failed / done-without-output 兜底）→ 处理中。失败不单立态。
  return 'processing'
}

/** 改派合法性：仅 designer 条目、且目标是工作流 agent 节点（Codex F5）。 */
export function canReassign(
  entry: { roleKind: TaskQuestionRoleKind },
  targetNodeId: string,
  agentNodeIds: ReadonlySet<string>,
): boolean {
  return entry.roleKind === 'designer' && agentNodeIds.has(targetNodeId)
}
