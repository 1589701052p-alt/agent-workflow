// RFC-111 PR-B — the Claude Code RuntimeDriver.
//
// The shared seam exposes `parseEvent` (the generic stdout pump consumes it for
// any runtime). Spawn assembly is runtime-branched in runNode (opencode inline
// config vs claude system-prompt-file differ too much for one ctx), so it lives
// in ./spawn.ts (buildClaudeSpawn) rather than on this object.

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
import { join } from 'node:path'
import { parseEvent } from './events'
import { buildClaudeSpawn } from './spawn'
import { MIN_CLAUDE_CODE_VERSION, probeClaudeCode } from './probe'
import { listClaudeModels } from './models'
import { captureClaudeSessions } from './sessionCapture'

export const claudeCodeDriver: RuntimeDriver = {
  kind: 'claude-code',
  minVersion: MIN_CLAUDE_CODE_VERSION,
  parseEvent(line: string): NormalizedEvent | null {
    return parseEvent(line)
  },
  // RFC-143 — capability methods. PR-1 delegates to the existing free functions.
  defaultBinary(config: Config): string[] {
    return config.claudeCodePath ? [config.claudeCodePath] : ['claude']
  },
  probe(binary: string, opts?: ProbeOpts): Promise<RuntimeProbe> {
    return probeClaudeCode(binary, opts)
  },
  // claude has no `models` subcommand — a static table, ignores binary, always cached.
  async listModels(binary: string, _opts?: ListModelsOpts): Promise<RuntimeModelList> {
    return { binary, models: listClaudeModels(), cached: true }
  },
  async captureSessions(ctx: SessionCaptureContext): Promise<void> {
    await captureClaudeSessions({
      rootSessionId: ctx.rootSessionId,
      nodeRunId: ctx.nodeRunId,
      taskId: ctx.taskId,
      db: ctx.db,
      log: ctx.log,
      configDir: join(ctx.runRoot, '.claude'),
      worktreePath: ctx.worktreePath,
    })
  },
  // RFC-117 — system-agent spawn. Persona → --append-system-prompt-file, model →
  // --model, prompt → stdin (buildClaudeSpawn already returns stdin:pipe). No
  // skills/mcp/subagents for a framework system agent.
  buildSpawn(ctx: SystemAgentSpawnContext): SpawnPlan {
    return buildClaudeSpawn({
      ...(ctx.runtimeBinary != null && ctx.runtimeBinary !== ''
        ? { claudeCmd: [ctx.runtimeBinary] }
        : {}),
      prompt: ctx.prompt,
      systemPromptText: ctx.systemPrompt,
      ...(ctx.model != null && ctx.model !== '' ? { model: ctx.model } : {}),
      attemptDir: ctx.runDir,
      worktreePath: ctx.worktreePath,
      ...(ctx.resumeSessionId != null && ctx.resumeSessionId !== ''
        ? { resumeSessionId: ctx.resumeSessionId }
        : {}),
      ...(ctx.bridgeCredentials != null ? { bridgeCredentials: ctx.bridgeCredentials } : {}),
      gitUserName: ctx.gitUserName ?? null,
      gitUserEmail: ctx.gitUserEmail ?? null,
    })
  },
}
