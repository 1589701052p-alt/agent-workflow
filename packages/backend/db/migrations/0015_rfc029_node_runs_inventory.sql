-- RFC-029: persist opencode runtime inventory snapshot per node_run.
-- Nullable; legacy rows stay NULL (UI treats NULL agent-kind rows as
-- captured:false with reason='file-missing' for backward compatibility).
ALTER TABLE `node_runs` ADD `inventory_snapshot_json` text;
