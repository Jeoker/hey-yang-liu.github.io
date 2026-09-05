import assert from "node:assert/strict";
import test from "node:test";

import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

const ok = (response) => {
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
};

const fails = (response, code) => {
  assert.equal(response.ok, false, JSON.stringify(response));
  assert.equal(response.error.code, code, JSON.stringify(response));
};

async function fixture({ templates = [3] } = {}) {
  const backend = await createBackend({ properties: { DRAGON_BOAT_SESSION_TTL_SECONDS: "86400" } });
  let now = Date.parse("2026-08-31T12:00:00.000Z");
  let requestNumber = 0;
  backend.context.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const requestId = () => `p4_test_${String(++requestNumber).padStart(6, "0")}`;
  let token = ok(post(backend.context, {
    action: "coachLogin", request_id: requestId(), coach_code: "coach-code-123"
  })).session_token;
  const send = (action, input = {}, fixedId) => post(backend.context, {
    action, request_id: fixedId || requestId(), session_token: token, ...input
  });
  const get = (action, input = {}) => payload(backend.context.doGet({
    parameter: { action, request_id: requestId(), ...input }
  }));
  const binding = backend.createFormBinding({ rows: [
    ["2026-08-31T10:00:00.000Z", "Archive Alice"],
    ["2026-08-31T10:01:00.000Z", "Archive Bob"],
    ["2026-08-31T10:02:00.000Z", "Archive Coach"]
  ] });
  let season = ok(send("createSeason", {
    name: "Archive Fixture 2026", start_date: "2026-08-31", end_date: "2026-09-02",
    timezone: "America/New_York"
  })).season;
  season = ok(send("initializeSeason", {
    season_id: season.season_id, season_version: season.season_version,
    form: binding.formId, spreadsheet: binding.spreadsheetId,
    response_sheet: binding.responseSheet.getName(), display_name_header: "Display Name"
  })).season;
  season = ok(send("updateScheduleTemplates", {
    season_id: season.season_id, season_version: season.season_version,
    templates: templates.map((day) => ({ day_of_week: day, start_time: "10:00", end_time: "12:00",
      location: `Archive Dock ${day}`, address: `${day} River Road`, map_url: "" }))
  })).season;
  const prepared = ok(send("updateTrainingWeek", {
    season_id: season.season_id, season_version: season.season_version, week_start_date: "2026-08-31"
  }));
  const opened = ok(send("confirmTrainingWeek", {
    season_id: season.season_id, week_id: prepared.week.week_id, week_version: prepared.week.week_version
  }));
  const members = sheetRecords(binding.runtimeSpreadsheet, "Members");
  const practice = (index = 0) => {
    const stored = backend.context.requireSeason_(season.season_id);
    return backend.context.requirePractice_(stored, opened.practices[index].practice_id);
  };
  const signupState = (practiceId) => backend.context.getSignupState_(
    backend.context.requireSeason_(season.season_id), practiceId
  );
  const signup = (practiceIndex, memberIndex, preference) => {
    const target = practice(practiceIndex);
    return ok(send("signupByCoach", {
      season_id: season.season_id, practice_id: target.practice_id, member_id: members[memberIndex].member_id,
      preference, practice_version: Number(target.practice_version), signup_version: signupState(target.practice_id).version
    }));
  };
  const publishSeats = (practiceIndex = 0) => {
    const target = practice(practiceIndex);
    let workspace = ok(send("getSeatingWorkspace", { season_id: season.season_id, practice_id: target.practice_id }));
    const seats = ["LEFT", "RIGHT"].flatMap((side) =>
      Array.from({ length: 10 }, (_, index) => ({ row_number: index + 1, side, member_id: "" }))
    );
    seats.find((seat) => seat.row_number === 1 && seat.side === "LEFT").member_id = members[0].member_id;
    seats.find((seat) => seat.row_number === 1 && seat.side === "RIGHT").member_id = members[1].member_id;
    workspace = ok(send("saveSeatPlanDraft", {
      season_id: season.season_id, practice_id: target.practice_id,
      practice_version: workspace.practice.practice_version, signup_version: workspace.signup_version,
      seat_plan_version: workspace.seat_plan_version, published_revision: workspace.published_revision,
      coach_member_id: members[2].member_id, steerer_member_id: members[2].member_id,
      seats, change_kind: "EDIT"
    }));
    return ok(send("publishSeatPlan", {
      season_id: season.season_id, practice_id: target.practice_id,
      practice_version: workspace.practice.practice_version, signup_version: workspace.signup_version,
      seat_plan_version: workspace.seat_plan_version, published_revision: workspace.published_revision,
      acknowledge_preference_mismatch: false
    }));
  };
  const cancelPractice = (practiceIndex) => {
    const target = practice(practiceIndex);
    const preview = ok(send("previewPracticeChange", {
      season_id: season.season_id, practice_id: target.practice_id, change: "CANCEL"
    }));
    return ok(send("cancelPractice", {
      season_id: season.season_id, week_id: target.week_id, practice_id: target.practice_id,
      week_version: preview.week_version, practice_version: preview.practice_version,
      signup_version: preview.signup_version, preview_token: preview.preview_token
    }));
  };
  return {
    backend, binding, season, opened, members, send, get, practice, signup, publishSeats, cancelPractice,
    setTime(value) { now = Date.parse(value); },
    login() {
      token = ok(post(backend.context, {
        action: "coachLogin", request_id: requestId(), coach_code: "coach-code-123"
      })).session_token;
      return token;
    }
  };
}

