// Explicit, bounded live acceptance. Creates a new week only in the dedicated
// two-member fixture; it never edits P1 Acceptance 2026 training or membership.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

assert(process.argv.includes("--write-test-data") && process.env.DBT_API_URL && process.env.DBT_COACH_CODE,
  "Supply runtime DBT_API_URL/DBT_COACH_CODE and --write-test-data.");
const run = randomUUID().replaceAll("-", "_");
let token, seasonId, originalDefault, switchedVersion, unknownWrite, ownWeek;
let sequence = 0;
let scenarioCompleted = false;
const checks = [];
const readActions = new Set(["health", "bootstrap", "members", "practice", "coachBootstrap", "getSeasonManagement", "getSeatingWorkspace", "previewPracticeChange"]);
const id = () => `p1_live_${run}_${++sequence}`;
function ok(r) { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; }
function denied(r, code) { assert.equal(r.ok, false); assert.equal(r.error.code, code); }
function pass(name) { checks.push(name); console.log(`PASS ${name}`); }
function seatingHistory(plan) {
  // The final-correction deadline follows a rescheduled training's end time.
  // It is derived schedule metadata, not an immutable seating revision field.
  const { archive_due_at, ...history } = plan;
  return history;
}
async function request(action, input = {}, requestId = id()) {
  const body = { action, request_id: requestId, ...(token ? { session_token: token } : {}), ...input };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(process.env.DBT_API_URL, { method: "POST", redirect: "follow",
        headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
      const value = await response.json();
      if (value.ok || (value.error && !value.error.retryable)) return value;
      throw new Error(`${action}: ${value.error?.code || "unreadable response"}`);
    } catch (error) {
      if (attempt === 2) {
        if (!readActions.has(action)) unknownWrite = { action, request_id: requestId };
        throw error;
      }
      console.log(`Retry original ${action} request; no new request ID.`);
    }
  }
}
const management = async () => ok(await request("getSeasonManagement", { season_id: seasonId }));
const detail = async practiceId => ok(await request("practice", { season_id: seasonId, practice_id: practiceId }));
const week = async () => (await management()).weeks.find(w => w.week.week_id === ownWeek);
function fields(p) {
  const parts = iso => Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: p.timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date(iso)).map(part => [part.type, part.value]));
  const s = parts(p.start_at), e = parts(p.end_at);
  return { practice_date: `${s.year}-${s.month}-${s.day}`, start_time: `${s.hour}:${s.minute}`, end_time: `${e.hour}:${e.minute}`,
    timezone: p.timezone, location: p.location, address: p.address, map_url: p.map_url };
}
async function preview(p, change = "UPDATE", patch = {}) {
  assert.equal(p.week_id, ownWeek, "Only this run's week may be mutated.");
  const input = { season_id: seasonId, week_id: ownWeek, practice_id: p.practice_id, change,
    ...(change === "UPDATE" ? { ...fields(p), ...patch } : {}) };
  const result = ok(await request("previewPracticeChange", input));
  return { ...input, practice_version: result.practice_version, week_version: result.week_version,
    signup_version: result.signup_version, preview_token: result.preview_token };
}
async function signup(p, memberId) {
  const view = await detail(p.practice_id);
  return ok(await request("signupByCoach", { season_id: seasonId, practice_id: p.practice_id, member_id: memberId,
    preference: "LEFT", practice_version: view.practice.practice_version, signup_version: view.signup_version }));
}

