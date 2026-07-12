-- RFC-154 — per-runtime config-dir injection overrides.
--
-- A custom fork binary (runtimes.binary_path, RFC-112) may have renamed the env
-- var and/or the default leaf directory it discovers its config dir through
-- (stock: OPENCODE_CONFIG_DIR → <runRoot>/.opencode; CLAUDE_CONFIG_DIR →
-- <runRoot>/.claude). Without an override, framework-staged skills land where
-- the fork never looks. NULL = protocol default (shared
-- DEFAULT_CONFIG_DIR_PROFILE) — existing rows keep byte-identical spawns.
-- Values are validated at save time (single leaf name / legal non-reserved env
-- name); dispatch freezes the resolved pair into
-- node_runs.runtime_params_json.__configDir so resume/retry never re-read these
-- mutable columns. See design/RFC-154-runtime-config-dir-configurable/design.md.
ALTER TABLE `runtimes` ADD `config_dir_env` text;--> statement-breakpoint
ALTER TABLE `runtimes` ADD `config_dir_name` text;
