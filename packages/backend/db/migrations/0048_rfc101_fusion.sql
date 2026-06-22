-- RFC-101 PR-B — memory→skill fusion.
--
--   * memories: add a terminal `fused` status + provenance columns
--     (fused_into_skill / fused_into_skill_version / fused_at /
--     fused_by_user_id / fused_fusion_id). SQLite cannot ALTER a CHECK, so the
--     table is rebuilt (template: 0035) preserving every 0023 column, index,
--     CHECK and the two self-FKs verbatim. New CHECK: status='fused' ⟺
--     fused_into_skill IS NOT NULL (the fused⟺has-provenance invariant). All
--     pre-existing rows carry NULL provenance and non-fused status, so the new
--     CHECK passes (0 = 0). Injection (services/memoryInject.ts) filters
--     status='approved', so `fused` is excluded with no code change.
--
--   * fusions: product-level record orchestrating one fusion across iterations
--     (running → awaiting_approval → applying → done / rejected / canceled /
--     failed). Engine execution runs as a normal task (current_task_id); the
--     proposed change lives in that task's ephemeral worktree
--     (proposed_worktree_path) until applied or discarded.
--
-- See design/RFC-101-memory-skill-fusion/design.md §2.3–2.4.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text,
	`source_task_id` text,
	`distill_job_id` text,
	`distill_action` text,
	`supersedes_id` text,
	`superseded_by_id` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`fused_into_skill` text,
	`fused_into_skill_version` integer,
	`fused_at` integer,
	`fused_by_user_id` text,
	`fused_fusion_id` text,
	CHECK (`scope_type` IN ('agent','workflow','repo','global')),
	CHECK (`status` IN ('candidate','approved','archived','superseded','rejected','fused')),
	CHECK (`source_kind` IN ('clarify','review','feedback','manual')),
	CHECK (`distill_action` IS NULL OR `distill_action` IN ('new','update_of','duplicate_of','conflict_with')),
	CHECK (
		(`scope_type` = 'global' AND `scope_id` IS NULL) OR
		(`scope_type` != 'global' AND `scope_id` IS NOT NULL)
	),
	CHECK ((`status` = 'fused') = (`fused_into_skill` IS NOT NULL)),
	FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_memories` (
	`id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
	`source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
	`supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
	`created_at`,`version`
) SELECT
	`id`,`scope_type`,`scope_id`,`title`,`body_md`,`tags`,`status`,`source_kind`,
	`source_event_id`,`source_task_id`,`distill_job_id`,`distill_action`,
	`supersedes_id`,`superseded_by_id`,`approved_by_user_id`,`approved_at`,
	`created_at`,`version`
FROM `memories`;--> statement-breakpoint
DROP TABLE `memories`;--> statement-breakpoint
ALTER TABLE `__new_memories` RENAME TO `memories`;--> statement-breakpoint
CREATE INDEX `idx_memories_scope_status` ON `memories` (`scope_type`,`scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_status_created` ON `memories` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_supersedes` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_source` ON `memories` (`source_kind`,`source_event_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `fusions` (
	`id` text PRIMARY KEY NOT NULL,
	`skill_name` text NOT NULL,
	`base_skill_version` integer NOT NULL,
	`memory_ids_json` text NOT NULL,
	`intent` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`iteration` integer DEFAULT 1 NOT NULL,
	`current_task_id` text,
	`proposed_worktree_path` text,
	`proposed_diff` text,
	`incorporated_memory_ids_json` text,
	`skipped_json` text,
	`changelog` text,
	`applied_skill_version` integer,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by_user_id` text,
	`decided_at` integer,
	`decision_reason` text,
	`error` text,
	CHECK (`status` IN ('running','awaiting_approval','applying','done','rejected','canceled','failed'))
);--> statement-breakpoint
CREATE INDEX `idx_fusions_skill` ON `fusions` (`skill_name`);--> statement-breakpoint
CREATE INDEX `idx_fusions_status` ON `fusions` (`status`);
