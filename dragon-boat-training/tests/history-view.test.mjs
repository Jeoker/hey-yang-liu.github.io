import assert from "node:assert/strict";
import test from "node:test";

import { groupHistorySeasons, historyHref, visibleHistoryPractices } from "../frontend/lib/history-view.js";

test("history directory groups newest years and seasons first", () => {
  const grouped = groupHistorySeasons([
    { season_id: "season_a", archive_year: "2025", latest_practice_at: "2025-08-01T00:00:00Z" },
    { season_id: "season_b", archive_year: "2026", latest_practice_at: "2026-05-01T00:00:00Z" },
    { season_id: "season_c", archive_year: "2026", latest_practice_at: "2026-08-01T00:00:00Z" }
  ]);
  assert.deepEqual(grouped.map((group) => group.year), ["2026", "2025"]);
  assert.deepEqual(grouped[0].seasons.map((season) => season.season_id), ["season_c", "season_b"]);
});

test("history links preserve explicit season and practice identities", () => {
  assert.equal(
    historyHref("/base/dragon-boat-training/history/", "season a&b", "practice/one"),
    "/base/dragon-boat-training/history/?season_id=season+a%26b&practice_id=practice%2Fone"
  );
});

test("history cards omit cancellation records even if an older API leaks them", () => {
  const visible = visibleHistoryPractices([
    { practice_id: "cancelled", start_at: "2026-09-03", cancelled: true },
    { practice_id: "newer", start_at: "2026-09-02" },
    { practice_id: "older", start_at: "2026-09-01" }
  ]);
  assert.deepEqual(visible.map((practice) => practice.practice_id), ["newer", "older"]);
});
