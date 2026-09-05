ALTER TABLE `agents` ADD `owner_user_id` varchar(30);--> statement-breakpoint
ALTER TABLE `agents` ADD `mac_address` varchar(32);--> statement-breakpoint
ALTER TABLE `agents` ADD `ip_address` varchar(45);--> statement-breakpoint
ALTER TABLE `agents` ADD `network_interface` varchar(80);--> statement-breakpoint
CREATE INDEX `agents_owner_idx` ON `agents` (`owner_user_id`);