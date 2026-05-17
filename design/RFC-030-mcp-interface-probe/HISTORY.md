# RFC-030 — Commit history note

## 3dd8947 — actually RFC-030, not the message it carries

Commit `3dd8947` is logged as
`chore(rfc-026): STATE 顶部记录 inline-mode prompt 剥输入 follow-up`,
but its actual diff is the entire RFC-030 implementation (36 files,
~4540 insertions): `design/RFC-030-mcp-interface-probe/{proposal,design,plan}.md`,
the `mcp_probes` migration (0016), `services/mcpProbe.ts` +
`services/mcpProbeStore.ts`, the `redactSensitiveString` util, the
`/api/mcps/.../probe` routes, the stdio + HTTP integration fixtures, the
front-end `McpProbeStatusChip` + `McpInventoryPanel` + `mcp-probe-query`
hooks, the i18n `mcps.probe.*` namespace, and all corresponding tests.

The mis-naming happened because another concurrent session in the same
working tree ran a small RFC-026 follow-up commit while RFC-030's files
were already staged; git took my staged paths into the other session's
commit. The commit was local-only at that point, so no rewrites were
needed — this note exists so anyone running `git log` later can recover
the actual provenance.

Use this entry, not the commit subject, when looking up "what landed for
RFC-030".
