import assert from "node:assert/strict";
import test from "node:test";

import { createBackend, payload } from "./backend-test-runtime.mjs";

const ok = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
};

let publicRequestNumber = 0;

function publicGet(backend, action, input = {}) {
  publicRequestNumber += 1;
  return ok(payload(backend.context.doGet({
    parameter: { action, request_id: `p5_public_${String(publicRequestNumber).padStart(6, "0")}`, ...input }
  })));
}

function historyRow({ seasonIndex = 0, practiceIndex = 0, seasonId, practiceId } = {}) {
  const start = new Date(Date.UTC(2026, 0, 1) + (seasonIndex * 40 + practiceIndex) * 86400000);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const resolvedSeasonId = seasonId || `season_p5_${String(seasonIndex).padStart(3, "0")}`;
  const resolvedPracticeId = practiceId || `practice_p5_${String(practiceIndex).padStart(3, "0")}`;
  const snapshot = {
    season: { season_id: resolvedSeasonId, name: `Season ${seasonIndex}` },
    practice: { practice_id: resolvedPracticeId, start_at: start.toISOString(), end_at: end.toISOString() },
    seat_plan: { status: "UNPUBLISHED", rows: [] }
  };
  return {
    history_key: `${resolvedSeasonId}:${resolvedPracticeId}`,
    season_id: resolvedSeasonId,
    season_name: `Season ${seasonIndex}`,
    season_start_date: start.toISOString().slice(0, 10),
    season_end_date: end.toISOString().slice(0, 10),
    season_timezone: "America/New_York",
    archive_year: start.toISOString().slice(0, 4),
    practice_id: resolvedPracticeId,
    practice_start_at: start.toISOString(),
    practice_end_at: end.toISOString(),
    location: "P5 Dock",
    address: "5 River Road",
    map_url: "",
    final_status: "UNPUBLISHED",
    published_revision: 0,
    published_at: "",
    public_snapshot_json: JSON.stringify(snapshot),
    history_version: 0,
    created_at: start.toISOString(),
    updated_at: start.toISOString()
  };
}

async function p5Backend() {
  const backend = await createBackend();
  backend.context.setupDragonBoatP4();
  return backend;
}

test("P5 batch-appends public history rows and paginates the cached directory", async () => {
  const backend = await p5Backend();
  const sheet = backend.spreadsheet.getSheetByName("PublicHistoryIndex");
  const originalGetRange = sheet.getRange.bind(sheet);
  const writes = [];
  sheet.getRange = function (row, column, rowCount, columnCount) {
    const range = originalGetRange(row, column, rowCount, columnCount);
    const originalSetValues = range.setValues.bind(range);
    range.setValues = function (values) {
      if (row > 1) writes.push({ row, rowCount, columnCount });
      return originalSetValues(values);
    };
    return range;
  };

  const rows = Array.from({ length: 35 }, (_, seasonIndex) => historyRow({ seasonIndex }));
  backend.context.appendSheetRecords_("PublicHistoryIndex", rows);
  backend.properties.deleteProperty("DRAGON_BOAT_HISTORY_INDEX_READY");
  assert.deepEqual(writes, [{ row: 2, rowCount: 35, columnCount: 20 }],
    "one projection batch should use one Sheets write range");

  const first = publicGet(backend, "historySeasons", { limit: "10" });
  assert.equal(first.seasons.length, 10);
  assert.equal(first.total_count, 35);
  assert.equal(first.next_cursor, "10");

  const originalRead = backend.context.getSheetRecords_;
  backend.context.getSheetRecords_ = function (sheetName) {
    if (sheetName === "PublicHistoryIndex") throw new Error("directory cache was bypassed");
    return originalRead(sheetName);
  };
  const second = publicGet(backend, "historySeasons", { limit: "10", cursor: first.next_cursor });
  assert.equal(second.seasons.length, 10);
  assert.equal(second.next_cursor, "20");
  assert.equal(new Set([...first.seasons, ...second.seasons].map((season) => season.season_id)).size, 20);

  backend.cacheValues.clear();
  const coldPage = publicGet(backend, "historySeasons", { limit: "10", cursor: second.next_cursor });
  assert.equal(coldPage.seasons.length, 10,
    "a cache miss should use the compact season index instead of scanning every archived practice");
});

test("P5 paginates and caches one season history and archived practice detail", async () => {
  const backend = await p5Backend();
  const seasonId = "season_p5_shared";
  const rows = Array.from({ length: 35 }, (_, practiceIndex) => historyRow({
    seasonIndex: 0,
    practiceIndex,
    seasonId,
    practiceId: `practice_p5_${String(practiceIndex).padStart(3, "0")}`
  }));
  backend.context.appendSheetRecords_("PublicHistoryIndex", rows);
  backend.properties.deleteProperty("DRAGON_BOAT_HISTORY_INDEX_READY");

  const first = publicGet(backend, "seasonHistory", { season_id: seasonId, limit: "15" });
  assert.equal(first.practices.length, 15);
  assert.equal(first.total_count, 35);
  assert.equal(first.next_cursor, "15");

  const detail = publicGet(backend, "archivedPractice", {
    season_id: seasonId,
    practice_id: first.practices[0].practice_id
  });
  assert.equal(detail.practice.practice_id, first.practices[0].practice_id);

  const originalRead = backend.context.getSheetRecords_;
  const originalHistoryPractice = backend.context.historyPracticeInternal_;
  backend.context.getSheetRecords_ = function (sheetName) {
    if (["PublicHistoryIndex", "HistoryCorrections"].includes(sheetName)) {
      throw new Error("history cache was bypassed");
    }
    return originalRead(sheetName);
  };
  backend.context.historyPracticeInternal_ = function () {
    throw new Error("practice cache was bypassed");
  };

  const second = publicGet(backend, "seasonHistory", {
    season_id: seasonId,
    limit: "15",
    cursor: first.next_cursor
  });
  assert.equal(second.practices.length, 15);
  assert.equal(second.next_cursor, "30");
  assert.equal(new Set([...first.practices, ...second.practices].map((practice) => practice.practice_id)).size, 30);

  const cachedDetail = publicGet(backend, "archivedPractice", {
    season_id: seasonId,
    practice_id: detail.practice.practice_id
  });
  assert.deepEqual(cachedDetail, detail);

  backend.context.historyPracticeInternal_ = originalHistoryPractice;
  backend.cacheValues.clear();
  const coldFinalPage = publicGet(backend, "seasonHistory", {
    season_id: seasonId,
    limit: "15",
    cursor: second.next_cursor
  });
  assert.equal(coldFinalPage.practices.length, 5,
    "a cache miss should read the compact season summary rather than the growing practice index");
  const coldDetail = publicGet(backend, "archivedPractice", {
    season_id: seasonId,
    practice_id: detail.practice.practice_id
  });
  assert.deepEqual(coldDetail, detail,
    "a detail cache miss should use the persisted row pointer and correction projection");
});
