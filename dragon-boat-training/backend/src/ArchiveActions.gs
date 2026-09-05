var DRAGON_BOAT_ARCHIVE_TAB_HEADERS_ = ["record_type", "record_key", "payload_json", "captured_at"];
var DRAGON_BOAT_P4_SYSTEM_SHEETS_ = [
  "AnnualArchiveFiles", "PracticeArchives", "SeasonArchives", "PublicHistoryIndex", "HistoryCorrections"
];

function ensureP4SystemSheets_() {
  var spreadsheet = getSystemSpreadsheet_();
  DRAGON_BOAT_P4_SYSTEM_SHEETS_.forEach(function (sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
    ensureSheetHeader_(sheet, DRAGON_BOAT_SHEET_HEADERS_[sheetName]);
  });
}

function archiveYearForPractice_(practice, season) {
  return String(zonedDateTimeParts_(String(practice.start_at), String(season.timezone)).year);
}

function seasonArchiveYear_(season) {
  return String(season.end_date || "").slice(0, 4);
}

function archiveSpreadsheetUrl_(spreadsheetId) {
  return spreadsheetId ? "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(String(spreadsheetId)) + "/edit" : "";
}

function ensureAnnualArchiveFile_(archiveYear, requestId) {
  ensureP4SystemSheets_();
  if (!/^\d{4}$/.test(String(archiveYear))) {
    throw dragonBoatRequestError_("ARCHIVE_CONFIGURATION_ERROR", "The archive year is invalid.");
  }
  var row = findRecord_("AnnualArchiveFiles", "archive_year", archiveYear);
  var now = new Date().toISOString();
  if (row && row.spreadsheet_id) {
    try {
      var existing = SpreadsheetApp.openById(String(row.spreadsheet_id));
      if (String(row.status) !== "READY" || !row.verified_at) {
        row.status = "READY";
        row.verified_at = now;
        row.updated_at = now;
        row.last_error = "";
        updateSheetRecord_("AnnualArchiveFiles", row);
      }
      return { record: row, spreadsheet: existing };
    } catch (error) {
      row.status = "ERROR";
      row.updated_at = now;
      row.last_error = "ARCHIVE_FILE_UNAVAILABLE";
      updateSheetRecord_("AnnualArchiveFiles", row);
      throw dragonBoatRequestError_("ARCHIVE_FILE_UNAVAILABLE", "The annual archive file cannot be opened.", true);
    }
  }
  if (!row) {
    row = appendSheetRecord_("AnnualArchiveFiles", {
      archive_year: archiveYear, spreadsheet_id: "", status: "CREATING",
      creation_request_id: requestId, created_at: now, verified_at: "", updated_at: now, last_error: ""
    });
    SpreadsheetApp.flush();
  }
  try {
    var spreadsheet = SpreadsheetApp.create("Dragon Boat Training Archive " + archiveYear);
    row.spreadsheet_id = spreadsheet.getId();
    row.status = "READY";
    row.created_at = row.created_at || now;
    row.verified_at = now;
    row.updated_at = now;
    row.last_error = "";
    updateSheetRecord_("AnnualArchiveFiles", row);
    SpreadsheetApp.flush();
    return { record: row, spreadsheet: spreadsheet };
  } catch (error) {
    row.status = "ERROR";
    row.updated_at = new Date().toISOString();
    row.last_error = error && error.code ? error.code : "ARCHIVE_FILE_CREATE_FAILED";
    updateSheetRecord_("AnnualArchiveFiles", row);
    if (error && error.isDragonBoatRequestError) throw error;
    throw dragonBoatRequestError_("ARCHIVE_FILE_CREATE_FAILED", "The annual archive file could not be created.", true);
  }
}

function archiveSheetName_(prefix, season, practice) {
  var parts = zonedDateTimeParts_(String(practice ? practice.start_at : season.season_ends_at), String(season.timezone));
  var date = parts.year + "-" + parts.month + "-" + parts.day;
  var suffix = practice ? String(practice.practice_id).slice(-12) : String(season.season_id).slice(-12);
  var name = prefix + " " + date + " " + suffix;
  return name.replace(/[\[\]\:\*\?\/\\]/g, "-").slice(0, 100);
}

function archivePayloadRow_(type, key, value, capturedAt) {
  return [String(type), String(key), JSON.stringify(value), String(capturedAt)];
}

function archivePayloadDigest_(rows) {
  return digestRequestPayload_(rows.map(function (row) { return row.slice(0, 3); }));
}

