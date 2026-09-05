var DRAGON_BOAT_CONTRACT_VERSION_ = "2026-09-02.p2.1";
var DRAGON_BOAT_SERVICE_NAME_ = "dragon-boat-training";
var DRAGON_BOAT_SERVICE_VERSION_ = "0.7.0-p1-management";

var DRAGON_BOAT_PROPERTY_KEYS_ = {
  SYSTEM_SPREADSHEET_ID: "DRAGON_BOAT_SYSTEM_SPREADSHEET_ID",
  SYSTEM_SPREADSHEET_NAME: "DRAGON_BOAT_SYSTEM_SPREADSHEET_NAME",
  CODE_SECRET: "DRAGON_BOAT_CODE_SECRET",
  SESSION_SECRET: "DRAGON_BOAT_SESSION_SECRET",
  SESSION_TTL_SECONDS: "DRAGON_BOAT_SESSION_TTL_SECONDS",
  INITIAL_COACH_ID: "DRAGON_BOAT_INITIAL_COACH_ID",
  INITIAL_COACH_NAME: "DRAGON_BOAT_INITIAL_COACH_NAME",
  INITIAL_COACH_CODE: "DRAGON_BOAT_INITIAL_COACH_CODE",
  PROVISION_COACH_ID: "DRAGON_BOAT_PROVISION_COACH_ID",
  PROVISION_COACH_NAME: "DRAGON_BOAT_PROVISION_COACH_NAME",
  PROVISION_COACH_CODE: "DRAGON_BOAT_PROVISION_COACH_CODE"
};

var DRAGON_BOAT_SHEET_HEADERS_ = {
  Coaches: [
    "coach_id",
    "display_name",
    "code_salt",
    "code_digest",
    "credential_version",
    "active",
    "created_at",
    "updated_at"
  ],
  CoachSessions: [
    "session_id",
    "token_digest",
    "coach_id",
    "credential_version",
    "issued_at",
    "expires_at",
    "revoked_at"
  ],
  SystemRequests: [
    "request_key",
    "actor_id",
    "action",
    "request_id",
    "payload_digest",
    "status",
    "result_json",
    "created_at",
    "completed_at"
  ],
  SystemAuditLog: [
    "event_id",
    "request_id",
    "server_time",
    "actor_type",
    "actor_id",
    "action",
    "status",
    "details_json"
  ],
  Seasons: [
    "season_id",
    "name",
    "start_date",
    "end_date",
    "timezone",
    "season_ends_at",
    "status",
    "form_id",
    "form_url",
    "runtime_spreadsheet_id",
    "response_sheet_id",
    "response_sheet_name",
    "field_mapping_json",
    "schema_fingerprint",
    "binding_version",
    "season_version",
    "roster_version",
    "initialization_status",
    "trigger_id",
    "last_sync_at",
    "activated_at",
    "completed_at",
    "archived_at",
    "created_by",
    "created_at",
    "updated_at"
  ],
  SystemSettings: [
    "setting_key",
    "setting_value",
    "settings_version",
    "updated_by",
    "updated_at"
  ]
};

var DRAGON_BOAT_RUNTIME_SHEET_HEADERS_ = {
  Members: [
    "season_id",
    "member_id",
    "source_key",
    "source_row_number",
    "source_display_name",
    "display_name_override",
    "status",
    "default_preference",
    "member_version",
    "created_at",
    "updated_at"
  ],
  ScheduleTemplates: [
    "season_id",
    "template_id",
    "day_of_week",
    "start_time",
    "end_time",
    "timezone",
    "location",
    "address",
    "map_url",
    "active",
    "template_version",
    "created_at",
    "updated_at"
  ],
  TrainingWeeks: [
    "season_id",
    "week_id",
    "week_start_date",
    "scheduled_open_at",
    "status",
    "week_version",
    "confirmed_version",
    "confirmed_by",
    "confirmed_at",
    "published_at",
    "created_at",
    "updated_at"
  ],
  Practices: [
    "season_id",
    "practice_id",
    "week_id",
    "template_id",
    "generation_key",
    "start_at",
    "end_at",
    "timezone",
    "location",
    "address",
    "map_url",
    "left_capacity",
    "right_capacity",
    "signup_cutoff_at",
    "practice_version",
    "cancelled_at",
    "cancelled_by",
    "schedule_published_at",
    "schedule_published_by",
    "created_at",
    "updated_at"
  ],
  SignupsCurrent: [
    "season_id", "practice_id", "member_id", "preference", "status",
    "queue_at", "queue_sequence", "updated_at", "last_request_id"
  ],
  SeatPlanCurrent: [
    "season_id", "practice_id", "row_number", "side", "member_id",
    "seat_plan_version", "updated_by", "updated_at"
  ],
  SeatPlanState: [
    "season_id", "practice_id", "seat_plan_version", "coach_member_id",
    "steerer_member_id", "published_revision", "frozen_revision",
    "frozen_at", "updated_by", "updated_at"
  ],
  SeatPlanRevisions: [
    "season_id", "practice_id", "revision_number", "revision_id", "source",
    "seat_plan_version", "coach_member_id", "steerer_member_id", "seats_json",
    "names_json", "published_by", "published_at", "request_id"
  ],
  PracticeFinalSnapshots: [
    "season_id", "practice_id", "snapshot_id", "revision_number", "roles_json",
    "seats_json", "names_json", "archive_due_at", "frozen_at", "status"
  ],
  AuditLog: [
    "event_id", "request_id", "server_time", "season_id", "entity_type",
    "entity_id", "actor_type", "actor_id", "action", "status", "details_json"
  ],
  Settings: ["setting_key", "setting_value", "updated_at"],
  ImportState: [
    "season_id", "response_sheet_id", "schema_fingerprint", "last_scanned_row",
    "imported_count", "failed_count", "last_error", "updated_at"
  ],
  Health: ["health_key", "health_value", "updated_at"]
};

var DRAGON_BOAT_SESSION_TTL_DEFAULT_SECONDS_ = 8 * 60 * 60;
var DRAGON_BOAT_SESSION_TTL_MIN_SECONDS_ = 15 * 60;
var DRAGON_BOAT_SESSION_TTL_MAX_SECONDS_ = 24 * 60 * 60;
var DRAGON_BOAT_SCRIPT_LOCK_TIMEOUT_MS_ = 10000;
var DRAGON_BOAT_PUBLIC_ROSTER_CACHE_SECONDS_ = 600;
