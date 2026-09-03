import assert from "node:assert/strict";
import test from "node:test";

import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

const INITIAL_TIME = "2026-09-02T12:00:00.000Z";

function expectSuccess(response) {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}

function expectError(response, code) {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code, JSON.stringify(response));
}

async function createFixture(memberCount = 30) {
  const backend = await createBackend({ properties: { DRAGON_BOAT_SESSION_TTL_SECONDS: "86400" } });
  let currentTime = Date.parse(INITIAL_TIME);
  let requestNumber = 0;
  backend.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  };
  const requestId = () => `p2_test_${String(++requestNumber).padStart(6, "0")}`;
  const send = (action, input = {}) => post(backend.context, { action, request_id: requestId(), ...input });
  const token = expectSuccess(send("coachLogin", { coach_code: "coach-code-123" })).session_token;
  const binding = backend.createFormBinding({
    rows: Array.from({ length: memberCount }, (_, index) => [INITIAL_TIME, `Member ${String(index + 1).padStart(2, "0")}`])
  });
  const draft = expectSuccess(send("createSeason", {
    session_token: token, name: "P2 Fixture", start_date: "2026-09-01", end_date: "2026-12-31", timezone: "America/New_York"
  })).season;
  const initialized = expectSuccess(send("initializeSeason", {
    session_token: token, season_id: draft.season_id, season_version: draft.season_version,
    form: binding.formId, spreadsheet: binding.spreadsheetId,
    response_sheet: binding.responseSheet.getName(), display_name_header: "Display Name"
  })).season;
  const template = { day_of_week: 3, start_time: "14:00", end_time: "16:00", location: "P2 Dock", address: "2 River Road", map_url: "" };
  const season = expectSuccess(send("updateScheduleTemplates", {
    session_token: token, season_id: initialized.season_id, season_version: initialized.season_version, templates: [template]
  })).season;
  const weekDraft = expectSuccess(send("updateTrainingWeek", {
    session_token: token, season_id: season.season_id, season_version: season.season_version, week_start_date: "2026-08-31"
  }));
  const week = expectSuccess(send("confirmTrainingWeek", {
    session_token: token, season_id: season.season_id,
    week_id: weekDraft.week.week_id, week_version: weekDraft.week.week_version
  }));
  const practice = week.practices[0];
  const members = sheetRecords(binding.runtimeSpreadsheet, "Members");
  const storedSeason = () => backend.context.requireSeason_(season.season_id);
  const get = (action, input = {}) => payload(backend.context.doGet({
    parameter: { action, request_id: requestId(), season_id: season.season_id, ...input }
  }));
  const body = (action, memberIndex, preference = "AMBIENT", extra = {}) => ({
    action, request_id: requestId(), season_id: season.season_id, practice_id: practice.practice_id,
    member_id: members[memberIndex].member_id, preference,
    practice_version: Number(backend.context.requirePractice_(storedSeason(), practice.practice_id).practice_version),
    signup_version: backend.context.getSignupState_(storedSeason(), practice.practice_id).version,
    ...(/ByCoach$/.test(action) ? { session_token: token } : {}), ...extra
  });
  const mutate = (action, memberIndex, preference = "AMBIENT", extra = {}) => {
    const response = post(backend.context, body(action, memberIndex, preference, extra));
    currentTime += 1;
    return response;
  };
  const memberBody = (action, memberIndex, input = {}) => ({
    action, request_id: requestId(), session_token: token, season_id: season.season_id,
    member_id: members[memberIndex].member_id,
    member_version: Number(backend.context.requireSeasonMember_(storedSeason(), members[memberIndex].member_id).member_version),
    ...input
  });
  return {
    backend, binding, token, season, template, week, practice, members, requestId, send, get,
    body, mutate, memberBody, storedSeason,
    setTime(value) { currentTime = typeof value === "number" ? value : Date.parse(value); },
    now() { return currentTime; },
    detail() { return expectSuccess(get("practice", { practice_id: practice.practice_id })); },
    signupRows() { return sheetRecords(binding.runtimeSpreadsheet, "SignupsCurrent"); }
  };
}

function fill(fixture, start, count, preference) {
  for (let index = start; index < start + count; index += 1) {
    expectSuccess(fixture.mutate("signup", index, preference));
  }
}