function writeAndVerifyArchiveTab_(spreadsheet, sheetName, rows, snapshotId, digest, capturedAt) {
  var manifest = archivePayloadRow_("manifest", snapshotId, {
    snapshot_id: snapshotId, snapshot_digest: digest, record_count: rows.length
  }, capturedAt);
  var values = [DRAGON_BOAT_ARCHIVE_TAB_HEADERS_, manifest].concat(rows);
  var sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
  var previousLastRow = sheet.getLastRow();
  sheet.getRange(1, 1, values.length, DRAGON_BOAT_ARCHIVE_TAB_HEADERS_.length)
    .setNumberFormat("@").setValues(values);
  if (previousLastRow > values.length) {
    var blankRows = Array.from({ length: previousLastRow - values.length }, function () {
      return ["", "", "", ""];
    });
    sheet.getRange(values.length + 1, 1, blankRows.length, 4).setNumberFormat("@").setValues(blankRows);
  }
  sheet.setFrozenRows(1);
  SpreadsheetApp.flush();
  var verified = sheet.getRange(1, 1, values.length, 4).getValues();
  if (JSON.stringify(verified) !== JSON.stringify(values)) {
    throw dragonBoatRequestError_("ARCHIVE_VERIFY_FAILED", "The archive snapshot could not be verified.", true);
  }
  var blank = spreadsheet.getSheetByName("Sheet1");
  if (blank && blank !== sheet && blank.getLastRow() === 0 && blank.getLastColumn() === 0 && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(blank);
  }
  return sheet;
}

function practiceArchiveKey_(seasonId, practiceId) {
  return String(seasonId) + ":" + String(practiceId);
}

function practiceArchiveRows_(season, practice, finalSnapshot, capturedAt) {
  var rows = [archivePayloadRow_("practice", practice.practice_id, practiceProjection_(practice), capturedAt)];
  rows.push(archivePayloadRow_("final_snapshot", finalSnapshot.snapshot_id, {
    season_id: String(finalSnapshot.season_id), practice_id: String(finalSnapshot.practice_id),
    snapshot_id: String(finalSnapshot.snapshot_id), revision_number: Number(finalSnapshot.revision_number || 0),
    roles: parseJsonObject_(finalSnapshot.roles_json), seats: parseSeatPlanArray_(finalSnapshot.seats_json),
    names: parseJsonObject_(finalSnapshot.names_json), archive_due_at: String(finalSnapshot.archive_due_at),
    frozen_at: String(finalSnapshot.frozen_at), status: String(finalSnapshot.status)
  }, capturedAt));
  var revision = getSeatPlanRevision_(season, practice.practice_id, finalSnapshot.revision_number);
  if (revision) rows.push(archivePayloadRow_("seat_plan_revision", revision.revision_id, revision, capturedAt));
  getPracticeSignups_(season, practice.practice_id).forEach(function (signup) {
    rows.push(archivePayloadRow_("signup", signup.member_id, signup, capturedAt));
  });
  getSeasonSheetRecords_(season, "AuditLog").filter(function (event) {
    return String(event.entity_id) === String(practice.practice_id);
  }).forEach(function (event) {
    rows.push(archivePayloadRow_("audit_event", event.event_id, event, capturedAt));
  });
  return rows;
}

