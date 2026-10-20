CREATE TABLE `sync_upload_receipts` (
	`id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`batch_id` varchar(30) NOT NULL,
	`chunk_ref` varchar(100) NOT NULL,
	`payload_sha256` char(64) NOT NULL,
	`status` enum('PROCESSING','COMPLETED') NOT NULL DEFAULT 'PROCESSING',
	`accepted_count` int NOT NULL DEFAULT 0,
	`rejected_count` int NOT NULL DEFAULT 0,
	`result` json,
	`completed_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sync_upload_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `sync_upload_receipts_identity_uq` UNIQUE(`agent_id`,`batch_id`,`chunk_ref`)
);
--> statement-breakpoint
CREATE INDEX `sync_upload_receipts_batch_idx` ON `sync_upload_receipts` (`batch_id`,`created_at`);