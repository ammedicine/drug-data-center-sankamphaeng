ALTER TABLE `agents` ADD `jhcis_connected` boolean;--> statement-breakpoint
ALTER TABLE `agents` ADD `last_jhcis_check_at` datetime;--> statement-breakpoint
ALTER TABLE `agents` ADD `pending_batches` int DEFAULT 0 NOT NULL;