test("P2.1 public commit returns a current view without storing it in the immutable result", async () => {
  const f = await createFixture();
  const request = f.body("signup", 0, "LEFT", { include_current_view: true });
  const result = expectSuccess(post(f.backend.context, request));
  assert.equal(result.view_status, "ready");
  assert.equal(result.current_view.practice.counts.confirmed, 1);
  assert.equal(result.current_view.practice.signup_version, result.signup_version);
  assert.ok(result.current_view.roster.members.length);
  assert.equal(result.current_view.members, undefined);
  assert.equal(result.current_view.member_links, undefined);
  assert.equal(JSON.stringify(sheetRecords(f.backend.spreadsheet, "SystemRequests")).includes('current_view'), false);
  expectSuccess(f.mutate("cancelSignup", 0));
  const replay = expectSuccess(post(f.backend.context, request));
  assert.equal(replay.signup.status, "CONFIRMED", "immutable operation result is preserved");
  assert.equal(replay.current_view.practice.counts.confirmed, 0, "replay reads the current state");
  assert.equal(f.signupRows().length, 1);
});

test("P2.1 projection failure preserves a successful commit and replay cannot duplicate it", async () => {
  const f = await createFixture();
  const request = f.body("signup", 0, "LEFT", { include_current_view: true });
  const original = f.backend.context.publicPractice_;
  f.backend.context.publicPractice_ = () => { throw new Error("projection interrupted"); };
  const result = expectSuccess(post(f.backend.context, request));
  assert.equal(result.view_status, "refresh_required");
  assert.equal(result.current_view, null);
  f.backend.context.publicPractice_ = original;
  const replay = expectSuccess(post(f.backend.context, request));
  assert.equal(replay.view_status, "ready");
  assert.equal(replay.signup_version, result.signup_version);
  assert.equal(replay.current_view.practice.counts.confirmed, 1);
  assert.equal(f.signupRows().length, 1);
});

test("P2.1 workspace authenticates and management writes return fresh names and associations", async () => {
  const f = await createFixture();
  expectError(f.send("getMemberWorkspace", { season_id: f.season.season_id }), "INVALID_REQUEST");
  const workspace = expectSuccess(f.send("getMemberWorkspace", { season_id: f.season.season_id, session_token: f.token }));
  assert.equal(workspace.members.length, 30);
  assert.equal(workspace.practices.length, 1);
  assert.equal(workspace.practice.practice.practice_id, f.practice.practice_id);
  const signup = expectSuccess(f.mutate("signupByCoach", 0, "LEFT", { include_current_view: true, known_roster_version: workspace.roster_version }));
  assert.equal(signup.current_view.members, undefined);
  assert.equal(signup.current_view.member_links[f.members[0].member_id].length, 1);
  const renamed = expectSuccess(post(f.backend.context, f.memberBody("updateMember", 0, {
    display_name_override: "Corrected", default_preference: "RIGHT", include_current_view: true,
    known_roster_version: workspace.roster_version, view_practice_id: f.practice.practice_id
  })));
  assert.equal(renamed.current_view.members[0].display_name, "Corrected");
  assert.equal(renamed.current_view.practice.signups[0].display_name, "Corrected");
  assert.equal(renamed.current_view.practice.signups[0].preference, "LEFT");
  expectSuccess(f.send("coachLogout", { session_token: f.token }));
  assert.equal(f.send("getMemberWorkspace", { season_id: f.season.season_id, session_token: f.token }).ok, false);
});

test("P2.1 roster reuse requires matching version and a live expiry; replay observes cutoff", async () => {
  const f = await createFixture();
  const roster = expectSuccess(f.get("members"));
  const request = f.body("signup", 0, "LEFT", { include_current_view: true,
    known_roster_version: roster.roster_version, roster_expires_at: roster.expires_at });
  assert.equal(expectSuccess(post(f.backend.context, request)).current_view.roster, undefined);
  f.setTime(Date.parse(roster.expires_at));
  assert.ok(expectSuccess(post(f.backend.context, request)).current_view.roster);
  f.setTime(f.practice.signup_cutoff_at);
  const replay = expectSuccess(post(f.backend.context, request));
  assert.equal(replay.current_view.practice.signup_open, false);
  assert.equal(replay.current_view.practice.counts.confirmed, 1);
});

function interruptOnceAfter(fixture, method, predicate) {
  const original = fixture.backend.context[method];
  let fired = false;
  fixture.backend.context[method] = (...args) => {
    const result = original(...args);
    if (!fired && predicate(...args)) {
      fired = true;
      throw new Error(`Injected failure after ${method}`);
    }
    return result;
  };
  return () => {
    fixture.backend.context[method] = original;
    assert.equal(fired, true, `Fault injection ${method} was not reached`);
  };
}