function archivePractice_(season, practice) {
  if (practice.cancelled_at || !practice.schedule_published_at) return null;
  if (Date.now() < Date.parse(seatPlanArchiveDueAt_(practice))) return null;
  var finalSnapshot = ensurePracticeSeatPlanFrozen_(season, practice);
  if (!finalSnapshot) throw dragonBoatRequestError_("ARCHIVE_NOT_READY", "The final seating snapshot is not ready.", true);
  ensureP4SystemSheets_();
  var key = practiceArchiveKey_(season.season_id, practice.practice_id);
  var existing = findRecord_("PracticeArchives", "archive_key", key);
  if (existing && String(existing.status) === "SUCCEEDED") return existing;
  var archiveYear = archiveYearForPractice_(practice, season);
  var requestId = "archive_practice_" + hmacDigest_(key, getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
  var target = ensureAnnualArchiveFile_(archiveYear, requestId);
  var capturedAt = new Date().toISOString();
  var rows = practiceArchiveRows_(season, practice, finalSnapshot, capturedAt);
  var digest = archivePayloadDigest_(rows);
  var sheetName = existing && existing.sheet_name ? String(existing.sheet_name) : archiveSheetName_("Practice", season, practice);
  var record = existing || appendSheetRecord_("PracticeArchives", {
    archive_key: key, season_id: season.season_id, practice_id: practice.practice_id,
    archive_year: archiveYear, spreadsheet_id: target.record.spreadsheet_id, sheet_name: sheetName,
    snapshot_id: finalSnapshot.snapshot_id, snapshot_digest: digest, status: "STARTED", request_id: requestId,
    started_at: capturedAt, archived_at: "", updated_at: capturedAt, last_error: ""
  });
  try {
    writeAndVerifyArchiveTab_(target.spreadsheet, sheetName, rows, finalSnapshot.snapshot_id, digest, capturedAt);
    record.spreadsheet_id = target.record.spreadsheet_id;
    record.sheet_name = sheetName;
    record.snapshot_id = finalSnapshot.snapshot_id;
    record.snapshot_digest = digest;
    record.status = "SUCCEEDED";
    record.archived_at = capturedAt;
    record.updated_at = capturedAt;
    record.last_error = "";
    updateSheetRecord_("PracticeArchives", record);
    appendSeasonAudit_(season, requestId, "SYSTEM", "archive_worker", "PRACTICE_ARCHIVED",
      "PRACTICE", practice.practice_id, { snapshot_id: finalSnapshot.snapshot_id, archive_year: archiveYear });
    return record;
  } catch (error) {
    record.status = "ERROR";
    record.updated_at = new Date().toISOString();
    record.last_error = error && error.code ? error.code : "ARCHIVE_WRITE_FAILED";
    updateSheetRecord_("PracticeArchives", record);
    throw error;
  }
}

function seasonArchiveRows_(season, capturedAt) {
  var practices = getSeasonSheetRecords_(season, "Practices");
  var cancelled = {};
  practices.forEach(function (practice) { if (practice.cancelled_at) cancelled[String(practice.practice_id)] = true; });
  var rows = [archivePayloadRow_("season", season.season_id, seasonManagementProjection_(season), capturedAt)];
  function appendRecords(type, records, keyField, filter) {
    records.filter(filter || function () { return true; }).forEach(function (record, index) {
      rows.push(archivePayloadRow_(type, record[keyField] || index, record, capturedAt));
    });
  }
  appendRecords("member", getSeasonSheetRecords_(season, "Members"), "member_id");
  appendRecords("schedule_template", getSeasonSheetRecords_(season, "ScheduleTemplates"), "template_id");
  appendRecords("training_week", getSeasonSheetRecords_(season, "TrainingWeeks"), "week_id");
  appendRecords("practice", practices, "practice_id", function (row) { return !cancelled[String(row.practice_id)]; });
  ["SignupsCurrent", "SeatPlanCurrent", "SeatPlanState", "SeatPlanRevisions", "PracticeFinalSnapshots"].forEach(function (sheetName) {
    appendRecords("runtime_" + sheetName, getSeasonSheetRecords_(season, sheetName), "practice_id", function (row) {
      return !cancelled[String(row.practice_id)];
    });
  });
  appendRecords("runtime_Settings", getSeasonSheetRecords_(season, "Settings"), "setting_key", function (row) {
    var match = /^signup:(.+)$/.exec(String(row.setting_key));
    return !match || !cancelled[match[1]];
  });
  appendRecords("runtime_ImportState", getSeasonSheetRecords_(season, "ImportState"), "response_sheet_id");
  appendRecords("runtime_Health", getSeasonSheetRecords_(season, "Health"), "health_key");
  appendRecords("audit_event", getSeasonSheetRecords_(season, "AuditLog"), "event_id", function (event) {
    return String(event.action) !== "cancelPractice" && !cancelled[String(event.entity_id)];
  });
  var responseSheet = getSeasonSpreadsheet_(season).getSheetByName(String(season.response_sheet_name));
  if (responseSheet && responseSheet.getLastRow() > 0) {
    var responseRows = responseSheet.getRange(1, 1, responseSheet.getLastRow(), responseSheet.getLastColumn()).getValues();
    responseRows.forEach(function (row, index) {
      rows.push(archivePayloadRow_(index === 0 ? "form_response_header" : "form_response", String(index), row, capturedAt));
    });
  }
  return rows;
}

function publishedUncancelledPractices_(season) {
  return getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
    return Boolean(practice.schedule_published_at) && !practice.cancelled_at;
  });
}

