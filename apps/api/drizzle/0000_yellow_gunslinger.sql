CREATE TABLE "ambulances" (
	"id" text PRIMARY KEY NOT NULL,
	"call_sign" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'AVAILABLE' NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"base_station_id" text NOT NULL,
	"crew_contact" text,
	"current_incident_id" text,
	CONSTRAINT "ambulances_call_sign_unique" UNIQUE("call_sign")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"reason" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"ambulance_id" text NOT NULL,
	"eta_min" double precision,
	"status" text DEFAULT 'ASSIGNED' NOT NULL,
	"assigned_by" text,
	"preempted_from" text,
	"destination_hospital_id" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"en_route_at" timestamp with time zone,
	"on_scene_at" timestamp with time zone,
	"transporting_at" timestamp with time zone,
	"at_hospital_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"dispatch_id" text,
	"patient_id" text,
	"hospital_id" text NOT NULL,
	"atmist" jsonb NOT NULL,
	"eta_min" double precision,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ack_at" timestamp with time zone,
	"decision" text DEFAULT 'PENDING' NOT NULL,
	"decline_reason" text
);
--> statement-breakpoint
CREATE TABLE "hospital_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"hospital_id" text NOT NULL,
	"unit_type" text NOT NULL,
	"beds_free" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'ACCEPTING' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "hospitals" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"level" integer NOT NULL,
	"duty_phone" text
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"ref_code" text NOT NULL,
	"client_id" text,
	"status" text DEFAULT 'REPORTED' NOT NULL,
	"priority" text NOT NULL,
	"priority_source" text DEFAULT 'rules' NOT NULL,
	"priority_locked" boolean DEFAULT false NOT NULL,
	"priority_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ai_suggestion" jsonb,
	"type" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy_m" double precision,
	"location_is_approx" boolean DEFAULT false NOT NULL,
	"channel" text NOT NULL,
	"patients_count" integer DEFAULT 1 NOT NULL,
	"symptom_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"description" text,
	"summary" text,
	"lang" text,
	"reporter_hash" text,
	"merged_into" text,
	"report_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"triaged_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"on_scene_at" timestamp with time zone,
	"transporting_at" timestamp with time zone,
	"at_hospital_at" timestamp with time zone,
	"handed_over_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	CONSTRAINT "incidents_ref_code_unique" UNIQUE("ref_code"),
	CONSTRAINT "incidents_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"recipient_role" text,
	"address" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"label" text NOT NULL,
	"start_tag" text,
	"age_est" integer,
	"sex" text,
	"vitals" jsonb,
	"injuries" text,
	"treatment" text,
	"required_unit" text
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"channel" text NOT NULL,
	"raw_text" text,
	"lat" double precision,
	"lng" double precision,
	"reporter_hash" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"ambulance_id" text,
	"hospital_id" text
);
