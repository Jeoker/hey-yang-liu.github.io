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
  return response.error;
}

async function createFixture({ memberCount = 30, endDate = "2026-12-31", capacities } = {}) {
  const backend = await createBackend({ properties: { DRAGON_BOAT_SESSION_TTL_SECONDS: "86400" } });
  let currentTime = Date.parse(INITIAL_TIME);
  let requestNumber = 0;
  backend.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [currentTime])); }
    static now() { return currentTime; }
  };
  const requestId = () => `p3_test_${String(++requestNumber).padStart(6, "0")}`;
  const send = (action, input = {}, fixedRequestId) => post(backend.context, {
    action,
    request_id: fixedRequestId || requestId(),
    ...input
  });
  let token = expectSuccess(send("coachLogin", { coach_code: "coach-code-123" })).session_token;
  const binding = backend.createFormBinding({
    rows: Array.from({ length: memberCount }, (_, index) => [
      INITIAL_TIME,
      `Member ${String(index + 1).padStart(2, "0")}`
    ])
  });
  const draft = expectSuccess(send("createSeason", {
    session_token: token,
    name: "P3 Fixture",
    start_date: "2026-09-01",
    end_date: endDate,
    timezone: "America/New_York"
  })).season;
  const initialized = expectSuccess(send("initializeSeason", {
    session_token: token,
    season_id: draft.season_id,
    season_version: draft.season_version,
    form: binding.formId,
    spreadsheet: binding.spreadsheetId,
    response_sheet: binding.responseSheet.getName(),
    display_name_header: "Display Name"
  })).season;
  const season = expectSuccess(send("updateScheduleTemplates", {
    session_token: token,
    season_id: initialized.season_id,
    season_version: initialized.season_version,
    templates: [{
      day_of_week: 3,
      start_time: "14:00",
      end_time: "16:00",
      location: "P3 Dock",
      address: "3 River Road",
      map_url: ""
    }]
  })).season;
  const weekDraft = expectSuccess(send("updateTrainingWeek", {
    session_token: token,
    season_id: season.season_id,
    season_version: season.season_version,
    week_start_date: "2026-08-31"
  }));
  const week = expectSuccess(send("confirmTrainingWeek", {
    session_token: token,
    season_id: season.season_id,
    week_id: weekDraft.week.week_id,
    week_version: weekDraft.week.week_version
  }));
  const practiceId = week.practices[0].practice_id;
  const storedSeason = () => backend.context.requireSeason_(season.season_id);
  if (capacities) {
    const practice = backend.context.requirePractice_(storedSeason(), practiceId);
    practice.left_capacity = capacities.left;
    practice.right_capacity = capacities.right;
    practice.practice_version = Number(practice.practice_version) + 1;
    backend.context.updateSeasonSheetRecord_(storedSeason(), "Practices", practice);
  }
  const members = sheetRecords(binding.runtimeSpreadsheet, "Members");
  const get = (action, input = {}) => payload(backend.context.doGet({
    parameter: {
      action,
      request_id: requestId(),
      season_id: season.season_id,
      ...input
    }
  }));
  const practiceRecord = () => backend.context.requirePractice_(storedSeason(), practiceId);
  const signupState = () => backend.context.getSignupState_(storedSeason(), practiceId);
  const signupBody = (action, memberIndex, preference = "AMBIENT", extra = {}) => ({
    action,
    request_id: requestId(),
    season_id: season.season_id,
    practice_id: practiceId,
    member_id: members[memberIndex].member_id,
    preference,
    practice_version: Number(practiceRecord().practice_version),
    signup_version: signupState().version,
    ...(/ByCoach$/.test(action) ? { session_token: token } : {}),
    ...extra
  });
  const mutate = (action, memberIndex, preference = "AMBIENT", extra = {}) => {
    const response = post(backend.context, signupBody(action, memberIndex, preference, extra));
    currentTime += 1;
    return response;
  };
  const workspace = () => expectSuccess(send("getSeatingWorkspace", {
    session_token: token,
    season_id: season.season_id,
    practice_id: practiceId
  }));
  const draftBody = (view, input = {}) => ({
    session_token: token,
    season_id: season.season_id,
    practice_id: practiceId,
    practice_version: view.practice.practice_version,
    signup_version: view.signup_version,
    seat_plan_version: view.seat_plan_version,
    coach_member_id: view.draft.coach_member_id || "",
    steerer_member_id: view.draft.steerer_member_id || "",
    seats: view.draft.seats,
    change_kind: "EDIT",
    ...input
  });
  const saveDraft = (view, input = {}, fixedRequestId) => expectSuccess(send(
    "saveSeatPlanDraft",
    draftBody(view, input),
    fixedRequestId
  ));
  const publishBody = (view, input = {}) => ({
    session_token: token,
    season_id: season.season_id,
    practice_id: practiceId,
    practice_version: view.practice.practice_version,
    signup_version: view.signup_version,
    seat_plan_version: view.seat_plan_version,
    published_revision: view.published_revision,
    acknowledge_preference_mismatch: false,
    ...input
  });
  const publish = (view, input = {}, fixedRequestId) => expectSuccess(send(
    "publishSeatPlan",
    publishBody(view, input),
    fixedRequestId
  ));
  return {
    backend,
    binding,
    get token() { return token; },
    season,
    week,
    practiceId,
    members,
    requestId,
    send,
    get,
    mutate,
    signupBody,
    workspace,
    draftBody,
    saveDraft,
    publishBody,
    publish,
    storedSeason,
    practiceRecord,
    signupState,
    refreshSession() {
      token = expectSuccess(send("coachLogin", { coach_code: "coach-code-123" })).session_token;
      return token;
    },
    setTime(value) { currentTime = typeof value === "number" ? value : Date.parse(value); },
    now() { return currentTime; }
  };
}