function allPracticeArchivesReady_(season) {
  var records = {};
  getSheetRecords_("PracticeArchives").forEach(function (row) {
    if (String(row.season_id) === String(season.season_id) && String(row.status) === "SUCCEEDED") {
      records[String(row.practice_id)] = true;
    }
  });
  return publishedUncancelledPractices_(season).every(function (practice) {
    return Date.now() >= Date.parse(seatPlanArchiveDueAt_(practice)) && records[String(practice.practice_id)];
  });
}

function archiveSeasonPrivate_(season) {
  ensureP4SystemSheets_();
  var existing = findRecord_("SeasonArchives", "season_id", season.season_id);
  if (existing && ["PRIVATE_ARCHIVED", "PUBLISHED"].indexOf(String(existing.status)) >= 0) return existing;
  var archiveYear = seasonArchiveYear_(season);
  var requestId = "archive_season_" + hmacDigest_(String(season.season_id),
    getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
  var target = ensureAnnualArchiveFile_(archiveYear, requestId);
  var capturedAt = new Date().toISOString();
  var rows = seasonArchiveRows_(season, capturedAt);
  var snapshotId = "season_snapshot_" + hmacDigest_(String(season.season_id) + "\n" + String(season.season_ends_at),
    getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
  var digest = archivePayloadDigest_(rows);
  var sheetName = existing && existing.sheet_name ? String(existing.sheet_name) : archiveSheetName_("Season", season, null);
  var record = existing || appendSheetRecord_("SeasonArchives", {
    season_id: season.season_id, archive_year: archiveYear, spreadsheet_id: target.record.spreadsheet_id,
    sheet_name: sheetName, snapshot_id: snapshotId, snapshot_digest: digest, status: "STARTED",
    request_id: requestId, started_at: capturedAt, archived_at: "", published_at: "", updated_at: capturedAt, last_error: ""
  });
  try {
    writeAndVerifyArchiveTab_(target.spreadsheet, sheetName, rows, snapshotId, digest, capturedAt);
    record.spreadsheet_id = target.record.spreadsheet_id;
    record.sheet_name = sheetName;
    record.snapshot_id = snapshotId;
    record.snapshot_digest = digest;
    record.status = "PRIVATE_ARCHIVED";
    record.archived_at = capturedAt;
    record.updated_at = capturedAt;
    record.last_error = "";
    updateSheetRecord_("SeasonArchives", record);
    var latestSeason = requireSeason_(season.season_id);
    if (String(latestSeason.status) !== "ARCHIVED") {
      latestSeason.status = "ARCHIVED";
      latestSeason.archived_at = capturedAt;
      latestSeason.updated_at = capturedAt;
      latestSeason.season_version = Number(latestSeason.season_version || 0) + 1;
      updateSheetRecord_("Seasons", latestSeason);
    }
    var auditRecord = { request_key: buildSystemRequestKey_("P4:SYSTEM", "archiveSeason", requestId),
      actor_id: "P4:SYSTEM", action: "archiveSeason", request_id: requestId };
    ensureSystemAuditEvent_(auditRecord, "SEASON_PRIVATE_ARCHIVED", "SUCCEEDED",
      { season_id: season.season_id, snapshot_id: snapshotId, archive_year: archiveYear }, "SYSTEM");
    return record;
  } catch (error) {
    record.status = "ERROR";
    record.updated_at = new Date().toISOString();
    record.last_error = error && error.code ? error.code : "ARCHIVE_WRITE_FAILED";
    updateSheetRecord_("SeasonArchives", record);
    throw error;
  }
}

function historyPerson_(memberId, names) {
  return memberId ? { display_name: String(names[memberId] || "已停用队员") } : null;
}

function historySeatPlanSnapshot_(season, practice, finalSnapshot) {
  var revision = getSeatPlanRevision_(season, practice.practice_id, finalSnapshot.revision_number);
  if (!revision || Number(finalSnapshot.revision_number || 0) < 1) {
    return { status: "UNPUBLISHED", mode: "FROZEN", seat_plan_version: 0, published_revision: 0,
      archive_due_at: String(finalSnapshot.archive_due_at), published_at: "", source: "",
      coach: null, steerer: null, seats: [], rows: [] };
  }
  var names = parseJsonObject_(finalSnapshot.names_json);
  var roles = parseJsonObject_(finalSnapshot.roles_json);
  var seats = parseSeatPlanArray_(finalSnapshot.seats_json);
  var rows = publicSeatPlanRows_(practice, seats, names).map(function (row) {
    return { row_number: Number(row.row_number),
      left: row.left ? { display_name: String(row.left.display_name) } : null,
      right: row.right ? { display_name: String(row.right.display_name) } : null };
  });
  return {
    status: "FROZEN", mode: "FROZEN", seat_plan_version: Number(revision.seat_plan_version || 0),
    published_revision: Number(revision.revision_number), archive_due_at: String(finalSnapshot.archive_due_at),
    published_at: String(revision.published_at || ""), source: String(revision.source || ""),
    coach: historyPerson_(String(roles.coach_member_id || ""), names),
    steerer: historyPerson_(String(roles.steerer_member_id || ""), names), rows: rows
  };
}

function publicHistorySnapshot_(season, practice) {
  var finalSnapshot = getPracticeFinalSnapshot_(season, practice.practice_id);
  if (!finalSnapshot) throw dragonBoatRequestError_("ARCHIVE_NOT_READY", "The final training snapshot is unavailable.", true);
  return {
    season: { season_id: String(season.season_id), name: String(season.name), start_date: String(season.start_date),
      end_date: String(season.end_date), timezone: String(season.timezone) },
    practice: { practice_id: String(practice.practice_id), start_at: String(practice.start_at), end_at: String(practice.end_at),
      timezone: String(practice.timezone), location: String(practice.location), address: String(practice.address),
      map_url: String(practice.map_url || "") },
    seat_plan: historySeatPlanSnapshot_(season, practice, finalSnapshot),
    archived_at: String(finalSnapshot.frozen_at)
  };
}

function publishSeasonHistory_(season, seasonArchive) {
  ensureP4SystemSheets_();
  var now = new Date().toISOString();
  publishedUncancelledPractices_(season).forEach(function (practice) {
    var archive = findRecord_("PracticeArchives", "archive_key", practiceArchiveKey_(season.season_id, practice.practice_id));
    if (!archive || String(archive.status) !== "SUCCEEDED") {
      throw dragonBoatRequestError_("ARCHIVE_NOT_READY", "A training archive is incomplete.", true);
    }
    var key = practiceArchiveKey_(season.season_id, practice.practice_id);
    var snapshot = publicHistorySnapshot_(season, practice);
    var existing = findRecord_("PublicHistoryIndex", "history_key", key);
    if (existing) return;
    appendSheetRecord_("PublicHistoryIndex", {
      history_key: key, season_id: season.season_id, season_name: season.name,
      season_start_date: season.start_date, season_end_date: season.end_date, season_timezone: season.timezone,
      archive_year: archive.archive_year, practice_id: practice.practice_id,
      practice_start_at: practice.start_at, practice_end_at: practice.end_at,
      location: practice.location, address: practice.address, map_url: practice.map_url || "",
      final_status: snapshot.seat_plan.status, published_revision: snapshot.seat_plan.published_revision,
      published_at: snapshot.seat_plan.published_at, public_snapshot_json: JSON.stringify(snapshot),
      history_version: 1, created_at: now, updated_at: now
    });
  });
  seasonArchive.status = "PUBLISHED";
  seasonArchive.published_at = seasonArchive.published_at || now;
  seasonArchive.updated_at = now;
  seasonArchive.last_error = "";
  updateSheetRecord_("SeasonArchives", seasonArchive);
  return seasonArchive;
}

function runArchiveForSeason_(season) {
  ensureP4SystemSheets_();
  var effective = seasonEffectiveStatus_(season);
  if (["COMPLETED", "ARCHIVED"].indexOf(effective) < 0) return { status: effective, archived: false };
  var existingSeasonArchive = findRecord_("SeasonArchives", "season_id", season.season_id);
  var wasPublished = existingSeasonArchive && String(existingSeasonArchive.status) === "PUBLISHED";
  var practices = publishedUncancelledPractices_(season);
  var archivedCount = 0;
  practices.forEach(function (practice) {
    if (Date.now() >= Date.parse(seatPlanArchiveDueAt_(practice))) {
      var before = findRecord_("PracticeArchives", "archive_key", practiceArchiveKey_(season.season_id, practice.practice_id));
      archivePractice_(season, practice);
      if (!before || String(before.status) !== "SUCCEEDED") archivedCount += 1;
    }
  });
  if (!allPracticeArchivesReady_(season)) {
    return { status: "WAITING_FOR_FINAL_CORRECTION", archived: false, practice_archived_count: archivedCount };
  }
  var privateArchive = archiveSeasonPrivate_(requireSeason_(season.season_id));
  publishSeasonHistory_(requireSeason_(season.season_id), privateArchive);
  return { status: "PUBLISHED", archived: !wasPublished, practice_archived_count: archivedCount };
}

function runDueArchivesUnlocked_() {
  ensureP4SystemSheets_();
  completeDueSeasons_();
  var frozenCount = freezeDueSeatPlans_();
  var seasonCount = 0;
  var practiceCount = 0;
  getSheetRecords_("Seasons").forEach(function (season) {
    if (["COMPLETED", "ARCHIVED"].indexOf(seasonEffectiveStatus_(season)) < 0 || !season.runtime_spreadsheet_id) return;
    var result = runArchiveForSeason_(season);
    practiceCount += Number(result.practice_archived_count || 0);
    if (result.archived) seasonCount += 1;
  });
  return { frozen_count: frozenCount, practice_archived_count: practiceCount,
    season_archived_count: seasonCount, checked_at: new Date().toISOString() };
}

function runDragonBoatArchiveTasks() {
  return withDragonBoatScriptLock_(function () { return runDueArchivesUnlocked_(); });
}

function historyCorrections_(seasonId, practiceId, management) {
  ensureP4SystemSheets_();
  return getSheetRecords_("HistoryCorrections").filter(function (row) {
    return String(row.season_id) === String(seasonId) && String(row.practice_id) === String(practiceId);
  }).sort(function (left, right) { return String(left.created_at).localeCompare(String(right.created_at)); })
    .map(function (row) {
      var result = { correction_id: String(row.correction_id), note: String(row.note), created_at: String(row.created_at) };
      if (management) result.created_by = String(row.created_by);
      return result;
    });
}

function historyPracticeInternal_(seasonId, practiceId) {
  ensureP4SystemSheets_();
  var row = findRecord_("PublicHistoryIndex", "history_key", practiceArchiveKey_(seasonId, practiceId));
  if (!row) throw dragonBoatRequestError_("HISTORY_NOT_FOUND", "The archived training does not exist.");
  var snapshot = parseJsonObject_(row.public_snapshot_json);
  snapshot.history_version = Number(row.history_version || 0);
  snapshot.corrections = historyCorrections_(seasonId, practiceId, false);
  return snapshot;
}

function publicHistorySeasons_() {
  return withDragonBoatScriptLock_(function () {
    ensureP4SystemSheets_();
    var grouped = {};
    getSheetRecords_("PublicHistoryIndex").forEach(function (row) {
      var id = String(row.season_id);
      if (!grouped[id]) grouped[id] = {
        season_id: id, name: String(row.season_name), start_date: String(row.season_start_date),
        end_date: String(row.season_end_date), timezone: String(row.season_timezone),
        archive_year: String(row.archive_year), practice_count: 0, latest_practice_at: ""
      };
      grouped[id].practice_count += 1;
      if (String(row.practice_start_at) > grouped[id].latest_practice_at) grouped[id].latest_practice_at = String(row.practice_start_at);
    });
    return { seasons: Object.keys(grouped).map(function (key) { return grouped[key]; })
      .sort(function (left, right) { return right.latest_practice_at.localeCompare(left.latest_practice_at); }),
      generated_at: new Date().toISOString() };
  });
}

function publicSeasonHistory_(request) {
  return withDragonBoatScriptLock_(function () {
    ensureP4SystemSheets_();
    var seasonId = requireRequestString_(request, "season_id", 8, 128);
    var rows = getSheetRecords_("PublicHistoryIndex").filter(function (row) {
      return String(row.season_id) === seasonId;
    }).sort(function (left, right) { return String(right.practice_start_at).localeCompare(String(left.practice_start_at)); });
    if (!rows.length) throw dragonBoatRequestError_("HISTORY_NOT_FOUND", "The archived season does not exist.");
    return {
      season: { season_id: seasonId, name: String(rows[0].season_name), start_date: String(rows[0].season_start_date),
        end_date: String(rows[0].season_end_date), timezone: String(rows[0].season_timezone) },
      practices: rows.map(function (row) { return {
        practice_id: String(row.practice_id), start_at: String(row.practice_start_at), end_at: String(row.practice_end_at),
        timezone: String(row.season_timezone), location: String(row.location), address: String(row.address),
        map_url: String(row.map_url || ""), final_status: String(row.final_status),
        published_revision: Number(row.published_revision || 0), published_at: String(row.published_at || ""),
        history_version: Number(row.history_version || 0), correction_count: historyCorrections_(seasonId, row.practice_id, false).length
      }; }), generated_at: new Date().toISOString()
    };
  });
}

function publicArchivedPractice_(request) {
  return withDragonBoatScriptLock_(function () {
    return historyPracticeInternal_(requireRequestString_(request, "season_id", 8, 128),
      requireRequestString_(request, "practice_id", 8, 128));
  });
}

function archiveManagementProjection_(season) {
  ensureP4SystemSheets_();
  var practiceRows = getSheetRecords_("PracticeArchives").filter(function (row) {
    return String(row.season_id) === String(season.season_id);
  });
  var byPractice = {};
  practiceRows.forEach(function (row) { byPractice[String(row.practice_id)] = row; });
  var history = {};
  getSheetRecords_("PublicHistoryIndex").forEach(function (row) {
    if (String(row.season_id) === String(season.season_id)) history[String(row.practice_id)] = row;
  });
  var seasonArchive = findRecord_("SeasonArchives", "season_id", season.season_id);
  var files = {};
  getSheetRecords_("AnnualArchiveFiles").forEach(function (row) {
    if (practiceRows.some(function (archive) { return String(archive.archive_year) === String(row.archive_year); }) ||
        (seasonArchive && String(seasonArchive.archive_year) === String(row.archive_year))) {
      files[String(row.archive_year)] = { archive_year: String(row.archive_year), status: String(row.status),
        spreadsheet_url: archiveSpreadsheetUrl_(row.spreadsheet_id), verified_at: String(row.verified_at || ""),
        last_error: String(row.last_error || "") };
    }
  });
  return {
    season: seasonManagementProjection_(season),
    archive_status: seasonArchive ? String(seasonArchive.status) :
      (seasonEffectiveStatus_(season) === "COMPLETED" ? "PENDING" : "NOT_DUE"),
    season_archive: seasonArchive ? { status: String(seasonArchive.status), archived_at: String(seasonArchive.archived_at || ""),
      published_at: String(seasonArchive.published_at || ""), last_error: String(seasonArchive.last_error || "") } : null,
    annual_files: Object.keys(files).sort().map(function (key) { return files[key]; }),
    practices: getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
      return Boolean(practice.schedule_published_at) && !practice.cancelled_at;
    }).map(function (practice) {
      var archive = byPractice[String(practice.practice_id)];
      var index = history[String(practice.practice_id)];
      return { practice_id: String(practice.practice_id), start_at: String(practice.start_at), location: String(practice.location),
        archive_due_at: seatPlanArchiveDueAt_(practice), status: archive ? String(archive.status) :
          (Date.now() >= Date.parse(seatPlanArchiveDueAt_(practice)) ? "PENDING" : "NOT_DUE"),
        history_published: Boolean(index), history_version: index ? Number(index.history_version || 0) : 0,
        corrections: historyCorrections_(season.season_id, practice.practice_id, true),
        last_error: archive ? String(archive.last_error || "") : "" };
    }).sort(function (left, right) { return left.start_at.localeCompare(right.start_at); }),
    can_retry: ["COMPLETED", "ARCHIVED"].indexOf(seasonEffectiveStatus_(season)) >= 0,
    generated_at: new Date().toISOString()
  };
}

