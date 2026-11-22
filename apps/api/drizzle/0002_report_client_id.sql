ALTER TABLE "incidents" ADD COLUMN "mci_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_unique" UNIQUE("client_id");