function seat(rowNumber, side, member) {
  return { row_number: rowNumber, side, member_id: member.member_id };
}

function findSeat(plan, rowNumber, side) {
  return plan?.seats?.find((candidate) =>
    Number(candidate.row_number) === rowNumber && candidate.side === side
  );
}

function activeSignup(view, member) {
  return view.signups.find((signup) => signup.member_id === member.member_id);
}

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

test("P3 keeps a Coach draft private and preserves immutable published revisions", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));

  let workspace = fixture.workspace();
  assert.equal(workspace.mode, "UPCOMING");
  assert.equal(workspace.seat_plan_version, 0);
  assert.equal(workspace.published_revision, 0);
  assert.equal(workspace.published, null);
  assert.deepEqual(new Set(workspace.unseated_member_ids), new Set([
    fixture.members[0].member_id,
    fixture.members[1].member_id
  ]));

  workspace = fixture.saveDraft(workspace, {
    coach_member_id: fixture.members[2].member_id,
    steerer_member_id: fixture.members[2].member_id,
    seats: [seat(1, "LEFT", fixture.members[0]), seat(1, "RIGHT", fixture.members[1])]
  });
  assert.equal(workspace.seat_plan_version, 1);
  assert.equal(workspace.draft.coach_member_id, fixture.members[2].member_id);
  assert.equal(workspace.draft.steerer_member_id, fixture.members[2].member_id);

  const beforePublish = expectSuccess(fixture.get("practice", { practice_id: fixture.practiceId }));
  assert.equal(beforePublish.seat_plan.status, "UNPUBLISHED");
  assert.equal(beforePublish.seat_plan.published_revision, 0);
  assert.deepEqual(beforePublish.seat_plan.seats, []);
  assert.equal(beforePublish.seat_plan.rows.length, 10);
  assert.ok(beforePublish.seat_plan.rows.every((row) => row.left === null && row.right === null));
  assert.equal("draft" in beforePublish, false);
  assert.equal("unseated_member_ids" in beforePublish, false);

  workspace = fixture.publish(workspace);
  assert.equal(workspace.published_revision, 1);
  assert.equal(workspace.published.coach.display_name, "Member 03");
  assert.equal(workspace.published.steerer.display_name, "Member 03");
  const protectedRevisionOne = fixture.workspace().published;
  assert.deepEqual(protectedRevisionOne.coach, {
    display_name: "Member 03", member_id: fixture.members[2].member_id
  });
  assert.deepEqual(protectedRevisionOne.steerer, {
    display_name: "Member 03", member_id: fixture.members[2].member_id
  });
  const firstRevision = structuredClone(
    sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions")[0]
  );
  assert.equal(Number(firstRevision.revision_number), 1);

  const publicRevisionOne = expectSuccess(fixture.get("practice", { practice_id: fixture.practiceId })).seat_plan;
  assert.equal(publicRevisionOne.status, "PUBLISHED");
  assert.equal(publicRevisionOne.published_revision, 1);
  assert.deepEqual(publicRevisionOne.coach, { display_name: "Member 03" }, "public Coach role must not expose its management ID");
  assert.deepEqual(publicRevisionOne.steerer, { display_name: "Member 03" }, "public Steerer role must not expose its management ID");
  assert.equal(findSeat(publicRevisionOne, 1, "LEFT").display_name, "Member 01");
  assert.equal(findSeat(publicRevisionOne, 1, "RIGHT").display_name, "Member 02");
  assert.equal(publicRevisionOne.rows.length, 10);
  assert.equal(publicRevisionOne.rows[0].left.display_name, "Member 01");
  assert.equal(publicRevisionOne.rows[0].right.display_name, "Member 02");

  workspace = fixture.saveDraft(workspace, {
    seats: [seat(2, "LEFT", fixture.members[0]), seat(2, "RIGHT", fixture.members[1])]
  });
  const stillRevisionOne = expectSuccess(fixture.get("practice", { practice_id: fixture.practiceId })).seat_plan;
  assert.equal(stillRevisionOne.published_revision, 1);
  assert.ok(findSeat(stillRevisionOne, 1, "LEFT"));
  assert.equal(findSeat(stillRevisionOne, 2, "LEFT"), undefined);

  workspace = fixture.publish(workspace);
  assert.equal(workspace.published_revision, 2);
  const revisions = sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions");
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions[0], firstRevision, "a later publish must not rewrite revision 1");
  assert.equal(Number(revisions[1].revision_number), 2);
  assert.ok(findSeat(workspace.published, 2, "LEFT"));
});

