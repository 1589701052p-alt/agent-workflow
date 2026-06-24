-- RFC-104 — built-in resource read-only lock (additive, hand-written; the repo
-- stopped using drizzle-kit generate after 0012, so every migration since 0013
-- is authored by hand and registered in meta/_journal.json).
--
-- Only `agents` and `workflows` gain `builtin` — they are the sole resource
-- types with framework-seeded rows today (aw-skill-merger / aw-skill-fusion,
-- RFC-101). `builtin` is the immutable identity anchor for the read-only guard
-- (assertNotBuiltin) + list-hide (excludeBuiltin*), replacing the owner+name
-- heuristic that broke the instant a built-in's owner drifted. It is set ONLY by
-- seedFusionResources and is absent from every Create*/Update* HTTP schema.
--
-- Backfill marks the two seeded rows deterministically:
--   * aw-skill-merger — agents.name is UNIQUE, so there is at most one
--     candidate; the owner clause keeps a (hypothetical) non-system row safe.
--   * aw-skill-fusion — workflows.name is NON-unique. Mark only the OLDEST
--     __system__-owned row (min ULID id = the framework's first-seeded one); a
--     later daemon-token same-name row, if any, stays a normal row. Owner-
--     drifted rows (owner already moved off __system__) are reconciled at boot
--     by seedFusionResources (repair-or-adopt-or-create), not here.
--
-- The partial unique index guarantees the framework can never end up with two
-- built-in workflows sharing a name (DB-level backstop for the seed invariant).
ALTER TABLE `agents` ADD COLUMN `builtin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `builtin` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `agents` SET `builtin` = true WHERE `name` = 'aw-skill-merger' AND `owner_user_id` = '__system__';--> statement-breakpoint
UPDATE `workflows` SET `builtin` = true WHERE `id` = (SELECT `id` FROM `workflows` WHERE `name` = 'aw-skill-fusion' AND `owner_user_id` = '__system__' ORDER BY `id` ASC LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflows_builtin_name` ON `workflows` (`name`) WHERE `builtin` = 1;
