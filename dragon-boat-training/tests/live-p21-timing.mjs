// Opt-in test against the isolated fixture season. No private IDs or credentials
// are persisted; the report contains only action counts, durations and statuses.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const mode = process.argv.includes("--optimized") ? "optimized" : "baseline";
assert(process.argv.includes("--write-test-data") && process.env.DBT_API_URL && process.env.DBT_COACH_CODE,
  "Set runtime DBT_API_URL and DBT_COACH_CODE and explicitly allow isolated test writes.");
const report = { mode, measured_at: new Date().toISOString(), samples: [], requests: [] };
const run = randomUUID().replaceAll("-", "_");
let sequence = 0;
async function call(action, payload = {}, post = false) {
  const body = { ...payload, action, request_id: `timing_${run}_${++sequence}` };
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = new URL(process.env.DBT_API_URL);
    if (!post) for (const [key, value] of Object.entries(body)) url.searchParams.set(key, String(value));
    const start = performance.now();
    let status = "transport_error", responseBytes = 0;
    try {
      const response = await fetch(url, { method: post ? "POST" : "GET", redirect: "follow",
        ...(post ? { headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(45000) });
      const responseText = await response.text();
      responseBytes = Buffer.byteLength(responseText, "utf8");
      const result = JSON.parse(responseText);
      status = result.ok ? "ok" : result.error?.code || "invalid_response";
      if (!result.ok && result.error?.retryable && attempt < 2) continue;
      assert.equal(result.ok, true, status);
      return result.data;
    } catch (error) {
      if (attempt === 2 || error.code === "ERR_ASSERTION") throw error;
    } finally { report.requests.push({ action, method: post ? "POST" : "GET", status, response_bytes: responseBytes, ms: Math.round(performance.now() - start) }); }
  }
}
async function measure(name, fn) {
  const start = performance.now(), count = report.requests.length;
  const result = await fn();
  const sample = { name, ms: Math.round(performance.now() - start), requests: report.requests.length - count };
  report.samples.push(sample);
  console.log(JSON.stringify(sample));
  return result;
}
let bootstrap, roster, state, token, member, ownedSignup;
try {
  await measure("public_home_cold", async () => {
    bootstrap = await call("bootstrap");
    assert.equal(bootstrap.season.name, "P1 Acceptance 2026");
    assert.equal(bootstrap.season.status, "OPEN");
    roster = await call("members", { season_id: bootstrap.season.season_id });
  });
  const practices = bootstrap.weeks.flatMap(w => w.practices).sort((a,b) => a.start_at.localeCompare(b.start_at));
  assert.equal(practices.length, 3);
  const practice = practices[0];
  assert.equal(practice.location, "P1 Test Dock");
  const scope = { season_id: bootstrap.season.season_id, practice_id: practice.practice_id };
  const selected = roster.members.filter(m => m.display_name === "P2 Test Member 20");
  assert.equal(selected.length, 1);
  member = selected[0];
  state = await measure("practice_first_open", () => call("practice", scope));
  assert.equal(state.signups.length, 0, "Never clear existing signups for timing tests.");
  assert(state.signup_open);
  state = await measure("practice_cached_roster", () => call("practice", scope));
  const viewOptions = () => mode === "optimized" ? { include_current_view: true,
    known_roster_version: roster.roster_version, roster_expires_at: roster.expires_at, view_practice_id: scope.practice_id } : {};
  for (let i = 0; i < 2; i++) {
    for (const [action, preference] of [["signup", "LEFT"], ["updateSignup", "RIGHT"], ["cancelSignup", null]]) {
      await measure(`${action}_${i + 1}`, async () => {
        const result = await call(action, { ...scope, ...viewOptions(), member_id: member.member_id,
          signup_version: state.signup_version, practice_version: state.practice.practice_version,
          ...(preference ? { preference } : {}) }, true);
        if (action === "signup") ownedSignup = result.signup;
        if (mode === "optimized") {
          assert.equal(result.view_status, "ready");
          state = result.current_view.practice;
        } else state = await call("practice", scope);
        assert(state);
        assert.equal(state.counts.confirmed, action === "cancelSignup" ? 0 : 1);
        if (action === "cancelSignup") ownedSignup = null;
      });
    }
  }
  await measure("coach_login", async () => {
    const login = await call("coachLogin", { coach_code: process.env.DBT_COACH_CODE }, true);
    token = login.session_token;
    await call("coachBootstrap", { session_token: token }, true);
    if (mode === "baseline") {
      await call("getSeasonManagement", { session_token: token, season_id: scope.season_id }, true);
      const data = await call("listSeasonMembers", { session_token: token, season_id: scope.season_id }, true);
      member = data.members.find(m => m.member_id === member.member_id);
      roster.roster_version = data.roster_version;
      state = await call("practice", scope);
    }
  });
  if (mode === "optimized") {
    const data = await measure("coach_open_members", () => call("getMemberWorkspace", { session_token: token,
      season_id: scope.season_id, practice_id: scope.practice_id }, true));
    member = data.members.find(m => m.member_id === member.member_id);
    roster.roster_version = data.roster_version;
    state = data.practice;
  }
  assert.equal(member.display_name_override, "", "Fixture name has been edited; do not overwrite it.");
  for (const [action, override] of [["updateMember", "P2 Test Member 20 timing"], ["restoreMemberName", null]]) {
    await measure(action, async () => {
      const result = await call(action, { session_token: token, season_id: scope.season_id, ...viewOptions(),
        member_id: member.member_id, member_version: member.member_version,
        ...(override ? { display_name_override: override, default_preference: member.default_preference } : {}) }, true);
      if (mode === "optimized") {
        assert.equal(result.view_status, "ready");
        member = result.current_view.members.find(m => m.member_id === member.member_id);
        roster.roster_version = result.current_view.roster_version;
        state = result.current_view.practice;
      } else {
        const data = await call("listSeasonMembers", { session_token: token, season_id: scope.season_id }, true);
        member = data.members.find(m => m.member_id === member.member_id);
        roster.roster_version = data.roster_version;
        state = await call("practice", scope);
      }
    });
  }
  assert.equal(member.display_name_override, "");
  assert.equal(state.signups.length, 0);
  report.ok = true;
} finally {
  if (token) await call("coachLogout", { session_token: token }, true);
  report.cleanup = report.ok ? "Fixture name restored; no active test signup; Coach session revoked." :
    "Incomplete run: inspect this fixture and original request before any recovery write.";
  report.owned_active_signup = Boolean(ownedSignup);
  if (process.env.DBT_TIMING_REPORT) writeFileSync(process.env.DBT_TIMING_REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ mode, ok: report.ok || false, cleanup: report.cleanup }));
}
