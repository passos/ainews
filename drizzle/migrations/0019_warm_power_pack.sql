CREATE TABLE `companies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`cik` text NOT NULL,
	`ticker` text NOT NULL,
	`name` text NOT NULL,
	`tracked` integer DEFAULT 1 NOT NULL,
	`last_polled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `companies_tracked_idx` ON `companies` (`tracked`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_cik_unique` ON `companies` (`cik`);--> statement-breakpoint
CREATE UNIQUE INDEX `companies_ticker_unique` ON `companies` (`ticker`);--> statement-breakpoint
CREATE TABLE `filings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`accession_number` text NOT NULL,
	`form` text NOT NULL,
	`filing_date` text NOT NULL,
	`report_date` text,
	`acceptance_date_time` text,
	`items` text,
	`primary_document` text,
	`sec_url` text NOT NULL,
	`article_id` integer,
	`fiscal_year` integer,
	`fiscal_period` text,
	`status` text DEFAULT 'processed' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `filings_company_date_idx` ON `filings` (`company_id`,`filing_date`);--> statement-breakpoint
CREATE INDEX `filings_article_id_idx` ON `filings` (`article_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `filings_accession_unique` ON `filings` (`accession_number`);--> statement-breakpoint
CREATE TABLE `financial_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`company_id` integer NOT NULL,
	`filing_id` integer NOT NULL,
	`accession_number` text NOT NULL,
	`taxonomy` text NOT NULL,
	`concept` text NOT NULL,
	`unit` text NOT NULL,
	`val` text NOT NULL,
	`period_start` text,
	`period_end` text NOT NULL,
	`fiscal_year` integer,
	`fiscal_period` text,
	`frame` text,
	`filed_date` text NOT NULL,
	`sec_url` text NOT NULL,
	`superseded_by` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`filing_id`) REFERENCES `filings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by`) REFERENCES `financial_facts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `financial_facts_lookup_idx` ON `financial_facts` (`company_id`,`concept`,`fiscal_year`,`fiscal_period`);--> statement-breakpoint
CREATE INDEX `financial_facts_superseded_idx` ON `financial_facts` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `financial_facts_filing_id_idx` ON `financial_facts` (`filing_id`);--> statement-breakpoint
CREATE INDEX `financial_facts_accession_idx` ON `financial_facts` (`accession_number`);