test("P3 validates completeness and roles, permits one person to Coach and Steer, and requires an explicit wrong-side acknowledgement", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));

  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, { seats: [seat(1, "LEFT", fixture.members[0])] });
  expectError(fixture.send("publishSeatPlan", fixture.publishBody(workspace)), "SEAT_PLAN_INCOMPLETE");

  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(workspace, {
    coach_member_id: fixture.members[0].member_id
  })), "ROLE_SIGNUP_CONFLICT");
  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(workspace, {
    seats: [seat(1, "LEFT", fixture.members[0]), seat(1, "RIGHT", fixture.members[2])]
  })), "SEAT_MEMBER_NOT_CONFIRMED");

  workspace = fixture.saveDraft(workspace, {
    coach_member_id: fixture.members[2].member_id,
    steerer_member_id: fixture.members[2].member_id,
    seats: [seat(1, "RIGHT", fixture.members[0]), seat(1, "LEFT", fixture.members[1])]
  });
  assert.equal(workspace.draft.coach_member_id, workspace.draft.steerer_member_id);
  assert.equal(workspace.preference_mismatches.length, 2);
  expectError(fixture.send("publishSeatPlan", fixture.publishBody(workspace)), "PREFERENCE_ACK_REQUIRED");
  assert.equal(sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions").length, 0);

  workspace = fixture.publish(workspace, { acknowledge_preference_mismatch: true });
  assert.equal(workspace.published_revision, 1);
  assert.equal(workspace.published.coach.display_name, "Member 03");
  assert.equal(workspace.published.steerer.display_name, "Member 03");
});

test("P3 preference warnings ignore the same member's signup in another practice", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  const additional = expectSuccess(fixture.send("createPractice", {
    session_token: fixture.token,
    season_id: fixture.season.season_id,
    week_id: fixture.week.week.week_id,
    week_version: fixture.week.week.week_version,
    practice_date: "2026-09-04",
    start_time: "14:00",
    end_time: "16:00",
    location: "P3 Second Dock",
    address: "4 River Road",
    map_url: ""
  }));
  const publishedAdditional = expectSuccess(fixture.send("publishAdditionalPractice", {
    session_token: fixture.token,
    season_id: fixture.season.season_id,
    week_id: additional.week.week_id,
    practice_id: additional.practice.practice_id,
    week_version: additional.week.week_version,
    practice_version: additional.practice.practice_version
  }));
  const otherSignup = expectSuccess(fixture.send("signup", {
    season_id: fixture.season.season_id,
    practice_id: publishedAdditional.practice.practice_id,
    member_id: fixture.members[0].member_id,
    preference: "RIGHT",
    practice_version: publishedAdditional.practice.practice_version,
    signup_version: 0
  }));
  assert.equal(otherSignup.signup.preference, "RIGHT");

  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(1, "LEFT", fixture.members[0])]
  });
  assert.deepEqual(workspace.preference_mismatches, []);
  workspace = fixture.publish(workspace);
  assert.equal(findSeat(workspace.published, 1, "LEFT").member_id, fixture.members[0].member_id);
});