test("P2 permits twenty Ambient confirmations and enforces total and explicit side capacities", async () => {
  const ambient = await createFixture();
  fill(ambient, 0, 20, "AMBIENT");
  assert.equal(expectSuccess(ambient.mutate("signup", 20, "AMBIENT")).signup.status, "WAITLISTED");
  assert.equal(ambient.detail().counts.ambient, 20);
  assert.equal(ambient.detail().counts.confirmed, 20);

  const sides = await createFixture();
  fill(sides, 0, 10, "LEFT");
  assert.equal(expectSuccess(sides.mutate("signup", 10, "LEFT")).signup.status, "WAITLISTED");
  fill(sides, 11, 10, "RIGHT");
  assert.equal(expectSuccess(sides.mutate("signup", 21, "RIGHT")).signup.status, "WAITLISTED");
  assert.equal(expectSuccess(sides.mutate("signup", 22, "AMBIENT")).signup.status, "WAITLISTED");
  assert.deepEqual(
    [sides.detail().counts.left, sides.detail().counts.right, sides.detail().counts.confirmed], [10, 10, 20]
  );
});

test("P2 waitlists keep timestamp and sequence order and skip a candidate incompatible with the vacancy", async () => {
  const fixture = await createFixture();
  fill(fixture, 0, 10, "LEFT");
  fill(fixture, 10, 10, "RIGHT");
  const sameTime = fixture.now();
  const first = expectSuccess(fixture.mutate("signup", 20, "RIGHT")).signup;
  fixture.setTime(sameTime);
  const second = expectSuccess(fixture.mutate("signup", 21, "AMBIENT")).signup;
  fixture.setTime(sameTime);
  const third = expectSuccess(fixture.mutate("signup", 22, "LEFT")).signup;
  assert.equal(first.queue_at, second.queue_at);
  assert.equal(second.queue_at, third.queue_at);
  assert.ok(first.queue_sequence < second.queue_sequence && second.queue_sequence < third.queue_sequence);

  const leftCancellation = expectSuccess(fixture.mutate("cancelSignup", 0));
  assert.deepEqual(leftCancellation.promoted_member_ids, [fixture.members[21].member_id]);
  const rightCancellation = expectSuccess(fixture.mutate("cancelSignup", 10));
  assert.deepEqual(rightCancellation.promoted_member_ids, [fixture.members[20].member_id]);
  const final = fixture.detail();
  assert.equal(final.counts.confirmed, 20);
  assert.equal(final.signups.find((signup) => signup.member_id === fixture.members[22].member_id).status, "WAITLISTED");
});

test("P2 changing side keeps queue priority but returning to a replaced seat cannot displace its replacement", async () => {
  const fixture = await createFixture();
  fill(fixture, 0, 10, "LEFT");
  fill(fixture, 10, 10, "RIGHT");
  const original = fixture.detail().signups.find((signup) => signup.member_id === fixture.members[0].member_id);
  expectSuccess(fixture.mutate("signup", 20, "LEFT"));
  const changed = expectSuccess(fixture.mutate("updateSignup", 0, "RIGHT"));
  assert.equal(changed.signup.status, "WAITLISTED");
  assert.equal(changed.signup.queue_at, original.queue_at);
  assert.equal(changed.signup.queue_sequence, original.queue_sequence);
  assert.deepEqual(changed.promoted_member_ids, [fixture.members[20].member_id]);

  const returned = expectSuccess(fixture.mutate("updateSignup", 0, "LEFT"));
  assert.equal(returned.signup.status, "WAITLISTED");
  assert.equal(returned.signup.queue_at, original.queue_at);
  assert.deepEqual(returned.promoted_member_ids, []);
  assert.equal(fixture.detail().signups.find((signup) => signup.member_id === fixture.members[20].member_id).status, "CONFIRMED");
  const cancelledReplacement = expectSuccess(fixture.mutate("cancelSignup", 20));
  assert.deepEqual(cancelledReplacement.promoted_member_ids, [fixture.members[0].member_id]);
});