test("P4 freezes, archives and publishes one season without duplicating annual files", async () => {
  const f = await fixture();
  f.signup(0, 0, "LEFT");
  f.signup(0, 1, "RIGHT");
  f.publishSeats();
  f.setTime("2026-09-03T17:00:00.000Z");

  const first = f.backend.context.publishDueTrainingWeeks();
  assert.equal(first.published_count, 0);
  assert.equal(first.practice_archived_count, 1);
  assert.equal(first.season_archived_count, 1);
  assert.equal(f.backend.context.requireSeason_(f.season.season_id).status, "ARCHIVED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "AnnualArchiveFiles").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PracticeArchives").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "SeasonArchives")[0].status, "PUBLISHED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 1);

  const annual = sheetRecords(f.backend.spreadsheet, "AnnualArchiveFiles")[0];
  const archiveFile = f.backend.spreadsheets.get(annual.spreadsheet_id);
  assert.ok(archiveFile);
  assert.equal(archiveFile.getSheets().length, 2);
  assert.ok(archiveFile.getSheets().every((sheet) => sheet.getName() !== "Sheet1"));

  const second = f.backend.context.publishDueTrainingWeeks();
  assert.equal(second.practice_archived_count, 0);
  assert.equal(second.season_archived_count, 0);
  assert.equal(sheetRecords(f.backend.spreadsheet, "AnnualArchiveFiles").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PracticeArchives").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 1);

  const seasons = ok(f.get("historySeasons"));
  assert.deepEqual(seasons.seasons.map((season) => season.season_id), [f.season.season_id]);
  assert.equal(seasons.seasons[0].practice_count, 1);
  const history = ok(f.get("seasonHistory", { season_id: f.season.season_id }));
  assert.equal(history.practices[0].final_status, "FROZEN");
  const archived = ok(f.get("archivedPractice", {
    season_id: f.season.season_id, practice_id: f.practice().practice_id
  }));
  assert.equal(archived.seat_plan.status, "FROZEN");
  assert.equal(archived.seat_plan.rows[0].left.display_name, "Archive Alice");
  assert.equal(archived.seat_plan.coach.display_name, "Archive Coach");
  assert.equal(JSON.stringify(archived).includes(f.members[0].member_id), false);
});

