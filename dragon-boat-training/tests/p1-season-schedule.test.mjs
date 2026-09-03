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

test("a repeated create-season request returns the original draft without another row", async () => {
  const backend = await createBackend();
  const token = login(backend.context);
  const first = createSeason(backend.context, token, "p1_create_replayed");
  const replayed = createSeason(backend.context, token, "p1_create_replayed");

  assert.equal(first.ok, true);
  assert.deepEqual(replayed.data, first.data);
  assert.equal(sheetRecords(backend.spreadsheet, "Seasons").length, 1);
  assert.equal(sheetRecords(backend.spreadsheet, "Seasons")[0].season_id, first.data.season.season_id);
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

async function prepareWeekRecoveryFixture() {
  const backend = await createBackend();
  const fixture = backend.createFormBinding();
  const token = login(backend.context);
  const created = createSeason(backend.context, token);
  const initialized = post(
    backend.context,
    bindingBody(created.data.season, token, fixture, "initializeSeason", "recovery_initialize")
  );
  const templates = [
    { day_of_week: 3, start_time: "18:00", end_time: "20:00", location: "Original Dock", address: "1 River Road", map_url: "" },
    { day_of_week: 6, start_time: "10:00", end_time: "12:00", location: "Original Dock", address: "1 River Road", map_url: "" }
  ];
  const saved = post(backend.context, {
    action: "updateScheduleTemplates", request_id: "recovery_templates", session_token: token,
    season_id: initialized.data.season.season_id, season_version: initialized.data.season.season_version,
    templates
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const season = saved.data.season;
  return {
    backend, fixture, token, season, templates,
    body: {
      action: "updateTrainingWeek", request_id: "recovery_prepare_week", session_token: token,
      season_id: season.season_id, season_version: season.season_version, week_start_date: "2026-09-07"
    }
  };
}

test("week generation recovers every persisted stage without an empty week or duplicate event", async (t) => {
  for (const stage of ["week", "practice", "result", "audit", "completed"]) {
    await t.test(stage, async () => {
      const { backend, fixture, body } = await prepareWeekRecoveryFixture();
      const originalAppend = backend.context.appendSeasonSheetRecord_;
      const originalUpdate = backend.context.updateSheetRecord_;
      backend.context.appendSeasonSheetRecord_ = (season, sheetName, record) => {
        const result = originalAppend(season, sheetName, record);
        if (
          (stage === "week" && sheetName === "TrainingWeeks") ||
          (stage === "practice" && sheetName === "Practices") ||
          (stage === "audit" && sheetName === "AuditLog" && record.action === "TRAINING_WEEK_PREPARED")
        ) throw new Error(`Interrupted after ${stage}`);
        return result;
      };
      backend.context.updateSheetRecord_ = (sheetName, record) => {
        const result = originalUpdate(sheetName, record);
        if (sheetName === "SystemRequests" && record.action === "updateTrainingWeek") {
          const saved = JSON.parse(record.result_json);
          if (
            (stage === "result" && saved.result) ||
            (stage === "completed" && record.status === "COMPLETED")
          ) throw new Error(`Interrupted after ${stage}`);
        }
        return result;
      };
      const interrupted = post(backend.context, body);
      assert.equal(interrupted.ok, false);
      assert.equal(interrupted.error.code, "INTERNAL_ERROR");
      backend.context.appendSeasonSheetRecord_ = originalAppend;
      backend.context.updateSheetRecord_ = originalUpdate;

      const recovered = post(backend.context, body);
      assert.equal(recovered.ok, true, JSON.stringify(recovered));
      assert.equal(recovered.data.practices.length, 2);
      assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "TrainingWeeks").length, 1);
      assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "Practices").length, 2);
      assert.equal(
        sheetRecords(fixture.runtimeSpreadsheet, "AuditLog").filter((event) => event.action === "TRAINING_WEEK_PREPARED").length,
        1
      );
      assert.deepEqual(post(backend.context, body).data, recovered.data);
    });
  }
});

