CREATE TABLE "avatars" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"recipe" jsonb NOT NULL,
	"vrm_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "avatars" ADD CONSTRAINT "avatars_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "avatars_owner" ON "avatars" USING btree ("owner_id");