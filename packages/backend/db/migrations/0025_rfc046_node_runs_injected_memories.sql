-- RFC-046: persist the post-budget-clip snapshot of memories that
-- runner.ts injected into the primary agent's inline prompt for this
-- node_run. Adds one nullable column to node_runs; no backfill — old
-- rows surface as NULL (the frontend renders "Inject record not
-- captured (pre-RFC-046 run)") and stay legal forever.
--
-- See design/RFC-046-node-session-injected-memory/design.md §2.1 / §3.
-- See packages/shared/src/schemas/memory.ts InjectedMemorySnapshotSchema
-- for the array element shape stored in this column.
ALTER TABLE `node_runs` ADD COLUMN `injected_memories_json` text;
