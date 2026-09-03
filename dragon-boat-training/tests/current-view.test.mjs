import assert from "node:assert/strict";
import test from "node:test";
import { validPracticeView, olderPracticeView, usableRoster } from "../frontend/lib/current-view.js";

const snapshot = () => ({ season_id: "s1", practice: { practice_id: "p1", practice_version: 2 },
  signup_version: 4, roster_version: 6, binding_version: 1, signup_open: true, counts: {}, signups: [],
  generated_at: "2026-09-02T12:00:00Z" });

test("practice response checks isolate entities and reject incomplete versions", () => {
  assert.equal(validPracticeView(snapshot(), "s1", "p1"), true);
  assert.equal(validPracticeView(snapshot(), "s2", "p1"), false);
  assert.equal(validPracticeView(snapshot(), "s1", "p2"), false);
  assert.equal(validPracticeView({ ...snapshot(), signup_version: "4" }, "s1", "p1"), false);
  assert.equal(validPracticeView({ ...snapshot(), signups: null }, "s1", "p1"), false);
});

test("late responses cannot downgrade any version or reopen a time-closed view", () => {
  const current = snapshot();
  for (const key of ["signup_version", "roster_version", "binding_version"]) {
    assert.equal(olderPracticeView({ ...current, [key]: current[key] - 1 }, current), true);
  }
  assert.equal(olderPracticeView({ ...current, practice: { ...current.practice, practice_version: 1 } }, current), true);
  assert.equal(olderPracticeView({ ...current, generated_at: "2026-09-02T11:59:59Z" }, current), true);
  assert.equal(olderPracticeView({ ...current, signup_version: 5 }, current), false);
  assert.equal(olderPracticeView({ ...current, season_id: "s2", signup_version: 1 }, current), false);
});

test("roster reuse stops at the absolute expiry and every season/version boundary", () => {
  const season = snapshot(), now = Date.parse(season.generated_at);
  const roster = { ...season, members: [], expires_at: "2026-09-02T12:10:00Z" };
  assert.equal(usableRoster(roster, season, now), true);
  assert.equal(usableRoster(roster, season, now + 600000), false);
  for (const key of ["season_id", "roster_version", "binding_version"]) {
    assert.equal(usableRoster({ ...roster, [key]: "different" }, season, now), false);
  }
});
