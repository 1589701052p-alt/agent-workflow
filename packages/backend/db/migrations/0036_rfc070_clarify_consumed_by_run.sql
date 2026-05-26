-- RFC-070 — Clarify Q&A Aging by Consumed-By-Run. Replace iteration-based
-- aging cutoff (clarifyIteration < cutoff) with a row-level "consumed-by"
-- stamp: when a consumer node_run finishes 'done' AND captures at least one
-- `<workflow-output>` port, mark every Q&A row it consumed. Aging becomes a
-- plain `WHERE consumed_by_..._run_id IS NULL` predicate — no counter math,
-- so adding new rerun modes / consumer kinds / counters in the future cannot
-- silently break this rule.
--
-- Why three tables: `clarify_rounds` is the unified read source post-RFC-058,
-- but `clarify_sessions` (RFC-023) and `cross_clarify_sessions` (RFC-056) are
-- still read directly in services/clarify.ts and services/crossClarify.ts
-- (the legacy DROP is deferred to RFC-058 T18 / RFC-064 PR-C). Dual-write the
-- stamp until those reads are unified or the tables are dropped.
--
-- Why two columns on cross tables: cross-clarify Q&A has TWO independent
-- consumers — the designer (target_consumer_node_id) reading via External
-- Feedback, and the questioner (asking_node_id) reading its own Q&A history
-- on cascade rerun. They run independently; a designer may bake-in a round
-- before the questioner does or vice versa, so the stamps must not share.
-- `clarify_sessions` only has one consumer (asking IS consumer for self), so
-- only the consumer column is added there.
--
-- Backfill: for each answered row with no consumed stamp, find the most
-- recent (finished_at) done node_run for the same (taskId, consumer-node-id)
-- that finished BEFORE the row's answered_at AND has a captured
-- `<workflow-output>` row in `node_run_outputs`. This preserves byte-level
-- equivalence with the prior `computeHistoryCutoff` rule: the rows aged out
-- by the old cutoff are exactly the rows whose consumed stamp lands on a
-- non-NULL run after backfill.

ALTER TABLE `clarify_sessions`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE `cross_clarify_sessions`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE `cross_clarify_sessions`
  ADD COLUMN `consumed_by_questioner_run_id` TEXT
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE `clarify_rounds`
  ADD COLUMN `consumed_by_consumer_run_id` TEXT
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;--> statement-breakpoint

ALTER TABLE `clarify_rounds`
  ADD COLUMN `consumed_by_questioner_run_id` TEXT
    REFERENCES `node_runs`(`id`) ON UPDATE NO ACTION ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX `idx_clarify_rounds_consumed_consumer`
  ON `clarify_rounds`(`consumed_by_consumer_run_id`);--> statement-breakpoint
CREATE INDEX `idx_clarify_rounds_consumed_questioner`
  ON `clarify_rounds`(`consumed_by_questioner_run_id`);--> statement-breakpoint
CREATE INDEX `idx_clarify_sessions_consumed_consumer`
  ON `clarify_sessions`(`consumed_by_consumer_run_id`);--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_consumed_consumer`
  ON `cross_clarify_sessions`(`consumed_by_consumer_run_id`);--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_consumed_questioner`
  ON `cross_clarify_sessions`(`consumed_by_questioner_run_id`);--> statement-breakpoint

-- Backfill clarify_sessions (kind='self'): asking IS consumer.
UPDATE `clarify_sessions` AS cs
SET `consumed_by_consumer_run_id` = (
  SELECT nr.id FROM `node_runs` nr
  WHERE nr.task_id = cs.task_id
    AND nr.node_id = cs.source_agent_node_id
    AND nr.status = 'done'
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < cs.answered_at
    AND EXISTS (SELECT 1 FROM `node_run_outputs` nro WHERE nro.node_run_id = nr.id)
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE cs.status = 'answered'
  AND cs.answered_at IS NOT NULL
  AND cs.consumed_by_consumer_run_id IS NULL;--> statement-breakpoint

-- Backfill cross_clarify_sessions consumer (designer): target_designer_node_id
-- is the consumer.
UPDATE `cross_clarify_sessions` AS ccs
SET `consumed_by_consumer_run_id` = (
  SELECT nr.id FROM `node_runs` nr
  WHERE nr.task_id = ccs.task_id
    AND nr.node_id = ccs.target_designer_node_id
    AND nr.status = 'done'
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < ccs.answered_at
    AND EXISTS (SELECT 1 FROM `node_run_outputs` nro WHERE nro.node_run_id = nr.id)
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE ccs.status = 'answered'
  AND ccs.answered_at IS NOT NULL
  AND ccs.target_designer_node_id IS NOT NULL
  AND ccs.consumed_by_consumer_run_id IS NULL;--> statement-breakpoint

-- Backfill cross_clarify_sessions questioner: source_questioner_node_id is
-- the questioner; it consumes its own Q&A on cascade rerun.
UPDATE `cross_clarify_sessions` AS ccs
SET `consumed_by_questioner_run_id` = (
  SELECT nr.id FROM `node_runs` nr
  WHERE nr.task_id = ccs.task_id
    AND nr.node_id = ccs.source_questioner_node_id
    AND nr.status = 'done'
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < ccs.answered_at
    AND EXISTS (SELECT 1 FROM `node_run_outputs` nro WHERE nro.node_run_id = nr.id)
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE ccs.status = 'answered'
  AND ccs.answered_at IS NOT NULL
  AND ccs.consumed_by_questioner_run_id IS NULL;--> statement-breakpoint

-- Backfill clarify_rounds consumer (kind='self': asking is consumer;
-- kind='cross': target_consumer_node_id is consumer/designer).
UPDATE `clarify_rounds` AS cr
SET `consumed_by_consumer_run_id` = (
  SELECT nr.id FROM `node_runs` nr
  WHERE nr.task_id = cr.task_id
    AND nr.node_id = CASE cr.kind
                       WHEN 'self'  THEN cr.asking_node_id
                       WHEN 'cross' THEN cr.target_consumer_node_id
                     END
    AND nr.status = 'done'
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < cr.answered_at
    AND EXISTS (SELECT 1 FROM `node_run_outputs` nro WHERE nro.node_run_id = nr.id)
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE cr.status = 'answered'
  AND cr.answered_at IS NOT NULL
  AND cr.consumed_by_consumer_run_id IS NULL
  AND (cr.kind = 'self' OR cr.target_consumer_node_id IS NOT NULL);--> statement-breakpoint

-- Backfill clarify_rounds questioner (kind='cross' only; asking is questioner).
UPDATE `clarify_rounds` AS cr
SET `consumed_by_questioner_run_id` = (
  SELECT nr.id FROM `node_runs` nr
  WHERE nr.task_id = cr.task_id
    AND nr.node_id = cr.asking_node_id
    AND nr.status = 'done'
    AND nr.finished_at IS NOT NULL
    AND nr.finished_at < cr.answered_at
    AND EXISTS (SELECT 1 FROM `node_run_outputs` nro WHERE nro.node_run_id = nr.id)
  ORDER BY nr.finished_at DESC
  LIMIT 1
)
WHERE cr.kind = 'cross'
  AND cr.status = 'answered'
  AND cr.answered_at IS NOT NULL
  AND cr.consumed_by_questioner_run_id IS NULL;
