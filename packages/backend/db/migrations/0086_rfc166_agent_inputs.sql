-- RFC-166 — agent declarative input ports (hand-written; additive; registered
-- in meta/_journal.json).
--
-- Adds `agents.inputs` (JSON AgentInputPort[]) symmetrical to `outputs`.
-- Purely additive: existing agents get `[]` and behave byte-for-byte as before
-- (the runner binds inputs implicitly via promptTemplate {{token}}; declared
-- inputs are consumed only by the RFC-166 capability card, not the spawn path).
-- No backfill. See design/RFC-166-agent-capability-layer/design.md §1.
ALTER TABLE `agents` ADD `inputs` text DEFAULT '[]' NOT NULL;
