// Explicit live P3 acceptance against the isolated fixture season. This script
// never stores private IDs or credentials and refuses to clear data it cannot
// prove belongs to this run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

assert(
  process.argv.includes("--write-test-data") && process.env.DBT_API_URL && process.env.DBT_COACH_CODE,
  "Set runtime DBT_API_URL and DBT_COACH_CODE and explicitly pass --write-test-data."
);

const EXPECTED_SEASON = "P1 Acceptance 2026";
const EXPECTED_LOCATION = "P1 Test Dock";
const EXPECTED_NAMES = [
  "P1 Test Member Alpha",
  "P1 Test Member Beta",
  ...Array.from({ length: 20 }, (_, index) => `P2 Test Member ${String(index + 1).padStart(2, "0")}`)
];
const WRITE_ACTIONS = new Set([
  "signup",
  "updateSignup",
  "cancelSignupByCoach",
  "saveSeatPlanDraft",
  "publishSeatPlan"
]);
const run = randomUUID().replaceAll("-", "_");
let sequence = 0;
let unknownBusinessWrite = null;

function nextRequestId(action) {
  sequence += 1;
  return `live_p3_${action}_${run}_${sequence}`;
}

async function request(action, values = {}, { post = false, requestId } = {}) {
  const body = { ...values, action, request_id: requestId || nextRequestId(action) };
  let finalError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const url = new URL(process.env.DBT_API_URL);
    if (!post) {
      Object.entries(body).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    }
    try {
      const response = await fetch(url, {
        method: post ? "POST" : "GET",
        redirect: "follow",
        ...(post ? {
          headers: { "Content-Type": "text/plain;charset=UTF-8" },
          body: JSON.stringify(body)
        } : {}),
        signal: AbortSignal.timeout(45000)
      });
      const envelope = await response.json();
      if (envelope.ok || !envelope.error?.retryable) return envelope;
      finalError = new Error(`${action} returned ${envelope.error.code}`);
      if (attempt < 2) {
        console.log(`Retrying the original ${action} request with the same request_id.`);
        continue;
      }
    } catch (error) {
      finalError = error;
      if (attempt < 2) {
        console.log(`Retrying the original ${action} request after an uncertain transport result.`);
        continue;
      }
    }
  }
  if (post && WRITE_ACTIONS.has(action)) {
    unknownBusinessWrite = { action, request_id: body.request_id };
  }
  throw finalError || new Error(`${action} did not return a usable response.`);
}

function accepted(envelope) {
  assert.equal(envelope.ok, true, JSON.stringify(envelope.error));
  return envelope.data;
}

function rejected(envelope, code) {
  assert.equal(envelope.ok, false, JSON.stringify(envelope));
  assert.equal(envelope.error.code, code, JSON.stringify(envelope.error));
  return envelope.error;
}

function slotKey(rowNumber, side) {
  return `${side}:${rowNumber}`;
}

function fullSeatSnapshot(occupied = []) {
  const bySlot = new Map(occupied.map((seat) => [slotKey(seat.row_number, seat.side), seat.member_id]));
  const seats = [];
  for (let rowNumber = 1; rowNumber <= 10; rowNumber += 1) {
    for (const side of ["LEFT", "RIGHT"]) {
      seats.push({ row_number: rowNumber, side, member_id: bySlot.get(slotKey(rowNumber, side)) || "" });
    }
  }
  return seats;
}

function occupiedSeat(rowNumber, side, member) {
  return { row_number: rowNumber, side, member_id: member.member_id };
}

function findSeat(plan, memberId) {
  return plan?.seats?.find((seat) => seat.member_id === memberId);
}

function requireEmptyFormalSeatPlan(seatPlan) {
  assert.ok(seatPlan, "The target practice must return the P3 public seat projection.");
  assert.equal(seatPlan.seats.length, 0, "Refusing to overwrite an occupied formal seat plan.");
  assert.equal(seatPlan.coach, null, "Refusing to overwrite an existing formal Coach role.");
  assert.equal(seatPlan.steerer, null, "Refusing to overwrite an existing formal Steerer role.");
}

