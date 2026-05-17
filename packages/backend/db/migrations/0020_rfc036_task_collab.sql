ALTER TABLE `tasks` ADD `owner_user_id` text REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `idx_tasks_owner` ON `tasks` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `task_collaborators` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY (`task_id`, `user_id`, `role`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`added_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_task_collab_user` ON `task_collaborators` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_task_collab_task` ON `task_collaborators` (`task_id`);--> statement-breakpoint
CREATE TABLE `node_assignments` (
	`task_id` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`assigned_by` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY (`task_id`, `node_id`, `kind`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_node_assign_user` ON `node_assignments` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_node_assign_task` ON `node_assignments` (`task_id`);