test("P2 a direct side change can confirm a waiter; a same-preference save never changes the queue", async () => {
  const fixture = await createFixture();
  fill(fixture, 0, 10, "LEFT");
  const waiting = expectSuccess(fixture.mutate("signup", 10, "LEFT")).signup;
  const changed = expectSuccess(fixture.mutate("updateSignup", 10, "RIGHT"));
  assert.equal(changed.signup.status, "CONFIRMED");
  assert.equal(changed.signup.queue_at, waiting.queue_at);
  assert.equal(changed.signup.queue_sequence, waiting.queue_sequence);
  const rowsBefore = fixture.signupRows();
  const stateBefore = fixture.backend.context.getSignupState_(fixture.storedSeason(), fixture.practice.practice_id);
  const unchanged = expectSuccess(fixture.mutate("updateSignup", 10, "RIGHT"));
  assert.equal(unchanged.signup_version, changed.signup_version);
  assert.deepEqual(unchanged.promoted_member_ids, []);
  assert.deepEqual(fixture.signupRows(), rowsBefore);
  assert.deepEqual(fixture.backend.context.getSignupState_(fixture.storedSeason(), fixture.practice.practice_id), stateBefore);
});

test("P2 cancelling and signing up again keeps one current row and allocates a new queue position", async () => {
  const fixture = await createFixture();
  const first = expectSuccess(fixture.mutate("signup", 0, "LEFT")).signup;
  expectSuccess(fixture.mutate("signup", 1, "LEFT"));
  expectSuccess(fixture.mutate("cancelSignup", 0));
  const rejoined = expectSuccess(fixture.mutate("signup", 0, "RIGHT")).signup;
  assert.ok(rejoined.queue_at > first.queue_at);
  assert.ok(rejoined.queue_sequence > first.queue_sequence);
  assert.equal(rejoined.queue_sequence, 3);
  assert.equal(fixture.signupRows().length, 2);
  const firstMember = fixture.signupRows().filter((signup) => signup.member_id === fixture.members[0].member_id);
  assert.equal(firstMember.length, 1);
  assert.equal(firstMember[0].status, "CONFIRMED");
});

test("P2 stale versions cannot take a second last seat; a refreshed retry joins the waitlist", async () => {
  const fixture = await createFixture();
  fill(fixture, 0, 19, "AMBIENT");
  const first = fixture.body("signup", 19);
  const competing = fixture.body("signup", 20);
  assert.equal(first.signup_version, competing.signup_version);
  assert.equal(expectSuccess(post(fixture.backend.context, first)).signup.status, "CONFIRMED");
  expectError(post(fixture.backend.context, competing), "VERSION_CONFLICT");
  assert.equal(fixture.detail().counts.confirmed, 20);
  assert.equal(fixture.signupRows().length, 20);
  assert.equal(expectSuccess(fixture.mutate("signup", 20)).signup.status, "WAITLISTED");
  expectError(fixture.mutate("signup", 21, "AMBIENT", { practice_version: fixture.practice.practice_version - 1 }), "VERSION_CONFLICT");
});

test("P2 enforces the exact ordinary cutoff and management end boundary for every signup mutation", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  fixture.setTime(Date.parse(fixture.practice.signup_cutoff_at) - 1);
  expectSuccess(fixture.mutate("updateSignup", 0, "RIGHT"));
  fixture.setTime(fixture.practice.signup_cutoff_at);
  expectError(fixture.mutate("signup", 1), "SIGNUP_CLOSED");
  expectError(fixture.mutate("updateSignup", 0, "LEFT"), "SIGNUP_CLOSED");
  expectError(fixture.mutate("cancelSignup", 0), "SIGNUP_CLOSED");
  expectSuccess(fixture.mutate("updateSignupByCoach", 0, "LEFT"));
  expectSuccess(fixture.mutate("signupByCoach", 1, "RIGHT"));
  fixture.setTime(Date.parse(fixture.practice.end_at) - 1);
  expectSuccess(fixture.mutate("cancelSignupByCoach", 1));
  fixture.setTime(fixture.practice.end_at);
  expectError(fixture.mutate("signupByCoach", 2), "PRACTICE_ENDED");
  expectError(fixture.mutate("updateSignupByCoach", 0, "AMBIENT"), "PRACTICE_ENDED");
  expectError(fixture.mutate("cancelSignupByCoach", 0), "PRACTICE_ENDED");
});

