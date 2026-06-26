-- RFC-108 T11 (AR-09) — circuit-breaker / quarantine columns on tasks
-- (additive, hand-written; migrations are authored by hand since 0013).
--
-- Per-task auto-recovery accounting so a task that deterministically crashes on
-- every auto-resume / auto-repair is QUARANTINED after N attempts in a rolling
-- window instead of crash-looping forever (burning real LLM cost + handles).
--   auto_recovery_attempts          — attempts within the current window
--   auto_recovery_suspended         — 0/1 soft flag; 1 ⟹ excluded from BOTH auto
--                                     loops until a human clears it (one action,
--                                     never terminal).
--   auto_recovery_window_started_at — start of the rolling window (ms).
ALTER TABLE `tasks` ADD COLUMN `auto_recovery_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `auto_recovery_suspended` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `auto_recovery_window_started_at` integer;
