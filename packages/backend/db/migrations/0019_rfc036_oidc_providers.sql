CREATE TABLE `oidc_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`issuer_url` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_enc` text NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`provisioning` text DEFAULT 'invite' NOT NULL,
	`allowed_email_domains_json` text DEFAULT '[]' NOT NULL,
	`icon_url` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oidc_providers_slug_unique` ON `oidc_providers` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_oidc_providers_enabled` ON `oidc_providers` (`enabled`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_user_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`subject` text NOT NULL,
	`email` text,
	`email_verified` integer DEFAULT 0 NOT NULL,
	`linked_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `oidc_providers`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_user_identities` SELECT * FROM `user_identities`;--> statement-breakpoint
DROP TABLE `user_identities`;--> statement-breakpoint
ALTER TABLE `__new_user_identities` RENAME TO `user_identities`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_identities_provider_subject_unique` ON `user_identities` (`provider_id`, `subject`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_user` ON `user_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_identities_provider` ON `user_identities` (`provider_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
