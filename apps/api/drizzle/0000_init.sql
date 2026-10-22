CREATE TYPE "public"."contact_status" AS ENUM('pending', 'accepted', 'blocked');--> statement-breakpoint
CREATE TABLE "contacts" (
	"user_id" text NOT NULL,
	"contact_user_id" text NOT NULL,
	"label" text,
	"status" "contact_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_user_id_contact_user_id_pk" PRIMARY KEY("user_id","contact_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"auth_provider" text NOT NULL,
	"auth_provider_id" text NOT NULL,
	"avatar_id" text,
	"age_confirmed_13_plus_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_contact_user_id_users_id_fk" FOREIGN KEY ("contact_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_auth_identity" ON "users" USING btree ("auth_provider","auth_provider_id");