async function verifyRetainedHistory(m) {
  const w = m.weeks.find(w => w.week.week_start_date === "2026-09-21");
  assert.ok(w && w.week.status === "OPENED");
  assert.equal(w.practices.length, 3);
  assert.ok(w.practices.every(p => p.cancelled));
  const target = w.practices.find(p => p.location === "P1 API Cross Week Dock");
  assert.ok(target);
  const view = await detail(target.practice_id);
  assert.equal(view.closed_reason, "PRACTICE_CANCELLED");
  assert.equal(view.signup_open, false);
  assert.equal(view.management_signup_open, false);
  assert.deepEqual(view.signups.map(s => s.display_name), ["P1 Management Alice", "P1 Management Bob"]);
  assert.ok(view.signups.every(s => s.preference === "LEFT" && s.status === "CONFIRMED"));
  assert.ok(view.signups[0].queue_at <= view.signups[1].queue_at);
  assert.ok(view.signups[0].queue_sequence < view.signups[1].queue_sequence);
  assert.equal(view.practice.week_id, w.week.week_id);
  assert.equal(fields(view.practice).practice_date, "2026-09-28");
  assert.equal(Date.parse(view.seat_plan.archive_due_at), Date.parse(view.practice.end_at) + 86400000);
  assert.equal(view.seat_plan.published_revision, 1);
  assert.equal(view.seat_plan.seat_plan_version, 1);
  assert.equal(view.seat_plan.seats.length, 1);
  assert.equal(view.seat_plan.seats[0].display_name, "P1 Management Alice");
  assert.equal(view.seat_plan.seats[0].row_number, 1);
  assert.equal(view.seat_plan.seats[0].side, "LEFT");
  assert.equal(view.seat_plan.coach, null);
  assert.equal(view.seat_plan.steerer, null);
  pass("retained cancellation history and rescheduled 24-hour deadline independently verified");

  const body = { season_id: seasonId, season_version: m.season.season_version,
    start_date: m.season.start_date, end_date: m.season.end_date };
  const requestId = id();
  const first = ok(await request("updateSeasonSchedule", body, requestId));
  const replay = ok(await request("updateSeasonSchedule", body, requestId));
  assert.deepEqual(replay.season, first.season);
  assert.equal((await management()).season.season_version, m.season.season_version + 1);
  denied(await request("updateSeasonSchedule", { ...body, end_date: "2026-10-02" }, requestId), "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(seatingHistory((await detail(target.practice_id)).seat_plan), seatingHistory(view.seat_plan));
  pass("P1 immutable request replay does not advance versions twice; altered payload rejected");
}

try {
  const health = ok(await request("health"));
  assert.equal(health.service_version, "0.7.0-p1-management");
  const login = ok(await request("coachLogin", { coach_code: process.env.DBT_COACH_CODE }));
  token = login.session_token;
  const entry = ok(await request("coachBootstrap"));
  const matches = entry.seasons.filter(s => s.name === "P1 Management Acceptance 2026");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "OPEN");
  assert.equal(matches[0].timezone, "America/New_York");
  assert.equal(matches[0].start_date, "2026-09-01");
  assert.ok(["2026-09-30", "2026-10-01"].includes(matches[0].end_date));
  seasonId = matches[0].season_id;
  let m = await management();
  assert.deepEqual(m.members.map(x => x.display_name).sort(), ["P1 Management Alice", "P1 Management Bob"]);
  if (process.argv.includes("--verify-retained-history")) {
    await verifyRetainedHistory(m);
  } else {
  assert.ok(!m.weeks.some(w => w.week.week_start_date === "2026-09-21"), "Refuse to reuse another run's week.");
  originalDefault = entry.default_season_id;
  assert.ok(originalDefault && originalDefault !== seasonId);
  const originalPublic = ok(await request("bootstrap", { season_id: originalDefault }));
  assert.equal(originalPublic.season.name, "P1 Acceptance 2026");
  pass("fixture ownership and original season isolation");

  const switched = ok(await request("setDefaultSeason", { season_id: seasonId, season_version: m.season.season_version, settings_version: m.settings_version }));
  switchedVersion = switched.settings_version;
  assert.equal(ok(await request("bootstrap")).season.season_id, seasonId);
  assert.deepEqual(ok(await request("members", { season_id: seasonId })).members.map(x => x.display_name).sort(), ["P1 Management Alice", "P1 Management Bob"]);
  assert.deepEqual(ok(await request("bootstrap", { season_id: originalDefault })).weeks, originalPublic.weeks);
  denied(await request("setDefaultSeason", { season_id: seasonId, season_version: m.season.season_version, settings_version: m.settings_version }), "VERSION_CONFLICT");
  pass("default switching, explicit old links and stale settings rejection");

  m = await management();
  const previousEnd = m.season.end_date;
  const targetEnd = previousEnd === "2026-09-30" ? "2026-10-01" : "2026-09-30";
  ok(await request("updateSeasonSchedule", { season_id: seasonId, season_version: m.season.season_version, start_date: m.season.start_date, end_date: targetEnd }));
  m = await management();
  assert.equal(m.season.end_date, targetEnd);
  ok(await request("updateSeasonSchedule", { season_id: seasonId, season_version: m.season.season_version, start_date: m.season.start_date, end_date: previousEnd }));
  pass("season dates persist and restore with fresh versions");

  m = await management();
  if (!m.templates.length) {
    ok(await request("updateScheduleTemplates", { season_id: seasonId, season_version: m.season.season_version,
      templates: [3, 6].map(day => ({ day_of_week: day, start_time: "10:00", end_time: "12:00", location: "P1 Management Test Dock", address: "2 Test River Road", map_url: "" })) }));
    m = await management();
  }
  const templates = m.templates;
  const prepared = ok(await request("updateTrainingWeek", { season_id: seasonId, season_version: m.season.season_version, week_start_date: "2026-09-21" }));
  ownWeek = prepared.week.week_id;
  assert.equal(prepared.practices.length, 2);
  let [p, removed] = prepared.practices;
  ok(await request("updatePractice", await preview(p, "UPDATE", { start_time: "10:30", location: "P1 API Revised Dock" })));
  ok(await request("cancelPractice", await preview(removed, "CANCEL")));
  let w = await week();
  ok(await request("createPractice", { season_id: seasonId, week_id: ownWeek, week_version: w.week.week_version,
    practice_date: "2026-09-24", start_time: "09:00", end_time: "11:00", location: "P1 API Extra Dock", address: "3 Test River Road" }));
  m = await management();
  assert.deepEqual(m.templates, templates);
  const regenerated = ok(await request("updateTrainingWeek", { season_id: seasonId, season_version: m.season.season_version, week_start_date: "2026-09-21" }));
  assert.equal(regenerated.practices.length, 3);
  assert.equal(regenerated.practices.filter(x => x.cancelled).length, 1);
  assert.ok(!ok(await request("bootstrap", { season_id: seasonId })).weeks.some(x => x.week_id === ownWeek));
  pass("private instance edits, deletion tombstone, extra training and unchanged templates");

  w = await week();
  const abandonedTime = new Date(Date.now() + 60000).toISOString();
  ok(await request("confirmTrainingWeek", { season_id: seasonId, week_id: ownWeek, week_version: w.week.week_version, open_at: abandonedTime }));
  w = await week(); p = w.practices.find(x => x.practice_id === p.practice_id);
  ok(await request("updatePractice", await preview(p, "UPDATE", { address: "4 Test River Road" })));
  w = await week();
  assert.equal(w.week.status, "DRAFT");
  assert.equal(w.week.scheduled_open_at, "");
  // Reconfirm later than the abandoned appointment. The real five-minute Google
  // trigger, not this script, must publish the new confirmed version.
  const newTime = new Date(Date.now() + 3 * 60000);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(newTime).map(p => [p.type, p.value]));
  const scheduled = ok(await request("confirmTrainingWeek", { season_id: seasonId, week_id: ownWeek, week_version: w.week.week_version,
    open_date: `${parts.year}-${parts.month}-${parts.day}`, open_time: `${parts.hour}:${parts.minute}` }));
  assert.equal(scheduled.week.status, "SCHEDULED");
  console.log(`Google trigger appointment: ${scheduled.week.scheduled_open_at}`);
  m = await management();
  denied(await request("updateSeasonSchedule", { season_id: seasonId, season_version: m.season.season_version,
    start_date: "2026-09-01", end_date: "2026-09-22" }), "SEASON_SCHEDULE_CONFLICT");
  pass("schedule confirmation invalidation, local-time reconfirmation and season bounds rejection");
  const deadline = Date.now() + 11 * 60000;
  while (Date.now() < deadline) {
    w = await week();
    if (w.week.status === "OPENED") break;
    assert.equal(w.week.status, "SCHEDULED");
    assert.ok(!ok(await request("bootstrap", { season_id: seasonId })).weeks.some(x => x.week_id === ownWeek));
    console.log("Waiting for Google scheduled trigger; confirmed week remains private.");
    await new Promise(resolve => setTimeout(resolve, 45000));
  }
  assert.equal(w.week.status, "OPENED", "Google scheduler did not publish within observation window.");
  assert.ok(Date.parse(w.week.published_at) >= Date.parse(scheduled.week.scheduled_open_at));
  assert.equal(ok(await request("bootstrap", { season_id: seasonId })).weeks.find(x => x.week_id === ownWeek).practices.length, 2);
  pass("real Google scheduled trigger published the confirmed batch once");

  p = w.practices.find(x => x.practice_id === p.practice_id);
  const alice = m.members.find(x => x.display_name === "P1 Management Alice").member_id;
  const bob = m.members.find(x => x.display_name === "P1 Management Bob").member_id;
  await signup(p, alice);
  let seating = ok(await request("getSeatingWorkspace", { season_id: seasonId, practice_id: p.practice_id }));
  const seats = Array.from({ length: 10 }, (_, i) => ["LEFT", "RIGHT"].map(side => ({ row_number: i + 1, side, member_id: i === 0 && side === "LEFT" ? alice : "" }))).flat();
  seating = ok(await request("saveSeatPlanDraft", { season_id: seasonId, practice_id: p.practice_id, practice_version: p.practice_version,
    signup_version: seating.signup_version, seat_plan_version: seating.seat_plan_version, coach_member_id: "", steerer_member_id: "", seats, change_kind: "EDIT" }));
  ok(await request("publishSeatPlan", { season_id: seasonId, practice_id: p.practice_id, practice_version: p.practice_version,
    signup_version: seating.signup_version, seat_plan_version: seating.seat_plan_version, published_revision: seating.published_revision, acknowledge_preference_mismatch: false }));
  const stale = await preview(p, "UPDATE", { practice_date: "2026-09-28", location: "P1 API Cross Week Dock" });
  await signup(p, bob);
  denied(await request("updatePractice", stale), "VERSION_CONFLICT");
  const before = await detail(p.practice_id);
  const body = await preview(p, "UPDATE", { practice_date: "2026-09-28", location: "P1 API Cross Week Dock" });
  const changeId = id();
  const changed = ok(await request("updatePractice", body, changeId));
  const after = await detail(p.practice_id);
  assert.equal(after.practice.practice_id, p.practice_id);
  assert.equal(after.practice.week_id, ownWeek);
  assert.deepEqual(after.signups, before.signups);
  assert.deepEqual(seatingHistory(after.seat_plan), seatingHistory(before.seat_plan));
  assert.equal(Date.parse(after.seat_plan.archive_due_at), Date.parse(after.practice.end_at) + 86400000);
  const replay = ok(await request("updatePractice", body, changeId));
  assert.deepEqual(replay.practice, changed.practice);
  assert.equal(replay.current_view.practices.find(x => x.practice_id === p.practice_id).practice_version, after.practice.practice_version);
  pass("stale preview rejected; cross-week reschedule and replay preserve queues and published seating");
  ok(await request("cancelPractice", await preview(after.practice, "CANCEL")));
  const cancelled = await detail(p.practice_id);
  assert.equal(cancelled.closed_reason, "PRACTICE_CANCELLED");
  assert.equal(cancelled.management_signup_open, false);
  assert.deepEqual(cancelled.signups, before.signups);
  assert.deepEqual(seatingHistory(cancelled.seat_plan), seatingHistory(before.seat_plan));
  pass("public cancellation retains signup and seating history and closes writes");
  }
  scenarioCompleted = true;
} finally {
  if (token && !unknownWrite) {
    if (ownWeek) {
      for (const p of (await week()).practices.filter(p => !p.cancelled)) {
        ok(await request("cancelPractice", await preview(p, "CANCEL")));
      }
      pass("only this run's future test practices cancelled; history retained");
    }
    if (switchedVersion) {
      const entry = ok(await request("coachBootstrap"));
      assert.equal(entry.default_season_id, seasonId, "Default changed externally; manual review required.");
      assert.equal(entry.settings_version, switchedVersion, "Default version changed externally; do not overwrite.");
      const old = entry.seasons.find(s => s.season_id === originalDefault);
      ok(await request("setDefaultSeason", { season_id: originalDefault, season_version: old.season_version, settings_version: entry.settings_version }));
      assert.equal(ok(await request("bootstrap")).season.season_id, originalDefault);
      pass("original default season restored");
    }
    ok(await request("coachLogout"));
    denied(await request("coachBootstrap"), "SESSION_REVOKED");
    pass("owned API session logged out and protected read rejected");
  }
  console.log(JSON.stringify({ scenario_completed: scenarioCompleted, passed: checks.length, checks, unknown_write: unknownWrite || null }));
}