function assertQueueOwnership(signup, ownedSignups) {
  const owned = ownedSignups.get(signup.member_id);
  assert.ok(owned, "An active signup was not created by this run; cleanup stopped.");
  assert.equal(signup.queue_at, owned.queue_at, "Queue timestamp ownership changed; cleanup stopped.");
  assert.equal(signup.queue_sequence, owned.queue_sequence, "Queue sequence ownership changed; cleanup stopped.");
}

async function main() {
  let token = "";
  let scope = null;
  let practice = null;
  let seating = null;
  let seatTouched = false;
  let completed = false;
  let failure = null;
  let cleanupFailure = null;
  const ownedSignups = new Map();

  async function readPractice() {
    return accepted(await request("practice", scope));
  }

  async function readSeating() {
    return accepted(await request("getSeatingWorkspace", {
      session_token: token,
      ...scope
    }, { post: true }));
  }

  async function signup(member, preference) {
    const state = await readPractice();
    const result = accepted(await request("signup", {
      ...scope,
      member_id: member.member_id,
      preference,
      practice_version: state.practice.practice_version,
      signup_version: state.signup_version
    }, { post: true }));
    ownedSignups.set(member.member_id, {
      queue_at: result.signup.queue_at,
      queue_sequence: result.signup.queue_sequence
    });
    return result;
  }

  async function saveDraft(current, input) {
    assert.equal(input.seats.length, 20, "Every live draft save must submit all twenty physical slots.");
    const result = accepted(await request("saveSeatPlanDraft", {
      ...scope,
      session_token: token,
      practice_version: current.practice.practice_version,
      signup_version: current.signup_version,
      seat_plan_version: current.seat_plan_version,
      published_revision: current.published_revision,
      coach_member_id: input.coach_member_id,
      steerer_member_id: input.steerer_member_id,
      seats: input.seats,
      change_kind: "EDIT"
    }, { post: true }));
    seatTouched = true;
    return result;
  }

  async function publish(current, acknowledgePreferenceMismatch) {
    return request("publishSeatPlan", {
      ...scope,
      session_token: token,
      practice_version: current.practice.practice_version,
      signup_version: current.signup_version,
      seat_plan_version: current.seat_plan_version,
      published_revision: current.published_revision,
      acknowledge_preference_mismatch: acknowledgePreferenceMismatch
    }, { post: true });
  }

  async function cleanup() {
    if (!token || !scope || unknownBusinessWrite) return;
    let state = await readPractice();
    state.signups.forEach((signup) => assertQueueOwnership(signup, ownedSignups));
    while (state.signups.length) {
      const target = state.signups[0];
      assertQueueOwnership(target, ownedSignups);
      accepted(await request("cancelSignupByCoach", {
        ...scope,
        session_token: token,
        member_id: target.member_id,
        practice_version: state.practice.practice_version,
        signup_version: state.signup_version
      }, { post: true }));
      state = await readPractice();
      state.signups.forEach((signup) => assertQueueOwnership(signup, ownedSignups));
    }
    if (seatTouched) {
      let current = await readSeating();
      current = await saveDraft(current, {
        coach_member_id: "",
        steerer_member_id: "",
        seats: fullSeatSnapshot()
      });
      accepted(await publish(current, false));
      const cleared = await readPractice();
      assert.equal(cleared.signups.length, 0);
      requireEmptyFormalSeatPlan(cleared.seat_plan);
    }
  }

  try {
    const bootstrap = accepted(await request("bootstrap"));
    assert.equal(bootstrap.season.name, EXPECTED_SEASON, "Refusing to write outside the isolated P1 acceptance season.");
    assert.equal(bootstrap.season.status, "OPEN");
    const practices = bootstrap.weeks
      .flatMap((week) => week.practices)
      .sort((left, right) => left.start_at.localeCompare(right.start_at));
    assert.equal(practices.length, 3, "The isolated acceptance season must still have exactly three published practices.");
    practice = practices.at(-1);
    assert.equal(practice.location, EXPECTED_LOCATION);
    scope = { season_id: bootstrap.season.season_id, practice_id: practice.practice_id };

    const roster = accepted(await request("members", { season_id: scope.season_id }));
    assert.equal(roster.members.length, EXPECTED_NAMES.length);
    const membersByName = new Map();
    for (const name of EXPECTED_NAMES) {
      const matches = roster.members.filter((member) => member.display_name === name);
      assert.equal(matches.length, 1, `Expected exactly one active fixture member named ${name}.`);
      membersByName.set(name, matches[0]);
    }
    assert.deepEqual(
      new Set(roster.members.map((member) => member.display_name)),
      new Set(EXPECTED_NAMES),
      "The public roster contains a member outside the documented fixture set."
    );

    let state = await readPractice();
    assert.equal(state.signups.length, 0, "The target practice must begin with zero active signups; this script never clears pre-existing registrations.");
    assert.equal(state.signup_open, true);
    requireEmptyFormalSeatPlan(state.seat_plan);
    const initialPublishedRevision = state.seat_plan.published_revision;

    const login = accepted(await request("coachLogin", {
      coach_code: process.env.DBT_COACH_CODE
    }, { post: true }));
    token = login.session_token;
    seating = await readSeating();
    assert.equal(seating.mode, "UPCOMING");
    assert.equal(seating.editable, true);
    assert.equal(seating.draft.seats.length, 0, "Refusing to overwrite a non-empty Coach draft.");
    assert.equal(seating.draft.coach_member_id, "", "Refusing to overwrite an existing draft Coach role.");
    assert.equal(seating.draft.steerer_member_id, "", "Refusing to overwrite an existing draft Steerer role.");

    const roleMember = membersByName.get("P1 Test Member Alpha");
    const paddlers = Array.from({ length: 10 }, (_, index) =>
      membersByName.get(`P2 Test Member ${String(index + 1).padStart(2, "0")}`)
    );
    const waiter = membersByName.get("P2 Test Member 11");
    for (const member of paddlers) {
      const result = await signup(member, "LEFT");
      assert.equal(result.signup.status, "CONFIRMED");
    }
    const waitlisted = await signup(waiter, "LEFT");
    assert.equal(waitlisted.signup.status, "WAITLISTED");
    state = await readPractice();
    assert.equal(state.counts.confirmed, 10);
    assert.equal(state.counts.left, 10);
    assert.equal(state.counts.waitlisted, 1);

    seating = await readSeating();
    const wrongSideSeats = [
      ...paddlers.slice(0, 9).map((member, index) => occupiedSeat(index + 1, "LEFT", member)),
      occupiedSeat(1, "RIGHT", paddlers[9])
    ];
    seating = await saveDraft(seating, {
      coach_member_id: roleMember.member_id,
      steerer_member_id: roleMember.member_id,
      seats: fullSeatSnapshot(wrongSideSeats)
    });
    assert.equal(seating.preference_mismatches.length, 1);
    state = await readPractice();
    assert.equal(state.seat_plan.published_revision, initialPublishedRevision);
    requireEmptyFormalSeatPlan(state.seat_plan);
    console.log("PASS: a twenty-slot private draft did not change the public seat plan.");

    const unacknowledged = await publish(seating, false);
    rejected(unacknowledged, "PREFERENCE_ACK_REQUIRED");
    seating = await readSeating();
    assert.equal(seating.published_revision, initialPublishedRevision);
    seating = accepted(await publish(seating, true));
    const manualRevision = seating.published_revision;
    assert.equal(manualRevision, initialPublishedRevision + 1);
    state = await readPractice();
    assert.equal(state.seat_plan.published_revision, manualRevision);
    assert.equal(state.seat_plan.seats.length, 10);
    assert.equal(state.seat_plan.coach.display_name, roleMember.display_name);
    assert.equal(state.seat_plan.steerer.display_name, roleMember.display_name);
    console.log("PASS: one member served as Coach and Steerer; wrong-side publication required explicit acknowledgement.");

    const cancelledMember = paddlers[0];
    const cancelledSlot = findSeat(state.seat_plan, cancelledMember.member_id);
    assert.ok(cancelledSlot && cancelledSlot.side === "LEFT");
    const cancellation = accepted(await request("cancelSignupByCoach", {
      ...scope,
      session_token: token,
      member_id: cancelledMember.member_id,
      practice_version: state.practice.practice_version,
      signup_version: state.signup_version
    }, { post: true }));
    assert.deepEqual(cancellation.promoted_member_ids, [waiter.member_id]);
    state = await readPractice();
    assert.equal(state.seat_plan.published_revision, manualRevision + 1);
    const promotedSlot = findSeat(state.seat_plan, waiter.member_id);
    assert.deepEqual(
      { row_number: promotedSlot.row_number, side: promotedSlot.side },
      { row_number: cancelledSlot.row_number, side: cancelledSlot.side }
    );
    assert.match(state.seat_plan.source, /^SYSTEM_/);
    console.log("PASS: cancellation promoted the earliest compatible waiter into the released formal seat.");

    const movedMember = paddlers[1];
    const movedOwnedQueue = ownedSignups.get(movedMember.member_id);
    const oldSeat = findSeat(state.seat_plan, movedMember.member_id);
    assert.ok(oldSeat && oldSeat.side === "LEFT");
    const changed = accepted(await request("updateSignup", {
      ...scope,
      member_id: movedMember.member_id,
      preference: "RIGHT",
      practice_version: state.practice.practice_version,
      signup_version: state.signup_version
    }, { post: true }));
    assert.equal(changed.signup.status, "CONFIRMED");
    assert.equal(changed.signup.queue_at, movedOwnedQueue.queue_at);
    assert.equal(changed.signup.queue_sequence, movedOwnedQueue.queue_sequence);
    state = await readPractice();
    assert.equal(findSeat(state.seat_plan, movedMember.member_id), undefined);
    assert.equal(
      state.seat_plan.seats.some((seat) => seat.row_number === oldSeat.row_number && seat.side === oldSeat.side),
      false
    );
    seating = await readSeating();
    assert.ok(seating.unseated_member_ids.includes(movedMember.member_id));
    console.log("PASS: changing side preserved queue ownership, cleared the old formal seat, and left the confirmed member pending placement.");

    const reSeated = seating.draft.seats.filter((seat) => seat.member_id !== movedMember.member_id);
    reSeated.push(occupiedSeat(2, "RIGHT", movedMember));
    seating = await saveDraft(seating, {
      coach_member_id: roleMember.member_id,
      steerer_member_id: roleMember.member_id,
      seats: fullSeatSnapshot(reSeated)
    });
    seating = accepted(await publish(seating, true));
    state = await readPractice();
    assert.equal(findSeat(state.seat_plan, movedMember.member_id).side, "RIGHT");
    assert.equal(state.seat_plan.published_revision, seating.published_revision);
    completed = true;
    console.log("PASS: the Coach re-seated the moved member and published a later manual revision.");
  } catch (error) {
    failure = error;
  } finally {
    if (unknownBusinessWrite) {
      console.error(`CLEANUP STOPPED: ${unknownBusinessWrite.action} (${unknownBusinessWrite.request_id}) has an unknown result. Retry that exact request before any cleanup write.`);
    } else {
      try {
        await cleanup();
      } catch (error) {
        cleanupFailure = error;
        console.error(`CLEANUP STOPPED: ${error.message}`);
      }
    }
    if (token) {
      try {
        accepted(await request("coachLogout", { session_token: token }, { post: true }));
        token = "";
      } catch (error) {
        cleanupFailure ||= error;
      }
    }
    console.log(JSON.stringify({
      ok: completed && !failure && !cleanupFailure && !unknownBusinessWrite,
      phase: "P3",
      fixture_members: EXPECTED_NAMES.length,
      cleanup: unknownBusinessWrite
        ? "Not attempted because one business write is unresolved."
        : cleanupFailure
          ? "Stopped after an ownership or cleanup failure; inspect the fixture before retrying."
          : "All run-owned active signups cancelled; empty roles and seats published; Coach session revoked.",
      twenty_four_hour_boundary: "Local controllable-clock coverage only; this script never changes live training time."
    }));
  }

  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  if (unknownBusinessWrite) throw new Error("A live P3 write has an unresolved result; manual review is required.");
}

await main();
