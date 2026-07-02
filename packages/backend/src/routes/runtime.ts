// RFC-001 + RFC-111: model lists for Settings → Runtime.
// Mounted under /api/* — token auth applied by server.ts.
//
// RFC-135: the two legacy single-runtime probes (GET /api/runtime/opencode +
// /api/runtime/claude) were removed — the homepage hero (their last consumer)
// now reads the registry-wide GET /api/runtimes/status in routes/runtimes.ts.

import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { listOpencodeModels } from '@/util/opencode-models'
import { listClaudeModels } from '@/services/runtime/claudeCode/models'
import { resolveRuntimeByName } from '@/services/runtimeRegistry'
import { redactSensitiveString } from '@/util/redact'

export function mountRuntimeRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/runtime/models', async (c) => {
    const cfg = loadConfig(deps.configPath)
    // RFC-114: `?runtime=<name>` lists models for THAT runtime's binary (a custom
    // opencode fork no longer shows the default opencode's models). Resolve the
    // registered runtime FIRST; the legacy `claude`/`claude-code` alias only
    // applies when no runtime is named that (Codex P1-1 — else a runtime literally
    // named `claude` would be hijacked into the static list). No `?runtime=` /
    // unknown name → default opencode (byte-identical to pre-RFC-114).
    const rtParam = c.req.query('runtime')
    const resolved =
      rtParam !== undefined && rtParam.length > 0
        ? await resolveRuntimeByName(deps.db, rtParam)
        : null
    // resolveRuntimeByName fail-safes unknown names to the opencode built-in, so a
    // real match is `resolved.name === rtParam`; the bare alias is when it didn't.
    const matchedReal = resolved !== null && resolved.name === rtParam
    const resolvedBinary = matchedReal ? resolved.binaryPath : null
    const isClaude =
      (matchedReal && resolved.protocol === 'claude-code') ||
      (!matchedReal && (rtParam === 'claude' || rtParam === 'claude-code'))

    if (isClaude) {
      // D3: claude (incl. forks) → curated static list; `binary` reflects the
      // runtime's binary so the UI can label "static, not probed for this binary".
      const models = listClaudeModels()
      return c.json({
        binary: resolvedBinary ?? cfg.claudeCodePath ?? 'claude',
        models: models.map((m) => ({
          id: m.id,
          provider: m.provider ?? 'anthropic',
          modelID: m.modelID ?? m.id,
          name: m.name,
        })),
        cached: true,
      })
    }
    const refreshParam = c.req.query('refresh')
    const refresh = refreshParam === '1' || refreshParam === 'true'
    const binary = resolvedBinary ?? cfg.opencodePath ?? 'opencode'
    try {
      const result = await listOpencodeModels(binary, { refresh })
      return c.json(result)
    } catch (err) {
      // Codex P2-4: the message can carry the fork's raw stderr → redact before
      // it reaches the client.
      return c.json(
        {
          ok: false,
          code: 'opencode-models-failed',
          message: redactSensitiveString((err as Error).message),
          runtime: rtParam ?? null,
        },
        502,
      )
    }
  })
}
