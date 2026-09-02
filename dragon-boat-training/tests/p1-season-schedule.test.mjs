import assert from "node:assert/strict";
import test from "node:test";

import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

function login(context) {
  const response = post(context, {
    action: "coachLogin",
    request_id: "p1_login_request",
    coach_code: "coach-code-123"
  });
  assert.equal(response.ok, true);
  return response.data.session_token;
}

function createSeason(context, sessionToken, requestId = "p1_create_season") {
  return post(context, {
    action: "createSeason",
    request_id: requestId,
    session_token: sessionToken,
    name: "Fall 2026",
    start_date: "2026-09-01",
    end_date: "2026-12-31",
    timezone: "America/New_York"
  });
}

function bindingBody(season, sessionToken, fixture, action, requestId) {
  return {
    action,
    request_id: requestId,
    session_token: sessionToken,
    season_id: season.season_id,
    season_version: season.season_version,
    form: fixture.formId,
    spreadsheet: fixture.spreadsheetId,
    response_sheet: fixture.responseSheet.getName(),
    display_name_header: "Display Name"
  };
}

function get(context, action, parameters = {}) {
  return payload(context.doGet({ parameter: { action, request_id: `get_${action}_123`, ...parameters } }));
}

test("P1 creates a draft, validates the real Form target, initializes tabs and imports members", async () => {
  const backend = await createBackend();
  const fixture = backend.createFormBinding({
    rows: [
      ["2026-09-01T12:00:00Z", "Alice"],
      ["2026-09-01T12:01:00Z", "Bob"]
    ]
  });
  const token = login(backend.context);
  const created = createSeason(backend.context, token);
  assert.equal(created.ok, true);
  assert.equal(created.data.season.status, "DRAFT");
  assert.equal(created.data.season.season_version, 1);
  assert.equal(created.data.season.season_ends_at, "2027-01-01T05:00:00.000Z");

  const validated = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "validateSeasonBinding", "p1_validate_binding")
  );
  assert.equal(validated.ok, true);
  assert.equal(validated.data.response_count, 2);
  assert.deepEqual(validated.data.preview_names, ["Alice", "Bob"]);

  const initialized = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "initializeSeason", "p1_initialize_season")
  );
  assert.equal(initialized.ok, true);
  assert.equal(initialized.data.season.status, "OPEN");
  assert.equal(initialized.data.sync.imported_count, 2);
  assert.equal(initialized.data.default_season_id, created.data.season.season_id);
  assert.equal(backend.triggers.length, 1);
  assert.deepEqual([...fixture.runtimeSpreadsheet.sheets.keys()], [
    "Form Responses 1",
    "Members",
    "ScheduleTemplates",
    "TrainingWeeks",
    "Practices",
    "SignupsCurrent",
    "SeatPlanCurrent",
    "AuditLog",
    "Settings",
    "ImportState",
    "Health"
  ]);
  assert.deepEqual(
    sheetRecords(fixture.runtimeSpreadsheet, "Members").map((member) => member.source_display_name),
    ["Alice", "Bob"]
  );

  const repeated = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "initializeSeason", "p1_initialize_season")
  );
  assert.equal(repeated.ok, true);
  assert.equal(repeated.data.season.season_id, initialized.data.season.season_id);
  assert.equal(backend.triggers.length, 1);
  assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "Members").length, 2);
});

test("P1 rejects an incorrect Form destination and leaves the season draft", async () => {
  const backend = await createBackend();
  const expected = backend.createFormBinding();
  const other = backend.createFormBinding({
    formId: "other-form-1234567890",
    spreadsheetId: "other-sheet-1234567890",
    responseSheetName: "Other Responses"
  });
  const token = login(backend.context);
  const created = createSeason(backend.context, token, "p1_create_invalid");
  const invalid = post(backend.context, {
    ...bindingBody(created.data.season, token, expected, "validateSeasonBinding", "p1_validate_invalid"),
    spreadsheet: other.spreadsheetId,
    response_sheet: other.responseSheet.getName()
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "BINDING_DESTINATION_MISMATCH");
  assert.equal(sheetRecords(backend.spreadsheet, "Seasons")[0].status, "DRAFT");
});

test("public members reuse one ten-minute snapshot and a sync advances the roster version", async () => {
  const backend = await createBackend();
  const fixture = backend.createFormBinding({
    rows: [["2026-09-01T12:00:00Z", "Alice"]]
  });
  const token = login(backend.context);
  const created = createSeason(backend.context, token, "p1_create_cache");
  const initialized = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "initializeSeason", "p1_initialize_cache")
  );
  const seasonId = initialized.data.season.season_id;

  const first = get(backend.context, "members", { season_id: seasonId });
  const second = get(backend.context, "members", { season_id: seasonId });
  assert.equal(first.ok, true);
  assert.equal(second.data.generated_at, first.data.generated_at);
  assert.equal(second.data.expires_at, first.data.expires_at);
  assert.equal(Date.parse(first.data.expires_at) - Date.parse(first.data.generated_at), 600_000);
  assert.deepEqual(first.data.members.map((member) => member.display_name), ["Alice"]);

  fixture.responseSheet.rows.push(["2026-09-02T12:00:00Z", "Bob"]);
  const synced = post(backend.context, {
    action: "retrySeasonSync",
    request_id: "p1_retry_sync",
    session_token: token,
    season_id: seasonId
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.data.sync.imported_count, 1);
  assert.equal(synced.data.season.roster_version, first.data.roster_version + 1);

  const refreshed = get(backend.context, "members", { season_id: seasonId });
  assert.deepEqual(refreshed.data.members.map((member) => member.display_name), ["Alice", "Bob"]);
  assert.equal(refreshed.data.roster_version, synced.data.season.roster_version);
});