test("P2 rejects unpublished practices, invalid membership, cross-season entities, and cancelled practices", async () => {
  const fixture = await createFixture();
  const additional = expectSuccess(fixture.send("createPractice", {
    session_token: fixture.token, season_id: fixture.season.season_id,
    week_id: fixture.week.week.week_id, week_version: fixture.week.week.week_version,
    practice_date: "2026-09-04", start_time: "14:00", end_time: "16:00", location: "Private Dock", address: "3 River Road", map_url: ""
  })).practice;
  expectError(fixture.get("practice", { practice_id: additional.practice_id }), "PRACTICE_NOT_PUBLIC");
  expectError(fixture.mutate("signup", 0, "LEFT", { practice_id: additional.practice_id, practice_version: additional.practice_version }), "PRACTICE_NOT_PUBLIC");
  expectError(fixture.mutate("signup", 0, "LEFT", { member_id: "member_unknown" }), "MEMBER_NOT_FOUND");
  expectError(fixture.mutate("signup", 0, "LEFT", { season_id: "season_unknown" }), "SEASON_NOT_FOUND");

  const stored = fixture.storedSeason();
  const member = fixture.backend.context.requireSeasonMember_(stored, fixture.members[1].member_id);
  member.season_id = "season_another";
  fixture.backend.context.updateSeasonSheetRecord_(stored, "Members", member);
  expectError(fixture.mutate("signup", 1, "LEFT"), "MEMBER_NOT_FOUND");
  const practice = fixture.backend.context.requirePractice_(stored, fixture.practice.practice_id);
  const week = fixture.backend.context.requireTrainingWeek_(stored, practice.week_id);
  week.status = "DRAFT";
  fixture.backend.context.updateSeasonSheetRecord_(stored, "TrainingWeeks", week);
  expectError(fixture.get("practice", { practice_id: practice.practice_id }), "PRACTICE_NOT_PUBLIC");
  expectError(fixture.mutate("signupByCoach", 0), "PRACTICE_NOT_PUBLIC");
  week.status = "OPENED";
  fixture.backend.context.updateSeasonSheetRecord_(stored, "TrainingWeeks", week);
  practice.cancelled_at = INITIAL_TIME;
  fixture.backend.context.updateSeasonSheetRecord_(stored, "Practices", practice);
  expectError(fixture.mutate("signup", 0), "PRACTICE_CANCELLED");
  expectError(fixture.mutate("signupByCoach", 0), "PRACTICE_CANCELLED");
});

test("P2 completed requests replay after cutoff without reverting newer state; altered parameters conflict", async () => {
  const fixture = await createFixture();
  const original = fixture.body("signup", 0, "LEFT");
  const completed = expectSuccess(post(fixture.backend.context, original));
  expectSuccess(fixture.mutate("updateSignup", 0, "RIGHT"));
  fixture.setTime(fixture.practice.signup_cutoff_at);
  assert.deepEqual(expectSuccess(post(fixture.backend.context, original)), completed);
  assert.equal(fixture.signupRows()[0].preference, "RIGHT");
  expectError(post(fixture.backend.context, { ...original, preference: "AMBIENT" }), "IDEMPOTENCY_CONFLICT");
  fixture.setTime("2027-01-01T05:00:00.000Z");
  assert.deepEqual(expectSuccess(post(fixture.backend.context, original)), completed);
  expectError(fixture.mutate("signup", 1), "SEASON_NOT_OPEN");
});

test("P2 management signup requires its own authenticated action and cannot bypass capacity", async () => {
  const fixture = await createFixture();
  expectError(fixture.mutate("signupByCoach", 0, "LEFT", { session_token: "invalid_session_token_12345678901234567890" }), "SESSION_INVALID");
  fill(fixture, 0, 20, "AMBIENT");
  fixture.setTime(fixture.practice.signup_cutoff_at);
  expectError(fixture.mutate("signup", 20, "AMBIENT", { session_token: fixture.token, management: true }), "SIGNUP_CLOSED");
  const managed = expectSuccess(fixture.mutate("signupByCoach", 20, "AMBIENT"));
  assert.equal(managed.signup.status, "WAITLISTED");
  assert.equal(fixture.detail().counts.confirmed, 20);
  expectSuccess(fixture.send("coachLogout", { session_token: fixture.token }));
  expectError(fixture.mutate("cancelSignupByCoach", 0), "SESSION_REVOKED");
});

test("P2 refuses signup changes when a seating plan needs the deferred P3 transition", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  const before = fixture.signupRows();
  fixture.backend.context.appendSeasonSheetRecord_(fixture.storedSeason(), "SeatPlanCurrent", {
    season_id: fixture.season.season_id, practice_id: fixture.practice.practice_id,
    row_number: 1, side: "LEFT", member_id: fixture.members[0].member_id, seat_plan_version: 1
  });
  expectError(fixture.mutate("updateSignup", 0, "RIGHT"), "SEAT_PLAN_REQUIRES_P3");
  expectError(fixture.mutate("cancelSignupByCoach", 0), "SEAT_PLAN_REQUIRES_P3");
  expectError(fixture.mutate("signup", 1), "SEAT_PLAN_REQUIRES_P3");
  assert.deepEqual(fixture.signupRows(), before);
});

