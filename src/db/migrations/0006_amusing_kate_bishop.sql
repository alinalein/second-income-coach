CREATE TABLE "idea_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"language" text NOT NULL,
	"title" text NOT NULL,
	"rationale" text NOT NULL,
	"demand_evidence_note" text,
	"growth_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "idea_translations" ADD CONSTRAINT "idea_translations_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_translations_idea_id_language_idx" ON "idea_translations" USING btree ("idea_id","language");