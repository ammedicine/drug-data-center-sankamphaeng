CREATE TABLE `agent_update_commands` (
	`id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`facility_id` varchar(30),
	`group_id` varchar(30),
	`target_version` varchar(40) NOT NULL,
	`target_asset_name` varchar(120) NOT NULL,
	`target_size` bigint unsigned,
	`target_sha256` char(64) NOT NULL,
	`version_at_request` varchar(40),
	`requested_by_user_id` varchar(30) NOT NULL,
	`requested_at` datetime NOT NULL,
	`status` enum('REQUESTED','DELIVERED','WAITING_FOR_IDLE','CHECKING','DOWNLOADING','VERIFYING','INSTALLING','SUCCESS','FAILED','CANCELLED','SUPERSEDED') NOT NULL DEFAULT 'REQUESTED',
	`status_changed_at` datetime NOT NULL,
	`delivered_at` datetime,
	`completed_at` datetime,
	`attempts` int NOT NULL DEFAULT 0,
	`last_error_code` varchar(40),
	`last_error_message` varchar(400),
	`last_error_at` datetime,
	`result_version` varchar(40),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agent_update_commands_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `update_state` varchar(24);--> statement-breakpoint
ALTER TABLE `agents` ADD `update_command_id` varchar(30);--> statement-breakpoint
ALTER TABLE `agents` ADD `update_target_version` varchar(40);--> statement-breakpoint
ALTER TABLE `agents` ADD `update_checked_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `update_error_code` varchar(40);--> statement-breakpoint
ALTER TABLE `agents` ADD `update_error` varchar(400);--> statement-breakpoint
ALTER TABLE `agents` ADD `update_error_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `update_succeeded_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `updater_task` json;--> statement-breakpoint
CREATE INDEX `agent_update_commands_agent_idx` ON `agent_update_commands` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_update_commands_status_idx` ON `agent_update_commands` (`status`,`status_changed_at`);--> statement-breakpoint
CREATE INDEX `agent_update_commands_group_idx` ON `agent_update_commands` (`group_id`);