test("P2 member corrections invalidate the shared roster, survive sync, and do not alter existing signup preferences", async () => {
  const fixture = await createFixture();
  const signup = expectSuccess(fixture.mutate("signup", 0, "LEFT")).signup;
  const initialRoster = expectSuccess(fixture.get("members"));
  const change = fixture.memberBody("updateMember", 0, { display_name_override: "Corrected Member", default_preference: "RIGHT" });
  const updated = expectSuccess(post(fixture.backend.context, change));
  const refreshed = expectSuccess(fixture.get("members"));
  assert.equal(refreshed.roster_version, initialRoster.roster_version + 1);
  const corrected = refreshed.members.find((member) => member.member_id === fixture.members[0].member_id);
  assert.equal(corrected.display_name, "Corrected Member");
  assert.equal(corrected.default_preference, "RIGHT");
  const currentSignup = fixture.detail().signups.find((row) => row.member_id === signup.member_id);
  assert.equal(currentSignup.display_name, "Corrected Member");
  assert.equal(currentSignup.preference, "LEFT");
  assert.equal(currentSignup.queue_at, signup.queue_at);
  assert.equal(currentSignup.queue_sequence, signup.queue_sequence);
  const synced = expectSuccess(fixture.send("retrySeasonSync", { session_token: fixture.token, season_id: fixture.season.season_id }));
  assert.equal(synced.sync.imported_count, 0);
  const afterSync = expectSuccess(fixture.send("listSeasonMembers", { session_token: fixture.token, season_id: fixture.season.season_id }));
  assert.equal(afterSync.members[0].display_name, "Corrected Member");
  assert.equal(afterSync.members[0].default_preference, "RIGHT");
  expectError(post(fixture.backend.context, { ...change, request_id: fixture.requestId() }), "VERSION_CONFLICT");
  const restored = expectSuccess(post(fixture.backend.context, fixture.memberBody("restoreMemberName", 0)));
  assert.equal(restored.member.display_name, fixture.members[0].source_display_name);
  assert.equal(restored.member.default_preference, "RIGHT");
  assert.equal(updated.member.member_id, restored.member.member_id);
});

test("P2 deactivation blocks live links and stale-roster signup, while re-sync never reactivates a member", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0));
  expectError(post(fixture.backend.context, fixture.memberBody("setMemberStatus", 0, { status: "INACTIVE" })), "MEMBER_HAS_ACTIVE_LINKS");
  expectSuccess(fixture.mutate("cancelSignup", 0));
  const rosterBefore = expectSuccess(fixture.get("members"));
  const deactivated = expectSuccess(post(fixture.backend.context, fixture.memberBody("setMemberStatus", 0, { status: "INACTIVE" })));
  const rosterAfter = expectSuccess(fixture.get("members"));
  assert.equal(rosterAfter.roster_version, rosterBefore.roster_version + 1);
  assert.equal(rosterAfter.members.some((member) => member.member_id === fixture.members[0].member_id), false);
  expectError(fixture.mutate("signup", 0), "MEMBER_INACTIVE");
  expectSuccess(fixture.send("retrySeasonSync", { session_token: fixture.token, season_id: fixture.season.season_id }));
  assert.equal(fixture.backend.context.requireSeasonMember_(fixture.storedSeason(), fixture.members[0].member_id).status, "INACTIVE");
  const activated = expectSuccess(post(fixture.backend.context, fixture.memberBody("setMemberStatus", 0, { status: "ACTIVE" })));
  assert.equal(activated.member.member_version, deactivated.member.member_version + 1);
  expectSuccess(fixture.mutate("signup", 0));

  fixture.backend.context.appendSeasonSheetRecord_(fixture.storedSeason(), "SeatPlanCurrent", {
    season_id: fixture.season.season_id, practice_id: fixture.practice.practice_id,
    row_number: 1, side: "LEFT", member_id: fixture.members[1].member_id, seat_plan_version: 1
  });
  expectError(post(fixture.backend.context, fixture.memberBody("setMemberStatus", 1, { status: "INACTIVE" })), "MEMBER_HAS_ACTIVE_LINKS");
  fixture.setTime(fixture.practice.end_at);
  expectSuccess(post(fixture.backend.context, fixture.memberBody("setMemberStatus", 1, { status: "INACTIVE" })));
});