test("P3 signup cancellation and side changes create isolated system revisions and update matching drafts", async () => {
  const fixture = await createFixture({ capacities: { left: 1, right: 1 } });
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));
  const waiter = expectSuccess(fixture.mutate("signup", 2, "AMBIENT")).signup;
  assert.equal(waiter.status, "WAITLISTED");

  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(1, "LEFT", fixture.members[0]), seat(1, "RIGHT", fixture.members[1])]
  });
  workspace = fixture.publish(workspace);
  const coachRevision = workspace.published_revision;

  const cancelled = expectSuccess(fixture.mutate("cancelSignup", 0));
  assert.deepEqual(cancelled.promoted_member_ids, [fixture.members[2].member_id]);
  workspace = fixture.workspace();
  assert.equal(workspace.published_revision, coachRevision + 1);
  assert.equal(findSeat(workspace.published, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(findSeat(workspace.draft, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(activeSignup(workspace, fixture.members[2]).status, "CONFIRMED");
  assert.match(workspace.published.source, /SYSTEM/);

  const compatibleRevision = workspace.published_revision;
  const compatible = expectSuccess(fixture.mutate("updateSignup", 2, "LEFT"));
  assert.equal(compatible.signup.status, "CONFIRMED");
  workspace = fixture.workspace();
  assert.equal(workspace.published_revision, compatibleRevision);
  assert.equal(findSeat(workspace.published, 1, "LEFT").member_id, fixture.members[2].member_id);

  const moved = expectSuccess(fixture.mutate("updateSignup", 2, "RIGHT"));
  assert.equal(moved.signup.status, "WAITLISTED");
  workspace = fixture.workspace();
  assert.equal(workspace.published_revision, compatibleRevision + 1);
  assert.equal(findSeat(workspace.published, 1, "LEFT"), undefined);
  assert.equal(findSeat(workspace.draft, 1, "LEFT"), undefined);
  assert.equal(activeSignup(workspace, fixture.members[2]).queue_at, waiter.queue_at);
  assert.equal(activeSignup(workspace, fixture.members[2]).queue_sequence, waiter.queue_sequence);
});

test("P3 removes an invalidated draft seat without overwriting a Coach-diverged draft during promotion", async () => {
  const fixture = await createFixture({ capacities: { left: 1, right: 1 } });
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));
  expectSuccess(fixture.mutate("signup", 2, "AMBIENT"));

  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(1, "LEFT", fixture.members[0]), seat(1, "RIGHT", fixture.members[1])]
  });
  workspace = fixture.publish(workspace);
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(1, "LEFT", fixture.members[1]), seat(1, "RIGHT", fixture.members[0])]
  });
  const divergedVersion = workspace.seat_plan_version;

  const cancelled = expectSuccess(fixture.mutate("cancelSignupByCoach", 0));
  assert.deepEqual(cancelled.promoted_member_ids, [fixture.members[2].member_id]);
  workspace = fixture.workspace();
  assert.equal(findSeat(workspace.published, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(findSeat(workspace.published, 1, "RIGHT").member_id, fixture.members[1].member_id);
  assert.equal(findSeat(workspace.draft, 1, "LEFT").member_id, fixture.members[1].member_id);
  assert.equal(findSeat(workspace.draft, 1, "RIGHT"), undefined);
  assert.equal(workspace.draft.seats.some((candidate) => candidate.member_id === fixture.members[2].member_id), false);
  assert.ok(workspace.unseated_member_ids.includes(fixture.members[2].member_id));
  assert.ok(workspace.seat_plan_version > divergedVersion);
});