test("a private week and a private additional practice stay hidden until their own publish actions", async () => {
  const backend = await createBackend();
  const fixture = backend.createFormBinding({
    rows: [["2026-09-01T12:00:00Z", "Alice"]]
  });
  const token = login(backend.context);
  const created = createSeason(backend.context, token, "p1_create_schedule");
  const initialized = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "initializeSeason", "p1_initialize_schedule")
  );
  const season = initialized.data.season;

  const templates = post(backend.context, {
    action: "updateScheduleTemplates",
    request_id: "p1_update_templates",
    session_token: token,
    season_id: season.season_id,
    season_version: season.season_version,
    templates: [
      {
        day_of_week: 3,
        start_time: "18:00",
        end_time: "20:00",
        location: "River Dock",
        address: "1 River Road",
        map_url: "https://maps.example.test/river"
      },
      {
        day_of_week: 6,
        start_time: "10:00",
        end_time: "12:00",
        location: "River Dock",
        address: "1 River Road",
        map_url: ""
      }
    ]
  });
  assert.equal(templates.ok, true);

  const draft = post(backend.context, {
    action: "updateTrainingWeek",
    request_id: "p1_prepare_week",
    session_token: token,
    season_id: season.season_id,
    season_version: templates.data.season.season_version,
    week_start_date: "2026-09-07"
  });
  assert.equal(draft.ok, true);
  assert.equal(draft.data.week.status, "DRAFT");
  assert.equal(draft.data.practices.length, 2);
  assert.equal(get(backend.context, "bootstrap", { season_id: season.season_id }).data.weeks.length, 0);

  const opened = post(backend.context, {
    action: "confirmTrainingWeek",
    request_id: "p1_confirm_week",
    session_token: token,
    season_id: season.season_id,
    week_id: draft.data.week.week_id,
    week_version: draft.data.week.week_version
  });
  assert.equal(opened.ok, true);
  assert.equal(opened.data.week.status, "OPENED");
  const repeatedOpen = post(backend.context, {
    action: "confirmTrainingWeek",
    request_id: "p1_confirm_week",
    session_token: token,
    season_id: season.season_id,
    week_id: draft.data.week.week_id,
    week_version: draft.data.week.week_version
  });
  assert.deepEqual(repeatedOpen.data, opened.data);
  assert.equal(get(backend.context, "bootstrap", { season_id: season.season_id }).data.weeks[0].practices.length, 2);

  const additional = post(backend.context, {
    action: "createPractice",
    request_id: "p1_create_additional",
    session_token: token,
    season_id: season.season_id,
    week_id: opened.data.week.week_id,
    week_version: opened.data.week.week_version,
    practice_date: "2026-09-11",
    start_time: "07:00",
    end_time: "09:00",
    location: "River Dock",
    address: "1 River Road",
    map_url: ""
  });
  assert.equal(additional.ok, true);
  assert.equal(additional.data.practice.schedule_published_at, "");
  assert.equal(get(backend.context, "bootstrap", { season_id: season.season_id }).data.weeks[0].practices.length, 2);

  const published = post(backend.context, {
    action: "publishAdditionalPractice",
    request_id: "p1_publish_additional",
    session_token: token,
    season_id: season.season_id,
    week_id: additional.data.week.week_id,
    practice_id: additional.data.practice.practice_id,
    week_version: additional.data.week.week_version,
    practice_version: additional.data.practice.practice_version
  });
  assert.equal(published.ok, true, JSON.stringify(published));
  assert.ok(published.data.practice.schedule_published_at);
  assert.equal(get(backend.context, "bootstrap", { season_id: season.season_id }).data.weeks[0].practices.length, 3);
});

test("P1 setup creates only one scheduled week publisher", async () => {
  const backend = await createBackend();
  const first = backend.context.setupDragonBoatP1();
  const second = backend.context.setupDragonBoatP1();
  assert.equal(first.schedule_trigger_id, second.schedule_trigger_id);
  assert.equal(
    backend.triggers.filter((trigger) => trigger.getHandlerFunction() === "publishDueTrainingWeeks").length,
    1
  );
});