test("week recovery uses the accepted templates and preserves adjusted or cancelled instances", async () => {
  const { backend, fixture, token, season, templates, body } = await prepareWeekRecoveryFixture();
  const originalAppend = backend.context.appendSeasonSheetRecord_;
  backend.context.appendSeasonSheetRecord_ = (storedSeason, sheetName, record) => {
    const result = originalAppend(storedSeason, sheetName, record);
    if (sheetName === "Practices") throw new Error("Interrupted after first instance");
    return result;
  };
  assert.equal(post(backend.context, body).ok, false);
  backend.context.appendSeasonSheetRecord_ = originalAppend;

  const storedSeason = backend.context.requireSeason_(season.season_id);
  const firstPractice = backend.context.getSeasonSheetRecords_(storedSeason, "Practices")[0];
  firstPractice.location = "Adjusted Dock";
  firstPractice.cancelled_at = "2026-09-02T12:00:00.000Z";
  firstPractice.practice_version = 2;
  backend.context.updateSeasonSheetRecord_(storedSeason, "Practices", firstPractice);
  const changedTemplates = post(backend.context, {
    action: "updateScheduleTemplates", request_id: "recovery_changed_templates", session_token: token,
    season_id: season.season_id, season_version: season.season_version,
    templates: templates.map((template) => ({ ...template, day_of_week: 7, location: "New Default Dock" }))
  });
  assert.equal(changedTemplates.ok, true, JSON.stringify(changedTemplates));

  const recovered = post(backend.context, body);
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.equal(recovered.data.practices.length, 2);
  const practices = sheetRecords(fixture.runtimeSpreadsheet, "Practices");
  assert.equal(practices[0].location, "Adjusted Dock");
  assert.ok(practices[0].cancelled_at);
  assert.equal(practices[0].practice_version, "2");
  assert.equal(practices[1].location, "Original Dock");
  assert.equal(practices[1].start_at, "2026-09-12T14:00:00.000Z");
  assert.equal(practices[1].created_at, practices[0].created_at);
});

test("completed and new generation requests never recreate a removed instance of an existing week", async () => {
  const { backend, fixture, body } = await prepareWeekRecoveryFixture();
  const completed = post(backend.context, body);
  assert.equal(completed.ok, true);
  const practiceSheet = fixture.runtimeSpreadsheet.getSheetByName("Practices");
  practiceSheet.rows.splice(1, 1);

  const replay = post(backend.context, body);
  assert.deepEqual(replay.data, completed.data);
  assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "Practices").length, 1);
  const newRequest = post(backend.context, { ...body, request_id: "recovery_existing_week" });
  assert.equal(newRequest.ok, true);
  assert.equal(newRequest.data.practices.length, 1);
  assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "Practices").length, 1);
});

test("an unfinished legacy week without its generation plan requires review instead of reporting success", async () => {
  const { backend, fixture, body } = await prepareWeekRecoveryFixture();
  const originalAppend = backend.context.appendSeasonSheetRecord_;
  backend.context.appendSeasonSheetRecord_ = (season, sheetName, record) => {
    const result = originalAppend(season, sheetName, record);
    if (sheetName === "TrainingWeeks") throw new Error("Interrupted after week");
    return result;
  };
  assert.equal(post(backend.context, body).ok, false);
  backend.context.appendSeasonSheetRecord_ = originalAppend;
  const request = backend.context.getSheetRecords_("SystemRequests").find((record) => record.action === "updateTrainingWeek");
  request.result_json = JSON.stringify({ week_id: sheetRecords(fixture.runtimeSpreadsheet, "TrainingWeeks")[0].week_id });
  backend.context.updateSheetRecord_("SystemRequests", request);

  const replay = post(backend.context, body);
  assert.equal(replay.ok, false);
  assert.equal(replay.error.code, "RECOVERY_REQUIRED");
  assert.equal(sheetRecords(fixture.runtimeSpreadsheet, "Practices").length, 0);
});
