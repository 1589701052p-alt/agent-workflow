// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.

import type { NormalizedEvent, RuntimeDriver, SpawnPlan, SystemAgentSpawnContext } from '../types'
import { parseEvent } from './events'
import { buildOpencodeSpawn } from './spawn'

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  // RFC-117 — system-agent spawn. Minimal inline config (prompt + model only; no
  // skills/mcp/plugins/inventory, no RFC-029/041 in-place mutation), then the
  // shared buildOpencodeSpawn. opencode takes the prompt positionally → no stdin.
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan {
    const inlineConfig = {
      agent: {
        [ctx.agentName]: {
          prompt: ctx.systemPrompt,
          ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
        },
      },
    }
    const { cmd, env } = buildOpencodeSpawn({
      ...(ctx.runtimeBinary != null && ctx.runtimeBinary !== ''
        ? { opencodeCmd: [ctx.runtimeBinary] }
        : {}),
      agentName: ctx.agentName,
      prompt: ctx.prompt,
      worktreePath: ctx.worktreePath,
      runDir: ctx.runDir,
      inlineConfigSerialized: JSON.stringify(inlineConfig),
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
    })
    return { cmd, env, stdin: { mode: 'ignore' } }
  },
}
