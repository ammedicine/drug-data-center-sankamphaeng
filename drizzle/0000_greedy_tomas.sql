CREATE TABLE `agent_credentials` (
	`id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`key_id` varchar(40) NOT NULL,
	`secret_enc` varchar(255) NOT NULL,
	`is_active` boolean NOT NULL DEFAULT true,
	`last_used_at` datetime,
	`revoked_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_credentials_key_uq` UNIQUE(`key_id`)
);
--> statement-breakpoint
CREATE TABLE `agent_enrollment_tokens` (
	`id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`token_hash` varchar(64) NOT NULL,
	`expires_at` datetime NOT NULL,
	`used_at` datetime,
	`created_by_user_id` varchar(30),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `agent_enrollment_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `agent_enrollment_tokens_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `agent_request_nonces` (
	`nonce` varchar(64) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`seen_at` datetime NOT NULL,
	CONSTRAINT `agent_request_nonces_nonce` PRIMARY KEY(`nonce`)
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` varchar(30) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`name` varchar(160) NOT NULL,
	`status` enum('ONLINE','OFFLINE','SYNCING','ERROR','DISABLED') NOT NULL DEFAULT 'OFFLINE',
	`version` varchar(40),
	`installation_id` varchar(64),
	`hostname` varchar(120),
	`jhcis_pcucode` char(5),
	`jhcis_version` varchar(40),
	`mysql_version` varchar(40),
	`schema_report` json,
	`sync_interval_minutes` int NOT NULL DEFAULT 60,
	`reprocess_days` int NOT NULL DEFAULT 7,
	`last_heartbeat_at` datetime,
	`last_sync_at` datetime,
	`last_successful_sync_at` datetime,
	`last_error` text,
	`last_error_at` datetime,
	`last_synced_visit_date` date,
	`sync_count` int NOT NULL DEFAULT 0,
	`failed_count` int NOT NULL DEFAULT 0,
	`sync_requested_at` datetime,
	`enrolled_at` datetime,
	`revoked_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `agents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`actor_type` enum('USER','AGENT','SYSTEM') NOT NULL,
	`actor_id` varchar(30),
	`actor_label` varchar(160),
	`action` varchar(80) NOT NULL,
	`resource` varchar(60) NOT NULL,
	`resource_id` varchar(64),
	`facility_id` varchar(30),
	`ip` varchar(45),
	`metadata` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `drug_usage` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`record_key` char(64) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`drug_code` varchar(24) NOT NULL,
	`drug_name_snapshot` varchar(255),
	`drug_type` varchar(2),
	`visit_no` bigint NOT NULL,
	`usage_date` date NOT NULL,
	`quantity` decimal(14,2) NOT NULL,
	`unit` varchar(15),
	`clinic` varchar(5),
	`source_pcucode` char(5) NOT NULL,
	`source_version` varchar(40),
	`sync_batch_id` varchar(30) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drug_usage_id` PRIMARY KEY(`id`),
	CONSTRAINT `drug_usage_record_key_uq` UNIQUE(`record_key`)
);
--> statement-breakpoint
CREATE TABLE `drugs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`drug_code` varchar(24) NOT NULL,
	`drug_name` varchar(255) NOT NULL,
	`generic_name` varchar(220),
	`drug_type` varchar(2),
	`drug_type_sub` varchar(2),
	`drug_flag` char(1),
	`unit_sell` varchar(15),
	`unit_usage` varchar(15),
	`source_version` varchar(40),
	`synced_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `drugs_id` PRIMARY KEY(`id`),
	CONSTRAINT `drugs_facility_code_uq` UNIQUE(`facility_id`,`drug_code`)
);
--> statement-breakpoint
CREATE TABLE `facilities` (
	`id` varchar(30) NOT NULL,
	`code` varchar(20) NOT NULL,
	`jhcis_pcucode` char(5) NOT NULL,
	`name` varchar(200) NOT NULL,
	`province` varchar(100),
	`district` varchar(100),
	`subdistrict` varchar(100),
	`is_active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `facilities_id` PRIMARY KEY(`id`),
	CONSTRAINT `facilities_code_uq` UNIQUE(`code`),
	CONSTRAINT `facilities_pcucode_uq` UNIQUE(`jhcis_pcucode`)
);
--> statement-breakpoint
CREATE TABLE `facility_users` (
	`facility_id` varchar(30) NOT NULL,
	`user_id` varchar(30) NOT NULL,
	`can_manage` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `facility_users_facility_id_user_id_pk` PRIMARY KEY(`facility_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `sync_batches` (
	`id` varchar(30) NOT NULL,
	`batch_ref` varchar(40) NOT NULL,
	`agent_id` varchar(30) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`mode` enum('INITIAL','INCREMENTAL','MANUAL_RANGE','RETRY') NOT NULL DEFAULT 'INCREMENTAL',
	`status` enum('STARTED','UPLOADING','COMPLETED','FAILED','ABORTED') NOT NULL DEFAULT 'STARTED',
	`range_from` date,
	`range_to` date,
	`started_at` datetime NOT NULL,
	`completed_at` datetime,
	`records_read` int NOT NULL DEFAULT 0,
	`records_sent` int NOT NULL DEFAULT 0,
	`records_accepted` int NOT NULL DEFAULT 0,
	`records_rejected` int NOT NULL DEFAULT 0,
	`error_message` text,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sync_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `sync_batches_ref_uq` UNIQUE(`agent_id`,`batch_ref`)
);
--> statement-breakpoint
CREATE TABLE `sync_rejects` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`batch_id` varchar(30) NOT NULL,
	`facility_id` varchar(30) NOT NULL,
	`record_key` char(64),
	`reason` varchar(255) NOT NULL,
	`payload` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sync_rejects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`setting_key` varchar(80) NOT NULL,
	`value` json NOT NULL,
	`description` varchar(255),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `system_settings_setting_key` PRIMARY KEY(`setting_key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(30) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	`full_name` varchar(160) NOT NULL,
	`role` enum('SUPER_ADMIN','FACILITY_ADMIN','USER') NOT NULL DEFAULT 'USER',
	`facility_id` varchar(30),
	`is_active` boolean NOT NULL DEFAULT true,
	`last_login_at` datetime,
	`session_epoch` int NOT NULL DEFAULT 1,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `agent_credentials_agent_idx` ON `agent_credentials` (`agent_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `agent_enrollment_tokens_agent_idx` ON `agent_enrollment_tokens` (`agent_id`);--> statement-breakpoint
CREATE INDEX `agent_request_nonces_seen_idx` ON `agent_request_nonces` (`seen_at`);--> statement-breakpoint
CREATE INDEX `agents_facility_idx` ON `agents` (`facility_id`,`status`);--> statement-breakpoint
CREATE INDEX `agents_heartbeat_idx` ON `agents` (`last_heartbeat_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_facility_idx` ON `audit_logs` (`facility_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`created_at`);--> statement-breakpoint
CREATE INDEX `drug_usage_report_idx` ON `drug_usage` (`facility_id`,`usage_date`,`drug_code`);--> statement-breakpoint
CREATE INDEX `drug_usage_drug_idx` ON `drug_usage` (`facility_id`,`drug_code`,`usage_date`);--> statement-breakpoint
CREATE INDEX `drug_usage_type_idx` ON `drug_usage` (`facility_id`,`drug_type`,`usage_date`);--> statement-breakpoint
CREATE INDEX `drug_usage_batch_idx` ON `drug_usage` (`sync_batch_id`);--> statement-breakpoint
CREATE INDEX `drug_usage_agent_idx` ON `drug_usage` (`agent_id`,`usage_date`);--> statement-breakpoint
CREATE INDEX `drugs_type_idx` ON `drugs` (`facility_id`,`drug_type`);--> statement-breakpoint
CREATE INDEX `facility_users_user_idx` ON `facility_users` (`user_id`);--> statement-breakpoint
CREATE INDEX `sync_batches_facility_idx` ON `sync_batches` (`facility_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `sync_batches_status_idx` ON `sync_batches` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `sync_rejects_batch_idx` ON `sync_rejects` (`batch_id`);--> statement-breakpoint
CREATE INDEX `users_facility_idx` ON `users` (`facility_id`,`is_active`);