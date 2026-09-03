// Explicit, isolated live test. Not run by npm test. Uses public business APIs;
// never edits Google cells or requires a Coach credential.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (!process.argv.includes("--write-test-data") || !process.env.DBT_API_URL) {
  throw new Error("Set DBT_API_URL and explicitly pass --write-test-data for the isolated acceptance season.");
}
const baseUrl = process.env.DBT_API_URL;
const run = randomUUID().replaceAll("-", "_");
let sequence = 0;
async function request(action, values = {}, write = false) {
  const payload = { ...values, action, request_id: `live_p2_${run}_${++sequence}` };
  const url = new URL(baseUrl);
  if (!write) Object.entries(payload).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, write ? {
        method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: JSON.stringify(payload), redirect: "follow", signal: AbortSignal.timeout(45000)
      } : { redirect: "follow", signal: AbortSignal.timeout(45000) });
      const envelope = await response.json();
      if (envelope.ok || !envelope.error?.retryable || attempt === 2) return envelope;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    console.log(`Retrying original ${action} request after an uncertain result.`);
  }
}
function accepted(response) {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.data;
}
const bootstrap = accepted(await request("bootstrap"));
assert.equal(bootstrap.season.name, "P1 Acceptance 2026", "Refusing to write outside the isolated test season.");
assert.equal(bootstrap.season.status, "OPEN");
const seasonId = bootstrap.season.season_id;
const practices = bootstrap.weeks.flatMap((week) => week.practices).sort((a, b) => a.start_at.localeCompare(b.start_at));
assert.equal(practices.length, 3);
const practice = practices.at(-1);
assert.equal(practice.location, "P1 Test Dock");
const scope = { season_id: seasonId, practice_id: practice.practice_id };
const roster = accepted(await request("members", { season_id: seasonId }));
const names = ["P1 Test Member Alpha", "P1 Test Member Beta", ...Array.from({ length: 20 }, (_, i) => `P2 Test Member ${String(i + 1).padStart(2, "0")}`)];
const members = names.map((name) => {
  const found = roster.members.filter((member) => member.display_name === name);
  assert.equal(found.length, 1, `Expected one fixture member: ${name}`);
  return found[0];
});
let state = accepted(await request("practice", scope));
const ownedSignups = new Map();
assert.equal(state.signups.length, 0, "Live test requires an empty practice; it never clears pre-existing signups.");
assert.equal(state.signup_open, true);
async function read() { state = accepted(await request("practice", scope)); return state; }
async function change(action, member, preference) {
  const result = accepted(await request(action, {
    ...scope, member_id: member.member_id, practice_version: practice.practice_version,
    signup_version: state.signup_version, ...(preference ? { preference } : {})
  }, true));
  state.signup_version = result.signup_version;
  if (action === "signup") ownedSignups.set(member.member_id, result.signup);
  return result;
}
for (let i = 0; i < 19; i++) {
  const result = await change("signup", members[i], i < 10 ? "LEFT" : "RIGHT");
  assert.equal(result.signup.status, "CONFIRMED");
  console.log(`Seeded ${i + 1}/19 confirmed fixtures.`);
}
const leftWaiter = await change("signup", members[19], "LEFT");
assert.equal(leftWaiter.signup.status, "WAITLISTED");
const beforeRace = await read();
assert.equal(beforeRace.counts.confirmed, 19);
assert.equal(beforeRace.counts.left, 10);
const raceBodies = members.slice(20).map((member) => ({
  ...scope, member_id: member.member_id, preference: "AMBIENT",
  practice_version: practice.practice_version, signup_version: state.signup_version
}));
const race = await Promise.all(raceBodies.map((body) => request("signup", body, true)));
assert.equal(race.filter((result) => result.ok).length, 1, "Exactly one competing request may consume the last seat.");
const loser = race.findIndex((result) => !result.ok);
const winner = race.find((result) => result.ok).data;
ownedSignups.set(winner.signup.member_id, winner.signup);
assert.equal(race[loser].error.code, "VERSION_CONFLICT");
await read();
assert.equal(state.counts.confirmed, 20);
const late = await change("signup", members[20 + loser], "AMBIENT");
assert.equal(late.signup.status, "WAITLISTED");
await read();
assert.equal(state.counts.waitlisted, 2);
console.log("PASS: simultaneous final-seat writes confirmed exactly one; refreshed loser joined waitlist.");
const winnerMember = members[20 + (1 - loser)];
const promoted = await change("cancelSignup", winnerMember);
assert.deepEqual(promoted.promoted_member_ids, [members[20 + loser].member_id]);
await read();
assert.equal(state.counts.confirmed, 20);
assert.equal(state.signups.find((row) => row.member_id === members[19].member_id).status, "WAITLISTED");
await change("cancelSignup", members[20 + loser]);
await read();
const originalQueue = state.signups.find((row) => row.member_id === members[0].member_id);
const moved = await change("updateSignup", members[0], "RIGHT");
assert.equal(moved.signup.status, "CONFIRMED");
assert.equal(moved.signup.queue_at, originalQueue.queue_at);
assert.equal(moved.signup.queue_sequence, originalQueue.queue_sequence);
assert.deepEqual(moved.promoted_member_ids, [members[19].member_id]);
await read();
assert.equal(state.counts.confirmed, 20);
const back = await change("updateSignup", members[0], "LEFT");
assert.equal(back.signup.status, "WAITLISTED");
assert.equal(back.signup.queue_at, originalQueue.queue_at);
await read();
assert.equal(state.signups.find((row) => row.member_id === members[19].member_id).status, "CONFIRMED");
const returned = await change("cancelSignup", members[1]);
assert.deepEqual(returned.promoted_member_ids, [members[0].member_id]);
console.log("PASS: compatible waitlist promotion, preserved change timestamp, no displacement on changing back.");
await read();
// Cleanup is limited to the exact records created by this run. Never iterate
// all current signups as mutation targets, even though the practice began empty.
for (const member of members) {
  const owned = ownedSignups.get(member.member_id);
  if (!owned) continue;
  await read();
  const active = state.signups.find((row) => row.member_id === member.member_id);
  if (!active) continue;
  assert.equal(active.queue_at, owned.queue_at, "Queue ownership changed; manual review required, no cleanup write.");
  assert.equal(active.queue_sequence, owned.queue_sequence, "Queue ownership changed; manual review required, no cleanup write.");
  await change("cancelSignup", member);
}
await read();
assert.equal(state.signups.filter((row) => ownedSignups.has(row.member_id)).length, 0);
console.log(JSON.stringify({ ok: true, phase: "P2", fixture_members: members.length,
  competing_writes: 2, final_confirmed: 0, final_waitlisted: 0,
  cleaned_up: "Only this run's active signups were cancelled; member and audit records retained." }));