test("P3 rejects stale draft, signup, and published-revision writes", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0));
  const editorA = fixture.workspace();
  const editorB = fixture.workspace();
  let current = fixture.saveDraft(editorA, { seats: [seat(1, "LEFT", fixture.members[0])] });
  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(editorB, {
    seats: [seat(2, "LEFT", fixture.members[0])]
  })), "VERSION_CONFLICT");

  const beforeSignupChange = fixture.workspace();
  expectSuccess(fixture.mutate("signup", 1, "AMBIENT"));
  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(beforeSignupChange)), "VERSION_CONFLICT");
  expectSuccess(fixture.mutate("cancelSignup", 1));

  current = fixture.workspace();
  current = fixture.publish(current);
  const stalePublishedRevision = current.published_revision;
  expectSuccess(fixture.mutate("cancelSignup", 0));
  const afterSystemRevision = fixture.workspace();
  assert.ok(afterSystemRevision.published_revision > stalePublishedRevision);
  expectError(fixture.send("publishSeatPlan", fixture.publishBody(afterSystemRevision, {
    published_revision: stalePublishedRevision
  })), "VERSION_CONFLICT");
});

test("P3 replays completed draft and publish requests before checking their now-stale versions", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0));
  const initial = fixture.workspace();
  const saveRequestId = "p3_replay_draft_request";
  const saveInput = fixture.draftBody(initial, {
    seats: [seat(1, "LEFT", fixture.members[0])]
  });
  const saved = expectSuccess(fixture.send("saveSeatPlanDraft", saveInput, saveRequestId));
  const replayedSave = expectSuccess(fixture.send("saveSeatPlanDraft", saveInput, saveRequestId));
  assert.equal(replayedSave.seat_plan_version, saved.seat_plan_version);
  assert.deepEqual(replayedSave.draft, saved.draft);

  const publishRequestId = "p3_replay_publish_request";
  const publishInput = fixture.publishBody(saved);
  const published = expectSuccess(fixture.send("publishSeatPlan", publishInput, publishRequestId));
  const replayedPublish = expectSuccess(fixture.send("publishSeatPlan", publishInput, publishRequestId));
  assert.equal(replayedPublish.published_revision, published.published_revision);
  assert.equal(sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions").length, 1);
  const p3Requests = sheetRecords(fixture.backend.spreadsheet, "SystemRequests").filter((row) =>
    row.request_id === saveRequestId || row.request_id === publishRequestId
  );
  assert.equal(p3Requests.length, 2);
  const p3Events = sheetRecords(fixture.binding.runtimeSpreadsheet, "AuditLog").filter((row) =>
    row.request_id === saveRequestId || row.request_id === publishRequestId
  );
  assert.equal(p3Events.length, 2);
});

test("P3 recovers an interrupted manual publish without duplicating its revision or audit", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0));
  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, { seats: [seat(1, "LEFT", fixture.members[0])] });
  const publishRequestId = "p3_interrupted_publish";
  const body = { action: "publishSeatPlan", request_id: publishRequestId, ...fixture.publishBody(workspace) };
  const restore = interruptOnceAfter(
    fixture,
    "appendSeasonSheetRecord_",
    (_season, sheetName) => sheetName === "SeatPlanRevisions"
  );
  expectError(post(fixture.backend.context, body), "INTERNAL_ERROR");
  restore();

  const recovered = fixture.workspace();
  assert.equal(recovered.published_revision, 1);
  assert.equal(findSeat(recovered.published, 1, "LEFT").member_id, fixture.members[0].member_id);
  const revisions = sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions")
    .filter((row) => row.request_id === publishRequestId);
  assert.equal(revisions.length, 1);
  const events = sheetRecords(fixture.binding.runtimeSpreadsheet, "AuditLog")
    .filter((row) => row.request_id === publishRequestId);
  assert.equal(events.length, 1);

  const replayed = expectSuccess(post(fixture.backend.context, body));
  assert.equal(replayed.published_revision, 1);
  assert.equal(sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions")
    .filter((row) => row.request_id === publishRequestId).length, 1);
});

