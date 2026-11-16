CREATE TABLE "intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"skills_interests" text NOT NULL,
	"weekly_time_availability" text NOT NULL,
	"starting_budget_range" text NOT NULL,
	"risk_tolerance" text NOT NULL,
	"stopped_before_text" text NOT NULL,
	"failure_pattern" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "intake" ADD CONSTRAINT "intake_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;