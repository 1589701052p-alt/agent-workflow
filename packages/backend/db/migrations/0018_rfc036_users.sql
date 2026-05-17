CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text,
	`display_name` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`force_password_change` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer,
	`schema_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `idx_users_status` ON `users` (`status`);--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_sessions_token_hash_unique` ON `user_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_sessions_user` ON `user_sessions` (`user_id`, `expires_at`);--> statement-breakpoint
CREATE TABLE `user_pats` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_pats_token_hash_unique` ON `user_pats` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_user_pats_user` ON `user_pats` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_subject_unique` ON `user_identities` (`provider_id`, `subject`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_user` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_provider` ON `user_identities` (`provider_id`);--> statement-breakpoint
INSERT INTO `users` (`id`, `username`, `display_name`, `password_hash`, `role`, `status`, `created_at`, `updated_at`) VALUES ('__system__', '__system__', 'System', NULL, 'admin', 'active', CAST(unixepoch() * 1000 AS INTEGER), CAST(unixepoch() * 1000 AS INTEGER));
