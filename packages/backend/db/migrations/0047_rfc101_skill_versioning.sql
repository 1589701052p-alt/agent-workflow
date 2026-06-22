-- RFC-101 PR-A — general skill content versioning + history.
--
-- New:
--   * `skills.content_version` (NOT NULL DEFAULT 1): the monotonic CONTENT
--     version, distinct from the pre-existing `schema_version` (which is the
--     DB-migration version, always 1 in production). Bumps on every write to a
--     managed skill's files/ through the single funnel commitSkillVersion
--     (services/skillVersion.ts); always equals the latest
--     skill_versions.version_index for that skill.
--   * `skill_versions` table: one immutable snapshot row per
--     (skill_name, version_index). The archived files/ tree lives on disk at
--     ~/.agent-workflow/skills/{name}/versions/v{n}/files (filesPath is the
--     app-home-relative path); the DB row holds metadata only. Modeled on
--     doc_versions (RFC-005).
--
-- Backfill: NONE in SQL. Pre-existing managed skills are lazily backfilled to
-- v1 on first version-funnel access (ensureInitialSkillVersion) — the disk
-- snapshot (versions/v1/files) cannot be created from SQL, so the runtime owns
-- it. This keeps the migration pure-schema and the parity replay deterministic.
--
-- Purely additive: no DROP, no rename, no CHECK tightening. Roll-back is
-- `DROP TABLE skill_versions; ALTER TABLE skills DROP COLUMN content_version;`.
--
-- See design/RFC-101-memory-skill-fusion/design.md §3.
ALTER TABLE `skills` ADD COLUMN `content_version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TABLE `skill_versions` (
  `id` text PRIMARY KEY NOT NULL,
  `skill_name` text NOT NULL,
  `version_index` integer NOT NULL,
  `files_path` text NOT NULL,
  `source` text NOT NULL,
  `summary` text,
  `fusion_id` text,
  `restored_from_version` integer,
  `author_user_id` text,
  `content_hash` text,
  `created_at` integer NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (`skill_name`) REFERENCES `skills`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_skill_versions_skill_v` ON `skill_versions` (`skill_name`, `version_index`);
--> statement-breakpoint
CREATE INDEX `idx_skill_versions_created` ON `skill_versions` (`created_at`);
