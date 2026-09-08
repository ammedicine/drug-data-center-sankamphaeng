ALTER TABLE `agents` ADD `last_seen_at` datetime;--> statement-breakpoint
CREATE INDEX `agents_seen_idx` ON `agents` (`last_seen_at`);