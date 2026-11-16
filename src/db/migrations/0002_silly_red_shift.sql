CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'suggested' NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"cited_intake_fields" text[] NOT NULL,
	"idea_type" text NOT NULL,
	"weekly_time_commitment" text NOT NULL,
	"startup_cost_amount_minor_units" integer NOT NULL,
	"startup_cost_currency" text NOT NULL,
	"risk_level" text NOT NULL,
	"baseline_rate_quote" text NOT NULL,
	"baseline_rate_low_amount_minor_units" integer NOT NULL,
	"baseline_rate_high_amount_minor_units" integer NOT NULL,
	"is_vendor_source" boolean NOT NULL,
	"rate_unit" text NOT NULL,
	"baseline_rate_currency" text NOT NULL,
	"baseline_rate_citation" text NOT NULL,
	"source_trust_tier" text NOT NULL,
	"is_rate_unverified" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;