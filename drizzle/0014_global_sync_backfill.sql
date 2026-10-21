CREATE TABLE `global_sync_backfill_requests` (
	`id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`policy_revision` int NOT NULL,
	`range_from` date NOT NULL,
	`range_to` date NOT NULL,
	`requested_by_user_id` varchar(30) NOT NULL,
	`reason` varchar(500) NOT NULL,
	`status` enum('REQUESTED','IN_PROGRESS','COMPLETED','FAILED','CANCELLED') NOT NULL DEFAULT 'REQUESTED',
	`linked_batch_id` varchar(30),
	`reconciliation_expected` int,
	`reconciliation_central` int,
	`reconciliation_gap` int,
	`quarantine_covered` int,
	`quarantine_unresolved` int,
	`result_message` varchar(500),
	`error_message` text,
	`requested_at` datetime NOT NULL,
	`started_at` datetime,
	`completed_at` datetime,
	`failed_at` datetime,
	`cancelled_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `global_sync_backfill_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `global_sync_backfill_batch_uq` UNIQUE(`linked_batch_id`)
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `queue_pending_count` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `queue_failed_count` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `quarantine_total_count` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `quarantine_covered_count` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `quarantine_unresolved_count` int;--> statement-breakpoint
ALTER TABLE `agents` ADD `queue_telemetry_at` datetime;--> statement-breakpoint
CREATE INDEX `global_sync_backfill_facility_idx` ON `global_sync_backfill_requests` (`facility_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `global_sync_backfill_agent_idx` ON `global_sync_backfill_requests` (`agent_id`,`requested_at`);--> statement-breakpoint
CREATE INDEX `global_sync_backfill_status_idx` ON `global_sync_backfill_requests` (`status`,`requested_at`);