test("P2 signup recovery keeps the accepted queue and writes its event exactly once at every interruption", async (t) => {
  const stages = [
    ["journal", "appendSheetRecord_", (name, row) => name === "SystemRequests" && row.actor_id.startsWith("P2:")],
    ["signup", "appendSeasonSheetRecord_", (_season, name) => name === "SignupsCurrent"],
    ["state", "appendSeasonSheetRecord_", (_season, name) => name === "Settings"],
    ["audit", "appendSeasonSheetRecord_", (_season, name, row) => name === "AuditLog" && row.action === "signup"],
    ["completion", "updateSheetRecord_", (name, row) => name === "SystemRequests" && row.status === "COMPLETED" && row.actor_id.startsWith("P2:")]
  ];
  for (const [stage, method, predicate] of stages) {
    await t.test(stage, async () => {
      const fixture = await createFixture();
      const body = fixture.body("signup", 0, "LEFT");
      const restore = interruptOnceAfter(fixture, method, predicate);
      expectError(post(fixture.backend.context, body), "INTERNAL_ERROR");
      restore();
      const acceptedAt = new Date(fixture.now()).toISOString();
      fixture.setTime(Date.parse(fixture.practice.signup_cutoff_at) + 1);
      const recovered = fixture.detail();
      assert.equal(recovered.signups.length, 1);
      assert.equal(recovered.signups[0].queue_at, acceptedAt);
      assert.equal(recovered.signups[0].queue_sequence, 1);
      assert.equal(recovered.signup_version, 1);
      const replayed = expectSuccess(post(fixture.backend.context, body));
      assert.equal(replayed.signup.queue_at, acceptedAt);
      assert.equal(fixture.signupRows().length, 1);
      const events = sheetRecords(fixture.binding.runtimeSpreadsheet, "AuditLog").filter((event) => event.request_id === body.request_id);
      assert.equal(events.length, 1);
      assert.equal(new Set(events.map((event) => event.event_id)).size, 1);
    });
  }
});

test("P2 a partial cancellation and promotion is recovered before the next reader or writer", async () => {
  const fixture = await createFixture();
  fill(fixture, 0, 20, "AMBIENT");
  const waiter = expectSuccess(fixture.mutate("signup", 20)).signup;
  const body = fixture.body("cancelSignup", 0);
  const restore = interruptOnceAfter(fixture, "updateSeasonSheetRecord_", (_season, name, row) => name === "SignupsCurrent" && row.status === "CANCELLED");
  expectError(post(fixture.backend.context, body), "INTERNAL_ERROR");
  restore();
  const recovered = fixture.detail();
  assert.equal(recovered.counts.confirmed, 20);
  const promoted = recovered.signups.find((row) => row.member_id === fixture.members[20].member_id);
  assert.equal(promoted.status, "CONFIRMED");
  assert.equal(promoted.queue_at, waiter.queue_at);
  assert.equal(promoted.queue_sequence, waiter.queue_sequence);
  assert.deepEqual(expectSuccess(post(fixture.backend.context, body)).promoted_member_ids, [fixture.members[20].member_id]);
  assert.equal(expectSuccess(fixture.mutate("signup", 21)).signup.status, "WAITLISTED");
  assert.equal(fixture.detail().counts.confirmed, 20);
});

test("P2 member recovery runs before a P1 write and cannot roll its season configuration version back", async () => {
  const fixture = await createFixture();
  const cached = expectSuccess(fixture.get("members"));
  const body = fixture.memberBody("updateMember", 0, { display_name_override: "Recovered Name", default_preference: "LEFT" });
  const restore = interruptOnceAfter(fixture, "updateSeasonSheetRecord_", (_season, name) => name === "Members");
  expectError(post(fixture.backend.context, body), "INTERNAL_ERROR");
  restore();
  const changedTemplate = expectSuccess(fixture.send("updateScheduleTemplates", {
    session_token: fixture.token, season_id: fixture.season.season_id, season_version: fixture.season.season_version,
    templates: [{ ...fixture.template, location: "Changed P1 Dock" }]
  }));
  assert.equal(changedTemplate.season.season_version, fixture.season.season_version + 1);
  assert.equal(changedTemplate.season.roster_version, cached.roster_version + 1);
  const replay = expectSuccess(post(fixture.backend.context, body));
  assert.equal(replay.member.display_name, "Recovered Name");
  const currentSeason = fixture.storedSeason();
  assert.equal(Number(currentSeason.season_version), changedTemplate.season.season_version);
  assert.equal(Number(currentSeason.roster_version), cached.roster_version + 1);
  const refreshed = expectSuccess(fixture.get("members"));
  assert.equal(refreshed.members.find((member) => member.member_id === fixture.members[0].member_id).display_name, "Recovered Name");
  assert.equal(refreshed.roster_version, cached.roster_version + 1);
  const events = sheetRecords(fixture.binding.runtimeSpreadsheet, "AuditLog").filter((event) => event.request_id === body.request_id);
  assert.equal(events.length, 1);
});