test("P3 recovers an interrupted cancellation, promotion, draft update, and system revision as one change", async () => {
  const fixture = await createFixture({ capacities: { left: 1, right: 1 } });
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));
  expectSuccess(fixture.mutate("signup", 2, "AMBIENT"));
  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(1, "LEFT", fixture.members[0]), seat(1, "RIGHT", fixture.members[1])]
  });
  workspace = fixture.publish(workspace);
  const cancellationRequestId = "p3_interrupted_cancellation";
  const body = fixture.signupBody("cancelSignup", 0);
  body.request_id = cancellationRequestId;
  const restore = interruptOnceAfter(
    fixture,
    "appendSeasonSheetRecord_",
    (_season, sheetName, row) => sheetName === "SeatPlanRevisions" && row.request_id === cancellationRequestId
  );
  expectError(post(fixture.backend.context, body), "INTERNAL_ERROR");
  restore();

  const recovered = fixture.workspace();
  assert.equal(activeSignup(recovered, fixture.members[2]).status, "CONFIRMED");
  assert.equal(findSeat(recovered.published, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(findSeat(recovered.draft, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions")
    .filter((row) => row.request_id === cancellationRequestId).length, 1);
  const events = sheetRecords(fixture.binding.runtimeSpreadsheet, "AuditLog")
    .filter((row) => row.request_id === cancellationRequestId);
  assert.equal(events.filter((row) => row.action === "SEAT_PLAN_SYSTEM_REVISED").length, 1);
  assert.equal(events.filter((row) => row.action === "cancelSignup").length, 1);

  const replayed = expectSuccess(post(fixture.backend.context, body));
  assert.deepEqual(replayed.promoted_member_ids, [fixture.members[2].member_id]);
  assert.equal(sheetRecords(fixture.binding.runtimeSpreadsheet, "SeatPlanRevisions")
    .filter((row) => row.request_id === cancellationRequestId).length, 1);
});

test("P3 final correction preserves signup history and closes exactly at the 24-hour boundary", async () => {
  const fixture = await createFixture({ endDate: "2026-09-02" });
  expectSuccess(fixture.mutate("signup", 0, "LEFT"));
  expectSuccess(fixture.mutate("signup", 1, "RIGHT"));
  const frozenSignups = sheetRecords(fixture.binding.runtimeSpreadsheet, "SignupsCurrent");
  const frozenSignupVersion = fixture.signupState().version;
  const endAt = Date.parse(fixture.practiceRecord().end_at);
  fixture.setTime(endAt);

  let workspace = fixture.workspace();
  assert.equal(workspace.mode, "FINAL_CORRECTION");
  workspace = fixture.saveDraft(workspace, {
    coach_member_id: fixture.members[3].member_id,
    seats: [seat(1, "LEFT", fixture.members[2])]
  });
  workspace = fixture.publish(workspace);
  assert.equal(findSeat(workspace.published, 1, "LEFT").member_id, fixture.members[2].member_id);
  assert.equal(fixture.signupState().version, frozenSignupVersion);
  assert.deepEqual(sheetRecords(fixture.binding.runtimeSpreadsheet, "SignupsCurrent"), frozenSignups);
  expectError(fixture.mutate("cancelSignupByCoach", 0), "PRACTICE_ENDED");

  const archiveDueAt = Date.parse(workspace.archive_due_at);
  fixture.refreshSession();
  fixture.setTime(archiveDueAt - 1);
  workspace = fixture.workspace();
  assert.equal(workspace.mode, "FINAL_CORRECTION");
  workspace = fixture.saveDraft(workspace, {
    seats: [seat(2, "RIGHT", fixture.members[4])]
  });
  workspace = fixture.publish(workspace);
  assert.equal(findSeat(workspace.published, 2, "RIGHT").member_id, fixture.members[4].member_id);
  assert.equal(fixture.signupState().version, frozenSignupVersion);

  fixture.refreshSession();
  fixture.setTime(archiveDueAt);
  const frozen = fixture.workspace();
  assert.equal(frozen.mode, "FROZEN");
  assert.deepEqual(frozen.published.coach, {
    display_name: "Member 04", member_id: fixture.members[3].member_id
  });
  assert.deepEqual(frozen.published.steerer, null);
  const frozenPublic = expectSuccess(fixture.get("practice", { practice_id: fixture.practiceId })).seat_plan;
  assert.deepEqual(frozenPublic.coach, { display_name: "Member 04" });
  assert.deepEqual(frozenPublic.steerer, null);
  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(frozen, {
    seats: [],
    change_kind: "EDIT"
  })), "SEAT_PLAN_FROZEN");
  expectError(fixture.send("saveSeatPlanDraft", fixture.draftBody(frozen, {
    change_kind: "UNDO"
  })), "SEAT_PLAN_FROZEN");
  expectError(fixture.send("publishSeatPlan", fixture.publishBody(frozen)), "SEAT_PLAN_FROZEN");
  assert.deepEqual(sheetRecords(fixture.binding.runtimeSpreadsheet, "SignupsCurrent"), frozenSignups);
});

