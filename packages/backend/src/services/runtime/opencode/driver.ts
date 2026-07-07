// RFC-111 PR-A — the opencode RuntimeDriver.
//
// PR-A slice A1 implements `parseEvent` (delegating to ./events). Later slices
// add `buildSpawn` (argv + env + inline config + skills) and PR-B adds
// probe/listModels/captureSession. Keeping this a thin delegator means the
// extracted logic stays byte-identical to the pre-RFC-111 runner.ts.

import type {
  NormalizedEvent,
  ProbeOpts,
  RuntimeDriver,
  RuntimeModelList,
  RuntimeProbe,
  SessionCaptureContext,
  SpawnPlan,
  SystemAgentSpawnContext,
  ListModelsOpts,
} from '../types'
import type { Config } from '@agent-workflow/shared'
import { parseEvent } from './events'
import { buildOpencodeSpawn } from './spawn'
import { MIN_OPENCODE_VERSION, probeOpencode } from '@/util/opencode'
import { listOpencodeModels } from '@/util/opencode-models'
import { captureChildSessions } from '@/services/sessionCapture'

export const opencodeDriver: RuntimeDriver = {
  kind: 'opencode',
  minVersion: MIN_OPENCODE_VERSION,
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions
  // (byte-for-byte behavior); later PRs move call sites onto these.
  defaultBinary(config: Config): string[] {
    return config.opencodePath ? [config.opencodePath] : ['opencode']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeOpencode(binary, opts)
  },
  async listModels(binary: string, opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return listOpencodeModels(binary, opts)
  },
  async captureSessions(ctx: SessionCaptureContext): Promise<void> {
    await captureChildSessions({
      rootSessionId: ctx.rootSessionId,
      nodeRunId: ctx.nodeRunId,
      taskId: ctx.taskId,
      db: ctx.db,
      log: ctx.log,
      ...(ctx.alreadyInsertedPartIds !== undefined
        ? { alreadyInsertedPartIds: ctx.alreadyInsertedPartIds }
        : {}),
      ...(ctx.opencodeDbPath !== undefined ? { opencodeDbPath: ctx.opencodeDbPath } : {}),
    })
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