function getArchiveManagement_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    return archiveManagementProjection_(requireSeason_(request.season_id));
  });
}

function retrySeasonArchive_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    if (["COMPLETED", "ARCHIVED"].indexOf(seasonEffectiveStatus_(season)) < 0) {
      throw dragonBoatRequestError_("ARCHIVE_NOT_DUE", "The season is not ready to archive.");
    }
    runArchiveForSeason_(season);
    return archiveManagementProjection_(requireSeason_(season.season_id));
  });
}

function applyHistoryCorrectionRequest_(record) {
  var saved = readSystemRequestResult_(record);
  if (saved.kind !== "P4_HISTORY_CORRECTION" || !saved.plan || !saved.result) {
    throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The history correction needs recovery.", true);
  }
  if (String(record.status) === "COMPLETED") return saved.result;
  var row = saved.plan.correction;
  if (!findRecord_("HistoryCorrections", "correction_id", row.correction_id)) {
    appendSheetRecord_("HistoryCorrections", row);
  }
  var index = findRecord_("PublicHistoryIndex", "history_key", saved.plan.history_key);
  if (!index) throw dragonBoatRequestError_("HISTORY_NOT_FOUND", "The archived training does not exist.");
  if (Number(index.history_version || 0) < Number(saved.plan.history_version)) {
    index.history_version = saved.plan.history_version;
    index.updated_at = saved.plan.updated_at;
    updateSheetRecord_("PublicHistoryIndex", index);
  }
  ensureSystemAuditEvent_(record, "HISTORY_CORRECTION_APPENDED", "SUCCEEDED", {
    season_id: row.season_id, practice_id: row.practice_id, correction_id: row.correction_id
  }, "COACH");
  SpreadsheetApp.flush();
  completeSystemRequest_(record);
  SpreadsheetApp.flush();
  return saved.result;
}