test("P3 member workspace remains available for a completed season's final-correction practice", async () => {
  const fixture = await createFixture({ endDate: "2026-09-02" });
  const practiceEnd = Date.parse(fixture.practiceRecord().end_at);
  fixture.setTime(practiceEnd);
  fixture.refreshSession();
  const seasonEnd = Date.parse(fixture.storedSeason().season_ends_at);
  assert.ok(seasonEnd > practiceEnd);
  fixture.setTime(seasonEnd + 1);

  const workspace = expectSuccess(fixture.send("getMemberWorkspace", {
    session_token: fixture.token,
    season_id: fixture.season.season_id,
    practice_id: fixture.practiceId
  }));
  assert.equal(workspace.season_status, "COMPLETED");
  assert.equal(workspace.practice.practice.practice_id, fixture.practiceId);
  assert.equal(workspace.seating.practice_id, fixture.practiceId);
  assert.equal(workspace.seating.mode, "FINAL_CORRECTION");
  assert.equal(workspace.seating.editable, true);
});

test("P3 seating workspace exposes server-authoritative editability for every lifecycle mode", async () => {
  const fixture = await createFixture();
  let workspace = fixture.workspace();
  assert.equal(workspace.mode, "UPCOMING");
  assert.equal(workspace.editable, true);

  const practiceEnd = Date.parse(fixture.practiceRecord().end_at);
  fixture.setTime(practiceEnd);
  workspace = fixture.workspace();
  assert.equal(workspace.mode, "FINAL_CORRECTION");
  assert.equal(workspace.editable, true);

  const archiveDue = Date.parse(workspace.archive_due_at);
  fixture.setTime(archiveDue - 1);
  fixture.refreshSession();
  fixture.setTime(archiveDue);
  workspace = fixture.workspace();
  assert.equal(workspace.mode, "FROZEN");
  assert.equal(workspace.editable, false);

  const cancelledFixture = await createFixture();
  const cancelledPractice = cancelledFixture.practiceRecord();
  cancelledPractice.cancelled_at = new Date(cancelledFixture.now()).toISOString();
  cancelledPractice.cancelled_by = "coach_alpha";
  cancelledPractice.practice_version = Number(cancelledPractice.practice_version) + 1;
  cancelledFixture.backend.context.updateSeasonSheetRecord_(
    cancelledFixture.storedSeason(),
    "Practices",
    cancelledPractice
  );
  const cancelled = cancelledFixture.workspace();
  assert.equal(cancelled.mode, "CANCELLED");
  assert.equal(cancelled.editable, false);
});

test("P3 seating management is protected and its public projection never exposes a draft", async () => {
  const fixture = await createFixture();
  expectSuccess(fixture.mutate("signup", 0));
  expectError(fixture.get("getSeatingWorkspace", { practice_id: fixture.practiceId }), "METHOD_NOT_ALLOWED");
  expectError(fixture.send("getSeatingWorkspace", {
    season_id: fixture.season.season_id,
    practice_id: fixture.practiceId
  }), "INVALID_REQUEST");
  expectError(fixture.send("getSeatingWorkspace", {
    session_token: "invalid_session_token_12345678901234567890",
    season_id: fixture.season.season_id,
    practice_id: fixture.practiceId
  }), "SESSION_INVALID");

  let workspace = fixture.workspace();
  workspace = fixture.saveDraft(workspace, { seats: [seat(1, "LEFT", fixture.members[0])] });
  const publicDetail = expectSuccess(fixture.get("practice", { practice_id: fixture.practiceId }));
  const serialized = JSON.stringify(publicDetail);
  assert.equal(publicDetail.seat_plan.status, "UNPUBLISHED");
  assert.deepEqual(publicDetail.seat_plan.seats, []);
  assert.equal(publicDetail.seat_plan.coach, null);
  assert.equal(publicDetail.seat_plan.steerer, null);
  assert.equal(serialized.includes("unseated_member_ids"), false);
  assert.equal(serialized.includes("preference_mismatches"), false);
  assert.equal(serialized.includes(fixture.members[0].member_id), true, "signup IDs remain part of the existing public contract");
});