test("P4 treats cancelled training as nonexistent outside its operational tombstone", async () => {
  const f = await fixture({ templates: [2, 3] });
  const cancelledId = f.practice(0).practice_id;
  const retainedId = f.practice(1).practice_id;
  f.cancelPractice(0);
  const bootstrap = ok(f.get("bootstrap", { season_id: f.season.season_id }));
  assert.deepEqual(bootstrap.weeks.flatMap((week) => week.practices).map((practice) => practice.practice_id), [retainedId]);
  fails(f.get("practice", { season_id: f.season.season_id, practice_id: cancelledId }), "PRACTICE_NOT_PUBLIC");

  f.setTime("2026-09-03T17:00:00.000Z");
  f.backend.context.runDragonBoatArchiveTasks();
  assert.deepEqual(sheetRecords(f.backend.spreadsheet, "PracticeArchives").map((row) => row.practice_id), [retainedId]);
  assert.deepEqual(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").map((row) => row.practice_id), [retainedId]);
  assert.equal(sheetRecords(f.binding.runtimeSpreadsheet, "Practices").find((row) => row.practice_id === cancelledId).cancelled_at !== "", true);

  const seasonArchive = sheetRecords(f.backend.spreadsheet, "SeasonArchives")[0];
  const archiveFile = f.backend.spreadsheets.get(seasonArchive.spreadsheet_id);
  const seasonSheet = archiveFile.getSheetByName(seasonArchive.sheet_name);
  const payloadText = seasonSheet.rows.flat().join("\n");
  assert.equal(payloadText.includes(cancelledId), false);
  assert.equal(payloadText.includes('"action":"cancelPractice"'), false);
});

test("P4 publishes an explicit unpublished result when no formal seating revision exists", async () => {
  const f = await fixture();
  f.setTime("2026-09-03T17:00:00.000Z");
  f.backend.context.runDragonBoatArchiveTasks();
  const archived = ok(f.get("archivedPractice", {
    season_id: f.season.season_id, practice_id: f.practice().practice_id
  }));
  assert.equal(archived.seat_plan.status, "UNPUBLISHED");
  assert.equal(archived.seat_plan.published_revision, 0);
  assert.deepEqual(archived.seat_plan.rows, []);
});

test("P4 appends versioned public correction notes without rewriting the frozen snapshot", async () => {
  const f = await fixture();
  f.signup(0, 0, "LEFT");
  f.signup(0, 1, "RIGHT");
  f.publishSeats();
  f.setTime("2026-09-03T17:00:00.000Z");
  f.backend.context.runDragonBoatArchiveTasks();
  f.login();
  const practiceId = f.practice().practice_id;
  const before = ok(f.get("archivedPractice", { season_id: f.season.season_id, practice_id: practiceId }));
  const fixedId = "p4_history_note_fixed";
  const input = { season_id: f.season.season_id, practice_id: practiceId,
    history_version: before.history_version, note: "实际训练记录补充：天气原因缩短了训练时间。" };
  const first = ok(f.send("appendHistoryCorrection", input, fixedId));
  const replay = ok(f.send("appendHistoryCorrection", input, fixedId));
  assert.deepEqual(replay, first);
  assert.equal(sheetRecords(f.backend.spreadsheet, "HistoryCorrections").length, 1);

  const after = ok(f.get("archivedPractice", { season_id: f.season.season_id, practice_id: practiceId }));
  assert.equal(after.history_version, before.history_version + 1);
  assert.equal(after.corrections.length, 1);
  assert.equal(after.seat_plan.rows[0].left.display_name, before.seat_plan.rows[0].left.display_name);
  fails(f.send("appendHistoryCorrection", { ...input, note: "Another note" }), "VERSION_CONFLICT");

  const management = ok(f.send("getArchiveManagement", { season_id: f.season.season_id }));
  assert.equal(management.archive_status, "PUBLISHED");
  assert.equal(management.annual_files.length, 1);
  assert.match(management.annual_files[0].spreadsheet_url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\//);
  assert.equal(management.practices[0].corrections.length, 1);
  const audit = ok(f.send("listManagementAudit", { season_id: f.season.season_id, limit: 200 }));
  assert.ok(audit.events.some((event) => event.action === "HISTORY_CORRECTION_APPENDED"));
});

test("P4 recovers a failed practice archive on the next maintenance run", async () => {
  const f = await fixture();
  f.setTime("2026-09-03T17:00:00.000Z");
  const original = f.backend.context.writeAndVerifyArchiveTab_;
  let interrupted = false;
  f.backend.context.writeAndVerifyArchiveTab_ = function (...args) {
    if (!interrupted && String(args[1]).startsWith("Practice ")) {
      interrupted = true;
      throw Object.assign(new Error("archive interruption"), { code: "ARCHIVE_VERIFY_FAILED" });
    }
    return original(...args);
  };
  assert.throws(() => f.backend.context.runDragonBoatArchiveTasks(), /archive interruption/);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PracticeArchives")[0].status, "ERROR");
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 0);

  f.backend.context.writeAndVerifyArchiveTab_ = original;
  const recovered = f.backend.context.runDragonBoatArchiveTasks();
  assert.equal(recovered.practice_archived_count, 1);
  assert.equal(recovered.season_archived_count, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PracticeArchives")[0].status, "SUCCEEDED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "AnnualArchiveFiles").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 1);
});

test("P4 resumes public history projection after a private season archive succeeds", async () => {
  const f = await fixture();
  f.setTime("2026-09-03T17:00:00.000Z");
  const original = f.backend.context.appendSheetRecord_;
  let interrupted = false;
  f.backend.context.appendSheetRecord_ = function (sheetName, record) {
    if (!interrupted && sheetName === "PublicHistoryIndex") {
      interrupted = true;
      throw new Error("history projection interruption");
    }
    return original(sheetName, record);
  };
  assert.throws(() => f.backend.context.runDragonBoatArchiveTasks(), /history projection interruption/);
  assert.equal(f.backend.context.requireSeason_(f.season.season_id).status, "ARCHIVED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "SeasonArchives")[0].status, "PRIVATE_ARCHIVED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 0);

  f.backend.context.appendSheetRecord_ = original;
  const recovered = f.backend.context.runDragonBoatArchiveTasks();
  assert.equal(recovered.practice_archived_count, 0);
  assert.equal(recovered.season_archived_count, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "SeasonArchives")[0].status, "PUBLISHED");
  assert.equal(sheetRecords(f.backend.spreadsheet, "AnnualArchiveFiles").length, 1);
  assert.equal(sheetRecords(f.backend.spreadsheet, "PublicHistoryIndex").length, 1);
});
