-- RFC-164 — workgroups (工作组), migration A of 3 (hand-written; additive;
-- registered in meta/_journal.json).
--
-- Two new tables: `workgroups` (sixth ACL resource: mode + leader + the three
-- visibility switches + round cap + completion gate) and `workgroup_members`
-- (roster; display_name is the group-unique addressing token — for human
-- members a REQUIRED alias so prompts never carry user ids, design §11).
-- resource_grants.resource_type gains 'workgroup' at the app layer only (the
-- column has no CHECK constraint — drizzle text enums are type-level).
--
-- Purely additive: no backfill, no existing-table changes. Engine tables
-- (assignments / messages / member cursors) land with migration B (PR-2);
-- tasks link columns + builtin host seed land with migration C (PR-3). See
-- design/RFC-164-workgroup/design.md §1/§14.
CREATE TABLE IF NOT EXISTS `workgroups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'leader_worker' NOT NULL,
	`leader_member_id` text,
	`share_outputs` integer DEFAULT true NOT NULL,
	`direct_messages` integer DEFAULT false NOT NULL,
	`blackboard` integer DEFAULT false NOT NULL,
	`max_rounds` integer DEFAULT 20 NOT NULL,
	`completion_gate` integer DEFAULT false NOT NULL,
	`owner_user_id` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workgroups_name_unique` ON `workgroups` (`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `workgroup_members` (
	`id` text PRIMARY KEY NOT NULL,
	`workgroup_id` text NOT NULL,
	`member_type` text NOT NULL,
	`agent_name` text,
	`user_id` text,
	`display_name` text NOT NULL,
	`role_desc` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`workgroup_id`) REFERENCES `workgroups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uq_workgroup_members_display` ON `workgroup_members` (`workgroup_id`,`display_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workgroup_members_group` ON `workgroup_members` (`workgroup_id`);
