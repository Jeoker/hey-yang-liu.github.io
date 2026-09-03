import assert from "node:assert/strict";
import test from "node:test";
import { createBackend } from "./backend-test-runtime.mjs";

const NOW = "2026-09-02T12:00:00.000Z";

function countDataReads(sheet) {
  let reads = 0;
  const getRange = sheet.getRange.bind(sheet);
  sheet.getRange = (...args) => {
    const range = getRange(...args);
    if (args[0] >= 2) {
      const getValues = range.getValues.bind(range);
      range.getValues = () => { reads++; return getValues(); };
    }
    return range;
  };
  return () => reads;
}

async function createStores() {
  const backend = await createBackend();
  const context = backend.context;
  const binding = backend.createFormBinding();
  context.ensureSeasonRuntimeSheets_(binding.runtimeSpreadsheet);
  const season = { season_id: "season_cache_a", runtime_spreadsheet_id: binding.spreadsheetId };
  const systemRow = (id, value) => ({
    setting_key: id, setting_value: value, settings_version: 1,
    updated_by: "cache_test", updated_at: NOW
  });
  const memberRow = (id, value) => ({
    season_id: season.season_id, member_id: id, source_key: id,
    source_display_name: value, display_name_override: "", status: "ACTIVE",
    default_preference: "AMBIENT", member_version: 1, created_at: NOW, updated_at: NOW
  });
  const stores = [
    {
      name: "system", valueField: "setting_value", idField: "setting_key",
      sheet: backend.spreadsheet.getSheetByName("SystemSettings"),
      read: () => context.getSheetRecords_("SystemSettings"),
      append: (row) => context.appendSheetRecord_("SystemSettings", row),
      update: (row) => context.updateSheetRecord_("SystemSettings", row),
      row: systemRow
    },
    {
      name: "season", valueField: "source_display_name", idField: "member_id",
      sheet: binding.runtimeSpreadsheet.getSheetByName("Members"),
      read: () => context.getSeasonSheetRecords_(season, "Members"),
      append: (row) => context.appendSeasonSheetRecord_(season, "Members", row),
      update: (row) => context.updateSeasonSheetRecord_(season, "Members", row),
      row: memberRow
    }
  ].map((store) => {
    store.append(store.row("cache_initial", "Original value"));
    return { ...store, reads: countDataReads(store.sheet) };
  });
  return { backend, context, binding, season, stores };
}

test("request-local store caches avoid repeat reads and protect both first and cached results from mutation", async () => {
  const { context, stores } = await createStores();
  context.withDragonBoatScriptLock_(() => {
    for (const store of stores) {
      const first = store.read();
      assert.equal(first.length, 1, store.name);
      first[0][store.valueField] = "Unsaved first-result change";
      first.push(store.row("not_persisted", "Not persisted"));
      const second = store.read();
      assert.equal(second.length, 1, store.name);
      assert.equal(second[0][store.valueField], "Original value", store.name);
      second[0][store.valueField] = "Unsaved cache-result change";
      second[0]._rowNumber = 999;
      const third = context.withDragonBoatScriptLock_(() => store.read());
      assert.equal(third[0][store.valueField], "Original value", store.name);
      assert.equal(third[0]._rowNumber, 2, store.name);
      assert.equal(store.reads(), 1, `${store.name} should read the data range once in a lock`);
    }
  });
  assert.equal(context.dragonBoatRecordCache_, null);
  assert.equal(context.dragonBoatStoreHandles_, null);
});

test("append and update invalidate the matching store cache and expose persisted values immediately", async () => {
  const { context, stores } = await createStores();
  context.withDragonBoatScriptLock_(() => {
    for (const store of stores) {
      store.read();
      store.append(store.row("cache_appended", "Appended value"));
      const appended = store.read();
      assert.equal(appended.length, 2, store.name);
      assert.equal(appended[1][store.valueField], "Appended value", store.name);
      assert.equal(store.reads(), 2, store.name);
      appended[0][store.valueField] = "Updated value";
      store.update(appended[0]);
      const updated = store.read();
      assert.equal(updated[0][store.valueField], "Updated value", store.name);
      assert.equal(updated[1][store.valueField], "Appended value", store.name);
      store.read();
      assert.equal(store.reads(), 3, `${store.name} should re-read once per write, then reuse the refreshed snapshot`);
    }
  });
});

