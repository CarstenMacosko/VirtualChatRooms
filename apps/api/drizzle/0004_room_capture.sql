CREATE TYPE "public"."capture_provider" AS ENUM('kiri', 'byo');--> statement-breakpoint
CREATE TYPE "public"."capture_source" AS ENUM('video', 'splat_upload');--> statement-breakpoint
CREATE TYPE "public"."capture_status" AS ENUM('uploading', 'queued', 'reconstructing', 'postprocessing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."room_status" AS ENUM('uploading', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "capture_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"source" "capture_source" NOT NULL,
	"provider" "capture_provider" NOT NULL,
	"provider_task_id" text,
	"source_key" text NOT NULL,
	"upload_id" text,
	"source_bytes" real,
	"status" "capture_status" NOT NULL,
	"progress" real,
	"error" text,
	"options" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "status" "room_status" DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "progress" real;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "scan" jsonb;--> statement-breakpoint
ALTER TABLE "capture_jobs" ADD CONSTRAINT "capture_jobs_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capture_jobs_room" ON "capture_jobs" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "capture_jobs_status" ON "capture_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rooms_owner" ON "rooms" USING btree ("owner_id");