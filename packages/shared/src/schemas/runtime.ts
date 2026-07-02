// RFC-001: shared types for the /api/runtime(s)/* endpoints.
//
// These shape the response of:
//   GET /api/runtimes/status   — per-enabled-runtime live probe (RFC-135)
//   GET /api/runtime/models    — `opencode models --verbose` parsed list
//
// Backend writes them; frontend reads them. Kept in shared so both sides
// type-check against the same shape. The legacy single-runtime probe schemas
// (RuntimeOpencodeStatus / RuntimeClaudeStatus) were removed with their
// endpoints in RFC-135.

import { z } from 'zod'

/**
 * RFC-135: GET /api/runtimes/status — one entry per ENABLED registry runtime,
 * probed live (`--version`) against the binary a real dispatch would use.
 *
 * Deliberately carries NO `compatible` / `minVersion`: availability is
 * version-gate free (user decision 2026-07-02 — custom binaries own their own
 * version scheme; comparing against the official minimum produced false
 * failures). `ok` = the probe process exited 0; `version` is display-only and
 * may be null even when ok (unparseable custom version strings).
 */
export const RuntimeStatusEntrySchema = z.object({
  name: z.string(),
  protocol: z.enum(['opencode', 'claude-code']),
  binary: z.string(),
  ok: z.boolean(),
  version: z.string().nullable(),
  isDefault: z.boolean(),
})
export type RuntimeStatusEntry = z.infer<typeof RuntimeStatusEntrySchema>

export const RuntimesStatusResponseSchema = z.object({
  runtimes: z.array(RuntimeStatusEntrySchema),
})
export type RuntimesStatusResponse = z.infer<typeof RuntimesStatusResponseSchema>

export const OpencodeModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  modelID: z.string(),
  name: z.string().optional(),
})
export type OpencodeModel = z.infer<typeof OpencodeModelSchema>

export const RuntimeModelsResponseSchema = z.object({
  binary: z.string(),
  models: z.array(OpencodeModelSchema),
  cached: z.boolean(),
})
export type RuntimeModelsResponse = z.infer<typeof RuntimeModelsResponseSchema>
