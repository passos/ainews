ALTER TABLE `analyses` ADD `prefilter_relevant` real;--> statement-breakpoint
ALTER TABLE `analyses` ADD `prefilter_pass` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analyses` ADD `category` text;--> statement-breakpoint
ALTER TABLE `analyses` ADD `noise_kind` text;--> statement-breakpoint
ALTER TABLE `analyses` ADD `selected` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `analyses` ADD `title_en` text;--> statement-breakpoint
ALTER TABLE `analyses` ADD `summary_en` text;--> statement-breakpoint
ALTER TABLE `analyses` ADD `jev_raw` text;