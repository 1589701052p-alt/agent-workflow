// RFC-060 PR-A — parametric OutputKindHandler 注册表骨架。
//
// 把 RFC-049 的 `OutputKindHandler<K extends AgentOutputKind>`（按字面值 kind
// 绑定的 handler）泛化为按 `ParsedKind` 谓词分派的 handler。
//
// PR-A 阶段：这是一个 **sibling 注册表**——`PARAMETRIC_HANDLERS` 与现有
// `HANDLERS` Record 并存，不接现有 runtime；getHandlerForParsedKind 仅供
// 新 wrapper-fanout 相关代码（待 PR-C / PR-D）调用。现有 envelope.ts /
// review.ts 仍走 `getOutputKindHandler(kind: AgentOutputKind)`。
//
// PR-D：切换 runtime 调用方为 parseKind + getHandlerForParsedKind；同步
// 删除 markdownFile.ts、把现有 HANDLERS Record 替换为本注册表。
//
// 设计要点：
//   - 每个 handler 通过 `matches(parsed)` 自报负责的 ParsedKind 子集。
//     PathHandler 接 `parsed.kind === 'path'`（任意 ext，含 path<*>）；
//     ListHandler 接 list；SignalHandler 接 base name 'signal'；
//     StringHandler 接 base 'string'；MarkdownHandler 接 base 'markdown'。
//   - 注册顺序决定派发优先级；getHandlerForParsedKind 第一个 matches 命中为准。
//   - subReasons 跨 handler 唯一性继续锁住（与 RFC-049 同款 invariant）；
//     模块加载期 throw 让 PR 永远不能合入冲突命名。

import { stringifyKind, type ParsedKind } from '../kindParser'
import type { ValidateIO, ValidateResult } from './types'

export interface ParametricValidateCtx {
  /** Port name (matches envelope `<port name=…>` attribute). */
  port: string
  /** Parsed kind of the port — handler may read `ext` / `item` etc. */
  kind: ParsedKind
  /** Absolute worktree root. Caller has already ensured it exists. */
  worktreePath: string
}

export interface ParametricKindFailure {
  port: string
  kind: ParsedKind
  /** Handler-internal flat short-code (e.g. 'missing-file'). */
  subReason: string
  detail?: string
}

export interface ParametricOutputKindHandler {
  /** Human-readable name for logs / errors (e.g. 'path' / 'list' / 'signal'). */
  readonly displayName: string
  /** subReasons owned by this handler — used at module load to assert no
   *  cross-handler collision inside this registry. */
  readonly subReasons: ReadonlySet<string>
  /** Returns true if this handler should serve the given ParsedKind. */
  matches(parsed: ParsedKind): boolean
  /** First-turn prompt guidance. Receives the ports declared with this
   *  handler + their full ParsedKind context so a list handler can decide
   *  guidance based on item kind. Return null to skip. */
  buildPromptGuidance(input: {
    ports: readonly string[]
    portKinds: ReadonlyMap<string, ParsedKind>
  }): string | null
  /** Validate one port's raw content. Same contract as RFC-049 ValidateResult. */
  validate(rawContent: string, ctx: ParametricValidateCtx, io: ValidateIO): ValidateResult
  /** Followup repair-prompt segment for failed ports of this handler.
   *  Same contract as RFC-049 buildRepairBlock; return null to skip. */
  buildRepairBlock(input: {
    failures: readonly ParametricKindFailure[]
    ports: readonly string[]
  }): string | null
}

// -----------------------------------------------------------------------------
// Registration. PR-A registers 5 handlers (string, markdown, path, list,
// signal). Order matters: more specific predicates first so a future
// composite kind doesn't accidentally route to a generic fallback.
// -----------------------------------------------------------------------------

import stringHandler from './stringParametric'
import markdownHandler from './markdownParametric'
import pathHandler from './path'
import listHandler from './list'
import signalHandler from './signal'

export const PARAMETRIC_HANDLERS: readonly ParametricOutputKindHandler[] = Object.freeze([
  stringHandler,
  markdownHandler,
  pathHandler,
  listHandler,
  signalHandler,
])

export function getHandlerForParsedKind(parsed: ParsedKind): ParametricOutputKindHandler {
  for (const h of PARAMETRIC_HANDLERS) {
    if (h.matches(parsed)) return h
  }
  throw new Error(`no parametric OutputKindHandler matches '${stringifyKind(parsed)}'`)
}

/**
 * `getHandlerForParsedKind` that returns null instead of throwing — useful
 * in places that want to handle "no handler" gracefully (e.g. legacy
 * passthrough fallback).
 */
export function tryHandlerForParsedKind(parsed: ParsedKind): ParametricOutputKindHandler | null {
  for (const h of PARAMETRIC_HANDLERS) {
    if (h.matches(parsed)) return h
  }
  return null
}

// -----------------------------------------------------------------------------
// Module-load-time invariant: subReason short-codes are unique within this
// registry. RFC-049 sibling check on the legacy HANDLERS Record continues
// to run independently in outputKinds/index.ts.
// -----------------------------------------------------------------------------
{
  const claimedBy = new Map<string, string>()
  for (const h of PARAMETRIC_HANDLERS) {
    for (const sub of h.subReasons) {
      const prev = claimedBy.get(sub)
      if (prev !== undefined && prev !== h.displayName) {
        throw new Error(
          `RFC-060 PARAMETRIC_HANDLERS: subReason collision: '${sub}' claimed by both ${prev} and ${h.displayName}`,
        )
      }
      claimedBy.set(sub, h.displayName)
    }
  }
}
