// RFC-029 — opencode runtime inventory dump plugin.
//
// This file is loaded by an opencode 1.x CHILD PROCESS (not our framework
// runtime). It must be a single ESM file with zero non-builtin imports.
/* global Bun */
// The framework writes it to `<runDir>/.opencode/plugins/` and references
// it via `OPENCODE_CONFIG_CONTENT.plugin: ["file://<abs>"]`. The plugin's
// `server` hook is invoked at opencode boot; we capture the loaded agent /
// skill / mcp inventory by hitting the in-process opencode SDK, the loaded
// plugin list via the `config(cfg)` hook, then write a single JSON file at
// `process.env.OPENCODE_AW_INVENTORY_OUT`.
//
// JS twin of `transcoder.ts` — kept aligned by
// `tests/inventory-dump-twin-parity.test.ts`.

function str(v, fallback) {
  if (typeof v === 'string') return v
  if (v == null) return fallback
  return String(v)
}

function nullableStr(v) {
  if (typeof v === 'string') return v
  if (v == null) return null
  return String(v)
}

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback
}

function transcodeAgent(raw) {
  const r = raw ?? {}
  const model = r.model ?? {}
  const source = r.source ?? {}
  const permission = r.permission ?? {}
  const readonly =
    permission.edit === 'deny' && permission.bash === 'deny' ? true : bool(r.readonly, false)
  return {
    name: str(r.name, '(unnamed)'),
    mode: str(r.mode, 'unknown'),
    modelProviderId: nullableStr(model.providerID ?? r.modelProviderId),
    modelId: nullableStr(model.modelID ?? r.modelId),
    readonly,
    source: str(source.type ?? r.source, 'unknown'),
  }
}

function transcodeSkill(raw) {
  const r = raw ?? {}
  const source = r.source ?? {}
  return {
    name: str(r.name, '(unnamed)'),
    source: str(source.type ?? r.source, 'unknown'),
    path: nullableStr(source.path ?? r.path),
    description: nullableStr(r.description),
  }
}

function transcodeMcp(name, raw) {
  const r = raw ?? {}
  const config = r.config ?? {}
  return {
    name,
    type: str(config.type ?? r.type, 'unknown'),
    status: str(r.status, 'unknown'),
    hint: nullableStr(r.error ?? r.url ?? r.hint),
  }
}

function transcodePluginOrigin(raw) {
  const r = raw ?? {}
  const spec = r.spec
  let specifier
  if (typeof spec === 'string') specifier = spec
  else if (Array.isArray(spec) && typeof spec[0] === 'string') specifier = spec[0]
  else if (spec != null) specifier = JSON.stringify(spec)
  else specifier = '(unknown)'
  return { specifier, source: str(r.source, 'unknown') }
}

async function writeFile(path, body) {
  // Bun.write is available because opencode itself runs on Bun. Fall back to
  // node:fs/promises if the global ever changes (defensive — not exercised).
  if (typeof Bun !== 'undefined' && Bun.write) {
    await Bun.write(path, body)
    return
  }
  const { writeFile: fsWriteFile } = await import('node:fs/promises')
  await fsWriteFile(path, body)
}

export default {
  id: 'aw-inventory-dump',
  async server(input) {
    let pluginsCache = []
    const out = process.env.OPENCODE_AW_INVENTORY_OUT
    let dumped = false

    async function dump() {
      if (dumped) return
      dumped = true
      if (!out) return
      try {
        const [agentsRes, skillsRes, mcpsRes] = await Promise.allSettled([
          input.client.app.agents(),
          input.client.app.skills(),
          input.client.mcp.status(),
        ])
        const agentsRaw =
          agentsRes.status === 'fulfilled' ? agentsRes.value?.data ?? [] : []
        const skillsRaw =
          skillsRes.status === 'fulfilled' ? skillsRes.value?.data ?? [] : []
        const mcpsRaw =
          mcpsRes.status === 'fulfilled' ? mcpsRes.value?.data ?? {} : {}
        const agents = Array.isArray(agentsRaw) ? agentsRaw.map(transcodeAgent) : []
        const skills = Array.isArray(skillsRaw) ? skillsRaw.map(transcodeSkill) : []
        const mcps = []
        if (mcpsRaw && typeof mcpsRaw === 'object') {
          for (const [name, value] of Object.entries(mcpsRaw)) {
            mcps.push(transcodeMcp(name, value))
          }
        }
        const snapshot = {
          captured: true,
          schemaVersion: 1,
          capturedAt: Date.now(),
          agents,
          skills,
          mcps,
          plugins: pluginsCache,
        }
        await writeFile(out, JSON.stringify(snapshot))
      } catch (err) {
        try {
          await writeFile(
            out,
            JSON.stringify({
              captured: false,
              reason: 'dump-plugin-internal-error',
              message: err && err.message ? String(err.message) : String(err),
            }),
          )
        } catch {
          // fs unavailable; give up silently — framework reads file-missing.
        }
      }
    }

    // Try once on next microtask (covers the common case where opencode's
    // service layer is already up at plugin-boot time).
    queueMicrotask(() => {
      void dump()
    })

    return {
      // `config(cfg)` runs after opencode resolved & merged its config. We
      // snapshot `plugin_origins` here; if `dump()` ran before this, we re-run
      // once on the first chat.message to pick up the plugin list.
      config: async (cfg) => {
        const origins = Array.isArray(cfg && cfg.plugin_origins) ? cfg.plugin_origins : []
        pluginsCache = origins.map(transcodePluginOrigin)
      },
      'chat.message': async () => {
        if (!dumped) {
          await dump()
          return
        }
        // Already dumped but plugins list arrived later — re-dump idempotently
        // so the plugins[] array isn't empty in the common case.
        if (pluginsCache.length > 0) {
          dumped = false
          await dump()
        }
      },
    }
  },
}
