ALTER TABLE "ideas" ADD COLUMN "demand_evidence_note" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "demand_evidence_citation" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "demand_evidence_quote" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "is_demand_evidence_unverified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "growth_path" text;--> statement-breakpoint
ALTER TABLE "intake" ADD COLUMN "country" text DEFAULT 'other' NOT NULL;