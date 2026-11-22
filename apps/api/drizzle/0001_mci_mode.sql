ALTER TABLE "incidents" ADD COLUMN "mci_suggestion" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "mci_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "mci_activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "mci_activated_by" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "dispatch_id" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "destination_hospital_id" text;