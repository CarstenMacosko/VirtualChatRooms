CREATE TYPE "public"."call_status" AS ENUM('ringing', 'accepted', 'declined', 'missed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."link_kind" AS ENUM('device', 'invite', 'call');--> statement-breakpoint
CREATE TABLE "calls" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"link_token" text NOT NULL,
	"caller_name" text NOT NULL,
	"secret" text NOT NULL,
	"status" "call_status" DEFAULT 'ringing' NOT NULL,
	"session_id" text,
	"guest_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"token" text PRIMARY KEY NOT NULL,
	"kind" "link_kind" NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_link_token_links_token_fk" FOREIGN KEY ("link_token") REFERENCES "public"."links"("token") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_owner_status" ON "calls" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "links_owner_kind" ON "links" USING btree ("owner_id","kind");