import assert from "node:assert/strict";
import test from "node:test";
import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
const fails = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error.code, code); };

async function fixture() {
  const b = await createBackend({ properties: { DRAGON_BOAT_SESSION_TTL_SECONDS: "86400" } });
  let now = Date.parse("2026-09-04T12:00:00Z"), n = 0, token;
  b.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const send = (action, data = {}, id = `p1m_test_${++n}`) => post(b.context, { action, request_id: id, session_token: token, ...data });
  const login = () => { token = ok(send("coachLogin", { coach_code: "coach-code-123" })).session_token; };
  login();
  const binding = b.createFormBinding({ rows: [["2026-09-04T11:00:00Z", "Alice"], ["2026-09-04T11:01:00Z", "Bob"]] });
  let season = ok(send("createSeason", { name: "P1 Management", start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York" })).season;
  season = ok(send("initializeSeason", { season_id: season.season_id, season_version: season.season_version,
    form: binding.formId, spreadsheet: binding.spreadsheetId, response_sheet: binding.responseSheet.getName(), display_name_header: "Display Name" })).season;
  season = ok(send("updateScheduleTemplates", { season_id: season.season_id, season_version: season.season_version,
    templates: [3, 6].map(day => ({ day_of_week: day, start_time: "10:00", end_time: "12:00", location: "Dock", address: "Road", map_url: "" })) })).season;
  ok(send("updateTrainingWeek", { season_id: season.season_id, season_version: season.season_version, week_start_date: "2026-09-07" }));
  const get = (action = "bootstrap", data = {}) => payload(b.context.doGet({ parameter: { action, request_id: `p1m_get_${++n}`, season_id: season.season_id, ...data } }));
  const management = () => ok(send("getSeasonManagement", { season_id: season.season_id }));
  const weekData = () => management().weeks[0];
  const practice = () => weekData().practices[0];
  const fields = (p = practice()) => {
    const parts = b.context.zonedDateTimeParts_(p.start_at, p.timezone);
    const end = b.context.zonedDateTimeParts_(p.end_at, p.timezone);
    return { practice_date: `${parts.year}-${parts.month}-${parts.day}`, start_time: `${parts.hour}:${parts.minute}`,
      end_time: `${end.hour}:${end.minute}`, timezone: p.timezone, location: p.location, address: p.address, map_url: p.map_url };
  };
  const preview = (change = "UPDATE", overrides = {}, target = practice()) => {
    const input = { season_id: season.season_id, week_id: target.week_id, practice_id: target.practice_id, change,
      ...(change === "UPDATE" ? { ...fields(target), ...overrides } : {}) };
    const result = ok(send("previewPracticeChange", input));
    return { ...input, week_version: result.week_version, practice_version: result.practice_version,
      signup_version: result.signup_version, preview_token: result.preview_token };
  };
  const open = (data = {}) => {
    const current = weekData();
    return send("confirmTrainingWeek", { season_id: season.season_id, week_id: current.week.week_id, week_version: current.week.week_version, ...data });
  };
  const signup = (index = 0) => {
    const p = practice();
    const view = ok(get("practice", { practice_id: p.practice_id }));
    return send("signupByCoach", { season_id: season.season_id, practice_id: p.practice_id,
      member_id: sheetRecords(binding.runtimeSpreadsheet, "Members")[index].member_id, preference: "LEFT",
      practice_version: p.practice_version, signup_version: view.signup_version });
  };
  return { b, binding, season, send, get, management, weekData, practice, fields, preview, open, signup,
    time(value) { now = Date.parse(value); login(); } };
}

test("P1 management edits one draft, keeps templates unchanged, removes an instance permanently, and adds before opening", async () => {
  const f = await fixture();
  const templates = f.management().templates;
  const updated = ok(f.send("updatePractice", f.preview("UPDATE", { location: "New Dock", start_time: "11:00" })));
  assert.equal(updated.practice.location, "New Dock");
  assert.equal(updated.practice.signup_cutoff_at, "2026-09-09T13:00:00.000Z");
  assert.deepEqual(f.management().templates, templates);
  ok(f.send("cancelPractice", f.preview("CANCEL")));
  const week = f.weekData().week;
  ok(f.send("createPractice", { season_id: f.season.season_id, week_id: week.week_id, week_version: week.week_version,
    practice_date: "2026-09-10", start_time: "10:00", end_time: "12:00", location: "Extra Dock", address: "Extra Road" }));
  const regenerated = ok(f.send("updateTrainingWeek", { season_id: f.season.season_id, season_version: f.season.season_version, week_start_date: "2026-09-07" }));
  assert.equal(regenerated.practices.length, 3);
  assert.equal(regenerated.practices.filter(p => p.cancelled).length, 1);
  assert.equal(ok(f.get()).weeks.length, 0);
  ok(f.open());
  assert.equal(ok(f.get()).weeks[0].practices.length, 2);
});

test("P1 scheduled opening is invalidated by edits and only the newly confirmed version opens", async () => {
  const f = await fixture();
  const scheduled = ok(f.open({ open_date: "2026-09-05", open_time: "09:00" }));
  assert.equal(scheduled.week.status, "SCHEDULED");
  assert.equal(scheduled.week.scheduled_open_at, "2026-09-05T13:00:00.000Z");
  ok(f.send("updatePractice", f.preview("UPDATE", { address: "Changed Road" })));
  assert.equal(f.weekData().week.status, "DRAFT");
  f.time("2026-09-05T13:01:00Z");
  assert.equal(f.b.context.publishDueTrainingWeeks().published_count, 0);
  assert.equal(ok(f.get()).weeks.length, 0);
  ok(f.open({ open_date: "2026-09-06", open_time: "09:00" }));
  f.time("2026-09-06T13:00:00Z");
  assert.equal(f.b.context.publishDueTrainingWeeks().published_count, 1);
  assert.equal(f.b.context.publishDueTrainingWeeks().published_count, 0);
  assert.equal(ok(f.get()).weeks[0].practices.length, 2);
});

test("P1 preview detects intervening signups and accepted changes preserve queues, private seats and formal revisions", async () => {
  const f = await fixture(); ok(f.open()); ok(f.signup());
  const p = f.practice();
  const view = ok(f.send("getSeatingWorkspace", { season_id: f.season.season_id, practice_id: p.practice_id }));
  const alice = view.signups[0].member_id;
  const seats = Array.from({ length: 10 }, (_, i) => ["LEFT", "RIGHT"].map(side => ({ row_number: i + 1, side, member_id: i === 0 && side === "LEFT" ? alice : "" }))).flat();
  const saved = ok(f.send("saveSeatPlanDraft", { season_id: f.season.season_id, practice_id: p.practice_id, practice_version: p.practice_version,
    signup_version: view.signup_version, seat_plan_version: view.seat_plan_version, published_revision: view.published_revision,
    coach_member_id: "", steerer_member_id: "", seats, change_kind: "EDIT" }));
  ok(f.send("publishSeatPlan", { season_id: f.season.season_id, practice_id: p.practice_id, practice_version: p.practice_version,
    signup_version: saved.signup_version, seat_plan_version: saved.seat_plan_version, published_revision: saved.published_revision,
    acknowledge_preference_mismatch: false }));
  const stale = f.preview("UPDATE", { start_time: "11:00", location: "New Dock" });
  ok(f.signup(1));
  fails(f.send("updatePractice", stale), "VERSION_CONFLICT");
  const before = Object.fromEntries(["SignupsCurrent", "SeatPlanCurrent", "SeatPlanState", "SeatPlanRevisions"].map(name => [name, sheetRecords(f.binding.runtimeSpreadsheet, name)]));
  const body = f.preview("UPDATE", { start_time: "11:00", location: "New Dock" });
  const changed = ok(f.send("updatePractice", body, "keep_original_schedule_request"));
  assert.equal(changed.practice.practice_id, p.practice_id);
  for (const [name, rows] of Object.entries(before)) assert.deepEqual(sheetRecords(f.binding.runtimeSpreadsheet, name), rows, name);
  ok(f.send("updatePractice", f.preview("UPDATE", { location: "Newest Dock" })));
  const replay = ok(f.send("updatePractice", body, "keep_original_schedule_request"));
  assert.equal(replay.practice.location, "New Dock");
  assert.equal(replay.current_view.practices[0].location, "Newest Dock");
  ok(f.send("cancelPractice", f.preview("CANCEL")));
  assert.equal(ok(f.get()).weeks[0].practices[0].cancelled, true);
  const cancelled = ok(f.get("practice", { practice_id: p.practice_id }));
  assert.equal(cancelled.management_signup_open, false);
  assert.equal(cancelled.signups.length, 2);
  for (const [name, rows] of Object.entries(before)) assert.deepEqual(sheetRecords(f.binding.runtimeSpreadsheet, name), rows, name);
});

test("P1 schedule validation rejects altered previews and invalid ranges and invalid local times", async () => {
  const f = await fixture();
  const body = f.preview("UPDATE", { location: "Previewed" });
  fails(f.send("updatePractice", { ...body, location: "Unreviewed" }), "PREVIEW_STALE");
  const input = { season_id: f.season.season_id, practice_id: f.practice().practice_id, change: "UPDATE", ...f.fields() };
  assert.equal(ok(f.send("previewPracticeChange", { ...input, practice_date: "2026-09-20" })).week_id, input.week_id || f.practice().week_id);
  fails(f.send("previewPracticeChange", { ...input, end_time: "09:00" }), "INVALID_TIME_RANGE");
  fails(f.open({ open_at: "nonsense" }), "INVALID_REQUEST");
  fails(f.open({ open_date: "2026-09-09", open_time: "10:00" }), "OPEN_TIME_TOO_LATE");
  assert.throws(() => f.b.context.localDateTimeToIso_("2026-11-01", "01:30", "America/New_York"), e => e.code === "AMBIGUOUS_LOCAL_TIME");
  assert.throws(() => f.b.context.localDateTimeToIso_("2026-03-08", "02:30", "America/New_York"), e => e.code === "INVALID_LOCAL_TIME");
  f.time("2026-09-09T14:00:00Z");
  fails(f.send("previewPracticeChange", input), "PRACTICE_ALREADY_STARTED");
});

test("P1 default switching has a settings version and cannot select a draft or completed season", async () => {
  const f = await fixture();
  const management = f.management();
  const input = { season_id: f.season.season_id, season_version: management.season.season_version, settings_version: management.settings_version };
  const selected = ok(f.send("setDefaultSeason", input));
  assert.equal(selected.default_season_id, f.season.season_id);
  fails(f.send("setDefaultSeason", input), "VERSION_CONFLICT");
  const draft = ok(f.send("createSeason", { name: "Next season", start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York" })).season;
  fails(f.send("setDefaultSeason", { ...input, season_id: draft.season_id, season_version: draft.season_version, settings_version: selected.settings_version }), "SEASON_NOT_OPEN");
});

test("P1 season dates protect existing practices, complete exactly at the boundary and retain final-correction access", async () => {
  const f = await fixture(); ok(f.open());
  const season = f.management().season;
  fails(f.send("updateSeasonSchedule", { season_id: season.season_id, season_version: season.season_version, start_date: "2026-09-01", end_date: "2026-09-11" }), "SEASON_SCHEDULE_CONFLICT");
  const changed = ok(f.send("updateSeasonSchedule", { season_id: season.season_id, season_version: season.season_version, start_date: "2026-09-01", end_date: "2026-09-12" }));
  assert.equal(changed.season.season_ends_at, "2026-09-13T04:00:00.000Z");
  const last = f.weekData().practices[1];
  f.time("2026-09-13T03:59:59Z"); assert.equal(f.management().season.status, "OPEN");
  f.time("2026-09-13T04:00:00Z");
  assert.equal(f.management().season.status, "COMPLETED");
  assert.equal(f.management().is_default, false);
  assert.equal(ok(f.get("bootstrap", { season_id: "" })).state, "COMPLETED");
  assert.equal(ok(f.send("getSeatingWorkspace", { season_id: season.season_id, practice_id: last.practice_id })).mode, "FINAL_CORRECTION");
  fails(f.send("updateSeasonSchedule", { season_id: season.season_id, season_version: f.management().season.season_version, start_date: "2026-09-01", end_date: "2026-12-31" }), "SEASON_NOT_OPEN");
  assert.equal(sheetRecords(f.b.spreadsheet, "SystemAuditLog").filter(e => e.action === "completeSeason").length, 1);
});

test("P1 schedule recovery finishes each persisted stage before readers and never duplicates versions or audit", async t => {
  for (const stage of ["journal", "practice", "week", "audit", "completion"]) await t.test(stage, async () => {
    const f = await fixture();
    const body = f.preview("UPDATE", { location: "Recovered Dock" });
    const append = f.b.context.appendSheetRecord_, update = f.b.context.updateSheetRecord_;
    const runtime = f.b.context.updateSeasonSheetRecord_, audit = f.b.context.appendSeasonSheetRecord_;
    let thrown = false;
    const interrupt = condition => { if (condition && !thrown) { thrown = true; throw new Error("injected failure"); } };
    f.b.context.appendSheetRecord_ = (sheet, row) => { const r = append(sheet, row); interrupt(stage === "journal" && sheet === "SystemRequests" && row.action === "updatePractice"); return r; };
    f.b.context.updateSheetRecord_ = (sheet, row) => { const r = update(sheet, row); interrupt(stage === "completion" && sheet === "SystemRequests" && row.action === "updatePractice" && row.status === "COMPLETED"); return r; };
    f.b.context.updateSeasonSheetRecord_ = (season, sheet, row) => { const r = runtime(season, sheet, row); interrupt((stage === "practice" && sheet === "Practices") || (stage === "week" && sheet === "TrainingWeeks")); return r; };
    f.b.context.appendSeasonSheetRecord_ = (season, sheet, row) => { const r = audit(season, sheet, row); interrupt(stage === "audit" && sheet === "AuditLog" && row.action === "updatePractice"); return r; };
    fails(f.send("updatePractice", body, "recover_schedule_change"), "INTERNAL_ERROR");
    f.b.context.appendSheetRecord_ = append; f.b.context.updateSheetRecord_ = update;
    f.b.context.updateSeasonSheetRecord_ = runtime; f.b.context.appendSeasonSheetRecord_ = audit;
    assert.equal(f.practice().location, "Recovered Dock");
    assert.equal(f.practice().practice_version, body.practice_version + 1);
    ok(f.send("updatePractice", body, "recover_schedule_change"));
    assert.equal(sheetRecords(f.binding.runtimeSpreadsheet, "AuditLog").filter(e => e.action === "updatePractice").length, 1);
  });
});

test("P1 committed change with a failed view still succeeds and a retry only replays the result", async () => {
  const f = await fixture();
  const body = f.preview("UPDATE", { location: "Saved Dock" });
  const project = f.b.context.trainingWeekManagementProjection_;
  f.b.context.trainingWeekManagementProjection_ = (season, week, planned) => {
    if (!planned) throw new Error("projection failed");
    return project(season, week, planned);
  };
  const saved = ok(f.send("updatePractice", body, "saved_failed_view"));
  assert.equal(saved.view_status, "reload_required");
  f.b.context.trainingWeekManagementProjection_ = project;
  const replay = ok(f.send("updatePractice", body, "saved_failed_view"));
  assert.equal(replay.view_status, "ready");
  assert.equal(f.practice().practice_version, body.practice_version + 1);
});

test("P1 a delayed scheduled trigger publishes the confirmed batch without extending signup deadlines", async () => {
  const f = await fixture(); ok(f.open({ open_date: "2026-09-09", open_time: "09:59" }));
  f.time("2026-09-09T14:03:00Z");
  assert.equal(f.b.context.publishDueTrainingWeeks().published_count, 1);
  const view = ok(f.get("practice", { practice_id: f.practice().practice_id }));
  assert.equal(view.signup_open, false);
  assert.equal(view.practice.signup_cutoff_at, "2026-09-09T12:00:00.000Z");
});
test("P1 Version 11 completed schedule requests remain idempotent after deployment", async () => {
  const f = await fixture(); const week = f.weekData().week;
  const input = { season_id: f.season.season_id, week_id: week.week_id, week_version: week.week_version };
  const digest = f.b.context.digestRequestPayload_({ ...input, open_at: "IMMEDIATE" });
  const original = { week: { ...week, status: "OPENED" }, practices: [] };
  const request = f.b.context.beginSystemRequest_("coach_alpha", "confirmTrainingWeek", "legacy_completed_test", digest, original).record;
  f.b.context.completeSystemRequest_(request);
  const replay = ok(f.send("confirmTrainingWeek", input, "legacy_completed_test"));
  assert.deepEqual(replay.week, original.week);
  assert.equal(f.weekData().week.status, "DRAFT");
  fails(f.send("confirmTrainingWeek", { ...input, open_at: "2026-09-05T12:00:00Z" }, "legacy_completed_test"), "IDEMPOTENCY_CONFLICT");
});
test("P1 switching between initialized seasons never migrates names and old completion does not clear the new default", async () => {
  const f = await fixture();
  const binding = f.b.createFormBinding({ formId: "form-second-1234567890", spreadsheetId: "runtime-second-1234567890",
    rows: [["2026-09-04T12:00:00Z", "New Season Only"]] });
  const draft = ok(f.send("createSeason", { name: "Second Season", start_date: "2026-09-01", end_date: "2027-01-31", timezone: "America/New_York" })).season;
  const second = ok(f.send("initializeSeason", { season_id: draft.season_id, season_version: draft.season_version,
    form: binding.formId, spreadsheet: binding.spreadsheetId, response_sheet: binding.responseSheet.getName(), display_name_header: "Display Name" })).season;
  ok(f.send("setDefaultSeason", { season_id: second.season_id, season_version: second.season_version, settings_version: f.management().settings_version }));
  assert.equal(ok(f.get("bootstrap", { season_id: "" })).season.season_id, second.season_id);
  assert.equal(ok(f.get("members")).members.length, 2);
  assert.equal(ok(f.get("members", { season_id: second.season_id })).members[0].display_name, "New Season Only");
  f.time("2027-01-01T05:00:00Z");
  assert.equal(f.management().season.status, "COMPLETED");
  assert.equal(ok(f.get("bootstrap", { season_id: "" })).season.season_id, second.season_id);
});
