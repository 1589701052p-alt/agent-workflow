-- RFC-099 B3 — retire the dormant node-level assignment mechanism (D6).
--
-- RFC-036 shipped node_assignments + the reviewer/clarify_target roles as the
-- decision-rights boundary, but the launcher UI never landed, so no real
-- deployment ever wrote an assignment. RFC-099 replaces the boundary with
-- task membership (owner + collaborators + admin can answer reviews and
-- clarifications), so:
--
--   1. task_collaborators rows tagged reviewer/clarify_target collapse into
--      plain 'collaborator' rows (INSERT OR IGNORE first — a user holding
--      both a special role and 'collaborator' would violate the composite PK
--      on a blind UPDATE).
--   2. node_assignments is dropped outright.
--
-- The matching code removal (taskCollab assignment helpers, the assignments
-- API, StartTaskSchema.assignments) ships in the same commit batch.
INSERT OR IGNORE INTO `task_collaborators` (`task_id`, `user_id`, `role`, `added_by`, `added_at`)
SELECT `task_id`, `user_id`, 'collaborator', `added_by`, `added_at`
FROM `task_collaborators`
WHERE `role` IN ('reviewer', 'clarify_target');--> statement-breakpoint
DELETE FROM `task_collaborators` WHERE `role` IN ('reviewer', 'clarify_target');--> statement-breakpoint
DROP TABLE IF EXISTS `node_assignments`;
