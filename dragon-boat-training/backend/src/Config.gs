var DRAGON_BOAT_CONTRACT_VERSION_ = "2026-08-31.p0.2";
var DRAGON_BOAT_SERVICE_NAME_ = "dragon-boat-training";
var DRAGON_BOAT_SERVICE_VERSION_ = "0.2.1-p0";

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
  ]
};

var DRAGON_BOAT_SESSION_TTL_DEFAULT_SECONDS_ = 8 * 60 * 60;
var DRAGON_BOAT_SESSION_TTL_MIN_SECONDS_ = 15 * 60;
var DRAGON_BOAT_SESSION_TTL_MAX_SECONDS_ = 24 * 60 * 60;
var DRAGON_BOAT_SCRIPT_LOCK_TIMEOUT_MS_ = 10000;
