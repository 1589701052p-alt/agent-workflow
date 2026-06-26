-- RFC-111 PR-B — agent runtime selection + frozen per-run runtime (hand-written;
-- additive). Two ALTERs separated by the breakpoint marker below — the marker is
-- REQUIRED or only the first ALTER applies silently (RFC-108 0052/0053 incident).
--
-- agents.runtime   : per-agent runtime ('opencode' | 'claude-code'); NULL =
--                    inherit config.defaultRuntime (resolves to 'opencode').
-- node_runs.runtime: D15 — the runtime frozen onto the run at dispatch time;
--                    resume/retry read it instead of re-resolving.
-- Both nullable; legacy rows stay NULL → read as 'opencode' → zero behavior change.
ALTER TABLE `agents` ADD COLUMN `runtime` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `runtime` text;
