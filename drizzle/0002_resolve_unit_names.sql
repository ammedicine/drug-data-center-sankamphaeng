ALTER TABLE `drug_usage` MODIFY COLUMN `unit` varchar(64);--> statement-breakpoint
ALTER TABLE `drug_usage` ADD `unit_code` varchar(15);--> statement-breakpoint
ALTER TABLE `drugs` ADD `unit_sell_name` varchar(64);--> statement-breakpoint
ALTER TABLE `drugs` ADD `unit_usage_name` varchar(64);