test("P2 commits its recovery plan before business rows and commits completion before releasing the lock", async () => {
  const fixture = await createFixture();
  const context = fixture.backend.context;
  const events = [];
  let held = false;
  context.LockService.getScriptLock = () => ({
    waitLock() { held = true; events.push("lock"); },
    releaseLock() { held = false; events.push("unlock"); }
  });
  context.SpreadsheetApp.flush = () => {
    assert.equal(held, true, "Spreadsheet changes must commit before exclusive access ends");
    events.push("flush");
  };
  const appendSystem = context.appendSheetRecord_;
  context.appendSheetRecord_ = (name, row) => {
    if (name === "SystemRequests" && row.actor_id.startsWith("P2:")) events.push("journal");
    return appendSystem(name, row);
  };
  const appendSeason = context.appendSeasonSheetRecord_;
  context.appendSeasonSheetRecord_ = (season, name, row) => {
    if (name === "SignupsCurrent" || name === "Settings") events.push("business");
    if (name === "AuditLog" && row.action === "signup") events.push("audit");
    return appendSeason(season, name, row);
  };
  const updateSystem = context.updateSheetRecord_;
  context.updateSheetRecord_ = (name, row) => {
    if (name === "SystemRequests" && row.status === "COMPLETED" && row.actor_id.startsWith("P2:")) events.push("completed");
    return updateSystem(name, row);
  };
  expectSuccess(fixture.mutate("signup", 0));
  const journal = events.indexOf("journal");
  const business = events.indexOf("business");
  const audit = events.indexOf("audit");
  const completed = events.indexOf("completed");
  const unlock = events.indexOf("unlock");
  const flushedBetween = (start, end) => events.slice(start + 1, end).includes("flush");
  assert.ok(journal >= 0 && journal < business && business < audit && audit < completed && completed < unlock, events.join(" -> "));
  assert.ok(flushedBetween(journal, business), "The recovery plan must be durable before its first business write");
  assert.ok(flushedBetween(audit, completed), "Business rows and audit must be durable before marking the request complete");
  assert.ok(flushedBetween(completed, unlock), "The completion record must be durable before unlocking");
  assert.equal(held, false);
});

test("P2 a failed flush never reports success or retains the write lock", async (t) => {
  for (const failureStage of ["journal", "completion"]) {
    await t.test(failureStage, async () => {
      const fixture = await createFixture();
      const context = fixture.backend.context;
      let held = false;
      let releaseCount = 0;
      let completionWritten = false;
      let failureRaised = false;
      context.LockService.getScriptLock = () => ({
        waitLock() { held = true; },
        releaseLock() { held = false; releaseCount += 1; }
      });
      const updateSystem = context.updateSheetRecord_;
      context.updateSheetRecord_ = (name, row) => {
        const result = updateSystem(name, row);
        if (name === "SystemRequests" && row.status === "COMPLETED" && row.actor_id.startsWith("P2:")) completionWritten = true;
        return result;
      };
      context.SpreadsheetApp.flush = () => {
        assert.equal(held, true);
        if (!failureRaised && (failureStage === "journal" || completionWritten)) {
          failureRaised = true;
          throw new Error("Injected spreadsheet flush failure");
        }
      };
      const body = fixture.body("signup", 0);
      expectError(post(context, body), "INTERNAL_ERROR");
      assert.equal(failureRaised, true);
      assert.equal(held, false);
      assert.equal(releaseCount, 1);
      assert.equal(context.dragonBoatLockDepth_, 0);
      if (failureStage === "journal") assert.equal(fixture.signupRows().length, 0);
      const recovered = expectSuccess(post(context, body));
      assert.equal(recovered.signup.status, "CONFIRMED");
      assert.equal(fixture.signupRows().length, 1);
      assert.equal(held, false);
      assert.equal(releaseCount, 2);
    });
  }
});
