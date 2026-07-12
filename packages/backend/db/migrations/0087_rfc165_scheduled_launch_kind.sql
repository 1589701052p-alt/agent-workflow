-- RFC-165 §9b — scheduled-task launch kind (D11): which subject face this
-- schedule fires (workflow / agent / workgroup). Existing rows are all
-- workflow schedules — the column default IS the backfill.
ALTER TABLE `scheduled_tasks` ADD `launch_kind` text NOT NULL DEFAULT 'workflow';
