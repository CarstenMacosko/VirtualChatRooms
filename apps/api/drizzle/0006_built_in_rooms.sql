ALTER TABLE "rooms" ADD COLUMN "built_in" text;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_owner_built_in" ON "rooms" USING btree ("owner_id","built_in");