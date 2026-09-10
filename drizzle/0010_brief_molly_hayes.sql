ALTER TABLE `agents` ADD `sync_control_state` enum('RUNNING','PAUSED') DEFAULT 'RUNNING' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `control_revision` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `paused_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `paused_by_user_id` varchar(30);--> statement-breakpoint
ALTER TABLE `agents` ADD `pause_reason` varchar(200);--> statement-breakpoint
ALTER TABLE `agents` ADD `effective_sync_state` enum('RUNNING','PAUSE_REQUESTED','PAUSED');--> statement-breakpoint
ALTER TABLE `agents` ADD `applied_control_revision` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `control_applied_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `build_id` varchar(40);--> statement-breakpoint
ALTER TABLE `agents` ADD `capabilities` json;--> statement-breakpoint
ALTER TABLE `agents` ADD `sync_start_date` date;--> statement-breakpoint
CREATE INDEX `agents_control_idx` ON `agents` (`sync_control_state`);