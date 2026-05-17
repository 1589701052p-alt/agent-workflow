ALTER TABLE `cached_repos` ADD `has_submodules` integer;--> statement-breakpoint
ALTER TABLE `cached_repos` ADD `last_submodule_sync_ok` integer;--> statement-breakpoint
ALTER TABLE `cached_repos` ADD `last_submodule_sync_error` text;
