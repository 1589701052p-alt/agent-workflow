-- RFC-014: agent-level switch for "sync-refresh sibling documents when one is
-- returned for revision (iterate)". Backfills existing rows with `1` (true)
-- so legacy agents inherit the new behavior by default; authors opt out by
-- writing `syncOutputsOnIterate: false` in frontmatter.
ALTER TABLE `agents` ADD `sync_outputs_on_iterate` integer DEFAULT true NOT NULL;