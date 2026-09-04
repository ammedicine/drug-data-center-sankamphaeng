ALTER TABLE `users` MODIFY COLUMN `role` enum('SUPER_ADMIN','ADMIN','FACILITY_ADMIN','USER') NOT NULL DEFAULT 'USER';--> statement-breakpoint
ALTER TABLE `users` ADD `username` varchar(60);--> statement-breakpoint
ALTER TABLE `users` ADD `position` varchar(120);--> statement-breakpoint
ALTER TABLE `users` ADD `approved_at` datetime;--> statement-breakpoint
ALTER TABLE `users` ADD `approved_by_user_id` varchar(30);--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_username_uq` UNIQUE(`username`);