function appendHistoryCorrection_(request) {
  return withDragonBoatScriptLock_(function () {
    ensureP4SystemSheets_();
    var auth = validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    if (String(season.status) !== "ARCHIVED") throw dragonBoatRequestError_("HISTORY_NOT_READY", "The season history is not published.");
    var practiceId = requireRequestString_(request, "practice_id", 8, 128);
    var note = typeof request.note === "string" ? request.note.trim() : "";
    if (!note || note.length > 1000 || /[\r\n\t]/.test(note) || /^[=+\-@]/.test(note)) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "Use a one-line correction note of 1 to 1000 safe characters.");
    }
    var historyKey = practiceArchiveKey_(season.season_id, practiceId);
    var index = findRecord_("PublicHistoryIndex", "history_key", historyKey);
    if (!index) throw dragonBoatRequestError_("HISTORY_NOT_FOUND", "The archived training does not exist.");
    var actorId = String(auth.coach.coach_id);
    var scope = "P4:" + season.season_id + ":COACH:" + actorId;
    var digest = digestRequestPayload_({ season_id: season.season_id, practice_id: practiceId,
      history_version: Number(request.history_version), note: note });
    var prior = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (prior) return applyHistoryCorrectionRequest_(prior);
    requireVersion_(index.history_version, request.history_version, "history");
    var now = new Date().toISOString();
    var correctionId = "history_note_" + hmacDigest_(buildSystemRequestKey_(scope, request.action, request.request_id),
      getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
    var result = { season_id: String(season.season_id), practice_id: practiceId,
      correction_id: correctionId, history_version: Number(index.history_version || 0) + 1 };
    var transaction = beginSystemRequest_(scope, request.action, request.request_id, digest, {
      kind: "P4_HISTORY_CORRECTION", plan: { history_key: historyKey, history_version: result.history_version,
        updated_at: now, correction: { correction_id: correctionId, season_id: season.season_id,
          practice_id: practiceId, note: note, created_by: actorId, created_at: now, request_id: request.request_id } },
      result: result
    });
    SpreadsheetApp.flush();
    return applyHistoryCorrectionRequest_(transaction.record);
  });
}

