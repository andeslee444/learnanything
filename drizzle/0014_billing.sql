CREATE TYPE "public"."credit_entry_type" AS ENUM('purchase', 'grant', 'hold', 'capture', 'refund');--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"entry_type" "credit_entry_type" NOT NULL,
	"amount" integer NOT NULL,
	"related_entry_id" uuid,
	"lesson_id" uuid,
	"stripe_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_ledger_user_created" ON "credit_ledger" USING btree ("user_id","created_at");