test("a later lock and unlocked reads never reuse an earlier request snapshot", async () => {
  const { context, stores } = await createStores();
  context.withDragonBoatScriptLock_(() => stores.forEach((store) => store.read()));
  for (const store of stores) {
    const column = store.sheet.rows[0].indexOf(store.valueField) + 1;
    // Represents another execution or a direct administrator Sheet edit.
    store.sheet.getRange(2, column, 1, 1).setValues([["Changed between requests"]]);
  }
  context.withDragonBoatScriptLock_(() => {
    for (const store of stores) {
      assert.equal(store.read()[0][store.valueField], "Changed between requests", store.name);
      assert.equal(store.reads(), 2, store.name);
    }
  });
  for (const store of stores) {
    store.read();
    store.read();
    assert.equal(store.reads(), 4, `${store.name} must not cache unlocked reads`);
  }
});

test("callback or flush failure clears request caches and releases the lock before recovery reads", async () => {
  const { context, stores } = await createStores();
  let releases = 0;
  context.LockService.getScriptLock = () => ({ waitLock() {}, releaseLock() { releases++; } });
  assert.throws(() => context.withDragonBoatScriptLock_(() => {
    stores.forEach((store) => store.read());
    throw new Error("Injected callback failure");
  }), /Injected callback failure/);
  assert.equal(context.dragonBoatRecordCache_, null);
  assert.equal(context.dragonBoatStoreHandles_, null);
  assert.equal(context.dragonBoatLockDepth_, 0);
  assert.equal(releases, 1);

  context.SpreadsheetApp.flush = () => { throw new Error("Injected flush failure"); };
  assert.throws(() => context.withDragonBoatScriptLock_(() => stores.forEach((store) => store.read())), /Injected flush failure/);
  assert.equal(context.dragonBoatRecordCache_, null);
  assert.equal(context.dragonBoatStoreHandles_, null);
  assert.equal(context.dragonBoatLockDepth_, 0);
  assert.equal(releases, 2);
  context.SpreadsheetApp.flush = () => {};
  context.withDragonBoatScriptLock_(() => stores.forEach((store) => store.read()));
  assert.equal(releases, 3);
  stores.forEach((store) => assert.equal(store.reads(), 3, store.name));
});

test("season record cache keys isolate season and spreadsheet identities", async () => {
  const { backend, context, binding, season } = await createStores();
  const secondSeason = { ...season, season_id: "season_cache_b" };
  context.appendSeasonSheetRecord_(secondSeason, "Members", {
    season_id: secondSeason.season_id, member_id: "member_season_b", source_display_name: "Second season", status: "ACTIVE"
  });
  const otherBinding = backend.createFormBinding({ formId: "form-cache-other", spreadsheetId: "runtime-cache-other" });
  context.ensureSeasonRuntimeSheets_(otherBinding.runtimeSpreadsheet);
  const otherSpreadsheet = { ...season, runtime_spreadsheet_id: otherBinding.spreadsheetId };
  context.appendSeasonSheetRecord_(otherSpreadsheet, "Members", {
    season_id: season.season_id, member_id: "member_other_sheet", source_display_name: "Other spreadsheet", status: "ACTIVE"
  });
  context.withDragonBoatScriptLock_(() => {
    const first = context.getSeasonSheetRecords_(season, "Members");
    const second = context.getSeasonSheetRecords_(secondSeason, "Members");
    const other = context.getSeasonSheetRecords_(otherSpreadsheet, "Members");
    assert.deepEqual(first.map((row) => row.member_id), ["cache_initial"]);
    assert.deepEqual(second.map((row) => row.member_id), ["member_season_b"]);
    assert.deepEqual(other.map((row) => row.member_id), ["member_other_sheet"]);
    assert.equal(context.getSeasonSheetRecords_(season, "Members")[0].source_display_name, "Original value");
    assert.equal(context.getSeasonSheetRecords_(secondSeason, "Members")[0].source_display_name, "Second season");
    assert.equal(context.getSeasonSheetRecords_(otherSpreadsheet, "Members")[0].source_display_name, "Other spreadsheet");
  });
  assert.equal(binding.runtimeSpreadsheet.getSheetByName("Members").getLastRow(), 3);
});
