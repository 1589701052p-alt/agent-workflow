CREATE TABLE `mcp_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`mcp_id` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer NOT NULL,
	`handshake_ms` integer,
	`server_info_json` text,
	`protocol_version` text,
	`capabilities_json` text,
	`tools_json` text,
	`resources_json` text,
	`resource_templates_json` text,
	`prompts_json` text,
	`error_code` text,
	`error_message` text,
	`error_detail_json` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`mcp_id`) REFERENCES `mcps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_probes_mcp_id_unique` ON `mcp_probes` (`mcp_id`);