function listManagementAudit_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var limit = Math.min(200, Math.max(1, Number(request.limit || 100)));
    var events = getSeasonSheetRecords_(season, "AuditLog").map(function (row) {
      return { event_id: String(row.event_id), request_id: String(row.request_id), server_time: String(row.server_time),
        entity_type: String(row.entity_type), entity_id: String(row.entity_id), actor_type: String(row.actor_type),
        actor_id: String(row.actor_id), action: String(row.action), status: String(row.status),
        details: parseJsonObject_(row.details_json), scope: "SEASON" };
    });
    getSheetRecords_("SystemAuditLog").forEach(function (row) {
      var details = parseJsonObject_(row.details_json);
      if (String(details.season_id || "") !== String(season.season_id)) return;
      events.push({ event_id: String(row.event_id), request_id: String(row.request_id), server_time: String(row.server_time),
        entity_type: "SYSTEM", entity_id: String(details.entity_id || season.season_id), actor_type: String(row.actor_type),
        actor_id: String(row.actor_id), action: String(row.action), status: String(row.status), details: details, scope: "SYSTEM" });
    });
    events.sort(function (left, right) { return right.server_time.localeCompare(left.server_time); });
    return { season_id: String(season.season_id), events: events.slice(0, limit), generated_at: new Date().toISOString() };
  });
}
